import ExcelJS from 'exceljs';
import type { Cell } from 'exceljs';
import { UnsupportedMediaError } from '../errors.js';

export const XLSX_DEFAULT_MAX_ROWS = 200;
export const XLSX_DEFAULT_MAX_COLS = 30;
export const XLSX_DEFAULT_MAX_SHEETS = 20;

export interface XlsxExtraction {
  text: string;
  truncated: boolean;
  sheets: number;
}

function cellText(cell: Cell): string {
  try {
    const value = cell.value;
    if (value instanceof Date) return value.toISOString().replace('T00:00:00.000Z', '');
    // Formulas are never evaluated: exceljs returns the cached result stored in the file.
    return cell.text ?? '';
  } catch {
    return '';
  }
}

/**
 * XLSX → one TSV block per sheet ("## Sheet: name"), capped at maxRows × maxCols per sheet.
 * Run inspectOfficeZip first (zip-bomb / macro guard).
 */
export async function extractXlsxText(
  buf: Buffer,
  opts: { maxRows?: number; maxCols?: number; maxSheets?: number } = {},
): Promise<XlsxExtraction> {
  const maxRows = Math.max(1, opts.maxRows ?? XLSX_DEFAULT_MAX_ROWS);
  const maxCols = Math.max(1, opts.maxCols ?? XLSX_DEFAULT_MAX_COLS);
  const maxSheets = Math.max(1, opts.maxSheets ?? XLSX_DEFAULT_MAX_SHEETS);

  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs types its input as an ArrayBuffer; hand it an exact copy of the bytes.
    const data = new ArrayBuffer(buf.length);
    new Uint8Array(data).set(buf);
    await workbook.xlsx.load(data);
  } catch {
    throw new UnsupportedMediaError('the XLSX workbook could not be parsed', 'xlsx');
  }

  let truncated = workbook.worksheets.length > maxSheets;
  const blocks: string[] = [];
  for (const sheet of workbook.worksheets.slice(0, maxSheets)) {
    const lines: string[] = [];
    let rowsSeen = 0;
    let sheetRowsCut = false;
    let sheetColsCut = false;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      rowsSeen++;
      if (rowsSeen > maxRows) {
        sheetRowsCut = true;
        return;
      }
      const lastCol = row.cellCount;
      if (lastCol > maxCols) sheetColsCut = true;
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(lastCol, maxCols); c++) {
        cells.push(cellText(row.getCell(c)).replace(/[\t\r\n]+/g, ' ').trim());
      }
      lines.push(cells.join('\t').replace(/\t+$/, ''));
    });
    const notes: string[] = [];
    if (sheetRowsCut) notes.push(`only the first ${maxRows} of ${rowsSeen} rows are shown`);
    if (sheetColsCut) notes.push(`only the first ${maxCols} columns are shown`);
    truncated = truncated || sheetRowsCut || sheetColsCut;
    const name = sheet.name.replace(/[\r\n]+/g, ' ');
    blocks.push(
      [`## Sheet: ${name}`, lines.length ? lines.join('\n') : '(empty)', notes.length ? `[${notes.join('; ')}]` : '']
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (workbook.worksheets.length > maxSheets) {
    blocks.push(`[only the first ${maxSheets} of ${workbook.worksheets.length} sheets are shown]`);
  }
  return { text: blocks.join('\n\n'), truncated, sheets: workbook.worksheets.length };
}
