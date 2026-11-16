import { CacheService } from '../src/cache/cache.service';

describe('AI 额度存储', () => {
  test('Redis 未配置时拒绝扣额', async () => {
    const cache = Object.create(CacheService.prototype) as CacheService;
    Object.defineProperty(cache, 'redis', { value: null });
    await expect(cache.consumeDailyQuota('student-1', 10, 1000)).rejects.toThrow('Redis is required');
  });

  test('由 Redis 原子脚本同时检查额度，并区分不同拒绝原因', async () => {
    const evalScript = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const cache = Object.create(CacheService.prototype) as CacheService;
    Object.defineProperty(cache, 'redis', { value: { eval: evalScript } });
    expect(await cache.consumeDailyQuota('student-1', 10, 1000)).toBe('ok');
    expect(await cache.consumeDailyQuota('student-1', 10, 1000)).toBe('user');
    expect(await cache.consumeDailyQuota('student-1', 10, 1000)).toBe('global');
    const [script, numKeys, globalKey, usersKey, user, limit, totalLimit] = evalScript.mock.calls[0];
    expect(script).toContain("redis.call('TIME')");
    expect(numKeys).toBe(2);
    expect(globalKey).toContain('{daily}');
    expect(usersKey).toContain('{daily}');
    expect([user, limit, totalLimit]).toEqual(['student-1', 10, 1000]);
  });
});
