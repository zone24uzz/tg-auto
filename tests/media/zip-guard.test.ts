import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { inspectOfficeZip } from '../../src/media/documents/zip-guard.js';
import { UnsupportedMediaError } from '../../src/media/errors.js';

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

async function expectRefused(buf: Buffer, pattern: RegExp, limits?: Parameters<typeof inspectOfficeZip>[1]) {
  const err = await inspectOfficeZip(buf, limits).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnsupportedMediaError);
  expect((err as Error).message).toMatch(pattern);
}

describe('inspectOfficeZip', () => {
  it('accepts a small DOCX-like archive and reports its kind', async () => {
    const buf = await zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
    const r = await inspectOfficeZip(buf);
    expect(r.kind).toBe('docx');
    expect(r.entryNames).toContain('word/document.xml');
  });

  it('refuses archives that expand beyond 50 MB (zip bomb)', async () => {
    const buf = await zipOf({ 'xl/workbook.xml': '<w/>', 'xl/sharedStrings.xml': Buffer.alloc(60 * 1024 * 1024, 0x41) });
    expect(buf.length).toBeLessThan(1024 * 1024);
    await expectRefused(buf, /zip bomb/);
  });

  it('refuses archives whose headers lie about the uncompressed size', async () => {
    const buf = await zipOf({ 'word/document.xml': Buffer.alloc(8 * 1024 * 1024, 0x41) });
    // Patch the declared uncompressed size in every central directory record to 100 bytes.
    for (let i = 0; i + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50) buf.writeUInt32LE(100, i + 24);
    }
    await expectRefused(buf, /zip bomb/, { maxEntries: 2000, maxUncompressedBytes: 1024 * 1024 });
  });

  it('refuses archives with too many entries', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`f/${i}.xml`] = 'x';
    await expectRefused(await zipOf(files), /too many entries/);
  });

  it('refuses documents with macros (vbaProject.bin)', async () => {
    const buf = await zipOf({ 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': Buffer.from([1, 2, 3]) });
    await expectRefused(buf, /macros/);
  });

  it('refuses garbage', async () => {
    await expectRefused(Buffer.from('PK\u0003\u0004 definitely not a zip', 'latin1'), /corrupt/);
  });
});
