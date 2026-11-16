/** Opt-in real MySQL session tests. Requires the dedicated loopback test database and isolated generated client. */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { Role } from '@zc/shared';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersController } from '../src/modules/users/users.module';

type PrismaClient = any;
const enabled = process.env.RUN_MYSQL_SESSION_E2E === '1';
const describeIf = enabled ? describe : describe.skip;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describeIf('真实 MySQL 会话并发（独立临时库）', () => {
  const createdIds: string[] = [];
  let client1: PrismaClient, client2: PrismaClient;
  let hash: string;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed-access') };
  const opts = (refreshToken: string) => ({ refreshToken, ip: '127.0.0.1', ua: 'integration' });
  const service = (p: any) => new AuthService(p, jwt as any, {} as any, audit as any, {} as any);

  beforeAll(async () => {
    const url = process.env.MYSQL_SESSION_TEST_URL;
    const clientPath = process.env.MYSQL_SESSION_PRISMA_CLIENT;
    if (!url || !clientPath) throw new Error('Missing isolated MySQL test URL or generated client');
    const parsed = new URL(url);
    // Fail closed: never run against a production host or database.
    if (parsed.protocol !== 'mysql:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '33961' || parsed.pathname !== '/zc_security_test') {
      throw new Error('MySQL integration test requires the dedicated loopback zc_security_test instance');
    }
    const { PrismaClient: MySQLClient } = require(clientPath);
    client1 = new MySQLClient({ datasources: { db: { url } } });
    client2 = new MySQLClient({ datasources: { db: { url } } });
    if (client1._engineConfig.activeProvider !== 'mysql') throw new Error('MySQL tests require an isolated MySQL Prisma client');
    await Promise.all([client1.$connect(), client2.$connect()]);
    hash = await argon2.hash('Old-password-2026');
  }, 60000);

  afterAll(async () => {
    if (client1 && createdIds.length) await client1.user.deleteMany({ where: { id: { in: createdIds } } });
    await Promise.all([client1?.$disconnect(), client2?.$disconnect()]);
  });

  async function fixture() {
    const id = randomUUID();
    createdIds.push(id);
    const raw = randomUUID();
    const family = randomUUID();
    await client1.user.create({ data: { id, username: id, name: 'Test user', role: Role.GRADE_ADMIN, grade: 2025, status: 'ACTIVE', passwordHash: hash, mustChangePwd: false } });
    await client1.refreshToken.create({ data: { userId: id, tokenHash: sha(raw), familyId: family, expiresAt: new Date(Date.now() + 600000) } });
    return { id, raw, family };
  }

  // Delay after the real owner lookup, before the refresh transaction takes its lock.
  function pauseAfterOwner(p: PrismaClient) {
    const reached = gate(), proceed = gate();
    const wrapped = new Proxy(p as any, { get(target, key) {
      if (key === 'refreshToken') return new Proxy(target.refreshToken, { get(delegate, method) {
        if (method === 'findUnique') return async (args: any) => { const result = await delegate.findUnique(args); if (args.select?.userId) { reached.release(); await proceed.promise; } return result; };
        return (delegate as any)[method];
      } });
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { wrapped, reached: reached.promise, proceed: proceed.release };
  }

  // Let the actual transaction acquire the MySQL row write lock before pausing it.
  function pauseAfterWriteLock(p: PrismaClient) {
    const reached = gate(), proceed = gate();
    const wrapped = new Proxy(p as any, { get(target, key) {
      if (key === '$transaction') return (callback: any) => target.$transaction((tx: any) => callback(new Proxy(tx, { get(t, k) {
        if (k === 'user') return new Proxy(t.user, { get(delegate, method) {
          if (method === 'updateMany') return async (args: any) => { const result = await delegate.updateMany(args); reached.release(); await proceed.promise; return result; };
          return (delegate as any)[method];
        } });
        return t[k];
      } })));
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { wrapped, reached: reached.promise, proceed: proceed.release };
  }

  test.each([
    { status: 'DISABLED' }, { role: Role.STUDENT }, { grade: 2024 }, { password: 'New-password-2026' },
  ])('先完成账号变更，再继续刷新：%o', async (change) => {
    const f = await fixture();
    const paused = pauseAfterOwner(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    await new UsersController(client2 as any, audit as any).update(f.id, change as any, 'operator', '127.0.0.1');
    paused.proceed();
    await expect(refresh).rejects.toThrow();
    expect(await client1.refreshToken.count({ where: { userId: f.id, revokedAt: null } })).toBe(0);
  }, 30000);

  test('登出先完成时，已定位的刷新不能恢复会话', async () => {
    const f = await fixture();
    const paused = pauseAfterOwner(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    await service(client2).logout(f.raw, f.id);
    paused.proceed();
    await expect(refresh).rejects.toThrow();
    expect(await client1.refreshToken.count({ where: { userId: f.id, revokedAt: null } })).toBe(0);
  }, 30000);

  test.each([
    { status: 'DISABLED' }, { role: Role.STUDENT }, { grade: 2024 }, { password: 'New-password-2026' },
  ])('刷新先持有行锁时，并发账号变更撤销新会话：%o', async (change) => {
    const f = await fixture();
    const paused = pauseAfterWriteLock(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    const update = new UsersController(client2 as any, audit as any).update(f.id, change as any, 'operator', '127.0.0.1');
    // Allow the second request to enter its independent transaction while the first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    paused.proceed();
    const results = await Promise.allSettled([refresh, update]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    expect(await client1.refreshToken.count({ where: { userId: f.id, revokedAt: null } })).toBe(0);
  }, 30000);

  test('仅以旧令牌登出时，与刷新竞争后撤销轮换出的会话', async () => {
    const f = await fixture();
    const paused = pauseAfterWriteLock(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    const logout = service(client2).logout(f.raw);
    await new Promise((resolve) => setTimeout(resolve, 50));
    paused.proceed();
    const results = await Promise.allSettled([refresh, logout]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await client1.refreshToken.count({ where: { userId: f.id, familyId: f.family, revokedAt: null } })).toBe(0);
  }, 30000);

  test('改密先完成时，已定位的旧令牌刷新不能恢复旧会话', async () => {
    const f = await fixture();
    const paused = pauseAfterOwner(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    const changed = await service(client2).changePassword(f.id, 'Old-password-2026', 'Changed-password-2026', '127.0.0.1', f.family);
    paused.proceed();
    await expect(refresh).rejects.toThrow();
    const active = await client1.refreshToken.findMany({ where: { userId: f.id, revokedAt: null } });
    expect(active).toHaveLength(1);
    expect(active[0].tokenHash).toBe(sha(changed.refreshToken));
  }, 30000);

  test('两个连接同时轮换同一刷新令牌，重放不能留下两个有效令牌', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([service(client1).refresh(opts(f.raw)), service(client2).refresh(opts(f.raw))]);
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBe(1);
    const active = await client1.refreshToken.count({ where: { userId: f.id, revokedAt: null } });
    expect(results.some((r) => r.status === 'rejected' && String(r.reason).includes('检测到令牌重用'))).toBe(true);
    expect(active).toBe(0);
  }, 30000);

  test('已轮换令牌被重放时，新令牌家族在真实数据库中撤销', async () => {
    const f = await fixture();
    await service(client1).refresh(opts(f.raw));
    await expect(service(client2).refresh(opts(f.raw))).rejects.toThrow('检测到令牌重用');
    expect(await client1.refreshToken.count({ where: { userId: f.id, familyId: f.family, revokedAt: null } })).toBe(0);
  }, 30000);
});
