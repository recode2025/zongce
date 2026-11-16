import * as XLSX from 'xlsx';
import { GRADE_TARGETS, STUDENT_TARGETS } from './column-matcher';

/**
 * 导入模板生成（成绩 / 学生名册 / 综测登记表）。
 *
 * 安全约定：数据表只放表头，**不放任何示例行**——示例学号可能与真实学生重号，
 * 忘删即导入会凭空写入成绩/申请。示例统一放在「填写说明」表（解析器不读取）。
 *
 * 表头口径：
 * - 成绩/名册：取列映射的首选列名（column-matcher），导入时可全部自动匹配。
 * - 综测登记表：sheet 名与表头关键词严格对应 registration-import.service 的识别规则，
 *   并避开关键词互相误命中（如科研表「加分类型」不得被当作「加分」列）。
 */

export type TemplateKind = 'GRADE' | 'STUDENT' | 'REGISTRATION';

/** 成绩 / 名册各列的填写说明（与导入解析口径一致） */
const FIELD_NOTES: Record<string, string> = {
  studentNo: '学生学号，用于匹配已导入的学生名册',
  name: '学生姓名',
  termKey: '格式：学年-学期，如 2025-2026-1（1 为秋季学期，2 为春季学期）',
  courseCode: '教务系统课程编号；同一学生同一学期同一课程编号视为同一门课',
  courseName: '课程名称',
  courseNature: '如：必修、选修',
  courseAttr: '如：专业基础、公共基础',
  credit: '数字，如 4 或 2.5；学分为 0 或空会进入异常面板',
  scoreText: '百分制数字（如 86），或等级制（优秀/良好/中等/及格/不及格）',
  scoreFlag: '只在异常时填写：缺考 / 缓考 / 取消考试资格；正常成绩留空',
  examType: '期末考试 / 补考',
  makeupTerm: '补考或重修所在学期，格式同开课学期',
  hours: '学时，数字',
  className: '班级全称，如 软件2301班；不存在的班级会自动创建',
  gender: '男 / 女',
  college: '如：软件学院',
  major: '专业名称',
  grade: '入学年份，如 2023',
  enrollStatusRaw: '如：在读；填「休学」「无学籍」「退学」的学生会标记为学籍异常',
  idCard: '选填',
};

const GRADE_EXAMPLE = [
  ['示例学号', '张三', '2025-2026-1', 'B0801001', '数据结构', '必修', '专业基础', 4, 86, '', '期末考试', '', 64],
  ['示例学号', '张三', '2025-2026-1', 'B0801002', '大学英语（三）', '必修', '公共基础', 2, '良好', '', '期末考试', '', 32],
  ['示例学号', '李四', '2025-2026-1', 'B0801001', '数据结构', '必修', '专业基础', 4, 0, '缺考', '期末考试', '', 64],
];
const STUDENT_EXAMPLE = [
  ['示例学号', '张三', '软件2301班', '男', '软件学院', '软件工程', 2023, '在读', ''],
  ['示例学号', '李四', '软件2301班', '女', '软件学院', '软件工程', 2023, '休学', ''],
];

/** 综测登记表各 sheet：名称、表头、填写说明、示例行（示例只进说明表） */
const REGISTRATION_SHEETS: { name: string; headers: string[]; note: string; example: (string | number)[] }[] = [
  {
    name: '表3 品德行为',
    headers: ['学号', '姓名', '优秀寝室', '献血', '退役复学', '优秀学生教官/国旗班', '优秀班导生', '其他加分', '备注'],
    note: '每名学生一行；各项填加分分值，不涉及的留空或填 0；「其他加分」请在备注写明事由',
    example: ['示例学号', '张三', 0.5, 1, '', '', '', 0.5, '其他加分：校运会志愿者'],
  },
  {
    name: '表4 社会实践志愿',
    headers: ['学号', '姓名', '活动名称', '活动类型', '佐证材料'],
    note: '每项活动一行，同一学生多项写多行；分值由审核时按规则认定',
    example: ['示例学号', '张三', '2025 大连马拉松志愿服务', '志愿服务', '志愿时长证明'],
  },
  {
    name: '表5 专业竞赛',
    headers: ['学号', '姓名', '竞赛名称', '获奖等级', '名次', '是否团体', '加分', '是否补录'],
    note: '每项竞赛一行；获奖等级写 国家级 / 省级 / 市级 / 校级 / 院级；竞赛须在教务处当年度认定目录内',
    example: ['示例学号', '张三', '蓝桥杯全国软件和信息技术专业人才大赛', '省级', '一等奖', '否', 2, '否'],
  },
  {
    name: '表6 职业技能证书',
    headers: ['学号', '姓名', '证书名称', '加分'],
    note: '每张证书一行',
    example: ['示例学号', '张三', '全国计算机等级考试二级', 0.5],
  },
  {
    name: '表7 科研成果',
    headers: ['学号', '姓名', '成果名称', '加分类型', '本人身份', '链接', '加分'],
    note: '每项成果一行；加分类型如 论文 / 专利 / 软著 / 项目；本人身份如 第一作者、负责人',
    example: ['示例学号', '张三', '基于深度学习的……研究', '论文', '第一作者', 'https://…', 1],
  },
  {
    name: '表8 学生干部',
    headers: ['学号', '姓名', '干部类型', '职位得分'],
    note: '每个职务一行；干部类型请连同职务一起写，如 班长（班级干部）、宣传部部长（学生会），这一栏会作为申请标题',
    example: ['示例学号', '张三', '班长（班级干部）', 1.5],
  },
  {
    name: '表9 非专业文体活动',
    headers: ['学号', '姓名', '活动名称', '参与等级', '奖项', '名次', '是否团体', '加分'],
    note: '每项活动一行；奖项写明级别，如 校级一等奖',
    example: ['示例学号', '张三', '校园歌手大赛', '校级', '校级二等奖', '第二名', '否', 1],
  },
  {
    name: '表10 校园文化活动',
    headers: ['学号', '姓名', '活动名称', '参与得分', '奖项', '名次', '是否团体', '加分'],
    note: '每项活动一行；奖项写明级别，如 院级三等奖',
    example: ['示例学号', '张三', '读书月征文', 0.2, '院级三等奖', '第三名', '否', 0.5],
  },
  {
    name: '表11 学术论文期刊投稿',
    headers: ['学号', '姓名', '标题', '投稿类型', '刊物名称', '消息来源', '加分'],
    note: '每篇一行；投稿类型如 论文 / 新闻稿',
    example: ['示例学号', '张三', '……', '新闻稿', '大外校报', '', 0.5],
  },
];

function headerSheet(headers: string[]) {
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(10, h.length * 2 + 4) }));
  return ws;
}

export function buildImportTemplate(kind: TemplateKind): { buffer: Buffer; fileName: string } {
  const wb = XLSX.utils.book_new();

  if (kind === 'REGISTRATION') {
    for (const s of REGISTRATION_SHEETS) XLSX.utils.book_append_sheet(wb, headerSheet(s.headers), s.name);
    const rows: (string | number)[][] = [
      ['综测登记表导入模板 · 填写说明'],
      ['· 每个数据表的第 1 行是表头，请不要修改表头文字和工作表名称；从第 2 行起填写'],
      ['· 学号必须是已导入名册的学生；学号不在学生库的行会被跳过并在导入结果中列出'],
      ['· 每行导入后生成一条「待初审」的加分申请，填写的加分作申报分值，最终以复审核定为准'],
      ['· 重复导入同一份表会自动跳过已导入的行'],
      ['· 下面的示例只用于说明格式，本表不会被导入'],
      [],
    ];
    for (const s of REGISTRATION_SHEETS) {
      rows.push([`【${s.name}】${s.note}`], s.headers, s.example, []);
    }
    const guide = XLSX.utils.aoa_to_sheet(rows);
    guide['!cols'] = Array.from({ length: 9 }, (_, i) => ({ wch: i === 2 ? 30 : 14 }));
    XLSX.utils.book_append_sheet(wb, guide, '填写说明');
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, fileName: '综测登记表导入模板.xlsx' };
  }

  const targets = kind === 'GRADE' ? GRADE_TARGETS : STUDENT_TARGETS;
  const headers = targets.map((t) => t.label);
  // 数据表必须是第一张：成绩/名册解析器读取第一张非空工作表
  XLSX.utils.book_append_sheet(wb, headerSheet(headers), '数据');
  const guide = XLSX.utils.aoa_to_sheet([
    ['列名', '是否必填', '说明'],
    ...targets.map((t) => [t.label, t.required ? '必填' : '选填', FIELD_NOTES[t.target] ?? '']),
    [],
    ['· 在「数据」表第 2 行起填写；列顺序可以调整，列名请保持不变'],
    ['· 下面的示例只用于说明格式，本表不会被导入'],
    headers,
    ...(kind === 'GRADE' ? GRADE_EXAMPLE : STUDENT_EXAMPLE),
  ]);
  guide['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, guide, '填写说明');
  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    fileName: kind === 'GRADE' ? '课程成绩导入模板.xlsx' : '学生名册导入模板.xlsx',
  };
}
