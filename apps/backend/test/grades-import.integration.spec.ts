import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import { GradesImportService } from '../src/modules/grades/grades-import.service';
import { GRADE_TARGETS } from '../src/modules/imports/column-matcher';

// Requires a locally generated SQLite client; never connects to the application database.
// RUN_GRADES_DB_TESTS=1 pnpm test --runTestsByPath test/grades-import.integration.spec.ts
const sqliteDescribe = process.env.RUN_GRADES_DB_TESTS === '1' ? describe : describe.skip;
sqliteDescribe('成绩重复导入（隔离 SQLite + 真实 XLSX）', () => {
  let dir: string;
  let db: PrismaClient;
  let service: GradesImportService;
  const term = '2026-2027-1';
  const mapping = GRADE_TARGETS.map(x => ({ ...x, source: x.target }));
  const row = (overrides: Record<string, unknown> = {}) => ({
    studentNo: '99001', termKey: term, courseCode: 'TEST001', courseName: '测试课程',
    credit: 2, scoreText: '85', examType: '期末考试', ...overrides,
  });
  const run = (rows: Record<string, unknown>[], batch = 'batch-a') => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '测试成绩');
    return service.run(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), mapping, batch, term,
      { jobId: 'test-job', prisma: db, setProgress: jest.fn().mockResolvedValue(undefined) } as any);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zc-grades-import-'));
    db = new PrismaClient({ datasourceUrl: `file:${join(dir, 'test.db').replace(/\\/g, '/')}` });
    // Only the four tables touched by the importer are needed; all records are synthetic.
    for (const sql of [
      'CREATE TABLE Student (id TEXT PRIMARY KEY, studentNo TEXT NOT NULL UNIQUE)',
      'CREATE TABLE Batch (id TEXT PRIMARY KEY)',
      `CREATE TABLE CourseGrade (
        id TEXT PRIMARY KEY, batchId TEXT NOT NULL REFERENCES Batch(id), studentId TEXT NOT NULL REFERENCES Student(id),
        termKey TEXT NOT NULL, courseCode TEXT NOT NULL, courseName TEXT NOT NULL,
        courseNature TEXT NOT NULL DEFAULT '', courseAttr TEXT NOT NULL DEFAULT '', credit DECIMAL NOT NULL DEFAULT 0,
        hours INTEGER, scoreText TEXT NOT NULL DEFAULT '', scoreValue DECIMAL, scoreFlag TEXT NOT NULL DEFAULT '',
        examType TEXT NOT NULL DEFAULT '期末考试', makeupTerm TEXT, isPublicElective BOOLEAN NOT NULL DEFAULT false,
        rawLineHash TEXT NOT NULL, rowNo INTEGER NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(studentId, termKey, courseCode, examType, rawLineHash))`,
      `CREATE TABLE GradeIssue (
        id TEXT PRIMARY KEY, batchId TEXT NOT NULL REFERENCES Batch(id), studentId TEXT NOT NULL REFERENCES Student(id),
        courseGradeId TEXT REFERENCES CourseGrade(id), issueType TEXT NOT NULL, resolution TEXT NOT NULL DEFAULT 'PENDING',
        pickedGradeId TEXT, resolvedBy TEXT, resolvedAt DATETIME, note TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(batchId, courseGradeId, issueType))`,
      "INSERT INTO Student VALUES ('student-test', '99001')",
      "INSERT INTO Batch VALUES ('batch-a'), ('batch-b')",
    ]) await db.$executeRawUnsafe(sql);
    service = new GradesImportService(db as any);
  });
  beforeEach(async () => {
    await db.gradeIssue.deleteMany();
    await db.courseGrade.deleteMany();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await db?.$disconnect();
    // dir is created above with mkdtemp, and contains only this suite's isolated database.
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('同文件重复上传全部跳过，原记录及创建时间保持不变', async () => {
    expect(await run([row()])).toMatchObject({ total: 1, inserted: 1, updated: 0, skipped: 0 });
    const before = await db.courseGrade.findMany();
    expect(await run([row()])).toMatchObject({ total: 1, inserted: 0, updated: 0, skipped: 1 });
    expect(await db.courseGrade.findMany()).toEqual(before);
  });

  test('文件内重复、已入库和新成绩混合时准确计数', async () => {
    await run([row()]);
    expect(await run([row(), row(), row({ courseCode: 'TEST002' }), row({ courseCode: 'TEST002' })]))
      .toMatchObject({ total: 4, inserted: 1, updated: 0, skipped: 3 });
    expect(await db.courseGrade.count()).toBe(2);
  });

  test('跨批次重复也跳过，不迁移成绩或改动已有人工裁决', async () => {
    const input = row({ scoreFlag: '缺考' });
    await run([input]);
    const issue = await db.gradeIssue.findFirstOrThrow();
    await db.gradeIssue.update({ where: { id: issue.id }, data: { resolution: 'EXCLUDED', resolvedBy: 'test-reviewer', note: '测试裁决' } });
    const grades = await db.courseGrade.findMany();
    const issues = await db.gradeIssue.findMany();
    expect(await run([input], 'batch-b')).toMatchObject({ inserted: 0, skipped: 1, updated: 0 });
    expect(await db.courseGrade.findMany()).toEqual(grades);
    expect(await db.gradeIssue.findMany()).toEqual(issues);
  });

  test('分数变化和不同考试类型保留为独立成绩并进入异常队列', async () => {
    await run([row()]);
    expect(await run([row(), row({ scoreText: '90' }), row({ examType: '补考' })]))
      .toMatchObject({ total: 3, inserted: 2, skipped: 1 });
    expect(await db.courseGrade.count()).toBe(3);
    expect(await db.gradeIssue.count({ where: { issueType: 'RESIT_DUP' } })).toBe(1);
  });

  test('重复上传保留待处理异常 ID 和已裁决异常', async () => {
    const input = [row({ scoreFlag: '缺考' }), row({ courseCode: 'TEST002', credit: 0 })];
    await run(input);
    const issue = await db.gradeIssue.findFirstOrThrow({ where: { issueType: 'MISSING' } });
    await db.gradeIssue.update({ where: { id: issue.id }, data: { resolution: 'EXCLUDED', resolvedBy: 'test-reviewer' } });
    const before = await db.gradeIssue.findMany({ orderBy: { id: 'asc' } });
    expect(await run(input)).toMatchObject({ inserted: 0, skipped: 2 });
    expect(await db.gradeIssue.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  test('上次写入成绩后中断，重试可以补齐缺失异常', async () => {
    const input = row({ scoreFlag: '缺考' });
    await run([input]);
    await db.gradeIssue.deleteMany();
    expect(await run([input])).toMatchObject({ inserted: 0, skipped: 1, issues: [{ type: 'MISSING', count: 1 }] });
  });

  test('预查后其他导入抢先写入，真实 P2002 降级后只跳过重复行', async () => {
    const create = db.courseGrade.createMany.bind(db.courseGrade);
    jest.spyOn(db.courseGrade, 'createMany').mockImplementationOnce(async (args: any) => {
      await create({ data: [args.data[0]] });
      return create(args); // Real database unique violation, not a fabricated error.
    });
    expect(await run([row(), row({ courseCode: 'TEST002' })]))
      .toMatchObject({ total: 2, inserted: 1, skipped: 1 });
    expect(await db.courseGrade.count()).toBe(2);
  });

  test('异常生成时遇到真实唯一键竞争仍正常完成', async () => {
    const create = db.gradeIssue.createMany.bind(db.gradeIssue);
    jest.spyOn(db.gradeIssue, 'createMany').mockImplementationOnce(async (args: any) => {
      await create({ data: [args.data[0]] });
      return create(args);
    });
    expect(await run([row({ scoreFlag: '缺考', credit: 0 })])).toMatchObject({ inserted: 1, skipped: 0 });
    expect(await db.gradeIssue.count()).toBe(2);
  });

  test('数据库故障不能当作重复而吞掉', async () => {
    const error = Object.assign(new Error('test database unavailable'), { code: 'P1001' });
    jest.spyOn(db.courseGrade, 'createMany').mockRejectedValueOnce(error);
    await expect(run([row()])).rejects.toBe(error);
    expect(await db.courseGrade.count()).toBe(0);
  });

  test('没有对应成绩的其他唯一键错误仍然失败', async () => {
    const error = Object.assign(new Error('test unrelated constraint'), { code: 'P2002' });
    jest.spyOn(db.courseGrade, 'createMany').mockRejectedValue(error);
    await expect(run([row()])).rejects.toBe(error);
  });

  test('超过写入分块大小仍可重复上传', async () => {
    const input = Array.from({ length: 601 }, (_, i) => row({ courseCode: `TEST${i}` }));
    expect(await run(input)).toMatchObject({ total: 601, inserted: 601, skipped: 0 });
    expect(await run(input)).toMatchObject({ total: 601, inserted: 0, skipped: 601 });
    expect(await db.courseGrade.count()).toBe(601);
  });
});
