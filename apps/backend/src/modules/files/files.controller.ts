import { BadRequestException, Controller, Get, Module, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'node:fs';
import { Role } from '@zc/shared';
import { PrismaService } from '../../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtUser, Roles } from '../../common/decorators';
import { StorageService } from './storage.service';
import { ZipService } from './zip.service';
import { env } from '../../config/env';

const UPLOAD_LIMITS = { fileSize: env.maxUploadBytes };

@Controller('files')
export class FilesController {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private zip: ZipService,
    private audit: AuditService,
  ) {}

  /** 单文件上传（学生端向导附件 / 材料扫描件） */
  @Post('upload')
  @Roles(Role.STUDENT, Role.GRADE_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtUser, @Query('kind') kind?: string) {
    if (!file) throw new BadRequestException('缺少文件');
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    const saved = await this.storage.saveUpload({
      buffer: file.buffer,
      originalName: file.originalname,
      declaredExt: ext,
      uploaderId: user.id,
      kind: kind === 'zip' ? 'ZIP' : 'FILE',
    });
    // zip 上传后立即建目录树（同时完成炸弹预检）
    let zipTree: unknown = null;
    if (saved.ext === 'zip') {
      zipTree = await this.zip.indexZip(saved.id);
    }
    await this.audit.log({ operatorId: user.id, action: 'FILE_UPLOAD', resourceType: 'file', resourceId: saved.id, detail: { ext: saved.ext, size: saved.size } });
    return { ...saved, zipTree };
  }

  /** 文件下载（鉴权 + 归属校验） */
  @Get(':uuid/download')
  async download(@Param('uuid') uuid: string, @CurrentUser() user: JwtUser, @Res({ passthrough: true }) res: Response) {
    const file = await this.storage.findByUuid(uuid);
    if (!file) throw new BadRequestException('文件不存在');
    await this.assertAccess(user, file.uploaderId, file.id);
    const abs = this.storage.absPath(file.storedPath);
    if (!fs.existsSync(abs)) throw new BadRequestException('文件已丢失');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
    res.setHeader('Content-Type', file.mimeType);
    return new StreamableFile(fs.createReadStream(abs));
  }

  /** zip 目录树 */
  @Get(':uuid/zip/entries')
  async zipEntries(@Param('uuid') uuid: string, @CurrentUser() user: JwtUser) {
    const file = await this.storage.findByUuid(uuid);
    if (!file) throw new BadRequestException('文件不存在');
    await this.assertAccess(user, file.uploaderId, file.id);
    const entries = await this.prisma.zipEntry.findMany({ where: { zipFileId: file.id }, orderBy: { entryPath: 'asc' } });
    if (entries.length === 0) await this.zip.indexZip(file.id).catch(() => undefined);
    const rows = entries.length
      ? entries
      : await this.prisma.zipEntry.findMany({ where: { zipFileId: file.id }, orderBy: { entryPath: 'asc' } });
    return rows
      .filter((e: any) => !e.isDir)
      .map((e: any) => ({ path: e.entryPath, name: e.entryPath.split('/').pop(), size: e.size, previewable: e.status === 'OK', status: e.status }));
  }

  /** zip 内文件在线预览（懒解压 + 内联流） */
  @Get(':uuid/zip/preview')
  async zipPreview(@Param('uuid') uuid: string, @Query('path') entryPath: string, @CurrentUser() user: JwtUser, @Res({ passthrough: true }) res: Response) {
    if (!entryPath) throw new BadRequestException('缺少 path');
    const file = await this.storage.findByUuid(uuid);
    if (!file) throw new BadRequestException('文件不存在');
    await this.assertAccess(user, file.uploaderId, file.id);
    const { file: info, absPath } = await this.zip.extractEntry(file.id, entryPath);
    res.setHeader('Content-Type', info.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(info.originalName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(fs.createReadStream(absPath));
  }

  /** 访问控制：超管/辅导员全量；班委限本班；学生仅本人（经上传者/申请/材料包三路归属判定） */
  private async assertAccess(user: JwtUser, uploaderId: string | null, fileObjectId: string) {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.GRADE_ADMIN) return;
    if (uploaderId && uploaderId === user.id) return;

    if (user.role === Role.CLASS_LEADER && user.classId) {
      // 经申请附件或材料包判定归属班级
      const [app, pkg] = await Promise.all([
        this.prisma.applicationAttachment.findFirst({ where: { fileId: fileObjectId }, include: { application: { select: { classId: true } } } }),
        this.prisma.materialPackage.findFirst({ where: { zipFileId: fileObjectId }, include: { student: { select: { classId: true } } } }),
      ]);
      const classId = app?.application.classId ?? pkg?.student.classId;
      if (classId === user.classId) return;
      // zip 派生文件：查父 zip 的归属
      const derived = await this.prisma.fileObject.findFirst({ where: { id: fileObjectId, parentZipId: { not: null } } });
      if (derived?.parentZipId) {
        const parent = await this.storage.findByUuid(derived.parentZipId);
        if (parent) return this.assertAccess(user, parent.uploaderId, parent.id);
      }
    }
    throw new BadRequestException('无权访问该文件');
  }
}

@Module({
  controllers: [FilesController],
  providers: [StorageService, ZipService],
  exports: [StorageService, ZipService],
})
export class FilesModule {}
