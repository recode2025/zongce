import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Role } from '@zc/shared';
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, Public, Roles } from '../../common/decorators';
import { CacheService } from '../../cache/cache.service';
import { env } from '../../config/env';

class LoginDto {
  @IsString() @MinLength(1) username: string;
  @IsString() @MinLength(1) password: string;
  @IsOptional() @IsString() captchaId?: string;
  @IsOptional() @IsString() captchaCode?: string;
  /** 管理员登录前置：密语口令验证令牌（POST /auth/gate 获得） */
  @IsOptional() @IsString() gateToken?: string;
}

class ChangePasswordDto {
  @IsString() oldPassword: string;
  @IsString() @MinLength(8) newPassword: string;
}

class PassphraseDto {
  @IsString() @MinLength(1) passphrase: string;
}

class UpdatePassphraseDto {
  @IsString() @MinLength(4) value: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private cache: CacheService) {}

  /** 图形验证码：返回 svg（前端内联渲染），5 分钟有效、一次性 */
  @Public()
  @Get('captcha')
  async captcha() {
    return this.auth.issueCaptcha();
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // 密语口令门：本地登录（管理员入口）须先通过；学生走 CAS（cas-login / cas/authorize）不受限
    if (!(await this.auth.checkGateToken(dto.gateToken))) {
      throw new UnauthorizedException('密语口令未验证或已过期，请重新验证');
    }
    const ip = req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    const r = await this.auth.login({ ...dto, ip, ua });
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, user: r.user };
  }

  /** 数字大外统一身份认证（CAS）：学号 + 学校密码（代理式，保留作兜底） */
  @Public()
  @Post('cas-login')
  @HttpCode(200)
  async casLogin(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    const r = await this.auth.casLogin({ ...dto, ip, ua });
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, user: r.user };
  }

  // ---------- 登录密语口令（管理员本地登录第一道门） ----------

  /** 校验密语口令 → 签发 10 分钟通行令牌（管理员本地登录须携带） */
  @Public()
  @Post('gate')
  @HttpCode(200)
  async gate(@Body() dto: PassphraseDto, @ClientIp() ip: string) {
    return this.auth.verifyPassphrase(dto.passphrase, ip);
  }

  /** 当前密语（ADM） */
  @Get('passphrase')
  @Roles(Role.SUPER_ADMIN)
  async getPassphrase() {
    return { value: await this.auth.getLoginPassphrase() };
  }

  /** 修改密语（ADM） */
  @Put('passphrase')
  @Roles(Role.SUPER_ADMIN)
  async updatePassphrase(@Body() dto: UpdatePassphraseDto, @CurrentUser() operator: { id: string; name: string }, @ClientIp() ip: string) {
    return this.auth.setLoginPassphrase(dto.value, operator, ip);
  }

  // ---------- 跳转式 CAS（浏览器 302 → 学校登录页 → 回调换会话） ----------

  /**
   * 发起跳转：302 到学校 CAS 登录页（学生入口，无需密语口令）。
   * ru = 前端回调页（校验其 origin ∈ CORS 白名单/本站），state 存缓存以便回调时取回 service 与 ru。
   */
  @Public()
  @Get('cas/authorize')
  async casAuthorize(@Query('ru') ru: string, @Req() req: Request, @Res() res: Response) {
    const ruOk = this.sanitizeRu(ru, req);
    if (!ruOk) return res.status(400).send('回调地址不合法');

    const state = randomBytes(16).toString('hex');
    const browserSecret = randomBytes(32).toString('hex');
    // service 走前端同源（dev 经 vite 代理 / prod 同域 nginx），保证 refresh cookie 落在前端域
    const service = `${new URL(ruOk).origin}/api/v1/auth/cas/callback?state=${state}`;
    await this.cache.set(`cas:state:${state}`, JSON.stringify({ service, ru: ruOk, browserSecret }), 600);
    res.append('Set-Cookie', `zc_cas_${state}=${browserSecret}; Path=/api/v1/auth/cas/callback; HttpOnly; SameSite=Lax; Max-Age=600${env.isDev ? '' : '; Secure'}`);
    return res.redirect(302, `${env.casBase}/login?service=${encodeURIComponent(service)}`);
  }

  /** CAS 回跳：ticket 换用户属性 → 签发会话 → 带 fragment 重定向回前端（token 不进 URL 查询串/服务端日志） */
  @Public()
  @Get('cas/callback')
  async casCallback(@Query('ticket') ticket: string, @Query('state') state: string, @Req() req: Request, @Res() res: Response) {
    const raw = state ? await this.cache.get(`cas:state:${state}`) : null;
    if (!raw) return res.status(400).send('登录状态已过期，请返回登录页重新登录');
    const { service, ru, browserSecret } = JSON.parse(raw) as { service: string; ru: string; browserSecret?: string };
    if (!browserSecret || (req as any).cookies?.[`zc_cas_${state}`] !== browserSecret) return res.status(400).send('登录状态不匹配，请返回登录页重新登录');
    await this.cache.del(`cas:state:${state}`); // state 一次性
    res.append('Set-Cookie', `zc_cas_${state}=; Path=/api/v1/auth/cas/callback; HttpOnly; SameSite=Lax; Max-Age=0${env.isDev ? '' : '; Secure'}`);
    const fail = (msg: string) => this.casRedirect(res, ru, `error=${encodeURIComponent(msg)}`);

    if (!ticket) return fail('学校认证未返回票据，请重新登录');
    const ip = req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    try {
      const r = await this.auth.casTicketLogin({ ticket, service, ip, ua });
      res.append('Set-Cookie', r.refreshCookie);
      const frag = new URLSearchParams({ token: r.accessToken, rt: r.refreshToken, name: r.user.name });
      return this.casRedirect(res, ru, frag.toString());
    } catch (e) {
      return fail(e instanceof Error ? e.message : '学校统一认证失败');
    }
  }

  /**
   * 登出学校 CAS SSO 会话：302 到 CAS /logout 销毁浏览器侧 CASTGC，完成后回 ru（前端登录页）。
   * 前端在「本次会话经 CAS 登录」时退出后跳这里，否则 CAS 侧 SSO 仍有效、再点登录直接免密进入。
   */
  @Public()
  @Get('cas/logout')
  async casLogout(@Query('ru') ru: string, @Req() req: Request, @Res() res: Response) {
    const ruOk = this.sanitizeRu(ru, req);
    if (!ruOk) return res.status(400).send('回调地址不合法');
    return res.redirect(302, `${env.casBase}/logout?service=${encodeURIComponent(ruOk)}`);
  }

  /** ru 只能指向明确配置的前端 origin，不能信任客户端转发头。 */
  private sanitizeRu(ru: string | undefined, req: Request): string | null {
    try {
      const u = new URL(ru ?? '');
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      if (u.username || u.password) return null;
      if (env.corsOrigins.includes(u.origin)) return u.toString();
      return null;
    } catch {
      return null;
    }
  }

  /** 302 到前端页并替换 hash（token 走 URL fragment，不落入查询串） */
  private casRedirect(res: Response, ru: string, fragment: string) {
    return res.redirect(302, `${ru.split('#')[0]}#${fragment}`);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { refreshToken?: string }) {
    const cookieToken = (req as any).cookies?.[REFRESH_COOKIE_NAME()];
    const token = body?.refreshToken || cookieToken;
    if (!token) throw new UnauthorizedException('缺少刷新令牌');
    const ip = req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    const r = await this.auth.refresh({ refreshToken: token, ip, ua });
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser('id') userId: string, @Req() req: Request, @Body() body: { refreshToken?: string }) {
    const cookieToken = (req as any).cookies?.[REFRESH_COOKIE_NAME()];
    return this.auth.logout(body?.refreshToken || cookieToken, userId);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: { id: string; sid: string }, @Body() dto: ChangePasswordDto, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.changePassword(user.id, dto.oldPassword, dto.newPassword, ip, user.sid);
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user };
  }

  @Get('me')
  async me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }
}

function REFRESH_COOKIE_NAME(): string {
  return 'zc_rt';
}
