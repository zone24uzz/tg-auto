import mammoth from 'mammoth';
import { UnsupportedMediaError } from '../errors.js';

/** DOCX → raw text via mammoth (no HTML conversion, no external resources). Run inspectOfficeZip first. */
export async function extractDocxText(buf: Buffer): Promise<{ text: string }> {
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    return { text: result.value };
  } catch {
    throw new UnsupportedMediaError('the DOCX document could not be parsed', 'docx');
  }
}
