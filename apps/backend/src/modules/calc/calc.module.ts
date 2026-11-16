import { BadRequestException, Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { CalcService } from './calc.service';
import { assertStudentScope } from '../../common/utils/scope';

@Controller('calc')
export class CalcController {
  constructor(private calc: CalcService, private prisma: PrismaService) {}

  /** 发起计算（dryRun=true 试算不落版，返回差异报告任务） */
  @Post('run')
  @Roles(Role.SUPER_ADMIN)
  async run(@Body() dto: { batchId: string; dryRun?: boolean }, @CurrentUser() user: JwtUser) {
    if (!dto?.batchId) throw new BadRequestException('缺少 batchId');
    const jobId = await this.calc.startRun(user, dto.batchId, !!dto.dryRun);
    return { jobId };
  }

  @Get('versions')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  versions(@Query('batchId') batchId: string, @CurrentUser() user: JwtUser) {
    if (!batchId) throw new BadRequestException('缺少 batchId');
    return this.calc.versions(batchId, user);
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
      include: { student: { select: { studentNo: true, name: true, className: true, classId: true, grade: true } } },
    });
    if (!row) throw new BadRequestException('无计算结果');
    assertStudentScope(user, row.student);
    return row;
  }
}

@Module({
  controllers: [CalcController],
  providers: [CalcService],
  exports: [CalcService],
})
export class CalcModule {}
