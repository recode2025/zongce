import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../../common/decorators';
import { rateLimit } from '../../common/utils/rate-limit';
import { env } from '../../config/env';

const REFRESH_COOKIE = 'zc_rt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cache: CacheService,
    private audit: AuditService,
  ) {}

  // ---------- 登录 ----------

  async login(opts: { username: string; password: string; ip: string; ua: string }) {
    const username = opts.username.trim();
    // 双重限流：IP 维度 + 账号维度（防爆破）
    await rateLimit(this.cache, { scope: 'login-ip', id: opts.ip, limit: 20, windowSec: 60 });
    await rateLimit(this.cache, { scope: 'login-user', id: username, limit: 8, windowSec: 900 });

    const user = await this.prisma.user.findUnique({ where: { username }, include: { student: true } });
    const t0 = Date.now();
    const ok = user ? await argon2.verify(user.passwordHash, opts.password).catch(() => false) : false;
    // 统一耗时（防时序侧信道）：补齐至 150ms
    const elapsed = Date.now() - t0;
    if (elapsed < 150) await new Promise((r) => setTimeout(r, 150 - elapsed));

    if (!user || !ok || user.status === 'DISABLED') {
      if (user) {
        const failedCount = user.failedCount + 1;
        // 指数退避锁定：5/10/20/40…秒
        const lockSec = failedCount >= 5 ? Math.min(2 ** (failedCount - 4), 3600) : 0;
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedCount, lockedUntil: lockSec ? new Date(Date.now() + lockSec * 1000) : null },
        });
      }
      await this.audit.log({ action: 'LOGIN_FAIL', operatorName: username, ip: opts.ip, ua: opts.ua, detail: { reason: 'bad_credentials' } });
      throw new UnauthorizedException('学号/账号或密码错误');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const wait = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new ForbiddenException(`失败次数过多，账号已临时锁定，请 ${wait} 秒后重试`);
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedCount: 0, lockedUntil: null } });
    await this.audit.log({ operatorId: user.id, operatorName: user.name, action: 'LOGIN', ip: opts.ip, ua: opts.ua });

    const jwtUser = this.toJwtUser(user);
    const accessToken = await this.signAccess(jwtUser);
    const refreshToken = await this.issueRefresh(user.id, opts.ip, opts.ua);

    return { accessToken, refreshToken, refreshCookie: `${REFRESH_COOKIE}=${refreshToken}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${env.refreshTokenTtlSec}${env.isDev ? '' : '; Secure'}`, user: jwtUser };
  }

  // ---------- 刷新令牌轮换 ----------

  async refresh(opts: { refreshToken: string; ip: string; ua: string }) {
    const tokenHash = sha256hex(opts.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: { include: { student: true } } } });
    if (!stored) throw new UnauthorizedException('登录状态无效，请重新登录');

    if (stored.revokedAt) {
      // 重用检测：已作废令牌再次出现 → 吊销整个家族 + 审计告警
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({ action: 'LOGIN_FAIL', operatorId: stored.userId, detail: { reason: 'refresh_reuse_detected' }, ip: opts.ip });
      throw new UnauthorizedException('检测到令牌重用，全部登录已失效，请重新登录');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('登录已过期，请重新登录');

    const newToken = await this.issueRefresh(stored.userId, opts.ip, opts.ua, stored.familyId);
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date(), replacedById: newToken.id } });

    const jwtUser = this.toJwtUser(stored.user);
    const accessToken = await this.signAccess(jwtUser);
    return {
      accessToken,
      refreshToken: newToken.raw,
      refreshCookie: `${REFRESH_COOKIE}=${newToken.raw}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${env.refreshTokenTtlSec}${env.isDev ? '' : '; Secure'}`,
      user: jwtUser,
    };
  }

  async logout(refreshToken: string | undefined, userId?: string) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256hex(refreshToken) }, data: { revokedAt: new Date() } }).catch(() => undefined);
    }
    if (userId) {
      await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return { success: true };
  }

  // ---------- 改密 ----------

  async changePassword(userId: string, oldPassword: string, newPassword: string, ip: string) {
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new BadRequestException('新密码至少 8 位且须包含字母和数字');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (!user.mustChangePwd) {
      const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
      if (!ok) throw new BadRequestException('原密码错误');
    }
    const hash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash, mustChangePwd: false } });
    // 改密后吊销全部既有会话
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ operatorId: userId, operatorName: user.name, action: 'CHANGE_PWD', ip });
    const jwtUser = this.toJwtUser({ ...user, mustChangePwd: false } as any);
    return { accessToken: await this.signAccess(jwtUser), user: jwtUser };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { student: { select: { id: true, studentNo: true, className: true, classId: true, grade: true, enrollStatus: true } } } });
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      mustChangePwd: user.mustChangePwd,
      student: user.student,
      grade: user.grade,
    };
  }

  // ---------- 内部工具 ----------

  toJwtUser(user: any): JwtUser {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role as Role,
      mustChangePwd: !!user.mustChangePwd,
      studentId: user.student?.id,
      classId: user.student?.classId,
      grade: user.grade ?? user.student?.grade ?? null,
    };
  }

  async signAccess(user: JwtUser): Promise<string> {
    return this.jwt.signAsync({ ...user }, { secret: env.jwtAccessSecret, expiresIn: env.jwtAccessTtlSec });
  }

  private async issueRefresh(userId: string, ip: string, ua: string, familyId?: string) {
    const raw = randomBytes(48).toString('base64url');
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256hex(raw),
        familyId: familyId ?? randomBytes(16).toString('hex'),
        expiresAt: new Date(Date.now() + env.refreshTokenTtlSec * 1000),
        ip: ip.slice(0, 64),
        ua: ua.slice(0, 255),
      },
    });
    return { id: row.id, raw };
  }
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
