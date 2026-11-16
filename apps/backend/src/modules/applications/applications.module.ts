import { Body, Controller, ForbiddenException, Get, Headers, Module, Param, Post, Query } from '@nestjs/common';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { idempotencyGuard, rateLimit } from '../../common/utils/rate-limit';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AiDraftService } from './ai-draft.service';
import { AiEvidenceService } from './ai-evidence.service';
import { ApplicationsService, SubmitApplicationDto } from './applications.service';
import { PackagesService, SubmitPackageDto } from './packages.service';
import { FilesModule } from '../files/files.controller';

class AiDraftDto {
  @IsString() @Length(1, 100) ruleItemId: string;
  @IsString() @Length(1, 3000) text: string;
}

class AiEvidenceDto {
  @IsString() @Length(1, 100) ruleItemId: string;
  @IsOptional() @IsString() @MaxLength(3000) text?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsString({ each: true }) @Length(1, 100, { each: true }) fileIds: string[];
}

@Controller()
export class ApplicationsController {
  constructor(
    private apps: ApplicationsService,
    private packages: PackagesService,
    private cache: CacheService,
    private prisma: PrismaService,
    private aiDraft: AiDraftService,
    private aiEvidence: AiEvidenceService,
  ) {}

  // ---------- 加分申请（学生） ----------

  @Post('applications/ai-draft')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  async draft(@Body() dto: AiDraftDto, @CurrentUser() user: JwtUser) {
    // 通用角色守卫允许超管兜底；此计费接口仅允许学生及班级负责人使用。
    if (user.role !== Role.STUDENT && user.role !== Role.CLASS_LEADER) throw new ForbiddenException('仅学生可使用 AI 辅助填写');
    await rateLimit(this.cache, { scope: 'ai-draft', id: user.id, limit: 10, windowSec: 60 });
    return this.aiDraft.generate(dto.ruleItemId, dto.text, user.id);
  }

  @Post('applications/ai-evidence')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  async evidenceDraft(@Body() dto: AiEvidenceDto, @CurrentUser() user: JwtUser) {
    if (user.role !== Role.STUDENT && user.role !== Role.CLASS_LEADER) throw new ForbiddenException('仅学生可使用 AI 辅助填写');
    await rateLimit(this.cache, { scope: 'ai-draft', id: user.id, limit: 10, windowSec: 60 });
    return this.aiEvidence.generate(dto.ruleItemId, dto.text ?? '', dto.fileIds, user.id);
  }

  @Post('applications')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  async submit(
    @Body() dto: SubmitApplicationDto,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (idemKey) await idempotencyGuard(this.cache, `app:${user.id}:${idemKey}`);
    return this.apps.submit(user, dto);
  }

  @Get('applications/mine')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  mine(@CurrentUser() user: JwtUser, @Query('batchId') batchId?: string) {
    return this.apps.mine(user, batchId);
  }

  @Post('applications/:id/withdraw')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  withdraw(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.apps.withdraw(user, id);
  }

  // ---------- 申请查询（班委/管理员/超管） ----------

  @Get('applications')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  list(@CurrentUser() user: JwtUser, @Query() q: any) {
    if (!q.batchId) return { total: 0, page: 1, pageSize: 20, rows: [] };
    return this.apps.list(user, q);
  }

  @Get('applications/:id')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.apps.detail(user, id);
  }

  // ---------- 材料包（学生） ----------

  @Post('packages/submit')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  async submitPackage(
    @Body() dto: SubmitPackageDto,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (idemKey) await idempotencyGuard(this.cache, `pkg:${user.id}:${idemKey}`);
    return this.packages.submit(user, dto);
  }

  @Post('packages/:id/rebuild')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  rebuild(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.packages.rebuild(user, id);
  }

  @Get('packages/mine')
  @Roles(Role.STUDENT, Role.CLASS_LEADER)
  myPackages(@CurrentUser() user: JwtUser, @Query('batchId') batchId?: string) {
    return this.packages.mine(user, batchId);
  }

  @Get('packages')
  @Roles(Role.CLASS_LEADER, Role.GRADE_ADMIN, Role.SUPER_ADMIN)
  listPackages(@CurrentUser() user: JwtUser, @Query() q: any) {
    if (!q.batchId) return { total: 0, page: 1, pageSize: 20, rows: [] };
    return this.packages.list(user, q);
  }
}

@Module({
  imports: [FilesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, PackagesService, AiDraftService, AiEvidenceService],
  exports: [ApplicationsService, PackagesService],
})
export class ApplicationsModule {}
