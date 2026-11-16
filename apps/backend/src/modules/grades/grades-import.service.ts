import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ColumnMappingEntry, GRADE_CHAR_MAP, ImportSummary, IssueType } from '@zc/shared';
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

    // 同一成绩按数据库复合唯一键去重（不含 batchId）。已存在的记录只跳过，
    // 不覆盖分数、不迁移批次，也不删除原记录上的审核/裁决信息。
    const CHUNK = 500;
    const uniqKey = (x: Pick<RowRecord, 'studentId' | 'termKey' | 'courseCode' | 'examType' | 'rawLineHash'>) =>
      JSON.stringify([x.studentId, x.termKey, x.courseCode, x.examType, x.rawLineHash]);

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

    // 2) 跨批次预查，再按完整复合键匹配，不能只凭 hash 判断另一条记录已存在。
    const existing = new Map<string, string>();
    for (let i = 0; i < deduped.length; i += 1000) {
      const hashes = deduped.slice(i, i + 1000).map((x) => x.rawLineHash);
      const found = await this.prisma.courseGrade.findMany({
        where: { rawLineHash: { in: hashes } },
        select: { studentId: true, termKey: true, courseCode: true, examType: true, rawLineHash: true, batchId: true },
      });
      found.forEach((f) => existing.set(uniqKey(f), f.batchId));
    }
    // 3) 仅插入不存在的记录；同批次和跨批次重复均计入跳过数。
    const fresh: RowRecord[] = [];
    for (const record of deduped) {
      const previousBatch = existing.get(uniqKey(record));
      if (previousBatch === undefined) {
        fresh.push(record);
        continue;
      }
      summary.skipped++;
      if (summary.skippedRows.length < 200) summary.skippedRows.push({
        row: record.rowNo,
        reason: previousBatch === batchId ? '该成绩已导入，跳过' : '该成绩已在其他批次导入，跳过并保留原批次关联',
      });
    }

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
            const duplicate = await this.prisma.courseGrade.findUnique({
              where: { studentId_termKey_courseCode_examType_rawLineHash: {
                studentId: d.studentId, termKey: d.termKey, courseCode: d.courseCode, examType: d.examType, rawLineHash: d.rawLineHash,
              } },
              select: { id: true },
            });
            if (!duplicate) throw e2; // 不吞掉其他唯一约束错误。
            summary.skipped++;
            if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: d.rowNo, reason: '该成绩已导入，跳过' });
          }
        }
      }
      inserted += count;
      await ctx.setProgress(50 + (i / records.length) * 40);
    }
    summary.inserted = inserted;
    // 补齐异常队列，也能修复上次在成绩写入后、异常生成前中断的导入。
    await this.rebuildIssues(batchId, termKey, ctx);
    const counts = await this.prisma.gradeIssue.groupBy({ by: ['issueType'], where: { batchId }, _count: { _all: true } });
    summary.issues = counts.map((c) => ({ type: c.issueType as IssueType, count: c._count._all }));
    await ctx.setProgress(100);
    return summary;
  }

  /** 依据已入库成绩重建异常 issue */
  private async rebuildIssues(batchId: string, termKey: string, ctx: JobContext) {
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

    // 保留仍有效的待处理异常和所有人工裁决，只删除已经失效的自动异常。
    const existing = await this.prisma.gradeIssue.findMany({
      where: { batchId },
      select: { id: true, courseGradeId: true, issueType: true, resolution: true, resolvedBy: true },
    });
    const issueKey = (x: { courseGradeId: string | null; issueType: string }) => JSON.stringify([x.courseGradeId, x.issueType]);
    const expectedKeys = new Set(issues.map(issueKey));
    const automaticTypes = new Set(['RESIT_DUP', 'MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE', 'ZERO_CREDIT']);
    const staleIds = existing.filter((x) => x.resolution === 'PENDING' && !x.resolvedBy && automaticTypes.has(x.issueType) && !expectedKeys.has(issueKey(x))).map((x) => x.id);
    if (staleIds.length) await this.prisma.gradeIssue.deleteMany({ where: { id: { in: staleIds }, resolution: 'PENDING', resolvedBy: null } });
    const existingKeys = new Set(existing.map(issueKey));
    const freshIssues = issues.filter((x) => !existingKeys.has(issueKey(x)));
    const CHUNK = 500;
    for (let i = 0; i < freshIssues.length; i += CHUNK) {
      const data = freshIssues.slice(i, i + CHUNK);
      try {
        await this.prisma.gradeIssue.createMany({ data });
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        for (const issue of data) {
          try {
            await this.prisma.gradeIssue.createMany({ data: [issue] });
          } catch (duplicate: any) {
            if (duplicate?.code !== 'P2002') throw duplicate;
            const found = await this.prisma.gradeIssue.findUnique({
              where: { batchId_courseGradeId_issueType: { batchId, courseGradeId: issue.courseGradeId, issueType: issue.issueType } },
              select: { id: true },
            });
            if (!found) throw duplicate;
          }
        }
      }
      await ctx.setProgress(90 + (i / Math.max(1, freshIssues.length)) * 10);
    }
  }
}
