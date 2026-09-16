import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env';

/** AES-256-GCM：身份证等敏感字段加密（密钥来自 env，与数据库分离） */
export function aesEncrypt(plain: string): string {
  const key = Buffer.from(env.aesKeyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function aesDecrypt(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(':');
  const key = Buffer.from(env.aesKeyHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 身份证脱敏：前3后4 */
export function maskIdCard(idCard: string): string {
  if (idCard.length < 8) return '***';
  return `${idCard.slice(0, 3)}****${idCard.slice(-4)}`;
}
