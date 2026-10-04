import { looksLikeText } from '../../security/files.js';
import { UnsupportedMediaError } from '../errors.js';

/**
 * Decodes a text file: UTF-8 (with/without BOM) or UTF-16 with a BOM.
 * Returns null when the bytes do not look like text.
 */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return sanitizeDecoded(new TextDecoder('utf-16le').decode(buf.subarray(2)));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return sanitizeDecoded(new TextDecoder('utf-16be').decode(buf.subarray(2)));
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  if (!looksLikeText(body)) return null;
  return body.toString('utf8');
}

function sanitizeDecoded(text: string): string | null {
  // UTF-16 decoding of binary data produces many control characters.
  const sample = text.slice(0, 8192);
  let control = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  if (sample.length > 0 && control / sample.length >= 0.02) return null;
  return text;
}

/** TXT / MD / JSON / LOG → text. Never parses or evaluates the content. */
export function extractPlainText(buf: Buffer): { text: string } {
  const text = decodeText(buf);
  if (text === null) throw new UnsupportedMediaError('file does not look like text', 'binary');
  return { text: text.replace(/\r\n?/g, '\n') };
}
