import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../../common/decorators';
import { rateLimit } from '../../common/utils/rate-limit';
import { env } from '../../config/env';
import { CasService, CasUserInfo } from './cas/cas.service';
import { genCaptchaSvg } from './captcha';
import { Prisma } from '@prisma/client';

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

    const jwtUser = this.toJwtUser(user);
    const rt = await this.issueSessionForUser(user, opts.ip, opts.ua);
    const accessToken = await this.signAccess(jwtUser, rt.familyId);
    await this.audit.log({ operatorId: user.id, operatorName: user.name, action: 'LOGIN', ip: opts.ip, ua: opts.ua });

    return this.loginResponse(jwtUser, accessToken, rt.raw);
  }

  // ---------- 登录密语口令（登录页第一道门，后台可改） ----------

  private static readonly PASSPHRASE_KEY = 'login.passphrase';

  /** 当前生效密语：SysConfig 覆盖 > 环境变量默认（DUFL1964） */
  async getLoginPassphrase(): Promise<string> {
    const row = await this.prisma.sysConfig.findUnique({ where: { key: AuthService.PASSPHRASE_KEY } });
    return row?.value?.trim() || env.loginPassphrase;
  }

  async setLoginPassphrase(value: string, operator: { id: string; name: string }, ip: string) {
    const v = value.trim();
    if (v.length < 4 || v.length > 64) throw new BadRequestException('密语口令长度须为 4-64 个字符');
    await this.prisma.sysConfig.upsert({
      where: { key: AuthService.PASSPHRASE_KEY },
      update: { value: v },
      create: { key: AuthService.PASSPHRASE_KEY, value: v },
    });
    await this.audit.log({ operatorId: operator.id, operatorName: operator.name, action: 'USER_UPDATE', detail: { action: 'login_passphrase_change' }, ip });
    return { success: true };
  }

  /**
   * 校验密语口令 → 签发 10 分钟有效的通行令牌（gateToken）。
   * 管理员本地登录（/auth/login）须携带该令牌；学生 CAS 通道不涉及。
   */
  async verifyPassphrase(passphrase: string, ip: string) {
    await rateLimit(this.cache, { scope: 'gate-ip', id: ip, limit: 15, windowSec: 600 });
    const expect = await this.getLoginPassphrase();
    const ok = safeEqual(passphrase.trim(), expect);
    if (!ok) {
      await this.audit.log({ action: 'LOGIN_FAIL', ip, detail: { reason: 'bad_passphrase' } }).catch(() => undefined);
      throw new BadRequestException('密语口令错误，请向管理员确认');
    }
    const gateToken = randomBytes(24).toString('hex');
    await this.cache.set(`gate:${gateToken}`, '1', 600);
    return { gateToken };
  }

  /** gateToken 是否有效（10 分钟内可复用，不主动销毁） */
  async checkGateToken(gateToken?: string): Promise<boolean> {
    if (!gateToken) return false;
    return (await this.cache.get(`gate:${gateToken}`)) === '1';
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
    return this.issueCasSession(userInfo, { ip: opts.ip, ua: opts.ua, via: 'CAS' });
  }

  /** 跳转式 CAS 回调：ticket 校验 → 映射账号 → 签发会话 */
  async casTicketLogin(opts: { ticket: string; service: string; ip: string; ua: string }) {
    const userInfo = await this.cas.validateTicket(opts.ticket, opts.service);
    return this.issueCasSession(userInfo, { ip: opts.ip, ua: opts.ua, via: 'CAS_REDIRECT' });
  }

  /** CAS 属性 → 平台账号映射 + 会话签发（代理式 casLogin 与跳转式 callback 共用） */
  private async issueCasSession(userInfo: CasUserInfo, opts: { ip: string; ua: string; via: string }) {
    // 学校 CAS 的 user_id 是 12 位人员编号 ≠ 平台账号（9 位学号）：
    // 按「<sso:user> 主体（学生登录输入的学号）→ 任意 9 位纯数字属性 → user_id 兜底」
    // 生成候选依次匹配库内 username，命中即用
    const nineDigit = Object.entries(userInfo)
      .filter(([k, v]) => k !== 'principal' && /^\d{9}$/.test(String(v ?? '').trim()))
      .map(([, v]) => String(v).trim());
    const candidates = [...new Set([(userInfo.principal ?? '').trim(), ...nineDigit, userInfo.user_id.trim()].filter(Boolean))];
    await rateLimit(this.cache, { scope: 'login-ip', id: opts.ip, limit: 20, windowSec: 60 });
    console.log(`[cas] 账号映射候选: ${candidates.join(' | ')}`);

    const found = await Promise.all(
      candidates.map((c) => this.prisma.user.findUnique({ where: { username: c }, include: { student: true } })),
    );
    const user = found.find((u) => u) ?? null;
    if (!user || user.status === 'DISABLED') {
      await this.audit.log({
        action: 'LOGIN_FAIL',
        operatorName: candidates[0] ?? '',
        ip: opts.ip,
        ua: opts.ua,
        detail: { reason: 'cas_user_not_imported', tried: candidates },
      });
      throw new UnauthorizedException(
        `学校认证通过，但该账号未导入本平台（或已停用）。认证返回标识：${candidates.join(' / ')}；平台按 9 位学号匹配，请联系管理员核对`,
      );
    }

    // CAS 已认证学校密码，本地密码不再强制修改；姓名不一致仅审计留痕
    const rt = await this.issueSessionForUser(user, opts.ip, opts.ua);
    await this.audit.log({
      operatorId: user.id,
      operatorName: user.name,
      action: 'LOGIN',
      ip: opts.ip,
      ua: opts.ua,
      detail: {
        via: opts.via,
        casName: userInfo.user_name,
        casUnit: userInfo.unit_name,
        nameMismatch: userInfo.user_name !== user.name || undefined,
      },
    });

    const jwtUser: JwtUser = { ...this.toJwtUser(user), mustChangePwd: false };
    const accessToken = await this.signAccess(jwtUser, rt.familyId);
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
    // 先定位账户，再在事务内获取用户行写锁，随后重新读取令牌。
    // 所有身份变更均先更新同一用户行、再撤销令牌；SQLite 和 MySQL 均可串行化这些写入。
    const owner = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } });
    if (!owner) throw new UnauthorizedException('登录状态无效，请重新登录');
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.user.updateMany({ where: { id: owner.userId, status: { not: 'DISABLED' } }, data: { updatedAt: new Date() } });
      if (!locked.count) return { kind: 'disabled' as const };
      const stored = await tx.refreshToken.findUnique({ where: { tokenHash }, include: { user: { include: { student: true } } } });
      if (!stored || stored.userId !== owner.userId) return { kind: 'invalid' as const };
      if (stored.revokedAt) {
        await tx.refreshToken.updateMany({ where: { familyId: stored.familyId, userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        // 返回而非抛错：确保重用检测的撤销在事务中提交。
        return { kind: 'reused' as const, userId: stored.userId };
      }
      if (stored.expiresAt <= new Date()) return { kind: 'expired' as const };
      const newToken = await this.issueRefresh(tx, stored.userId, opts.ip, opts.ua, stored.familyId);
      await tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date(), replacedById: newToken.id } });
      return { kind: 'ok' as const, newToken, user: stored.user };
    });
    if (outcome.kind === 'reused') {
      await this.audit.log({ action: 'LOGIN_FAIL', operatorId: outcome.userId, detail: { reason: 'refresh_reuse_detected' }, ip: opts.ip });
      throw new UnauthorizedException('检测到令牌重用，全部登录已失效，请重新登录');
    }
    if (outcome.kind !== 'ok') throw new UnauthorizedException(outcome.kind === 'disabled' ? '账号已停用' : outcome.kind === 'expired' ? '登录已过期，请重新登录' : '登录状态无效，请重新登录');
    const { newToken } = outcome;
    const jwtUser = this.toJwtUser(outcome.user);
    const accessToken = await this.signAccess(jwtUser, newToken.familyId);
    return {
      accessToken,
      refreshToken: newToken.raw,
      refreshCookie: `${REFRESH_COOKIE}=${newToken.raw}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${env.refreshTokenTtlSec}${env.isDev ? '' : '; Secure'}`,
      user: jwtUser,
    };
  }

  async logout(refreshToken: string | undefined, userId?: string) {
    if (userId) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({ where: { id: userId }, data: { updatedAt: new Date() } });
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      });
    } else if (refreshToken) {
      // 外部调用若仅给 token，也要与刷新竞争同一个用户锁。
      const owner = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256hex(refreshToken) }, select: { userId: true, familyId: true } });
      if (owner) await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({ where: { id: owner.userId }, data: { updatedAt: new Date() } });
        // 令牌可能在查找与持锁之间被轮换，吊销整个家族才能使新令牌失效。
        await tx.refreshToken.updateMany({ where: { userId: owner.userId, familyId: owner.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      });
    }
    return { success: true };
  }

  // ---------- 改密 ----------

  async changePassword(userId: string, oldPassword: string, newPassword: string, ip: string, sessionFamily: string) {
    if (!sessionFamily) throw new UnauthorizedException('登录状态已失效，请重新登录');
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new BadRequestException('新密码至少 8 位且须包含字母和数字');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { student: true } });
    if (!user) throw new UnauthorizedException();
    if (!user.mustChangePwd) {
      const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
      if (!ok) throw new BadRequestException('原密码错误');
    }
    const hash = await argon2.hash(newPassword);
    const rt = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({ where: { id: userId, passwordHash: user.passwordHash, role: user.role, status: { not: 'DISABLED' } }, data: { passwordHash: hash, mustChangePwd: false } });
      if (!changed.count) throw new UnauthorizedException('账号状态已变更，请重新登录');
      const currentSession = await tx.refreshToken.findFirst({ where: { userId, familyId: sessionFamily, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!currentSession) throw new UnauthorizedException('登录状态已失效，请重新登录');
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return this.issueRefresh(tx, userId, ip, 'password-change');
    });
    await this.audit.log({ operatorId: userId, operatorName: user.name, action: 'CHANGE_PWD', ip });
    const jwtUser = this.toJwtUser({ ...user, mustChangePwd: false } as any);
    return this.loginResponse(jwtUser, await this.signAccess(jwtUser, rt.familyId), rt.raw);
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
      grade: user.role === Role.GRADE_ADMIN ? user.grade ?? null : user.grade ?? user.student?.grade ?? null,
    };
  }

  async signAccess(user: JwtUser, familyId: string): Promise<string> {
    return this.jwt.signAsync({ ...user, sid: familyId }, { secret: env.jwtAccessSecret, expiresIn: env.jwtAccessTtlSec });
  }

  private async issueSessionForUser(user: any, ip: string, ua: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.user.updateMany({ where: { id: user.id, updatedAt: user.updatedAt, passwordHash: user.passwordHash, role: user.role, grade: user.grade ?? null, mustChangePwd: user.mustChangePwd, status: { not: 'DISABLED' } }, data: { updatedAt: new Date(), failedCount: 0, lockedUntil: null } });
      if (!locked.count) throw new UnauthorizedException('账号状态已变更，请重新登录');
      return this.issueRefresh(tx, user.id, ip, ua);
    });
  }

  private async issueRefresh(tx: Prisma.TransactionClient, userId: string, ip: string, ua: string, familyId?: string) {
    const raw = randomBytes(48).toString('base64url');
    const sessionFamily = familyId ?? randomBytes(16).toString('hex');
    const row = await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256hex(raw),
        familyId: sessionFamily,
        expiresAt: new Date(Date.now() + env.refreshTokenTtlSec * 1000),
        ip: ip.slice(0, 64),
        ua: ua.slice(0, 255),
      },
    });
    return { id: row.id, raw, familyId: sessionFamily };
  }
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 定长摘要后常量时间比较（避免长度/时序侧信道） */
function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
