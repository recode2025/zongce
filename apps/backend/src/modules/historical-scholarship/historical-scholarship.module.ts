import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as XLSX from 'xlsx';
import * as yauzl from 'yauzl';
import { Role } from '@zc/shared';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { env } from '../../config/env';

const SPECIAL_PROJECTS = new Set(['优秀退役士兵', '优秀学生教官', '文体奖学金']);
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_EXPANDED = 96 * 1024 * 1024;
const MAX_SHEETS = 32;
const MAX_RECORDS = 10000;

export interface HistoricalScholarshipRow {
  studentNo: string;
  sourceName: string;
  rawAward: string | null;
  projectName: string | null;
  note: string | null;
  isPending: boolean;
  sourceSheet: string;
  sourceRow: number;
}

interface PreviewIssue {
  sheet: string;
  row: number;
  studentNo: string;
  sourceName: string;
  reason: string;
}

interface SheetSummary {
  name: string;
  rows: number;
  matched: number;
  unmatched: number;
  nameMismatches: number;
  pending: number;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function previewToken(year: string, fileHash: string): string {
  return createHmac('sha256', env.jwtAccessSecret)
    .update(JSON.stringify(['historical-scholarship-preview-v1', year, fileHash]))
    .digest('hex');
}

function checkedYear(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{4})-(\d{4})$/.exec(s);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) {
    throw new BadRequestException('学年格式应为 2025-2026，且结束年份为开始年份加一');
  }
  return s;
}

function textCell(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === null || cell.v === undefined) return '';
  return String(cell.v).trim();
}

/** 检查 OOXML ZIP 声明大小，防止在 SheetJS 解析前加载无限制的压缩内容。 */
async function inspectXlsxArchive(buffer: Buffer): Promise<void> {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new BadRequestException('仅支持有效的 .xlsx 文件');
  }
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new BadRequestException('无法读取 Excel 文件'));
      let count = 0;
      let total = 0;
      let contentTypes = false;
      let workbook = false;
      let done = false;
      const fail = (message: string) => {
        if (done) return;
        done = true;
        zip.close();
        reject(new BadRequestException(message));
      };
      zip.on('error', () => fail('Excel 文件损坏或不受支持'));
      zip.on('entry', (entry) => {
        count++;
        total += entry.uncompressedSize;
        if (count > 500 || total > MAX_EXPANDED || entry.uncompressedSize > MAX_ENTRY ||
            (entry.compressedSize > 1024 && entry.uncompressedSize / entry.compressedSize > 500)) {
          return fail('Excel 内容超过安全限制');
        }
        if (entry.fileName === '[Content_Types].xml') contentTypes = true;
        if (entry.fileName === 'xl/workbook.xml') workbook = true;
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail('Excel 条目无法解压');
          let actual = 0;
          stream.on('data', (chunk: Buffer) => {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > MAX_ENTRY) {
              stream.destroy();
              fail('Excel 条目实际大小超过限制');
            }
          });
          stream.on('error', () => fail('Excel 条目损坏或大小不一致'));
          stream.on('end', () => { if (!done) zip.readEntry(); });
          stream.resume();
        });
      });
      zip.on('end', () => {
        if (done) return;
        done = true;
        if (!contentTypes || !workbook) return reject(new BadRequestException('不是有效的 XLSX 工作簿'));
        resolve();
      });
      zip.readEntry();
    });
  });
}

/** 保留源表行号。只读取实际存在的单元格，避免 !ref 被设置为一百多万行。 */
export function parseHistoricalScholarshipWorkbook(buffer: Buffer): HistoricalScholarshipRow[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, bookVBA: false });
  } catch {
    throw new BadRequestException('无法解析 Excel 文件');
  }
  if (!workbook.SheetNames.length || workbook.SheetNames.length > MAX_SHEETS) {
    throw new BadRequestException('Excel 工作表数量不符合要求');
  }

  const result: HistoricalScholarshipRow[] = [];
  for (const sheetName of workbook.SheetNames) {
    if (sheetName.length > 128) throw new BadRequestException('工作表名称过长');
    const sheet = workbook.Sheets[sheetName];
    const cells = Object.keys(sheet).filter((key) => /^[A-Z]+[1-9][0-9]*$/.test(key));
    if (cells.length > 200000) throw new BadRequestException('工作表单元格数量超过限制');
    if (!cells.length) continue;

    let headerRow = 0;
    const columns = new Map<string, number>();
    for (let row = 0; row < 10; row++) {
      const found = new Map<string, number>();
      for (let col = 0; col < 80; col++) {
        const value = textCell(sheet[XLSX.utils.encode_cell({ r: row, c: col })]);
        if (['学号', '姓名', '奖学金', '备注'].includes(value)) found.set(value, col);
      }
      if (found.has('学号') && found.has('姓名') && found.has('奖学金')) {
        headerRow = row + 1;
        for (const [key, value] of found) columns.set(key, value);
        break;
      }
    }
    if (!headerRow) throw new BadRequestException(`工作表「${sheetName}」未找到学号、姓名和奖学金表头，请检查文件`);
    const rows = new Set<number>();
    for (const addr of cells) {
      const pos = XLSX.utils.decode_cell(addr);
      if (pos.r + 1 > headerRow && [...columns.values()].includes(pos.c)) rows.add(pos.r);
    }
    for (const r of [...rows].sort((a, b) => a - b)) {
      const value = (key: string) => {
        const col = columns.get(key);
        return col === undefined ? '' : textCell(sheet[XLSX.utils.encode_cell({ r, c: col })]);
      };
      const studentNo = value('学号');
      const studentCell = sheet[XLSX.utils.encode_cell({ r, c: columns.get('学号')! })];
      if (studentCell && typeof studentCell.v === 'number' && !Number.isSafeInteger(studentCell.v)) {
        throw new BadRequestException(`工作表「${sheetName}」第 ${r + 1} 行的学号无法安全识别，请将学号设置为文本`);
      }
      const sourceName = value('姓名');
      const award = value('奖学金');
      const note = value('备注');
      const projectName = SPECIAL_PROJECTS.has(sheetName) ? sheetName : null;
      // 总表的空奖项是“未记录奖项”，用于展示全部学生；特色名单按用户要求关联项目。
      // 普通专业分表的空奖项不作为单独记录。
      if (!award && !projectName && sheetName !== '奖学金总表') continue;
      if (!studentNo && !sourceName && !award && !note) continue;
      if (studentNo.length > 32 || sourceName.length > 64 || award.length > 128 ||
          Buffer.byteLength(note, 'utf8') > 60000) {
        throw new BadRequestException(`工作表「${sheetName}」第 ${r + 1} 行的字段过长`);
      }
      result.push({
        studentNo, sourceName, rawAward: award || null, projectName,
        note: note || null, isPending: !!projectName && !award,
        sourceSheet: sheetName, sourceRow: r + 1,
      });
      if (result.length > MAX_RECORDS) throw new BadRequestException('历史奖学金记录数量超过限制');
    }
  }
  if (!result.length) throw new BadRequestException('未找到奖学金记录或特色名单');
  return result;
}

@Injectable()
export class HistoricalScholarshipService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async preview(file: Express.Multer.File, academicYear: unknown) {
    const year = checkedYear(academicYear);
    if (!file?.buffer || !file.originalname?.toLowerCase().endsWith('.xlsx') || file.buffer.length > MAX_UPLOAD) {
      throw new BadRequestException('请上传不超过 10MB 的 .xlsx 文件');
    }
    await inspectXlsxArchive(file.buffer);
    const rows = parseHistoricalScholarshipWorkbook(file.buffer);
    const fileHash = sha256(file.buffer);
    const importModel = (this.prisma as any).historicalScholarshipImport;
    if (!importModel) throw new Error('历史奖学金 Prisma 客户端未生成');
    const previous = await importModel.findUnique({ where: { academicYear: year } });
    if (previous && previous.fileHash !== fileHash) {
      throw new ConflictException('该学年已导入其他奖学金文件，不能叠加或覆盖，请联系管理员核对历史数据');
    }
    const numbers = [...new Set(rows.map((r) => r.studentNo).filter(Boolean))];
    const students: { id: string; studentNo: string; name: string }[] = [];
    for (let i = 0; i < numbers.length; i += 500) {
      students.push(...await this.prisma.student.findMany({
        where: { studentNo: { in: numbers.slice(i, i + 500) } },
        select: { id: true, studentNo: true, name: true },
      }));
    }
    const byNumber = new Map(students.map((s) => [s.studentNo, s]));
    const sheets = new Map<string, SheetSummary>();
    const issues: PreviewIssue[] = [];
    const matched: (HistoricalScholarshipRow & { studentId: string })[] = [];
    for (const row of rows) {
      if (!sheets.has(row.sourceSheet)) sheets.set(row.sourceSheet, {
        name: row.sourceSheet, rows: 0, matched: 0, unmatched: 0, nameMismatches: 0, pending: 0,
      });
      const s = sheets.get(row.sourceSheet)!;
      s.rows++;
      if (row.isPending) s.pending++;
      const student = byNumber.get(row.studentNo);
      if (!student) {
        s.unmatched++;
        issues.push({ sheet: row.sourceSheet, row: row.sourceRow, studentNo: row.studentNo, sourceName: row.sourceName, reason: row.studentNo ? '学号未找到现有学生' : '缺少学号' });
      } else if (!row.sourceName || student.name.trim() !== row.sourceName.trim()) {
        s.nameMismatches++;
        issues.push({ sheet: row.sourceSheet, row: row.sourceRow, studentNo: row.studentNo, sourceName: row.sourceName, reason: row.sourceName ? '姓名与学生档案不一致' : '缺少姓名' });
      } else {
        s.matched++;
        matched.push({ ...row, studentId: student.id });
      }
    }
    const list = [...sheets.values()];
    const summary = {
      sheets: list.length, rows: rows.length, matched: matched.length,
      unmatched: list.reduce((n, s) => n + s.unmatched, 0),
      nameMismatches: list.reduce((n, s) => n + s.nameMismatches, 0),
      pending: list.reduce((n, s) => n + s.pending, 0),
    };
    return { academicYear: year, fileHash, previewToken: previewToken(year, fileHash), summary, sheets: list, issues, matched };
  }

  async commit(file: Express.Multer.File, academicYear: unknown, expectedFileHash: unknown, expectedPreviewToken: unknown, user: JwtUser) {
    if (typeof expectedFileHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFileHash)) {
      throw new BadRequestException('缺少有效的预览文件校验值，请重新预览');
    }
    if (typeof expectedPreviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPreviewToken)) {
      throw new BadRequestException('缺少有效的预览令牌，请重新预览');
    }
    const preview = await this.preview(file, academicYear);
    if (preview.fileHash !== expectedFileHash) throw new BadRequestException('文件与预览不一致，请重新预览');
    if (!timingSafeEqual(Buffer.from(expectedPreviewToken, 'hex'), Buffer.from(preview.previewToken, 'hex'))) {
      throw new BadRequestException('学年或文件与预览不一致，请重新预览');
    }
    if (preview.summary.unmatched || preview.summary.nameMismatches) {
      throw new BadRequestException('存在未匹配学号或姓名不一致，请先处理预览问题');
    }
    const sourceFileName = file.originalname.replace(/.*[\\/]/g, '');
    if (!sourceFileName || sourceFileName.length > 255) throw new BadRequestException('文件名无效或过长');
    const data = preview.matched.map((r) => ({
      ...r,
      academicYear: preview.academicYear,
      sourceFileName,
      fileHash: preview.fileHash,
      sourceRecordHash: sha256(JSON.stringify([preview.academicYear, preview.fileHash, r.sourceSheet, r.sourceRow])),
      operatorId: user.id,
    }));
    // 学年元数据唯一键与记录写入在同一事务中，防止并发时不同文件混入。
    const persist = () => this.prisma.$transaction(async (tx) => {
      const model = (tx as any).historicalScholarshipRecord;
      const importModel = (tx as any).historicalScholarshipImport;
      if (!model || !importModel) throw new Error('历史奖学金 Prisma 客户端未生成');
      let batch = await importModel.findUnique({ where: { academicYear: preview.academicYear } });
      if (batch && batch.fileHash !== preview.fileHash) {
        throw new ConflictException('该学年已导入其他奖学金文件，不能叠加或覆盖，请联系管理员核对历史数据');
      }
      if (!batch) {
        // 防御旧版本或手工写入但缺少导入元数据的历史数据。
        if (await model.count({ where: { academicYear: preview.academicYear } })) {
          throw new ConflictException('该学年已有未关联导入记录，请先由管理员核对数据');
        }
        batch = await importModel.create({
          data: {
            academicYear: preview.academicYear, fileHash: preview.fileHash,
            sourceFileName, operatorId: user.id,
          },
        });
      }
      const existing = new Set<string>();
      for (let i = 0; i < data.length; i += 500) {
        const records = await model.findMany({
          where: { sourceRecordHash: { in: data.slice(i, i + 500).map((r) => r.sourceRecordHash) } },
          select: { sourceRecordHash: true },
        });
        for (const record of records) existing.add(record.sourceRecordHash);
      }
      const fresh = data.filter((record) => !existing.has(record.sourceRecordHash));
      if (!fresh.length) return { count: 0 };
      return model.createMany({ data: fresh.map((record) => ({ ...record, importId: batch.id })) });
    }, { timeout: 30000 });
    let result: { count: number };
    try {
      result = await persist();
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      // 并发创建学年元数据时，等待对方事务结束后复核文件；
      // 相同文件的重试应保持幂等，不同文件仍明确拒绝。
      try {
        result = await persist();
      } catch (retryError) {
        if ((retryError as { code?: string })?.code === 'P2002') {
          throw new ConflictException('该学年正在被导入，请重新预览并重试');
        }
        throw retryError;
      }
    }
    await this.audit.log({
      operatorId: user.id, operatorName: user.name, action: 'IMPORT',
      resourceType: 'historical-scholarship',
      detail: { academicYear: preview.academicYear, fileHash: preview.fileHash, inserted: result.count, duplicates: data.length - result.count },
    });
    return {
      academicYear: preview.academicYear, fileHash: preview.fileHash,
      summary: preview.summary, inserted: result.count, duplicates: data.length - result.count,
    };
  }

  async list(academicYear: unknown, pageRaw: unknown, pageSizeRaw: unknown) {
    const year = checkedYear(academicYear);
    const positive = (value: unknown, defaultValue: number, max: number) => {
      if (value === undefined || value === '') return defaultValue;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequestException('分页参数无效');
      return n;
    };
    const page = positive(pageRaw, 1, 100000);
    const pageSize = positive(pageSizeRaw, 50, 100);
    const model = (this.prisma as any).historicalScholarshipRecord;
    if (!model) throw new Error('历史奖学金 Prisma 客户端未生成');
    const [items, total] = await Promise.all([
      model.findMany({ where: { academicYear: year }, orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      model.count({ where: { academicYear: year } }),
    ]);
    return { items, total, page, pageSize };
  }

  /** 每生每学年汇总原文奖项及特色名单；只代表源表记录，不代表资格核验或奖金发放。 */
  async summary(academicYear: unknown, pageRaw: unknown, pageSizeRaw: unknown) {
    const year = checkedYear(academicYear);
    const positive = (value: unknown, fallback: number, max: number) => {
      if (value === undefined || value === '') return fallback;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequestException('分页参数无效');
      return n;
    };
    const page = positive(pageRaw, 1, 100000);
    const pageSize = positive(pageSizeRaw, 50, 100);
    const model = (this.prisma as any).historicalScholarshipRecord;
    if (!model) throw new Error('历史奖学金 Prisma 客户端未生成');
    const where = { historicalScholarshipRecords: { some: { academicYear: year } } };
    const [students, total] = await Promise.all([
      (this.prisma.student as any).findMany({
        where, orderBy: [{ studentNo: 'asc' }, { id: 'asc' }],
        select: { id: true, studentNo: true, name: true },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
      (this.prisma.student as any).count({ where }),
    ]);
    const rows = students.length ? await model.findMany({
      where: { academicYear: year, studentId: { in: students.map((student: any) => student.id) } },
      select: { studentId: true, rawAward: true, projectName: true, sourceSheet: true, sourceRow: true, sourceFileName: true },
      orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }],
    }) : [];
    const byStudent = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
      byStudent.get(row.studentId)!.push(row);
    }
    const items = students.map((student: { id: string; studentNo: string; name: string }) => {
      type Source = { sourceSheet: string; sourceRow: number; sourceFileName: string };
      const awards = new Map<string, Source[]>();
      const projects = new Map<string, Source[]>();
      for (const row of byStudent.get(student.id) ?? []) {
        const source = { sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, sourceFileName: row.sourceFileName };
        if (row.rawAward) {
          if (!awards.has(row.rawAward)) awards.set(row.rawAward, []);
          awards.get(row.rawAward)!.push(source);
        }
        if (row.projectName) {
          if (!projects.has(row.projectName)) projects.set(row.projectName, []);
          projects.get(row.projectName)!.push(source);
        }
      }
      const hasAward = awards.size > 0 || projects.size > 0;
      return {
        studentId: student.id, studentNo: student.studentNo, name: student.name,
        hasAward, awardStatus: hasAward ? 'RECORDED' : 'NONE_RECORDED',
        awards: [...awards].map(([name, sources]) => ({ name, sources })),
        projects: [...projects].map(([name, sources]) => ({ name, sources })),
      };
    });
    return { items, total, page, pageSize };
  }
}

@Controller('historical-import/scholarships')
export class HistoricalScholarshipController {
  constructor(private service: HistoricalScholarshipService) {}

  @Post('preview')
  @Roles(Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD } }))
  async preview(@UploadedFile() file: Express.Multer.File, @Body('academicYear') academicYear: string) {
    const { matched, ...result } = await this.service.preview(file, academicYear);
    return result;
  }

  @Post('commit')
  @Roles(Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD } }))
  commit(
    @UploadedFile() file: Express.Multer.File,
    @Body('academicYear') academicYear: string,
    @Body('expectedFileHash') expectedFileHash: string,
    @Body('expectedPreviewToken') expectedPreviewToken: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.service.commit(file, academicYear, expectedFileHash, expectedPreviewToken, user);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN)
  list(@Query('academicYear') academicYear: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.list(academicYear, page, pageSize);
  }

  @Get('summary')
  @Roles(Role.SUPER_ADMIN)
  summary(@Query('academicYear') academicYear: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.summary(academicYear, page, pageSize);
  }
}

@Module({
  controllers: [HistoricalScholarshipController],
  providers: [HistoricalScholarshipService],
})
export class HistoricalScholarshipModule {}
