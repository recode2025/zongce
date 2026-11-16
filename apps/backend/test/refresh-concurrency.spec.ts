import 'reflect-metadata';
import { Role } from '@zc/shared';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersController } from '../src/modules/users/users.module';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// 事务锁模拟数据库对用户行的串行化；可暂停在令牌定位和事务重读处控制交错顺序。
function fixture() {
  const user: any = { id: 'u', username: 'u', name: 'User', role: Role.GRADE_ADMIN, grade: 2025, status: 'ACTIVE', student: null };
  const rows: any[] = [{ id: 'old', userId: 'u', familyId: 'family', revokedAt: null, expiresAt: new Date(Date.now() + 60000) }];
  let next = 0;
  let queue = Promise.resolve();
  let waitOwner: Promise<void> | undefined;
  let waitRead: Promise<void> | undefined;
  const ownerReached = deferred();
  const readReached = deferred();
  const prisma: any = {
    user: {
      updateMany: jest.fn(async () => ({ count: user.status === 'DISABLED' ? 0 : 1 })),
      update: jest.fn(async ({ data }: any) => Object.assign(user, data)),
      findUnique: jest.fn(async () => ({ role: user.role })),
    },
    refreshToken: {
      findUnique: jest.fn(async ({ select }: any) => {
        if (select) { ownerReached.resolve(); if (waitOwner) await waitOwner; return { userId: 'u' }; }
        readReached.resolve(); if (waitRead) await waitRead;
        return { ...rows[0], user: { ...user } };
      }),
      create: jest.fn(async ({ data }: any) => { const row = { id: `new-${++next}`, revokedAt: null, ...data }; rows.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const row of rows) if ((!where.userId || row.userId === where.userId) && (!where.familyId || row.familyId === where.familyId) && (where.revokedAt !== null || row.revokedAt === null)) Object.assign(row, data);
        return { count: 1 };
      }),
    },
    $transaction: async (fn: any) => {
      const before = queue; const unlocked = deferred(); queue = unlocked.promise;
      await before;
      try { return await fn(prisma); } finally { unlocked.resolve(); }
    },
  };
  const auth = new AuthService(prisma, { signAsync: jest.fn().mockResolvedValue('access') } as any, {} as any, { log: jest.fn() } as any, {} as any);
  const users = new UsersController(prisma, { log: jest.fn() } as any);
  return { auth, users, prisma, rows, ownerReached, readReached, setOwnerWait: (p: Promise<void>) => { waitOwner = p; }, setReadWait: (p: Promise<void>) => { waitRead = p; } };
}

describe('刷新与会话撤销的并发', () => {
  test.each([{ status: 'DISABLED' }, { role: Role.STUDENT }, { grade: 2024 }, { password: 'newPassword123' }])('账号变更先提交后不能新建会话：%o', async (change) => {
    const f = fixture(); const proceed = deferred(); f.setOwnerWait(proceed.promise);
    const refreshing = f.auth.refresh({ refreshToken: 'old-token', ip: '', ua: '' });
    await f.ownerReached.promise;
    await f.users.update('u', change as any, 'admin', '127.0.0.1');
    proceed.resolve();
    await expect(refreshing).rejects.toThrow();
    expect(f.prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(f.rows.every((r) => r.revokedAt)).toBe(true);
  });

  test('刷新先拿锁时，随后账号停用会撤销新旧令牌', async () => {
    const f = fixture(); const proceed = deferred(); f.setReadWait(proceed.promise);
    const refreshing = f.auth.refresh({ refreshToken: 'old-token', ip: '', ua: '' });
    await f.readReached.promise;
    const disabling = f.users.update('u', { status: 'DISABLED' } as any, 'admin', '127.0.0.1');
    proceed.resolve();
    await refreshing;
    await disabling;
    expect(f.rows).toHaveLength(2);
    expect(f.rows.every((r) => r.revokedAt)).toBe(true);
  });

  test('重放已使用令牌时提交整个家族的撤销', async () => {
    const f = fixture();
    f.rows[0].revokedAt = new Date();
    f.rows.push({ id: 'active', userId: 'u', familyId: 'family', revokedAt: null });
    await expect(f.auth.refresh({ refreshToken: 'old-token', ip: '', ua: '' })).rejects.toThrow('检测到令牌重用');
    expect(f.rows[1].revokedAt).toBeInstanceOf(Date);
    expect(f.prisma.refreshToken.create).not.toHaveBeenCalled();
  });
});
