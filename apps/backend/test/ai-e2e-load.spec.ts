/** Opt-in isolated HTTP / Redis test. Never contacts DeepSeek or the real database. */
import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import Redis from 'ioredis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.module';
import { CacheService } from '../src/cache/cache.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { CasService } from '../src/modules/auth/cas/cas.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { FilesController } from '../src/modules/files/files.controller';
import { StorageService } from '../src/modules/files/storage.service';
import { ZipService } from '../src/modules/files/zip.service';
import { ApplicationsController } from '../src/modules/applications/applications.module';
import { ApplicationsService } from '../src/modules/applications/applications.service';
import { PackagesService } from '../src/modules/applications/packages.service';
import { AiDraftService } from '../src/modules/applications/ai-draft.service';
import { AiEvidenceService } from '../src/modules/applications/ai-evidence.service';

const enabled = process.env.RUN_AI_E2E === '1';
(enabled ? describe : describe.skip)('isolated AI HTTP and load test', () => {
  const prefix = `zc:test:ai:${randomUUID()}:`;
  const tmp = path.resolve(__dirname, '../tmp', `ai-e2e-${randomUUID()}`);
  const oldFetch = global.fetch;
  const oldEnv = { ...env };
  const files = new Map<string, any>();
  const sessions = new Map<string, any>();
  let app: any, redis: Redis, base: string, modelCalls = 0, active = 0, maxActive = 0;
  const modelInputs: any[] = [];
  let passwordHash = '';
  const student = { id: 'synthetic-student', username: 'test-student', name: 'Synthetic Student', role: 'STUDENT', status: 'ACTIVE', failedCount: 0, lockedUntil: null, mustChangePwd: false, student: { id: 'synthetic-student-record', classId: 'test-class', grade: 2026 } };
  const prisma: any = {
    sysConfig: { findUnique: async () => null },
    user: { findUnique: async ({ where }: any) => where.username === student.username || where.id === student.id || /^load-\d+$/.test(where.id ?? '') || where.id === 'other-test-student' ? { ...student, id: where.id ?? student.id, passwordHash } : null, update: async () => ({}), updateMany: async () => ({ count: 1 }) },
    refreshToken: {
      create: async ({ data }: any) => { const row = { id: randomUUID(), ...data }; sessions.set(data.familyId, row); return row; },
      findFirst: async ({ where }: any) => where.familyId === 'fixture-session' && /^(load-\d+|other-test-student)$/.test(where.userId) ? { id: 'fixture' } : (sessions.get(where.familyId)?.userId === where.userId ? sessions.get(where.familyId) : null),
    },
    fileObject: {
      create: async ({ data }: any) => { const row = { id: randomUUID(), ...data }; files.set(row.id, row); return row; },
      findMany: async ({ where }: any) => where.id.in.map((id: string) => files.get(id)).filter((x: any) => x && x.uploaderId === where.uploaderId),
    },
    ruleItem: { findUnique: async () => ({ id: 'rule', name: '测试项目', description: '测试规则', isActive: true, applyType: 'SELF', detailSchema: [{ field: 'level', label: '级别', type: 'select', options: [{ value: 'school', label: '校级' }] }] }) },
    $transaction: async (fn: any) => fn(prisma),
  };

  beforeAll(async () => {
    env.deepseekApiKey = 'isolated-test-key';
    env.jwtAccessSecret = `isolated-${randomUUID()}`;
    env.uploadDir = tmp;
    env.aiDailyUserLimit = 1000;
    env.aiDailyGlobalLimit = 1000;
    env.aiConcurrentLimit = 5;
    fs.mkdirSync(tmp, { recursive: true });
    passwordHash = await argon2.hash('Synthetic-Test-Only');
    redis = new Redis(process.env.AI_E2E_REDIS_URL || 'redis://127.0.0.1:6379/0', { keyPrefix: prefix, maxRetriesPerRequest: 1 });
    await redis.ping();
    const cache = Object.create(CacheService.prototype) as CacheService;
    Object.defineProperty(cache, 'redis', { value: redis });
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Unexpected external request blocked');
      const body = JSON.parse(String(init?.body));
      if (!body.messages[1].content) throw new Error('Missing model input');
      modelInputs.push(body.messages[1].content);
      modelCalls++; active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active--;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '测试证书', detail: { level: 'school', unexpected: 'ignored' } }) } }] }) } as Response;
    }) as typeof fetch;
    @Module({
      imports: [JwtModule.register({ global: true })],
      controllers: [AuthController, FilesController, ApplicationsController],
      providers: [
        { provide: PrismaService, useValue: prisma }, { provide: CacheService, useValue: cache },
        { provide: AuditService, useValue: { log: async () => {} } }, { provide: CasService, useValue: {} },
        { provide: ZipService, useValue: {} }, { provide: ApplicationsService, useValue: {} }, { provide: PackagesService, useValue: {} },
        AuthService, StorageService, AiDraftService, AiEvidenceService, JwtAuthGuard, RolesGuard,
      ],
    })
    class IsolatedTestModule {}
    app = await NestFactory.create(IsolatedTestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalGuards(app.get(JwtAuthGuard), app.get(RolesGuard));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (redis) {
      // SCAN returns actual names; use an unprefixed connection and only delete this run's unique keys.
      const cleaner = new Redis(process.env.AI_E2E_REDIS_URL || 'redis://127.0.0.1:6379/0');
      let cursor = '0';
      do { const [next, keys] = await cleaner.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100); cursor = next; if (keys.length) await cleaner.del(...keys); } while (cursor !== '0');
      await cleaner.quit(); if (redis.status !== 'end') await redis.quit();
    }
    if (tmp.startsWith(path.resolve(__dirname, '../tmp') + path.sep)) fs.rmSync(tmp, { recursive: true, force: true });
    global.fetch = oldFetch;
    Object.assign(env, oldEnv);
  }, 30000);

  test('student login → upload image → AI draft; concurrency is bounded', async () => {
    const request = async (p: string, init?: RequestInit) => oldFetch(base + p, init);
    const json = (body: unknown, token?: string): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const gate = await (await request('/auth/gate', json({ passphrase: env.loginPassphrase }))).json() as any;
    const cap = await (await request('/auth/captcha')).json() as any;
    const captchaCode = [...String(cap.svg).matchAll(/<text[^>]*>([A-HJ-NP-Z2-9])<\/text>/g)].map((m) => m[1]).join('');
    const login = await request('/auth/login', json({ username: student.username, password: 'Synthetic-Test-Only', gateToken: gate.gateToken, captchaId: cap.captchaId, captchaCode }));
    expect(login.status).toBe(200);
    const token = ((await login.json()) as any).accessToken as string;
    const form = new FormData();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SjAAAAAASUVORK5CYII=', 'base64');
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'synthetic.png');
    const upload = await request('/files/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    expect(upload.status).toBe(201);
    const fileId = ((await upload.json()) as any).id;
    const jwt = app.get(JwtService);
    const otherUser = await jwt.signAsync({ ...student, id: 'other-test-student', sid: 'fixture-session' }, { secret: env.jwtAccessSecret });
    const missingAuth = await request('/applications/ai-evidence', json({ ruleItemId: 'rule', fileIds: [fileId] }));
    expect(missingAuth.status).toBe(401);
    const otherFile = await request('/applications/ai-evidence', json({ ruleItemId: 'rule', fileIds: [fileId] }, otherUser));
    expect(otherFile.status).toBe(400);
    expect(modelCalls).toBe(0);
    const result = await request('/applications/ai-evidence', json({ ruleItemId: 'rule', fileIds: [fileId], text: '真实经历文字' }, token));
    const body = await result.json();
    expect(result.status).toBe(201);
    expect(body).toEqual({ title: '测试证书', detail: { level: 'school' } });
    expect(Array.isArray(modelInputs[0])).toBe(true);
    expect(JSON.parse(modelInputs[0][0].text).facts).toBe('真实经历文字');
    expect(modelInputs[0][1].image_url.url).toMatch(/^data:image\/png;base64,/);
    // Direct HTTP requests with different signed synthetic users avoid the per-user minute throttle.
    const signed = await Promise.all(Array.from({ length: 50 }, (_, i) => jwt.signAsync({ ...student, id: `load-${i}`, sid: 'fixture-session' }, { secret: env.jwtAccessSecret })));
    const service = app.get(AiDraftService) as AiDraftService;
    const began = Date.now();
    const beforeRss = process.memoryUsage().rss;
    let peakRss = beforeRss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    const timings: number[] = [];
    const results = await Promise.all(signed.map(async (t: string) => { const start = Date.now(); const res = await request('/applications/ai-draft', json({ ruleItemId: 'rule', text: '测试事实' }, t)); timings.push(Date.now() - start); return res; }));
    clearInterval(sampler);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(45);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(modelCalls).toBe(6);
    expect(Number((await redis.hgetall('zc:ai-quota:{daily}:global')).count)).toBe(6);
    timings.sort((a, b) => a - b);
    console.log(`HTTP load: 50 concurrent, ok=5, rejected=45, model max concurrency=${maxActive}, elapsed=${Date.now() - began}ms, p95=${timings[Math.ceil(timings.length * 0.95) - 1]}ms, peak RSS delta=${Math.round((peakRss - beforeRss) / 1048576)} MiB`);
    expect(service).toBeDefined();
  }, 60000);
});
