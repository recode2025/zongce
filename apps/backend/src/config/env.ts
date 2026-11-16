import * as path from 'path';
import * as fs from 'fs';

// 本地启动时读取项目根目录的私有配置；已有进程环境变量优先。
const rootEnvFile = path.resolve(__dirname, '../../../..', '.env');
if (fs.existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

function int(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

const dev = process.env.NODE_ENV !== 'production';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: dev,
  port: int(process.env.PORT, 3000),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  aiDailyUserLimit: Math.floor(int(process.env.AI_DAILY_USER_LIMIT, 10)),
  aiDailyGlobalLimit: Math.floor(int(process.env.AI_DAILY_GLOBAL_LIMIT, 1000)),
  aiConcurrentLimit: Math.max(1, Math.floor(int(process.env.AI_CONCURRENT_LIMIT, 5))),

  /** 本地开发可留空 → 退化为 SQLite（需先跑 pnpm db:local 生成 sqlite schema） */
  databaseUrl: process.env.DATABASE_URL || '',
  /** SQLite 模式标识（make-sqlite-schema 使用） */
  sqliteUrl: process.env.SQLITE_URL || 'file:./dev.db',

  redisUrl: process.env.REDIS_URL || '', // 留空 → 进程内缓存 + 内联任务（仅本地开发）

  // 仅在后端只能由可信反向代理访问时开启；Express 据此解析 req.ip。
  trustProxy: process.env.TRUST_PROXY === 'true',

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || (dev ? 'dev-secret-do-not-use-in-prod' : ''),
  jwtAccessTtlSec: int(process.env.JWT_ACCESS_TTL_SEC, 900),
  refreshTokenTtlSec: 7 * 24 * 3600,

  aesKeyHex: process.env.AES_KEY_HEX || '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',

  initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD || 'Admin@Zc2026',
  studentInitPwdMode: (process.env.STUDENT_INIT_PWD_MODE || 'LAST6') as 'LITERAL' | 'LAST6',

  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  tmpDir: path.resolve(process.env.TMP_DIR || './tmp'),
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
  zipMaxEntries: int(process.env.ZIP_MAX_ENTRIES, 500),
  zipMaxTotalBytes: int(process.env.ZIP_MAX_TOTAL_MB, 500) * 1024 * 1024,
  zipMaxEntryBytes: int(process.env.ZIP_MAX_ENTRY_MB, 20) * 1024 * 1024,
  zipMaxRatio: int(process.env.ZIP_MAX_RATIO, 100),

  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** 数字大外统一身份认证（CAS）：留空 casBase 即关闭 cas-login 端点 */
  casBase: process.env.CAS_BASE || 'https://cas.dlufl.edu.cn/cas',
  casService: process.env.CAS_SERVICE || 'https://i.dlufl.edu.cn/dcp/',

  /** 登录前密语口令（默认值；后台 SysConfig 可覆盖，key = login.passphrase） */
  loginPassphrase: process.env.LOGIN_PASSPHRASE || 'DUFL1964',
};

export function validateProductionSecrets(values: { jwtAccessSecret: string; aesKeyHex: string; initialAdminPassword: string }): void {
  if (values.jwtAccessSecret.length < 32 || /changeme|dev-secret/i.test(values.jwtAccessSecret)) {
    throw new Error('JWT_ACCESS_SECRET must be a unique production secret of at least 32 characters');
  }
  if (!/^[a-f0-9]{64}$/i.test(values.aesKeyHex) || values.aesKeyHex.toLowerCase() === '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff') {
    throw new Error('AES_KEY_HEX must be a unique 32-byte hexadecimal production key');
  }
  if (values.initialAdminPassword.length < 12 || values.initialAdminPassword === 'Admin@Zc2026' || /changeme/i.test(values.initialAdminPassword)) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be a unique production password of at least 12 characters');
  }
}

if (!dev) {
  validateProductionSecrets(env);
}
