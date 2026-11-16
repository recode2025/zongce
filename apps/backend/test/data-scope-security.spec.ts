import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@zc/shared';
import { studentScope } from '../src/common/utils/scope';
import { ApplicationsService } from '../src/modules/applications/applications.service';
import { PackagesService } from '../src/modules/applications/packages.service';
import { ReviewsController } from '../src/modules/reviews/reviews.module';
import { FilesController } from '../src/modules/files/files.controller';
import { ExportsController } from '../src/modules/exports/exports.module';
import { ImportsController } from '../src/modules/imports/imports.controller';
import { PublishController } from '../src/modules/publish/publish.module';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { Reflector } from '@nestjs/core';

const leader = { id: 'leader', role: Role.CLASS_LEADER, classId: 'class-a' } as any;
const admin = { id: 'admin', role: Role.GRADE_ADMIN, grade: 2025 } as any;
const superAdmin = { id: 'root', role: Role.SUPER_ADMIN } as any;

describe('班级及年级数据范围', () => {
  test('班委不能指定其他班级，未绑定班级或年级的账号拒绝访问', () => {
    expect(() => studentScope(leader, 'class-b')).toThrow(ForbiddenException);
    expect(() => studentScope({ ...leader, classId: undefined })).toThrow(ForbiddenException);
    expect(() => studentScope({ ...admin, grade: null })).toThrow(ForbiddenException);
    expect(studentScope(admin, 'class-a')).toEqual({ classId: 'class-a', grade: 2025 });
    expect(studentScope(superAdmin)).toEqual({});
  });

  test('申请和材料包列表使用服务端范围，班委不能传入其他班级', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { application: { count, findMany }, materialPackage: { count, findMany }, $transaction: (p: any[]) => Promise.all(p) };
    const apps = new ApplicationsService(prisma as any, {} as any);
    const packages = new PackagesService(prisma as any, {} as any, {} as any, {} as any);
    await expect(packages.list(leader, { batchId: 'b', classId: 'class-b' })).rejects.toThrow(ForbiddenException);
    await expect(apps.list({ ...leader, classId: undefined }, { batchId: 'b' })).rejects.toThrow(ForbiddenException);
    await packages.list(leader, { batchId: 'b' });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { batchId: 'b', student: { classId: 'class-a' } } }));
    await apps.list(admin, { batchId: 'b', classId: 'class-b' });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { batchId: 'b', student: { grade: 2025, classId: 'class-b' } } }));
  });

  test('申请详情阻止跨年级访问', async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ student: { id: 's', classId: 'c', grade: 2024 } }) } };
    const service = new ApplicationsService(prisma as any, {} as any);
    await expect(service.detail(admin, 'a')).rejects.toThrow(ForbiddenException);
    await expect(service.detail(superAdmin, 'a')).resolves.toBeDefined();
  });

  test('审核和统计查询均强制学生范围', async () => {
    const apps = { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) };
    const pkgs = { groupBy: jest.fn().mockResolvedValue([]) };
    const controller = new ReviewsController({ application: apps, materialPackage: pkgs } as any, {} as any);
    await controller.stats(admin, 'b');
    expect(apps.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { batchId: 'b', student: { grade: 2025 } } }));
    expect(pkgs.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { batchId: 'b', student: { grade: 2025 } } }));
    await expect(controller.stats({ ...leader, classId: undefined }, 'b')).rejects.toThrow(ForbiddenException);
    await expect(controller.secondReview({ ids: ['other'], action: 'APPROVE' }, admin)).rejects.toThrow();
    expect(apps.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ student: { grade: 2025 } }) }));
  });

  test('文件归属必须在范围内，无法证明归属时拒绝', async () => {
    const prisma = {
      student: { findFirst: jest.fn().mockResolvedValue(null) },
      applicationAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
      materialPackage: { findFirst: jest.fn().mockResolvedValue(null) },
      fileObject: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const controller = new FilesController(prisma as any, {} as any, {} as any, {} as any);
    await expect((controller as any).assertAccess(admin, 'other', 'file')).rejects.toThrow();
    expect(prisma.student.findFirst).toHaveBeenCalledWith({ where: { userId: 'other', grade: 2025 }, select: { id: true } });
    expect(prisma.applicationAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { fileId: 'file', application: { student: { grade: 2025 } } } }));
    prisma.student.findFirst.mockResolvedValue({ id: 's' });
    await expect((controller as any).assertAccess(admin, 'other', 'file')).resolves.toBeUndefined();
  });

  test('导出结果及历史按年级或操作者限制', async () => {
    const prisma = {
      importJob: { findMany: jest.fn().mockResolvedValue([]) },
      batch: { findUnique: jest.fn().mockResolvedValue({ id: 'b', currentCalcVersion: 1 }) },
      publishSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
      calcResult: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const controller = new ExportsController(prisma as any, {} as any, {} as any, {} as any);
    await controller.history('b', admin);
    expect(prisma.importJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: 'EXPORT', batchId: 'b', operatorId: 'admin' } }));
    await expect((controller as any).execute({ prisma, setProgress: jest.fn() }, { batchId: 'b', scope: 'GRADE' }, admin)).rejects.toThrow('无匹配');
    expect(prisma.calcResult.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ student: { grade: 2025 } }) }));
  });

  test.each([
    ['imports.confirm', ImportsController, 'confirm'], ['imports.registration', ImportsController, 'registration'],
    ['publish.release', PublishController, 'release'], ['publish.incremental', PublishController, 'incremental'], ['publish.rounds', PublishController, 'rounds'],
  ])('全批次写入或聚合接口 %s 只允许超管', (_name, controller, method) => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: Role) => ({
      getHandler: () => (controller as any).prototype[method as string],
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as any;
    expect(() => guard.canActivate(context(Role.GRADE_ADMIN))).toThrow(ForbiddenException);
    expect(guard.canActivate(context(Role.SUPER_ADMIN))).toBe(true);
  });

  test('异议列表和处理只允许对应年级', async () => {
    const prisma = { objection: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ status: 'SUBMITTED', student: { classId: 'c', grade: 2024 } }), update: jest.fn() } };
    const controller = new PublishController(prisma as any, {} as any, {} as any);
    await controller.objections('b', undefined, admin);
    expect(prisma.objection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { batchId: 'b', student: { grade: 2025 } } }));
    await expect(controller.handleObjection('o', { status: 'ACCEPTED' as any }, admin)).rejects.toThrow(ForbiddenException);
    expect(prisma.objection.update).not.toHaveBeenCalled();
  });

  test('后台任务结果只能由本年级管理员本人或超管读取', async () => {
    const prisma = { importJob: { findUnique: jest.fn().mockResolvedValue({ operatorId: 'other' }), findMany: jest.fn().mockResolvedValue([]) } };
    const controller = new ImportsController(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(controller.job('j', admin)).rejects.toThrow(ForbiddenException);
    await controller.listJobs(undefined, 'b', admin);
    expect(prisma.importJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: undefined, batchId: 'b', operatorId: 'admin' } }));
  });
});
