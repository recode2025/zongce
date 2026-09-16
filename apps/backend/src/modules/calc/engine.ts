/**
 * 综测计算引擎（纯函数，无 Nest 依赖 —— 单测/golden test 直接调用）。
 * 口径依据：软件学院测评办法 + 大外校发〔2026〕7号 + 模板实测舍入（65.8469→65.85，ROUND_HALF_UP 2位）。
 *
 * 学业 75 = round2(加权均分×0.75) + 全科加分(85+→2 / 80+→1) + 竞赛/证书/科研 − 必修不及格每科1，封顶75
 * 品德 15 = 基础9 + 奖扣分（负分允许），封顶15；<9 置 flag 取消评优资格
 * 文体 10 = 基础(体育课成绩/100×3 或 3) + 干部(取最高≤3) + 活动奖励(≤4)，封顶10
 */
import { Decimal } from '../../common/utils/decimal';
import { round2, toNum } from '../../common/utils/decimal';
import { RESULT_FLAGS, GRADE_CHAR_MAP, PE_COURSE_NAME_PATTERN } from '@zc/shared';

export interface EngineCourse {
  id: string;
  courseCode: string;
  courseName: string;
  credit: number;
  scoreValue: number | null;
  scoreFlag: string; // '' / 缺考 / 缓考 / 取消考试资格
  scoreText: string;
  examType: string; // 期末考试 / 补考
  courseAttr: string; // 必修/限选/公选/任选
  courseNature: string; // 公共选修课/公共必修课/专业必修课/专业选修课
  isPublicElective: boolean;
}

export interface EngineApplication {
  id: string;
  ruleCode: string;
  category: 'MORAL' | 'ACADEMIC' | 'SPORTS';
  grantedScore: number;
}

export interface EngineRuleCap {
  takeHighest?: boolean;
  perTermMax?: number | null;
  itemCountMax?: number | null;
}

export interface EngineOptions {
  /** 全科加分阈值（默认 85/80） */
  allPassHigh: number;
  allPassLow: number;
  /** 必修不及格每科扣分（默认 1） */
  failPenaltyPerCourse: number;
  /** 活动奖励小计封顶（默认 4） */
  sportsActivityCap: number;
  moralBase: number;
  academicWeight: number; // 0.75
  moralCap: number;
  academicCap: number;
  sportsCap: number;
  /** 规则封顶元数据（来自批次规则快照 caps） */
  ruleCaps: Record<string, EngineRuleCap>;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  allPassHigh: 85,
  allPassLow: 80,
  failPenaltyPerCourse: 1,
  sportsActivityCap: 4,
  moralBase: 9,
  academicWeight: 0.75,
  moralCap: 15,
  academicCap: 75,
  sportsCap: 10,
  ruleCaps: {},
};

export interface BreakdownItem {
  key: string; // ruleCode 或 ENGINE:academicWeighted 等
  applicationIds?: string[];
  score: number;
  source: 'APPLICATION' | 'ENGINE';
  note?: string;
}

export interface EngineResult {
  studentId: string;
  flags: string[];
  // 品德
  moralBase: number;
  moralBonusByRule: Record<string, number>;
  moralTotal: number;
  // 学业
  academicWeighted: number;
  academicAllPass: number;
  academicBonusByRule: Record<string, number>;
  academicFailPenalty: number;
  academicTotal: number;
  // 文体
  sportsBase: number;
  sportsCadre: number;
  sportsActivityByRule: Record<string, number>;
  sportsActivityTotal: number;
  sportsTotal: number;
  totalScore: number;
  breakdown: BreakdownItem[];
  courseSummary: {
    courseCount: number;
    totalCredit: number;
    weightedAvg: number | null;
    peScore: number | null;
    excluded: { courseName: string; reason: string }[];
  };
}

/** 同课程多行去重：人工裁决 picked → 「期末考试」且标志空 → 最高分（flag AUTO） */
export function dedupCourses(courses: EngineCourse[], pickedGradeIds: Set<string> = new Set()): { picked: EngineCourse[]; autoPicked: boolean } {
  const groups = new Map<string, EngineCourse[]>();
  for (const c of courses) {
    const key = c.courseCode || c.courseName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const picked: EngineCourse[] = [];
  let autoPicked = false;
  for (const group of groups.values()) {
    if (group.length === 1) {
      picked.push(group[0]);
      continue;
    }
    const manual = group.find((c) => pickedGradeIds.has(c.id));
    if (manual) {
      picked.push(manual);
      continue;
    }
    const finals = group.filter((c) => c.examType === '期末考试' && !c.scoreFlag);
    if (finals.length === 1) {
      picked.push(finals[0]);
      continue;
    }
    if (finals.length > 1) {
      autoPicked = true;
      picked.push(maxByScore(finals));
      continue;
    }
    // 只有补考行等：取最高分
    autoPicked = true;
    picked.push(maxByScore(group));
  }
  return { picked, autoPicked };
}

function maxByScore(rows: EngineCourse[]): EngineCourse {
  return rows.reduce((best, c) => {
    const a = c.scoreValue ?? -1;
    const b = best.scoreValue ?? -1;
    return a > b ? c : best;
  }, rows[0]);
}

/** 判定是否必修（扣分口径）：课程属性=必修 或 课程性质含「必修」 */
function isRequired(c: EngineCourse): boolean {
  return c.courseAttr === '必修' || c.courseNature.includes('必修');
}

/** 专项体育课：公共必修 + 体育(一)/(二)…。「体育与健康」不折算（golden：大数据2025级1班全班 W=3） */
function isPeCourse(c: EngineCourse): boolean {
  return c.courseNature === '公共必修课' && PE_COURSE_NAME_PATTERN.test(c.courseName);
}

export function computeStudent(
  student: { id: string; enrollStatus: string; manualInclude?: boolean },
  courses: EngineCourse[],
  applications: EngineApplication[],
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): EngineResult {
  const flags: string[] = [];
  const breakdown: BreakdownItem[] = [];
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };

  // ---------- 课程处理 ----------
  const { picked: deduped, autoPicked } = dedupCourses(courses);
  if (autoPicked) flags.push(RESULT_FLAGS.AUTO_PICKED_MULTI_LINE);

  const excluded: { courseName: string; reason: string }[] = [];
  const participating: EngineCourse[] = []; // 参与加权
  const allPassPool: EngineCourse[] = []; // 全科加分判定池 = 参与加权课程 + 有成绩的公选课（golden 实证，见下）
  let peScore: number | null = null;

  for (const c of deduped) {
    if (c.isPublicElective) {
      // 全科 85+/80+ 判定包含公选课成绩（golden：250460101 公选73→Q=0；250460102 公选83→Q=1；250460130 公选84→Q=1，30人全吻合）
      if (c.scoreValue !== null && c.scoreValue !== undefined) allPassPool.push(c);
      excluded.push({ courseName: c.courseName, reason: '公共选修课不计入加权' });
      continue;
    }
    if (!c.credit || c.credit <= 0) {
      excluded.push({ courseName: c.courseName, reason: '学分为0' });
      continue;
    }
    if (isPeCourse(c)) peScore = c.scoreValue ?? null;
    if (c.scoreValue === null || c.scoreValue === undefined) {
      if (c.scoreFlag === '缓考') {
        flags.push(RESULT_FLAGS.PENDING_DEFERRED);
        excluded.push({ courseName: c.courseName, reason: '缓考未出成绩，暂不计入' });
      } else if (c.scoreFlag === '缺考' || c.scoreFlag === '取消考试资格') {
        excluded.push({ courseName: c.courseName, reason: `${c.scoreFlag}，无成绩` });
      } else if (c.scoreText && GRADE_CHAR_MAP[c.scoreText.trim()] !== undefined) {
        // 等级制成绩兜底映射（ETL 已前置映射，此处防御 DB 中未映射行）
        participating.push({ ...c, scoreValue: GRADE_CHAR_MAP[c.scoreText.trim()] });
        continue;
      } else {
        flags.push(RESULT_FLAGS.NON_NUMERIC_SCORE);
        excluded.push({ courseName: c.courseName, reason: `非数字成绩（${c.scoreText || '空'}）` });
      }
      continue;
    }
    participating.push(c);
    allPassPool.push(c);
  }

  // 学业加权
  let weightedAvg: Decimal | null = null;
  let academicWeighted = new Decimal(0);
  if (participating.length) {
    const sumScore = participating.reduce((s, c) => s.plus(new Decimal(c.scoreValue!).times(new Decimal(c.credit))), new Decimal(0));
    const sumCredit = participating.reduce((s, c) => s.plus(new Decimal(c.credit)), new Decimal(0));
    weightedAvg = sumScore.div(sumCredit);
    academicWeighted = round2(weightedAvg.times(new Decimal(opts.academicWeight)));
  }
  breakdown.push({ key: 'ENGINE:academicWeighted', score: toNum(academicWeighted), source: 'ENGINE', note: weightedAvg ? `加权均分 ${toNum(round2(weightedAvg))} × ${opts.academicWeight}` : '无有效成绩课程' });

  // 全科加分（判定池含公选课）
  let academicAllPass = new Decimal(0);
  if (allPassPool.length) {
    const allHigh = allPassPool.every((c) => new Decimal(c.scoreValue!).gte(opts.allPassHigh));
    const allLow = allPassPool.every((c) => new Decimal(c.scoreValue!).gte(opts.allPassLow));
    if (allHigh) academicAllPass = new Decimal(2);
    else if (allLow) academicAllPass = new Decimal(1);
  }
  if (academicAllPass.gt(0)) {
    breakdown.push({ key: 'ENGINE:academicAllPass', score: toNum(academicAllPass), source: 'ENGINE', note: `全科 ≥${academicAllPass.eq(2) ? opts.allPassHigh : opts.allPassLow}` });
  }

  // 必修不及格扣分（缺考/取消资格视为不及格）
  let failPenalty = new Decimal(0);
  for (const c of deduped) {
    if (!isRequired(c) || c.isPublicElective || !c.credit || c.credit <= 0) continue;
    const failed = (c.scoreValue !== null && c.scoreValue !== undefined && new Decimal(c.scoreValue).lt(60)) || c.scoreFlag === '缺考' || c.scoreFlag === '取消考试资格';
    if (failed) failPenalty = failPenalty.plus(new Decimal(opts.failPenaltyPerCourse));
  }
  // 等级制必修：NON_NUMERIC 已 flag，默认不计扣分（人工裁决映射分数后重算）
  if (failPenalty.gt(0)) {
    breakdown.push({ key: 'ENGINE:academicFailPenalty', score: toNum(failPenalty.negated()), source: 'ENGINE', note: '必修不及格/缺考扣分' });
  }

  // ---------- 申请加分 ----------
  const moralBonusByRule: Record<string, number> = {};
  const academicBonusByRule: Record<string, number> = {};
  const sportsActivityByRule: Record<string, number> = {};
  let sportsCadre = new Decimal(0);

  const byRule = new Map<string, EngineApplication[]>();
  for (const a of applications) {
    if (!byRule.has(a.ruleCode)) byRule.set(a.ruleCode, []);
    byRule.get(a.ruleCode)!.push(a);
  }
  for (const [ruleCode, list] of byRule) {
    const cap = opts.ruleCaps[ruleCode] ?? {};
    let subtotal: Decimal;
    if (cap.takeHighest) {
      subtotal = list.reduce((m, a) => Decimal.max(m, new Decimal(a.grantedScore)), new Decimal(0));
    } else {
      subtotal = list.reduce((s, a) => s.plus(new Decimal(a.grantedScore)), new Decimal(0));
    }
    if (cap.itemCountMax && list.length > cap.itemCountMax) {
      subtotal = list
        .map((a) => new Decimal(a.grantedScore))
        .sort((a, b) => b.comparedTo(a))
        .slice(0, cap.itemCountMax)
        .reduce((s, v) => s.plus(v), new Decimal(0));
    }
    if (cap.perTermMax !== undefined && cap.perTermMax !== null) subtotal = Decimal.min(subtotal, new Decimal(cap.perTermMax));
    subtotal = round2(subtotal);

    const head = list[0];
    if (head.category === 'MORAL') moralBonusByRule[ruleCode] = toNum(subtotal);
    else if (head.category === 'ACADEMIC') academicBonusByRule[ruleCode] = toNum(subtotal);
    else if (ruleCode === 'SPORTS_CADRE') sportsCadre = subtotal; // takeHighest + ≤3 由 caps 保证，双保险 min 3
    else sportsActivityByRule[ruleCode] = toNum(subtotal);

    breakdown.push({ key: ruleCode, applicationIds: list.map((a) => a.id), score: toNum(subtotal), source: 'APPLICATION', note: cap.takeHighest ? '同类取最高' : undefined });
  }
  sportsCadre = round2(Decimal.min(sportsCadre, 3));

  // ---------- 汇总 ----------
  const moralBonus = new Decimal(Object.values(moralBonusByRule).reduce((s, v) => s + v, 0));
  const moralTotalRaw = new Decimal(opts.moralBase).plus(moralBonus);
  const moralTotal = Decimal.min(moralTotalRaw, new Decimal(opts.moralCap));
  if (moralTotalRaw.gt(new Decimal(opts.moralCap))) flags.push(RESULT_FLAGS.CAPOUT_MORAL);
  if (moralTotal.lt(opts.moralBase)) flags.push(RESULT_FLAGS.BELOW_MORAL_9);

  const academicBonus = new Decimal(Object.values(academicBonusByRule).reduce((s, v) => s + v, 0));
  const academicTotalRaw = academicWeighted.plus(academicAllPass).plus(academicBonus).minus(failPenalty);
  const academicTotal = Decimal.min(Decimal.max(academicTotalRaw, new Decimal(0)), new Decimal(opts.academicCap));
  if (academicTotalRaw.gt(new Decimal(opts.academicCap))) flags.push(RESULT_FLAGS.CAPOUT_ACADEMIC);

  const sportsBase = peScore !== null ? round2(new Decimal(peScore).div(100).times(3)) : new Decimal(3);
  const sportsActivitySum = new Decimal(Object.values(sportsActivityByRule).reduce((s, v) => s + v, 0));
  const sportsActivityTotal = Decimal.min(sportsActivitySum, new Decimal(opts.sportsActivityCap));
  const sportsTotalRaw = sportsBase.plus(sportsCadre).plus(sportsActivityTotal);
  const sportsTotal = Decimal.min(sportsTotalRaw, new Decimal(opts.sportsCap));
  if (sportsTotalRaw.gt(new Decimal(opts.sportsCap))) flags.push(RESULT_FLAGS.CAPOUT_SPORTS);

  const totalScore = round2(moralTotal.plus(academicTotal).plus(sportsTotal));

  return {
    studentId: student.id,
    flags,
    moralBase: opts.moralBase,
    moralBonusByRule,
    moralTotal: toNum(round2(moralTotal)),
    academicWeighted: toNum(academicWeighted),
    academicAllPass: toNum(academicAllPass),
    academicBonusByRule,
    academicFailPenalty: toNum(failPenalty),
    academicTotal: toNum(round2(academicTotal)),
    sportsBase: toNum(sportsBase),
    sportsCadre: toNum(sportsCadre),
    sportsActivityByRule,
    sportsActivityTotal: toNum(sportsActivityTotal),
    sportsTotal: toNum(round2(sportsTotal)),
    totalScore: toNum(totalScore),
    breakdown,
    courseSummary: {
      courseCount: participating.length,
      totalCredit: toNum(participating.reduce((s, c) => s.plus(new Decimal(c.credit)), new Decimal(0))),
      weightedAvg: weightedAvg ? toNum(round2(weightedAvg)) : null,
      peScore,
      excluded,
    },
  };
}

/** 排名：total↓ → 品德↓ → 学业↓ → 文体↓ → 学号↑；dense rank（同分同名次） */
export function rankAll(
  rows: { studentId: string; studentNo: string; classId: string; totalScore: number; moralTotal: number; academicTotal: number; sportsTotal: number }[],
): Map<string, { rankGrade: number; rankClass: number }> {
  const sorted = [...rows].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.moralTotal !== a.moralTotal) return b.moralTotal - a.moralTotal;
    if (b.academicTotal !== a.academicTotal) return b.academicTotal - a.academicTotal;
    if (b.sportsTotal !== a.sportsTotal) return b.sportsTotal - a.sportsTotal;
    return a.studentNo.localeCompare(b.studentNo);
  });
  const out = new Map<string, { rankGrade: number; rankClass: number }>();
  // 年级 dense rank
  let lastKey = '';
  let rank = 0;
  for (const r of sorted) {
    const key = `${r.totalScore}|${r.moralTotal}|${r.academicTotal}|${r.sportsTotal}`;
    if (key !== lastKey) {
      rank++;
      lastKey = key;
    }
    const prev = out.get(r.studentId) ?? { rankGrade: 0, rankClass: 0 };
    out.set(r.studentId, { ...prev, rankGrade: rank });
  }
  // 班级 dense rank
  const byClass = new Map<string, typeof sorted>();
  for (const r of sorted) {
    if (!byClass.has(r.classId)) byClass.set(r.classId, []);
    byClass.get(r.classId)!.push(r);
  }
  for (const [, list] of byClass) {
    let lastKeyC = '';
    let rankC = 0;
    for (const r of list) {
      const key = `${r.totalScore}|${r.moralTotal}|${r.academicTotal}|${r.sportsTotal}`;
      if (key !== lastKeyC) {
        rankC++;
        lastKeyC = key;
      }
      const prev = out.get(r.studentId)!;
      out.set(r.studentId, { ...prev, rankClass: rankC });
    }
  }
  return out;
}
