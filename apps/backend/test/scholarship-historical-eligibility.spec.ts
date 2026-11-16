import { ScholarshipsService } from '../src/modules/scholarships/scholarships.module';

function makeService(firstEngine: string, firstPenalty = 0) {
  const prisma = {
    batch: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'b1', semesterKey: '2025-2026-1', name: '第一学期', status: 'PUBLICITY' },
        { id: 'b2', semesterKey: '2025-2026-2', name: '第二学期', status: 'PUBLICITY' },
      ]),
    },
    calcResult: {
      findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve([{
        studentId: 's1', version: 1, totalScore: 80,
        academicFailPenalty: where.batchId === 'b1' ? firstPenalty : 0,
        engineVersion: where.batchId === 'b1' ? firstEngine : '1.0.0',
      }])),
    },
    student: {
      findMany: jest.fn().mockResolvedValue([
        { id: 's1', studentNo: '20250001', name: '测试学生', className: '测试班', major: '测试专业', grade: 2025 },
      ]),
    },
    courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
    scholarshipAward: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new ScholarshipsService(prisma as any);
}

describe('历史汇总成绩的奖学金资格', () => {
  it.each(['STRICT', 'ENGINE'] as const)('不把缺失课程明细视为 %s 口径合格', async (failRule) => {
    const result = await makeService('HISTORICAL', 2).evaluate({ academicYear: '2025-2026', failRule });
    expect(result.rows[0]).toMatchObject({
      terms: [80, 80], sum: 160, eligible: false, rank: null,
      reason: '历史汇总成绩，课程资格待核验',
    });
  });

  it('未导入历史汇总的原有流程不变', async () => {
    const result = await makeService('1.0.0').evaluate({ academicYear: '2025-2026' });
    expect(result.rows[0]).toMatchObject({ eligible: true, reason: null, rank: 1 });
  });
});
