import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@zc/shared';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersController } from '../src/modules/users/users.module';

const liveUser = { id: 'u', username: 'admin', name: 'Admin', role: Role.GRADE_ADMIN, status: 'ACTIVE', grade: 2025, student: null };
const payload = { ...liveUser, mustChangePwd: true, sid: 'session' };

function guardFixture(overrides: any = {}) {
  const user = { findUnique: jest.fn().mockResolvedValue(liveUser) };
  const refreshToken = { findFirst: jest.fn().mockResolvedValue({ id: 'rt' }) };
  const prisma = { user, refreshToken };
  const jwt = { verifyAsync: jest.fn().mockResolvedValue({ ...payload, ...overrides }) };
  const guard = new JwtAuthGuard({ getAllAndOverride: () => false } as any, jwt as any, prisma as any);
  function context(url: string, method = 'GET') {
    const request = { url, path: url.split('?')[0], method, headers: { authorization: 'Bearer jwt' } };
    return { request, ctx: { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) } as any };
  }
  return { guard, user, refreshToken, context };
}

describe('会话权限边界', () => {
  test('首次改密白名单按路由和方法精确匹配，查询字符串不可绕过', async () => {
    const f = guardFixture();
    await expect(f.guard.canActivate(f.context('/api/v1/users?next=/auth/me').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.guard.canActivate(f.context('/api/v1/auth/me').ctx)).resolves.toBe(true);
    await expect(f.guard.canActivate(f.context('/api/v1/auth/me', 'POST').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.guard.canActivate(f.context('/api/v1/auth/change-password', 'POST').ctx)).resolves.toBe(true);
  });

  test('停用、降权、家族已撤销和旧版无会话标识令牌立即失效', async () => {
    const f = guardFixture({ mustChangePwd: false });
    f.user.findUnique.mockResolvedValueOnce({ ...liveUser, status: 'DISABLED' });
    await expect(f.guard.canActivate(f.context('/api/v1/users').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    f.user.findUnique.mockResolvedValueOnce({ ...liveUser, role: Role.STUDENT });
    await expect(f.guard.canActivate(f.context('/api/v1/users').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    f.refreshToken.findFirst.mockResolvedValueOnce(null);
    await expect(f.guard.canActivate(f.context('/api/v1/users').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    const legacy = guardFixture({ sid: undefined });
    await expect(legacy.guard.canActivate(legacy.context('/api/v1/users').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test('数据范围使用当前账号和学生记录', async () => {
    const f = guardFixture({ mustChangePwd: false, grade: 2024, classId: 'old' });
    f.user.findUnique.mockResolvedValueOnce({ ...liveUser, student: { id: 's', classId: 'new', grade: 2025 } });
    const { request, ctx } = f.context('/api/v1/users');
    await f.guard.canActivate(ctx);
    expect((request as any).user).toMatchObject({ grade: 2025, classId: 'new', studentId: 's' });
  });

  test('未绑定年级的管理员不会从学生记录继承年级', async () => {
    const f = guardFixture({ mustChangePwd: false });
    const record = { ...liveUser, grade: null, student: { id: 's', classId: 'c', grade: 2025 } };
    f.user.findUnique.mockResolvedValueOnce(record);
    const { request, ctx } = f.context('/api/v1/users');
    await f.guard.canActivate(ctx);
    expect((request as any).user.grade).toBeNull();
    const auth = new AuthService({} as any, {} as any, {} as any, {} as any, {} as any);
    expect(auth.toJwtUser(record).grade).toBeNull();
  });

  test('停用账号不能轮换刷新令牌', async () => {
    const prisma = { refreshToken: { findUnique: jest.fn().mockResolvedValue({ userId: 'u' }), create: jest.fn() }, user: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, $transaction: jest.fn((fn) => fn(prisma)) };
    const auth = new AuthService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    await expect(auth.refresh({ refreshToken: 'token', ip: '', ua: '' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  test('改密时若当前会话已被撤销，事务内拒绝签发新会话', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...liveUser, passwordHash: 'old', mustChangePwd: true }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), updateMany: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    const auth = new AuthService(prisma, {} as any, {} as any, {} as any, {} as any);
    await expect(auth.changePassword('u', '', 'newPassword123', '127.0.0.1', 'revoked-family')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  test('用户停用、降权或重置密码在同一事务内撤销全部会话', async () => {
    const tx = { user: { update: jest.fn() }, refreshToken: { updateMany: jest.fn() } };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ role: Role.GRADE_ADMIN }) }, $transaction: jest.fn((cb) => cb(tx)) };
    const controller = new UsersController(prisma as any, { log: jest.fn() } as any);
    for (const update of [{ status: 'DISABLED' }, { role: Role.STUDENT }, { password: 'newPassword123' }]) {
      await controller.update('u', update as any, 'operator', '127.0.0.1');
    }
    expect(tx.user.update).toHaveBeenCalledTimes(3);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(3);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', revokedAt: null } }));
  });
});
