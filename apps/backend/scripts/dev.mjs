#!/usr/bin/env node
// 跨平台 dev 启动器：prisma generate（按环境选 schema）+ 并行跑 tsc --watch 与 node --watch。
// 背景：Windows cmd 的 `&` 只是顺序分隔符，无法后台执行，导致旧脚本里 `tsc --watch & node --watch`
// 的 node 永远等不到启动；且旧的 `pnpm db:generate` 固定按 MySQL schema 生成 client，会覆盖
// `pnpm db:local` 生成的 SQLite client，本地无 DATABASE_URL 时启动即崩（P1012）。
// 约定：有 DATABASE_URL → MySQL schema；否则 → SQLite（本地零依赖联调，需先 pnpm db:local）。
// 本地联调默认 PORT=3210（与 apps/frontend 的 vite 代理一致），可用环境变量 PORT 覆盖。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '3210';
const node = process.execPath;
const tsc = join(backendDir, 'node_modules', 'typescript', 'bin', 'tsc');
const prismaCli = join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');
const schema = process.env.DATABASE_URL
  ? join(backendDir, 'prisma', 'schema.prisma')
  : join(backendDir, 'prisma', 'sqlite.schema.prisma');
const env = { ...process.env, PORT: port };

if (!existsSync(schema)) {
  console.error(`[dev] 缺少 ${schema}，请先执行 pnpm db:local（本地 SQLite）或设置 DATABASE_URL（MySQL）`);
  process.exit(1);
}

const gen = spawnSync(node, [prismaCli, 'generate', '--schema', schema], { cwd: backendDir, env, stdio: 'inherit' });
if (gen.status !== 0) process.exit(gen.status ?? 1);

const children = [];
function watch(name, args, stdio = 'inherit') {
  const child = spawn(node, args, { cwd: backendDir, env, stdio });
  child.on('exit', (code, sig) => {
    console.log(`[dev] ${name} 退出（${sig ?? `code ${code}`}），停止全部进程`);
    for (const c of children) if (c !== child && !c.killed) c.kill();
    process.exit(code ?? 1);
  });
  children.push(child);
  return child;
}

// 等待 watch 首轮编译完成后再启动服务，避免首轮写入 dist 时反复重启。
// 只监听 dist：Node 默认会追踪 node_modules 等所有依赖，偶发变动会导致请求期间服务重启。
const compiler = watch('tsc', [tsc, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput', '--pretty', 'false'], ['inherit', 'pipe', 'inherit']);
let output = '';
let serverStarted = false;
compiler.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (serverStarted) return;
  output = (output + chunk.toString()).slice(-4096);
  if (/Found 0 errors?\. Watching for file changes\./.test(output)) {
    serverStarted = true;
    watch('server', ['--enable-source-maps', '--watch-path=dist', 'dist/main.js']);
  }
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
