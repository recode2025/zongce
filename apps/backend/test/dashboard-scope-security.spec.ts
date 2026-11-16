import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@zc/shared';
import { CalcService } from '../src/modules/calc/calc.service';
import { CalcController } from '../src/modules/calc/calc.module';
import { StatsController } from '../src/modules/stats/stats.module';
import { ScholarshipsController } from '../src/modules/scholarships/scholarships.module';

const admin = { id: 'a', role: Role.GRADE_ADMIN, grade: 2025 } as any;
const leader = { id: 'l', role: Role.CLASS_LEADER, classId: 'class-a' } as any;

describe('计算、统计和奖学金数据范围', () => {
  test('全批次计算仅允许超管发起', async () => {
    const prisma = { batch: { findUnique: jest.fn() } };
    const svc = new CalcService(prisma as any, {} as any, {} as any);
    await expect(svc.startRun(admin, 'batch', false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.batch.findUnique).not.toHaveBeenCalled();
  });

  test('计算结果列表和版本统计限制为管理员所属年级', async () => {
    const count = jest.fn().mockReturnValue(Promise.resolve(0));
    const findMany = jest.fn().mockReturnValue(Promise.resolve([]));
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = { calcResult: { count, findMany, groupBy }, $transaction: (v: any) => Promise.all(v) };
    const svc = new CalcService(prisma as any, {} as any, {} as any);
    await svc.results(admin, { batchId: 'batch', classId: 'other' });
    expect(findMany.mock.calls[0][0].where.student).toEqual({ grade: 2025, classId: 'other' });
    await svc.versions('batch', admin);
    expect(groupBy.mock.calls[0][0].where.student).toEqual({ grade: 2025 });
  });

  test('班委不能通过学生 ID 查看其他班的计算明细', async () => {
    const prisma = { calcResult: { findFirst: jest.fn().mockResolvedValue({ student: { classId: 'class-b', grade: 2025 } }) } };
    const controller = new CalcController({} as any, prisma as any);
    await expect(controller.resultDetail('batch', '', 'student', leader)).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('统计聚合的学生及关联数据限制年级', async () => {
    const studentCount = jest.fn().mockResolvedValue(0);
    const clazzCount = jest.fn().mockResolvedValue(0);
    const clazzFind = jest.fn().mockResolvedValue([]);
    const groupBy = jest.fn().mockResolvedValue([]);
    const issueCount = jest.fn().mockResolvedValue(0);
    const packageFind = jest.fn().mockResolvedValue([]);
    const prisma = { batch: { findUnique: jest.fn().mockResolvedValue({ id: 'batch', currentCalcVersion: 0 }) },
      student: { count: studentCount }, clazz: { count: clazzCount, findMany: clazzFind },
      application: { groupBy }, materialPackage: { groupBy, findMany: packageFind },
      gradeIssue: { groupBy, count: issueCount }, publishSnapshot: { findFirst: jest.fn().mockResolvedValue(null) } };
    await new StatsController(prisma as any).overview('batch', admin);
    expect(studentCount.mock.calls[0][0].where.grade).toBe(2025);
    expect(clazzFind.mock.calls[0][0].where).toEqual({ grade: 2025 });
    expect(groupBy.mock.calls.every(([q]) => q.where.student.grade === 2025)).toBe(true);
    expect(packageFind.mock.calls[0][0].where.student).toEqual({ grade: 2025 });
  });

  test('奖学金评定忽略管理员请求的其他年级，禁止修改其他年级学生奖项', async () => {
    const evaluate = jest.fn().mockResolvedValue({});
    const prisma = { student: { findUnique: jest.fn().mockResolvedValue({ id: 's', grade: 2024, classId: 'c' }) } };
    const controller = new ScholarshipsController({ evaluate } as any, prisma as any, {} as any);
    await controller.evaluate('2025-2026', '2024', undefined, undefined, admin);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ grade: 2025 }));
    await expect(controller.setAward({ academicYear: '2025-2026', studentId: 's', award: null }, admin)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
