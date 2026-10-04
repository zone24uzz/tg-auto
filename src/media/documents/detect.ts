import { extensionOf, looksLikeText, type SniffedType } from '../../security/files.js';

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'tsv' | 'text';
/** 'ooxml' = a zip whose kind (docx/xlsx) is decided after inspecting its entries. */
export type DetectedFormat = DocumentFormat | 'ooxml';

export type DetectResult = { ok: true; format: DetectedFormat } | { ok: false; reason: string; typeLabel: string };

type Family = 'pdf' | 'docx' | 'xlsx' | 'textual';

/** Macro-enabled / legacy Office, executables and scripts: never analysed. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'doc', 'docm', 'dot', 'dotm', 'xls', 'xlsm', 'xlsb', 'xlt', 'xltm', 'xla', 'xlam', 'ppt', 'pptm', 'potm', 'ppsm', 'ppam', 'rtf',
  'exe', 'dll', 'msi', 'msp', 'com', 'scr', 'cpl', 'sys', 'bin', 'elf', 'so', 'dylib', 'app', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'ts', 'wsf', 'wsh', 'hta', 'jar', 'class',
  'sh', 'bash', 'zsh', 'csh', 'fish', 'py', 'pyc', 'pyw', 'rb', 'pl', 'php', 'lnk', 'reg', 'inf', 'iso', 'img', 'vhd',
]);

const EXT_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
  tsv: 'tsv',
  txt: 'text',
  text: 'text',
  md: 'text',
  markdown: 'text',
  json: 'text',
  log: 'text',
};

const MIME_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/comma-separated-values': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/x-markdown': 'text',
  'application/json': 'text',
  'text/json': 'text',
  'text/x-log': 'text',
};

const BLOCKED_MIMES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel.addin.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sh',
  'application/x-bat',
  'application/javascript',
  'text/javascript',
  'application/x-python-code',
  'text/x-python',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/rtf',
  'text/rtf',
]);

const GENERIC_MIMES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
  'application/force-download',
  'application/unknown',
]);

/**
 * Quick decision from the display extension alone (before downloading): false for blocked
 * or unknown extensions. Files without an extension are decided after download.
 */
export function isAcceptedDocumentExtension(ext: string): boolean {
  if (!ext) return true;
  return !BLOCKED_EXTENSIONS.has(ext) && EXT_FORMATS[ext] !== undefined;
}

function familyOf(format: DocumentFormat): Family {
  if (format === 'pdf' || format === 'docx' || format === 'xlsx') return format;
  return 'textual';
}

function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

function looksLikeTextual(head: Buffer, sniffed: SniffedType): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return true; // UTF-16 with BOM; verified again when decoding
  }
  // sniffMime can mistake text for MPEG audio (e.g. a file starting with "ID3"); text check decides.
  return (sniffed === 'unknown' || sniffed === 'audio/mpeg') && looksLikeText(head);
}

/**
 * Decides the document format from the extension, the Telegram MIME type and the magic bytes together.
 * Anything inconsistent (".pdf" that is not %PDF-, ".docx" whose MIME says PDF, …) is rejected.
 */
export function detectDocumentFormat(input: {
  head: Buffer;
  sniffed: SniffedType;
  fileName?: string | null;
  mimeType?: string | null;
}): DetectResult {
  const ext = extensionOf(input.fileName ?? undefined);
  const mime = normalizeMime(input.mimeType);
  const { sniffed, head } = input;

  if (ext && BLOCKED_EXTENSIONS.has(ext)) return { ok: false, reason: `.${ext} files are not accepted`, typeLabel: ext };
  if (BLOCKED_MIMES.has(mime)) return { ok: false, reason: `${mime} is not accepted`, typeLabel: ext || mime };
  if (sniffed === 'application/x-executable') return { ok: false, reason: 'executable file', typeLabel: ext || 'executable' };
  if (sniffed === 'application/x-ole-storage') {
    return { ok: false, reason: 'legacy Office (OLE) files are not accepted', typeLabel: ext || 'ole' };
  }

  const extFormat = ext ? EXT_FORMATS[ext] : undefined;
  if (ext && !extFormat) return { ok: false, reason: `.${ext} files are not supported`, typeLabel: ext };
  const mimeFormat = GENERIC_MIMES.has(mime) ? undefined : MIME_FORMATS[mime];
  if (extFormat && mimeFormat && familyOf(extFormat) !== familyOf(mimeFormat)) {
    return { ok: false, reason: `extension .${ext} does not match MIME type ${mime}`, typeLabel: ext };
  }

  const claimed: DocumentFormat | undefined = extFormat ?? mimeFormat;
  if (claimed) {
    const family = familyOf(claimed);
    if (family === 'pdf' && sniffed !== 'application/pdf') {
      return { ok: false, reason: 'file content is not a PDF', typeLabel: ext || 'pdf' };
    }
    if ((family === 'docx' || family === 'xlsx') && sniffed !== 'application/zip') {
      return { ok: false, reason: `file content is not a ${claimed.toUpperCase()} document`, typeLabel: ext || claimed };
    }
    if (family === 'textual' && !looksLikeTextual(head, sniffed)) {
      return { ok: false, reason: 'file content is not text', typeLabel: ext || claimed };
    }
    return { ok: true, format: claimed };
  }

  // Neither extension nor MIME decided: trust only the bytes.
  if (sniffed === 'application/pdf') return { ok: true, format: 'pdf' };
  if (sniffed === 'application/zip') return { ok: true, format: 'ooxml' };
  if (mime && !GENERIC_MIMES.has(mime) && !mime.startsWith('text/')) {
    return { ok: false, reason: `${mime} is not supported`, typeLabel: mime };
  }
  if (looksLikeTextual(head, sniffed)) return { ok: true, format: 'text' };
  return { ok: false, reason: 'unrecognised file type', typeLabel: sniffed === 'unknown' ? 'unknown' : sniffed };
}
