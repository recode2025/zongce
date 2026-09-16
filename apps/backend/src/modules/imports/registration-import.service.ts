import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { ImportSummary } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JobContext } from '../../queue/job.service';
import { cellNum, cellStr } from './sheet-parser';

/** 等级文本 → 平台等级枚举 */
const LEVEL_MAP: [string, string][] = [
  ['国家', 'NATIONAL'],
  ['省', 'PROVINCIAL'],
  ['市', 'MUNICIPAL'],
  ['校', 'UNIVERSITY'],
  ['院', 'COLLEGE'],
];

/** 表3 品德行为（宽表：每生一行，各列对应规则项） */
const MORAL_COLS: { kw: string; code: string; label: string }[] = [
  { kw: '优秀寝室', code: 'MORAL_DORM', label: '优秀寝室' },
  { kw: '献血', code: 'MORAL_BLOOD', label: '献血' },
  { kw: '退役', code: 'MORAL_OTHER', label: '退役复学' },
  { kw: '教官', code: 'MORAL_HONOR', label: '优秀学生教官、国旗班' },
  { kw: '班导生', code: 'MORAL_PEER_TUTOR', label: '优秀班导生' },
  { kw: '其他加分', code: 'MORAL_OTHER', label: '其他加分' },
];

/** 逐行明细 sheet 配置（表4-表11，隐 sheet 跳过：表头行含「学号」即数据 sheet） */
interface RowSheetSpec {
  /** sheet 名关键词（任一命中） */
  nameKw: string[];
  code: string;
  /** 标题列关键词（无则用规则名） */
  titleKw?: string;
  /** 等级列关键词（可选） */
  levelKw?: string;
  /** 得分列关键词 + 排除词 */
  scoreKw?: string;
  scoreNotKw?: string;
  /** 学生干部宽表特例 */
  cadreTypeKw?: string;
  /** 附加明细列：key = detail 字段名 */
  extras?: { key: string; kw: string; notKw?: string }[];
}

const ROW_SHEETS: RowSheetSpec[] = [
  { nameKw: ['社会实践'], code: 'MORAL_PRACTICE_VOLUNTEER', titleKw: '活动名称', extras: [{ key: 'activityType', kw: '类型' }, { key: 'evidenceType', kw: '佐证' }] },
  { nameKw: ['专业竞赛'], code: 'ACA_COMPETITION', titleKw: '竞赛名称', levelKw: '等级', scoreKw: '加分', extras: [{ key: 'rank', kw: '名次' }, { key: 'team', kw: '团体' }, { key: 'makeup', kw: '补录', notKw: '前' }] },
  { nameKw: ['职业技能'], code: 'ACA_CERT', titleKw: '证书名称', scoreKw: '加分' },
  { nameKw: ['科研'], code: 'ACA_RESEARCH', titleKw: '名称', scoreKw: '加分', scoreNotKw: '类型', extras: [{ key: 'type', kw: '加分类型' }, { key: 'role', kw: '身份' }, { key: 'link', kw: '链接' }] },
  { nameKw: ['学生干部'], code: 'SPORTS_CADRE', cadreTypeKw: '干部类型', scoreKw: '职位得分' },
  { nameKw: ['非专业'], code: 'SPORTS_EVENT', titleKw: '活动名称', levelKw: '奖项', scoreKw: '加分', extras: [{ key: 'partLevel', kw: '参与等级' }, { key: 'rank', kw: '名次' }, { key: 'team', kw: '团体' }] },
  { nameKw: ['校园文化'], code: 'SPORTS_CAMPUS', titleKw: '活动名称', levelKw: '奖项', scoreKw: '加分', extras: [{ key: 'partScore', kw: '参与得分' }, { key: 'rank', kw: '名次' }, { key: 'team', kw: '团体' }] },
  { nameKw: ['学术论文', '期刊'], code: 'SPORTS_JOURNAL', titleKw: '标题', scoreKw: '加分', extras: [{ key: 'type', kw: '投稿类型' }, { key: 'journal', kw: '刊物' }, { key: 'news', kw: '消息' }] },
];

interface AppRecord {
  studentId: string;
  classId: string;
  ruleCode: string;
  title: string;
  level: string | null;
  declaredScore: number | null;
  detail: Record<string, any>;
  dedupeKey: string;
  rowNo: number;
  sheet: string;
}

/** 综测登记表导入：班级官方模板（表1-表11 + 汇总表），固定格式按 sheet 语义逐行转加分申请（状态 SUBMITTED，走初审/复审） */
@Injectable()
export class RegistrationImportService {
  constructor(private prisma: PrismaService) {}

  async run(buffer: Buffer, batchId: string, ctx: JobContext): Promise<ImportSummary> {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BadRequestException('批次不存在');

    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const summary: ImportSummary = { total: 0, inserted: 0, updated: 0, skipped: 0, skippedRows: [], issues: [] };
    const records: AppRecord[] = [];
    const foundSheets = new Set<string>();
    const addSkip = (rowNo: number, reason: string) => {
      summary.skipped++;
      if (summary.skippedRows.length < 200) summary.skippedRows.push({ row: rowNo, reason });
    };

    // 学生与规则索引
    const students = await this.prisma.student.findMany({ select: { id: true, studentNo: true, classId: true } });
    const studentMap = new Map(students.map((s) => [s.studentNo, s]));
    const rules = await this.prisma.ruleItem.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } });
    const ruleByCode = new Map(rules.map((r) => [r.code, r]));
    const missingCodes = new Set<string>();

    const matrixOf = (nameRe: RegExp): { name: string; m: any[][] } | null => {
      // 优先非「隐」sheet（官方模板的浮动隐藏变体不取）
      const names = wb.SheetNames.filter((n) => nameRe.test(n.replace(/\s/g, '')));
      const name = names.find((n) => !n.startsWith('隐')) ?? names[0];
      if (!name) return null;
      const ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) return null;
      return { name, m: XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false, defval: '' }) };
    };
    /** 定位表头行（前 8 行内含「学号」的行）与列号（含关键词的首个表头） */
    const locate = (m: any[][]) => {
      for (let i = 0; i < Math.min(8, m.length); i++) {
        const row = m[i] ?? [];
        if (row.some((c) => String(c ?? '').includes('学号'))) {
          return { headerRow: row.map((c) => String(c ?? '').replace(/\s+/g, '')), headerIdx: i };
        }
      }
      return null;
    };
    const colOf = (headerRow: string[], kw: string, notKw?: string) =>
      headerRow.findIndex((h) => h.includes(kw) && (!notKw || !h.includes(notKw)));
    const norm = (v: unknown) => cellStr(v).replace(/\s+/g, '');
    const toLevel = (v: string): string | null => {
      for (const [kw, lv] of LEVEL_MAP) if (v.includes(kw)) return lv;
      return null;
    };
    const pushRecord = (r: Omit<AppRecord, 'dedupeKey'>) => {
      const dedupeKey = createHash('sha1')
        .update([r.ruleCode, r.studentId, r.title, r.level ?? '', String(r.declaredScore ?? '')].join('|'))
        .digest('hex')
        .slice(0, 32);
      records.push({ ...r, dedupeKey });
    };

    // ---- 表3 品德行为（宽表）----
    const moralSheet = matrixOf(/表3|品德/);
    if (moralSheet) {
      foundSheets.add(`表3 ${moralSheet.name}`);
      const loc = locate(moralSheet.m);
      if (loc) {
        const noCol = colOf(loc.headerRow, '学号');
        const noteCol = colOf(loc.headerRow, '备注');
        const cols = MORAL_COLS.map((c) => ({ ...c, idx: colOf(loc.headerRow, c.kw) })).filter((c) => c.idx >= 0);
        for (let r = loc.headerIdx + 1; r < moralSheet.m.length; r++) {
          const row = moralSheet.m[r] ?? [];
          const studentNo = norm(row[noCol]);
          const student = studentMap.get(studentNo);
          if (!/^\d{6,}$/.test(studentNo)) continue; // 汇总/说明行
          if (!student) {
            if (cols.some((c) => cellNum(row[c.idx]))) addSkip(r + 1, `[表3] 学号 ${studentNo} 不在学生库（请先导入学生名册）`);
            continue;
          }
          const note = noteCol >= 0 ? cellStr(row[noteCol]) : '';
          for (const c of cols) {
            const raw = cellNum(row[c.idx]);
            if (raw === null || raw === 0) continue; // 未登记
            summary.total++;
            if (!ruleByCode.has(c.code)) {
              missingCodes.add(c.code);
              summary.skipped++;
              continue;
            }
            pushRecord({
              studentId: student.id,
              classId: student.classId,
              ruleCode: c.code,
              title: c.label === '其他加分' && note ? `其他加分（${note.slice(0, 40)}）` : c.label,
              level: null,
              declaredScore: raw,
              detail: { imported: true, source: '综测登记表', sheet: moralSheet.name, row: r + 1, 登记: c.label, 备注: note || undefined },
              rowNo: r + 1,
              sheet: moralSheet.name,
            });
          }
        }
      }
    }

    // ---- 表4-表11（逐行明细）----
    for (const spec of ROW_SHEETS) {
      const sheet = matrixOf(new RegExp(spec.nameKw.join('|')));
      if (!sheet) continue;
      foundSheets.add(sheet.name);
      const loc = locate(sheet.m);
      if (!loc) continue;
      const { headerRow, headerIdx } = loc;
      const noCol = colOf(headerRow, '学号');
      const titleCol = spec.titleKw ? colOf(headerRow, spec.titleKw) : -1;
      const levelCol = spec.levelKw ? colOf(headerRow, spec.levelKw) : -1;
      const scoreCol = spec.scoreKw ? colOf(headerRow, spec.scoreKw, spec.scoreNotKw) : -1;
      const typeCol = spec.cadreTypeKw ? colOf(headerRow, spec.cadreTypeKw) : -1;
      const extraCols = (spec.extras ?? []).map((e) => ({ ...e, idx: colOf(headerRow, e.kw, e.notKw) }));
      if (noCol < 0) continue;

      for (let r = headerIdx + 1; r < sheet.m.length; r++) {
        const row = sheet.m[r] ?? [];
        const studentNo = norm(row[noCol]);
        if (!/^\d{6,}$/.test(studentNo)) continue;
        const title = titleCol >= 0 ? cellStr(row[titleCol]).slice(0, 120) : '';
        const typeText = typeCol >= 0 ? cellStr(row[typeCol]).slice(0, 60) : '';
        const levelRaw = levelCol >= 0 ? cellStr(row[levelCol]) : '';
        const score = scoreCol >= 0 ? cellNum(row[scoreCol]) : null;
        // 空行判定：无标题且无干部类型且无加分 → 跳过
        if (!title && !typeText && (score === null || score === 0)) continue;
        summary.total++;
        const student = studentMap.get(studentNo);
        if (!student) {
          addSkip(r + 1, `[${sheet.name}] 学号 ${studentNo} 不在学生库（请先导入学生名册）`);
          continue;
        }
        if (!ruleByCode.has(spec.code)) {
          missingCodes.add(spec.code);
          summary.skipped++;
          continue;
        }
        const extraDetail: Record<string, any> = {};
        for (const e of extraCols) {
          if (e.idx >= 0) {
            const v = cellStr(row[e.idx]);
            if (v) extraDetail[e.key] = v;
          }
        }
        pushRecord({
          studentId: student.id,
          classId: student.classId,
          ruleCode: spec.code,
          title: title || typeText || ruleByCode.get(spec.code)!.name,
          level: levelRaw ? toLevel(levelRaw) : null,
          declaredScore: score,
          detail: {
            imported: true,
            source: '综测登记表',
            sheet: sheet.name,
            row: r + 1,
            ...(levelRaw && !toLevel(levelRaw) ? { 等级原文: levelRaw } : {}),
            ...extraDetail,
          },
          rowNo: r + 1,
          sheet: sheet.name,
        });
        if (records.length % 200 === 0) await ctx.setProgress(Math.min(45, 10 + (records.length / 400) * 10));
      }
    }

    if (!foundSheets.size) throw new BadRequestException('未识别到综测登记表数据 sheet（需包含 表3 品德行为 或 表4-表11 明细表）');
    if (missingCodes.size) {
      summary.issues.push({ type: 'RULE_MISSING' as any, count: 0 });
      if (summary.skippedRows.length < 200)
        summary.skippedRows.push({ row: 0, reason: `平台规则字典缺少：${[...missingCodes].join('、')}，相关记录已跳过（请在规则字典中补齐后重导）` });
    }

    // ---- 幂等写入（dedupeKey 命中已有申请则跳过；同批重导不重复）----
    await ctx.setProgress(50);
    const existing = new Set<string>();
    const uniq = new Map<string, AppRecord>(); // 文件内同键去重
    for (const x of records) {
      if (uniq.has(x.dedupeKey)) {
        summary.skipped++;
        continue;
      }
      uniq.set(x.dedupeKey, x);
    }
    const all = [...uniq.values()];
    for (let i = 0; i < all.length; i += 1000) {
      const keys = all.slice(i, i + 1000).map((x) => x.dedupeKey);
      const found = await this.prisma.application.findMany({ where: { batchId, dedupeKey: { in: keys } }, select: { dedupeKey: true } });
      found.forEach((f) => existing.add(f.dedupeKey));
    }
    const fresh = all.filter((x) => !existing.has(x.dedupeKey));

    const byCategory = new Map<string, number>();
    let inserted = 0;
    const CHUNK = 200;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const chunk = fresh.slice(i, i + CHUNK);
      const r = await this.prisma.application.createMany({
        data: chunk.map((x) => ({
          batchId,
          studentId: x.studentId,
          classId: x.classId,
          ruleItemId: ruleByCode.get(x.ruleCode)!.id,
          title: x.title,
          level: x.level,
          occurredTerm: batch.semesterKey,
          detail: x.detail as any,
          declaredScore: x.declaredScore,
          dedupeKey: x.dedupeKey,
          status: 'SUBMITTED',
        })),
      });
      inserted += r.count;
      await ctx.setProgress(60 + (i / Math.max(1, fresh.length)) * 35);
    }
    for (const x of fresh) byCategory.set(x.ruleCode, (byCategory.get(x.ruleCode) ?? 0) + 1);

    summary.inserted = inserted;
    summary.updated = 0;
    summary.skipped += existing.size; // 本批次此前已导入过的记录（dedupeKey 命中）
    return { ...summary, categories: Object.fromEntries(byCategory), sheets: [...foundSheets] } as any;
  }
}
