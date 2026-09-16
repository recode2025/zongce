import { BadRequestException, Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsArray, IsObject, IsOptional, IsString } from 'class-validator';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ColumnMappingEntry, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JobService } from '../../queue/job.service';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, Roles } from '../../common/decorators';
import { GRADE_ALIASES, GRADE_TARGETS, STUDENT_ALIASES, STUDENT_TARGETS, suggestMapping } from './column-matcher';
import { parseWorkbook } from './sheet-parser';
import { StudentsImportService } from './students-import.service';
import { GradesImportService } from '../grades/grades-import.service';
import { RegistrationImportService } from './registration-import.service';
import { env } from '../../config/env';

class ConfirmDto {
  @IsString() token: string;
  @IsString() kind: 'STUDENT' | 'GRADE';
  @IsArray() mapping: ColumnMappingEntry[];
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() termKey?: string;
  @IsOptional() @IsObject() options?: Record<string, any>;
}

const UUID_RE = /^[0-9a-f-]{36}$/;

@Controller('imports')
export class ImportsController {
  constructor(
    private prisma: PrismaService,
    private jobs: JobService,
    private audit: AuditService,
    private studentsImport: StudentsImportService,
    private gradesImport: GradesImportService,
    private registrationImport: RegistrationImportService,
  ) {}

  /** 阶段一：上传解析 + 列映射建议（不写库） */
  @Post('preview')
  @Roles(Role.GRADE_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async preview(@UploadedFile() file: Express.Multer.File, @Query('kind') kind: 'STUDENT' | 'GRADE') {
    if (!file) throw new BadRequestException('缺少文件');
    const parsed = parseWorkbook(file.buffer);
    if (parsed.headers.length === 0) throw new BadRequestException('无法识别表格内容');
    const targets = kind === 'STUDENT' ? STUDENT_TARGETS : GRADE_TARGETS;
    const aliases = kind === 'STUDENT' ? STUDENT_ALIASES : GRADE_ALIASES;
    const mapping = suggestMapping(parsed.headers, targets, aliases);
    const missingRequired = mapping.filter((m) => m.required && !m.source).map((m) => m.label);
    if (missingRequired.length) {
      throw new BadRequestException(`表头缺少必填列：${missingRequired.join('、')}（请在文件中确认后重传，或检查表头行位置）`);
    }
    // 暂存文件供 confirm 使用
    const token = randomUUID();
    const dir = path.join(env.tmpDir, 'imports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, token), file.buffer);
    return {
      token,
      kind,
      headers: parsed.headers,
      mapping,
      sampleRows: parsed.rows.slice(0, 5),
      totalRows: parsed.rows.length,
      termKeys: parsed.termKeys ?? [],
      fileName: file.originalname,
    };
  }

  /** 阶段二：确认映射，启动导入任务 */
  @Post('confirm')
  @Roles(Role.GRADE_ADMIN)
  async confirm(@Body() dto: ConfirmDto, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    if (!UUID_RE.test(dto.token)) throw new BadRequestException('无效的导入令牌');
    const filePath = path.join(env.tmpDir, 'imports', dto.token);
    if (!fs.existsSync(filePath)) throw new BadRequestException('导入会话已过期，请重新上传');
    const buffer = fs.readFileSync(filePath);

    if (dto.kind === 'GRADE') {
      if (!dto.batchId) throw new BadRequestException('缺少批次');
      if (!dto.termKey) throw new BadRequestException('缺少学期（文件中含多个学期数据，需选择导入哪个学期）');
    }

    const jobId = await this.jobs.start({
      kind: dto.kind,
      batchId: dto.batchId,
      operatorId,
      fileName: dto.options?.fileName ?? '',
      payload: { token: dto.token, mapping: dto.mapping, termKey: dto.termKey ?? '', options: dto.options ?? {} },
      handler: async (ctx) => {
        const summary =
          dto.kind === 'STUDENT'
            ? await this.studentsImport.run(buffer, dto.mapping, ctx)
            : await this.gradesImport.run(buffer, dto.mapping, dto.batchId!, dto.termKey!, ctx);
        // 用完即删临时文件
        fs.unlink(filePath, () => undefined);
        await this.audit.log({ operatorId, action: 'IMPORT', resourceType: dto.kind.toLowerCase(), detail: { summary: { total: summary.total, inserted: summary.inserted, updated: summary.updated, skipped: summary.skipped } }, ip });
        return summary as object;
      },
    });
    return { jobId };
  }

  /** 综测登记表导入（班级官方模板，固定格式）：表3-表11 逐行转加分申请（SUBMITTED，走初审/复审） */
  @Post('registration')
  @Roles(Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async registration(@UploadedFile() file: Express.Multer.File, @Query('batchId') batchId: string, @CurrentUser('id') operatorId: string, @ClientIp() ip: string) {
    if (!file) throw new BadRequestException('缺少文件');
    if (!batchId) throw new BadRequestException('缺少批次');
    const jobId = await this.jobs.start({
      kind: 'REGISTRATION',
      batchId,
      operatorId,
      fileName: file.originalname,
      payload: {},
      handler: async (ctx) => {
        const summary = await this.registrationImport.run(file.buffer, batchId, ctx);
        await this.audit.log({
          operatorId,
          action: 'IMPORT',
          resourceType: 'registration',
          resourceId: batchId,
          detail: { fileName: file.originalname, total: summary.total, inserted: summary.inserted, skipped: summary.skipped },
          ip,
        });
        return summary as object;
      },
    });
    return { jobId };
  }

  @Get('jobs/:id')
  @Roles(Role.GRADE_ADMIN)
  async job(@Param('id') id: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new BadRequestException('任务不存在');
    return job;
  }

  @Get('jobs')
  @Roles(Role.GRADE_ADMIN)
  async listJobs(@Query('kind') kind?: string, @Query('batchId') batchId?: string) {
    return this.prisma.importJob.findMany({
      where: { kind, batchId: batchId ?? undefined },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}
