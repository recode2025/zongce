import { Body, Controller, DefaultValuePipe, Get, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import * as argon2 from 'argon2';
import { Role } from '@zc/shared';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators';

class CreateUserDto {
  @IsString() username: string;
  @IsString() name: string;
  /** 必须加装饰器：全局 ValidationPipe whitelist 会剥离无装饰器属性 */
  @IsString() role: Role;
  @IsOptional() @IsString() password?: string;
  @IsOptional() grade?: number;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() role?: Role;
  @IsOptional() @IsString() password?: string;
  @IsOptional() status?: string;
  @IsOptional() grade?: number;
}

class ResetPwdBatchDto {
  @IsArray() ids: string[];
}

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** 用户列表（ADM） */
  @Get()
  @Roles(Role.SUPER_ADMIN)
  async list(
    @Query('role') role?: string,
    @Query('keyword') keyword?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize = 20,
  ) {
    const where: any = {};
    if (role) where.role = role;
    if (keyword) where.OR = [{ username: { contains: keyword } }, { name: { contains: keyword } }];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: { id: true, username: true, name: true, role: true, status: true, mustChangePwd: true, grade: true, createdAt: true, classLeaderOf: { select: { name: true } } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  async create(@Body() dto: CreateUserDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const hash = await argon2.hash(dto.password ?? 'Zc@' + Math.random().toString(36).slice(2, 10));
    const user = await this.prisma.user.create({
      data: { username: dto.username, name: dto.name, role: dto.role, passwordHash: hash, mustChangePwd: true, grade: dto.grade },
    });
    await this.audit.log({ operatorId, action: 'USER_UPDATE', resourceType: 'user', resourceId: user.id, detail: { action: 'create', role: dto.role }, ip });
    return { id: user.id };
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const data: any = { name: dto.name, role: dto.role, status: dto.status, grade: dto.grade };
    if (dto.password) data.passwordHash = await argon2.hash(dto.password);
    if (dto.password) data.mustChangePwd = true;
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    await this.prisma.user.update({ where: { id }, data });
    await this.audit.log({ operatorId, action: 'USER_UPDATE', resourceType: 'user', resourceId: id, detail: { fields: Object.keys(dto) }, ip });
    return { success: true };
  }

  /** 批量重置密码为初始规则密码（学生账号） */
  @Post('reset-password-batch')
  @Roles(Role.SUPER_ADMIN)
  async resetBatch(@Body() dto: ResetPwdBatchDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const students = await this.prisma.student.findMany({ where: { userId: { in: dto.ids } } });
    for (const s of students) {
      const pwd = initialPassword(s.studentNo);
      await this.prisma.user.update({ where: { id: s.userId! }, data: { passwordHash: await argon2.hash(pwd), mustChangePwd: true, failedCount: 0, lockedUntil: null } });
    }
    await this.audit.log({ operatorId, action: 'USER_UPDATE', detail: { action: 'reset_password_batch', count: students.length }, ip });
    return { count: students.length };
  }

  /** 审计日志（ADM） */
  @Get('audit-logs')
  @Roles(Role.SUPER_ADMIN)
  async auditLogs(
    @Query('action') action?: string,
    @Query('operatorId') operatorId?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(30), ParseIntPipe) pageSize = 30,
  ) {
    const where: any = {};
    if (action) where.action = action;
    if (operatorId) where.operatorId = operatorId;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }
}

export function initialPassword(studentNo: string): string {
  if (env.studentInitPwdMode === 'LITERAL') return env.initialAdminPassword;
  return studentNo.slice(-6); // LAST6
}

@Module({
  controllers: [UsersController],
  providers: [],
})
export class UsersModule {}
