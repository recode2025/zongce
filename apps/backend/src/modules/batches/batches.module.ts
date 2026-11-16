import { BadRequestException, Body, Controller, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { BATCH_STATUS_FLOW, BatchStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { studentScope } from '../../common/utils/scope';
import { APPLY_SWITCH_KEY } from '../applications/applications.service';

export interface PhaseRange {
  phase: string;
  start?: string;
  end?: string;
}

class CreateBatchDto {
  @IsString() semesterKey: string; // 2025-2026-1
  @IsString() name: string;
  @IsOptional() phases?: PhaseRange[];
}

class TransitionDto {
  /** 必须加装饰器：全局 ValidationPipe whitelist 会剥离无装饰器属性（否则 to 恒为 undefined） */
  @IsIn(BATCH_STATUS_FLOW)
  to: BatchStatus;
}

class ApplySwitchDto {
  @IsBoolean()
  enabled: boolean;
}

@Controller('batches')
export class BatchesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @Roles(Role.GRADE_ADMIN, Role.CLASS_LEADER)
  async list(@CurrentUser() user: JwtUser) {
    const scope = studentScope(user);
    const scoped = Object.keys(scope).length > 0;
    const scopedCount = { where: { student: scope } };
    const items = await this.prisma.batch.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: {
        applications: scoped ? scopedCount : true, courseGrades: scoped ? scopedCount : true,
        calcResults: scoped ? scopedCount : true, objections: scoped ? scopedCount : true,
        ...(!scoped ? { snapshots: true } : {}),
      } } },
    });
    const historical = items.length ? await this.prisma.calcResult.findMany({
      where: { batchId: { in: items.map((batch) => batch.id) }, engineVersion: 'HISTORICAL' },
      select: { batchId: true },
      distinct: ['batchId'],
    }) : [];
    const historicalIds = new Set(historical.map((row) => row.batchId));
    return items.map((b) => ({
      ...b,
      counts: b._count,
      historicalImport: historicalIds.has(b.id),
    }));
  }

  /** 当前进行中的批次（学生端首页用；附提交通道开关状态） */
  @Get('active')
  async active(@CurrentUser('grade') grade: number | null) {
    const list = await this.prisma.batch.findMany({
      where: { status: { not: 'ARCHIVED' }, calcResults: { none: { engineVersion: 'HISTORICAL' } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!list.length) return null;
    const row = await this.prisma.sysConfig.findUnique({ where: { key: APPLY_SWITCH_KEY } });
    return { ...list[0], applyEnabled: row?.value !== 'false' };
  }

  /** 学生提交通道开关（后台系统设置用；提交接口在服务端强制校验） */
  @Get('apply-switch')
  @Roles(Role.GRADE_ADMIN)
  async getApplySwitch() {
    const row = await this.prisma.sysConfig.findUnique({ where: { key: APPLY_SWITCH_KEY } });
    return { enabled: row?.value !== 'false' };
  }

  @Put('apply-switch')
  @Roles(Role.SUPER_ADMIN)
  async setApplySwitch(@Body() dto: ApplySwitchDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const enabled = dto.enabled !== false;
    await this.prisma.sysConfig.upsert({
      where: { key: APPLY_SWITCH_KEY },
      update: { value: String(enabled) },
      create: { key: APPLY_SWITCH_KEY, value: String(enabled) },
    });
    await this.audit.log({ operatorId, action: 'APPLY_SWITCH', resourceType: 'sysConfig', resourceId: APPLY_SWITCH_KEY, detail: { enabled }, ip });
    return { enabled };
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  async create(@Body() dto: CreateBatchDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    if (!/^\d{4}-\d{4}-[12]$/.test(dto.semesterKey)) throw new BadRequestException('学期格式应为 2025-2026-1');
    const exists = await this.prisma.batch.findUnique({ where: { semesterKey: dto.semesterKey } });
    if (exists) throw new BadRequestException('该学期批次已存在');
    const batch = await this.prisma.batch.create({
      data: { semesterKey: dto.semesterKey, name: dto.name, phases: (dto.phases ?? []) as object[] },
    });
    await this.audit.log({ operatorId, action: 'BATCH_CREATE', resourceType: 'batch', resourceId: batch.id, detail: { semesterKey: dto.semesterKey }, ip });
    return batch;
  }

  /** 激活规则快照：把当前 RuleItem 字典复制为本批次 BatchRule */
  @Post(':id/activate-rules')
  @Roles(Role.SUPER_ADMIN)
  async activateRules(@Param('id') id: string, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const items = await this.prisma.ruleItem.findMany({ where: { isActive: true } });
    await this.prisma.batchRule.deleteMany({ where: { batchId: id } });
    await this.prisma.batchRule.createMany({
      data: items.map((r) => ({ batchId: id, ruleItemId: r.id, overrides: {} })),
    });
    await this.audit.log({ operatorId, action: 'RULE_UPDATE', resourceType: 'batch', resourceId: id, detail: { action: 'activate_rules', count: items.length }, ip });
    return { count: items.length };
  }

  /** 阶段流转（含门禁校验） */
  @Post(':id/transition')
  @Roles(Role.SUPER_ADMIN)
  async transition(@Param('id') id: string, @Body() dto: TransitionDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const batch = await this.prisma.batch.findUnique({ where: { id } });
    if (!batch) throw new BadRequestException('批次不存在');
    const flow = BATCH_STATUS_FLOW;
    const cur = flow.indexOf(batch.status as BatchStatus);
    const next = flow.indexOf(dto.to);
    if (next !== cur + 1 && next !== cur) throw new BadRequestException(`不允许从 ${batch.status} 流转到 ${dto.to}`);

    await this.assertGates(batch, dto.to);

    await this.prisma.batch.update({ where: { id }, data: { status: dto.to } });
    await this.audit.log({ operatorId, action: 'BATCH_TRANSITION', resourceType: 'batch', resourceId: id, detail: { from: batch.status, to: dto.to }, ip });
    return { success: true };
  }

  private async assertGates(batch: any, to: BatchStatus) {
    if (to === BatchStatus.SECOND_REVIEW) {
      const pending = await this.prisma.application.count({ where: { batchId: batch.id, status: 'SUBMITTED' } });
      if (pending > 0) throw new BadRequestException(`仍有 ${pending} 条申请未完成班级初审，不能进入复审`);
    }
    if (to === BatchStatus.CALCULATED) {
      const pendingReview = await this.prisma.application.count({ where: { batchId: batch.id, status: 'FIRST_PASSED' } });
      if (pendingReview > 0) throw new BadRequestException(`仍有 ${pendingReview} 条初审通过的申请未完成复审，不能计算`);
      const pendingIssue = await this.prisma.gradeIssue.count({ where: { batchId: batch.id, resolution: 'PENDING', issueType: { in: ['MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE'] } } });
      if (pendingIssue > 0) throw new BadRequestException(`仍有 ${pendingIssue} 条成绩异常待裁决，不能计算`);
    }
    if (to === BatchStatus.PUBLICITY) {
      const published = await this.prisma.calcResult.count({ where: { batchId: batch.id, status: 'PUBLISHED' } });
      if (published === 0) throw new BadRequestException('尚未发布成绩，不能进入公示期（请先在「发布公示」中发布）');
    }
  }
}

@Module({
  controllers: [BatchesController],
  providers: [],
})
export class BatchesModule {}
