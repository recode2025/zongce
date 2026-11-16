import { BadRequestException, Body, Controller, Get, Injectable, Module, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as XLSX from 'xlsx';
import { Role, SCHOLARSHIP_AWARD_LABEL, SCHOLARSHIP_AWARD_ORDER, ScholarshipAward } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { isRequired } from '../calc/engine';
import { assertStudentScope, studentScope } from '../../common/utils/scope';

/**
 * 奖学金评定（按学年）：
 * - 两学期综测总分相加后排名；每学期分数取「已发布」成绩（按学生取最新发布版本），
 *   该学期尚未发布时取批次当前计算版本，并在结果中标注来源。
 * - 挂科判定两种口径：
 *     STRICT 严格：两学期内任一课程（学分>0，含选修、含补考前的期末成绩）不及格 / 缺考 / 取消考试资格
 *     ENGINE 同综测计算：仅以计算引擎已扣「必修不及格分」为准（与查分页扣分一致）
 * - 参与排名：两学期都有综测成绩且无挂科；同分同名次（1,2,2,4）。
 * - 奖项由管理员手动设定，每人每学年一项。
 */

export type FailRule = 'STRICT' | 'ENGINE';
const FAIL_FLAGS = ['缺考', '取消考试资格'];
const YEAR_RE = /^\d{4}-\d{4}$/;

export interface SemesterMeta {
  semesterKey: string;
  batchId: string | null;
  batchName: string | null;
  batchStatus: string | null;
  /** PUBLISHED = 已发布成绩；CALC = 未发布，取当前计算版本；NONE = 无成绩 */
  source: 'PUBLISHED' | 'CALC' | 'NONE';
  version: number | null;
}

export interface FailCourse {
  semesterKey: string;
  courseName: string;
  credit: number;
  score: string;
  examType: string;
  required: boolean;
}

export interface ScholarshipRow {
  studentId: string;
  studentNo: string;
  name: string;
  className: string;
  major: string;
  grade: number;
  terms: (number | null)[]; // [第一学期, 第二学期]
  sum: number | null;
  fails: FailCourse[];
  hasFail: boolean;
  eligible: boolean;
  reason: string | null;
  rank: number | null;
  award: ScholarshipAward | null;
  awardNote: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class ScholarshipsService {
  constructor(private prisma: PrismaService) {}

  /** 可评定的学年：由批次学期键归并（2025-2026-1 / -2 → 2025-2026） */
  async years() {
    const batches = await this.prisma.batch.findMany({ select: { id: true, semesterKey: true, name: true, status: true }, orderBy: { semesterKey: 'desc' } });
    const map = new Map<string, { semesterKey: string; status: string }[]>();
    for (const b of batches) {
      const y = b.semesterKey.slice(0, 9);
      if (!YEAR_RE.test(y)) continue;
      if (!map.has(y)) map.set(y, []);
      map.get(y)!.push({ semesterKey: b.semesterKey, status: b.status });
    }
    return [...map.entries()].map(([academicYear, terms]) => ({ academicYear, terms: terms.sort((a, b) => a.semesterKey.localeCompare(b.semesterKey)) }));
  }

  async evaluate(q: { academicYear: string; grade?: number; major?: string; failRule?: FailRule }) {
    if (!YEAR_RE.test(q.academicYear ?? '')) throw new BadRequestException('学年格式应为 2025-2026');
    const failRule: FailRule = q.failRule === 'ENGINE' ? 'ENGINE' : 'STRICT';
    const keys = [`${q.academicYear}-1`, `${q.academicYear}-2`];
    const batches = await this.prisma.batch.findMany({ where: { semesterKey: { in: keys } } });

    // ---- 每学期每生的综测总分（及引擎不及格扣分）----
    const semesters: SemesterMeta[] = [];
    const scoreBy: Map<string, { total: number; failPenalty: number }>[] = [];
    for (const key of keys) {
      const b = batches.find((x) => x.semesterKey === key);
      const m = new Map<string, { total: number; failPenalty: number }>();
      let source: SemesterMeta['source'] = 'NONE';
      let version: number | null = null;
      if (b) {
        const published = await this.prisma.calcResult.findMany({
          where: { batchId: b.id, status: 'PUBLISHED', ...(q.grade != null ? { student: { grade: q.grade } } : {}) },
          select: { studentId: true, version: true, totalScore: true, academicFailPenalty: true },
          orderBy: { version: 'desc' },
        });
        let rows = published;
        if (published.length) {
          source = 'PUBLISHED';
          version = published[0].version;
        } else if (b.currentCalcVersion > 0) {
          rows = await this.prisma.calcResult.findMany({
            where: { batchId: b.id, version: b.currentCalcVersion, ...(q.grade != null ? { student: { grade: q.grade } } : {}) },
            select: { studentId: true, version: true, totalScore: true, academicFailPenalty: true },
          });
          if (rows.length) {
            source = 'CALC';
            version = b.currentCalcVersion;
          }
        }
        // orderBy version desc：同一学生多行（增量发布）时首行即最新
        for (const r of rows) if (!m.has(r.studentId)) m.set(r.studentId, { total: Number(r.totalScore), failPenalty: Number(r.academicFailPenalty) });
      }
      semesters.push({ semesterKey: key, batchId: b?.id ?? null, batchName: b?.name ?? null, batchStatus: b?.status ?? null, source, version });
      scoreBy.push(m);
    }

    // ---- 学生范围：两学期任一有成绩，且符合年级 / 专业筛选 ----
    const ids = new Set<string>([...scoreBy[0].keys(), ...scoreBy[1].keys()]);
    const allStudents = await this.prisma.student.findMany({
      where: { id: { in: [...ids] }, ...(q.grade != null ? { grade: q.grade } : {}) },
      select: { id: true, studentNo: true, name: true, className: true, major: true, grade: true },
    });
    const grades = [...new Set(allStudents.map((s) => s.grade))].sort((a, b) => b - a);
    const majors = [...new Set(allStudents.filter((s) => !q.grade || s.grade === q.grade).map((s) => s.major).filter(Boolean))].sort();
    const students = allStudents.filter((s) => (!q.grade || s.grade === q.grade) && (!q.major || s.major === q.major));
    const sid = students.map((s) => s.id);

    // ---- 不及格课程明细（按开课学期取，不依赖成绩挂在哪个批次）----
    const failRows = sid.length
      ? await this.prisma.courseGrade.findMany({
          where: {
            studentId: { in: sid },
            termKey: { in: keys },
            credit: { gt: 0 },
            OR: [{ scoreValue: { lt: 60 } }, { scoreFlag: { in: FAIL_FLAGS } }, { scoreText: { contains: '不及格' } }],
          },
          select: {
            studentId: true, termKey: true, courseCode: true, courseName: true, credit: true, scoreValue: true, scoreText: true,
            scoreFlag: true, examType: true, courseAttr: true, courseNature: true, isPublicElective: true,
          },
          orderBy: [{ termKey: 'asc' }, { courseName: 'asc' }],
        })
      : [];
    const failsBy = new Map<string, FailCourse[]>();
    for (const g of failRows) {
      const required =
        !g.isPublicElective &&
        isRequired({ id: '', courseCode: g.courseCode, courseName: g.courseName, credit: Number(g.credit), scoreValue: null, scoreFlag: g.scoreFlag, scoreText: g.scoreText, examType: g.examType, courseAttr: g.courseAttr, courseNature: g.courseNature, isPublicElective: g.isPublicElective });
      if (!failsBy.has(g.studentId)) failsBy.set(g.studentId, []);
      failsBy.get(g.studentId)!.push({
        semesterKey: g.termKey,
        courseName: g.courseName,
        credit: Number(g.credit),
        score: g.scoreFlag || g.scoreText || (g.scoreValue != null ? String(Number(g.scoreValue)) : '-'),
        examType: g.examType,
        required,
      });
    }

    const awards = sid.length
      ? await this.prisma.scholarshipAward.findMany({ where: { academicYear: q.academicYear, studentId: { in: sid } } })
      : [];
    const awardBy = new Map(awards.map((a) => [a.studentId, a]));

    // ---- 组装 + 资格判定 ----
    const rows: ScholarshipRow[] = students.map((s) => {
      const t = scoreBy.map((m) => m.get(s.id) ?? null);
      const terms = t.map((x) => (x ? round2(x.total) : null));
      const sum = terms[0] != null && terms[1] != null ? round2(terms[0] + terms[1]) : null;
      const fails = failsBy.get(s.id) ?? [];
      const hasFail = failRule === 'ENGINE' ? t.some((x) => x && x.failPenalty > 0) : fails.length > 0;
      const missing = terms.map((v, i) => (v == null ? (i === 0 ? '第一学期' : '第二学期') : null)).filter(Boolean);
      const reason = missing.length ? `缺少${missing.join('、')}综测成绩` : hasFail ? '有挂科' : null;
      const a = awardBy.get(s.id);
      return {
        studentId: s.id,
        studentNo: s.studentNo,
        name: s.name,
        className: s.className,
        major: s.major,
        grade: s.grade,
        terms,
        sum,
        // ENGINE 口径只展示必修课明细，与扣分口径一致
        fails: failRule === 'ENGINE' ? fails.filter((f) => f.required) : fails,
        hasFail,
        eligible: !reason,
        reason,
        rank: null,
        award: (a?.award as ScholarshipAward) ?? null,
        awardNote: a?.note ?? null,
      };
    });

    // ---- 排名：参与者按总和降序，同分同名次；其次学号升序仅用于稳定展示 ----
    const ranked = rows.filter((r) => r.eligible).sort((a, b) => b.sum! - a.sum! || a.studentNo.localeCompare(b.studentNo));
    ranked.forEach((r, i) => {
      r.rank = i > 0 && ranked[i - 1].sum === r.sum ? ranked[i - 1].rank : i + 1;
    });
    const others = rows.filter((r) => !r.eligible).sort((a, b) => (b.sum ?? -1) - (a.sum ?? -1) || a.studentNo.localeCompare(b.studentNo));

    const awardCounts = Object.fromEntries(SCHOLARSHIP_AWARD_ORDER.map((k) => [k, rows.filter((r) => r.award === k).length]));
    return {
      academicYear: q.academicYear,
      failRule,
      scope: { grade: q.grade ?? null, major: q.major ?? null },
      semesters,
      grades,
      majors,
      awardCounts,
      rows: [...ranked, ...others],
    };
  }
}

@Controller('scholarships')
export class ScholarshipsController {
  constructor(
    private svc: ScholarshipsService,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('years')
  @Roles(Role.GRADE_ADMIN)
  years() {
    return this.svc.years();
  }

  @Get()
  @Roles(Role.GRADE_ADMIN)
  evaluate(@Query('academicYear') academicYear: string, @Query('grade') grade?: string, @Query('major') major?: string, @Query('failRule') failRule?: FailRule, @CurrentUser() user?: JwtUser) {
    const scope = studentScope(user!);
    return this.svc.evaluate({ academicYear, grade: scope.grade ?? (grade ? Number(grade) : undefined), major: major || undefined, failRule });
  }

  /** 设定 / 取消奖项（award 为 null 即取消）。允许给未参与排名的学生设奖（管理员裁量），前端会提示 */
  @Put('awards')
  @Roles(Role.GRADE_ADMIN)
  async setAward(@Body() dto: { academicYear: string; studentId: string; award: ScholarshipAward | null; note?: string }, @CurrentUser() user: JwtUser) {
    if (!YEAR_RE.test(dto?.academicYear ?? '')) throw new BadRequestException('学年格式应为 2025-2026');
    const student = await this.prisma.student.findUnique({ where: { id: dto.studentId }, select: { id: true, studentNo: true, name: true, grade: true, classId: true } });
    if (!student) throw new BadRequestException('学生不存在');
    assertStudentScope(user, student);
    const key = { academicYear_studentId: { academicYear: dto.academicYear, studentId: student.id } };
    if (dto.award === null || dto.award === undefined) {
      await this.prisma.scholarshipAward.deleteMany({ where: { academicYear: dto.academicYear, studentId: student.id } });
      await this.audit.log({ operatorId: user.id, operatorName: user.name, action: 'SCHOLARSHIP_CLEAR', resourceType: 'student', resourceId: student.id, detail: { academicYear: dto.academicYear, studentNo: student.studentNo } });
      return { ok: true, award: null };
    }
    if (!SCHOLARSHIP_AWARD_ORDER.includes(dto.award)) throw new BadRequestException('奖项无效');
    const note = dto.note?.trim().slice(0, 255) || null;
    const saved = await this.prisma.scholarshipAward.upsert({
      where: key,
      update: { award: dto.award, note, setById: user.id, setByName: user.name },
      create: { academicYear: dto.academicYear, studentId: student.id, award: dto.award, note, setById: user.id, setByName: user.name },
    });
    await this.audit.log({ operatorId: user.id, operatorName: user.name, action: 'SCHOLARSHIP_SET', resourceType: 'student', resourceId: student.id, detail: { academicYear: dto.academicYear, studentNo: student.studentNo, award: dto.award } });
    return saved;
  }

  /** 导出：评定总表（参与排名在前）+ 获奖名单（按奖项等级） */
  @Get('export')
  @Roles(Role.GRADE_ADMIN)
  async export(
    @Query('academicYear') academicYear: string,
    @Query('grade') grade: string | undefined,
    @Query('major') major: string | undefined,
    @Query('failRule') failRule: FailRule | undefined,
    @Res() res: Response,
    @CurrentUser() user: JwtUser,
  ) {
    const allowedScope = studentScope(user);
    const r = await this.svc.evaluate({ academicYear, grade: allowedScope.grade ?? (grade ? Number(grade) : undefined), major: major || undefined, failRule });
    const [s1, s2] = r.semesters.map((s) => `${s.semesterKey}${s.source === 'CALC' ? '（未发布）' : ''}`);
    const label = (a: ScholarshipAward | null) => (a ? SCHOLARSHIP_AWARD_LABEL[a] : '');
    const failText = (x: ScholarshipRow) => x.fails.map((f) => `${f.courseName}(${f.score})`).join('；');

    const all = XLSX.utils.aoa_to_sheet([
      ['排名', '学号', '姓名', '班级', '专业', `${s1} 综测`, `${s2} 综测`, '两学期总和', '是否挂科', '不及格课程', '参与排名', '不参与原因', '奖学金', '备注'],
      ...r.rows.map((x) => [x.rank ?? '', x.studentNo, x.name, x.className, x.major, x.terms[0] ?? '', x.terms[1] ?? '', x.sum ?? '', x.hasFail ? '是' : '否', failText(x), x.eligible ? '是' : '否', x.reason ?? '', label(x.award), x.awardNote ?? '']),
    ]);
    all['!cols'] = [6, 12, 8, 18, 14, 14, 14, 10, 8, 36, 8, 18, 14, 20].map((w) => ({ wch: w }));

    const winners = r.rows.filter((x) => x.award).sort((a, b) => SCHOLARSHIP_AWARD_ORDER.indexOf(a.award!) - SCHOLARSHIP_AWARD_ORDER.indexOf(b.award!) || (a.rank ?? 1e9) - (b.rank ?? 1e9));
    const list = XLSX.utils.aoa_to_sheet([
      ['奖学金', '排名', '学号', '姓名', '班级', '两学期总和', '备注'],
      ...winners.map((x) => [label(x.award), x.rank ?? '未参与排名', x.studentNo, x.name, x.className, x.sum ?? '', x.awardNote ?? '']),
    ]);
    list['!cols'] = [14, 10, 12, 8, 18, 10, 20].map((w) => ({ wch: w }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, all, '评定总表');
    XLSX.utils.book_append_sheet(wb, list, '获奖名单');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const scope = [r.scope.grade ? `${r.scope.grade}级` : '', r.scope.major ?? ''].filter(Boolean).join('-');
    const name = `${academicYear}学年奖学金评定${scope ? `-${scope}` : ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  }
}

@Module({
  controllers: [ScholarshipsController],
  providers: [ScholarshipsService],
})
export class ScholarshipsModule {}
