import { BadRequestException, ConflictException } from '@nestjs/common';
import { NotifyController } from '../src/modules/notify/notify.module';
import { JobService } from '../src/queue/job.service';

describe('创建批次相关任务和公告', () => {
  const fixture = (count = 1) => {
    const db: any = {
      batch: { updateMany: jest.fn().mockResolvedValue({ count }) },
      importJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      announcement: { create: jest.fn().mockResolvedValue({ id: 'notice-1' }) },
    };
    db.$transaction = jest.fn(async (fn) => fn(db));
    return db;
  };

  test('带批次的任务先在事务内锁定父批次，再创建任务', async () => {
    const db = fixture();
    const id = await new JobService(db).start({ kind: 'GRADE', batchId: 'batch-1', handler: async () => ({}) });
    expect(id).toBe('job-1');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.batch.updateMany).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { currentCalcVersion: { increment: 0 } } });
    expect(db.batch.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.importJob.create.mock.invocationCallOrder[0]);
    expect(db.importJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch-1' }) }));
  });

  test('批次不存在时不创建任务，返回可读错误', async () => {
    const db = fixture(0);
    await expect(new JobService(db).start({ kind: 'GRADE', batchId: 'missing', handler: async () => ({}) }))
      .rejects.toThrow(new BadRequestException('批次不存在'));
    expect(db.importJob.create).not.toHaveBeenCalled();
  });

  test('同批次运行中的任务仍阻止重复创建', async () => {
    const db = fixture();
    db.importJob.findFirst.mockResolvedValue({ id: 'running' });
    await expect(new JobService(db).start({ kind: 'GRADE', batchId: 'batch-1', handler: async () => ({}) }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(db.importJob.create).not.toHaveBeenCalled();
  });

  test('不关联批次的任务无需访问批次或启动事务', async () => {
    const db = fixture();
    await new JobService(db).start({ kind: 'STUDENT', handler: async () => ({}) });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.batch.updateMany).not.toHaveBeenCalled();
    expect(db.importJob.create).toHaveBeenCalled();
  });

  test('带批次的公告先在事务内锁定父批次，再创建公告', async () => {
    const db = fixture();
    const controller = new NotifyController(db, {} as any);
    await controller.createAnnouncement({ title: '公告', content: '内容', batchId: 'batch-1' }, 'admin');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.batch.updateMany).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { currentCalcVersion: { increment: 0 } } });
    expect(db.batch.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.announcement.create.mock.invocationCallOrder[0]);
    expect(db.announcement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch-1' }) }));
  });

  test('公告指定不存在的批次时不创建记录', async () => {
    const db = fixture(0);
    const controller = new NotifyController(db, {} as any);
    await expect(controller.createAnnouncement({ title: '公告', content: '内容', batchId: 'missing' }, 'admin'))
      .rejects.toThrow(new BadRequestException('批次不存在'));
    expect(db.announcement.create).not.toHaveBeenCalled();
  });

  test('不关联批次的公告保持原有行为', async () => {
    const db = fixture();
    const controller = new NotifyController(db, {} as any);
    await controller.createAnnouncement({ title: '公告', content: '内容' }, 'admin');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.batch.updateMany).not.toHaveBeenCalled();
    expect(db.announcement.create).toHaveBeenCalled();
  });
});
