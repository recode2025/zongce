import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.module';
import { CasLoginStateService } from '../src/modules/auth/cas/cas-login-state.service';

const describeSqlite = process.env.RUN_SQLITE_SESSION_E2E === '1' ? describe : describe.skip;
describeSqlite('CAS 登录状态（隔离 SQLite）', () => {
  const ru = 'https://campus.example/cas/callback';
  let directory: string;
  let first: PrismaClient, second: PrismaClient;
  let authorize: CasLoginStateService, callback: CasLoginStateService;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'zc-cas-state-'));
    const file = join(directory, 'test.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE CasLoginState (state TEXT PRIMARY KEY, browserSecretHash TEXT NOT NULL, ru TEXT NOT NULL, expiresAt DATETIME NOT NULL)');
    db.close();
    const datasourceUrl = 'file:' + file.replace(/\\/g, '/');
    first = new PrismaClient({ datasourceUrl });
    second = new PrismaClient({ datasourceUrl });
    authorize = new CasLoginStateService(first as PrismaService);
    callback = new CasLoginStateService(second as PrismaService);
  });
  afterAll(async () => {
    await Promise.all([first?.$disconnect(), second?.$disconnect()]);
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test('跨实例回调绑定原浏览器，同一状态的并发回调只有一个成功', async () => {
    const state = 'v2-' + randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    await authorize.create(state, secret, ru, new Date(Date.now() + 600_000));
    const saved = await first.casLoginState.findUniqueOrThrow({ where: { state } });
    expect(saved.browserSecretHash).not.toEqual(secret);
    await expect(callback.consume(state, 'another-browser')).resolves.toBeNull();

    const results = await Promise.all([callback.consume(state, secret), authorize.consume(state, secret)]);
    expect(results).toHaveLength(2);
    expect(results).toContainEqual({ ru });
    expect(results).toContain(null);
    await expect(callback.consume(state, secret)).resolves.toBeNull();
  });

  test('即使记录仍在数据库中，超时回调也不能换票，下一次发起登录将清理过期记录', async () => {
    const expired = 'v2-' + randomBytes(16).toString('hex');
    const fresh = 'v2-' + randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    await authorize.create(expired, secret, ru, new Date(Date.now() - 1_000));
    await expect(callback.consume(expired, secret)).resolves.toBeNull();
    await authorize.create(fresh, secret, ru, new Date(Date.now() + 600_000));
    expect(await first.casLoginState.findUnique({ where: { state: expired } })).toBeNull();
    await expect(callback.consume(fresh, secret)).resolves.toEqual({ ru });
  });
});
