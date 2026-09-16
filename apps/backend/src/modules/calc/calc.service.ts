import { BadRequestException, Injectable } from '@nestjs/common';
import { AppStatus, BatchStatus, IssueResolution } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JobService, JobContext } from '../../queue/job.service';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../../common/decorators';
import { computeStudent, rankAll, EngineCourse, EngineApplication, EngineOptions, DEFAULT_ENGINE_OPTIONS, EngineResult } from './engine';

export const ENGINE_VERSION = '1.0.0';

/** 计算编排：数据装配（课程/申请/裁决）→ 引擎 → 版本化落库 / dryRun 差异 */
@Injectable()
export class CalcService {
  constructor(private prisma: PrismaService, private jobs: JobService, private audit: AuditService) {}

  async startRun(user: JwtUser, batchId: string, dryRun: boolean) {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    if (batch.status === BatchStatus.DRAFT || batch.status === BatchStatus.DATA_PREP) {
      throw new BadRequestException('批次尚未开始收集材料，无需计算');
    }
    // 公示期允许重算（异议更正 → 重算出 CANDIDATE 新版 → 增量发布晋升）；仅归档批次锁定不可动
    if (batch.status === BatchStatus.ARCHIVED && !dryRun) {
      throw new BadRequestException('批次已归档，不可重算；如需更正请先回退公示');
    }
    return this.jobs.start({
      kind: 'CALC',
      batchId,
      operatorId: user.id,
      payload: { dryRun },
      handler: (ctx) => this.execute(ctx, batchId, dryRun, user),
    });
  }

  private async execute(ctx: JobContext, batchId: string, dryRun: boolean, user: JwtUser) {
    const batch = await ctx.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new Error('批次不存在');

    // 1. 规则口径（优先批次快照 overrides.caps）
    const snapshot = await ctx.prisma.batchRule.findMany({ where: { batchId }, include: { ruleItem: true } });
    const ruleSource = snapshot.length ? snapshot : [];
    const ruleCaps: Record<string, any> = {};
    for (const s of ruleSource) {
      ruleCaps[s.ruleItem.code] = { ...((s.ruleItem.caps as any) ?? {}), ...((s.overrides as any)?.caps ?? {}) };
    }
    const options: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, ruleCaps };

    // 2. 学生范围：NORMAL + 人工纳入的休学
    const includedSuspended = new Set(
      (await ctx.prisma.gradeIssue.findMany({ where: { batchId, issueType: 'SUSPENDED', resolution: IssueResolution.INCLUDED }, select: { studentId: true } })).map((i) => i.studentId),
    );
    const students = await ctx.prisma.student.findMany({
      where: { OR: [{ enrollStatus: 'NORMAL' }, { id: { in: [...includedSuspended] } }] },
      select: { id: true, studentNo: true, classId: true, enrollStatus: true },
    });

    // 3. 课程 + 人工裁决 picked：被裁决的课程组只保留 pickedGradeId 指定行（其余行剔除，不进引擎去重）
    const grades = await ctx.prisma.courseGrade.findMany({ where: { batchId, termKey: batch.semesterKey } });
    const pickedIds = new Set(
      (await ctx.prisma.gradeIssue.findMany({ where: { batchId, resolution: IssueResolution.MANUAL_PICKED, pickedGradeId: { not: null } }, select: { pickedGradeId: true } }))
        .map((i) => i.pickedGradeId!)
        .filter(Boolean),
    );
    // picked 行所属课程组（studentId|courseCode）：组内其他行全部让位
    const pickedGroup = new Set(grades.filter((g) => pickedIds.has(g.id)).map((g) => `${g.studentId}|${g.courseCode}`));

    // 4. 已认定申请
    const applications = await ctx.prisma.application.findMany({
      where: { batchId, status: AppStatus.APPROVED },
      select: { id: true, studentId: true, grantedScore: true, ruleItem: { select: { code: true, category: true } } },
    });
    const appsByStudent = new Map<string, EngineApplication[]>();
    for (const a of applications) {
      if (!appsByStudent.has(a.studentId)) appsByStudent.set(a.studentId, []);
      appsByStudent.get(a.studentId)!.push({ id: a.id, ruleCode: a.ruleItem.code, category: a.ruleItem.category as any, grantedScore: Number(a.grantedScore ?? 0) });
    }
    const gradesByStudent = new Map<string, any[]>();
    for (const g of grades) {
      if (!gradesByStudent.has(g.studentId)) gradesByStudent.set(g.studentId, []);
      gradesByStudent.get(g.studentId)!.push(g);
    }

    // 5. 逐生计算
    const results: (EngineResult & { studentNo: string; classId: string })[] = [];
    let done = 0;
    for (const s of students) {
      const rows = (gradesByStudent.get(s.id) ?? [])
        .filter((g) => pickedIds.has(g.id) || !pickedGroup.has(`${g.studentId}|${g.courseCode}`))
        .map<EngineCourse>((g) => ({
        id: g.id,
        courseCode: g.courseCode,
        courseName: g.courseName,
        credit: Number(g.credit),
        scoreValue: g.scoreValue === null ? null : Number(g.scoreValue),
        scoreFlag: g.scoreFlag,
        scoreText: g.scoreText,
        examType: g.examType,
        courseAttr: g.courseAttr,
        courseNature: g.courseNature,
        isPublicElective: g.isPublicElective,
      }));
      const r = computeStudent({ id: s.id, enrollStatus: s.enrollStatus }, rows, appsByStudent.get(s.id) ?? [], options);
      results.push({ ...r, studentNo: s.studentNo, classId: s.classId });
      done++;
      if (done % 100 === 0) await ctx.setProgress(Math.round((done / students.length) * 90));
    }

    // 6. 排名
    const ranks = rankAll(results.map((r) => ({
      studentId: r.studentId,
      studentNo: r.studentNo,
      classId: r.classId,
      totalScore: r.totalScore,
      moralTotal: r.moralTotal,
      academicTotal: r.academicTotal,
      sportsTotal: r.sportsTotal,
    })));

    // 7. 落库或差异报告
    if (dryRun) {
      const latest = await ctx.prisma.calcResult.findMany({ where: { batchId, version: batch.currentCalcVersion } });
      const prevMap = new Map(latest.map((r) => [r.studentId, r]));
      const diffs = results
        .map((r) => {
          const prev = prevMap.get(r.studentId);
          if (!prev) return { studentId: r.studentId, type: 'NEW', total: r.totalScore, prevTotal: null };
          if (Number(prev.totalScore) !== r.totalScore) {
            return {
              studentId: r.studentId,
              type: 'CHANGED',
              prevTotal: Number(prev.totalScore),
              total: r.totalScore,
              delta: Number((r.totalScore - Number(prev.totalScore)).toFixed(2)),
              moral: [Number(prev.moralTotal), r.moralTotal],
              academic: [Number(prev.academicTotal), r.academicTotal],
              sports: [Number(prev.sportsTotal), r.sportsTotal],
            };
          }
          return null;
        })
        .filter(Boolean);
      const missing = latest.filter((p) => !results.some((r) => r.studentId === p.studentId)).map((p) => ({ studentId: p.studentId, type: 'REMOVED', prevTotal: Number(p.totalScore) }));
      return {
        dryRun: true,
        students: results.length,
        diffs: [...diffs, ...missing],
        changed: diffs.length,
        summary: {
          moralBelow9: results.filter((r) => r.flags.includes('BELOW_MORAL_9')).length,
          deferred: results.filter((r) => r.flags.includes('PENDING_DEFERRED')).length,
          autoPicked: results.filter((r) => r.flags.includes('AUTO_PICKED_MULTI_LINE')).length,
          nonNumeric: results.filter((r) => r.flags.includes('NON_NUMERIC_SCORE')).length,
          totalScoreTop10: results
            .slice()
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, 10)
            .map((r) => ({ studentNo: r.studentNo, totalScore: r.totalScore })),
        },
      };
    }

    const version = batch.currentCalcVersion + 1;
    await ctx.prisma.$transaction(async (tx) => {
      // 旧候选版作废（已发布版本保持不动，保证公示数据不可变）
      await tx.calcResult.updateMany({ where: { batchId, status: 'CANDIDATE' }, data: { status: 'SUPERSEDED' } });
      await tx.calcResult.createMany({
        data: results.map((r) => ({
          batchId,
          studentId: r.studentId,
          version,
          moralBase: r.moralBase,
          moralBonus: Object.values(r.moralBonusByRule).reduce((s, v) => s + v, 0),
          moralTotal: r.moralTotal,
          academicWeighted: r.academicWeighted,
          academicAllPass: r.academicAllPass,
          academicBonus: Object.values(r.academicBonusByRule).reduce((s, v) => s + v, 0),
          academicFailPenalty: r.academicFailPenalty,
          academicTotal: r.academicTotal,
          sportsBase: r.sportsBase,
          sportsCadre: r.sportsCadre,
          sportsActivity: Object.values(r.sportsActivityByRule).reduce((s, v) => s + v, 0),
          sportsActivityTotal: r.sportsActivityTotal,
          sportsTotal: r.sportsTotal,
          totalScore: r.totalScore,
          rankGrade: ranks.get(r.studentId)?.rankGrade ?? null,
          rankClass: ranks.get(r.studentId)?.rankClass ?? null,
          breakdown: r.breakdown as any,
          courseSummary: r.courseSummary as any,
          flags: r.flags as any,
          status: 'CANDIDATE',
          engineVersion: ENGINE_VERSION,
        })),
      });
      await tx.batch.update({ where: { id: batchId }, data: { currentCalcVersion: version } });
    });

    await this.audit.log({
      operatorId: user.id,
      action: 'CALC_RUN',
      resourceType: 'batch',
      resourceId: batchId,
      detail: { version, students: results.length, dryRun: false },
    });
    return { version, students: results.length, changedFlags: results.filter((r) => r.flags.length > 0).length };
  }

  /** 版本列表 */
  async versions(batchId: string) {
    const group = await this.prisma.calcResult.groupBy({ by: ['version', 'status'], where: { batchId }, _count: { _all: true }, _max: { totalScore: true } });
    return group.sort((a, b) => b.version - a.version);
  }

  /** 结果查询（工作台预览） */
  async results(user: JwtUser, q: { batchId: string; version?: string; classId?: string; q?: string; page?: number; pageSize?: string }) {
    const version = q.version ? Number(q.version) : undefined;
    const where: any = { batchId: q.batchId, ...(version ? { version } : { status: 'CANDIDATE' }) };
    const studentWhere: any = {};
    if (q.classId) studentWhere.classId = q.classId;
    if (q.q) studentWhere.OR = [{ name: { contains: q.q } }, { studentNo: { contains: q.q } }];
    if (Object.keys(studentWhere).length) where.student = studentWhere;
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Number(q.pageSize) || 50);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.calcResult.count({ where }),
      this.prisma.calcResult.findMany({
        where,
        orderBy: [{ totalScore: 'desc' }, { rankGrade: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { student: { select: { studentNo: true, name: true, className: true, classId: true } } },
      }),
    ]);
    return { total, page, pageSize, rows };
  }
}
