import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@zc/shared';
import { JwtUser, ROLES_KEY } from '../decorators';

/** 角色守卫：@Roles(...) 装饰的接口按角色放行；SUPER_ADMIN 兜底全通 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;
    if (!user) return false;
    if (user.role === Role.SUPER_ADMIN) return true;
    if (!required.includes(user.role)) {
      throw new ForbiddenException('无权访问该资源');
    }
    return true;
  }
}
