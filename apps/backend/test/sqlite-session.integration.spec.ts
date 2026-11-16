/** Opt-in real SQLite integration tests. Creates and removes only its own temporary database. */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { Role } from '@zc/shared';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersController } from '../src/modules/users/users.module';
import { DatabaseSync } from 'node:sqlite';

const enabled = process.env.RUN_SQLITE_SESSION_E2E === '1';
const describeIf = enabled ? describe : describe.skip;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describeIf('真实 SQLite 会话并发（独立临时库）', () => {
  let directory = '';
  let client1: PrismaClient, client2: PrismaClient;
  let hash: string;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed-access') };
  const opts = (refreshToken: string) => ({ refreshToken, ip: '127.0.0.1', ua: 'integration' });
  const service = (p: any) => new AuthService(p, jwt as any, {} as any, audit as any, {} as any);

  beforeAll(async () => {
    const base = path.resolve(__dirname, '../../../.turbo');
    fs.mkdirSync(base, { recursive: true });
    directory = fs.mkdtempSync(path.join(base, 'sqlite-session-integration-'));
    const db = path.join(directory, 'isolated.db').replace(/\\/g, '/');
    const init = new DatabaseSync(db);
    init.exec(`
      CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE, "passwordHash" TEXT NOT NULL,
        "name" TEXT NOT NULL, "role" TEXT NOT NULL, "mustChangePwd" BOOLEAN NOT NULL DEFAULT 1,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE', "failedCount" INTEGER NOT NULL DEFAULT 0,
        "lockedUntil" DATETIME, "grade" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL);
      CREATE TABLE "Student" ("id" TEXT PRIMARY KEY, "studentNo" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
        "gender" TEXT, "college" TEXT NOT NULL DEFAULT '', "major" TEXT NOT NULL DEFAULT '',
        "classId" TEXT NOT NULL, "className" TEXT NOT NULL, "grade" INTEGER NOT NULL,
        "enrollStatus" TEXT NOT NULL DEFAULT 'NORMAL', "enrollRaw" TEXT, "idCardEnc" TEXT,
        "userId" TEXT UNIQUE, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
      CREATE TABLE "RefreshToken" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE,
        "familyId" TEXT NOT NULL, "expiresAt" DATETIME NOT NULL, "revokedAt" DATETIME, "replacedById" TEXT,
        "ip" TEXT NOT NULL DEFAULT '', "ua" TEXT NOT NULL DEFAULT '', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE);
      CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
      CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
    `);
    init.close();
    const url = `file:${db}`;
    client1 = new PrismaClient({ datasources: { db: { url } } });
    client2 = new PrismaClient({ datasources: { db: { url } } });
    if ((client1 as any)._engineConfig.activeProvider !== 'sqlite') throw new Error('SQLite tests require a SQLite Prisma client');
    await Promise.all([client1.$connect(), client2.$connect()]);
    hash = await argon2.hash('Old-password-2026');
  }, 60000);

  afterAll(async () => {
    await Promise.all([client1?.$disconnect(), client2?.$disconnect()]);
    const expected = path.resolve(__dirname, '../../../.turbo') + path.sep + 'sqlite-session-integration-';
    if (directory && path.resolve(directory).startsWith(expected)) fs.rmSync(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const id = randomUUID();
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

  // Let the actual transaction acquire the SQLite write lock before pausing it.
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

  test('刷新先持有写锁时，并发停用不能留下有效会话', async () => {
    const f = await fixture();
    const paused = pauseAfterWriteLock(client1);
    const refresh = service(paused.wrapped).refresh(opts(f.raw));
    await paused.reached;
    const disable = new UsersController(client2 as any, audit as any).update(f.id, { status: 'DISABLED' } as any, 'operator', '127.0.0.1');
    // Allow the second request to enter its independent transaction while the first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    paused.proceed();
    const results = await Promise.allSettled([refresh, disable]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    expect((await client1.user.findUnique({ where: { id: f.id } }))?.status).toBe('DISABLED');
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
