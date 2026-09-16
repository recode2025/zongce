import { BadRequestException, Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { EXPORT_COLUMNS } from '@zc/shared';
import { Role } from '@zc/shared';
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

  /** 发起导出（CLASS 单班 / GRADE 全年级）。产物为 xlsx 文件，经 files/:uuid/download 下载 */
  @Post()
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async create(@Body() dto: { batchId: string; scope: 'CLASS' | 'GRADE'; classId?: string; version?: number }, @CurrentUser() user: JwtUser) {
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

  private async execute(ctx: JobContext, dto: { batchId: string; scope: 'CLASS' | 'GRADE'; classId?: string; version?: number }, user: JwtUser) {
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
    if (!version) throw new Error('该批次没有可导出的计算结果');

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
    const buffer = await this.buildWorkbook(batch.name, version, rows);
    await ctx.setProgress(85);

    const fileName = dto.scope === 'CLASS' ? `${classNames[0]}_综测_${batch.semesterKey}.xlsx` : `软件学院全年级_综测_${batch.semesterKey}.xlsx`;
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
