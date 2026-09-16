/**
 * M7 查分压测：模拟发布瞬间 ~150 名学生并发查分（走完整登录 → /publish/scores/mine）。
 * 设计对齐：
 *  - 登录 IP 限流 20/min → 每次登录随机 X-Forwarded-For（模拟不同来源 IP）
 *  - 查分限流 10/min/user → 每用户打 8 次（150×8=1200 请求，不触限流）
 *  - 发布时已物化全量快照 → 本测的是热缓存读路径（发布瞬间的真实形态）
 */
import { PrismaClient } from '@prisma/client';

const BASE = 'http://127.0.0.1:3210/api/v1';
const N = Number(process.env.BENCH_N ?? 150);
const ROUNDS = 8;

const prisma = new PrismaClient();
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function login(username) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': randIp() },
    body: JSON.stringify({ username, password: username.slice(-6) }),
  });
  if (r.status !== 200) throw new Error(`login ${username} → ${r.status}`);
  return (await r.json()).accessToken;
}

// ============ 1. 准备：抽 N 名正常学籍学生并置 mustChangePwd=false（模拟已完成首登改密） ============
const students = await prisma.student.findMany({
  where: { enrollStatus: 'NORMAL', user: { mustChangePwd: true } },
  select: { id: true, studentNo: true, userId: true },
  take: N,
});
if (students.length < 10) {
  console.error(`可压测学生不足（${students.length}），请先跑 e2e-full.mjs 导入学生并发布成绩`);
  process.exit(1);
}
await prisma.user.updateMany({ where: { id: { in: students.map((s) => s.userId) } }, data: { mustChangePwd: false } });
console.log(`准备：${students.length} 名学生已解锁首登改密（模拟已改密）`);

// ============ 2. 并发登录（10 路） ============
const tLogin0 = Date.now();
const tokens = [];
const queue = [...students];
await Promise.all(
  Array.from({ length: 10 }, async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) break;
      try {
        tokens.push(await login(s.studentNo));
      } catch (e) {
        console.error(e.message);
      }
    }
  }),
);
console.log(`登录：${tokens.length}/${students.length} 成功，耗时 ${((Date.now() - tLogin0) / 1000).toFixed(1)}s`);
if (tokens.length < 10) process.exit(1);

// ============ 3. 并发查分：ROUNDS 轮 × 全员并发 ============
const latencies = [];
const errors = [];
let cacheHit = 0;
const t0 = Date.now();
for (let round = 1; round <= ROUNDS; round++) {
  await Promise.all(
    tokens.map(async (tok) => {
      const s = Date.now();
      try {
        const r = await fetch(`${BASE}/publish/scores/mine`, { headers: { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': randIp() } });
        const j = await r.json().catch(() => ({}));
        latencies.push(Date.now() - s);
        if (j.source === 'cache') cacheHit++;
        if (r.status !== 200) errors.push(`${r.status}:${JSON.stringify(j).slice(0, 80)}`);
      } catch (e) {
        latencies.push(Date.now() - s);
        errors.push(String(e.message).slice(0, 80));
      }
    }),
  );
}
const totalMs = Date.now() - t0;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
console.log(`\n——— 查分压测结果（${students.length} 用户 × ${ROUNDS} 轮 = ${latencies.length} 请求，总耗时 ${(totalMs / 1000).toFixed(1)}s）———`);
console.log(`  吞吐   ${Math.round((latencies.length / totalMs) * 1000)} req/s`);
console.log(`  延迟   P50=${pct(50)}ms  P95=${pct(95)}ms  P99=${pct(99)}ms  max=${latencies[latencies.length - 1]}ms`);
console.log(`  缓存   ${cacheHit}/${latencies.length} 命中快照缓存`);
console.log(`  错误   ${errors.length}${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);

const pass = errors.length === 0 && pct(95) < 200 && cacheHit === latencies.length;
console.log(pass ? `\n✅ 压测通过（P95<200ms、零错误、全缓存命中）` : `\n❌ 压测未达标`);
await prisma.$disconnect();
process.exit(pass ? 0 : 1);
