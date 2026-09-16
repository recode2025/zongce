/**
 * 重置超管密码并解锁（本地开发自救用）
 * 运行：node scripts/reset-admin.mjs [新密码]（不传则用默认 Admin@Zc2026）
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const password = process.argv[2] || 'Admin@Zc2026';
const prisma = new PrismaClient();

const user = await prisma.user.update({
  where: { username: 'admin' },
  data: {
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    mustChangePwd: true,
    failedCount: 0,
    lockedUntil: null,
  },
});

console.log(`✔ 超管已重置: admin (id=${user.id}，新密码已生效，首登须改密，锁定已清除)`);
await prisma.$disconnect();
