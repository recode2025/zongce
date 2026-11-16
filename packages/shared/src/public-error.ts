/** Public messages shared by API responses and legacy task displays. */
export const OPERATION_FAILED_MESSAGE = '操作未完成，请稍后重试；如仍失败，请联系管理员';
export const TASK_FAILED_MESSAGE = '任务处理失败，请稍后重试；如仍失败，请联系管理员';
export const DUPLICATE_DATA_MESSAGE = '数据重复或已存在，请检查导入记录后重试';

export function publicErrorText(value: unknown, fallback = OPERATION_FAILED_MESSAGE): string {
  const text = (Array.isArray(value) ? value.filter((v) => typeof v === 'string').join('；') : typeof value === 'string' ? value : '').trim();
  if (!text) return fallback;
  // Historical jobs can contain complete Prisma messages without an error code.
  if (/\bP2002\b|unique constraint failed|duplicate entry/i.test(text)) return DUPLICATE_DATA_MESSAGE;
  if (/\bP2003\b|foreign key constraint/i.test(text)) return '关联数据不完整，请检查后重试';
  if (/\bP2025\b/.test(text)) return '记录不存在或已被更新，请刷新后重试';
  const internal = /prisma|\bSQL(?:STATE|ITE)?\b|\bP\d{4}\b|\b(?:TypeError|ReferenceError|SyntaxError)\b|\b(?:ENOENT|EACCES|ECONNREFUSED)\b|node_modules|\bthis\.[\w.]+|\binvocation\b|[a-z]:[\\/]|file:\/\/|\/(?:app|home|usr|var|srv|opt|Users|tmp)\/|\bat\s+.*:\d+:\d+|\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b[\s\S]*\bSET\b|\bDELETE\s+FROM\b/i;
  return text.length > 300 || internal.test(text) ? fallback : text;
}
