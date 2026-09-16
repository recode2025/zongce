import { BadRequestException, Body, Controller, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';

/**
 * 规则字典：读全员（学生端向导渲染来源），写超管。
 * 批次激活时 batches/activate-rules 生成 BatchRule 快照，改字典不影响进行中批次。
 */
@Controller('rules')
export class RulesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** 规则项列表（按类别分组顺序输出，isActive 优先） */
  @Get('items')
  async items(@Query('category') category?: string, @Query('batchId') batchId?: string) {
    // 传 batchId 时合并批次快照 overrides
    let overrides: Record<string, any> = {};
    if (batchId) {
      const snap = await this.prisma.batchRule.findMany({ where: { batchId } });
      overrides = Object.fromEntries(snap.map((s) => [s.ruleItemId, s.overrides]));
    }
    const rows = await this.prisma.ruleItem.findMany({
      where: { isActive: true, ...(category ? { category } : {}) },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    });
    return rows.map((r) => {
      const ov = overrides[r.id] ?? {};
      return {
        ...r,
        defaultScore: ov.defaultScore ?? r.defaultScore,
        caps: { ...(r.caps as object), ...((ov.caps as object) ?? {}) },
        levelScoreMap: ov.levelScoreMap ?? r.levelScoreMap,
        overridden: Object.keys(ov).length > 0,
      };
    });
  }

  /** 白名单查询（向导竞赛搜索 + 证书校验） */
  @Get('whitelists')
  async whitelists(@Query('type') type?: string, @Query('q') q?: string, @Query('year') year?: number, @Query('limit') limit?: string) {
    const rows = await this.prisma.whitelistEntry.findMany({
      where: {
        ...(type ? { type } : { type: { startsWith: 'COMP' } }),
        ...(year ? { year } : {}),
        ...(q ? { name: { contains: q } } : {}),
      },
      orderBy: { name: 'asc' },
      take: Math.min(Number(limit) || 20, 50),
    });
    return rows;
  }

  /** 新增/编辑规则项（超管） */
  @Post('items')
  @Roles(Role.SUPER_ADMIN)
  async createItem(@Body() body: any, @CurrentUser() user: JwtUser) {
    for (const k of ['code', 'category', 'name', 'detailSchema'] as const) {
      if (!body[k]) throw new BadRequestException(`缺少 ${k}`);
    }
    const dup = await this.prisma.ruleItem.findUnique({ where: { code: body.code } });
    if (dup) throw new BadRequestException('规则代码已存在');
    const item = await this.prisma.ruleItem.create({
      data: {
        code: body.code,
        category: body.category,
        name: body.name,
        description: body.description,
        detailSchema: body.detailSchema ?? [],
        defaultScore: body.defaultScore ?? null,
        levelScoreMap: body.levelScoreMap ?? null,
        caps: body.caps ?? {},
        whitelistType: body.whitelistType ?? null,
        evidence: body.evidence ?? [],
        exportSlot: body.exportSlot ?? null,
      },
    });
    await this.audit.log({ operatorId: user.id, action: 'RULE_CREATE', resourceType: 'ruleItem', resourceId: item.id, detail: { code: item.code } });
    return item;
  }

  @Put('items/:id')
  @Roles(Role.SUPER_ADMIN)
  async updateItem(@Param('id') id: string, @Body() body: any, @CurrentUser() user: JwtUser) {
    const before = await this.prisma.ruleItem.findUnique({ where: { id } });
    if (!before) throw new BadRequestException('规则不存在');
    const item = await this.prisma.ruleItem.update({
      where: { id },
      data: {
        name: body.name ?? before.name,
        description: body.description ?? before.description,
        detailSchema: body.detailSchema ?? before.detailSchema,
        defaultScore: body.defaultScore ?? before.defaultScore,
        levelScoreMap: body.levelScoreMap ?? before.levelScoreMap,
        caps: body.caps ?? before.caps,
        whitelistType: body.whitelistType ?? before.whitelistType,
        evidence: body.evidence ?? before.evidence,
        exportSlot: body.exportSlot ?? before.exportSlot,
        isActive: body.isActive ?? before.isActive,
        version: before.version + 1,
      },
    });
    await this.audit.log({
      operatorId: user.id,
      action: 'RULE_UPDATE',
      resourceType: 'ruleItem',
      resourceId: id,
      detail: { code: item.code, before: { defaultScore: before.defaultScore, caps: before.caps, isActive: before.isActive }, after: { defaultScore: item.defaultScore, caps: item.caps, isActive: item.isActive } },
    });
    return item;
  }

  /** 白名单维护（超管）：批量追加 */
  @Post('whitelists')
  @Roles(Role.SUPER_ADMIN)
  async addWhitelist(@Body() body: { type: string; year?: number; names: string[] }, @CurrentUser() user: JwtUser) {
    if (!body?.type || !Array.isArray(body.names)) throw new BadRequestException('参数错误');
    const year = body.year || new Date().getFullYear();
    const existing = await this.prisma.whitelistEntry.findMany({ where: { type: body.type, year }, select: { name: true } });
    const seen = new Set(existing.map((e) => e.name));
    let added = 0;
    for (const name of body.names) {
      const n = String(name).trim();
      if (!n || seen.has(n)) continue;
      await this.prisma.whitelistEntry.create({ data: { type: body.type, name: n.slice(0, 255), year } });
      seen.add(n);
      added++;
    }
    await this.audit.log({ operatorId: user.id, action: 'WHITELIST_ADD', resourceType: 'whitelist', resourceId: body.type, detail: { year, added, total: body.names.length } });
    return { added, skipped: body.names.length - added };
  }

  @Post('whitelists/:id/delete')
  @Roles(Role.SUPER_ADMIN)
  async removeWhitelist(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    const entry = await this.prisma.whitelistEntry.delete({ where: { id } }).catch(() => null);
    if (entry) await this.audit.log({ operatorId: user.id, action: 'WHITELIST_REMOVE', resourceType: 'whitelist', resourceId: id, detail: { name: entry.name } });
    return { ok: true };
  }
}

@Module({
  controllers: [RulesController],
})
export class RulesModule {}
