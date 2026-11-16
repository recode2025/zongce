import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { BatchesController } from '../src/modules/batches/batches.module';

function setup(overrides: { status?: string; missing?: boolean; applications?: number; packages?: number; jobs?: number; snapshots?: number; objections?: number; published?: number } = {}) {
  const batch = { name: '测试学期', semesterKey: '2025-2026-1' };
  const tx = {
    batch: {
      updateMany: jest.fn().mockResolvedValue({ count: overrides.missing || (overrides.status && overrides.status !== 'DRAFT') ? 0 : 1 }),
      findUnique: jest.fn().mockImplementation(({ select }) => Promise.resolve(select.id ? (overrides.missing ? null : { id: 'batch1' }) : batch)),
      delete: jest.fn().mockResolvedValue(batch),
    },
    application: { count: jest.fn().mockResolvedValue(overrides.applications ?? 0), deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    materialPackage: { count: jest.fn().mockResolvedValue(overrides.packages ?? 0), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    importJob: { count: jest.fn().mockResolvedValue(overrides.jobs ?? 0), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    announcement: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    publishSnapshot: { count: jest.fn().mockResolvedValue(overrides.snapshots ?? 0) },
    objection: { count: jest.fn().mockResolvedValue(overrides.objections ?? 0) },
    calcResult: { count: jest.fn().mockResolvedValue(overrides.published ?? 0) },
    gradeIssue: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = { $transaction: jest.fn((fn) => fn(tx)) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  return { controller: new BatchesController(prisma as any, audit as any), prisma, tx, audit };
}

describe('删除未提交的草稿批次', () => {
  it('清除未提交草稿及相关记录并保留文件对象', async () => {
    const { controller, prisma, tx, audit } = setup();
    await expect(controller.remove('batch1', 'admin1', '127.0.0.1')).resolves.toEqual({ success: true });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(tx.batch.updateMany).toHaveBeenCalledWith({ where: { id: 'batch1', status: 'DRAFT' }, data: { status: 'DRAFT' } });
    for (const model of [tx.application, tx.materialPackage, tx.importJob, tx.announcement, tx.gradeIssue]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { batchId: 'batch1' } });
    }
    expect(tx.batch.delete).toHaveBeenCalledWith({ where: { id: 'batch1' } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'BATCH_DELETE', operatorId: 'admin1', resourceId: 'batch1' }));
  });

  it.each([{ status: 'PUBLICITY' }, { missing: true }])('拒绝非草稿或不存在的批次 %j', async (state) => {
    const { controller, tx, audit } = setup(state);
    await expect(controller.remove('batch1', 'admin1', '')).rejects.toThrow(BadRequestException);
    expect(tx.batch.delete).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    { applications: 1 }, { packages: 1 }, { jobs: 1 }, { snapshots: 1 }, { objections: 1 }, { published: 1 },
  ])('存在已提交、进行中任务或公示数据时拒绝删除 %j', async (state) => {
    const { controller, tx } = setup(state);
    await expect(controller.remove('batch1', 'admin1', '')).rejects.toThrow('不能删除');
    expect(tx.batch.delete).not.toHaveBeenCalled();
    expect(tx.application.deleteMany).not.toHaveBeenCalled();
  });

  it('检查申请的历史审核轨迹及材料的提交时间，防止撤回后被误删', async () => {
    const { controller, tx } = setup();
    await controller.remove('batch1', 'admin1', '');
    expect(tx.application.count).toHaveBeenCalledWith({ where: { batchId: 'batch1', OR: [
      { status: { not: 'DRAFT' } }, { reviewLogs: { some: {} } },
    ] } });
    expect(tx.materialPackage.count).toHaveBeenCalledWith({ where: { batchId: 'batch1', OR: expect.arrayContaining([
      { status: { not: 'NOT_SUBMITTED' } }, { submittedAt: { not: null } },
    ]) } });
    expect(tx.importJob.count).toHaveBeenCalledWith({ where: { batchId: 'batch1', status: { notIn: ['DONE', 'FAILED'] } } });
  });
});
