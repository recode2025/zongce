import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@zc/shared';

export interface JwtUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  mustChangePwd: boolean;
  studentId?: string;
  classId?: string;
  grade?: number | null;
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((data: keyof JwtUser | undefined, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const user = request.user as JwtUser | undefined;
  return data ? user?.[data] : user;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip ?? 'unknown';
});
