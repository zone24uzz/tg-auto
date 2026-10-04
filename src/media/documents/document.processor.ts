import { readFile } from 'node:fs/promises';
import type { SniffedType } from '../../security/files.js';
import type { Settings } from '../../settings/schema.js';
import { MediaTooLargeError, UnsupportedMediaError } from '../errors.js';
import { bytesFromMb, checkSize, truncateChars } from '../limits.js';
import { extractCsvText } from './csv.js';
import { detectDocumentFormat, type DocumentFormat } from './detect.js';
import { extractDocxText } from './docx.js';
import { extractPdfText } from './pdf.js';
import { extractPlainText } from './text.js';
import { extractXlsxText } from './xlsx.js';
import { DEFAULT_ZIP_LIMITS, inspectOfficeZip } from './zip-guard.js';

export type { DocumentFormat } from './detect.js';

export interface DocumentProcessorInput {
  path: string;
  sniffed: SniffedType;
  /** Sanitized display name (extension is a hint only). */
  fileName?: string | null;
  /** Telegram-reported MIME type (hint only). */
  mimeType?: string | null;
}

export type DocumentProcessorSettings = Pick<Settings, 'maxDocumentSizeMb' | 'maxDocumentChars'>;

export interface DocumentExtraction {
  text: string;
  truncated: boolean;
  format: DocumentFormat;
}

/** Text extraction for PDF / DOCX / XLSX / CSV / TSV / TXT / MD / JSON / LOG. Never executes anything. */
export async function processDocument(
  input: DocumentProcessorInput,
  settings: DocumentProcessorSettings,
): Promise<DocumentExtraction> {
  const buf = await readFile(input.path);
  const sizeCheck = checkSize(buf.length, settings.maxDocumentSizeMb);
  if (!sizeCheck.ok) {
    throw new MediaTooLargeError(`document ${sizeCheck.reason}`, {
      sizeBytes: buf.length,
      limitBytes: bytesFromMb(settings.maxDocumentSizeMb),
    });
  }

  const detected = detectDocumentFormat({
    head: buf.subarray(0, 8192),
    sniffed: input.sniffed,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  if (!detected.ok) throw new UnsupportedMediaError(detected.reason, detected.typeLabel);

  let format: DocumentFormat;
  if (detected.format === 'docx' || detected.format === 'xlsx' || detected.format === 'ooxml') {
    const zip = await inspectOfficeZip(buf, DEFAULT_ZIP_LIMITS);
    if (zip.kind === 'other') throw new UnsupportedMediaError('archive is not a DOCX/XLSX document', 'zip');
    if (detected.format !== 'ooxml' && zip.kind !== detected.format) {
      throw new UnsupportedMediaError(`file content does not match .${detected.format}`, detected.format);
    }
    format = zip.kind;
  } else {
    format = detected.format;
  }

  const maxChars = settings.maxDocumentChars;
  let raw: string;
  let extractorTruncated = false;
  switch (format) {
    case 'pdf': {
      const r = await extractPdfText(buf, { maxChars });
      raw = r.text;
      extractorTruncated = r.truncated;
      break;
    }
    case 'docx':
      raw = (await extractDocxText(buf)).text;
      break;
    case 'xlsx': {
      const r = await extractXlsxText(buf);
      raw = r.text;
      extractorTruncated = r.truncated;
      break;
    }
    case 'csv':
    case 'tsv': {
      const text = extractPlainText(buf).text;
      const r = extractCsvText(text, format === 'tsv' ? { delimiter: '\t' } : {});
      raw = r.text;
      extractorTruncated = r.truncated;
      break;
    }
    case 'text':
      raw = extractPlainText(buf).text;
      break;
    default:
      throw new UnsupportedMediaError('unsupported document format', String(format));
  }

  const normalized = normalizeText(raw);
  const cut = truncateChars(normalized, maxChars);
  return { text: cut.text, truncated: cut.truncated || extractorTruncated, format };
}

/** Normalizes newlines/whitespace and strips control characters (keeps \n and \t). */
export function normalizeText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim()
  );
}
