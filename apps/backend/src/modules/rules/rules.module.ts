import { BadRequestException, Body, Controller, Get, Module, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as XLSX from 'xlsx';
import { ApplyType, AppStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { parseWorkbook } from '../imports/sheet-parser';
import { studentScope } from '../../common/utils/scope';

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
        applyType: body.applyType === ApplyType.UNIFIED ? ApplyType.UNIFIED : ApplyType.SELF,
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
        applyType: body.applyType === ApplyType.UNIFIED || body.applyType === ApplyType.SELF ? body.applyType : before.applyType,
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

  // ---------- 统一加分：模板下载 + 名单导入（学号 → 分值） ----------

  /** 下载统一加分导入模板（xlsx：学号 / 姓名 / 分值） */
  @Get('items/:id/unified-template')
  @Roles(Role.GRADE_ADMIN)
  async unifiedTemplate(@Param('id') id: string, @Res() res: Response) {
    const rule = await this.prisma.ruleItem.findUnique({ where: { id } });
    if (!rule) throw new BadRequestException('规则不存在');
    const ws = XLSX.utils.aoa_to_sheet([
      ['学号', '姓名', '分值'],
      ['230450604', '张三', 1],
      ['230450605', '李四', 0.5],
    ]);
    ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '统一加分');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${rule.name}-统一加分模板.xlsx`)}`);
    res.send(buf);
  }

  /**
   * 统一加分名单导入：按模板（学号/姓名/分值）批量写入「已认定」申请。
   * 幂等：同一学生同一加分项重复导入按覆盖更新；该生已有个人申报记录则跳过并提示。
   */
  @Post('items/:id/unified-import')
  @Roles(Role.GRADE_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async unifiedImport(
    @UploadedFile() file: Express.Multer.File,
    @Param('id') id: string,
    @Query('batchId') batchId: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string,
  ) {
    if (!file) throw new BadRequestException('缺少文件');
    if (!batchId) throw new BadRequestException('缺少批次');
    const rule = await this.prisma.ruleItem.findUnique({ where: { id } });
    if (!rule) throw new BadRequestException('规则不存在');
    if (rule.applyType !== ApplyType.UNIFIED) {
      throw new BadRequestException(`「${rule.name}」不是统一加分项；请先在规则字典中将其申报方式改为「统一加分」`);
    }
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BadRequestException('批次不存在');

    const parsed = parseWorkbook(file.buffer);
    const colOf = (re: RegExp) => parsed.headers.findIndex((h) => re.test(String(h).replace(/\s+/g, '')));
    const noIdx = colOf(/学号|考生号/);
    const scoreIdx = colOf(/分值|分数|加分|成绩/);
    if (noIdx < 0 || scoreIdx < 0) throw new BadRequestException('表头缺少「学号」或「分值」列（支持 xlsx/xls/csv）');

    const rows = parsed.rows
      .map((r) => ({ studentNo: String(r[parsed.headers[noIdx]] ?? '').trim(), score: Number(r[parsed.headers[scoreIdx]]) }))
      .filter((r) => r.studentNo);
    if (!rows.length) throw new BadRequestException('没有可导入的数据行');
    const bad = rows.filter((r) => !Number.isFinite(r.score) || r.score < 0 || r.score > 100);
    if (bad.length) throw new BadRequestException(`有 ${bad.length} 行分值无效（须为 0-100 的数字），如：${bad.slice(0, 3).map((b) => b.studentNo).join('、')}`);

    const scope = studentScope(user);
    const students = await this.prisma.student.findMany({ where: { studentNo: { in: rows.map((r) => r.studentNo) }, ...scope } });
    const byNo = new Map(students.map((s) => [s.studentNo, s]));

    const dedupeKey = 'UNIFIED';
    let created = 0;
    let updated = 0;
    const unknownStudentNos: string[] = [];
    const conflicts: { studentNo: string; status: string; title: string }[] = [];
    for (const r of rows) {
      const stu = byNo.get(r.studentNo);
      if (!stu) {
        unknownStudentNos.push(r.studentNo);
        continue;
      }
      // 已有个人申报（dedupeKey 非 UNIFIED）→ 跳过避免重复计分
      const self = await this.prisma.application.findFirst({
        where: { batchId: batch.id, studentId: stu.id, ruleItemId: rule.id, NOT: { dedupeKey } },
      });
      if (self) {
        conflicts.push({ studentNo: r.studentNo, status: self.status, title: self.title });
        continue;
      }
      const existed = await this.prisma.application.findUnique({
        where: { batchId_studentId_ruleItemId_dedupeKey: { batchId: batch.id, studentId: stu.id, ruleItemId: rule.id, dedupeKey } },
      });
      const data = {
        title: rule.name,
        level: null,
        occurredTerm: batch.semesterKey,
        detail: {},
        declaredScore: r.score,
        grantedScore: r.score,
        status: AppStatus.APPROVED,
        reviewerId: user.id,
        reviewedAt: new Date(),
      };
      const app = existed
        ? await this.prisma.application.update({ where: { id: existed.id }, data: { ...data, rejectReason: null, firstRejectReason: null } })
        : await this.prisma.application.create({
            data: { ...data, batchId: batch.id, studentId: stu.id, classId: stu.classId, ruleItemId: rule.id, dedupeKey },
          });
      await this.prisma.reviewLog.create({
        data: {
          applicationId: app.id,
          action: 'APPROVE',
          toStatus: AppStatus.APPROVED,
          operatorId: user.id,
          operatorName: user.name,
          comment: existed ? `统一加分导入（覆盖更新：${r.score} 分）` : `统一加分导入（${r.score} 分）`,
        },
      });
      existed ? updated++ : created++;
    }

    const summary = {
      rule: { id: rule.id, name: rule.name },
      total: rows.length,
      created,
      updated,
      skipped: unknownStudentNos.length + conflicts.length,
      unknownStudentNos,
      conflicts,
    };
    await this.audit.log({
      operatorId: user.id,
      operatorName: user.name,
      action: 'IMPORT',
      resourceType: 'unifiedBonus',
      resourceId: rule.id,
      detail: { batchId: batch.id, ...summary, conflicts: undefined, unknownStudentNos: unknownStudentNos.slice(0, 20) },
      ip,
    });
    return summary;
  }
}

@Module({
  controllers: [RulesController],
})
export class RulesModule {}
