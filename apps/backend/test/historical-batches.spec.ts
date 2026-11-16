import { BatchStatus, Role } from '@zc/shared';
import { BatchesController } from '../src/modules/batches/batches.module';
import { CalcService } from '../src/modules/calc/calc.service';
import { PublishController } from '../src/modules/publish/publish.module';

const admin: any = { id: 'admin', role: Role.SUPER_ADMIN };
const studentUser: any = { id: 'user', role: Role.STUDENT };

describe('historical batches remain separate from active calculation', () => {
  it.each([true, false])('rejects historical dryRun=%s before a job starts', async (dryRun) => {
    const db: any = {
      batch: { findUnique: jest.fn().mockResolvedValue({ id: 'historical', status: BatchStatus.PUBLICITY }) },
      calcResult: { findFirst: jest.fn().mockResolvedValue({ id: 'history-row' }) },
    };
    const jobs: any = { start: jest.fn() };
    const service = new CalcService(db, jobs, {} as any);
    await expect(service.startRun(admin, 'historical', dryRun)).rejects.toThrow('历史导入批次不支持');
    expect(jobs.start).not.toHaveBeenCalled();
    expect(db.calcResult.findFirst).toHaveBeenCalledWith({
      where: { batchId: 'historical', engineVersion: 'HISTORICAL' }, select: { id: true },
    });
  });

  it('rechecks historical status when the queued job executes', async () => {
    const db: any = {
      batch: { findUnique: jest.fn().mockResolvedValue({ id: 'historical' }) },
      calcResult: { findFirst: jest.fn().mockResolvedValue({ id: 'history-row' }) },
    };
    const service = new CalcService(db, {} as any, {} as any);
    await expect((service as any).execute({ prisma: db }, 'historical', true, admin)).rejects.toThrow('历史导入批次不支持');
  });

  it('marks historical batches and filters them out of the active batch query', async () => {
    const db: any = {
      batch: { findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'history', _count: {} }, { id: 'current', _count: {} }])
        .mockResolvedValueOnce([{ id: 'current' }]) },
      calcResult: { findMany: jest.fn().mockResolvedValue([{ batchId: 'history' }]) },
      sysConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const controller = new BatchesController(db, {} as any);
    const list = await controller.list(admin);
    expect(list.map((x: any) => [x.id, x.historicalImport])).toEqual([['history', true], ['current', false]]);
    await expect(controller.active(null)).resolves.toMatchObject({ id: 'current', applyEnabled: true });
    expect(db.batch.findMany.mock.calls[1][0].where).toMatchObject({
      calcResults: { none: { engineVersion: 'HISTORICAL' } },
    });
  });
});

describe('historical score ordering', () => {
  it('sorts a student’s results by semester rather than import time', async () => {
    const db: any = {
      student: { findUnique: jest.fn().mockResolvedValue({ id: 'student' }) },
      calcResult: { findMany: jest.fn().mockResolvedValue([
        { batchId: 'older', totalScore: 80, batch: { name: 'old', semesterKey: '2025-2026-1', status: 'PUBLICITY', createdAt: new Date('2027-01-01') } },
        { batchId: 'newer', totalScore: 90, batch: { name: 'new', semesterKey: '2025-2026-2', status: 'PUBLICITY', createdAt: new Date('2026-01-01') } },
      ]) },
    };
    const controller = new PublishController(db, {} as any, {} as any);
    const rows = await controller.myScoreBatches(studentUser);
    expect(rows.map((row) => row.batchId)).toEqual(['newer', 'older']);
  });

  it('selects the newest active semester in which the student has a published result', async () => {
    const db: any = {
      student: { findUnique: jest.fn().mockResolvedValue({ id: 'student', studentNo: '123456' }) },
      publishSnapshot: { findFirst: jest.fn().mockResolvedValue({ batchId: 'newer' }) },
    };
    const cache: any = { incrWithWindow: jest.fn().mockResolvedValue(1), get: jest.fn().mockResolvedValue('{"marker":true}') };
    const controller = new PublishController(db, cache, {} as any);
    await expect(controller.myScore(studentUser)).resolves.toMatchObject({ source: 'cache', marker: true });
    expect(db.publishSnapshot.findFirst).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', batch: { calcResults: { some: { studentId: 'student', status: 'PUBLISHED' } } } },
      orderBy: [{ batch: { semesterKey: 'desc' } }, { publishedAt: 'desc' }],
    });
  });
});
