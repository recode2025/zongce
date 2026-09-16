import { ActivityLevel, IssueType, PackageSection, RuleCategory, WhitelistType } from './enums';

/** RuleItem.caps：加分上限/去重策略 */
export interface RuleCaps {
  /** 本学期该项累计加分上限 */
  perTermMax?: number;
  /** 本学期该项最多认定条数 */
  itemCountMax?: number;
  /** 四年内申报次数上限（如语言证书同等级 1 次） */
  perYearMax?: number;
  /** 去重作用域：CERT_NO=按证书编号 / ACTIVITY=按活动+名次 */
  dedupeScope?: 'CERT_NO' | 'ACTIVITY';
  /** 同一学期多次参加按最高档计（不累计） */
  takeHighest?: boolean;
}

/** RuleItem.evidence：佐证材料要求 */
export interface RuleEvidence {
  label: string;
  accept: ('pdf' | 'jpg' | 'jpeg' | 'png' | 'webp')[];
  required: boolean;
  hint?: string;
}

/** detailSchema：学生端动态表单描述（轻量 JSON-Schema 子集，由前端渲染） */
export interface DetailField {
  field: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'date' | 'boolean' | 'textarea';
  required?: boolean;
  options?: { label: string; value: string; score?: number }[];
  placeholder?: string;
  /** 联动分值预估：按 options[i].score 展示 */
  scoreHint?: boolean;
}

/** BatchRule.overrides：批次级可覆盖项 */
export interface RuleOverrides {
  /** 覆盖默认分值（无级别差异的项） */
  score?: number;
  /** 有级别差异项的分值表 */
  levelScoreMap?: Partial<Record<ActivityLevel, number>>;
  caps?: RuleCaps;
  /** 佐证是否必须 */
  evidenceRequired?: boolean;
}

/** WhitelistEntry.extra */
export interface CompetitionExtra {
  /** 该赛事默认级别 */
  level: ActivityLevel;
  /** 是否 A 类 */
  isA?: boolean;
}
export interface CertLangExtra {
  /** 合格分数线（CET 425） */
  minScore?: number;
  /** 认可等级（JLPT N2/N1） */
  grades?: string[];
}

/** 计算结果 breakdown 中的分项 */
export interface BreakdownItem {
  ruleCode: string;
  applicationId?: string;
  title?: string;
  score: number;
  /** 封顶/取最高被削减时说明 */
  capApplied?: string;
  note?: string;
}

/** 打包命名报告 */
export interface NamingReport {
  ok: boolean;
  zipName: string;
  expectedFiles: string[];
  missing: string[];
  warnings: string[];
}

/** 导入列映射（前端确认后提交） */
export interface ColumnMappingEntry {
  target: string;
  label: string;
  /** 源表列名（原始表头） */
  source: string | null;
  required: boolean;
}

/** 学生导入识别的目标字段 */
export interface StudentImportRow {
  studentNo: string;
  name: string;
  gender?: string;
  college?: string;
  major?: string;
  className: string;
  grade?: number;
  enrollStatusRaw?: string;
  idCard?: string;
}

/** 成绩导入识别的目标字段 */
export interface GradeImportRow {
  studentNo: string;
  name: string;
  termKey: string;
  courseCode: string;
  courseName: string;
  courseNature: string;
  courseAttr: string;
  credit: number | null;
  scoreText: string;
  scoreValue: number | null;
  scoreFlag: string;
  examType: string;
  makeupTerm?: string;
  rowNo: number;
}

export interface ImportSummary {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  skippedRows: { row: number; reason: string }[];
  issues: { type: IssueType; count: number }[];
}

export interface PackageSectionMeta {
  section: PackageSection;
  ruleCategory?: RuleCategory;
}

export interface WhitelistQuery {
  type?: WhitelistType;
  year?: number;
  keyword?: string;
}
