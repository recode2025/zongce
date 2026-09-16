// 临时：综测登记表结构探查（紧凑摘要输出）
import ExcelJS from 'exceljs';

const file = process.argv[2];
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

for (const ws of wb.worksheets) {
  console.log(`\n=== SHEET [${ws.name}] rows=${ws.rowCount} cols=${ws.columnCount} merges=${(ws.model.merges ?? []).length}`);
  const maxR = Math.min(ws.rowCount, Number(process.argv[3] ?? 40));
  const maxC = Math.min(ws.columnCount, 30);
  for (let r = 1; r <= maxR; r++) {
    const parts = [];
    for (let c = 1; c <= maxC; c++) {
      let v = ws.getRow(r).getCell(c).value;
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        if (v.richText) v = v.richText.map((t) => t.text).join('');
        else if ('result' in v) v = v.result;
        else v = JSON.stringify(v);
      }
      const s = String(v).replace(/\s+/g, ' ').slice(0, 24);
      if (s) parts.push(`${c}:${s}`);
    }
    if (parts.length) console.log(`r${r}| ${parts.join(' | ')}`);
  }
  if (ws.rowCount > maxR) console.log(`... (${ws.rowCount - maxR} more rows)`);
}
