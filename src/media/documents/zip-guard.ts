import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { BYTES_PER_MB } from '../limits.js';
import { UnsupportedMediaError } from '../errors.js';

/**
 * Zip-bomb and macro guard for OOXML containers (DOCX/XLSX), run before any parser touches them.
 * - entry count and declared uncompressed sizes from the central directory;
 * - the real decompressed size of every entry (zlib with a hard output cap), so lying headers do not help;
 * - refuses macros (vbaProject.bin), encrypted entries, ZIP64 and exotic compression methods;
 * - JSZip must also be able to open the archive (structure check, entry names).
 */

export interface ZipGuardLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipGuardLimits = { maxEntries: 2000, maxUncompressedBytes: 50 * BYTES_PER_MB };

export interface ZipInspection {
  entryNames: string[];
  totalUncompressedBytes: number;
  kind: 'docx' | 'xlsx' | 'other';
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function refuse(reason: string, label = 'zip'): never {
  throw new UnsupportedMediaError(reason, label);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readCentralDirectory(buf: Buffer, limits: ZipGuardLimits): CentralEntry[] {
  if (buf.length < 22) refuse('corrupt archive');
  const eocd = findEocd(buf);
  if (eocd < 0) refuse('corrupt archive (no end of central directory)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) refuse('ZIP64 archives are not accepted');
  if (total > limits.maxEntries) refuse(`archive has too many entries (${total} > ${limits.maxEntries})`);
  if (cdOffset + cdSize > buf.length) refuse('corrupt archive (central directory out of bounds)');

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) refuse('corrupt archive (bad central directory)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) refuse('corrupt archive (bad entry name)');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function isMacroEntry(name: string): boolean {
  const lower = name.replace(/\\/g, '/').toLowerCase();
  return lower.endsWith('vbaproject.bin') || lower.endsWith('vbadata.xml');
}

function entryData(buf: Buffer, entry: CentralEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOCAL) refuse('corrupt archive (bad local header)');
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) refuse('corrupt archive (entry data out of bounds)');
  return buf.subarray(start, end);
}

/** Throws UnsupportedMediaError when the archive is unsafe; otherwise describes it. */
export async function inspectOfficeZip(buf: Buffer, limits: ZipGuardLimits = DEFAULT_ZIP_LIMITS): Promise<ZipInspection> {
  const entries = readCentralDirectory(buf, limits);

  if (entries.some((e) => isMacroEntry(e.name))) refuse('documents with macros are not accepted', 'macro');
  if (entries.some((e) => (e.flags & 0x1) !== 0)) refuse('password-protected archives are not accepted', 'encrypted');
  const declared = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  if (declared > limits.maxUncompressedBytes) refuse('archive expands beyond the allowed size (zip bomb guard)', 'zip bomb');

  // Verify real decompressed sizes with a hard cap (headers can lie).
  let actual = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const data = entryData(buf, entry);
    const remaining = limits.maxUncompressedBytes - actual;
    if (entry.method === 0) {
      actual += data.length;
    } else if (entry.method === 8) {
      try {
        actual += inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) }).length;
      } catch (error) {
        if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          refuse('archive expands beyond the allowed size (zip bomb guard)', 'zip bomb');
        }
        refuse('corrupt archive (bad compressed data)');
      }
    } else {
      refuse(`unsupported zip compression method ${entry.method}`);
    }
    if (actual > limits.maxUncompressedBytes) refuse('archive expands beyond the allowed size (zip bomb guard)', 'zip bomb');
  }

  // Structural check with JSZip (also gives normalized entry names).
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: false });
  } catch {
    refuse('corrupt archive');
  }
  const names = Object.keys(zip.files);
  if (names.length > limits.maxEntries) refuse(`archive has too many entries (${names.length})`);
  if (names.some(isMacroEntry)) refuse('documents with macros are not accepted', 'macro');

  const nameSet = new Set(names.map((n) => n.replace(/\\/g, '/').replace(/^\/+/, '')));
  const kind = nameSet.has('word/document.xml') ? 'docx' : nameSet.has('xl/workbook.xml') ? 'xlsx' : 'other';
  return { entryNames: [...nameSet], totalUncompressedBytes: actual, kind };
}
