import { BadRequestException, ConflictException, Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { TASK_FAILED_MESSAGE } from '@zc/shared';
import { PrismaService } from '../prisma/prisma.module';
import { publicExceptionMessage } from '../common/utils/public-error';

export interface JobContext {
  jobId: string;
  setProgress: (p: number) => Promise<void>;
  prisma: PrismaService;
}

/**
 * 后台任务：创建 ImportJob 记录后异步执行（进程内 fire-and-forget）。
 * 同一批次同类任务互斥（防止并发导入/计算相互覆盖）。
 * 进程重启时启动恢复把遗留 RUNNING 标记为 FAILED。
 * 说明：导入/计算为分钟级短任务，进程内执行已足够；
 * Redis 在本平台用于高并发查分快照/限流/幂等（见 CacheService）。
 */
@Injectable()
export class JobService implements OnModuleInit {
  private readonly logger = new Logger(JobService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // 启动恢复：上次进程中断遗留的 RUNNING 任务
    const stale = await this.prisma.importJob.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', error: '服务重启导致任务中断，请重新发起' },
    });
    if (stale.count > 0) this.logger.warn(`recovered ${stale.count} stale RUNNING jobs`);
  }

  /** 创建并启动任务；返回 jobId。同 kind+batch 已有 RUNNING 任务时抛 409。 */
  async start(opts: {
    kind: string;
    batchId?: string;
    fileName?: string;
    operatorId?: string;
    payload?: Record<string, unknown>;
    handler: (ctx: JobContext) => Promise<unknown>;
  }): Promise<string> {
    const createJob = async (db: Pick<PrismaService, 'importJob'>) => {
      const running = await db.importJob.findFirst({
        where: { kind: opts.kind, batchId: opts.batchId ?? null, status: 'RUNNING' },
      });
      if (running) throw new ConflictException('同类型任务正在执行中，请稍候');
      return db.importJob.create({
        data: {
          kind: opts.kind,
          batchId: opts.batchId,
          fileName: opts.fileName ?? '',
          operatorId: opts.operatorId,
          payload: (opts.payload ?? {}) as object,
          status: 'RUNNING',
        },
      });
    };
    const job = opts.batchId == null ? await createJob(this.prisma) : await this.prisma.$transaction(async (tx) => {
      // ImportJob.batchId 没有外键：先锁住父批次，和批次删除互斥。
      const locked = await tx.batch.updateMany({ where: { id: opts.batchId }, data: { currentCalcVersion: { increment: 0 } } });
      if (!locked.count) throw new BadRequestException('批次不存在');
      return createJob(tx);
    });
    const ctx: JobContext = {
      jobId: job.id,
      prisma: this.prisma,
      setProgress: async (p) => {
        await this.prisma.importJob.update({ where: { id: job.id }, data: { progress: Math.max(0, Math.min(100, Math.round(p))) } });
      },
    };
    // 异步执行，不阻塞响应
    void (async () => {
      try {
        const result = await opts.handler(ctx);
        await this.prisma.importJob.update({
          where: { id: job.id },
          data: { status: 'DONE', progress: 100, summary: (result ?? {}) as object },
        });
      } catch (e: any) {
        this.logger.error(`job ${opts.kind} ${job.id} failed: ${e?.message ?? e}`, e?.stack);
        await this.prisma.importJob
          .update({ where: { id: job.id }, data: { status: 'FAILED', error: publicExceptionMessage(e, TASK_FAILED_MESSAGE) } })
          .catch(() => undefined);
      }
    })();
    return job.id;
  }
}

@Global()
@Module({
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
