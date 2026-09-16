import * as XLSX from 'xlsx';
import { normalizeHeader } from './column-matcher';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, any>[];
  termKeys?: string[];
}

/** SheetJS 统一解析 xlsx/xls(OLE2)/csv：取第一个非空 sheet，返回表头与行字典 */
export function parseWorkbook(buffer: Buffer): ParsedSheet {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, codepage: 936 });
  const sheetName = wb.SheetNames.find((n) => {
    const ws = wb.Sheets[n];
    return ws && ws['!ref'];
  });
  if (!sheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false, defval: '' });
  if (matrix.length === 0) return { headers: [], rows: [] };

  // 表头行探测：默认第 1 行；若前 3 行内某行同时含「学号」，以该行为表头
  let headerIdx = 0;
  for (let i = 0; i < Math.min(3, matrix.length); i++) {
    const row = matrix[i] ?? [];
    const joined = row.map((c) => normalizeHeader(String(c ?? ''))).join('|');
    if (joined.includes('学号')) {
      headerIdx = i;
      break;
    }
  }
  const headerRow = (matrix[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  // 补齐重复表头（同名列加序号后缀）
  const seen = new Map<string, number>();
  const headers = headerRow.map((h) => {
    const base = h || '未命名';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}(${n})`;
  });

  const rows: Record<string, any>[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const arr = matrix[r] ?? [];
    if (arr.every((c) => c === '' || c === null || c === undefined)) continue;
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => {
      obj[h] = arr[i] ?? '';
    });
    obj.__rowNo = headerIdx + 2 + (r - headerIdx - 1); // Excel 中的 1-based 行号
    rows.push(obj);
  }

  // 成绩表：提取学期键集合
  const termSet = new Set<string>();
  const termHeader = headers.find((h) => ['开课学期', '学期', '上课学期'].includes(normalizeHeader(h)));
  if (termHeader) {
    for (const row of rows) {
      const t = String(row[termHeader] ?? '').trim();
      if (/^\d{4}-\d{4}-[12]$/.test(t)) termSet.add(t);
    }
  }
  return { headers, rows, termKeys: [...termSet].sort() };
}

export function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

export function cellNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
