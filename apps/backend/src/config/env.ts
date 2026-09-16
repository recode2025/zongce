import * as path from 'path';

function int(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

const dev = process.env.NODE_ENV !== 'production';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: dev,
  port: int(process.env.PORT, 3000),

  /** 本地开发可留空 → 退化为 SQLite（需先跑 pnpm db:local 生成 sqlite schema） */
  databaseUrl: process.env.DATABASE_URL || '',
  /** SQLite 模式标识（make-sqlite-schema 使用） */
  sqliteUrl: process.env.SQLITE_URL || 'file:./dev.db',

  redisUrl: process.env.REDIS_URL || '', // 留空 → 进程内缓存 + 内联任务（仅本地开发）

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

  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

if (!dev && !env.jwtAccessSecret) {
  throw new Error('JWT_ACCESS_SECRET must be set in production');
}
