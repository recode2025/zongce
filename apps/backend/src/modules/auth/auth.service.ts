import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../../common/decorators';
import { rateLimit } from '../../common/utils/rate-limit';
import { env } from '../../config/env';
import { CasService } from './cas/cas.service';
import { genCaptchaSvg } from './captcha';

const REFRESH_COOKIE = 'zc_rt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cache: CacheService,
    private audit: AuditService,
    private cas: CasService,
  ) {}

  // ---------- 验证码 ----------

  /** 签发图形验证码：答案存 cache 5 分钟，登录时一次性校验后即焚 */
  async issueCaptcha() {
    const { text, svg } = genCaptchaSvg();
    const captchaId = randomUUID();
    await this.cache.set(`captcha:${captchaId}`, text.toLowerCase(), 300);
    return { captchaId, svg };
  }

  private async verifyCaptcha(captchaId?: string, code?: string) {
    const expect = captchaId ? await this.cache.get(`captcha:${captchaId}`) : null;
    if (expect) await this.cache.del(`captcha:${captchaId}`); // 一次性：无论对错都作废
    if (!expect || !code?.trim() || code.trim().toLowerCase() !== expect) {
      throw new BadRequestException('验证码错误或已过期，请刷新后重试');
    }
  }

  // ---------- 登录 ----------

  async login(opts: { username: string; password: string; ip: string; ua: string; captchaId?: string; captchaCode?: string }) {
    await this.verifyCaptcha(opts.captchaId, opts.captchaCode); // 先验验证码（不消耗登录限流）
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
    // 注意取 .raw：issueRefresh 返回 {id, raw}，直接拼对象会让 cookie 变成 [object Object]
    const rt = await this.issueRefresh(user.id, opts.ip, opts.ua);

    return this.loginResponse(jwtUser, accessToken, rt.raw);
  }

  // ---------- CAS 统一身份认证登录（数字大外） ----------

  /** 学号 + 学校密码 → CAS 校验 → 映射平台本地账号 → 签发本平台会话 */
  async casLogin(opts: { username: string; password: string; ip: string; ua: string; captchaId?: string; captchaCode?: string }) {
    await this.verifyCaptcha(opts.captchaId, opts.captchaCode); // 先验验证码（不消耗登录限流）
    const username = opts.username.trim();
    // 与本地登录同等的双重限流（防用 CAS 通道爆破学校密码）
    await rateLimit(this.cache, { scope: 'login-ip', id: opts.ip, limit: 20, windowSec: 60 });
    await rateLimit(this.cache, { scope: 'login-user', id: username, limit: 8, windowSec: 900 });

    // CAS 侧校验（失败直接抛出，错误文案来自学校认证页）
    const { userInfo } = await this.cas.login(username, opts.password);

    const user = await this.prisma.user.findUnique({ where: { username }, include: { student: true } });
    if (!user || user.status === 'DISABLED') {
      await this.audit.log({ action: 'LOGIN_FAIL', operatorName: username, ip: opts.ip, ua: opts.ua, detail: { reason: 'cas_user_not_imported' } });
      throw new UnauthorizedException('学校认证通过，但该账号未导入本平台（或已停用），请联系管理员');
    }

    // CAS 已认证学校密码，本地密码不再强制修改；姓名不一致仅审计留痕
    await this.prisma.user.update({ where: { id: user.id }, data: { failedCount: 0, lockedUntil: null } });
    await this.audit.log({
      operatorId: user.id,
      operatorName: user.name,
      action: 'LOGIN',
      ip: opts.ip,
      ua: opts.ua,
      detail: {
        via: 'CAS',
        casName: userInfo.user_name,
        casUnit: userInfo.unit_name,
        nameMismatch: userInfo.user_name !== user.name || undefined,
      },
    });

    const jwtUser: JwtUser = { ...this.toJwtUser(user), mustChangePwd: false };
    const accessToken = await this.signAccess(jwtUser);
    const rt = await this.issueRefresh(user.id, opts.ip, opts.ua);
    return this.loginResponse(jwtUser, accessToken, rt.raw);
  }

  /** 统一登录响应（refresh token 同时以 HttpOnly cookie 下发） */
  private loginResponse(jwtUser: JwtUser, accessToken: string, refreshToken: string) {
    return {
      accessToken,
      refreshToken,
      refreshCookie: `${REFRESH_COOKIE}=${refreshToken}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${env.refreshTokenTtlSec}${env.isDev ? '' : '; Secure'}`,
      user: jwtUser,
    };
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
      mustChangePwd: user.mustChangePwd && user.role !== 'STUDENT',
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
      // 首登强制改密仅约束管理员；学生（学号后6位初始密码）免强制
      mustChangePwd: !!user.mustChangePwd && user.role !== 'STUDENT',
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
