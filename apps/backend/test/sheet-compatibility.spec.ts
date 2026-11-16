import * as XLSX from 'xlsx';
import { parseWorkbook } from '../src/modules/imports/sheet-parser';

describe('升级后的表格解析兼容性', () => {
  test.each(['xlsx', 'biff8'] as const)('读取 %s 成绩表', (bookType) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['教务成绩'], ['学号', '姓名', '开课学期', '成绩'], ['25001', '张三', '2025-2026-1', 85],
    ]), '成绩');
    const result = parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer);
    expect(result.headers).toEqual(['学号', '姓名', '开课学期', '成绩']);
    expect(result.rows[0]).toMatchObject({ 学号: '25001', 姓名: '张三', 成绩: 85 });
    expect(result.termKeys).toEqual(['2025-2026-1']);
  });

  test('读取 UTF-8 BOM 的中文 CSV', () => {
    const result = parseWorkbook(Buffer.from('\ufeff学号,姓名,成绩\n25001,张三,85\n', 'utf8'));
    expect(result.rows[0]).toMatchObject({ 学号: 25001, 姓名: '张三', 成绩: 85 });
  });
});
