import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { IssueResolution, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators';
import { GradesImportService } from './grades-import.service';

class ResolveDto {
  /** 必须加装饰器：全局 ValidationPipe whitelist 会剥离无装饰器属性（否则裁决结果静默丢失） */
  @IsString() resolution: IssueResolution; // MANUAL_PICKED / EXCLUDED / INCLUDED / PENDING
  @IsOptional() @IsString() pickedGradeId?: string;
  @IsOptional() @IsString() note?: string;
}

class BatchResolveDto {
  @IsString() batchId!: string;
  @IsString() resolution!: 'INCLUDED' | 'EXCLUDED';
  /** 指定记录 id 列表；缺省时按 type（再缺省为全部门禁类）批量 */
  @IsOptional() @IsArray() ids?: string[];
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() note?: string;
}

@Controller('grades')
export class GradesController {
  constructor(private prisma: PrismaService, private audit: AuditService, private gradesImport: GradesImportService) {}

  /** 异常数据面板 */
  @Get('issues')
  @Roles(Role.GRADE_ADMIN)
  async issues(
    @Query('batchId') batchId: string,
    @Query('type') type?: string,
    @Query('resolution') resolution?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize = 20,
  ) {
    if (!batchId) throw new BadRequestException('缺少批次');
    const where: any = { batchId };
    if (type) where.issueType = type;
    if (resolution) where.resolution = resolution;
    const [items, total, typeCounts] = await this.prisma.$transaction([
      this.prisma.gradeIssue.findMany({
        where,
        include: {
          student: { select: { studentNo: true, name: true, className: true } },
          courseGrade: true,
        },
        orderBy: [{ resolution: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.gradeIssue.count({ where }),
      this.prisma.gradeIssue.groupBy({ by: ['issueType', 'resolution'], where: { batchId }, orderBy: { issueType: 'asc' }, _count: { _all: true } }),
    ]);
    return { items, total, typeCounts };
  }

  /** 某门课多行成绩（RESIT_DUP 裁决时查看可选行） */
  @Get('issues/:id/lines')
  @Roles(Role.GRADE_ADMIN)
  async issueLines(@Param('id') id: string) {
    const issue = await this.prisma.gradeIssue.findUnique({ where: { id }, include: { courseGrade: true } });
    if (!issue || !issue.courseGrade) return [];
    const g = issue.courseGrade;
    return this.prisma.courseGrade.findMany({
      where: { studentId: g.studentId, termKey: g.termKey, courseCode: g.courseCode },
      orderBy: [{ examType: 'asc' }, { rowNo: 'asc' }],
    });
  }

  /** 人工裁决 */
  @Patch('issues/:id/resolve')
  @Roles(Role.GRADE_ADMIN)
  async resolve(@Param('id') id: string, @Body() dto: ResolveDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    const issue = await this.prisma.gradeIssue.findUnique({ where: { id } });
    if (!issue) throw new BadRequestException('异常记录不存在');
    await this.prisma.gradeIssue.update({
      where: { id },
      data: {
        resolution: dto.resolution,
        pickedGradeId: dto.pickedGradeId ?? null,
        resolvedBy: operatorId,
        resolvedAt: new Date(),
        note: dto.note?.slice(0, 500),
      },
    });
    await this.audit.log({
      operatorId,
      action: 'GRADE_RESOLVE',
      resourceType: 'gradeIssue',
      resourceId: id,
      detail: { resolution: dto.resolution, pickedGradeId: dto.pickedGradeId, type: issue.issueType },
      ip,
    });
    return { success: true };
  }

  /** 批量裁决：按勾选 ids，或按类型（缺省=门禁类 MISSING/DEFERRED_EMPTY/DISQUALIFIED/NON_NUMERIC_SCORE）作用于全部待裁决 */
  @Post('issues/batch-resolve')
  @Roles(Role.GRADE_ADMIN)
  async batchResolve(@Body() dto: BatchResolveDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    if (dto.resolution !== 'INCLUDED' && dto.resolution !== 'EXCLUDED') throw new BadRequestException('批量裁决仅支持 计入/剔除');
    const where: any = { batchId: dto.batchId, resolution: 'PENDING' };
    if (dto.ids?.length) where.id = { in: dto.ids };
    else if (dto.type) where.issueType = dto.type;
    else where.issueType = { in: ['MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE'] };

    const { count } = await this.prisma.gradeIssue.updateMany({
      where,
      data: { resolution: dto.resolution, resolvedBy: operatorId, resolvedAt: new Date(), note: dto.note?.slice(0, 500) ?? '批量裁决' },
    });
    await this.audit.log({
      operatorId,
      action: 'GRADE_RESOLVE',
      resourceType: 'gradeIssue',
      resourceId: dto.batchId,
      detail: { batch: true, resolution: dto.resolution, scope: dto.ids?.length ? { ids: dto.ids.length } : { type: dto.type ?? 'GATE_TYPES' }, count },
      ip,
    });
    return { count };
  }

  /** 学生成绩明细 */
  @Get('students/:studentId')
  @Roles(Role.GRADE_ADMIN, Role.CLASS_LEADER)
  async studentGrades(@Param('studentId') studentId: string, @Query('batchId') batchId: string, @Query('term') term?: string) {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    const rows = await this.prisma.courseGrade.findMany({
      where: { studentId, termKey: term ?? batch.semesterKey },
      orderBy: [{ courseCode: 'asc' }, { rowNo: 'asc' }],
    });
    const picks = await this.prisma.gradeIssue.findMany({
      where: { studentId, batchId, resolution: { in: ['MANUAL_PICKED'] }, pickedGradeId: { not: null } },
      select: { pickedGradeId: true },
    });
    const pickedSet = new Set(picks.map((p) => p.pickedGradeId));
    return rows.map((r) => ({ ...r, picked: pickedSet.has(r.id) }));
  }
}

@Module({
  controllers: [GradesController],
  providers: [GradesImportService],
  exports: [GradesImportService],
})
export class GradesModule {}
