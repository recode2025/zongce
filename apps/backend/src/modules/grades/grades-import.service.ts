import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ColumnMappingEntry, COURSE_NATURES, GRADE_CHAR_MAP, ImportSummary, IssueType } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JobContext } from '../../queue/job.service';
import { mappingToDict } from '../imports/column-matcher';
import { cellNum, cellStr, parseWorkbook } from '../imports/sheet-parser';

const FLAG_MISSING = '缺考';
const FLAG_DEFERRED = '缓考';
const FLAG_DISQUALIFIED = '取消考试资格';
const EXAM_FINAL = '期末考试';
const EXAM_MAKEUP = '补考';
const PUB_ELECTIVE_NATURE = '公共选修课';
/** golden 实证：专业选修课（属性=任选）计入加权（IT英语 250460114/128 两例），仅「公选」属性剔除 */
const PUB_ELECTIVE_ATTRS = ['公选'];

interface RowRecord {
  studentId: string;
  termKey: string;
  courseCode: string;
  courseName: string;
  courseNature: string;
  courseAttr: string;
  credit: number;
  hours: number | null;
  scoreText: string;
  scoreValue: number | null;
  scoreFlag: string;
  examType: string;
  makeupTerm: string | null;
  isPublicElective: boolean;
  rawLineHash: string;
  rowNo: number;
}

/** 课程成绩导入：年级成绩总表.xls（OLE2，多学期混合，含补考行） */
@Injectable()
export class GradesImportService {
  constructor(private prisma: PrismaService) {}

  async run(buffer: Buffer, mapping: ColumnMappingEntry[], batchId: string, termKey: string, ctx: JobContext): Promise<ImportSummary> {
    const dict = mappingToDict(mapping);
    const parsed = parseWorkbook(buffer);
    const summary: ImportSummary = { total: 0, inserted: 0, updated: 0, skipped: 0, skippedRows: [], issues: [] };

    // 学生存量索引（学号 → id）
    const students = await this.prisma.student.findMany({ select: { id: true, studentNo: true } });
    const studentMap = new Map(students.map((s) => [s.studentNo, s.id]));

    const pick = (row: Record<string, any>, target: string) => cellStr(dict[target] ? row[dict[target]] : '');

    const records: RowRecord[] = [];
    for (const row of parsed.rows) {
      const rowNo = row.__rowNo as number;
      const studentNo = pick(row, 'studentNo');
      const rowTerm = pick(row, 'termKey');
      const courseCode = pick(row, 'courseCode');
      const scoreText = pick(row, 'scoreText');

      if (!studentNo || !rowTerm || !courseCode) {
        summary.skipped++;
        if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: rowNo, reason: '学号/学期/课程编号为空' });
        continue;
      }
      if (rowTerm !== termKey) continue; // 只导入所选学期（文件常含多学期）

      const studentId = studentMap.get(studentNo);
      if (!studentId) {
        summary.skipped++;
        if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: rowNo, reason: `学号 ${studentNo} 不在学生库（请先导入学生信息）` });
        continue;
      }

      const courseNature = pick(row, 'courseNature');
      const courseAttr = pick(row, 'courseAttr');
      const scoreFlagRaw = pick(row, 'scoreFlag');
      const scoreFlag = [FLAG_MISSING, FLAG_DEFERRED, FLAG_DISQUALIFIED].includes(scoreFlagRaw) ? scoreFlagRaw : '';
      const examTypeRaw = pick(row, 'examType');
      const examType = examTypeRaw === '补考' ? EXAM_MAKEUP : EXAM_FINAL;
      const credit = cellNum(dict.credit ? row[dict.credit] : '') ?? 0;
      // 学分单元格可能形如 "5" 或 "5.0"；等级制成绩（优/良/中…）按 GRADE_CHAR_MAP 前置映射（golden：军事技能「优」=95）
      const scoreValue = cellNum(scoreText) ?? (!scoreFlag ? GRADE_CHAR_MAP[scoreText.trim()] ?? null : null);
      const courseName = pick(row, 'courseName');
      const makeupTerm = pick(row, 'makeupTerm') || null;

      const rawLineHash = createHash('sha256')
        .update([studentNo, rowTerm, courseCode, courseName, scoreText, scoreFlag, examTypeRaw, credit].join('|'))
        .digest('hex')
        .slice(0, 32);

      records.push({
        studentId,
        termKey: rowTerm,
        courseCode,
        courseName,
        courseNature,
        courseAttr,
        credit,
        hours: cellNum(dict.hours ? row[dict.hours] : ''),
        scoreText: scoreText.slice(0, 32),
        scoreValue: scoreFlag === FLAG_MISSING || scoreFlag === FLAG_DISQUALIFIED ? null : scoreValue,
        scoreFlag,
        examType,
        makeupTerm,
        isPublicElective: courseNature === PUB_ELECTIVE_NATURE || PUB_ELECTIVE_ATTRS.includes(courseAttr),
        rawLineHash,
        rowNo,
      });
      summary.total++;
      if (records.length % 500 === 0) await ctx.setProgress((records.length / parsed.rows.length) * 100);
    }

    // 分块写入。DB 唯一键为 (studentId,termKey,courseCode,examType,rawLineHash) 且【不含 batchId】：
    // - 文件内重复行：仅保留首行
    // - 本批次已导入：rawLineHash 幂等跳过
    // - 其他批次已导入（同学期重复建批/批次重建）：成绩行按学期全局唯一，迁移关联到本批次（calc 按 batchId 读成绩，直接跳过会导致本批次无成绩）
    const CHUNK = 500;
    const uniqKey = (x: RowRecord) => `${x.studentId}|${x.termKey}|${x.courseCode}|${x.examType}|${x.rawLineHash}`;

    // 1) 文件内重复行：仅保留首行
    const seenInFile = new Set<string>();
    const deduped: RowRecord[] = [];
    let dupInFile = 0;
    let dupFirstRowNo = 0;
    for (const x of records) {
      const k = uniqKey(x);
      if (seenInFile.has(k)) {
        dupInFile++;
        dupFirstRowNo ||= x.rowNo;
        continue;
      }
      seenInFile.add(k);
      deduped.push(x);
    }
    if (dupInFile) {
      summary.skipped += dupInFile;
      if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: dupFirstRowNo, reason: `文件内重复 ${dupInFile} 行（同学生同课程同考试类型），仅保留首行` });
    }

    // 2) 库内已存在（跨批次预查：hash → 所在 batchId）
    const existing = new Map<string, string>();
    for (let i = 0; i < deduped.length; i += 1000) {
      const hashes = deduped.slice(i, i + 1000).map((x) => x.rawLineHash);
      const found = await this.prisma.courseGrade.findMany({
        where: { rawLineHash: { in: hashes } },
        select: { rawLineHash: true, batchId: true },
      });
      found.forEach((f) => existing.set(f.rawLineHash, f.batchId));
    }
    const sameBatch = new Set([...existing.entries()].filter(([, b]) => b === batchId).map(([h]) => h));
    const crossBatchHashes = [...existing.entries()].filter(([, b]) => b !== batchId).map(([h]) => h);
    if (crossBatchHashes.length) {
      for (let i = 0; i < crossBatchHashes.length; i += CHUNK) {
        const stale = await this.prisma.courseGrade.findMany({
          where: { rawLineHash: { in: crossBatchHashes.slice(i, i + CHUNK) }, batchId: { not: batchId } },
          select: { id: true },
        });
        const ids = stale.map((s) => s.id);
        if (!ids.length) continue;
        // 旧批次上挂着的自动异常随迁移清理（本批次 rebuildIssues 会按新关联重建）
        await this.prisma.gradeIssue.deleteMany({ where: { courseGradeId: { in: ids }, resolution: 'PENDING', resolvedBy: null } });
        await this.prisma.courseGrade.updateMany({ where: { id: { in: ids } }, data: { batchId } });
      }
      if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: 0, reason: `${crossBatchHashes.length} 行已存在于其他批次（同学期成绩全局唯一），已迁移关联到本批次` });
    }

    // 3) 待插入集：本批次已有 → 幂等跳过；其他批次已有 → 上一步已迁移关联到本批次，同样不再插入
    //    （迁移过的行若再插入会撞唯一键 —— 唯一键不含 batchId，库中该 hash 已存在）
    const sameBatchRows = deduped.filter((x) => sameBatch.has(x.rawLineHash));
    if (sameBatchRows.length) {
      summary.skipped += sameBatchRows.length;
      if (summary.skippedRows.length < 200)
        summary.skippedRows.push({ row: sameBatchRows[0].rowNo, reason: `${sameBatchRows.length} 行本批次已导入过，幂等跳过` });
    }
    const fresh = deduped.filter((x) => !existing.has(x.rawLineHash));

    let inserted = 0;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const chunk = fresh.slice(i, i + CHUNK);
      const data = chunk.map((x) => ({
        batchId,
        studentId: x.studentId,
        termKey: x.termKey,
        courseCode: x.courseCode,
        courseName: x.courseName,
        courseNature: x.courseNature,
        courseAttr: x.courseAttr,
        credit: x.credit,
        hours: x.hours,
        scoreText: x.scoreText,
        scoreValue: x.scoreValue,
        scoreFlag: x.scoreFlag,
        examType: x.examType,
        makeupTerm: x.makeupTerm,
        isPublicElective: x.isPublicElective,
        rawLineHash: x.rawLineHash,
        rowNo: x.rowNo,
      }));
      // 兜底：整块撞唯一键（并发导入等极端情况）时降级逐行插入，静默跳过已存在行（SQLite 不支持 skipDuplicates）
      let count = 0;
      try {
        count = (await this.prisma.courseGrade.createMany({ data })).count;
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        for (const d of data) {
          try {
            count += (await this.prisma.courseGrade.createMany({ data: [d] })).count;
          } catch (e2: any) {
            if (e2?.code !== 'P2002') throw e2;
            summary.skipped++;
            if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: d.rowNo, reason: '该行已存在（唯一键冲突），跳过' });
          }
        }
      }
      inserted += count;
      await ctx.setProgress(50 + (i / records.length) * 40);
    }
    summary.inserted = inserted;
    summary.updated = crossBatchHashes.length; // 跨批次迁移关联的行；同批次重复行由 rawLineHash 幂等跳过

    // 重建成绩类异常队列（清除自动生成且未人工处理的，保留人工裁决记录）
    await this.rebuildIssues(batchId, termKey, ctx);
    const counts = await this.prisma.gradeIssue.groupBy({ by: ['issueType'], where: { batchId }, _count: { _all: true } });
    summary.issues = counts.map((c) => ({ type: c.issueType as IssueType, count: c._count._all }));
    await ctx.setProgress(100);
    return summary;
  }

  /** 依据已入库成绩重建异常 issue */
  private async rebuildIssues(batchId: string, termKey: string, ctx: JobContext) {
    await this.prisma.gradeIssue.deleteMany({
      where: {
        batchId,
        issueType: { in: ['RESIT_DUP', 'MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE', 'ZERO_CREDIT'] },
        resolution: 'PENDING',
        resolvedBy: null,
      },
    });

    const grades = await this.prisma.courseGrade.findMany({ where: { batchId, termKey }, orderBy: [{ studentId: 'asc' }, { courseCode: 'asc' }, { rowNo: 'asc' }] });

    const issues: { batchId: string; studentId: string; courseGradeId: string; issueType: string }[] = [];

    // 同 (student, course) 多行 → RESIT_DUP（补考/重修）
    const groups = new Map<string, typeof grades>();
    for (const g of grades) {
      const key = `${g.studentId}|${g.courseCode}`;
      const arr = groups.get(key);
      if (arr) arr.push(g);
      else groups.set(key, [g]);
    }
    for (const arr of groups.values()) {
      if (arr.length > 1) {
        // 多行中若同时存在「期末考试」与「补考」，正是"补考取第一次成绩"场景 → 以期末考试行为锚
        const anchor = arr.find((g) => g.examType === EXAM_FINAL) ?? arr[0];
        issues.push({ batchId, studentId: arr[0].studentId, courseGradeId: anchor.id, issueType: 'RESIT_DUP' });
      }
    }

    for (const g of grades) {
      if (g.scoreFlag === FLAG_MISSING) issues.push({ batchId, studentId: g.studentId, courseGradeId: g.id, issueType: 'MISSING' });
      else if (g.scoreFlag === FLAG_DISQUALIFIED) issues.push({ batchId, studentId: g.studentId, courseGradeId: g.id, issueType: 'DISQUALIFIED' });
      else if (g.scoreFlag === FLAG_DEFERRED && g.scoreValue === null) issues.push({ batchId, studentId: g.studentId, courseGradeId: g.id, issueType: 'DEFERRED_EMPTY' });
      if (!g.scoreFlag && g.scoreValue === null && g.scoreText && !/^\d+(\.\d+)?$/.test(g.scoreText)) {
        issues.push({ batchId, studentId: g.studentId, courseGradeId: g.id, issueType: 'NON_NUMERIC_SCORE' });
      }
      if (Number(g.credit) <= 0) issues.push({ batchId, studentId: g.studentId, courseGradeId: g.id, issueType: 'ZERO_CREDIT' });
    }

    // 与库中已有（人工处理过未清除的）记录按唯一键去重后再插入
    const existingKeys = new Set(
      (await this.prisma.gradeIssue.findMany({ where: { batchId }, select: { courseGradeId: true, issueType: true } })).map((r) => `${r.courseGradeId}|${r.issueType}`),
    );
    const freshIssues = issues.filter((x) => !existingKeys.has(`${x.courseGradeId}|${x.issueType}`));
    const CHUNK = 500;
    for (let i = 0; i < freshIssues.length; i += CHUNK) {
      await this.prisma.gradeIssue.createMany({ data: freshIssues.slice(i, i + CHUNK) });
      await ctx.setProgress(90 + (i / Math.max(1, freshIssues.length)) * 10);
    }
  }
}
