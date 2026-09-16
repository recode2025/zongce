import { BadRequestException, Body, ConflictException, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { BatchStatus, ObjectionStatus, REDIS_KEYS, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { rateLimit } from '../../common/utils/rate-limit';

const DAY = 24 * 3600;

/**
 * 发布与公示：
 * - 发布 = 版本晋升 PUBLISHED + 快照物化 Redis（查分读路径单次 GET）+ 公示窗口开启
 * - 异议仅在公示期内可提交；成立 → 更正重算 → 增量发布（只刷新变动学生）
 * - 二次公示 = 整批重发（round+1），全量重写快照 + 版本键原子切换
 */
@Controller('publish')
export class PublishController {
  constructor(private prisma: PrismaService, private cache: CacheService, private audit: AuditService) {}

  /** 发布（正式/二次公示）。publicityDays 公示天数（默认 3）；hideTopRank 仅第一轮生效：隐藏年级前 N 名的排名 */
  @Post('release')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async release(@Body() dto: { batchId: string; publicityDays?: number; publicityEnd?: string; hideTopRank?: number }, @CurrentUser() user: JwtUser) {
    const batch = await this.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    if (![BatchStatus.CALCULATED, BatchStatus.PUBLICITY].includes(batch.status as BatchStatus)) {
      throw new BadRequestException('批次尚未完成计算，不能发布');
    }
    const lastRound = await this.prisma.publishSnapshot.findFirst({ where: { batchId: batch.id }, orderBy: { round: 'desc' } });
    const round = (lastRound?.round ?? 0) + 1;
    // 隐藏前 N 名排名：仅第一轮公示生效（二次公示起恢复显示）
    const hideTopRank = round === 1 ? Math.max(0, Math.floor(Number(dto.hideTopRank) || 0)) : 0;

    const publicityEnd = dto.publicityEnd ? new Date(dto.publicityEnd) : new Date(Date.now() + Math.max(1, dto.publicityDays ?? 3) * DAY);

    const results = await this.prisma.calcResult.findMany({
      where: { batchId: batch.id, version: batch.currentCalcVersion },
      include: { student: { select: { studentNo: true, name: true, className: true } } },
    });
    if (!results.length) throw new BadRequestException('当前版本无计算结果');

    const version = batch.currentCalcVersion;
    await this.prisma.$transaction(async (tx) => {
      await tx.calcResult.updateMany({ where: { batchId: batch.id, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } });
      await tx.calcResult.updateMany({ where: { batchId: batch.id, version, status: 'CANDIDATE' }, data: { status: 'PUBLISHED' } });
      await tx.publishSnapshot.updateMany({ where: { batchId: batch.id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
      await tx.publishSnapshot.create({
        data: {
          batchId: batch.id,
          calcVersion: version,
          round,
          publishedAt: new Date(),
          publicityStart: new Date(),
          publicityEnd,
          status: 'ACTIVE',
          publishedBy: user.id,
          statsJson: { students: results.length, version, avg: Number((results.reduce((s, r) => s + Number(r.totalScore), 0) / results.length).toFixed(2)), hideTopRank },
        },
      });
      await tx.batch.update({ where: { id: batch.id }, data: { status: BatchStatus.PUBLICITY } });
    });

    // 物化 Redis 快照（TTL = 公示期 + 30 天兜底）
    await this.materialize(batch.id, results.map((r) => ({ row: r, student: r.student })), round, publicityEnd, hideTopRank);

    await this.prisma.announcement.create({
      data: {
        batchId: batch.id,
        title: `综测成绩公示（第 ${round} 轮）`,
        content: `${batch.name} 综测成绩已发布，公示期至 ${publicityEnd.toLocaleString('zh-CN')}。如对成绩有异议，请在公示期内通过"成绩查询"页提交。`,
        createdBy: user.id,
        pinned: true,
      },
    });
    await this.audit.log({ operatorId: user.id, action: 'PUBLISH', resourceType: 'batch', resourceId: batch.id, detail: { round, version, students: results.length } });
    return { round, version, students: results.length, publicityEnd };
  }

  /** 增量发布：自动检测"最新版与已发布版不一致"的学生，逐生晋升 + 精准刷新快照 */
  @Post('incremental')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async incremental(@Body() dto: { batchId: string }, @CurrentUser() user: JwtUser) {
    const batch = await this.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    const snapshot = await this.prisma.publishSnapshot.findFirst({ where: { batchId: batch.id, status: 'ACTIVE' } });
    if (!snapshot) throw new BadRequestException('批次未发布过，无增量可发');

    const latest = await this.prisma.calcResult.findMany({
      where: { batchId: batch.id, version: batch.currentCalcVersion },
      include: { student: { select: { studentNo: true, name: true, className: true } } },
    });
    const published = await this.prisma.calcResult.findMany({ where: { batchId: batch.id, status: 'PUBLISHED' }, select: { studentId: true, totalScore: true } });
    const pubMap = new Map(published.map((p) => [p.studentId, Number(p.totalScore)]));
    const changed = latest.filter((r) => pubMap.get(r.studentId) !== Number(r.totalScore));
    if (!changed.length) return { refreshed: 0, note: '无变动学生，快照未变更' };

    await this.prisma.$transaction(async (tx) => {
      for (const r of changed) {
        await tx.calcResult.updateMany({ where: { batchId: batch.id, studentId: r.studentId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } });
        await tx.calcResult.update({ where: { batchId_studentId_version: { batchId: batch.id, studentId: r.studentId, version: batch.currentCalcVersion } }, data: { status: 'PUBLISHED' } });
      }
    });
    // 增量刷新沿用本轮公示的隐藏排名配置（存于 statsJson）
    const hideTopRank = Number((snapshot.statsJson as any)?.hideTopRank) || 0;
    await this.materialize(batch.id, changed.map((r) => ({ row: r, student: r.student })), snapshot.round, snapshot.publicityEnd, hideTopRank);
    await this.audit.log({ operatorId: user.id, action: 'PUBLISH_INCREMENTAL', resourceType: 'batch', resourceId: batch.id, detail: { refreshed: changed.length } });
    return { refreshed: changed.length, students: changed.map((r) => r.student.studentNo) };
  }

  /** 学生查分：只打快照（Redis 单次 GET，miss 回源 DB 并回填）；限流 10/min */
  @Get('scores/mine')
  @Roles(Role.STUDENT)
  async myScore(@CurrentUser() user: JwtUser, @Query('batchId') batchId?: string) {
    await rateLimit(this.cache, { scope: 'score', id: user.id, limit: 10, windowSec: 60 }).catch(() => undefined);
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) throw new BadRequestException('非学生账号');
    const snapshot = await this.prisma.publishSnapshot.findFirst({
      where: { batchId: batchId ?? undefined, status: 'ACTIVE' },
      orderBy: { publishedAt: 'desc' },
    });
    if (!snapshot && !batchId) {
      const any = await this.prisma.publishSnapshot.findFirst({ where: { status: 'ACTIVE' }, orderBy: { publishedAt: 'desc' } });
      if (any) return this.readSnapshot(any.batchId, student);
      throw new BadRequestException('成绩尚未发布');
    }
    return this.readSnapshot(snapshot ? snapshot.batchId : batchId!, student);
  }

  /** 公示轮次列表 */
  @Get('rounds')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async rounds(@Query('batchId') batchId: string) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    const rounds = await this.prisma.publishSnapshot.findMany({
      where: { batchId },
      orderBy: { round: 'desc' },
      include: { _count: { select: { objections: true } } },
    });
    return rounds.map((r) => ({
      id: r.id,
      round: r.round,
      calcVersion: r.calcVersion,
      publishedAt: r.publishedAt,
      publicityStart: r.publicityStart,
      publicityEnd: r.publicityEnd,
      status: r.status,
      stats: r.statsJson,
      objections: r._count.objections,
    }));
  }

  // ---------- 异议 ----------

  @Post('objections')
  @Roles(Role.STUDENT)
  async submitObjection(@Body() dto: { batchId: string; content: string; targetApplicationId?: string }, @CurrentUser() user: JwtUser) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) throw new BadRequestException('非学生账号');
    const snapshot = await this.prisma.publishSnapshot.findFirst({ where: { batchId: dto.batchId, status: 'ACTIVE' } });
    if (!snapshot) throw new BadRequestException('当前批次不在公示期');
    if (snapshot.publicityEnd.getTime() < Date.now()) throw new BadRequestException('公示期已结束，无法提交异议');
    const content = String(dto.content ?? '').trim();
    if (content.length < 10) throw new BadRequestException('异议说明至少 10 个字');
    if (content.length > 2000) throw new BadRequestException('异议说明过长');

    const dup = await this.prisma.objection.findFirst({ where: { snapshotId: snapshot.id, studentId: student.id, status: ObjectionStatus.SUBMITTED } });
    if (dup) throw new ConflictException('本轮公示你已提交过异议，请等待处理结果');

    const obj = await this.prisma.objection.create({
      data: { batchId: dto.batchId, studentId: student.id, snapshotId: snapshot.id, targetApplicationId: dto.targetApplicationId ?? null, content },
    });
    await this.audit.log({ operatorId: user.id, action: 'OBJECTION_SUBMIT', resourceType: 'objection', resourceId: obj.id, detail: { batchId: dto.batchId } });
    return obj;
  }

  @Get('objections/mine')
  @Roles(Role.STUDENT)
  async myObjections(@CurrentUser() user: JwtUser, @Query('batchId') batchId?: string) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return [];
    return this.prisma.objection.findMany({ where: { studentId: student.id, ...(batchId ? { batchId } : {}) }, orderBy: { createdAt: 'desc' } });
  }

  @Get('objections')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async objections(@Query('batchId') batchId: string, @Query('status') status?: string) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    return this.prisma.objection.findMany({
      where: { batchId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: { student: { select: { studentNo: true, name: true, className: true } } },
    });
  }

  @Post('objections/:id/handle')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async handleObjection(@Param('id') id: string, @Body() dto: { status: ObjectionStatus; note?: string }, @CurrentUser() user: JwtUser) {
    const obj = await this.prisma.objection.findUnique({ where: { id }, include: { student: { select: { userId: true, name: true } } } });
    if (!obj || obj.status !== ObjectionStatus.SUBMITTED) throw new BadRequestException('异议不存在或已处理');
    if (![ObjectionStatus.ACCEPTED, ObjectionStatus.REJECTED].includes(dto?.status)) throw new BadRequestException('处理结果只能是 成立/不成立');
    await this.prisma.objection.update({
      where: { id },
      data: { status: dto.status, handlerId: user.id, handledAt: new Date(), handleNote: dto.note?.slice(0, 1000) },
    });
    if (obj.student.userId) {
      await this.prisma.notification.create({
        data: {
          userId: obj.student.userId,
          title: dto.status === ObjectionStatus.ACCEPTED ? '异议已受理，将更正重算' : '异议处理结果：不成立',
          content: dto.status === ObjectionStatus.ACCEPTED ? `你的异议已受理，更正后将重新计算并更新成绩。${dto.note ?? ''}` : `异议不成立。${dto.note ?? ''}`,
          link: '/student/score',
        },
      });
    }
    await this.audit.log({ operatorId: user.id, action: 'OBJECTION_HANDLE', resourceType: 'objection', resourceId: id, detail: { status: dto.status } });
    return { ok: true };
  }

  // ---------- 内部 ----------

  private async readSnapshot(batchId: string, student: { id: string; studentNo: string }) {
    const key = REDIS_KEYS.scoreSnapshot(batchId, student.studentNo);
    const hit = await this.cache.get(key);
    if (hit) {
      try {
        return { source: 'cache', ...JSON.parse(hit) };
      } catch {
        /* fallthrough 回源 */
      }
    }
    // 回源：最新 PUBLISHED 版本行
    const row = await this.prisma.calcResult.findFirst({
      where: { batchId, studentId: student.id, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      include: { student: { select: { studentNo: true, name: true, className: true } } },
    });
    if (!row) throw new BadRequestException('成绩尚未发布');
    const snapshot = await this.prisma.publishSnapshot.findFirst({ where: { batchId, status: 'ACTIVE' } });
    const payload = this.buildPayload(row, row.student, snapshot?.round ?? 1, snapshot?.publicityEnd ?? null, Number((snapshot?.statsJson as any)?.hideTopRank) || 0);
    await this.cache.set(key, JSON.stringify(payload), 7 * DAY).catch(() => undefined);
    return { source: 'db', ...payload };
  }

  /** hideTopRank：年级前 N 名在第一轮公示隐藏排名（rankGrade/rankClass 置空 + rankHidden 标记） */
  private buildPayload(row: any, student: { studentNo: string; name: string; className: string }, round: number, publicityEnd: Date | null, hideTopRank = 0) {
    const hide = hideTopRank > 0 && row.rankGrade != null && row.rankGrade <= hideTopRank;
    return {
      batchId: row.batchId,
      calcVersion: row.version,
      round,
      publishedAt: row.createdAt,
      publicityEnd,
      studentNo: student.studentNo,
      name: student.name,
      className: student.className,
      totalScore: Number(row.totalScore),
      rankGrade: hide ? null : row.rankGrade,
      rankClass: hide ? null : row.rankClass,
      rankHidden: hide,
      moral: { base: Number(row.moralBase), bonus: Number(row.moralBonus), total: Number(row.moralTotal) },
      academic: {
        weighted: Number(row.academicWeighted),
        allPass: Number(row.academicAllPass),
        bonus: Number(row.academicBonus),
        failPenalty: Number(row.academicFailPenalty),
        total: Number(row.academicTotal),
      },
      sports: {
        base: Number(row.sportsBase),
        cadre: Number(row.sportsCadre),
        activity: Number(row.sportsActivity),
        activityTotal: Number(row.sportsActivityTotal),
        total: Number(row.sportsTotal),
      },
      breakdown: row.breakdown,
      courseSummary: row.courseSummary,
      flags: row.flags,
    };
  }

  private async materialize(batchId: string, rows: { row: any; student: { studentNo: string; name: string; className: string } }[], round: number, publicityEnd: Date, hideTopRank = 0) {
    const ttlSec = Math.ceil((publicityEnd.getTime() - Date.now()) / 1000) + 30 * DAY;
    const items = rows.map(({ row, student }) => ({
      key: REDIS_KEYS.scoreSnapshot(batchId, student.studentNo),
      value: JSON.stringify(this.buildPayload(row, student, round, publicityEnd, hideTopRank)),
      ttlSec: Math.max(ttlSec, DAY),
    }));
    await this.cache.msetBulk(items);
    // 版本键原子切换（读路径比对用）
    const verKey = REDIS_KEYS.scoreSnapshotVersion(batchId);
    await this.cache.set(verKey, String(rows[0]?.row.version ?? 0));
  }
}

@Module({
  controllers: [PublishController],
})
export class PublishModule {}
