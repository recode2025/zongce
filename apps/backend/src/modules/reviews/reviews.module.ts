import { BadRequestException, Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { AppStatus, BatchStatus, PackageStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { sendNotification } from '../notify/notify.module';

interface FirstReviewDto {
  ids: string[];
  action: 'PASS' | 'REJECT';
  comment?: string;
}

interface SecondReviewDto {
  ids: string[];
  action: 'APPROVE' | 'REJECT';
  comment?: string;
  /** 可选逐项改分：{ [applicationId]: score }，缺省用 declaredScore */
  grantedScores?: Record<string, number>;
}

/**
 * 审核流：班委初审（材料齐备性/命名规范）→ 辅导员复审（分值核定）。
 * grantedScore 只在复审写入，是计算引擎唯一取分来源；每次动作落 ReviewLog + 通知学生。
 */
@Controller('reviews')
export class ReviewsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---------- 初审（班委本班；辅导员可代初） ----------

  @Post('first')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async firstReview(@Body() dto: FirstReviewDto, @CurrentUser() user: JwtUser) {
    if (!dto?.ids?.length || dto.ids.length > 100) throw new BadRequestException('请选择 1-100 条申请');
    const apps = await this.prisma.application.findMany({
      where: { id: { in: dto.ids }, status: AppStatus.SUBMITTED },
      include: { student: { select: { id: true, classId: true, userId: true, name: true } } },
    });
    // 数据范围：班委仅本班
    if (user.role === Role.CLASS_LEADER) {
      const illegal = apps.filter((a) => a.classId !== user.classId);
      if (illegal.length) throw new BadRequestException('包含非本班学生的申请，已拒绝');
    }
    if (apps.length !== dto.ids.length) {
      const found = new Set(apps.map((a) => a.id));
      throw new BadRequestException(`部分申请不处于「待初审」状态（${dto.ids.filter((i) => !found.has(i)).length} 条），请刷新列表`);
    }

    const toStatus = dto.action === 'PASS' ? AppStatus.FIRST_PASSED : AppStatus.FIRST_REJECTED;
    await this.prisma.$transaction(
      apps.map((a) =>
        this.prisma.application.update({
          where: { id: a.id },
          data: {
            status: toStatus,
            firstReviewerId: user.id,
            firstReviewedAt: new Date(),
            firstRejectReason: dto.action === 'PASS' ? null : (dto.comment ?? '材料不符合规范').slice(0, 500),
          },
        }),
      ),
    );
    await this.prisma.reviewLog.createMany({
      data: apps.map((a) => ({
        applicationId: a.id,
        action: dto.action === 'PASS' ? 'FIRST_PASS' : 'FIRST_REJECT',
        fromStatus: AppStatus.SUBMITTED,
        toStatus,
        operatorId: user.id,
        operatorName: user.name,
        comment: dto.comment?.slice(0, 500),
      })),
    });
    // 通知学生
    for (const a of apps) {
      if (a.student.userId) {
        await sendNotification(
          this.prisma,
          a.student.userId,
          dto.action === 'PASS' ? '加分申请初审通过' : '加分申请被初审退回',
          dto.action === 'PASS'
            ? `「${a.title}」已通过班级初审，等待辅导员复审。`
            : `「${a.title}」被初审退回：${dto.comment ?? '材料不符合规范'}。请修改后重新提交。`,
          '/student/applications',
        );
      }
    }
    await this.audit.log({
      operatorId: user.id,
      action: dto.action === 'PASS' ? 'FIRST_REVIEW_PASS' : 'FIRST_REVIEW_REJECT',
      resourceType: 'application',
      detail: { count: apps.length, comment: dto.comment },
    });
    return { processed: apps.length, status: toStatus };
  }

  // ---------- 复审（辅导员/超管，核定 grantedScore） ----------

  @Post('second')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async secondReview(@Body() dto: SecondReviewDto, @CurrentUser() user: JwtUser) {
    if (!dto?.ids?.length || dto.ids.length > 100) throw new BadRequestException('请选择 1-100 条申请');
    const apps = await this.prisma.application.findMany({
      where: { id: { in: dto.ids }, status: AppStatus.FIRST_PASSED },
      include: {
        student: { select: { userId: true } },
        ruleItem: { select: { code: true, name: true, caps: true } },
      },
    });
    if (apps.length !== dto.ids.length) {
      const found = new Set(apps.map((a) => a.id));
      throw new BadRequestException(`部分申请不处于「待复审」状态（${dto.ids.filter((i) => !found.has(i)).length} 条），请刷新列表`);
    }

    const toStatus = dto.action === 'APPROVE' ? AppStatus.APPROVED : AppStatus.REJECTED;
    await this.prisma.$transaction(
      apps.map((a) => {
        let granted = a.declaredScore as any;
        const override = dto.grantedScores?.[a.id];
        if (dto.action === 'APPROVE' && override !== undefined) {
          granted = override;
        }
        // caps 兜底：单项封顶
        const cap = (a.ruleItem.caps as any)?.perTermMax;
        if (dto.action === 'APPROVE' && cap !== undefined && cap !== null && Number(granted) > Number(cap)) {
          granted = Number(cap);
        }
        return this.prisma.application.update({
          where: { id: a.id },
          data: {
            status: toStatus,
            reviewerId: user.id,
            reviewedAt: new Date(),
            grantedScore: dto.action === 'APPROVE' ? granted : null,
            rejectReason: dto.action === 'APPROVE' ? null : (dto.comment ?? '不符合认定条件').slice(0, 500),
          },
        });
      }),
    );
    await this.prisma.reviewLog.createMany({
      data: apps.map((a) => ({
        applicationId: a.id,
        action: dto.action === 'APPROVE' ? 'APPROVE' : 'REJECT',
        fromStatus: AppStatus.FIRST_PASSED,
        toStatus,
        operatorId: user.id,
        operatorName: user.name,
        comment: dto.comment?.slice(0, 500) ?? (dto.action === 'APPROVE' && dto.grantedScores?.[a.id] !== undefined ? `核定分值：${dto.grantedScores[a.id]}（申报 ${a.declaredScore}）` : undefined),
      })),
    });
    for (const a of apps) {
      if (a.student.userId) {
        const granted = dto.grantedScores?.[a.id];
        await sendNotification(
          this.prisma,
          a.student.userId,
          dto.action === 'APPROVE' ? '加分申请复审通过' : '加分申请复审驳回',
          dto.action === 'APPROVE'
            ? `「${a.title}」已认定${granted !== undefined ? `，核定分值 ${granted}` : ''}。`
            : `「${a.title}」复审驳回：${dto.comment ?? '不符合认定条件'}。`,
          '/student/applications',
        );
      }
    }
    await this.audit.log({
      operatorId: user.id,
      action: dto.action === 'APPROVE' ? 'SECOND_REVIEW_APPROVE' : 'SECOND_REVIEW_REJECT',
      resourceType: 'application',
      detail: { count: apps.length, comment: dto.comment, overrides: dto.grantedScores },
    });
    return { processed: apps.length, status: toStatus };
  }

  // ---------- 材料包初审（班委） ----------

  @Post('packages/first')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async packageFirst(@Body() dto: { ids: string[]; action: 'PASS' | 'REJECT'; comment?: string }, @CurrentUser() user: JwtUser) {
    if (!dto?.ids?.length || dto.ids.length > 100) throw new BadRequestException('请选择 1-100 个材料包');
    const pkgs = await this.prisma.materialPackage.findMany({
      where: { id: { in: dto.ids }, status: PackageStatus.SUBMITTED },
      include: { student: { select: { id: true, classId: true, userId: true } } },
    });
    if (user.role === Role.CLASS_LEADER) {
      const illegal = pkgs.filter((p) => p.student.classId !== user.classId);
      if (illegal.length) throw new BadRequestException('包含非本班学生的材料包，已拒绝');
    }
    if (pkgs.length !== dto.ids.length) throw new BadRequestException('部分材料包不处于「待初审」状态，请刷新列表');

    const toStatus = dto.action === 'PASS' ? PackageStatus.FIRST_PASSED : PackageStatus.FIRST_REJECTED;
    await this.prisma.$transaction(
      pkgs.map((p) =>
        this.prisma.materialPackage.update({
          where: { id: p.id },
          data: {
            status: toStatus,
            firstReviewerId: user.id,
            firstReviewedAt: new Date(),
            firstRejectReason: dto.action === 'PASS' ? null : (dto.comment ?? '材料命名/内容不符合规范').slice(0, 500),
          },
        }),
      ),
    );
    for (const p of pkgs) {
      if (p.student.userId) {
        await sendNotification(
          this.prisma,
          p.student.userId,
          dto.action === 'PASS' ? '材料包初审通过' : '材料包被初审退回',
          dto.action === 'PASS' ? '材料包已通过班级初审。' : `材料包被退回：${dto.comment ?? '材料命名/内容不符合规范'}。请补充材料后重新打包提交。`,
          '/student/applications',
        );
      }
    }
    await this.audit.log({
      operatorId: user.id,
      action: dto.action === 'PASS' ? 'PACKAGE_FIRST_PASS' : 'PACKAGE_FIRST_REJECT',
      resourceType: 'materialPackage',
      detail: { count: pkgs.length, comment: dto.comment },
    });
    return { processed: pkgs.length, status: toStatus };
  }

  // ---------- 审核统计（工作台顶栏） ----------

  @Get('stats')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async stats(@CurrentUser() user: JwtUser, @Query('batchId') batchId: string) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    const scope = user.role === Role.CLASS_LEADER && user.classId ? { classId: user.classId } : {};
    const group = await this.prisma.application.groupBy({
      by: ['status'],
      where: { batchId, ...scope },
      _count: { _all: true },
    });
    const pkgGroup = await this.prisma.materialPackage.groupBy({
      by: ['status'],
      where: { batchId, ...(user.role === Role.CLASS_LEADER && user.classId ? { student: { classId: user.classId } } : {}) },
      _count: { _all: true },
    });
    return {
      applications: Object.fromEntries(group.map((g) => [g.status, g._count._all])),
      packages: Object.fromEntries(pkgGroup.map((g) => [g.status, g._count._all])),
    };
  }
}

@Module({
  controllers: [ReviewsController],
})
export class ReviewsModule {}
