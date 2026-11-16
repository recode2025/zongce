import { ForbiddenException } from '@nestjs/common';
import { Role } from '@zc/shared';
import { JwtUser } from '../decorators';

export interface DataScope {
  /** 班委：强制限定的班级 id */
  forcedClassId?: string;
  /** 管理员：管辖年级 */
  grade?: number | null;
  isSuperAdmin: boolean;
}

/**
 * 服务端数据范围解析（防 IDOR）：班级负责人只能看本班、管理员按年级过滤。
 * 前端传入的 classId 参数对班委无效（一律强制本人班级）。
 */
export function resolveScope(user: JwtUser, requestedClassId?: string): DataScope {
  if (user.role === Role.SUPER_ADMIN) return { isSuperAdmin: true, grade: null };
  if (user.role === Role.CLASS_LEADER) {
    if (!user.classId) throw new ForbiddenException('账号未绑定班级，请联系管理员');
    return { forcedClassId: user.classId, grade: null, isSuperAdmin: false };
  }
  if (user.role === Role.GRADE_ADMIN) {
    if (user.grade == null || !Number.isInteger(user.grade)) throw new ForbiddenException('账号未绑定年级，请联系管理员');
    return { grade: user.grade, isSuperAdmin: false };
  }
  throw new ForbiddenException('无权访问');
}

/** Prisma 学生关联的强制数据范围；不得被用户查询参数覆盖。 */
export function studentScope(user: JwtUser, requestedClassId?: string): { classId?: string; grade?: number } {
  const scope = resolveScope(user);
  const classId = assertClassAllowed(scope, requestedClassId);
  return { ...(classId ? { classId } : {}), ...(scope.grade != null ? { grade: scope.grade } : {}) };
}

export function assertStudentScope(user: JwtUser, student: { classId: string; grade: number }): void {
  const scope = studentScope(user);
  if ((scope.classId && scope.classId !== student.classId) || (scope.grade != null && scope.grade !== student.grade)) {
    throw new ForbiddenException('无权访问该学生的数据');
  }
}

/** 班委访问指定班级数据前的强制校验 */
export function assertClassAllowed(scope: DataScope, classId?: string): string | undefined {
  if (scope.forcedClassId) {
    if (classId && classId !== scope.forcedClassId) throw new ForbiddenException('只能访问本班数据');
    return scope.forcedClassId;
  }
  return classId;
}
