import { Role } from '@zc/shared';
import { ExportsController } from '../src/modules/exports/exports.module';

describe('历史成绩导出安全', () => {
  it('拒绝用依赖完整课程明细的常规模板导出历史汇总', async () => {
    const prisma = {
      batch: { findUnique: jest.fn().mockResolvedValue({ id: 'batch', currentCalcVersion: 1 }) },
      publishSnapshot: { findFirst: jest.fn().mockResolvedValue({ calcVersion: 1 }) },
      calcResult: { findMany: jest.fn().mockResolvedValue([{ engineVersion: 'HISTORICAL', version: 1 }]) },
    };
    const storage = { saveExport: jest.fn() };
    const controller = new ExportsController(prisma as any, {} as any, storage as any, {} as any);
    const ctx = { prisma, setProgress: jest.fn() };
    await expect((controller as any).execute(ctx, { batchId: 'batch', scope: 'GRADE' }, { id: 'admin', role: Role.SUPER_ADMIN }))
      .rejects.toThrow('历史导入成绩暂不支持此计算结果模板导出');
    expect(storage.saveExport).not.toHaveBeenCalled();
  });
});
