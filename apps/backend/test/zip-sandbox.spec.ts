/**
 * zip 沙箱安全用例（M7 验收：炸弹/路径穿越/超限全量预检）。
 *
 * 恶意样本不走 archiver（会规范化文件名），而是手工构造 ZIP 字节流，
 * 完全控制 entry 名（UTF-8 flag 位 / GBK 编码 / 穿越路径）与 central directory
 * 声明大小（伪造 uncompressedSize 的头炸弹）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

process.env.UPLOAD_DIR = path.join(__dirname, '.uploads-test');
process.env.TMP_DIR = path.join(__dirname, '.tmp-test');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ZipService, sanitizeEntryPath } = require('../src/modules/files/zip.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StorageService } = require('../src/modules/files/storage.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaService } = require('../src/prisma/prisma.module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BadRequestException, NotFoundException } = require('@nestjs/common');

// ---------- 手工 ZIP 构造 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface CraftEntry {
  name: string | Buffer;
  data: Buffer;
  utf8?: boolean; // general purpose bit11
  method?: 0 | 8; // 0=store 8=deflate
  lieUncompressed?: number; // 伪造 central directory 声明（头炸弹）
}
function craftZip(entries: CraftEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    let data = e.data;
    if (method === 8) data = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const flags = e.utf8 === false ? 0 : 0x800;
    const uncompDeclared = e.lieUncompressed ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(uncompDeclared, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(uncompDeclared, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------- 测试环境 ----------
const prisma = new PrismaService();
const storage = new StorageService(prisma);
const zipService = new ZipService(prisma, storage);
const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function saveZip(buffer: Buffer, uuid: string): Promise<string> {
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR!, 't'), { recursive: true });
  const stored = `t/${uuid}.zip`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, stored), buffer);
  const row = await prisma.fileObject.create({
    data: { uuid, originalName: `${uuid}.zip`, ext: 'zip', mimeType: 'application/zip', size: buffer.length, sha256: '00', storedPath: stored, kind: 'FILE' },
  });
  return row.id;
}

describe('sanitizeEntryPath：路径安全清洗（纯函数）', () => {
  const evil = ['../evil.pdf', '..\\..\\win.pdf', 'a/../../b.pdf', 'C:\\temp\\x.pdf', '/etc/passwd.pdf', '/abs.pdf'];
  for (const p of evil) {
    test(`拒绝 ${JSON.stringify(p)}`, () => {
      expect(() => sanitizeEntryPath(p)).toThrow(BadRequestException);
    });
  }
  test('控制字符被剥离（剥离即安全，不拒绝）', () => {
    expect(sanitizeEntryPath('a/\x00b\x1f.pdf')).toBe('a/b.pdf');
  });
  test('合法中文路径原样通过（反斜杠归一）', () => {
    expect(sanitizeEntryPath('国/省 级-竞赛证明.pdf')).toBe('国/省 级-竞赛证明.pdf');
    expect(sanitizeEntryPath('dir\\file.pdf')).toBe('dir/file.pdf');
    expect(sanitizeEntryPath('./ok.pdf')).toBe('ok.pdf');
  });
});

describe('zip 沙箱 indexZip/extractEntry（真实恶意字节流）', () => {
  beforeAll(() => {
    fs.mkdirSync(process.env.UPLOAD_DIR!, { recursive: true });
    fs.mkdirSync(process.env.TMP_DIR!, { recursive: true });
  });
  afterAll(async () => {
    await prisma.fileObject.deleteMany({ where: { uuid: { startsWith: 'test-zip-' } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    fs.rmSync(process.env.UPLOAD_DIR!, { recursive: true, force: true });
    fs.rmSync(process.env.TMP_DIR!, { recursive: true, force: true });
  });

  test('正常包：目录树 + 可预览标记 + 懒解压内容一致', async () => {
    const buf = craftZip([
      { name: '社会实践1.pdf', data: PDF },
      { name: 'img/志愿服务.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) },
      { name: '说明.docx', data: Buffer.from('docx') },
    ]);
    const id = await saveZip(buf, 'test-zip-ok');
    const tree = await zipService.indexZip(id);
    expect(tree.map((t: any) => t.path).sort()).toEqual(['img/志愿服务.png', '社会实践1.pdf', '说明.docx']);
    const pdf = tree.find((t: any) => t.path === '社会实践1.pdf');
    expect(pdf.previewable).toBe(true);
    expect(tree.find((t: any) => t.path === '说明.docx').previewable).toBe(false);

    const { file, absPath } = await zipService.extractEntry(id, '社会实践1.pdf');
    expect(file.mimeType).toBe('application/pdf');
    expect(fs.readFileSync(absPath).equals(PDF)).toBe(true);
    // 二次提取走缓存（同一 absPath）
    const again = await zipService.extractEntry(id, '社会实践1.pdf');
    expect(again.absPath).toBe(absPath);
    // 不支持预览的类型被拒
    await expect(zipService.extractEntry(id, '说明.docx')).rejects.toThrow(BadRequestException);
    // 不存在的 entry
    await expect(zipService.extractEntry(id, 'nope.pdf')).rejects.toThrow(NotFoundException);
  });

  test('路径穿越 entry 被拒：../evil.pdf', async () => {
    const buf = craftZip([{ name: '../evil.pdf', data: PDF }]);
    const id = await saveZip(buf, 'test-zip-traversal');
    await expect(zipService.indexZip(id)).rejects.toThrow(/不安全路径/);
  });

  test('绝对路径/盘符 entry 被拒', async () => {
    const abs = await saveZip(craftZip([{ name: '/etc/cron.pdf', data: PDF }]), 'test-zip-abs');
    await expect(zipService.indexZip(abs)).rejects.toThrow(/不安全路径/);
    const drive = await saveZip(craftZip([{ name: Buffer.from('C:\\x.pdf', 'latin1'), data: PDF }]), 'test-zip-drive');
    await expect(zipService.indexZip(drive)).rejects.toThrow(/不安全路径/);
  });

  test('zip 炸弹预检：2MB 零字节 deflate（压缩比 ~1000:1）被拒', async () => {
    const bomb = craftZip([{ name: 'big.pdf', data: Buffer.alloc(2 * 1024 * 1024), method: 8 }]);
    const id = await saveZip(bomb, 'test-zip-bomb');
    await expect(zipService.indexZip(id)).rejects.toThrow(/压缩比|炸弹/);
  });

  test('头炸弹：central directory 伪造解压大小与实际不符 → yauzl 校验层直接拒绝', async () => {
    const lie = craftZip([{ name: 'lie.pdf', data: Buffer.alloc(10), lieUncompressed: 21 * 1024 * 1024 }]);
    const id = await saveZip(lie, 'test-zip-lie');
    await expect(zipService.indexZip(id)).rejects.toThrow(); // yauzl "size mismatch" —— 任何路径都不放行
  });

  test('单文件超限：真实 21MB store 条目触发应用层预检', async () => {
    const big = craftZip([{ name: 'big.pdf', data: Buffer.alloc(21 * 1024 * 1024) }]);
    const id = await saveZip(big, 'test-zip-big');
    await expect(zipService.indexZip(id)).rejects.toThrow(/单文件解压后超过限制/);
  });

  test('条目数超限：501 个文件被拒', async () => {
    const many = craftZip(Array.from({ length: 501 }, (_, i) => ({ name: `f${i}.pdf`, data: Buffer.from([i % 256]) })));
    const id = await saveZip(many, 'test-zip-many');
    await expect(zipService.indexZip(id)).rejects.toThrow(/文件数超过限制/);
  });

  test('GBK 文件名（无 UTF-8 flag）正确解码', async () => {
    const iconv = require('iconv-lite');
    const gbkName = iconv.encode('附件/获奖证明.pdf', 'gbk');
    const buf = craftZip([{ name: gbkName, data: PDF, utf8: false }]);
    const id = await saveZip(buf, 'test-zip-gbk');
    const tree = await zipService.indexZip(id);
    expect(tree.some((t: any) => t.path === '附件/获奖证明.pdf')).toBe(true);
  });
});
