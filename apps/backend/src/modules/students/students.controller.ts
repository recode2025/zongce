import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { EnrollStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { assertStudentScope, studentScope } from '../../common/utils/scope';
import { StudentsImportService } from '../imports/students-import.service';

class PatchStudentDto {
  @IsOptional() enrollStatus?: EnrollStatus;
  @IsOptional() @IsString() name?: string;
}

@Controller('students')
export class StudentsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private studentsImport: StudentsImportService) {}

  @Get()
  @Roles(Role.GRADE_ADMIN, Role.CLASS_LEADER)
  async list(
    @CurrentUser() user: JwtUser,
    @Query('grade') grade?: string,
    @Query('classId') classId?: string,
    @Query('enrollStatus') enrollStatus?: string,
    @Query('keyword') keyword?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(30), ParseIntPipe) pageSize = 30,
  ) {
    const where: any = studentScope(user, classId);
    if (grade && where.grade == null) where.grade = Number(grade);
    if (enrollStatus) where.enrollStatus = enrollStatus;
    if (keyword) where.OR = [{ studentNo: { contains: keyword } }, { name: { contains: keyword } }];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        select: {
          id: true, studentNo: true, name: true, gender: true, className: true, classId: true,
          major: true, grade: true, enrollStatus: true, enrollRaw: true, user: { select: { username: true, status: true, mustChangePwd: true } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ className: 'asc' }, { studentNo: 'asc' }],
      }),
      this.prisma.student.count({ where }),
    ]);
    return { items, total };
  }

  @Patch(':id')
  @Roles(Role.GRADE_ADMIN)
  async patch(@Param('id') id: string, @Body() dto: PatchStudentDto, @CurrentUser() user: JwtUser, @ClientIp() ip: string) {
    const data: any = {};
    if (dto.enrollStatus) data.enrollStatus = dto.enrollStatus;
    if (dto.name) data.name = dto.name.slice(0, 64);
    if (Object.keys(data).length === 0) throw new BadRequestException('无更新内容');
    const scope = studentScope(user);
    const result = await this.prisma.student.updateMany({ where: { id, ...scope }, data });
    if (!result.count) throw new BadRequestException('学生不存在或无权修改');
    // 学籍状态变化 → 重建学籍异常队列
    if (dto.enrollStatus) await this.studentsImport.rebuildSuspensionIssues(scope.grade);
    await this.audit.log({ operatorId: user.id, action: 'STUDENT_UPDATE', resourceType: 'student', resourceId: id, detail: { fields: Object.keys(dto) }, ip });
    return { success: true };
  }

  @Get('classes')
  @Roles(Role.GRADE_ADMIN, Role.CLASS_LEADER)
  async classes(@Query('grade') grade: string | undefined, @CurrentUser() user: JwtUser) {
    const scope = studentScope(user);
    const where = { ...(scope.classId ? { id: scope.classId } : {}), ...(scope.grade != null ? { grade: scope.grade } : grade ? { grade: Number(grade) } : {}) };
    const items = await this.prisma.clazz.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { leader: { select: { id: true, name: true, username: true } }, _count: { select: { students: true } } },
    });
    return items.map((c) => ({ ...c, studentCount: c._count.students, leaderInfo: c.leader }));
  }

  /** 绑定班级负责人（班委账号） */
  @Post('classes/:id/leader')
  @Roles(Role.GRADE_ADMIN)
  async bindLeader(@Param('id') id: string, @Body() body: { userId?: string; studentNo?: string }, @CurrentUser() user: JwtUser, @ClientIp() ip: string) {
    const scope = studentScope(user);
    const clazz = await this.prisma.clazz.findFirst({ where: { id, ...(scope.grade != null ? { grade: scope.grade } : {}) } });
    if (!clazz) throw new BadRequestException('班级不存在或无权修改');
    if (!body.userId && !body.studentNo) throw new BadRequestException('缺少 userId 或 studentNo');
    const stu = await this.prisma.student.findFirst({ where: { classId: id, ...(body.userId ? { userId: body.userId } : { studentNo: body.studentNo }) }, include: { user: true } });
    if (!stu?.userId || !stu.user || ![Role.STUDENT, Role.CLASS_LEADER].includes(stu.user.role as Role)) throw new BadRequestException('该学生不属于本班或没有有效的学生账号');
    assertStudentScope(user, stu);
    const userId = stu.userId;
    await this.prisma.$transaction(async (tx) => {
      // 换届时旧班委不应保留本班管理权限。
      if (clazz.leaderId && clazz.leaderId !== userId) {
        await tx.user.updateMany({ where: { id: clazz.leaderId, role: Role.CLASS_LEADER }, data: { role: Role.STUDENT } });
      }
      await tx.user.update({ where: { id: userId }, data: { role: Role.CLASS_LEADER } });
      await tx.clazz.update({ where: { id }, data: { leaderId: userId } });
    });
    await this.audit.log({ operatorId: user.id, action: 'USER_UPDATE', resourceType: 'class', resourceId: id, detail: { leaderUserId: userId }, ip });
    return { success: true };
  }
}

@Module({
  controllers: [StudentsController],
  providers: [StudentsImportService],
  exports: [StudentsImportService],
})
export class StudentsModule {}
