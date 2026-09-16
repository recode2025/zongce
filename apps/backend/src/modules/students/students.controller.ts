import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { EnrollStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators';
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
    @Query('grade') grade?: string,
    @Query('classId') classId?: string,
    @Query('enrollStatus') enrollStatus?: string,
    @Query('keyword') keyword?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(30), ParseIntPipe) pageSize = 30,
  ) {
    const where: any = {};
    if (grade) where.grade = Number(grade);
    if (classId) where.classId = classId;
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
  async patch(@Param('id') id: string, @Body() dto: PatchStudentDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const data: any = {};
    if (dto.enrollStatus) data.enrollStatus = dto.enrollStatus;
    if (dto.name) data.name = dto.name.slice(0, 64);
    if (Object.keys(data).length === 0) throw new BadRequestException('无更新内容');
    await this.prisma.student.update({ where: { id }, data });
    // 学籍状态变化 → 重建学籍异常队列
    if (dto.enrollStatus) await this.studentsImport.rebuildSuspensionIssues();
    await this.audit.log({ operatorId, action: 'STUDENT_UPDATE', resourceType: 'student', resourceId: id, detail: { fields: Object.keys(dto) }, ip });
    return { success: true };
  }

  @Get('classes')
  async classes(@Query('grade') grade?: string) {
    const where = grade ? { grade: Number(grade) } : undefined;
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
  async bindLeader(@Param('id') id: string, @Body() body: { userId?: string; studentNo?: string }, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    let userId = body.userId;
    if (!userId && body.studentNo) {
      const stu = await this.prisma.student.findUnique({ where: { studentNo: body.studentNo }, include: { clazz: true } });
      if (!stu?.userId) throw new BadRequestException('该学生没有登录账号');
      if (stu.clazz && stu.clazz.id !== id) throw new BadRequestException('该学生不属于本班');
      userId = stu.userId;
    }
    if (!userId) throw new BadRequestException('缺少 userId 或 studentNo');
    // 该用户升级为班委角色
    await this.prisma.user.update({ where: { id: userId }, data: { role: Role.CLASS_LEADER } });
    await this.prisma.clazz.update({ where: { id }, data: { leaderId: userId } });
    await this.audit.log({ operatorId, action: 'USER_UPDATE', resourceType: 'class', resourceId: id, detail: { leaderUserId: userId }, ip });
    return { success: true };
  }
}

@Module({
  controllers: [StudentsController],
  providers: [StudentsImportService],
  exports: [StudentsImportService],
})
export class StudentsModule {}
