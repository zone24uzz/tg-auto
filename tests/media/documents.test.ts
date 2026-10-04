import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv, detectDelimiter, extractCsvText } from '../../src/media/documents/csv.js';
import { detectDocumentFormat } from '../../src/media/documents/detect.js';
import { processDocument } from '../../src/media/documents/document.processor.js';
import { MediaTooLargeError, UnsupportedMediaError } from '../../src/media/errors.js';
import { sniffMime } from '../../src/security/files.js';
import { buildPdf, makeTmpDir, removeDir, writeTemp } from './helpers.js';

const settings = { maxDocumentSizeMb: 5, maxDocumentChars: 2000 };

function detect(data: Buffer | string, fileName?: string, mimeType?: string) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return detectDocumentFormat({ head: buf.subarray(0, 8192), sniffed: sniffMime(buf), fileName, mimeType });
}

async function minimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('detectDocumentFormat (bytes + extension + MIME)', () => {
  const pdf = buildPdf('hi');

  it('accepts consistent files', () => {
    expect(detect(pdf, 'report.pdf', 'application/pdf')).toEqual({ ok: true, format: 'pdf' });
    expect(detect('a,b\n1,2\n', 'data.csv', 'text/plain')).toEqual({ ok: true, format: 'csv' });
    expect(detect('{"a":1}', 'x.json', 'application/json')).toEqual({ ok: true, format: 'text' });
    expect(detect('# Title', 'notes.md')).toEqual({ ok: true, format: 'text' });
  });

  it('rejects a .pdf that is not %PDF-', () => {
    const r = detect('just some text pretending', 'report.pdf', 'application/pdf');
    expect(r.ok).toBe(false);
  });

  it('rejects extension / MIME family mismatches', () => {
    expect(detect(pdf, 'report.docx', 'application/pdf').ok).toBe(false);
    expect(detect(pdf, 'report.txt').ok).toBe(false);
  });

  it('rejects binary content claiming to be text', () => {
    const binary = Buffer.concat([Buffer.from('hello'), Buffer.alloc(64, 0)]);
    expect(detect(binary, 'notes.txt', 'text/plain').ok).toBe(false);
  });

  it('refuses macro-enabled, legacy Office, executables and scripts', () => {
    for (const name of ['a.docm', 'a.xlsm', 'a.doc', 'a.xls', 'a.exe', 'a.js', 'a.sh', 'a.bat', 'a.ps1', 'a.py']) {
      const r = detect('harmless text', name);
      expect(r.ok, name).toBe(false);
    }
    expect(detect(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'readme.txt').ok).toBe(false);
    expect(detect(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]), 'old.docx').ok).toBe(false);
    expect(detect('x', 'a.docx', 'application/vnd.ms-word.document.macroEnabled.12').ok).toBe(false);
  });

  it('labels the rejected type with the extension', () => {
    const r = detect('MZ', 'setup.exe');
    expect(r).toMatchObject({ ok: false, typeLabel: 'exe' });
  });

  it('falls back to magic bytes when there is no extension', () => {
    expect(detect(pdf, undefined, 'application/octet-stream')).toEqual({ ok: true, format: 'pdf' });
    expect(detect(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), undefined)).toEqual({ ok: true, format: 'ooxml' });
    expect(detect('plain words', undefined)).toEqual({ ok: true, format: 'text' });
  });
});

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    const csv = 'name,comment,qty\r\n"Smith, John","He said ""hi""\nthen left",3\nplain,"",4\n';
    const r = parseCsv(csv);
    expect(r.rows).toEqual([
      ['name', 'comment', 'qty'],
      ['Smith, John', 'He said "hi"\nthen left', '3'],
      ['plain', '', '4'],
    ]);
    expect(r.truncatedRows).toBe(false);
  });

  it('handles a final line without newline, trailing empty field, BOM and blank lines', () => {
    const r = parseCsv('﻿a,b\n\n1,\n2,"x"');
    expect(r.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['2', 'x'],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(parseCsv('a;"b;c"\n1;2').rows).toEqual([
      ['a', 'b;c'],
      ['1', '2'],
    ]);
  });

  it('caps rows and columns', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i},a,b,c`).join('\n');
    const r = parseCsv(lines, { maxRows: 3, maxCols: 2 });
    expect(r.rows).toEqual([
      ['0', 'a'],
      ['1', 'a'],
      ['2', 'a'],
    ]);
    expect(r.truncatedRows).toBe(true);
    expect(r.truncatedCols).toBe(true);
    const text = extractCsvText(lines, { maxRows: 3 });
    expect(text.truncated).toBe(true);
    expect(text.text).toContain('only the first 3 rows');
  });
});

describe('processDocument', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('extracts plain text and JSON', async () => {
    const f = await writeTemp(dir, 'Hello\r\nWorld\n', 'txt');
    const r = await processDocument({ ...f, fileName: 'notes.txt', mimeType: 'text/plain' }, settings);
    expect(r).toEqual({ text: 'Hello\nWorld', truncated: false, format: 'text' });

    const j = await writeTemp(dir, '{"error": "ECONNRESET"}', 'json');
    const rj = await processDocument({ ...j, fileName: 'log.json', mimeType: 'application/json' }, settings);
    expect(rj.text).toBe('{"error": "ECONNRESET"}');
  });

  it('extracts CSV as tab separated rows', async () => {
    const f = await writeTemp(dir, 'a,b\n"x, y",2\n', 'csv');
    const r = await processDocument({ ...f, fileName: 'data.csv', mimeType: 'text/csv' }, settings);
    expect(r.format).toBe('csv');
    expect(r.text).toBe('a\tb\nx, y\t2');
  });

  it('truncates to maxDocumentChars and says so', async () => {
    const f = await writeTemp(dir, 'x'.repeat(5000), 'txt');
    const r = await processDocument({ ...f, fileName: 'big.txt' }, { ...settings, maxDocumentChars: 600 });
    expect(r.text).toHaveLength(600);
    expect(r.truncated).toBe(true);
  });

  it('rejects a .pdf that is not a PDF (UNSUPPORTED)', async () => {
    const f = await writeTemp(dir, 'not really a pdf', 'pdf');
    await expect(processDocument({ ...f, fileName: 'invoice.pdf', mimeType: 'application/pdf' }, settings)).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });

  it('extracts text from a real PDF', async () => {
    const f = await writeTemp(dir, buildPdf('Hello PDF world'), 'pdf');
    const r = await processDocument({ ...f, fileName: 'hello.pdf', mimeType: 'application/pdf' }, settings);
    expect(r.format).toBe('pdf');
    expect(r.text).toContain('Hello PDF world');
  });

  it('extracts text from a DOCX', async () => {
    const f = await writeTemp(dir, await minimalDocx('Quarterly report draft'), 'docx');
    const r = await processDocument(
      { ...f, fileName: 'r.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      settings,
    );
    expect(r.format).toBe('docx');
    expect(r.text).toContain('Quarterly report draft');
  });

  it('extracts an XLSX as TSV per sheet (formulas are not evaluated)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Prices');
    ws.addRow(['item', 'price']);
    ws.addRow(['apple', 3]);
    ws.addRow(['total', { formula: 'B2*2', result: 6 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const f = await writeTemp(dir, buf, 'xlsx');
    const r = await processDocument({ ...f, fileName: 'prices.xlsx' }, settings);
    expect(r.format).toBe('xlsx');
    expect(r.text).toContain('## Sheet: Prices');
    expect(r.text).toContain('item\tprice');
    expect(r.text).toContain('apple\t3');
    expect(r.text).toContain('total\t6');
  });

  it('rejects a zip that is not DOCX/XLSX and a docx that is really a spreadsheet', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const f = await writeTemp(dir, await zip.generateAsync({ type: 'nodebuffer' }), 'docx');
    await expect(processDocument({ ...f, fileName: 'fake.docx' }, settings)).rejects.toBeInstanceOf(UnsupportedMediaError);
  });

  it('refuses files above maxDocumentSizeMb', async () => {
    const f = await writeTemp(dir, 'a'.repeat(200_000), 'txt');
    await expect(processDocument({ ...f, fileName: 'a.txt' }, { ...settings, maxDocumentSizeMb: 0.1 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
  });
});
