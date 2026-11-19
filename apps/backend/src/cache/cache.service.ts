import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * 缓存抽象：有 REDIS_URL → ioredis；否则进程内 Map（仅限本地开发/单进程）。
 * 高并发查分快照在生产必须走 Redis；内存模式仅为本地可运行性兜底。
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  readonly redis: Redis | null = null;
  private mem = new Map<string, { value: string; expiresAt: number | null }>();

  constructor() {
    if (env.redisUrl) {
      this.redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
      this.redis.on('error', (e) => this.logger.warn(`redis error: ${e.message}`));
    }
  }

  get isRedis(): boolean {
    return this.redis !== null;
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) return this.redis.get(key);
    const hit = this.mem.get(key);
    if (!hit) return null;
    if (hit.expiresAt && hit.expiresAt < Date.now()) {
      this.mem.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (this.redis) {
      if (ttlSec) await this.redis.set(key, value, 'EX', ttlSec);
      else await this.redis.set(key, value);
      return;
    }
    this.mem.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null });
  }

  async del(...keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    if (this.redis) return this.redis.del(...keys);
    let deleted = 0;
    for (const key of keys) {
      if (this.mem.delete(key)) deleted++;
    }
    return deleted;
  }

  /** 批量 pipeline 写入（发布快照用） */
  async msetBulk(items: { key: string; value: string; ttlSec?: number }[]): Promise<void> {
    if (!items.length) return;
    if (this.redis) {
      const pipeline = this.redis.pipeline();
      for (const it of items) {
        if (it.ttlSec) pipeline.set(it.key, it.value, 'EX', it.ttlSec);
        else pipeline.set(it.key, it.value);
      }
      await pipeline.exec();
      return;
    }
    for (const it of items) await this.set(it.key, it.value, it.ttlSec);
  }

  /** 固定窗口计数器（限流）：返回当前计数，窗口首次创建时设置 TTL */
  async incrWithWindow(key: string, windowSec: number): Promise<number> {
    if (this.redis) {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, windowSec);
      return n;
    }
    const now = Date.now();
    const hit = this.mem.get(key);
    if (!hit || (hit.expiresAt && hit.expiresAt < now)) {
      this.mem.set(key, { value: '1', expiresAt: now + windowSec * 1000 });
      return 1;
    }
    const n = Number(hit.value) + 1;
    this.mem.set(key, { value: String(n), expiresAt: hit.expiresAt });
    return n;
  }

  /** 同时检查并消耗个人与全局每日额度；Redis 脚本保证多实例并发原子性。
   * 不设置 TTL，避免 volatile-ttl 淘汰导致当日额度回退；值跨日自动重置。 */
  async consumeDailyQuota(userId: string, userLimit: number, globalLimit: number): Promise<'ok' | 'user' | 'global'> {
    const globalKey = 'zc:ai-quota:{daily}:global';
    const usersKey = 'zc:ai-quota:{daily}:users';
    if (this.redis) {
      const script = `
        local day = tostring(math.floor((tonumber(redis.call('TIME')[1]) + 28800) / 86400))
        local g = redis.call('HMGET', KEYS[1], 'day', 'count')
        local total = 0
        if g[1] == day then total = tonumber(g[2]) or 0 end
        local u = redis.call('HGET', KEYS[2], ARGV[1])
        local count = 0
        if u then
          local d, n = string.match(u, '^(%d+):(%d+)$')
          if d == day then count = tonumber(n) end
        end
        if count >= tonumber(ARGV[2]) then return 1 end
        if total >= tonumber(ARGV[3]) then return 2 end
        redis.call('HSET', KEYS[1], 'day', day, 'count', total + 1)
        redis.call('HSET', KEYS[2], ARGV[1], day .. ':' .. (count + 1))
        return 0
      `;
      const result = Number(await this.redis.eval(script, 2, globalKey, usersKey, userId, userLimit, globalLimit));
      if (result !== 0 && result !== 1 && result !== 2) throw new Error('Invalid quota result');
      return result === 1 ? 'user' : result === 2 ? 'global' : 'ok';
    }
    throw new Error('Redis is required for AI quota');
  }

  /** 用 Redis 有序集合原子申请全局并发槽；过期令牌由后续请求清理。 */
  async acquireAiSlot(token: string, limit: number): Promise<boolean> {
    if (!this.redis) throw new Error('Redis is required for AI concurrency');
    const script = `
      local now = tonumber(redis.call('TIME')[1])
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
      if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
      redis.call('ZADD', KEYS[1], now + 180, ARGV[1])
      return 1
    `;
    const result = Number(await this.redis.eval(script, 1, 'zc:ai-concurrency:slots', token, limit));
    if (result !== 0 && result !== 1) throw new Error('Invalid slot result');
    return result === 1;
  }

  async releaseAiSlot(token: string): Promise<void> {
    if (!this.redis) throw new Error('Redis is required for AI concurrency');
    await this.redis.zrem('zc:ai-concurrency:slots', token);
  }

  /** SETNX 幂等锁：成功返回 true */
  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    if (this.redis) {
      const r = await this.redis.set(key, value, 'EX', ttlSec, 'NX');
      return r === 'OK';
    }
    const now = Date.now();
    const hit = this.mem.get(key);
    if (hit && (!hit.expiresAt || hit.expiresAt > now)) return false;
    this.mem.set(key, { value, expiresAt: now + ttlSec * 1000 });
    return true;
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
