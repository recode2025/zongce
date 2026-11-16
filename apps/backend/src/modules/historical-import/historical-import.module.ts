import { BadRequestException, Body, Controller, Injectable, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BatchStatus, Role } from '@zc/shared';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import * as XLSX from 'xlsx';
import * as yauzl from 'yauzl';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_DATA_ROWS = 5000;

// The only supported source is the inspected single-sheet historical grade summary.
// Deliberately do not guess columns for other workbooks.
const HEADERS = [
  '年级排名', '班级', '学号', '姓名', '基础分', '献血', '优秀学生干部，国旗班',
  '优秀班导生', '寝室', '早晚自习', '实践，志愿', '教室卫生', '其他', '品德总分',
  '学业成绩加权', '全科额外加分', '不及格学业扣分', '市级以上学术竞赛', '职业技能证书',
  '科研', '学业总分', '基础分', '学生干部', '非专业领域文体实践', '校园文化活动',
  '期刊投稿', '校园文化活动总分', '文体总分', '总分', '备注',
];
const SPRING_HEADER_TOP = ['年级排名', '专业排名', '专业', '班级', '学号', '姓名'];
const SPRING_HEADER_DETAIL = [
  '基础分', '献血', '退役复学', '优秀学生干部，国旗班', '优秀班导生', '寝室', '早晚自习',
  '实践，志愿', '教室卫生', '其他', '品德总分', '学业成绩加权', '全科额外加分', '不及格学业扣分',
  '市级以上学术竞赛', '职业技能证书', '科研', '学业总分', '基础分', '学生干部',
  '非专业领域文体实践', '校园文化活动', '期刊投稿', '校园文化活动总分', '文体总分',
];

export interface ImportIssue { row: number; code: string; message: string }
interface ScoreRow {
  row: number;
  studentNo: string;
  name: string;
  className: string;
  rankGrade: number;
  numeric: (number | null)[];
  sourceValues: (number | string | null)[];
  sourceFields: { column: string; label: string; value: number | string | null; cachedFormula: boolean }[];
  sourceSheet: string;
  sourceProfession: string | null;
  sourceProfessionRank: number | null;
  retiredBonus: number | null;
  hasCachedFormula: boolean;
  note: string;
}
interface ParsedScores { hash: string; sourceSheet: string; rows: ScoreRow[]; issues: ImportIssue[] }

function isSemesterKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{4})-([12])$/.exec(value);
  return !!match && Number(match[2]) === Number(match[1]) + 1;
}

function numberAt(sheet: XLSX.WorkSheet, row: number, col: number, allowFormula = false): number | null {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  if (!cell || (!allowFormula && cell.f) || cell.t !== 'n' || typeof cell.v !== 'number' || !Number.isFinite(cell.v)) return null;
  return cell.v;
}

function stringAt(sheet: XLSX.WorkSheet, row: number, col: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  if (!cell || cell.f || !['s', 'n'].includes(cell.t)) return '';
  return String(cell.v ?? '').trim();
}

/** Reject malformed/oversized archives before SheetJS decompresses them. */
function validateArchive(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, archive) => {
      if (err || !archive) return reject(new BadRequestException('无法读取 XLSX 文件'));
      let count = 0;
      let unpacked = 0;
      let actualTotal = 0;
      let hasContentTypes = false;
      let hasWorkbook = false;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(new BadRequestException(message));
      };
      archive.on('error', () => fail('XLSX 文件损坏'));
      archive.on('entry', (entry) => {
        count++;
        unpacked += entry.uncompressedSize;
        if (count > MAX_ENTRIES || unpacked > MAX_UNPACKED_BYTES || entry.uncompressedSize > MAX_ENTRY_BYTES) {
          return fail('XLSX 解压后内容超过大小限制');
        }
        if (entry.compressedSize > 1024 && entry.uncompressedSize / entry.compressedSize > 500) return fail('XLSX 压缩比超过安全限制');
        if (entry.generalPurposeBitFlag & 1) return fail('不支持加密的 XLSX 文件');
        if (entry.fileName === '[Content_Types].xml') hasContentTypes = true;
        if (entry.fileName === 'xl/workbook.xml') hasWorkbook = true;
        if (/vbaProject\.bin$/i.test(entry.fileName)) return fail('不支持包含宏的工作簿');
        if (entry.fileName.endsWith('/')) return archive.readEntry();
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail('XLSX 内容无法解压');
          let actualEntry = 0;
          stream.on('data', (chunk: Buffer) => {
            actualEntry += chunk.length;
            actualTotal += chunk.length;
            if (actualEntry > entry.uncompressedSize || actualEntry > MAX_ENTRY_BYTES || actualTotal > MAX_UNPACKED_BYTES) {
              stream.destroy();
              fail('XLSX 实际解压内容超过大小限制');
            }
          });
          stream.on('error', () => fail('XLSX 条目损坏或大小不一致'));
          stream.on('end', () => {
            if (settled) return;
            if (actualEntry !== entry.uncompressedSize) return fail('XLSX 条目大小不一致');
            archive.readEntry();
          });
          stream.resume();
        });
      });
      archive.on('end', () => {
        if (settled) return;
        settled = true;
        if (!hasContentTypes || !hasWorkbook) reject(new BadRequestException('文件不是有效的 XLSX 工作簿'));
        else resolve();
      });
      archive.readEntry();
    });
  });
}

export async function parseHistoricalScores(file: Express.Multer.File | undefined): Promise<ParsedScores> {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new BadRequestException('请上传 XLSX 文件');
  if (!file.originalname?.toLowerCase().endsWith('.xlsx')) throw new BadRequestException('仅支持 .xlsx 文件');
  if (file.buffer.length < 4 || file.buffer.length > MAX_FILE_BYTES || file.buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new BadRequestException('文件不是有效的 XLSX，或超过 10MB');
  }
  await validateArchive(file.buffer);
  const hash = createHash('sha256').update(file.buffer).digest('hex');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer', cellFormula: true, bookVBA: true, WTF: true });
  } catch {
    throw new BadRequestException('无法解析 XLSX 工作簿');
  }
  const hasAutumn = !!workbook.Sheets['年级总表'];
  const hasSpring = !!workbook.Sheets['综测总表'];
  if (hasAutumn === hasSpring) throw new BadRequestException('工作簿应且仅应包含一个已支持的主表（年级总表或综测总表）');
  const sourceSheet = hasAutumn ? '年级总表' : '综测总表';
  const sheet = workbook.Sheets[sourceSheet];
  if (!sheet || !sheet['!ref']) throw new BadRequestException('主表没有有效内容');
  let range: XLSX.Range;
  try { range = XLSX.utils.decode_range(sheet['!ref']); } catch { throw new BadRequestException('工作表范围无效'); }
  if (range.e.r > MAX_DATA_ROWS + 1 || range.e.c > 127 || range.e.r < 2 || range.e.c < (hasSpring ? 31 : 29)) {
    throw new BadRequestException('工作表行列范围不符合要求');
  }
  if (hasAutumn) {
    for (let col = 0; col < HEADERS.length; col++) {
      if (stringAt(sheet, 1, col) !== HEADERS[col]) throw new BadRequestException(`第 2 行第 ${col + 1} 列表头不匹配，当前不支持此格式`);
    }
  } else {
    for (let col = 0; col < SPRING_HEADER_TOP.length; col++) {
      if (stringAt(sheet, 0, col) !== SPRING_HEADER_TOP[col]) throw new BadRequestException(`第 1 行第 ${col + 1} 列表头不匹配`);
    }
    for (let i = 0; i < SPRING_HEADER_DETAIL.length; i++) {
      if (stringAt(sheet, 1, i + 6) !== SPRING_HEADER_DETAIL[i]) throw new BadRequestException(`第 2 行第 ${i + 7} 列表头不匹配`);
    }
    if (stringAt(sheet, 0, 31) !== '总分') throw new BadRequestException('第 1 行总分列不匹配');
  }

  const rows: ScoreRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  for (let r = 2; r <= range.e.r; r++) {
    const row = r + 1;
    if (!Array.from({ length: hasSpring ? 33 : HEADERS.length }, (_, c) => sheet[XLSX.utils.encode_cell({ r, c })]).some((cell) => cell && (cell.v != null || cell.f))) continue;
    const studentNo = stringAt(sheet, r, hasSpring ? 4 : 2);
    const name = stringAt(sheet, r, hasSpring ? 5 : 3);
    const className = stringAt(sheet, r, hasSpring ? 3 : 1);
    const rankGrade = numberAt(sheet, r, 0);
    const firstColumn = hasSpring ? 6 : 4;
    const detailCount = hasSpring ? 26 : 25;
    const formulaColumns = new Set(hasSpring ? [16, 23, 29, 30, 31] : []);
    const sourceFields = Array.from({ length: detailCount }, (_, i) => {
      const column = firstColumn + i;
      const cell = sheet[XLSX.utils.encode_cell({ r, c: column })];
      const raw = cell?.v;
      const value: number | string | null = raw == null || raw === '' ? null : raw;
      return {
        column: XLSX.utils.encode_col(column),
        label: hasSpring ? (i === 25 ? '总分' : SPRING_HEADER_DETAIL[i]) : HEADERS[column],
        value, cachedFormula: !!cell?.f,
      };
    });
    const values = sourceFields.map((field, i) => {
      const column = firstColumn + i;
      return numberAt(sheet, r, column, formulaColumns.has(column));
    });
    const numeric = hasSpring ? [...values.slice(0, 2), ...values.slice(3)] : values;
    if (!/^\d{6,12}$/.test(studentNo) || !name || name.length > 64 || !className || className.length > 64) {
      issues.push({ row, code: 'INVALID_IDENTITY', message: '学号、姓名或班级缺失或格式错误' });
      continue;
    }
    if (seen.has(studentNo)) {
      issues.push({ row, code: 'DUPLICATE_STUDENT', message: '学号在表内重复' });
      continue;
    }
    seen.add(studentNo);
    if (rankGrade === null || !Number.isSafeInteger(rankGrade) || rankGrade < 1 || rankGrade > MAX_DATA_ROWS) {
      issues.push({ row, code: 'INVALID_RANK', message: '年级排名必须为正整数' });
      continue;
    }
    const invalidCell = sourceFields.some((field, i) => {
      const column = firstColumn + i;
      const cell = sheet[XLSX.utils.encode_cell({ r, c: column })];
      if (cell?.f && (!formulaColumns.has(column) || values[i] === null)) return true;
      if (values[i] !== null) return Math.abs(values[i]!) > 9999;
      if (!hasSpring) return true;
      return field.value !== null && !(column === 17 && field.value === '缓考');
    });
    if (invalidCell) {
      issues.push({ row, code: 'INVALID_SCORE', message: '分数字段存在无效值或没有有效缓存的公式' });
      continue;
    }
    const scores = numeric;
    const moral = scores[9], academic = scores[16], sports = scores[23], total = scores[24];
    if (moral === null || academic === null || sports === null || total === null) {
      issues.push({ row, code: 'MISSING_TOTAL', message: '分项总分或综测总分缺失' });
      continue;
    }
    if (moral < 0 || moral > 15 || academic < 0 || academic > 75 || sports < 0 || sports > 10 || total < 0 || total > 100) {
      issues.push({ row, code: 'SCORE_RANGE', message: '分项或总分超出允许范围' });
      continue;
    }
    const componentTotal = new Decimal(moral).plus(academic).plus(sports);
    if (componentTotal.minus(total).abs().gt('0.01')) {
      issues.push({ row, code: 'TOTAL_MISMATCH', message: '三个维度总分与综测总分不一致' });
      continue;
    }
    const noteCell = sheet[XLSX.utils.encode_cell({ r, c: hasSpring ? 32 : 29 })];
    if (noteCell?.f) {
      issues.push({ row, code: 'FORMULA_UNSUPPORTED', message: '备注含公式，无法安全导入' });
      continue;
    }
    const note = String(noteCell?.v ?? '').trim();
    if (note.length > 2000) {
      issues.push({ row, code: 'NOTE_TOO_LONG', message: '备注超过 2000 字' });
      continue;
    }
    rows.push({ row, studentNo, name, className, rankGrade, numeric: scores, note,
      sourceSheet, sourceValues: sourceFields.map((x) => x.value), sourceFields,
      sourceProfession: hasSpring ? stringAt(sheet, r, 2) || null : null,
      sourceProfessionRank: hasSpring ? numberAt(sheet, r, 1) : null,
      retiredBonus: hasSpring ? values[2] : null, hasCachedFormula: sourceFields.some((x) => x.cachedFormula),
    });
  }
  if (!rows.length && !issues.length) throw new BadRequestException('表格没有数据行');
  return { hash, sourceSheet, rows, issues };
}

function assertSourceSemester(parsed: ParsedScores, semesterKey: string): void {
  const expectedTerm = parsed.sourceSheet === '年级总表' ? '1' : '2';
  if (!semesterKey.endsWith(`-${expectedTerm}`)) {
    throw new BadRequestException(`“${parsed.sourceSheet}”模板对应第 ${expectedTerm} 学期，请检查文件和学期`);
  }
}

type Reader = Pick<PrismaService, 'student' | 'batch'>;
async function matchRows(db: Reader, semesterKey: string, parsed: ParsedScores) {
  const issues = [...parsed.issues];
  const existing = await db.batch.findUnique({ where: { semesterKey }, select: { id: true } });
  if (existing) issues.push({ row: 0, code: 'BATCH_EXISTS', message: '该学期已有批次，不允许覆盖' });
  const studentByNo = new Map<string, { id: string; studentNo: string; name: string; className: string }>();
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const students = await db.student.findMany({
      where: { studentNo: { in: parsed.rows.slice(i, i + 500).map((r) => r.studentNo) } },
      select: { id: true, studentNo: true, name: true, className: true },
    });
    for (const student of students) studentByNo.set(student.studentNo, student);
  }
  const matched: { row: ScoreRow; student: { id: string; studentNo: string; name: string; className: string } }[] = [];
  for (const row of parsed.rows) {
    const student = studentByNo.get(row.studentNo);
    if (!student) issues.push({ row: row.row, code: 'STUDENT_NOT_FOUND', message: '学生不存在，请先核对名册' });
    else if (student.name.trim() !== row.name) issues.push({ row: row.row, code: 'NAME_MISMATCH', message: '学号对应的姓名与系统不一致' });
    else matched.push({ row, student });
  }
  return { issues, matched };
}

function round2(n: number): number {
  return new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

function resultData(row: ScoreRow, studentId: string, batchId: string, hash: string) {
  const a = row.numeric; // E through AC
  // Database columns are non-nullable; any zero used here for an absent detail is a
  // storage placeholder, not a statement about the historical source. The original
  // values and missing-value markers are retained below for historical displays.
  const n = (i: number) => round2(a[i] ?? 0);
  const sum = (start: number, end: number) => round2(a.slice(start, end).reduce<number>((v, item) => v + (item ?? 0), 0));
  return {
    batchId, studentId, version: 1, status: 'CANDIDATE', engineVersion: 'HISTORICAL',
    moralBase: n(0), moralBonus: round2(sum(1, 9) + (row.retiredBonus ?? 0)), moralTotal: n(9),
    academicWeighted: n(10), academicAllPass: n(11),
    academicFailPenalty: round2(Math.abs(a[12] ?? 0)), academicBonus: sum(13, 16), academicTotal: n(16),
    sportsBase: n(17), sportsCadre: n(18), sportsActivity: sum(19, 22),
    sportsActivityTotal: n(22), sportsTotal: n(23), totalScore: n(24),
    rankGrade: row.rankGrade, rankClass: null,
    breakdown: [], flags: ['HISTORICAL_IMPORT'],
    courseSummary: {
      source: 'HISTORICAL_IMPORT', hasCourseDetails: false, sourceSha256: hash,
      sourceSheet: row.sourceSheet, sourceRow: row.row, sourceClassName: row.className,
      sourceProfession: row.sourceProfession, sourceProfessionRank: row.sourceProfessionRank,
      sourceValues: row.sourceValues, sourceFields: row.sourceFields, sourceNote: row.note,
      hasCachedFormula: row.hasCachedFormula,
      hasMissingDetails: row.sourceFields.some((field) => typeof field.value !== 'number'),
    },
  };
}

@Injectable()
export class HistoricalImportService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async preview(file: Express.Multer.File | undefined, semesterKey: string) {
    if (!isSemesterKey(semesterKey)) throw new BadRequestException('学期格式应为 2025-2026-1，且年份必须连续');
    const parsed = await parseHistoricalScores(file);
    assertSourceSemester(parsed, semesterKey);
    const { issues, matched } = await matchRows(this.prisma, semesterKey, parsed);
    return {
      semesterKey, fileSha256: parsed.hash, totalRows: parsed.rows.length + parsed.issues.length,
      matchedRows: matched.length, canCommit: issues.length === 0 && matched.length > 0, issues,
      sample: matched.slice(0, 5).map(({ row, student }) => ({
        row: row.row, studentNo: row.studentNo, name: row.name, className: row.className,
        systemClassName: student.className, totalScore: round2(row.numeric[24]!), rankGrade: row.rankGrade,
      })),
      warnings: ['仅导入本表原始成绩，不自动发布；不包含课程明细，不能据此确认奖学金资格。',
        ...(parsed.rows.some((row) => row.hasCachedFormula) ? ['工作簿含公式，使用 Excel 保存的缓存值，无法确认缓存是否最新。'] : []),
        ...(parsed.rows.some((row) => row.sourceFields.some((field) => typeof field.value !== 'number')) ? ['部分历史明细为空或含非数值；原值保留，不能视为空项实际为零。'] : []),
        '本功能不与其他文件合并或校验；存在其他权威成绩来源或冲突时请勿提交。'],
    };
  }

  async commit(file: Express.Multer.File | undefined, semesterKey: string, expectedSha256: string, operatorId: string, ip: string) {
    if (!isSemesterKey(semesterKey)) throw new BadRequestException('学期格式应为 2025-2026-1，且年份必须连续');
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new BadRequestException('缺少有效的预览文件校验值');
    const parsed = await parseHistoricalScores(file);
    assertSourceSemester(parsed, semesterKey);
    if (parsed.hash !== expectedSha256) throw new BadRequestException('文件与预览不一致，请重新预览');
    try {
      const batch = await this.prisma.$transaction(async (tx) => {
        const { issues, matched } = await matchRows(tx as unknown as Reader, semesterKey, parsed);
        if (issues.length || !matched.length) throw new BadRequestException({ message: '导入校验未通过，请重新预览', issues });
        const created = await tx.batch.create({
          data: { semesterKey, name: `${semesterKey} 历史综测`, status: BatchStatus.CALCULATED, phases: [], currentCalcVersion: 1 },
          select: { id: true },
        });
        await tx.calcResult.createMany({ data: matched.map(({ row, student }) => resultData(row, student.id, created.id, parsed.hash)) });
        return { batchId: created.id, semesterKey, count: matched.length, version: 1, status: BatchStatus.CALCULATED };
      }, { timeout: 60000 });
      await this.audit.log({ operatorId, action: 'IMPORT', resourceType: 'historical-scores', resourceId: batch.batchId,
        detail: { semesterKey, count: batch.count, sourceSha256: parsed.hash }, ip });
      return batch;
    } catch (error: any) {
      if (error?.code === 'P2002') throw new BadRequestException('该学期批次已存在或导入数据重复，请重新预览');
      throw error;
    }
  }
}

@Controller('historical-import/scores')
@Roles(Role.SUPER_ADMIN)
export class HistoricalImportController {
  constructor(private service: HistoricalImportService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  preview(@UploadedFile() file: Express.Multer.File, @Body('semesterKey') semesterKey: string) {
    return this.service.preview(file, semesterKey);
  }

  @Post('commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  commit(@UploadedFile() file: Express.Multer.File, @Body('semesterKey') semesterKey: string,
    @Body('expectedSha256') expectedSha256: string, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    return this.service.commit(file, semesterKey, expectedSha256, operatorId, ip);
  }
}

@Module({ controllers: [HistoricalImportController], providers: [HistoricalImportService] })
export class HistoricalImportModule {}
