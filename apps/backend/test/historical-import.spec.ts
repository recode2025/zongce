import 'reflect-metadata';
import * as XLSX from 'xlsx';
import { Role } from '@zc/shared';
import { ROLES_KEY } from '../src/common/decorators';
import { HistoricalImportController, HistoricalImportService, parseHistoricalScores } from '../src/modules/historical-import/historical-import.module';

const headers = [
  '年级排名', '班级', '学号', '姓名', '基础分', '献血', '优秀学生干部，国旗班',
  '优秀班导生', '寝室', '早晚自习', '实践，志愿', '教室卫生', '其他', '品德总分',
  '学业成绩加权', '全科额外加分', '不及格学业扣分', '市级以上学术竞赛', '职业技能证书',
  '科研', '学业总分', '基础分', '学生干部', '非专业领域文体实践', '校园文化活动',
  '期刊投稿', '校园文化活动总分', '文体总分', '总分', '备注',
];
const sourceRow = [
  1, '示例2025级1班', '2025000001', '测试学生',
  9, 1, 0, 0, 0, 0, 0, 0, 0, 10,
  60, 1, -1, 0.5, 0, 0, 60.5,
  3, 1, 0.5, 0, 0, 0.5, 4.5, 75, '测试备注',
];

function makeFile(rows: unknown[][] = [sourceRow], mutate?: (sheet: XLSX.WorkSheet) => void): Express.Multer.File {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['历史综测'], headers, ...rows]);
  mutate?.(sheet);
  XLSX.utils.book_append_sheet(book, sheet, '年级总表');
  return { originalname: 'historical.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) } as Express.Multer.File;
}

function makeSpringFile(mutate?: (sheet: XLSX.WorkSheet) => void): Express.Multer.File {
  const book = XLSX.utils.book_new();
  const top = ['年级排名', '专业排名', '专业', '班级', '学号', '姓名', '品德行为表现测评'];
  top[31] = '总分';
  const detail = [
    '基础分', '献血', '退役复学', '优秀学生干部，国旗班', '优秀班导生', '寝室', '早晚自习',
    '实践，志愿', '教室卫生', '其他', '品德总分', '学业成绩加权', '全科额外加分', '不及格学业扣分',
    '市级以上学术竞赛', '职业技能证书', '科研', '学业总分', '基础分', '学生干部',
    '非专业领域文体实践', '校园文化活动', '期刊投稿', '校园文化活动总分', '文体总分',
  ];
  const second = Array(6).fill(null).concat(detail);
  const row = [1, 1, '示例专业', '示例2025级1班', '2025000001', '测试学生',
    9, null, null, 1, null, null, null, null, null, null, 10,
    '缓考', null, null, null, null, null, 60.5,
    3, 1, 0.5, null, null, 0.5, 4.5, 75];
  const sheet = XLSX.utils.aoa_to_sheet([top, second, row]);
  sheet.Q3 = { t: 'n', v: 10, f: 'SUM(G3:P3)' };
  sheet.X3 = { t: 'n', v: 60.5, f: 'SUM(R3:W3)' };
  sheet.AD3 = { t: 'n', v: 0.5, f: 'SUM(AA3:AC3)' };
  sheet.AE3 = { t: 'n', v: 4.5, f: 'SUM(Y3:Z3,AD3)' };
  sheet.AF3 = { t: 'n', v: 75, f: 'SUM(Q3,X3,AE3)' };
  mutate?.(sheet);
  XLSX.utils.book_append_sheet(book, sheet, '综测总表');
  return { originalname: 'spring.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) } as Express.Multer.File;
}

function makeService() {
  const students = [{ id: 'student-id', studentNo: '2025000001', name: '测试学生', className: '示例2025级1班' }];
  const db: any = {
    batch: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'batch-id' }),
    },
    student: { findMany: jest.fn().mockImplementation(async () => students) },
    calcResult: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  db.$transaction = jest.fn(async (handler) => handler(db));
  const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
  return { db, audit, service: new HistoricalImportService(db, audit) };
}

describe('historical score import', () => {
  it('limits both endpoints to the super admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, HistoricalImportController)).toEqual([Role.SUPER_ADMIN]);
  });

  it('previews an existing student and imports a candidate without publishing', async () => {
    const file = makeFile();
    const { db, audit, service } = makeService();
    const preview = await service.preview(file, '2025-2026-1');
    expect(preview).toMatchObject({ totalRows: 1, matchedRows: 1, canCommit: true, issues: [] });
    const result = await service.commit(file, '2025-2026-1', preview.fileSha256, 'admin-id', '127.0.0.1');
    expect(result).toMatchObject({ batchId: 'batch-id', count: 1, status: 'CALCULATED', version: 1 });
    expect(db.calcResult.createMany).toHaveBeenCalledTimes(1);
    const row = db.calcResult.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      studentId: 'student-id', totalScore: 75, moralTotal: 10, academicTotal: 60.5,
      sportsTotal: 4.5, academicFailPenalty: 1, rankGrade: 1, rankClass: null,
      engineVersion: 'HISTORICAL', status: 'CANDIDATE',
      courseSummary: { source: 'HISTORICAL_IMPORT', hasCourseDetails: false, sourceRow: 3, sourceNote: '测试备注' },
    });
    expect(row.courseSummary.sourceValues[12]).toBe(-1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicates, unknown students and changed files without writing', async () => {
    const file = makeFile([sourceRow, sourceRow]);
    const { db, service } = makeService();
    const preview = await service.preview(file, '2025-2026-1');
    expect(preview.canCommit).toBe(false);
    expect(preview.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_STUDENT', row: 4 })]));
    await expect(service.commit(file, '2025-2026-1', preview.fileSha256, 'admin-id', '')).rejects.toThrow();
    expect(db.batch.create).not.toHaveBeenCalled();

    db.student.findMany.mockResolvedValue([]);
    const unknown = await service.preview(makeFile(), '2025-2026-1');
    expect(unknown.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STUDENT_NOT_FOUND' })]));
    await expect(service.commit(makeFile(), '2025-2026-1', '0'.repeat(64), 'admin-id', '')).rejects.toThrow('文件与预览不一致');
    expect(db.batch.create).not.toHaveBeenCalled();
  });

  it('rejects changed names, an existing batch, invalid terms and inconsistent totals', async () => {
    const { db, service } = makeService();
    db.student.findMany.mockResolvedValue([{ id: 'student-id', studentNo: '2025000001', name: '另一个姓名', className: '示例2025级1班' }]);
    db.batch.findUnique.mockResolvedValue({ id: 'existing' });
    const preview = await service.preview(makeFile(), '2025-2026-1');
    expect(preview.issues.map((x) => x.code)).toEqual(expect.arrayContaining(['BATCH_EXISTS', 'NAME_MISMATCH']));
    await expect(service.preview(makeFile(), '2025-2027-1')).rejects.toThrow('年份必须连续');
    const badTotal = [...sourceRow];
    badTotal[28] = 76;
    const parsed = await parseHistoricalScores(makeFile([badTotal]));
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOTAL_MISMATCH' })]));
  });

  it('rejects unsupported headers, formulas and non-XLSX data', async () => {
    await expect(parseHistoricalScores(makeFile([sourceRow], (s) => { s.A2 = { t: 's', v: '其他表头' }; }))).rejects.toThrow('表头不匹配');
    const withFormula = makeFile([sourceRow], (s) => { s.AC3 = { t: 'n', v: 75, f: 'N3+U3+AB3' }; });
    const parsed = await parseHistoricalScores(withFormula);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_SCORE' })]));
    await expect(parseHistoricalScores({ originalname: 'data.xlsx', buffer: Buffer.from('not an xlsx') } as Express.Multer.File)).rejects.toThrow();
  });

  it('imports valid cached totals from the second-semester format while retaining missing details', async () => {
    const file = makeSpringFile();
    const { db, service } = makeService();
    const preview = await service.preview(file, '2025-2026-2');
    expect(preview).toMatchObject({ totalRows: 1, matchedRows: 1, canCommit: true });
    expect(preview.warnings.join(' ')).toContain('缓存');
    await service.commit(file, '2025-2026-2', preview.fileSha256, 'admin-id', '');
    const row = db.calcResult.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ totalScore: 75, moralTotal: 10, academicTotal: 60.5, sportsTotal: 4.5,
      courseSummary: { sourceSheet: '综测总表', hasCourseDetails: false, hasMissingDetails: true, hasCachedFormula: true } });
    expect(row.courseSummary.sourceFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'H', value: null }),
      expect.objectContaining({ column: 'R', value: '缓考' }),
      expect.objectContaining({ column: 'AF', value: 75, cachedFormula: true }),
    ]));
  });

  it('rejects uncached or invalid formula totals in the second-semester file', async () => {
    const file = makeSpringFile((s) => { s.AF3 = { t: 'e', v: 7, f: '1/0' }; });
    const parsed = await parseHistoricalScores(file);
    expect(parsed.issues.map((x) => x.code)).toContain('INVALID_SCORE');
  });

  it('rejects the wrong term for each verified historical template', async () => {
    const { db, service } = makeService();
    await expect(service.preview(makeFile(), '2025-2026-2')).rejects.toThrow('对应第 1 学期');
    await expect(service.preview(makeSpringFile(), '2025-2026-1')).rejects.toThrow('对应第 2 学期');
    expect(db.batch.create).not.toHaveBeenCalled();
  });

  it('rejects an XLSX with mismatched central-directory and actual uncompressed sizes', async () => {
    const file = makeFile();
    const data = Buffer.from(file.buffer);
    // ZIP central directory: alter the declared uncompressed size without changing the entry.
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    const original = data.readUInt32LE(central + 24);
    expect(original).toBeGreaterThan(0);
    data.writeUInt32LE(original - 1, central + 24);
    await expect(parseHistoricalScores({ ...file, buffer: data } as Express.Multer.File)).rejects.toThrow();
  });
});
