import { BadRequestException, Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { CalcService } from './calc.service';

@Controller('calc')
export class CalcController {
  constructor(private calc: CalcService, private prisma: PrismaService) {}

  /** 发起计算（dryRun=true 试算不落版，返回差异报告任务） */
  @Post('run')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  async run(@Body() dto: { batchId: string; dryRun?: boolean }, @CurrentUser() user: JwtUser) {
    if (!dto?.batchId) throw new BadRequestException('缺少 batchId');
    const jobId = await this.calc.startRun(user, dto.batchId, !!dto.dryRun);
    return { jobId };
  }

  @Get('versions')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  versions(@Query('batchId') batchId: string) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    return this.calc.versions(batchId);
  }

  @Get('results')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  results(@CurrentUser() user: JwtUser, @Query() q: any) {
    if (!q.batchId) throw new BadRequestException('缺少 batchId');
    return this.calc.results(user, q);
  }

  /** 单生结果明细（breakdown 可解释） */
  @Get('results/:studentId')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN, Role.CLASS_LEADER)
  async resultDetail(@Query('batchId') batchId: string, @Query('version') version: string, @Param('studentId') studentId: string, @CurrentUser() user: JwtUser) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    const row = await this.prisma.calcResult.findFirst({
      where: { batchId, studentId, ...(version ? { version: Number(version) } : { status: 'CANDIDATE' }) },
      include: { student: { select: { studentNo: true, name: true, className: true, classId: true } } },
    });
    if (!row) throw new BadRequestException('无计算结果');
    if (user.role === Role.CLASS_LEADER && row.student.classId !== user.classId) throw new BadRequestException('无权查看非本班学生');
    return row;
  }
}

@Module({
  controllers: [CalcController],
  providers: [CalcService],
  exports: [CalcService],
})
export class CalcModule {}
