import 'reflect-metadata';
import * as XLSX from 'xlsx';
import { Role } from '@zc/shared';
import { ROLES_KEY } from '../src/common/decorators';
import {
  HistoricalScholarshipController,
  HistoricalScholarshipService,
  parseHistoricalScholarshipWorkbook,
} from '../src/modules/historical-scholarship/historical-scholarship.module';

const YEAR = '2025-2026';
const operator = { id: 'operator', username: 'admin', name: '管理员', role: Role.SUPER_ADMIN, mustChangePwd: false };
const students = [
  { id: 'student-a', studentNo: 'S001', name: '甲同学' },
  { id: 'student-b', studentNo: 'S002', name: '乙同学' },
];

function workbookFile(): Express.Multer.File {
  const book = XLSX.utils.book_new();
  const header = ['学号', '姓名', '奖学金', '备注'];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    header, ['S001', '甲同学', '校一等', '原始备注'], ['S002', '乙同学', '', ''],
  ]), '奖学金总表');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    header, ['S001', '甲同学', '校一等', ''], ['S002', '乙同学', '', ''],
  ]), '优秀学生教官');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    header, ['S001', '甲同学', '校一等', ''], ['S002', '乙同学', '', ''],
  ]), '软工奖学金');
  // 与用户原表相同：使用很大的 !ref，但实际只有数个单元格。
  book.Sheets['软工奖学金']['!ref'] = 'A1:L1048576';
  return { originalname: 'historical-awards.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) } as Express.Multer.File;
}

function fixture(dbStudents = students) {
  const saved: any[] = [];
  const imports = new Map<string, any>();
  const model = {
    findMany: jest.fn(async (args: any) => {
      if (args.where.sourceRecordHash) {
        return saved.filter((r) => args.where.sourceRecordHash.in.includes(r.sourceRecordHash));
      }
      return saved.filter((r) => r.academicYear === args.where.academicYear &&
        (!args.where.studentId || args.where.studentId.in.includes(r.studentId)));
    }),
    createMany: jest.fn(async ({ data }: any) => { saved.push(...data); return { count: data.length }; }),
    count: jest.fn(async ({ where }: any) => saved.filter((r) => r.academicYear === where.academicYear).length),
  };
  const importModel = {
    findUnique: jest.fn(async ({ where }: any) => imports.get(where.academicYear) ?? null),
    create: jest.fn(async ({ data }: any) => {
      if (imports.has(data.academicYear)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const item = { ...data, id: `import-${imports.size + 1}` };
      imports.set(data.academicYear, item);
      return item;
    }),
  };
  const db: any = {
    student: {
      findMany: jest.fn(async (args: any) => {
        if (args.where.studentNo) return dbStudents.filter((s) => args.where.studentNo.in.includes(s.studentNo));
        const ids = new Set(saved.filter((r) => r.academicYear === args.where.historicalScholarshipRecords.some.academicYear).map((r) => r.studentId));
        return dbStudents.filter((s) => ids.has(s.id)).slice(args.skip, args.skip + args.take);
      }),
      count: jest.fn(async (args: any) => {
        const ids = new Set(saved.filter((r) => r.academicYear === args.where.historicalScholarshipRecords.some.academicYear).map((r) => r.studentId));
        return dbStudents.filter((s) => ids.has(s.id)).length;
      }),
    },
    historicalScholarshipRecord: model,
    historicalScholarshipImport: importModel,
    $transaction: async (fn: any) => fn({ historicalScholarshipRecord: model, historicalScholarshipImport: importModel }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  return { service: new HistoricalScholarshipService(db, audit as any), db, model, importModel, saved };
}

describe('历史奖学金导入', () => {
  it('保留总表空奖、特色名单原值与来源，忽略普通专业分表空奖', () => {
    const rows = parseHistoricalScholarshipWorkbook(workbookFile().buffer);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.sourceSheet === '奖学金总表' && r.studentNo === 'S002'))
      .toMatchObject({ rawAward: null, projectName: null, isPending: false });
    expect(rows.find((r) => r.sourceSheet === '优秀学生教官' && r.studentNo === 'S002'))
      .toMatchObject({ rawAward: null, projectName: '优秀学生教官', isPending: true, sourceRow: 3 });
    expect(rows.find((r) => r.sourceSheet === '优秀学生教官' && r.studentNo === 'S001'))
      .toMatchObject({ rawAward: '校一等', projectName: '优秀学生教官', isPending: false });
    expect(rows.some((r) => r.sourceSheet === '软工奖学金' && r.studentNo === 'S002')).toBe(false);
  });

  it('预览无写入；确认原文件后按源行保存，不覆盖既有正式奖项；重传幂等', async () => {
    const { service, model, saved } = fixture();
    const file = workbookFile();
    const preview = await service.preview(file, YEAR);
    expect(preview.summary).toMatchObject({ rows: 5, matched: 5, unmatched: 0, nameMismatches: 0, pending: 1 });
    expect(model.createMany).not.toHaveBeenCalled();
    const first = await service.commit(file, YEAR, preview.fileHash, preview.previewToken, operator);
    expect(first).toMatchObject({ inserted: 5, duplicates: 0 });
    expect(saved.filter((r) => r.studentNo === 'S001')).toHaveLength(3);
    expect(saved.find((r) => r.studentNo === 'S002' && r.sourceSheet === '优秀学生教官'))
      .toMatchObject({ rawAward: null, projectName: '优秀学生教官', isPending: true });
    const second = await service.commit(file, YEAR, preview.fileHash, preview.previewToken, operator);
    expect(second).toMatchObject({ inserted: 0, duplicates: 5 });
  });

  it('未匹配、姓名不一致或确认文件不一致时不写入', async () => {
    const { service, model } = fixture([{ ...students[0], name: '另一个人' }]);
    const file = workbookFile();
    const preview = await service.preview(file, YEAR);
    expect(preview.summary.unmatched).toBeGreaterThan(0);
    expect(preview.summary.nameMismatches).toBeGreaterThan(0);
    await expect(service.commit(file, YEAR, preview.fileHash, preview.previewToken, operator)).rejects.toThrow('存在未匹配学号或姓名不一致');
    await expect(service.commit(file, YEAR, 'f'.repeat(64), preview.previewToken, operator)).rejects.toThrow('文件与预览不一致');
    expect(model.createMany).not.toHaveBeenCalled();
  });

  it('预览令牌绑定学年及文件，切换学年必须重新预览', async () => {
    const { service, model } = fixture();
    const file = workbookFile();
    const preview = await service.preview(file, YEAR);
    await expect(service.commit(file, '2026-2027', preview.fileHash, preview.previewToken, operator))
      .rejects.toThrow('学年或文件与预览不一致');
    await expect(service.commit(file, YEAR, preview.fileHash, 'a'.repeat(64), operator))
      .rejects.toThrow('学年或文件与预览不一致');
    expect(model.createMany).not.toHaveBeenCalled();
  });

  it('同学年不同文件并发导入时最多成功一个，不允许混入另一文件', async () => {
    const { service, saved, importModel } = fixture();
    const first = workbookFile();
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['学号', '姓名', '奖学金', '备注'], ['S001', '甲同学', '校二等', ''],
    ]), '奖学金总表');
    const second = { originalname: 'different.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) } as Express.Multer.File;
    const [a, b] = await Promise.all([service.preview(first, YEAR), service.preview(second, YEAR)]);
    expect(a.fileHash).not.toBe(b.fileHash);
    const results = await Promise.allSettled([
      service.commit(first, YEAR, a.fileHash, a.previewToken, operator),
      service.commit(second, YEAR, b.fileHash, b.previewToken, operator),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed?.reason.message).toContain('该学年已导入其他奖学金文件');
    expect(new Set(saved.map((r) => r.fileHash)).size).toBe(1);
    expect(importModel.create).toHaveBeenCalled();
  });

  it('按学生汇总原奖项与特色项目，不把项目名当原始奖项，保留每个来源', async () => {
    const { service } = fixture();
    const file = workbookFile();
    const preview = await service.preview(file, YEAR);
    await service.commit(file, YEAR, preview.fileHash, preview.previewToken, operator);
    const summary = await service.summary(YEAR, '1', '50');
    expect(summary.total).toBe(2);
    expect(summary.items[0]).toMatchObject({
      studentNo: 'S001', hasAward: true, awardStatus: 'RECORDED',
      awards: [{ name: '校一等', sources: expect.any(Array) }],
      projects: [{ name: '优秀学生教官', sources: expect.any(Array) }],
    });
    expect(summary.items[0].awards[0].sources).toHaveLength(3);
    expect(summary.items[1]).toMatchObject({
      studentNo: 'S002', hasAward: true, awards: [],
      projects: [{ name: '优秀学生教官', sources: expect.any(Array) }],
    });
  });

  it('总表未记录奖项且未进入特色名单时，显示未记录而不推断资格或发放', async () => {
    const { service } = fixture();
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['学号', '姓名', '奖学金', '备注'],
      ['S001', '甲同学', '国奖', ''],
      ['S002', '乙同学', '', ''],
    ]), '奖学金总表');
    const file = { originalname: 'main.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) } as Express.Multer.File;
    const preview = await service.preview(file, YEAR);
    await service.commit(file, YEAR, preview.fileHash, preview.previewToken, operator);
    const result = await service.summary(YEAR, '1', '50');
    expect(result.items[1]).toMatchObject({
      studentNo: 'S002', hasAward: false, awardStatus: 'NONE_RECORDED', awards: [], projects: [],
    });
  });

  it('拒绝无效格式、错误学年以及过大的分页参数', async () => {
    const { service } = fixture();
    await expect(service.preview({ originalname: 'fake.xlsx', buffer: Buffer.from('not a zip') } as Express.Multer.File, YEAR))
      .rejects.toThrow('仅支持有效的 .xlsx 文件');
    await expect(service.preview(workbookFile(), '2025-2028')).rejects.toThrow('学年格式');
    await expect(service.summary(YEAR, '1', '101')).rejects.toThrow('分页参数无效');
  });

  it('所有历史导入和查询接口只允许超级管理员', () => {
    for (const method of ['preview', 'commit', 'list', 'summary'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, HistoricalScholarshipController.prototype[method])).toEqual([Role.SUPER_ADMIN]);
    }
  });
});
