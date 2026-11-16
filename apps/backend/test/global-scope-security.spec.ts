import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as XLSX from 'xlsx';
import { Role } from '@zc/shared';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { BatchesController } from '../src/modules/batches/batches.module';
import { NotifyController } from '../src/modules/notify/notify.module';
import { AuthController } from '../src/modules/auth/auth.controller';
import { RulesController } from '../src/modules/rules/rules.module';

const guard = new RolesGuard(new Reflector());
const context = (controller: any, method: string, role: Role) => ({
  getHandler: () => controller.prototype[method], getClass: () => controller,
  switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
}) as any;

describe('全局操作和批次统计权限', () => {
  test.each([
    [BatchesController, 'create'], [BatchesController, 'remove'], [BatchesController, 'activateRules'], [BatchesController, 'transition'],
    [BatchesController, 'setApplySwitch'], [NotifyController, 'createAnnouncement'], [NotifyController, 'deleteAnnouncement'],
    [AuthController, 'getPassphrase'], [AuthController, 'updatePassphrase'],
  ])('%s.%s 仅允许超管', (controller, method) => {
    expect(() => guard.canActivate(context(controller, method, Role.GRADE_ADMIN))).toThrow(ForbiddenException);
    expect(guard.canActivate(context(controller, method, Role.SUPER_ADMIN))).toBe(true);
  });

  test.each([
    [{ id: 'l', role: Role.CLASS_LEADER, classId: 'own' }, { classId: 'own' }],
    [{ id: 'a', role: Role.GRADE_ADMIN, grade: 2025 }, { grade: 2025 }],
  ])('批次统计强制学生范围', async (user, scope) => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'b', _count: { applications: 1 } }]);
    const findHistorical = jest.fn().mockResolvedValue([{ batchId: 'b' }]);
    const controller = new BatchesController({ batch: { findMany }, calcResult: { findMany: findHistorical } } as any, {} as any);
    const result = await controller.list(user as any);
    const select = findMany.mock.calls[0][0].include._count.select;
    for (const key of ['applications', 'courseGrades', 'calcResults', 'objections']) expect(select[key]).toEqual({ where: { student: scope } });
    expect(select.snapshots).toBeUndefined();
    expect(result[0].counts.applications).toBe(1);
    expect(result[0].historicalImport).toBe(true);
    expect(findHistorical).toHaveBeenCalledWith({
      where: { batchId: { in: ['b'] }, engineVersion: 'HISTORICAL' },
      select: { batchId: true }, distinct: ['batchId'],
    });
  });

  test('未绑定年级的管理员不能查看批次统计', async () => {
    const controller = new BatchesController({ batch: { findMany: jest.fn() } } as any, {} as any);
    await expect(controller.list({ role: Role.GRADE_ADMIN } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('统一加分导入只查询管理员管辖年级的学生', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['学号', '分值'], ['own-student', 1], ['other-student', 2]]), 'Sheet');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const prisma: any = {
      ruleItem: { findUnique: jest.fn().mockResolvedValue({ id: 'r', name: 'rule', applyType: 'UNIFIED' }) },
      batch: { findUnique: jest.fn().mockResolvedValue({ id: 'b', semesterKey: '2025-2026-1' }) },
      student: { findMany: jest.fn().mockResolvedValue([{ id: 's', studentNo: 'own-student', classId: 'c' }]) },
      application: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'app' }) },
      reviewLog: { create: jest.fn() },
    };
    const controller = new RulesController(prisma, { log: jest.fn() } as any);
    const result = await controller.unifiedImport({ buffer } as any, 'r', 'b', { id: 'a', name: 'admin', role: Role.GRADE_ADMIN, grade: 2025 } as any, '127.0.0.1');
    expect(prisma.student.findMany).toHaveBeenCalledWith({ where: { studentNo: { in: ['own-student', 'other-student'] }, grade: 2025 } });
    expect(prisma.application.create).toHaveBeenCalledTimes(1);
    expect(result.unknownStudentNos).toEqual(['other-student']);
  });
});
