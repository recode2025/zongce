import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { PrismaService } from '../../prisma/prisma.module';
import { StorageService } from '../files/storage.service';
import { EXT_MIME, verifyMagic } from '../files/magic';
import { AiDraftService } from './ai-draft.service';

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** 仅读取当前学生已上传的图片；浏览器不能指定文件路径、URL 或原始模型请求。 */
@Injectable()
export class AiEvidenceService {
  constructor(private prisma: PrismaService, private storage: StorageService, private draft: AiDraftService) {}

  async generate(ruleItemId: string, text: string, fileIds: string[], userId: string) {
    return this.draft.withSlot(() => this.generateWithSlot(ruleItemId, text, fileIds, userId));
  }

  private async generateWithSlot(ruleItemId: string, text: string, fileIds: string[], userId: string) {
    if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > MAX_IMAGES || new Set(fileIds).size !== fileIds.length) {
      throw new BadRequestException('请选择 1 至 3 张不同的图片');
    }
    const files = await this.prisma.fileObject.findMany({ where: { id: { in: fileIds }, uploaderId: userId } });
    if (files.length !== fileIds.length) throw new BadRequestException('材料不存在或不属于当前账号');
    const byId = new Map(files.map((file) => [file.id, file]));
    const images: { mimeType: string; base64: string }[] = [];
    for (const id of fileIds) {
      const file = byId.get(id)!;
      if (!IMAGE_EXTS.has(file.ext) || file.kind !== 'FILE') throw new BadRequestException('AI 识别仅支持 JPG、PNG 或 WebP 图片，暂不支持 PDF');
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new BadRequestException('用于 AI 识别的图片每张不能超过 5MB');
      let data: Buffer;
      try {
        const absolute = this.storage.absPath(file.storedPath);
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== file.size) throw new Error('invalid file size');
        data = await fs.readFile(absolute);
        if (data.length !== stat.size) throw new Error('file changed');
        verifyMagic(file.ext, data);
      } catch {
        throw new BadRequestException('材料文件无法读取或内容无效，请重新上传');
      }
      images.push({ mimeType: EXT_MIME[file.ext], base64: data.toString('base64') });
    }
    return this.draft.generateWithSlot(ruleItemId, text, userId, images);
  }
}
