import { BadRequestException, Controller, Get, Module, Query } from '@nestjs/common';
import { AppStatus, BatchStatus, IssueResolution, PackageStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { Roles } from '../../common/decorators';

/** 统计看板：提交率 / 审核积压 / 分数分布 / 异常计数 —— 全部实时聚合，无缓存 */
@Controller('stats')
export class StatsController {
  constructor(private prisma: PrismaService) {}

  @Get('overview')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async overview(@Query('batchId') batchId: string) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BadRequestException('批次不存在');

    const [studentTotal, suspended, classes] = await Promise.all([
      this.prisma.student.count({ where: { enrollStatus: 'NORMAL' } }),
      this.prisma.student.count({ where: { enrollStatus: { not: 'NORMAL' } } }),
      this.prisma.clazz.count(),
    ]);

    const [appsByStatus, pkgsByStatus, issuesByType, issuesPending] = await Promise.all([
      this.prisma.application.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } }),
      this.prisma.materialPackage.groupBy({ by: ['status', 'section'], where: { batchId }, _count: { _all: true } }),
      this.prisma.gradeIssue.groupBy({ by: ['issueType', 'resolution'], where: { batchId }, _count: { _all: true } }),
      this.prisma.gradeIssue.count({ where: { batchId, resolution: IssueResolution.PENDING } }),
    ]);

    // 分班提交率：学生数 vs 已提交任一板块的人数
    const [classRows, submittedStudents] = await Promise.all([
      this.prisma.clazz.findMany({ select: { id: true, name: true, _count: { select: { students: { where: { enrollStatus: 'NORMAL' } } } } }, orderBy: { name: 'asc' } }),
      this.prisma.materialPackage.findMany({ where: { batchId, status: { in: [PackageStatus.SUBMITTED, PackageStatus.FIRST_PASSED, PackageStatus.FIRST_REJECTED] } }, select: { studentId: true, student: { select: { classId: true } } } }),
    ]);
    const submittedByClass = new Map<string, Set<string>>();
    for (const p of submittedStudents) {
      if (!submittedByClass.has(p.student.classId)) submittedByClass.set(p.student.classId, new Set());
      submittedByClass.get(p.student.classId)!.add(p.studentId);
    }
    const submission = classRows
      .filter((c) => c._count.students > 0)
      .map((c) => ({
        classId: c.id,
        className: c.name,
        students: c._count.students,
        submitted: submittedByClass.get(c.id)?.size ?? 0,
        rate: c._count.students ? Math.round(((submittedByClass.get(c.id)?.size ?? 0) / c._count.students) * 100) : 0,
      }))
      .sort((a, b) => a.rate - b.rate);

    // 分数分布（当前候选或已发布版本）
    const snap = await this.prisma.publishSnapshot.findFirst({ where: { batchId, status: 'ACTIVE' } });
    const version = snap?.calcVersion ?? batch.currentCalcVersion;
    const results = version
      ? await this.prisma.calcResult.findMany({ where: { batchId, version }, select: { totalScore: true, flags: true, moralTotal: true } })
      : [];
    const bucket = (n: number) => (n >= 90 ? '90+' : n >= 80 ? '80-90' : n >= 70 ? '70-80' : n >= 60 ? '60-70' : '<60');
    const dist: Record<string, number> = { '90+': 0, '80-90': 0, '70-80': 0, '60-70': 0, '<60': 0 };
    const flagCount: Record<string, number> = {};
    for (const r of results) {
      dist[bucket(Number(r.totalScore))]++;
      for (const f of ((r.flags as string[]) ?? [])) flagCount[f] = (flagCount[f] ?? 0) + 1;
    }

    return {
      batch: { id: batch.id, name: batch.name, semesterKey: batch.semesterKey, status: batch.status, calcVersion: batch.currentCalcVersion, published: !!snap, round: snap?.round ?? null, publicityEnd: snap?.publicityEnd ?? null },
      students: { total: studentTotal, abnormal: suspended, classes },
      applications: Object.fromEntries(appsByStatus.map((g) => [g.status, g._count._all])),
      pendingReviewBacklog:
        (appsByStatus.find((g) => g.status === AppStatus.SUBMITTED)?._count._all ?? 0) +
        (appsByStatus.find((g) => g.status === AppStatus.FIRST_PASSED)?._count._all ?? 0),
      packages: pkgsByStatus.map((g) => ({ section: g.section, status: g.status, count: g._count._all })),
      issues: { byType: issuesByType.map((g) => ({ type: g.issueType, resolution: g.resolution, count: g._count._all })), pending: issuesPending },
      submission,
      score: { version, count: results.length, distribution: dist, flags: flagCount },
    };
  }
}

@Module({
  controllers: [StatsController],
})
export class StatsModule {}
