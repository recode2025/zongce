import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.module';
import { Role } from '@zc/shared';

/** JWT 访问令牌守卫：Authorization: Bearer <access>；mustChangePwd 用户仅放行改密相关接口 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}

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
    if (typeof payload.id !== 'string' || typeof payload.sid !== 'string') throw new UnauthorizedException('登录状态无效，请重新登录');
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: payload.id }, include: { student: true } }),
      this.prisma.refreshToken.findFirst({ where: { userId: payload.id, familyId: payload.sid, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }),
    ]);
    if (!user || user.status === 'DISABLED' || !session || payload.role !== user.role) throw new UnauthorizedException('登录状态已失效，请重新登录');
    // 角色范围以数据库当前信息为准，避免班级或年级变动后继续使用旧权限。
    request.user = { ...payload, username: user.username, name: user.name, role: user.role,
      studentId: user.student?.id, classId: user.student?.classId,
      grade: user.role === Role.GRADE_ADMIN ? user.grade : user.grade ?? user.student?.grade ?? null };
    if (payload.mustChangePwd) {
      const pathname = String(request.path ?? request.url ?? '').split('?')[0];
      const allowed = (request.method === 'POST' && ['/api/v1/auth/change-password', '/api/v1/auth/logout'].includes(pathname)) ||
        (request.method === 'GET' && pathname === '/api/v1/auth/me');
      if (!allowed) throw new UnauthorizedException('首次登录请先修改密码');
    }
    return true;
  }
}
