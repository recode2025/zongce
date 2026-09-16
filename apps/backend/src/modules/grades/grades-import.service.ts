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

    // 分块写入（exact 去重：同 hash 幂等跳过；skipDuplicates 在 SQLite 不可用，改为预查过滤）
    const CHUNK = 500;
    const existingHashes = new Set<string>();
    for (let i = 0; i < records.length; i += 1000) {
      const hashes = records.slice(i, i + 1000).map((x) => x.rawLineHash);
      const found = await this.prisma.courseGrade.findMany({
        where: { batchId, rawLineHash: { in: hashes } },
        select: { rawLineHash: true },
      });
      found.forEach((f) => existingHashes.add(f.rawLineHash));
    }
    const fresh = records.filter((x) => !existingHashes.has(x.rawLineHash));
    summary.skipped = records.length - fresh.length;

    let inserted = 0;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const chunk = fresh.slice(i, i + CHUNK);
      const r = await this.prisma.courseGrade.createMany({
        data: chunk.map((x) => ({
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
        })),
      });
      inserted += r.count;
      await ctx.setProgress(50 + (i / records.length) * 40);
    }
    summary.inserted = inserted;
    summary.updated = 0; // 重复行已由 rawLineHash 幂等跳过

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
