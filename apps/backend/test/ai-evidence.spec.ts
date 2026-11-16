import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Role } from '@zc/shared';
import * as fs from 'node:fs/promises';
import { AiEvidenceService } from '../src/modules/applications/ai-evidence.service';
import { ApplicationsController } from '../src/modules/applications/applications.module';

jest.mock('node:fs/promises', () => ({ stat: jest.fn(), readFile: jest.fn() }));

describe('AI 材料识别', () => {
  const png = Buffer.from('89504e47000000000000000000000000', 'hex');
  const file = { id: 'f1', uploaderId: 'student', ext: 'png', kind: 'FILE', size: png.length, storedPath: 'xx/file.png' };
  const findMany = jest.fn();
  const absPath = jest.fn().mockReturnValue('safe-path');
  const generate = jest.fn().mockResolvedValue({ detail: {} });
  const withSlot = jest.fn((operation: () => Promise<unknown>) => operation());
  const service = new AiEvidenceService({ fileObject: { findMany } } as any, { absPath } as any, { withSlot, generateWithSlot: generate } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([file]);
    (fs.stat as jest.Mock).mockResolvedValue({ isFile: () => true, size: png.length });
    (fs.readFile as jest.Mock).mockResolvedValue(png);
  });

  test('仅从所属材料读取图片并和文字合并调用', async () => {
    await service.generate('rule', '获奖文字', ['f1'], 'student');
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ['f1'] }, uploaderId: 'student' } });
    expect(generate).toHaveBeenCalledWith('rule', '获奖文字', 'student', [{ mimeType: 'image/png', base64: png.toString('base64') }]);
    expect(withSlot.mock.invocationCallOrder[0]).toBeLessThan((fs.readFile as jest.Mock).mock.invocationCallOrder[0]);
  });

  test('无法获得并发槽时不读取材料', async () => {
    withSlot.mockRejectedValueOnce(new Error('busy'));
    await expect(service.generate('rule', '', ['f1'], 'student')).rejects.toThrow('busy');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  test('拒绝非本人材料、重复材料、PDF、过大或内容不符', async () => {
    findMany.mockResolvedValueOnce([]);
    await expect(service.generate('rule', '', ['other'], 'student')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.generate('rule', '', ['f1', 'f1'], 'student')).rejects.toBeInstanceOf(BadRequestException);
    findMany.mockResolvedValueOnce([{ ...file, ext: 'pdf' }]);
    await expect(service.generate('rule', '', ['f1'], 'student')).rejects.toBeInstanceOf(BadRequestException);
    findMany.mockResolvedValueOnce([{ ...file, size: 5 * 1024 * 1024 + 1 }]);
    await expect(service.generate('rule', '', ['f1'], 'student')).rejects.toBeInstanceOf(BadRequestException);
    (fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.alloc(png.length));
    await expect(service.generate('rule', '', ['f1'], 'student')).rejects.toBeInstanceOf(BadRequestException);
    expect(generate).not.toHaveBeenCalled();
  });

  test('接口验证图片数量、标识和文本长度，并拒绝非学生', async () => {
    const dto = Reflect.getMetadata('design:paramtypes', ApplicationsController.prototype, 'evidenceDraft')[0];
    expect(await validate(plainToInstance(dto, { ruleItemId: 'rule', text: '', fileIds: ['f1'] }))).toHaveLength(0);
    expect((await validate(plainToInstance(dto, { ruleItemId: 'rule', text: 'x'.repeat(3001), fileIds: ['f1', 'f1', 'f2', 'f3'] }))).length).toBeGreaterThan(0);
    const controller = new ApplicationsController({} as any, {} as any, {} as any, {} as any, {} as any, service);
    await expect(controller.evidenceDraft({ ruleItemId: 'rule', fileIds: ['f1'] }, { id: 'admin', role: Role.SUPER_ADMIN } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(generate).not.toHaveBeenCalled();
  });
});
