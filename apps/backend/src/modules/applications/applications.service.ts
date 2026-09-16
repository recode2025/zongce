import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { AppStatus, BatchStatus, Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtUser } from '../../common/decorators';
import { AuditService } from '../audit/audit.service';

export interface SubmitApplicationDto {
  batchId: string;
  ruleItemId: string;
  title: string;
  level?: string;
  detail: Record<string, any>;
  fileIds?: string[];
}

/** 加分申请：detailSchema 动态校验 + 白名单命中 + 重复申报拦截 + 审核轨迹 */
@Injectable()
export class ApplicationsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async submit(user: JwtUser, dto: SubmitApplicationDto) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) throw new BadRequestException('仅学生账号可提交加分申请');
    if (student.enrollStatus !== 'NORMAL') throw new BadRequestException('当前学籍状态不可申报（休学/无学籍），请联系辅导员');

    const batch = await this.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    if (![BatchStatus.COLLECTING, BatchStatus.FIRST_REVIEW].includes(batch.status as BatchStatus)) {
      throw new BadRequestException('当前批次不在材料收集阶段，无法提交');
    }

    const rule = await this.prisma.ruleItem.findUnique({ where: { id: dto.ruleItemId } });
    if (!rule || !rule.isActive) throw new BadRequestException('加分项不存在或已停用');

    const title = String(dto.title ?? '').trim();
    if (!title) throw new BadRequestException('请填写活动/证书全称');

    // 1. detailSchema 校验 + 归一化
    const detail = this.validateDetail(rule.detailSchema as any[], dto.detail ?? {});
    // 2. 白名单校验（竞赛目录 / 语言证书）
    const wl = await this.checkWhitelist(rule, title, detail);
    // 3. 申报分值：select 选项 score 优先，退回 defaultScore
    const declaredScore = this.computeDeclaredScore(rule.detailSchema as any[], detail, rule.defaultScore as any);
    // 4. 附件归属与必要性校验
    const files = await this.assertFiles(user, dto.fileIds ?? [], rule.evidence as any[]);

    const dedupeKey = this.buildDedupeKey(rule.code, title, detail);

    const existing = await this.prisma.application.findUnique({
      where: { batchId_studentId_ruleItemId_dedupeKey: { batchId: batch.id, studentId: student.id, ruleItemId: rule.id, dedupeKey } },
    });
    if (existing && existing.status !== AppStatus.FIRST_REJECTED && existing.status !== AppStatus.REJECTED) {
      throw new ConflictException('该项目已提交过，请勿重复申报；如需修改请在"我的申请"中查看退回原因后重提');
    }

    const data: any = {
      batchId: batch.id,
      studentId: student.id,
      classId: student.classId,
      ruleItemId: rule.id,
      title,
      level: wl?.level ?? dto.level ?? null,
      occurredTerm: batch.semesterKey,
      detail,
      declaredScore,
      dedupeKey,
      status: AppStatus.SUBMITTED,
    };

    const app = existing
      ? await this.prisma.application.update({
          where: { id: existing.id },
          data: { ...data, supersedesId: existing.id, firstRejectReason: null, rejectReason: null },
        })
      : await this.prisma.application.create({ data });

    if (files.length) {
      const seenFile = new Set<string>();
      await this.prisma.applicationAttachment.createMany({
        data: files.filter((f) => (seenFile.has(f.id) ? false : seenFile.add(f.id))).map((f) => ({ applicationId: app.id, fileId: f.id })),
      });
    }
    await this.prisma.reviewLog.create({
      data: {
        applicationId: app.id,
        action: existing ? 'RESUBMIT' : 'SUBMIT',
        toStatus: AppStatus.SUBMITTED,
        operatorId: user.id,
        operatorName: user.name,
        comment: existing ? '修改后重新提交' : null,
      },
    });
    await this.audit.log({
      operatorId: user.id,
      action: 'APPLICATION_SUBMIT',
      resourceType: 'application',
      resourceId: app.id,
      detail: { ruleCode: rule.code, title, declaredScore, files: files.length, resubmit: !!existing },
    });
    return { ...app, whitelistHit: wl?.name ?? null, attachments: files.map((f) => f.uuid) };
  }

  /** 我的申请（含轨迹与附件） */
  async mine(user: JwtUser, batchId?: string) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return [];
    const rows = await this.prisma.application.findMany({
      where: { studentId: student.id, ...(batchId ? { batchId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        ruleItem: { select: { code: true, name: true, category: true } },
        attachments: { include: { file: { select: { uuid: true, originalName: true, size: true } } } },
        reviewLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
    return rows;
  }

  /** 申请列表（班委本班 / 辅导员全年级 / 超管全量） */
  async list(user: JwtUser, query: { batchId: string; status?: string; classId?: string; ruleCode?: string; page?: number; pageSize?: number; q?: string }) {
    const where: any = { batchId: query.batchId };
    if (user.role === Role.CLASS_LEADER && user.classId) where.classId = user.classId;
    else if (query.classId) where.classId = query.classId;
    if (query.status) where.status = query.status;
    if (query.ruleCode) where.ruleItem = { code: query.ruleCode };
    if (query.q) where.OR = [{ title: { contains: query.q } }, { student: { name: { contains: query.q } } }, { student: { studentNo: { contains: query.q } } }];

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, query.pageSize ?? 20);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.application.count({ where }),
      this.prisma.application.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          student: { select: { studentNo: true, name: true, className: true } },
          ruleItem: { select: { code: true, name: true, category: true } },
          attachments: { include: { file: { select: { uuid: true, originalName: true, ext: true, size: true } } } },
        },
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  /** 详情（含轨迹）；班委/辅导员数据范围校验 */
  async detail(user: JwtUser, id: string) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: {
        student: { select: { id: true, studentNo: true, name: true, classId: true, className: true } },
        ruleItem: true,
        attachments: { include: { file: { select: { uuid: true, originalName: true, ext: true, size: true, id: true } } } },
        reviewLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!app) throw new BadRequestException('申请不存在');
    this.assertScope(user, app.student.id, app.classId);
    return app;
  }

  /** 学生撤回（仅 SUBMITTED 且批次仍在收集期） */
  async withdraw(user: JwtUser, id: string) {
    const app = await this.prisma.application.findUnique({ where: { id }, include: { student: true } });
    if (!app || app.student.userId !== user.id) throw new BadRequestException('申请不存在');
    if (app.status !== AppStatus.SUBMITTED) throw new BadRequestException('仅待初审的申请可撤回');
    const batch = await this.prisma.batch.findUnique({ where: { id: app.batchId } });
    if (batch && batch.status !== BatchStatus.COLLECTING) throw new BadRequestException('批次已进入审核，无法撤回');
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.DRAFT } });
    await this.prisma.reviewLog.create({
      data: { applicationId: id, action: 'WITHDRAW', fromStatus: AppStatus.SUBMITTED, toStatus: AppStatus.DRAFT, operatorId: user.id, operatorName: user.name },
    });
    return { ok: true };
  }

  // ---------- 内部 ----------

  private assertScope(user: JwtUser, studentId: string, classId: string) {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.GRADE_ADMIN) return;
    if (user.role === Role.CLASS_LEADER && user.classId === classId) return;
    throw new BadRequestException('无权访问该申请');
  }

  /** detailSchema 必填校验与字符串清洗 */
  private validateDetail(schema: any[], detail: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const f of schema ?? []) {
      const v = detail?.[f.field];
      const empty = v === undefined || v === null || v === '';
      if (f.required && empty) throw new BadRequestException(`请填写「${f.label}」`);
      if (!empty) out[f.field] = typeof v === 'string' ? v.trim().slice(0, 500) : v;
      else if (v !== undefined) out[f.field] = v;
    }
    return out;
  }

  /** 白名单：竞赛目录模糊命中（返回建议级别）；证书类型合法性 + CET 分数线 */
  private async checkWhitelist(rule: any, title: string, detail: Record<string, any>) {
    if (!rule.whitelistType) return null;
    if (rule.whitelistType.startsWith('COMP')) {
      const types = rule.whitelistType === 'COMPETITION_CATALOG' ? ['COMP_A', 'COMP_B_NATIONAL', 'COMP_B_PROVINCIAL', 'COMP_B_MUNICIPAL'] : [rule.whitelistType];
      const entries = await this.prisma.whitelistEntry.findMany({ where: { type: { in: types } } });
      const norm = (s: string) => s.replace(/[\s·・.。,，、()（）""'']/g, '').toLowerCase();
      const nTitle = norm(title);
      let best: { name: string; level: string; diff: number } | null = null;
      for (const e of entries) {
        const n = norm(e.name as string);
        if (n === nTitle) return { name: e.name as string, level: ((e.extra as any)?.level as string) ?? 'NATIONAL', exact: true };
        const contains = n.includes(nTitle) || nTitle.includes(n);
        if (contains) {
          const diff = Math.abs(n.length - nTitle.length);
          if (!best || diff < best.diff) best = { name: e.name as string, level: ((e.extra as any)?.level as string) ?? 'NATIONAL', diff };
        }
      }
      if (!best) {
        throw new BadRequestException(`「${title}」不在教务处当年度赛事认定目录中，不予加分。请在申报前核对认定目录，或联系辅导员确认`);
      }
      return best;
    }
    if (rule.whitelistType === 'CERT_LANG') {
      const certType = String(detail.certType ?? '');
      const nameMap: Record<string, string> = {
        CET4: '大学英语四级（CET-4）',
        CET6: '大学英语六级（CET-6）',
        JLPT_N2: '日本语能力测试（JLPT）N2',
        JLPT_N1: '日本语能力测试（JLPT）N1',
        TEM4: '英语专业四级（TEM-4）',
        TEM8: '英语专业八级（TEM-8）',
      };
      const name = nameMap[certType];
      if (!name) return null; // VOCATIONAL 等走人工复核
      const entry = await this.prisma.whitelistEntry.findFirst({ where: { type: 'CERT_LANG', name } });
      if (!entry) return null;
      const minScore = (entry.extra as any)?.minScore;
      if (minScore && Number(detail.score ?? 0) < minScore) {
        throw new BadRequestException(`${name}须达到 ${minScore} 分（当前填报 ${detail.score}），不满足加分条件`);
      }
      return { name: entry.name, level: null, exact: true };
    }
    return null;
  }

  /** select 选项携带 score 时作为申报分值；否则用规则默认分 */
  private computeDeclaredScore(schema: any[], detail: Record<string, any>, defaultScore: any): number | null {
    for (const f of schema ?? []) {
      if (f.type !== 'select') continue;
      const opt = (f.options ?? []).find((o: any) => o.value === detail[f.field]);
      if (opt && typeof opt.score === 'number') return opt.score;
    }
    return defaultScore === null || defaultScore === undefined ? null : Number(defaultScore);
  }

  private buildDedupeKey(ruleCode: string, title: string, detail: Record<string, any>) {
    const norm = (s: any) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
    if (detail.certNo) return `CERT:${norm(detail.certNo)}`;
    if (ruleCode === 'ACA_COMPETITION') return `COMP:${norm(detail.competitionName ?? title)}|${norm(detail.rank)}`;
    if (detail.activityName) return `ACT:${norm(detail.activityName)}|${norm(detail.date)}`;
    if (detail.title) return `RES:${norm(detail.title)}`;
    return `T:${norm(title)}`;
  }

  private async assertFiles(user: JwtUser, fileIds: string[], evidence: any[]) {
    if (evidence?.some((e) => e.required) && fileIds.length === 0) {
      throw new BadRequestException('该加分项必须上传佐证材料');
    }
    if (fileIds.length > 20) throw new BadRequestException('单次附件数量过多（≤20）');
    const files = await this.prisma.fileObject.findMany({ where: { id: { in: fileIds } } });
    for (const id of fileIds) {
      const f = files.find((x) => x.id === id);
      if (!f) throw new BadRequestException('附件不存在，请重新上传');
      if (f.uploaderId !== user.id) throw new BadRequestException('附件归属校验失败');
    }
    return files;
  }
}
