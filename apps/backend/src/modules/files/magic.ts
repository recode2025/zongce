/** 魔数嗅探：不信任扩展名与 Content-Type，只认文件头 */
export type AllowedExt = 'pdf' | 'jpg' | 'jpeg' | 'png' | 'webp' | 'zip' | 'rar';

const MAGIC_CHECKS: { ext: AllowedExt[]; test: (b: Buffer) => boolean }[] = [
  { ext: ['pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: ['jpg', 'jpeg'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['png'], test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: ['webp'], test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: ['zip'], test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { ext: ['rar'], test: (b) => b.subarray(0, 6).toString('latin1') === 'Rar!' },
];

export const ALLOWED_UPLOAD_EXTS: AllowedExt[] = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'zip', 'rar'];

export const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
};

/** 返回嗅探出的真实扩展名；识别失败返回 null */
export function sniff(buffer: Buffer): AllowedExt | null {
  for (const c of MAGIC_CHECKS) {
    if (buffer.length >= 16 && c.test(buffer)) return c.ext[0] === 'pdf' ? 'pdf' : c.ext[0];
  }
  return null;
}

/** 校验：声明扩展名必须与魔数嗅探一致（jpg/jpeg 互通） */
export function verifyMagic(declaredExt: string, buffer: Buffer): AllowedExt {
  const real = sniff(buffer);
  if (!real) throw new Error('不支持的文件类型（仅支持 PDF/图片/zip/rar）');
  const d = declaredExt.toLowerCase();
  if (d !== real && !(['jpg', 'jpeg'].includes(d) && ['jpg', 'jpeg'].includes(real))) {
    throw new Error(`文件内容与扩展名不符（声明 ${d}，实际 ${real}）`);
  }
  return real;
}
