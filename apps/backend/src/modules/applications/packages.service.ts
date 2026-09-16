import { BadRequestException, Injectable } from '@nestjs/common';
import archiver from 'archiver';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { ActivityLevel, LEVEL_PREFIX, NAMING_RULES, PackageSection, PackageStatus, BatchStatus } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtUser } from '../../common/decorators';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../files/storage.service';
import { env } from '../../config/env';

export interface PackageItemDto {
  fileId: string;
  /** 板块一：社会实践 | 志愿服务；板块二：活动/比赛/证书全称（服务端自动加级别前缀） */
  role?: string;
  level?: string;
  /** 覆盖自动命名（一般不用） */
  nameOverride?: string;
}

export interface SubmitPackageDto {
  batchId: string;
  section: PackageSection;
  items: PackageItemDto[];
  meta?: { cadreName?: string; certs?: string };
}

/** 材料包：后端按命名规范字典生成 zip（学生下载与服务端留档同一份），命名报告随包留痕 */
@Injectable()
export class PackagesService {
  constructor(private prisma: PrismaService, private storage: StorageService, private audit: AuditService) {}

  /** 提交材料包：校验归属 → 规范打包 → 留档 → 状态 SUBMITTED */
  async submit(user: JwtUser, dto: SubmitPackageDto) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) throw new BadRequestException('仅学生账号可提交材料包');
    const batch = await this.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new BadRequestException('批次不存在');
    if (![BatchStatus.COLLECTING, BatchStatus.FIRST_REVIEW].includes(batch.status as BatchStatus)) {
      throw new BadRequestException('当前批次不在材料收集阶段');
    }
    if (!dto.items?.length) throw new BadRequestException('请至少上传一份材料');
    if (dto.items.length > 30) throw new BadRequestException('单板块材料数过多（≤30）');

    // 附件归属校验
    const fileIds = dto.items.map((i) => i.fileId);
    const files = await this.prisma.fileObject.findMany({ where: { id: { in: fileIds } } });
    for (const id of fileIds) {
      const f = files.find((x) => x.id === id);
      if (!f || f.uploaderId !== user.id) throw new BadRequestException('存在非本人上传的文件，请重新上传');
      if (f.ext === 'zip' || f.ext === 'rar') throw new BadRequestException('材料包内不允许嵌套压缩包，请上传 PDF/图片原件');
    }

    const { zipName, entries, warnings, meta } = await this.buildNaming(student, dto.section, dto.items, files, dto.meta);

    const buffer = await this.buildZip(entries);
    const saved = await this.storage.saveUpload({
      buffer,
      originalName: `${zipName}.zip`,
      declaredExt: 'zip',
      uploaderId: user.id,
      kind: 'PACKAGE',
    });

    const namingReport = { zipName: `${zipName}.zip`, rule: dto.section === PackageSection.PRACTICE_VOLUNTEER ? NAMING_RULES.practiceVolunteerZip : NAMING_RULES.bonusEvidenceZip, entries: entries.map((e) => ({ entryName: e.entryName, source: e.source })), warnings };

    const pkg = await this.prisma.materialPackage.upsert({
      where: { batchId_studentId_section: { batchId: batch.id, studentId: student.id, section: dto.section } },
      update: {
        status: PackageStatus.SUBMITTED,
        zipFileId: saved.id,
        namingReport: namingReport as any,
        meta: meta as any,
        submittedAt: new Date(),
        firstReviewerId: null,
        firstReviewedAt: null,
        firstRejectReason: null,
      },
      create: {
        batchId: batch.id,
        studentId: student.id,
        section: dto.section,
        status: PackageStatus.SUBMITTED,
        zipFileId: saved.id,
        namingReport: namingReport as any,
        meta: meta as any,
        submittedAt: new Date(),
      },
    });
    await this.audit.log({
      operatorId: user.id,
      action: 'PACKAGE_SUBMIT',
      resourceType: 'materialPackage',
      resourceId: pkg.id,
      detail: { section: dto.section, zip: namingReport.zipName, files: entries.length },
    });
    return { ...pkg, zipFileUuid: saved.uuid, namingReport };
  }

  /** 重新规范打包（初审退回补材料后） */
  async rebuild(user: JwtUser, packageId: string) {
    const pkg = await this.prisma.materialPackage.findUnique({ where: { id: packageId }, include: { student: true } });
    if (!pkg) throw new BadRequestException('材料包不存在');
    if (pkg.student.userId !== user.id) throw new BadRequestException('无权操作他人材料包');
    if (pkg.status === PackageStatus.FIRST_PASSED) throw new BadRequestException('已通过初审的材料包无需重新打包');
    const meta = pkg.meta as any;
    if (!Array.isArray(meta?.items) || meta.items.length === 0) throw new BadRequestException('该材料包没有可重打包的材料记录，请重新提交');
    const dto: SubmitPackageDto = { batchId: pkg.batchId, section: pkg.section as PackageSection, items: meta.items, meta };
    return this.submit(user, dto);
  }

  /** 我的材料包 */
  async mine(user: JwtUser, batchId?: string) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return [];
    return this.prisma.materialPackage.findMany({
      where: { studentId: student.id, ...(batchId ? { batchId } : {}) },
      include: {
        student: { select: { studentNo: true, name: true } },
        zipFile: { select: { uuid: true, originalName: true, size: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** 材料包列表（班委本班 / 辅导员 / 超管） */
  async list(user: JwtUser, query: { batchId: string; section?: string; status?: string; classId?: string; page?: number; pageSize?: number }) {
    const where: any = { batchId: query.batchId };
    if (user.classId && !query.classId) where.student = { classId: user.classId };
    else if (query.classId) where.student = { classId: query.classId };
    if (query.section) where.section = query.section;
    if (query.status) where.status = query.status;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, query.pageSize ?? 20);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.materialPackage.count({ where }),
      this.prisma.materialPackage.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          student: { select: { studentNo: true, name: true, classId: true } },
          zipFile: { select: { uuid: true, originalName: true, size: true } },
        },
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  // ---------- 命名规范 ----------

  private async buildNaming(student: any, section: PackageSection, items: PackageItemDto[], files: any[], metaIn?: { cadreName?: string; certs?: string }) {
    const byId = new Map(files.map((f) => [f.id, f]));
    const warnings: string[] = [];
    const meta: any = { items, cadreName: metaIn?.cadreName ?? '', certs: metaIn?.certs ?? '' };

    if (section === PackageSection.PRACTICE_VOLUNTEER) {
      const practice = items.filter((i) => (i.role ?? '社会实践') === '社会实践');
      const volunteer = items.filter((i) => (i.role ?? '志愿服务') === '志愿服务');
      const entries = [
        ...practice.map((i, idx) => ({ entryName: practice.length > 1 ? `社会实践${idx + 1}.pdf` : '社会实践.pdf', source: byId.get(i.fileId) })),
        ...volunteer.map((i, idx) => ({ entryName: volunteer.length > 1 ? `志愿服务${idx + 1}.pdf` : '志愿服务.pdf', source: byId.get(i.fileId) })),
      ];
      const missing = entries.filter((e) => !e.source);
      if (missing.length) throw new BadRequestException('材料文件缺失，请重新上传');
      // 保留原件格式（pdf/图片），扩展名跟随后缀
      const finalEntries = entries.map((e) => ({ ...e, entryName: e.entryName.replace(/\.pdf$/, `.${e.source!.ext === 'jpeg' ? 'jpg' : e.source!.ext}`) }));
      meta.practiceCount = practice.length;
      meta.volunteerCount = volunteer.length;
      if (practice.length === 0 || volunteer.length === 0) {
        warnings.push(practice.length === 0 ? '未包含社会实践材料' : '未包含志愿服务材料');
      }
      const zipName = fillTemplate(NAMING_RULES.practiceVolunteerZip, {
        studentNo: student.studentNo,
        name: student.name,
        practiceCount: String(practice.length),
        volunteerCount: String(volunteer.length),
      });
      return { zipName, entries: finalEntries, warnings, meta };
    }

    // 板块二：加分证明
    const entries = items.map((i) => {
      const f = byId.get(i.fileId);
      if (!f) throw new BadRequestException('材料文件缺失，请重新上传');
      const base = (i.nameOverride ?? '').trim() || f.originalName.replace(/\.[^.]+$/, '');
      const prefix = i.level && LEVEL_PREFIX[i.level as ActivityLevel] ? LEVEL_PREFIX[i.level as ActivityLevel] : '';
      const ext = f.ext === 'jpeg' ? 'jpg' : f.ext;
      return { entryName: sanitizeEntryName(`${prefix}${base}.${ext}`), source: f };
    });
    const compCount = items.filter((i) => i.level === ActivityLevel.NATIONAL || i.level === ActivityLevel.PROVINCIAL || i.level === ActivityLevel.MUNICIPAL).length;
    meta.bonusCount = String(items.length);
    meta.compCount = String(compCount);
    const certs = (metaIn?.certs ?? '').trim();
    const cadre = (metaIn?.cadreName ?? '').trim();
    if (!certs && !cadre) warnings.push('未填写证书名称/干部名称（如无可忽略）');
    // 无证书/干部时省略尾段，避免 zip 名出现多余空段
    let tpl: string = NAMING_RULES.bonusEvidenceZip;
    if (!certs && !cadre) tpl = tpl.replace(' {certs} {cadre}', '');
    else if (!cadre) tpl = tpl.replace(' {cadre}', '');
    else if (!certs) tpl = tpl.replace(' {certs}', '');
    const zipName = fillTemplate(tpl, {
      studentNo: student.studentNo,
      name: student.name,
      bonusCount: String(items.length),
      compCount: String(compCount),
      certs,
      cadre,
    });
    return { zipName, entries, warnings, meta };
  }

  private async buildZip(entries: { entryName: string; source: any }[]): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    const zip = archiver('zip', { zlib: { level: 6 } });
    const done = new Promise<void>((resolve, reject) => {
      sink.on('finish', () => resolve());
      sink.on('error', reject);
      zip.on('error', reject);
    });
    zip.pipe(sink);
    for (const e of entries) {
      const abs = this.storage.absPath(e.source.storedPath);
      if (!fs.existsSync(abs)) throw new BadRequestException(`源文件已丢失：${e.source.originalName}`);
      zip.append(fs.createReadStream(abs), { name: e.entryName });
    }
    await zip.finalize();
    await done;
    const buffer = Buffer.concat(chunks);
    if (buffer.length > env.maxUploadBytes) throw new BadRequestException('打包后超过大小限制，请压缩图片后重试');
    return buffer;
  }
}

function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString()).replace(/\s+/g, ' ').trim();
}

function sanitizeEntryName(name: string) {
  const cleaned = name.replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '').trim();
  return cleaned.slice(0, 180) || '未命名.pdf';
}
