import { BadRequestException, Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { EXPORT_COLUMNS, RESULT_FLAG_LABEL, RESULT_FLAGS, IssueResolution } from '@zc/shared';
import { Role } from '@zc/shared';
import { classifyCourse, dedupCourses, isPeCourse, isRequired, EngineCourse } from '../calc/engine';
import { Decimal, round2, toNum } from '../../common/utils/decimal';
import { PrismaService } from '../../prisma/prisma.module';
import { JobService, JobContext } from '../../queue/job.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../files/storage.service';
import { FilesModule } from '../files/files.controller';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';

/**
 * 综测结果导出：与「大数据2025级1班.xlsx」模板严格一致的 30 列双行合并表头。
 * 列取数零硬编码：EXPORT_COLUMNS.key → CalcResult 字段 / breakdown ruleCode 汇总。
 */
@Controller('exports')
export class ExportsController {
  constructor(private prisma: PrismaService, private jobs: JobService, private storage: StorageService, private audit: AuditService) {}

  /** 发起导出（CLASS 单班 / GRADE 全年级 / ACADEMIC 学业分单表）。产物为 xlsx 文件，经 files/:uuid/download 下载 */
  @Post()
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async create(@Body() dto: { batchId: string; scope: 'CLASS' | 'GRADE' | 'ACADEMIC'; classId?: string; version?: number }, @CurrentUser() user: JwtUser) {
    if (!dto?.batchId || !dto.scope) throw new BadRequestException('参数错误');
    if (dto.scope === 'CLASS' && !dto.classId) throw new BadRequestException('班级导出须指定 classId');
    const jobId = await this.jobs.start({
      kind: 'EXPORT',
      batchId: dto.batchId,
      operatorId: user.id,
      payload: dto as any,
      handler: (ctx) => this.execute(ctx, dto, user),
    });
    return { jobId };
  }

  @Get('history')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async history(@Query('batchId') batchId?: string) {
    return this.prisma.importJob.findMany({
      where: { kind: 'EXPORT', ...(batchId ? { batchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, batchId: true, status: true, progress: true, summary: true, resultFileId: true, createdAt: true, error: true },
    });
  }

  private async execute(ctx: JobContext, dto: { batchId: string; scope: 'CLASS' | 'GRADE' | 'ACADEMIC'; classId?: string; version?: number }, user: JwtUser) {
    await ctx.setProgress(5);
    const batch = await ctx.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new Error('批次不存在');

    // 导出已发布版本；未发布批次导出当前候选版（试算预览用途，summary 标注）
    let version = dto.version;
    let published = true;
    if (!version) {
      const snap = await ctx.prisma.publishSnapshot.findFirst({ where: { batchId: batch.id, status: 'ACTIVE' } });
      if (snap) version = snap.calcVersion;
      else {
        published = false;
        version = batch.currentCalcVersion;
      }
    }
    if (!version) throw new Error('该批次没有可导出的计算结果：请先在「计算引擎」页执行正式计算（试算不落库，无法导出）');

    // 发布态导出：取每生最新 PUBLISHED 行（增量发布会把更正学生的旧版置 SUPERSEDED、新版置 PUBLISHED，
    // 故不能锁定快照版本号——否则异议更正过的学生会从导出中消失）；指定 version / 候选版才锁版本号
    const where: any = { batchId: batch.id, ...(dto.scope === 'CLASS' ? { student: { classId: dto.classId! } } : {}) };
    if (dto.version) where.version = dto.version;
    else if (published) where.status = 'PUBLISHED';
    else where.version = version;

    const rows = await ctx.prisma.calcResult.findMany({
      where,
      include: { student: { select: { studentNo: true, name: true, className: true, classId: true } } },
      orderBy: [{ student: { className: 'asc' } }, { rankClass: 'asc' }],
    });
    if (!rows.length) throw new Error('无匹配的计算结果');
    if (!dto.version) version = rows.reduce((m, r) => Math.max(m, r.version), 0) || version; // 标注实际覆盖的最高版本

    // 班级名单（CLASS 单班）
    let classNames = dto.classId ? [rows[0].student.className] : [];
    if (dto.scope === 'GRADE') classNames = [...new Set(rows.map((r) => r.student.className))];

    await ctx.setProgress(40);
    const buffer = dto.scope === 'ACADEMIC' ? await this.buildAcademicWorkbook(ctx, batch, version, rows) : await this.buildWorkbook(batch.name, version, rows);
    await ctx.setProgress(85);

    const fileName =
      dto.scope === 'ACADEMIC'
        ? `软件学院_学业分_${batch.semesterKey}.xlsx`
        : dto.scope === 'CLASS'
          ? `${classNames[0]}_综测_${batch.semesterKey}.xlsx`
          : `软件学院全年级_综测_${batch.semesterKey}.xlsx`;
    const saved = await this.storage.saveExport(buffer, fileName, user.id);
    await ctx.prisma.importJob.update({ where: { id: ctx.jobId }, data: { resultFileId: saved.id } });
    await this.audit.log({
      operatorId: user.id,
      action: 'EXPORT_RESULT',
      resourceType: 'batch',
      resourceId: batch.id,
      detail: { scope: dto.scope, classes: classNames.length, students: rows.length, version, published },
    });
    return { fileUuid: saved.uuid, fileName, students: rows.length, classes: classNames.length, version, published };
  }

  /**
   * 学业分单表（如何由成绩表算出学业分，含计算依据）：
   * Sheet1「学业分」汇总：加权均分 → 加权成绩(×0.75) → 全科/奖项加分 → 扣分 → 学业总分/排名，未计入课程及原因。
   * Sheet2「计算依据」：逐课程列 成绩×学分、多行取值、剔除原因，每生末行给出完整公式推导。
   * 逐课程口径与 calc 引擎共用纯函数（dedupCourses/classifyCourse/isRequired），保证与计算结果一致。
   */
  private async buildAcademicWorkbook(ctx: JobContext, batch: { id: string; name: string; semesterKey: string }, version: number, rows: any[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = '软件学院综测平台';
    const exportedAt = new Date().toLocaleString('zh-CN');

    // ---- 装配逐课程数据（与 calc.service 完全同口径：人工裁决 picked → 引擎去重 → 分类）----
    const grades = await ctx.prisma.courseGrade.findMany({ where: { batchId: batch.id, termKey: batch.semesterKey } });
    const pickedIds = new Set(
      (await ctx.prisma.gradeIssue.findMany({
        where: { batchId: batch.id, resolution: IssueResolution.MANUAL_PICKED, pickedGradeId: { not: null } },
        select: { pickedGradeId: true },
      }))
        .map((i) => i.pickedGradeId!)
        .filter(Boolean),
    );
    const pickedGroup = new Set(grades.filter((g) => pickedIds.has(g.id)).map((g) => `${g.studentId}|${g.courseCode || g.courseName}`));
    const gradesByStudent = new Map<string, any[]>();
    const groupSize = new Map<string, number>();
    for (const g of grades) {
      const arr = gradesByStudent.get(g.studentId);
      if (arr) arr.push(g);
      else gradesByStudent.set(g.studentId, [g]);
      const k = `${g.studentId}|${g.courseCode || g.courseName}`;
      groupSize.set(k, (groupSize.get(k) ?? 0) + 1);
    }

    // 每生计算依据：逐课程行 + 公式推导汇总
    const basisByStudent = new Map<string, { lines: (string | number | null)[][]; summary: string }>();
    for (const r of rows) {
      const courses: EngineCourse[] = (gradesByStudent.get(r.studentId) ?? [])
        .filter((g) => pickedIds.has(g.id) || !pickedGroup.has(`${g.studentId}|${g.courseCode || g.courseName}`))
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
      const { picked: deduped } = dedupCourses(courses, pickedIds);

      const lines: (string | number | null)[][] = [];
      let sumScore = new Decimal(0);
      let sumCredit = new Decimal(0);
      let weightedCount = 0;
      let poolCount = 0;
      let poolMin: number | null = null;
      const failedRequired: string[] = [];
      for (const c of deduped) {
        const cl = classifyCourse(c);
        const multi = groupSize.get(`${r.studentId}|${c.courseCode || c.courseName}`) ?? 1;
        // 多行取值说明（期末+补考等）
        let pickNote = '';
        if (multi > 1)
          pickNote = pickedIds.has(c.id)
            ? `同课程 ${multi} 行，人工裁决取该行；`
            : c.examType === '期末考试' && !c.scoreFlag
              ? `同课程 ${multi} 行，取期末考试成绩行；`
              : `同课程 ${multi} 行，取最高分行；`;
        // 必修不及格（缺考/取消资格视为不及格）
        if (isRequired(c) && !c.isPublicElective && c.credit > 0) {
          const failed = (c.scoreValue !== null && c.scoreValue !== undefined && c.scoreValue < 60) || c.scoreFlag === '缺考' || c.scoreFlag === '取消考试资格';
          if (failed) failedRequired.push(`${c.courseName}(${c.scoreValue ?? c.scoreFlag})`);
        }

        let useText: string;
        let basisText: string;
        if (cl.use === 'WEIGHTED') {
          const sv = cl.mappedScore !== undefined ? cl.mappedScore : c.scoreValue!;
          sumScore = sumScore.plus(new Decimal(sv).times(new Decimal(c.credit)));
          sumCredit = sumCredit.plus(new Decimal(c.credit));
          weightedCount++;
          useText = '是';
          basisText = `${pickNote}${cl.mappedScore !== undefined ? `等级制「${c.scoreText}」折算 ${cl.mappedScore} 分；` : ''}计入加权：${sv} × ${c.credit} = ${toNum(round2(new Decimal(sv).times(new Decimal(c.credit))))}`;
        } else if (cl.use === 'ALLPASS_ONLY') {
          useText = '否（计全科判定）';
          basisText = `${pickNote}公共选修课不计入加权；成绩计入全科 85/80 加分判定`;
        } else {
          useText = '否';
          basisText = `${pickNote}${cl.reason}`;
        }
        // 全科判定池（计入加权且非等级映射 + 有成绩公选）
        const inPool = (cl.use === 'WEIGHTED' && cl.mappedScore === undefined) || cl.use === 'ALLPASS_ONLY';
        if (inPool && c.scoreValue !== null && c.scoreValue !== undefined) {
          poolCount++;
          poolMin = poolMin === null ? c.scoreValue : Math.min(poolMin, c.scoreValue);
        }
        // 体育课折算文体基础分
        if (!c.isPublicElective && c.credit > 0 && isPeCourse(c) && c.scoreValue !== null && c.scoreValue !== undefined)
          basisText += `；体育课成绩折算文体基础分（${c.scoreValue}/100×3）`;

        lines.push([
          null,
          null,
          null,
          guardFormula(c.courseName),
          c.courseNature || null,
          c.courseAttr || null,
          num(c.credit),
          c.scoreValue !== null && c.scoreValue !== undefined ? num(c.scoreValue) : cl.mappedScore !== undefined ? `${c.scoreText}→${cl.mappedScore}` : c.scoreFlag || c.scoreText || '—',
          c.examType || null,
          useText,
          basisText,
        ]);
      }

      // 公式推导（与引擎同算法重算，数值取自 CalcResult 权威结果）
      const parts: string[] = [];
      if (weightedCount > 0) {
        const avg = sumScore.div(sumCredit);
        parts.push(`加权均分 = Σ(成绩×学分) ÷ Σ学分 = ${toNum(sumScore)} ÷ ${toNum(sumCredit)} = ${toNum(round2(avg))}；加权成绩 = 加权均分 × 0.75 = ${num(r.academicWeighted)}`);
      } else {
        parts.push('无计入加权的有效成绩课程，加权成绩 0');
      }
      const ap = num(r.academicAllPass) ?? 0;
      parts.push(`全科加分 ${ap}${ap > 0 ? `（判定池 ${poolCount} 门全部 ≥ ${ap >= 2 ? 85 : 80}）` : poolCount ? `（判定池 ${poolCount} 门最低 ${poolMin} 分，未达 80）` : ''}`);
      const acaRules = ((r.breakdown as any[]) ?? []).filter((b) => String(b.key ?? '').startsWith('ACA_') && Number(b.score) > 0).map((b) => `${b.key} +${num(b.score)}`);
      parts.push(`奖项加分 ${num(r.academicBonus) ?? 0}${acaRules.length ? `（${acaRules.join('，')}）` : ''}`);
      parts.push(failedRequired.length ? `必修不及格扣分 −${num(r.academicFailPenalty)}（${failedRequired.join('、')}）` : '必修不及格扣分 0');
      const capped = ((r.flags as string[]) ?? []).includes(RESULT_FLAGS.CAPOUT_ACADEMIC);
      parts.push(
        `学业总分 = 加权成绩 ${num(r.academicWeighted)} + 全科加分 ${ap} + 奖项加分 ${num(r.academicBonus) ?? 0} − 扣分 ${num(r.academicFailPenalty) ?? 0} = ${num(r.academicTotal)}${capped ? '（超上限，按 75 封顶计）' : ''}`,
      );
      basisByStudent.set(r.studentId, { lines, summary: parts.join(' ｜ ') });
    }

    // ---- Sheet1 学业分汇总 ----
    const ws = wb.addWorksheet('学业分', {
      views: [{ state: 'frozen', ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    const HEADERS = ['班级', '学号', '姓名', '加权均分', '加权成绩(均分×0.75)', '全科加分', '奖项加分', '不及格扣分', '学业总分', '班级排名', '年级排名', '计入课程数', '总学分', '未计入课程', '说明'];
    const WIDTHS = [22, 12, 10, 10, 13, 10, 10, 11, 11, 10, 10, 12, 9, 36, 40];

    ws.mergeCells(1, 1, 1, HEADERS.length);
    const title = ws.getCell(1, 1);
    title.value = `${batch.name}（${batch.semesterKey}）学业分明细 · 计算版本 v${version} · 导出于 ${exportedAt} ｜ 口径：学业总分 = 加权成绩（加权均分×0.75）+ 全科加分（全部≥85加2 / ≥80加1）+ 奖项加分 + 不及格扣分（负值）；逐课程「成绩×学分」与剔除原因详见「计算依据」工作表`;
    title.font = { bold: true, size: 10 };
    title.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4FF' } };
    ws.getRow(1).height = 30;

    HEADERS.forEach((h, i) => {
      const c = ws.getCell(2, i + 1);
      c.value = h;
      c.font = { bold: true, size: 10 };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      ws.getColumn(i + 1).width = WIDTHS[i];
    });
    ws.getRow(2).height = 22;

    rows.forEach((r, i) => {
      const cs = (r.courseSummary ?? {}) as any;
      const excluded = (cs.excluded ?? []).map((e: any) => `${e.courseName}（${e.reason}）`).join('；');
      // 说明原因：标记含义 + 学业相关分项的计算说明
      const notes = ((r.breakdown as any[]) ?? [])
        .filter((b) => String(b.key ?? '').startsWith('ACADEMIC') && b.note)
        .map((b) => b.note);
      const flagTexts = ((r.flags as string[]) ?? []).map((f) => (RESULT_FLAG_LABEL as Record<string, string>)[f] ?? f);
      const remark = [...flagTexts, ...notes].join('；');
      const values = [
        guardFormula(r.student.className),
        guardFormula(r.student.studentNo),
        guardFormula(r.student.name),
        num(cs.weightedAvg),
        num(r.academicWeighted),
        num(r.academicAllPass),
        num(r.academicBonus),
        num(r.academicFailPenalty === null ? null : -r.academicFailPenalty), // 负值口径同 30 列模板
        num(r.academicTotal),
        r.rankClass ?? null,
        r.rankGrade ?? null,
        cs.courseCount ?? null,
        num(cs.totalCredit),
        excluded || null,
        remark || null,
      ];
      const row = ws.getRow(3 + i);
      values.forEach((v, j) => {
        const cell = row.getCell(j + 1);
        cell.value = v;
        cell.alignment = { vertical: 'middle', horizontal: j < 3 ? 'center' : j >= 13 ? 'left' : 'right', wrapText: j >= 13 };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (j >= 3 && j <= 12 && typeof v === 'number') cell.numFmt = '0.##';
      });
    });

    // 班级列按连续同班块合并
    let blockStart = 0;
    for (let i = 1; i <= rows.length; i++) {
      const prev = rows[i - 1]?.student?.className;
      const cur = rows[i]?.student?.className;
      if (cur !== prev) {
        if (i - 1 > blockStart) ws.mergeCells(blockStart + 3, 1, i + 2, 1);
        blockStart = i;
      }
    }

    // ---- Sheet2 计算依据：逐课程 + 每生公式推导 ----
    const ws2 = wb.addWorksheet('计算依据', {
      views: [{ state: 'frozen', ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    const HEADERS2 = ['班级', '学号', '姓名', '课程名称', '课程性质', '课程属性', '学分', '成绩', '考试类型', '计入加权', '计算依据 / 剔除原因'];
    const WIDTHS2 = [22, 12, 10, 28, 13, 9, 7, 10, 10, 15, 70];

    ws2.mergeCells(1, 1, 1, HEADERS2.length);
    const title2 = ws2.getCell(1, 1);
    title2.value = `${batch.name}（${batch.semesterKey}）学业分计算依据 · 计算版本 v${version} ｜ 加权均分 = Σ(计入课程成绩×学分) ÷ Σ学分，加权成绩 = 加权均分 × 0.75；全科加分：判定池内全部课程 ≥85 加 2 分、≥80 加 1 分（公选课成绩计入判定但不计入加权）；必修不及格/缺考每科扣 1 分；每生末行为总分公式推导`;
    title2.font = { bold: true, size: 10 };
    title2.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    title2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4FF' } };
    ws2.getRow(1).height = 30;

    HEADERS2.forEach((h, i) => {
      const c = ws2.getCell(2, i + 1);
      c.value = h;
      c.font = { bold: true, size: 10 };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      ws2.getColumn(i + 1).width = WIDTHS2[i];
    });
    ws2.getRow(2).height = 22;

    const border: Partial<ExcelJS.Borders> = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    let outRow = 3;
    for (const r of rows) {
      const basis = basisByStudent.get(r.studentId)!;
      const blockFirst = outRow;
      for (const line of basis.lines) {
        const values = [guardFormula(r.student.className), r.student.studentNo, r.student.name, ...line.slice(3)];
        const row = ws2.getRow(outRow);
        values.forEach((v, j) => {
          const cell = row.getCell(j + 1);
          cell.value = v;
          cell.alignment = { vertical: 'middle', horizontal: j === 10 || j === 3 ? 'left' : j === 6 || j === 7 ? 'right' : 'center', wrapText: j === 10 };
          cell.border = border;
          if ((j === 6 || j === 7) && typeof v === 'number') cell.numFmt = '0.##';
        });
        outRow++;
      }
      // 每生公式推导行
      const sumRow = ws2.getRow(outRow);
      ws2.mergeCells(outRow, 4, outRow, HEADERS2.length);
      sumRow.getCell(4).value = basis.summary;
      for (let j = 4; j <= HEADERS2.length; j++) {
        const cell = sumRow.getCell(j);
        cell.font = { bold: true, size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        cell.border = border;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };
      }
      sumRow.height = 28;
      outRow++;
      // 班级/学号/姓名 按生合并
      if (outRow - 1 > blockFirst) for (let col = 1; col <= 3; col++) ws2.mergeCells(blockFirst, col, outRow - 1, col);
    }

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  }

  private async buildWorkbook(batchName: string, version: number, rows: any[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = '软件学院综测平台';
    const ws = wb.addWorksheet('综测成绩', {
      views: [{ state: 'frozen', ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });

    // ---- 双行表头 ----
    for (const col of EXPORT_COLUMNS) {
      const c1 = ws.getCell(1, col.index);
      c1.value = col.row1;
      if (col.row2 !== undefined) ws.getCell(2, col.index).value = col.row2;
    }
    // 横向分组合并（连续同 row1 且带 row2 的列：品德 F-O / 学业 P-V / 文体 W-AC）
    let i0 = 0;
    while (i0 < EXPORT_COLUMNS.length) {
      const col = EXPORT_COLUMNS[i0];
      if (col.row2 !== undefined) {
        let j = i0;
        while (j + 1 < EXPORT_COLUMNS.length && EXPORT_COLUMNS[j + 1].row2 !== undefined && EXPORT_COLUMNS[j + 1].row1 === col.row1) j++;
        if (j > i0) ws.mergeCells(1, col.index, 1, EXPORT_COLUMNS[j].index);
        i0 = j + 1;
      } else {
        i0++;
      }
    }
    // 纵向合并（无 row2 的列）+ 班级 B1:C2 块合并
    for (const col of EXPORT_COLUMNS) {
      if (col.row2 === undefined && col.col !== 'B') ws.mergeCells(`${col.col}1:${col.col}2`);
    }
    ws.mergeCells('B1:C2');
    // 表头样式
    for (let idx = 1; idx <= EXPORT_COLUMNS.length + 1; idx++) {
      const c = ws.getRow(1).getCell(idx);
      const c2 = ws.getRow(2).getCell(idx);
      for (const cell of [c, c2]) {
        cell.font = { bold: true, size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      }
    }
    EXPORT_COLUMNS.forEach((col) => (ws.getColumn(col.index).width = col.col === 'B' || col.col === 'C' ? 7 : Math.max(9, col.row2 ? col.row2.length * 2 + 3 : col.row1.length * 1.6 + 4)));

    // ---- 数据行 ----
    rows.forEach((r, i) => {
      const excelRow = ws.getRow(3 + i);
      const breakdownMap = new Map<string, number>((r.breakdown as any[] ?? []).map((b: any) => [b.key, Number(b.score)]));
      for (const col of EXPORT_COLUMNS) {
        const cell = excelRow.getCell(col.index);
        cell.value = resolveCellValue(col.key, r, breakdownMap);
        cell.alignment = { vertical: 'middle', horizontal: col.index <= 5 || col.key === 'rankGrade' ? 'center' : 'right' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (col.index > 5 && typeof cell.value === 'number') cell.numFmt = '0.##';
      }
    });

    // ---- 班级列纵向合并（CLASS 与 GRADE 均按连续同班块合并 B:C） ----
    let blockStart = 0;
    for (let i = 1; i <= rows.length; i++) {
      const prev = rows[i - 1]?.student?.className;
      const cur = rows[i]?.student?.className;
      if (cur !== prev) {
        if (i - 1 > blockStart) {
          ws.mergeCells(blockStart + 3, 2, i + 1, 3);
        }
        blockStart = i;
      }
    }

    ws.getRow(1).height = 22;
    ws.getRow(2).height = 22;
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  }
}

/** 单元格取数：固定字段直取；rule code 槽位从 breakdown 汇总；空值留白 */
function resolveCellValue(key: string, r: any, breakdownMap: Map<string, number>): string | number | null {
  switch (key) {
    case 'rankGrade':
      return r.rankGrade ?? null;
    case 'className':
      return guardFormula(r.student.className);
    case 'studentNo':
      return guardFormula(r.student.studentNo);
    case 'name':
      return guardFormula(r.student.name);
    case 'moralBase':
      return num(r.moralBase);
    case 'moralTotal':
      return num(r.moralTotal);
    case 'academicWeighted':
      return num(r.academicWeighted);
    case 'academicAllPass':
      return num(r.academicAllPass);
    case 'academicFailPenalty':
      return num(-r.academicFailPenalty); // golden 实证：模板 R 列为负值（-1），V = P+Q+S+T+U+R
    case 'academicTotal':
      return num(r.academicTotal);
    case 'sportsBase':
      return num(r.sportsBase);
    case 'sportsCadre':
      return breakdownMap.has('SPORTS_CADRE') ? breakdownMap.get('SPORTS_CADRE')! : num(r.sportsCadre);
    case 'sportsActivityTotal':
      return num(r.sportsActivityTotal);
    case 'sportsTotal':
      return num(r.sportsTotal);
    case 'totalScore':
      return num(r.totalScore);
    default:
      return breakdownMap.has(key) ? breakdownMap.get(key)! : null;
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 公式注入防护：= + - @ 开头的文本加前导单引号 */
function guardFormula(s: string): string {
  const v = String(s ?? '');
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

@Module({
  imports: [FilesModule],
  controllers: [ExportsController],
})
export class ExportsModule {}
