import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, Public } from '../../common/decorators';

class LoginDto {
  @IsString() @MinLength(1) username: string;
  @IsString() @MinLength(1) password: string;
  @IsOptional() @IsString() captchaId?: string;
  @IsOptional() @IsString() captchaCode?: string;
}

class ChangePasswordDto {
  @IsString() oldPassword: string;
  @IsString() @MinLength(8) newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

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
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    const r = await this.auth.login({ ...dto, ip, ua });
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, user: r.user };
  }

  /** 数字大外统一身份认证（CAS）：学号 + 学校密码 */
  @Public()
  @Post('cas-login')
  @HttpCode(200)
  async casLogin(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    const ua = String(req.headers['user-agent'] ?? '');
    const r = await this.auth.casLogin({ ...dto, ip, ua });
    res.setHeader('Set-Cookie', r.refreshCookie);
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { refreshToken?: string }) {
    const cookieToken = (req as any).cookies?.[REFRESH_COOKIE_NAME()];
    const token = body?.refreshToken || cookieToken;
    if (!token) throw new Error('缺少刷新令牌');
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
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
  async changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto, @ClientIp() ip: string) {
    return this.auth.changePassword(userId, dto.oldPassword, dto.newPassword, ip);
  }

  @Get('me')
  async me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }
}

function REFRESH_COOKIE_NAME(): string {
  return 'zc_rt';
}
