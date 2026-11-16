import { BadRequestException } from '@nestjs/common';
import { ApplicationsService } from '../src/modules/applications/applications.service';

describe('申报字段校验', () => {
  const service = new ApplicationsService({} as any, {} as any) as any;
  const schema = [
    { field: 'name', label: '名称', type: 'string', required: true },
    { field: 'level', label: '级别', type: 'select', required: true, options: [{ value: 'school' }, { value: 'city' }] },
    { field: 'count', label: '次数', type: 'number' },
    { field: 'date', label: '日期', type: 'date' },
    { field: 'team', label: '集体项目', type: 'boolean' },
  ];

  test('合法值被保留，空白被清理，false 和 0 不视为空', () => {
    expect(service.validateDetail(schema, { name: ' 活动 ', level: 'school', count: 0, date: '2024-02-29', team: false }))
      .toEqual({ name: '活动', level: 'school', count: 0, date: '2024-02-29', team: false });
  });

  test.each([
    { name: ' ', level: 'school' },
    { name: '活动', level: 'invalid' },
    { name: '活动', level: 'school', count: '2' },
    { name: '活动', level: 'school', count: Infinity },
    { name: '活动', level: 'school', date: '2025-02-29' },
    { name: '活动', level: 'school', date: '明天' },
    { name: '活动', level: 'school', team: 'false' },
    { name: { arbitrary: true }, level: 'school' },
  ])('拒绝无效或伪造的字段 %#', (detail) => {
    expect(() => service.validateDetail(schema, detail)).toThrow(BadRequestException);
  });
});

describe('竞赛名称绑定', () => {
  const title = '全国测试竞赛';
  const rule = { id: 'r', code: 'ACA_COMPETITION', isActive: true, applyType: 'SELF', whitelistType: 'COMPETITION_CATALOG', detailSchema: [
    { field: 'competitionName', label: '竞赛全称', type: 'string', required: true },
    { field: 'rank', label: '名次', type: 'string', required: true },
  ], evidence: [] };
  const prisma: any = {
    sysConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    student: { findUnique: jest.fn().mockResolvedValue({ id: 'student', classId: 'class', enrollStatus: 'NORMAL' }) },
    ruleItem: { findUnique: jest.fn().mockResolvedValue(rule) },
    batch: { findUnique: jest.fn().mockResolvedValue({ id: 'batch', status: 'COLLECTING', semesterKey: 'term' }) },
    whitelistEntry: { findMany: jest.fn().mockResolvedValue([{ name: title, extra: { level: 'NATIONAL' } }]) },
    fileObject: { findMany: jest.fn().mockResolvedValue([]) },
    application: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'app', ...data })) },
    reviewLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new ApplicationsService(prisma, { log: jest.fn().mockResolvedValue(undefined) } as any);
  const user = { id: 'user', name: '测试' } as any;
  const dto = (detail: Record<string, any>) => ({ batchId: 'batch', ruleItemId: 'r', title, detail });

  beforeEach(() => jest.clearAllMocks());

  test('以标题填充竞赛全称，并用于去重和白名单', async () => {
    const result = await service.submit(user, dto({ rank: '一等奖' }));
    expect(result.detail.competitionName).toBe(title);
    expect(result.dedupeKey).toContain(title);
    expect(result.whitelistHit).toBe(title);
  });

  test('允许仅标点和空格不同的竞赛名称，并以标题归一化', async () => {
    const result = await service.submit(user, dto({ competitionName: '全国 测试竞赛', rank: '一等奖' }));
    expect(result.detail.competitionName).toBe(title);
  });

  test('明细与标题不一致时拒绝，不查询目录或写入申请', async () => {
    await expect(service.submit(user, dto({ competitionName: '其他竞赛', rank: '一等奖' }))).rejects.toThrow('竞赛全称须与申报名称一致');
    expect(prisma.whitelistEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.application.create).not.toHaveBeenCalled();
  });
});
