import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../../prisma/prisma.module';
import { env } from '../../config/env';
import { sha256Hex } from '../../common/utils/crypto';
import { AllowedExt, EXT_MIME, verifyMagic } from './magic';

/** 本地磁盘存储：随机二级目录 + uuid 文件名，业务侧只见 uuid */
@Injectable()
export class StorageService {
  constructor(private prisma: PrismaService) {}

  /** 校验并保存上传文件，登记 FileObject */
  async saveUpload(opts: { buffer: Buffer; originalName: string; declaredExt: string; uploaderId?: string; kind?: string }): Promise<{ id: string; uuid: string; ext: string; size: number }> {
    if (opts.buffer.length === 0) throw new Error('空文件');
    if (opts.buffer.length > env.maxUploadBytes) throw new Error(`文件超过大小限制（${Math.round(env.maxUploadBytes / 1024 / 1024)}MB）`);
    const realExt = verifyMagic(opts.declaredExt, opts.buffer);

    const uuid = randomUUID();
    const subDir = uuid.slice(0, 2);
    const dir = path.join(env.uploadDir, subDir);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(subDir, `${uuid}.${realExt}`);
    fs.writeFileSync(path.join(env.uploadDir, storedPath), opts.buffer);

    const file = await this.prisma.fileObject.create({
      data: {
        uuid,
        originalName: sanitizeFileName(opts.originalName, realExt),
        ext: realExt,
        mimeType: EXT_MIME[realExt],
        size: opts.buffer.length,
        sha256: sha256Hex(opts.buffer),
        storedPath: storedPath.replace(/\\/g, '/'),
        kind: opts.kind ?? 'FILE',
        uploaderId: opts.uploaderId,
      },
    });
    return { id: file.id, uuid, ext: realExt, size: file.size };
  }

  absPath(storedPath: string): string {
    // 防御：storedPath 来自 DB，但仍拒绝任何路径穿越
    const safe = storedPath.replace(/\\/g, '/');
    if (safe.includes('..') || path.isAbsolute(safe)) throw new Error('非法存储路径');
    return path.join(env.uploadDir, safe);
  }

  async findByUuid(uuid: string) {
    if (!/^[0-9a-f-]{36}$/.test(uuid)) return null;
    return this.prisma.fileObject.findUnique({ where: { uuid } });
  }

  /** 生成导出类文件 */
  async saveExport(buffer: Buffer, fileName: string, uploaderId?: string): Promise<{ id: string; uuid: string }> {
    const uuid = randomUUID();
    const subDir = uuid.slice(0, 2);
    const dir = path.join(env.uploadDir, subDir);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(subDir, `${uuid}.xlsx`);
    fs.writeFileSync(path.join(env.uploadDir, storedPath), buffer);
    const file = await this.prisma.fileObject.create({
      data: {
        uuid,
        originalName: fileName.slice(0, 255),
        ext: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buffer.length,
        sha256: sha256Hex(buffer),
        storedPath: storedPath.replace(/\\/g, '/'),
        kind: 'EXPORT',
        uploaderId,
      },
    });
    return { id: file.id, uuid };
  }
}

/** 文件名清洗：去路径、控制字符；保留中文与常用符号 */
export function sanitizeFileName(name: string, ext: string): string {
  let n = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (!n) n = `file.${ext}`;
  // 扩展名纠偏
  if (!new RegExp(`\\.${ext}$`, 'i').test(n)) n = `${n.replace(/\.(pdf|jpe?g|png|webp|zip|rar|xlsx)$/i, '')}.${ext}`;
  return n.slice(0, 200);
}
