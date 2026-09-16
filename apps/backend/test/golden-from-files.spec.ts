/**
 * Golden test：真实文件回算比对（口径以 大数据2025级1班.xlsx 官方产出为唯一真值）。
 *
 * 数据源：D:\【学校工作】\综测相关规则\
 *   - 年级成绩总表.xls（OLE2，12641 行，表头在第 3 行 index=2，多学期混合）
 *   - 大数据2025级1班.xlsx（双行表头 30 列，数据从第 3 行 index=2，30 名学生）
 *
 * 已从该模板反推并两例交叉验证的口径（写入引擎/ETL，此处回归锁定）：
 *   1. 等级制成绩「优」=95 计入加权（军事技能；250460114 P=50.1666、250460128 P=59.2333）
 *   2. 专业选修课（属性=任选）计入加权；仅「公共选修课/公选」剔除
 *   3. 「体育与健康」不折算文体基础分（全班 W=3），仅 体育(一) 类专项课折算
 *   4. P 列为未舍入原值（如 65.8469387755102）；V = round2(P+Q+S+T+U+R)，R 为负数；
 *      AD = round2(O+V+AC)；另有一处 AD 手误 "70,73" 需容错解析
 *
 * 规则目录可用 ZC_RULES_DIR 覆盖；文件缺失时整组 skip（CI 可移植）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { GRADE_CHAR_MAP } from '@zc/shared';
import { computeStudent, dedupCourses, rankAll, EngineCourse, DEFAULT_ENGINE_OPTIONS } from '../src/modules/calc/engine';

const RULES_DIR = process.env.ZC_RULES_DIR ?? 'D:\\【学校工作】\\综测相关规则';
const SRC = join(RULES_DIR, '年级成绩总表.xls');
const TPL = join(RULES_DIR, '大数据2025级1班.xlsx');
const TERM = '2025-2026-1';
const CLASS_NAME = '大数据2025级1班';

const describeIf = existsSync(SRC) && existsSync(TPL) ? describe : describe.skip;

/** ROUND_HALF_UP 2 位（与引擎/模板一致） */
function halfUp2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function round2eq(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < 1e-9;
}
/** 模板空单元格（null/undefined）按 0 参与恒等式；"70,73" 类手误容错 */
function cellNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 成绩总表行 → EngineCourse（与 grades ETL 同口径） */
function toEngineCourse(r: Record<string, any>, line: number): EngineCourse {
  const nature = String(r['课程性质'] ?? '').trim();
  const attr = String(r['课程属性'] ?? '').trim();
  const flag = String(r['成绩标志'] ?? '').trim();
  const rawScore = r['总成绩'];
  const numScore =
    typeof rawScore === 'number'
      ? rawScore
      : rawScore !== null && rawScore !== undefined && String(rawScore).trim() !== '' && Number.isFinite(Number(rawScore))
        ? Number(rawScore)
        : null;
  return {
    id: `${r['学号']}:${r['课程编号']}:${line}`,
    courseCode: String(r['课程编号'] ?? '').trim(),
    courseName: String(r['课程名称'] ?? '').trim(),
    credit: Number(r['学分'] ?? 0) || 0,
    scoreValue: flag === '缺考' || flag === '取消考试资格' ? null : numScore ?? (!flag ? GRADE_CHAR_MAP[String(rawScore ?? '').trim()] ?? null : null),
    scoreFlag: flag,
    scoreText: rawScore === null || rawScore === undefined ? '' : String(rawScore),
    examType: String(r['考试性质'] ?? '').trim(),
    courseAttr: attr,
    courseNature: nature,
    isPublicElective: nature === '公共选修课' || attr === '公选',
  };
}

describeIf('golden：真实成绩总表 → 引擎回算 vs 官方模板（大数据2025级1班）', () => {
  const wbSrc = XLSX.read(readFileSync(SRC), { type: 'buffer', codepage: 936 });
  const srcRows = XLSX.utils.sheet_to_json<any[]>(wbSrc.Sheets[wbSrc.SheetNames[0]], { header: 1, raw: true, defval: null });
  const header = (srcRows[2] as string[]).map((h) => (h ?? '').toString().trim());
  const records: Record<string, any>[] = [];
  for (let i = 3; i < srcRows.length; i++) {
    const row = srcRows[i];
    if (!row || row.every((c) => c === null || c === undefined || c === '')) continue;
    const obj: Record<string, any> = {};
    header.forEach((h, idx) => { if (h) obj[h] = row[idx]; });
    records.push(obj);
  }
  const classRows = records.filter((r) => String(r['班级名称'] ?? '').trim() === CLASS_NAME && String(r['开课学期'] ?? '').trim() === TERM);

  const wbTpl = XLSX.read(readFileSync(TPL), { type: 'buffer' });
  const tplRows = XLSX.utils.sheet_to_json<any[]>(wbTpl.Sheets[wbTpl.SheetNames[0]], { header: 1, raw: true, defval: null });
  // 模板列（固定下标）：A0 年级排名 D3 学号 E4 姓名 O14 品德总分 P15 学业加权(原值) Q16 全科 R17 扣分(负) S18 竞赛 T19 证书 U20 科研 V21 学业总分 W22 文体基础 AC28 文体总分 AD29 总分
  const tpl = tplRows
    .slice(2)
    .filter((r) => r && r[3])
    .map((r) => ({
      rankA: cellNum(r[0]),
      studentNo: String(r[3]).trim(),
      name: String(r[4] ?? '').trim(),
      O: cellNum(r[14]), P: cellNum(r[15]), Q: cellNum(r[16]), R: cellNum(r[17]),
      S: cellNum(r[18]), T: cellNum(r[19]), U: cellNum(r[20]), V: cellNum(r[21]),
      W: cellNum(r[22]), AC: cellNum(r[28]), AD: cellNum(r[29]),
    }));

  const byStudent = new Map<string, EngineCourse[]>();
  classRows.forEach((r, i) => {
    const no = String(r['学号']).trim();
    if (!byStudent.has(no)) byStudent.set(no, []);
    byStudent.get(no)!.push(toEngineCourse(r, i));
  });
  const results = new Map<string, ReturnType<typeof computeStudent>>();
  for (const t of tpl) {
    const courses = byStudent.get(t.studentNo) ?? [];
    results.set(t.studentNo, computeStudent({ id: t.studentNo, enrollStatus: 'NORMAL' }, courses, [], DEFAULT_ENGINE_OPTIONS));
  }

  test('前置：模板 30 名学生全部命中总表该班该学期数据', () => {
    expect(tpl.length).toBe(30);
    expect(new Set(classRows.map((r) => String(r['学号']).trim())).size).toBe(30);
    for (const t of tpl) expect(byStudent.get(t.studentNo)!.length).toBeGreaterThan(0);
  });

  test('P 列（学业成绩加权）：引擎回算 === round2(模板原值)，30/30 逐生比对', () => {
    const diffs: string[] = [];
    for (const t of tpl) {
      const res = results.get(t.studentNo)!;
      if (!round2eq(res.academicWeighted, halfUp2(t.P))) {
        diffs.push(`${t.studentNo} ${t.name}: 引擎=${res.academicWeighted} 模板P=${t.P}(round2=${halfUp2(t.P)}) 加权均分=${res.courseSummary.weightedAvg} 剔除=${JSON.stringify(res.courseSummary.excluded)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  test('Q 列（全科额外加分）：引擎 all-pass 判定 === 模板', () => {
    const diffs: string[] = [];
    for (const t of tpl) {
      const res = results.get(t.studentNo)!;
      if (!round2eq(res.academicAllPass, t.Q)) diffs.push(`${t.studentNo} ${t.name}: 引擎Q=${res.academicAllPass} 模板Q=${t.Q}`);
    }
    expect(diffs).toEqual([]);
  });

  test('R 列（不及格扣分，负值）：引擎扣分 === −模板R；补考取第一次成绩由 P 比对隐含验证', () => {
    const diffs: string[] = [];
    for (const t of tpl) {
      const res = results.get(t.studentNo)!;
      if (!round2eq(res.academicFailPenalty, -t.R)) diffs.push(`${t.studentNo} ${t.name}: 引擎扣=${res.academicFailPenalty} 模板R=${t.R}`);
    }
    expect(diffs).toEqual([]);
  });

  test('V 列（学业总分）= round2(P+Q+S+T+U+R)；引擎（无申请数据）= V−S−T−U', () => {
    const diffs: string[] = [];
    for (const t of tpl) {
      const vCalc = halfUp2(t.P + t.Q + t.S + t.T + t.U + t.R);
      if (!round2eq(vCalc, t.V)) diffs.push(`${t.studentNo} V:${t.V} ≠ 恒等式:${vCalc}`);
      const res = results.get(t.studentNo)!;
      const engineExpect = halfUp2(t.V - t.S - t.T - t.U);
      if (!round2eq(res.academicTotal, engineExpect)) diffs.push(`${t.studentNo} 引擎学业总分:${res.academicTotal} ≠ V−S−T−U:${engineExpect}`);
    }
    expect(diffs).toEqual([]);
  });

  test('W 列（文体基础分）：体育与健康不折算，全班 = 3；AD = round2(O+V+AC)', () => {
    const hasPeHealth = classRows.some((r) => /体育与健康/.test(String(r['课程名称'] ?? '')));
    expect(hasPeHealth).toBe(true); // 数据里确有体育与健康课与成绩
    const diffs: string[] = [];
    for (const t of tpl) {
      const res = results.get(t.studentNo)!;
      if (!round2eq(res.sportsBase, t.W)) diffs.push(`${t.studentNo} 引擎文体基础:${res.sportsBase} 模板W:${t.W}`);
      const adCalc = halfUp2(t.O + t.V + t.AC);
      if (!round2eq(adCalc, t.AD)) diffs.push(`${t.studentNo} AD:${t.AD} ≠ O+V+AC:${adCalc}`);
    }
    expect(diffs).toEqual([]);
  });

  test('A 列（班内排名）：引擎 dense rank（四维排序键）与模板一致', () => {
    const rows = tpl.map((t) => {
      const res = results.get(t.studentNo)!;
      return {
        studentId: t.studentNo, studentNo: t.studentNo, classId: 'c1',
        totalScore: halfUp2(t.O + t.V + t.AC), moralTotal: t.O, academicTotal: t.V, sportsTotal: t.AC,
        _res: res,
      };
    });
    const ranks = rankAll(rows as any);
    const diffs: string[] = [];
    for (const t of tpl) {
      const r = ranks.get(t.studentNo)!;
      if (r.rankClass !== t.rankA) diffs.push(`${t.studentNo} ${t.name}: 引擎班排名=${r.rankClass} 模板A=${t.rankA}`);
    }
    expect(diffs).toEqual([]);
  });

  test('dedupCourses：补考双行学生（如 250460114 基础日语1 期末45/补考62）锚定期末行', () => {
    const c114 = byStudent.get('250460114')!;
    const japanese = c114.filter((c) => c.courseName.includes('日语'));
    expect(japanese.length).toBe(2);
    const { picked } = dedupCourses(japanese);
    expect(picked[0].scoreValue).toBe(45); // 第一次（期末）成绩为准，补考 62 不覆盖
    expect(results.get('250460114')!.academicFailPenalty).toBe(1);
  });
});
