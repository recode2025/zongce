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

  async del(...keys: string[]): Promise<void> {
    if (this.redis) {
      if (keys.length) await this.redis.del(...keys);
      return;
    }
    keys.forEach((k) => this.mem.delete(k));
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
