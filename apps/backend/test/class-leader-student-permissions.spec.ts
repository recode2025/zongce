import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@zc/shared';
import { AuthService } from '../src/modules/auth/auth.service';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ApplicationsController } from '../src/modules/applications/applications.module';
import { ApplicationsService } from '../src/modules/applications/applications.service';
import { PackagesService } from '../src/modules/applications/packages.service';
import { FilesController } from '../src/modules/files/files.controller';
import { PublishController } from '../src/modules/publish/publish.module';

const leader = { id: 'leader-user', name: '负责人', role: Role.CLASS_LEADER } as any;

describe('班级负责人学生权限', () => {
  const guard = new RolesGuard(new Reflector());
  const studentEndpoints: [any, string][] = [
    ...['draft', 'evidenceDraft', 'submit', 'mine', 'withdraw', 'submitPackage', 'rebuild', 'myPackages'].map((method): [any, string] => [ApplicationsController, method]),
    [FilesController, 'upload'],
    ...['myScoreBatches', 'myScore', 'submitObjection', 'myObjections'].map((method): [any, string] => [PublishController, method]),
  ];

  test.each(studentEndpoints)('%s.%s 放行学生和班级负责人', (controller, method) => {
    const context = (role: Role) => ({
      getHandler: () => controller.prototype[method],
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as any;
    expect(guard.canActivate(context(Role.STUDENT))).toBe(true);
    expect(guard.canActivate(context(Role.CLASS_LEADER))).toBe(true);
  });

  test('两个 AI 接口允许班级负责人，并继续拒绝超管', async () => {
    const cache = { incrWithWindow: jest.fn().mockResolvedValue(1) };
    const draft = { generate: jest.fn().mockResolvedValue({}) };
    const evidence = { generate: jest.fn().mockResolvedValue({}) };
    const controller = new ApplicationsController({} as any, {} as any, cache as any, {} as any, draft as any, evidence as any);
    await controller.draft({ ruleItemId: 'rule', text: '事实' }, leader);
    await controller.evidenceDraft({ ruleItemId: 'rule', text: '事实', fileIds: ['file'] }, leader);
    expect(draft.generate).toHaveBeenCalledWith('rule', '事实', leader.id);
    expect(evidence.generate).toHaveBeenCalledWith('rule', '事实', ['file'], leader.id);
    const admin = { ...leader, role: Role.SUPER_ADMIN };
    await expect(controller.draft({ ruleItemId: 'rule', text: '事实' }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.evidenceDraft({ ruleItemId: 'rule', fileIds: ['file'] }, admin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('个人申请和材料包查询仍限定负责人自己的学生记录', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'leader-student' });
    const applications = { findMany: jest.fn().mockResolvedValue([]) };
    const packages = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = { student: { findUnique }, application: applications, materialPackage: packages };
    await new ApplicationsService(prisma as any, {} as any).mine(leader, 'batch');
    await new PackagesService(prisma as any, {} as any, {} as any, {} as any).mine(leader, 'batch');
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: leader.id } });
    expect(applications.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { studentId: 'leader-student', batchId: 'batch' } }));
    expect(packages.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { studentId: 'leader-student', batchId: 'batch' } }));
  });

  test('不能以学生身份撤回他人申请或重新打包他人材料', async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ student: { userId: 'other-user' } }) },
      materialPackage: { findUnique: jest.fn().mockResolvedValue({ student: { userId: 'other-user' } }) },
    };
    await expect(new ApplicationsService(prisma as any, {} as any).withdraw(leader, 'other-application')).rejects.toThrow();
    await expect(new PackagesService(prisma as any, {} as any, {} as any, {} as any).rebuild(leader, 'other-package')).rejects.toThrow();
  });

  test('班级负责人改密后签发的令牌保留本人学生和班级信息', async () => {
    const record = { ...leader, username: 'leader', mustChangePwd: true, student: { id: 'leader-student', classId: 'leader-class', grade: 2025 } };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(record), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { findFirst: jest.fn().mockResolvedValue({ id: 'old-session' }), updateMany: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({ id: 'new-session' }) },
      $transaction: jest.fn((fn) => fn(prisma)),
    };
    const jwt = { signAsync: jest.fn().mockResolvedValue('token') };
    const auth = new AuthService(prisma as any, jwt as any, {} as any, { log: jest.fn() } as any, {} as any);
    const response = await auth.changePassword(leader.id, '', 'newPassword123', '127.0.0.1', 'family');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: leader.id }, include: { student: true } });
    expect(response.user).toMatchObject({ studentId: 'leader-student', classId: 'leader-class', role: Role.CLASS_LEADER, mustChangePwd: false });
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'leader-student', classId: 'leader-class' }), expect.any(Object));
  });

});
