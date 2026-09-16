/** 全局枚举：以字符串常量形式存储于 DB（不用 Prisma enum，保证 MySQL/SQLite 双端兼容） */

export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',   // 超级管理员
  GRADE_ADMIN = 'GRADE_ADMIN',   // 辅导员 / 年级管理员
  CLASS_LEADER = 'CLASS_LEADER', // 班级负责人（班委）
  STUDENT = 'STUDENT',           // 学生
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  DISABLED = 'DISABLED',
}

export enum EnrollStatus {
  NORMAL = 'NORMAL',       // 有学籍/正常
  SUSPENDED = 'SUSPENDED', // 休学
  WITHDRAWN = 'WITHDRAWN', // 退学
  GRADUATED = 'GRADUATED', // 毕业
}

export enum BatchStatus {
  DRAFT = 'DRAFT',                         // 草稿
  DATA_PREP = 'DATA_PREP',                 // 数据准备（导入学生/成绩）
  COLLECTING = 'COLLECTING',               // 材料收集中
  FIRST_REVIEW = 'FIRST_REVIEW',           // 班级初审
  SECOND_REVIEW = 'SECOND_REVIEW',         // 辅导员复审
  CALCULATED = 'CALCULATED',               // 已计算
  PUBLICITY = 'PUBLICITY',                 // 公示期
  ARCHIVED = 'ARCHIVED',                   // 归档
}

export const BATCH_STATUS_FLOW: BatchStatus[] = [
  BatchStatus.DRAFT,
  BatchStatus.DATA_PREP,
  BatchStatus.COLLECTING,
  BatchStatus.FIRST_REVIEW,
  BatchStatus.SECOND_REVIEW,
  BatchStatus.CALCULATED,
  BatchStatus.PUBLICITY,
  BatchStatus.ARCHIVED,
];

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  DRAFT: '草稿',
  DATA_PREP: '数据准备',
  COLLECTING: '材料收集',
  FIRST_REVIEW: '班级初审',
  SECOND_REVIEW: '辅导员复审',
  CALCULATED: '已计算',
  PUBLICITY: '公示期',
  ARCHIVED: '已归档',
};

export enum RuleCategory {
  MORAL = 'MORAL',         // 品德行为表现
  ACADEMIC = 'ACADEMIC',   // 学业表现
  SPORTS = 'SPORTS',       // 文体表现
}

export enum WhitelistType {
  COMP_A = 'COMP_A',                       // A 类竞赛（国家级）
  COMP_B_NATIONAL = 'COMP_B_NATIONAL',     // B 类国家级
  COMP_B_PROVINCIAL = 'COMP_B_PROVINCIAL', // B 类省级
  COMP_B_MUNICIPAL = 'COMP_B_MUNICIPAL',   // B 类市级
  CERT_LANG = 'CERT_LANG',                 // 语言技能证书
}

export enum ActivityLevel {
  NATIONAL = 'NATIONAL',       // 国家级
  PROVINCIAL = 'PROVINCIAL',   // 省部级
  MUNICIPAL = 'MUNICIPAL',     // 市级
  UNIVERSITY = 'UNIVERSITY',   // 校级
  COLLEGE = 'COLLEGE',         // 院级
}

export const ACTIVITY_LEVEL_LABEL: Record<ActivityLevel, string> = {
  NATIONAL: '国家级',
  PROVINCIAL: '省部级',
  MUNICIPAL: '市级',
  UNIVERSITY: '校级',
  COLLEGE: '院级',
};

/** 压缩包命名规范中的级别前缀 */
export const LEVEL_PREFIX: Record<ActivityLevel, string> = {
  NATIONAL: '国',
  PROVINCIAL: '省',
  MUNICIPAL: '市',
  UNIVERSITY: '校',
  COLLEGE: '院',
};

export enum AppStatus {
  DRAFT = 'DRAFT',                       // 草稿（学生可改）
  SUBMITTED = 'SUBMITTED',               // 已提交待初审
  FIRST_PASSED = 'FIRST_PASSED',         // 初审通过待复审
  FIRST_REJECTED = 'FIRST_REJECTED',     // 初审退回（学生可改后重提）
  APPROVED = 'APPROVED',                 // 复审通过（进入计算）
  REJECTED = 'REJECTED',                 // 复审驳回（最终）
}

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待初审',
  FIRST_PASSED: '待复审',
  FIRST_REJECTED: '初审退回',
  APPROVED: '已认定',
  REJECTED: '已驳回',
};

export enum PackageSection {
  PRACTICE_VOLUNTEER = 'PRACTICE_VOLUNTEER', // 板块一：志愿/实践
  BONUS_EVIDENCE = 'BONUS_EVIDENCE',         // 板块二：加分证明
}

export const PACKAGE_SECTION_LABEL: Record<PackageSection, string> = {
  PRACTICE_VOLUNTEER: '志愿/实践板块',
  BONUS_EVIDENCE: '加分证明板块',
};

export enum PackageStatus {
  NOT_SUBMITTED = 'NOT_SUBMITTED',
  SUBMITTED = 'SUBMITTED',
  FIRST_PASSED = 'FIRST_PASSED',
  FIRST_REJECTED = 'FIRST_REJECTED',
}

export enum IssueType {
  RESIT_DUP = 'RESIT_DUP',               // 补考/同课程多行
  MISSING = 'MISSING',                   // 缺考
  DEFERRED_EMPTY = 'DEFERRED_EMPTY',     // 缓考未出成绩
  DISQUALIFIED = 'DISQUALIFIED',         // 取消考试资格
  SUSPENDED = 'SUSPENDED',               // 休学/无学籍学生
  NON_NUMERIC_SCORE = 'NON_NUMERIC_SCORE', // 等级制成绩（合格/优秀）
  ZERO_CREDIT = 'ZERO_CREDIT',           // 学分为 0 或空
}

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  RESIT_DUP: '补考/重复成绩行',
  MISSING: '缺考',
  DEFERRED_EMPTY: '缓考未出成绩',
  DISQUALIFIED: '取消考试资格',
  SUSPENDED: '休学/学籍异常',
  NON_NUMERIC_SCORE: '等级制成绩',
  ZERO_CREDIT: '学分为0或空',
};

export enum IssueResolution {
  PENDING = 'PENDING',
  AUTO_PICK_FINAL = 'AUTO_PICK_FINAL',
  MANUAL_PICKED = 'MANUAL_PICKED',
  EXCLUDED = 'EXCLUDED',
  INCLUDED = 'INCLUDED',
}

export enum ResultStatus {
  CANDIDATE = 'CANDIDATE',
  PUBLISHED = 'PUBLISHED',
  SUPERSEDED = 'SUPERSEDED',
}

export enum ImportJobKind {
  STUDENT = 'STUDENT',
  GRADE = 'GRADE',
  EXPORT = 'EXPORT',
  CALC = 'CALC',
}

export enum ImportJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

export enum ObjectionStatus {
  SUBMITTED = 'SUBMITTED',
  ACCEPTED = 'ACCEPTED',     // 异议成立 → 更正
  REJECTED = 'REJECTED',     // 异议不成立 → 维持
}

/** 成绩标志（教务导出原文） */
export const SCORE_FLAGS = {
  MISSING: '缺考',
  DEFERRED: '缓考',
  DISQUALIFIED: '取消考试资格',
} as const;

export const EXAM_TYPES = {
  FINAL: '期末考试',
  MAKEUP: '补考',
} as const;

/** 课程性质（教务导出原文） */
export const COURSE_NATURES = {
  PUB_ELECTIVE: '公共选修课',
  PUB_REQUIRED: '公共必修课',
  MAJOR_REQUIRED: '专业必修课',
  MAJOR_ELECTIVE: '专业选修课',
} as const;

/** 课程属性 */
export const COURSE_ATTRS = {
  REQUIRED: '必修',
  LIMITED: '限选',
  PUBLIC: '公选',
  FREE: '任选',
} as const;
