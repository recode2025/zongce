/** 导出模板 30 列定义（与 大数据2025级1班.xlsx 双行合并表头严格一致）
 *  实测模板结构：
 *  - 双行表头；A1:A2/D1:D2/E1:E2/AD1:AD2 纵向合并
 *  - B1:C2 班级（B、C 两列，数据行纵向合并 B3:C32）
 *  - F1:O1 品德组、P1:W1 学业组、X1:AC1 文体组（横向合并，第二行为小项名）
 *  - 文体组共 6+1 列：W 基础分、X 学生干部、Y 非专业领域文体实践、Z 校园文化活动、AA 期刊投稿、
 *    AB 校园文化活动总分、AC 文体总分（AC 属文体组表头合并范围内但为汇总列）
 */
export interface ExportColumn {
  /** Excel 列字母 */
  col: string;
  /** 列序号（1-based） */
  index: number;
  row1: string;
  row2?: string;
  group?: 'MORAL' | 'ACADEMIC' | 'SPORTS';
  /** 取数键：CalcResult 固定字段或 breakdown 中的 rule code */
  key: string;
}

const C = (index: number, col: string, row1: string, row2: string | undefined, key: string, group?: ExportColumn['group']): ExportColumn =>
  ({ index, col, row1, row2, key, group });

export const EXPORT_COLUMNS: ExportColumn[] = [
  C(1, 'A', '年级排名', undefined, 'rankGrade'),
  C(2, 'B', '班级', undefined, 'className'),
  C(4, 'D', '学号', undefined, 'studentNo'),
  C(5, 'E', '姓名', undefined, 'name'),
  C(6, 'F', '品德行为表现测评', '基础分', 'moralBase', 'MORAL'),
  C(7, 'G', '品德行为表现测评', '献血', 'MORAL_BLOOD', 'MORAL'),
  C(8, 'H', '品德行为表现测评', '优秀学生干部，国旗班', 'MORAL_HONOR', 'MORAL'),
  C(9, 'I', '品德行为表现测评', '优秀班导生', 'MORAL_PEER_TUTOR', 'MORAL'),
  C(10, 'J', '品德行为表现测评', '寝室', 'MORAL_DORM', 'MORAL'),
  C(11, 'K', '品德行为表现测评', '早晚自习', 'MORAL_SELFSTUDY', 'MORAL'),
  C(12, 'L', '品德行为表现测评', '实践，志愿', 'MORAL_PRACTICE_VOLUNTEER', 'MORAL'),
  C(13, 'M', '品德行为表现测评', '教室卫生', 'MORAL_CLASSROOM', 'MORAL'),
  C(14, 'N', '品德行为表现测评', '其他', 'MORAL_OTHER', 'MORAL'),
  C(15, 'O', '品德行为表现测评', '品德总分', 'moralTotal', 'MORAL'),
  C(16, 'P', '学业表现', '学业成绩加权', 'academicWeighted', 'ACADEMIC'),
  C(17, 'Q', '学业表现', '全科额外加分', 'academicAllPass', 'ACADEMIC'),
  C(18, 'R', '学业表现', '不及格学业扣分', 'academicFailPenalty', 'ACADEMIC'),
  C(19, 'S', '学业表现', '市级以上学术竞赛', 'ACA_COMPETITION', 'ACADEMIC'),
  C(20, 'T', '学业表现', '职业技能证书', 'ACA_CERT', 'ACADEMIC'),
  C(21, 'U', '学业表现', '科研', 'ACA_RESEARCH', 'ACADEMIC'),
  C(22, 'V', '学业表现', '学业总分', 'academicTotal', 'ACADEMIC'),
  C(23, 'W', '文体表现', '基础分', 'sportsBase', 'SPORTS'),
  C(24, 'X', '文体表现', '学生干部', 'SPORTS_CADRE', 'SPORTS'),
  C(25, 'Y', '文体表现', '非专业领域文体实践', 'SPORTS_EVENT', 'SPORTS'),
  C(26, 'Z', '文体表现', '校园文化活动', 'SPORTS_CAMPUS', 'SPORTS'),
  C(27, 'AA', '文体表现', '期刊投稿', 'SPORTS_JOURNAL', 'SPORTS'),
  C(28, 'AB', '文体表现', '校园文化活动总分', 'sportsActivityTotal', 'SPORTS'),
  C(29, 'AC', '文体表现', '文体总分', 'sportsTotal', 'SPORTS'),
  C(30, 'AD', '总分', undefined, 'totalScore'),
];

/** 各组内映射到 breakdown rule code 的列 */
export const MORAL_EXPORT_SLOTS = [
  'MORAL_BLOOD', 'MORAL_HONOR', 'MORAL_PEER_TUTOR', 'MORAL_DORM',
  'MORAL_SELFSTUDY', 'MORAL_PRACTICE_VOLUNTEER', 'MORAL_CLASSROOM', 'MORAL_OTHER',
] as const;

export const ACADEMIC_EXPORT_SLOTS = ['ACA_COMPETITION', 'ACA_CERT', 'ACA_RESEARCH'] as const;
export const SPORTS_EXPORT_SLOTS = ['SPORTS_CADRE', 'SPORTS_EVENT', 'SPORTS_CAMPUS', 'SPORTS_JOURNAL'] as const;

/**
 * 等级制成绩 → 分数映射（golden 实测：大数据2025级1班 军事技能「优」按 95 计入加权，
 * 250460114 P=50.1666 / 250460128 P=59.2333 两例交叉验证）。良/中/及格为通行惯例默认值，未见样本。
 */
export const GRADE_CHAR_MAP: Record<string, number> = {
  '优': 95,
  '良': 85,
  '中': 75,
  '及格': 65,
  '不及格': 55,
  '合格': 85,
  '不合格': 55,
};

/** 专项体育课判定（公共必修 + 体育(一)/(二)…）。「体育与健康」属必修体能课，不折算文体基础分（golden 全班 W=3 实证） */
export const PE_COURSE_NAME_PATTERN = /^体育[(（]/;

/** 计算结果 flag */
export const RESULT_FLAGS = {
  BELOW_MORAL_9: 'BELOW_MORAL_9',
  PENDING_DEFERRED: 'PENDING_DEFERRED',
  SUSPENDED_EXCLUDED: 'SUSPENDED_EXCLUDED',
  AUTO_PICKED_MULTI_LINE: 'AUTO_PICKED_MULTI_LINE',
  NON_NUMERIC_SCORE: 'NON_NUMERIC_SCORE',
  CAPOUT_MORAL: 'CAPOUT_MORAL_15',
  CAPOUT_ACADEMIC: 'CAPOUT_ACADEMIC_75',
  CAPOUT_SPORTS: 'CAPOUT_SPORTS_10',
} as const;

export const RESULT_FLAG_LABEL: Record<string, string> = {
  BELOW_MORAL_9: '品德分不足9分，取消评奖评优资格',
  PENDING_DEFERRED: '存在缓考未出成绩课程',
  SUSPENDED_EXCLUDED: '休学/学籍异常，默认排除计算',
  AUTO_PICKED_MULTI_LINE: '存在多行成绩自动取分，请复核',
  NON_NUMERIC_SCORE: '存在等级制/非数字成绩，默认未计入加权',
  CAPOUT_MORAL: '品德加分已封顶15分',
  CAPOUT_ACADEMIC: '学业总分已封顶75分',
  CAPOUT_SPORTS: '文体总分已封顶10分',
};

/** 材料命名规范（引导打包/命名校验共用）
 *  zip 名模板中的占位符：{studentNo} {name} {practiceCount} {volunteerCount} {bonusCount} {compCount} {certs} {cadre}
 */
export const NAMING_RULES = {
  practiceVolunteerZip: '{studentNo} {name} {practiceCount}社会实践 {volunteerCount}志愿服务',
  practiceFile: '社会实践',
  volunteerFile: '志愿服务',
  bonusEvidenceZip: '{studentNo} {name} {bonusCount}加分证明 {compCount}比赛活动 {certs} {cadre}',
} as const;

/** Redis key 约定 */
export const REDIS_KEYS = {
  scoreSnapshot: (batchId: string, studentNo: string) => `zc:snap:${batchId}:${studentNo}`,
  scoreSnapshotVersion: (batchId: string) => `zc:snap:ver:${batchId}`,
  staticCache: (key: string) => `zc:static:${key}`,
  rateLimit: (scope: string, id: string) => `zc:rl:${scope}:${id}`,
  idempotency: (key: string) => `zc:idem:${key}`,
} as const;
