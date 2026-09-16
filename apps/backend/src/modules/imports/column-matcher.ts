import { ColumnMappingEntry } from '@zc/shared';

/** 表头归一化：去空白、全角转半角、去换行 */
export function normalizeHeader(h: string): string {
  return String(h ?? '')
    .replace(/[\s　\n\r]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
}

/** 目标字段候选别名表（实测教务导出表头 + 常见变体） */
export const STUDENT_TARGETS: ColumnMappingEntry[] = [
  { target: 'studentNo', label: '学号', source: null, required: true },
  { target: 'name', label: '姓名', source: null, required: true },
  { target: 'className', label: '班级', source: null, required: true },
  { target: 'gender', label: '性别', source: null, required: false },
  { target: 'college', label: '上课院系', source: null, required: false },
  { target: 'major', label: '专业名称', source: null, required: false },
  { target: 'grade', label: '入学年份', source: null, required: false },
  { target: 'enrollStatusRaw', label: '学籍状态', source: null, required: false },
  { target: 'idCard', label: '身份证件号', source: null, required: false },
];

export const STUDENT_ALIASES: Record<string, string[]> = {
  studentNo: ['学号', '学生学号', '学籍号', '考生号'],
  name: ['姓名', '学生姓名'],
  className: ['班级', '班级名称', '行政班', '班级代码'],
  gender: ['性别'],
  college: ['上课院系', '院系', '所属院系', '学院'],
  major: ['专业名称', '专业'],
  grade: ['入学年份', '年级', '当前所在级'],
  enrollStatusRaw: ['学籍状态', '学籍'],
  idCard: ['身份证件号', '身份证号', '证件号码'],
};

export const GRADE_TARGETS: ColumnMappingEntry[] = [
  { target: 'studentNo', label: '学号', source: null, required: true },
  { target: 'name', label: '姓名', source: null, required: false },
  { target: 'termKey', label: '开课学期', source: null, required: true },
  { target: 'courseCode', label: '课程编号', source: null, required: true },
  { target: 'courseName', label: '课程名称', source: null, required: false },
  { target: 'courseNature', label: '课程性质', source: null, required: false },
  { target: 'courseAttr', label: '课程属性', source: null, required: false },
  { target: 'credit', label: '学分', source: null, required: false },
  { target: 'scoreText', label: '总成绩', source: null, required: true },
  { target: 'scoreFlag', label: '成绩标志', source: null, required: false },
  { target: 'examType', label: '考试性质', source: null, required: false },
  { target: 'makeupTerm', label: '补重学期', source: null, required: false },
  { target: 'hours', label: '学时', source: null, required: false },
];

export const GRADE_ALIASES: Record<string, string[]> = {
  studentNo: ['学号', '学生学号'],
  name: ['姓名'],
  termKey: ['开课学期', '学期', '上课学期'],
  courseCode: ['课程编号', '课程代码', '课号'],
  courseName: ['课程名称', '课程'],
  courseNature: ['课程性质'],
  courseAttr: ['课程属性', '属性'],
  credit: ['学分'],
  scoreText: ['总成绩', '成绩', '期末成绩', '最终成绩'],
  scoreFlag: ['成绩标志', '标志'],
  examType: ['考试性质', '考核方式'],
  makeupTerm: ['补重学期'],
  hours: ['学时'],
};

/** 自动匹配：对每个目标字段在候选别名中精确命中，否则做包含式匹配（列索引去重，一列只供一个字段） */
export function suggestMapping(headers: string[], targets: ColumnMappingEntry[], aliases: Record<string, string[]>): ColumnMappingEntry[] {
  const norm = headers.map((h) => normalizeHeader(h));
  const usedIdx = new Set<number>();
  const find = (pred: (h: string) => boolean): number => {
    for (let idx = 0; idx < norm.length; idx++) {
      if (!usedIdx.has(idx) && norm[idx] !== '' && pred(norm[idx])) {
        usedIdx.add(idx);
        return idx;
      }
    }
    return -1;
  };
  return targets.map((t) => {
    const candidates = aliases[t.target] ?? [t.label];
    // 第一轮：精确匹配
    for (const c of candidates) {
      const i = find((h) => h === c);
      if (i >= 0) return { ...t, source: headers[i] };
    }
    // 第二轮：包含匹配（如 "学 号"、带备注后缀）
    for (const c of candidates) {
      const i = find((h) => h.length >= 2 && (h.includes(c) || c.includes(h)));
      if (i >= 0) return { ...t, source: headers[i] };
    }
    return { ...t, source: null };
  });
}

export function mappingToDict(mapping: ColumnMappingEntry[]): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const m of mapping) if (m.source) dict[m.target] = m.source;
  return dict;
}
