import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Display-safe file name: no path separators, control chars or traversal; max 120 chars. */
export function sanitizeFileName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** Lowercase extension of a display name, without the dot ("" when none). */
export function extensionOf(name: string | undefined): string {
  if (!name) return '';
  const ext = path.extname(name).toLowerCase().replace('.', '');
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * Creates a random file path inside `dir`. The name never comes from user input,
 * which rules out path traversal by construction; the check is defence in depth.
 */
export function safeTempPath(dir: string, ext = 'bin'): string {
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
  const root = path.resolve(dir);
  const full = path.resolve(root, `${randomUUID()}.${safeExt}`);
  assertInside(root, full);
  return full;
}

export function assertInside(root: string, candidate: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path escapes the allowed directory');
  }
}

export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  | 'application/zip'
  | 'audio/ogg'
  | 'audio/mpeg'
  | 'audio/wav'
  | 'audio/flac'
  | 'video/mp4'
  | 'video/webm'
  | 'application/x-ole-storage'
  | 'application/x-executable'
  | 'unknown';

/** Magic-byte sniffing for the formats we accept (and a few we must refuse). */
export function sniffMime(buf: Buffer): SniffedType {
  const b = buf;
  const at = (i: number) => b[i] ?? -1;
  const ascii = (start: number, end: number) => b.subarray(start, end).toString('latin1');
  if (b.length < 4) return 'unknown';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (at(0) === 0x50 && at(1) === 0x4b && (at(2) === 0x03 || at(2) === 0x05) && (at(3) === 0x04 || at(3) === 0x06))
    return 'application/zip';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3' || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video/webm';
  if (at(0) === 0xd0 && at(1) === 0xcf && at(2) === 0x11 && at(3) === 0xe0) return 'application/x-ole-storage';
  if ((at(0) === 0x4d && at(1) === 0x5a) || ascii(0, 4) === '\x7fELF') return 'application/x-executable';
  return 'unknown';
}

/** Heuristic: looks like UTF-8/ASCII text (no NUL bytes, few control chars). */
export function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.length === 0) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / sample.length < 0.02;
}
