import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators';
import { env } from '../../config/env';

/** JWT 访问令牌守卫：Authorization: Bearer <access>；mustChangePwd 用户仅放行改密相关接口 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const auth: string = request.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new UnauthorizedException('未登录');
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: env.jwtAccessSecret });
    } catch {
      throw new UnauthorizedException('登录已过期，请刷新或重新登录');
    }
    request.user = payload;
    if (payload.mustChangePwd) {
      const url: string = request.url ?? '';
      const allowed = url.includes('/auth/change-password') || url.includes('/auth/logout') || url.includes('/auth/me');
      if (!allowed) throw new UnauthorizedException('首次登录请先修改密码');
    }
    return true;
  }
}
