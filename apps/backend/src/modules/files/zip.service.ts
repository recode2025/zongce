import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yauzl from 'yauzl';
import * as iconv from 'iconv-lite';
import { PrismaService } from '../../prisma/prisma.module';
import { StorageService } from './storage.service';
import { env } from '../../config/env';

export interface ZipTreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  previewable: boolean;
  status: string;
}

const PREVIEWABLE = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

/** zip 安全沙箱：central directory 目录树 + 单文件懒解压（大小/数量/压缩比/路径穿越全量预检） */
@Injectable()
export class ZipService implements OnModuleInit {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  private cleanupTimer?: NodeJS.Timeout;

  onModuleInit() {
    // 定时清理懒解压临时目录（>24h）
    this.cleanupTimer = setInterval(() => void this.sweepTmp(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  /** 上传后的 zip：读 central directory 建目录树（不解压全包） */
  async indexZip(zipFileId: string): Promise<ZipTreeNode[]> {
    const zipFile = await this.prisma.fileObject.findUnique({ where: { id: zipFileId } });
    if (!zipFile || zipFile.ext !== 'zip') throw new BadRequestException('不是 zip 文件');
    const abs = this.storage.absPath(zipFile.storedPath);

    const entries = await this.readCentralDirectory(abs);

    // 炸弹预检：条目数 / 解压总量 / 单条目大小 / 压缩比
    if (entries.length > env.zipMaxEntries) throw new BadRequestException(`压缩包内文件数超过限制（${env.zipMaxEntries}）`);
    const totalUncompressed = entries.reduce((s, e) => s + e.uncompressedSize, 0);
    if (totalUncompressed > env.zipMaxTotalBytes) throw new BadRequestException(`解压后总大小超过限制（${env.zipMaxTotalBytes / 1024 / 1024}MB）`);
    for (const e of entries) {
      // decodeStrings:false 时 fileName 是 Buffer，须先解码（GBK/UTF-8）再取 basename
      const name = path.basename(decodeEntryName(e));
      if (e.uncompressedSize > env.zipMaxEntryBytes) throw new BadRequestException(`单文件解压后超过限制（${name}，${env.zipMaxEntryBytes / 1024 / 1024}MB）`);
      if (e.compressedSize > 1024 && e.uncompressedSize / e.compressedSize > env.zipMaxRatio) {
        throw new BadRequestException(`检测到异常压缩比（可能的 zip 炸弹）：${name}`);
      }
    }

    // 覆盖式重建目录树（fileName 为 Buffer，须按 flag 位解码 UTF-8/GBK）
    await this.prisma.zipEntry.deleteMany({ where: { zipFileId } });
    const rows = entries.map((e) => {
      const clean = sanitizeEntryPath(decodeEntryName(e));
      const ext = clean.split('.').pop()?.toLowerCase() ?? '';
      return {
        zipFileId,
        entryPath: clean,
        isDir: clean.endsWith('/'),
        size: e.uncompressedSize,
        compressedSize: e.compressedSize,
        status: PREVIEWABLE.includes(ext) ? 'OK' : 'SKIPPED_UNSUPPORTED',
      };
    });
    if (rows.length) await this.prisma.zipEntry.createMany({ data: rows });
    return rows
      .filter((r) => !r.isDir)
      .map((r) => ({
        path: r.entryPath,
        name: r.entryPath.split('/').pop()!,
        isDir: false,
        size: r.size,
        previewable: r.status === 'OK',
        status: r.status,
      }));
  }

  /** 懒解压单个 entry → 登记 FileObject → 返回绝对路径（流式下发） */
  async extractEntry(zipFileId: string, rawEntryPath: string): Promise<{ file: { uuid: string; mimeType: string; originalName: string; size: number }; absPath: string }> {
    const clean = sanitizeEntryPath(rawEntryPath);
    const existing = await this.prisma.zipEntry.findUnique({ where: { zipFileId_entryPath: { zipFileId, entryPath: clean } } });
    if (!existing) throw new NotFoundException('压缩包内不存在该文件');
    if (existing.status !== 'OK') throw new BadRequestException('该类型文件不支持在线预览，请下载压缩包查看');
    if (existing.extractedFileId) {
      const cached = await this.prisma.fileObject.findUnique({ where: { id: existing.extractedFileId } });
      if (cached && fs.existsSync(this.storage.absPath(cached.storedPath))) {
        return { file: { uuid: cached.uuid, mimeType: cached.mimeType, originalName: cached.originalName, size: cached.size }, absPath: this.storage.absPath(cached.storedPath) };
      }
    }

    const zipFile = await this.prisma.fileObject.findUnique({ where: { id: zipFileId } });
    if (!zipFile) throw new NotFoundException('压缩包不存在');
    const zipAbs = this.storage.absPath(zipFile.storedPath);

    // 单条目大小限制（懒解压时再次校验，防止 header 与实际不符）
    if (existing.size > env.zipMaxEntryBytes) throw new BadRequestException('文件过大，不支持在线预览');

    const tmpName = `${randomUUID()}.${clean.split('.').pop()}`;
    const tmpDir = path.join(env.tmpDir, 'zip');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, tmpName);

    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipAbs, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error('zip 打开失败'));
        zipfile.readEntry();
        zipfile.on('entry', (entry: any) => {
          const name = decodeEntryName(entry);
          if (name === clean) {
            zipfile.openReadStream(entry, (e2, readStream) => {
              if (e2 || !readStream) {
                zipfile.close();
                return reject(e2 ?? new Error('读取失败'));
              }
              const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
              readStream.pipe(out);
              out.on('finish', () => {
                zipfile.close();
                resolve();
              });
              out.on('error', reject);
            });
          } else {
            zipfile.readEntry();
          }
        });
        zipfile.on('end', () => reject(new NotFoundException('压缩包内未找到该文件')));
        zipfile.on('error', reject);
      });
    });

    // 登记为派生文件（parentZipId 关联）
    const buffer = fs.readFileSync(tmpPath);
    const uuid = randomUUID();
    const subDir = uuid.slice(0, 2);
    fs.mkdirSync(path.join(env.uploadDir, subDir), { recursive: true });
    const stored = path.join(subDir, `${uuid}.${clean.split('.').pop()}`);
    fs.renameSync(tmpPath, path.join(env.uploadDir, stored));

    const { sha256Hex } = await import('../../common/utils/crypto');
    const fileRow = await this.prisma.fileObject.create({
      data: {
        uuid,
        originalName: clean.split('/').pop()!.slice(0, 255),
        ext: clean.split('.').pop()!.toLowerCase(),
        mimeType: clean.endsWith('.pdf') ? 'application/pdf' : `image/${clean.split('.').pop()}`,
        size: buffer.length,
        sha256: sha256Hex(buffer),
        storedPath: stored.replace(/\\/g, '/'),
        kind: 'FILE',
        parentZipId: zipFile.uuid,
        innerPath: clean,
        uploaderId: zipFile.uploaderId,
      },
    });
    await this.prisma.zipEntry.update({ where: { id: existing.id }, data: { extractedFileId: fileRow.id } });
    return {
      file: { uuid: fileRow.uuid, mimeType: fileRow.mimeType, originalName: fileRow.originalName, size: fileRow.size },
      absPath: path.join(env.uploadDir, stored),
    };
  }

  private readCentralDirectory(abs: string): Promise<yauzl.Entry[]> {
    return new Promise((resolve, reject) => {
      yauzl.open(abs, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zipfile) => {
        if (err || !zipfile) return reject(new BadRequestException('无法读取压缩包（文件可能损坏）'));
        const entries: yauzl.Entry[] = [];
        zipfile.on('entry', (entry: any) => {
          // 大小预检（central directory 声明值）
          if (entry.uncompressedSize > env.zipMaxTotalBytes) {
            zipfile.close();
            return reject(new BadRequestException('压缩包内单文件过大'));
          }
          entries.push(entry as yauzl.Entry);
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve(entries));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
  }

  private async sweepTmp() {
    const dir = path.join(env.tmpDir, 'zip');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/** entry 文件名：UTF-8 flag(bit11) → 原样；否则 GBK 解码（中文压缩包常见） */
function decodeEntryName(entry: any): string {
  const buf: Buffer = entry.fileNameBuffer ?? Buffer.from(entry.fileName, 'utf8');
  const isUtf8 = (entry.generalPurposeBitFlag ?? entry.flags ?? 0) & 0x800;
  if (isUtf8) return buf.toString('utf8');
  try {
    return iconv.decode(buf, 'gbk');
  } catch {
    return buf.toString('latin1');
  }
}

/** 路径安全清洗：拒绝穿越/绝对路径/盘符/控制字符；统一正斜杠 */
export function sanitizeEntryPath(p: string): string {
  let s = String(p ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '/').trim();
  if (!s) throw new BadRequestException('空文件名');
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/') || s.includes('..') || s.includes('\0')) {
    throw new BadRequestException(`压缩包内存在不安全路径：${s}`);
  }
  // 去掉开头的 ./ 序列
  while (s.startsWith('./')) s = s.slice(2);
  if (!s || s === '/') throw new BadRequestException('空文件名');
  return s.slice(0, 500);
}
