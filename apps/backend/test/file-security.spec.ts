import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { BadRequestException } from '@nestjs/common';

// Dedicated directory; no database or existing uploads are touched.
const temporaryParent = path.resolve(__dirname, '../../../.turbo');
fs.mkdirSync(temporaryParent, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryParent, 'file-security-'));
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.TMP_DIR = path.join(root, 'tmp');
const { env } = require('../src/config/env');
const { StorageService } = require('../src/modules/files/storage.service');
const { ZipService } = require('../src/modules/files/zip.service');
const { FilesController } = require('../src/modules/files/files.controller');
const { PackagesService } = require('../src/modules/applications/packages.service');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Deflate data is valid but the central directory falsely declares one byte.
function shortDeclaredZip(): Buffer {
  const name = Buffer.from('proof.pdf');
  const compressed = zlib.deflateRawSync(Buffer.alloc(2000, 0x41));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

test('恶意 ZIP 的解压流错误被捕获且临时文件清理', async () => {
  fs.mkdirSync(process.env.UPLOAD_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'malformed.zip'), shortDeclaredZip());
  let indexed: any[] = [];
  const prisma = {
    fileObject: { findUnique: jest.fn().mockResolvedValue({ id: 'zip', uuid: 'zip-uuid', ext: 'zip', storedPath: 'malformed.zip' }) },
    zipEntry: {
      deleteMany: jest.fn(), createMany: jest.fn(({ data }) => { indexed = data; }),
      findUnique: jest.fn(() => indexed[0] && { ...indexed[0], id: 'entry' }),
    },
  };
  const zip = new ZipService(prisma, new StorageService(prisma));
  await expect(zip.indexZip('zip')).resolves.toHaveLength(1);
  await expect(zip.extractEntry('zip', 'proof.pdf')).rejects.toBeInstanceOf(BadRequestException);
  expect(fs.readdirSync(path.join(process.env.TMP_DIR!, 'zip'))).toEqual([]);
});

test('读取 ZIP 目录时达到条目上限立即中断', async () => {
  const archiver = require('archiver');
  const archive = archiver('zip');
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => { archive.on('end', resolve); archive.on('error', reject); });
  for (let i = 0; i < 3; i++) archive.append('x', { name: `${i}.pdf` });
  await archive.finalize(); await finished;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'many.zip'), Buffer.concat(chunks));
  const prisma = { fileObject: { findUnique: jest.fn().mockResolvedValue({ ext: 'zip', storedPath: 'many.zip' }) } };
  const zip = new ZipService(prisma, new StorageService(prisma));
  const original = env.zipMaxEntries;
  try {
    env.zipMaxEntries = 2;
    await expect(zip.indexZip('zip')).rejects.toThrow(/文件数超过限制/);
  } finally { env.zipMaxEntries = original; }
});

test('无效 ZIP 上传失败时清除文件和数据库记录', async () => {
  const rows = new Map<string, any>();
  const prisma = { fileObject: {
    create: jest.fn(({ data }) => { const row = { id: 'upload', ...data }; rows.set(row.id, row); return row; }),
    findUnique: jest.fn(({ where }) => rows.get(where.id)),
    delete: jest.fn(({ where }) => rows.delete(where.id)),
  } };
  const storage = new StorageService(prisma);
  const controller = new FilesController(prisma, storage, { indexZip: jest.fn().mockRejectedValue(new BadRequestException('bad ZIP')) }, { log: jest.fn() });
  const filesBefore = fs.readdirSync(process.env.UPLOAD_DIR!, { recursive: true }).map(String).filter((f) => f.endsWith('.zip')).sort();
  const badZip = Buffer.alloc(32); badZip.write('PK\x03\x04', 'latin1');
  await expect(controller.upload({ buffer: badZip, originalname: 'bad.zip' }, { id: 'u' })).rejects.toThrow('bad ZIP');
  expect(rows.size).toBe(0);
  const files = fs.readdirSync(process.env.UPLOAD_DIR!, { recursive: true }).map(String);
  expect(files.filter((f) => f.endsWith('.zip')).sort()).toEqual(filesBefore);
});

test('材料包拒绝重复文件，压缩前限制源文件总量并限制输出', async () => {
  const prisma = {
    student: { findUnique: jest.fn().mockResolvedValue({ id: 'student' }) },
    batch: { findUnique: jest.fn().mockResolvedValue({ status: 'COLLECTING' }) },
    fileObject: { findMany: jest.fn() },
  };
  const service = new PackagesService(prisma, new StorageService(prisma), {}, { assertApplyOpen: jest.fn() });
  await expect(service.submit({ id: 'u' }, { batchId: 'b', items: [{ fileId: 'x' }, { fileId: 'x' }] })).rejects.toThrow(/重复/);
  expect(prisma.fileObject.findMany).not.toHaveBeenCalled();

  const file = path.join(process.env.UPLOAD_DIR!, 'small.pdf');
  fs.writeFileSync(file, Buffer.alloc(1024, 65));
  const oldMax = env.maxUploadBytes;
  try {
    env.maxUploadBytes = 100;
    await expect(service.buildZip([{ entryName: 'a.pdf', source: { storedPath: 'small.pdf' } }])).rejects.toThrow(/材料总大小/);
    fs.writeFileSync(file, Buffer.from('a'));
    env.maxUploadBytes = 10; // ZIP headers alone exceed this limit
    await expect(service.buildZip([{ entryName: 'a.pdf', source: { storedPath: 'small.pdf' } }])).rejects.toThrow(/打包后超过/);
    env.maxUploadBytes = 1024;
    await expect(service.buildZip([{ entryName: 'a.pdf', source: { storedPath: 'small.pdf' } }])).resolves.toBeInstanceOf(Buffer);
  } finally { env.maxUploadBytes = oldMax; }
});
