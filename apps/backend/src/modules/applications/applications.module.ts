import { Body, Controller, Get, Headers, Module, Param, Post, Query } from '@nestjs/common';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { CacheService } from '../../cache/cache.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { idempotencyGuard } from '../../common/utils/rate-limit';
import { ApplicationsService, SubmitApplicationDto } from './applications.service';
import { PackagesService, SubmitPackageDto } from './packages.service';
import { FilesModule } from '../files/files.controller';

@Controller()
export class ApplicationsController {
  constructor(
    private apps: ApplicationsService,
    private packages: PackagesService,
    private cache: CacheService,
    private prisma: PrismaService,
  ) {}

  // ---------- 加分申请（学生） ----------

  @Post('applications')
  @Roles(Role.STUDENT)
  async submit(
    @Body() dto: SubmitApplicationDto,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    await idempotencyGuard(this.cache, `app:${user.id}:${idemKey ?? ''}`);
    return this.apps.submit(user, dto);
  }

  @Get('applications/mine')
  @Roles(Role.STUDENT)
  mine(@CurrentUser() user: JwtUser, @Query('batchId') batchId?: string) {
    return this.apps.mine(user, batchId);
  }

  @Post('applications/:id/withdraw')
  @Roles(Role.STUDENT)
  withdraw(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.apps.withdraw(user, id);
  }

  // ---------- 申请查询（班委/辅导员/超管） ----------

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
  @Roles(Role.STUDENT)
  async submitPackage(
    @Body() dto: SubmitPackageDto,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    await idempotencyGuard(this.cache, `pkg:${user.id}:${idemKey ?? ''}`);
    return this.packages.submit(user, dto);
  }

  @Post('packages/:id/rebuild')
  @Roles(Role.STUDENT)
  rebuild(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.packages.rebuild(user, id);
  }

  @Get('packages/mine')
  @Roles(Role.STUDENT)
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
  providers: [ApplicationsService, PackagesService],
  exports: [ApplicationsService, PackagesService],
})
export class ApplicationsModule {}
