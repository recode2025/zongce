import { HttpException, HttpStatus } from '@nestjs/common';
import { CacheService } from '../../cache/cache.service';
import { REDIS_KEYS } from '@zc/shared';

/**
 * 固定窗口限流（Redis/内存双模式）。
 * 用于：登录防爆破（IP 10/min、账号 5/15min）、查分接口 per-user 10/min。
 */
export async function rateLimit(
  cache: CacheService,
  opts: { scope: string; id: string; limit: number; windowSec: number },
): Promise<void> {
  const key = REDIS_KEYS.rateLimit(opts.scope, opts.id);
  const n = await cache.incrWithWindow(key, opts.windowSec);
  if (n > opts.limit) {
    throw new HttpException(`操作过于频繁，请 ${opts.windowSec >= 60 ? Math.ceil(opts.windowSec / 60) + ' 分钟' : opts.windowSec + ' 秒'}后再试`, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** 幂等保护：同 Idempotency-Key 10 分钟内重复请求直接 409 */
export async function idempotencyGuard(cache: CacheService, key: string): Promise<void> {
  if (!key) return;
  const ok = await cache.setNx(REDIS_KEYS.idempotency(key), '1', 600);
  if (!ok) {
    throw new HttpException('请勿重复提交', HttpStatus.CONFLICT);
  }
}
