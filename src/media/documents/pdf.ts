import { getDocumentProxy } from 'unpdf';
import { UnsupportedMediaError } from '../errors.js';

export const PDF_DEFAULT_MAX_PAGES = 300;

export interface PdfExtraction {
  text: string;
  truncated: boolean;
  pages: number;
}

/**
 * Extracts the text layer of a PDF with unpdf (pdf.js). Scripts/XFA are never run; fonts are not loaded.
 * Stops early once `maxChars` characters (or `maxPages` pages) were collected.
 */
export async function extractPdfText(
  buf: Buffer,
  opts: { maxChars: number; maxPages?: number },
): Promise<PdfExtraction> {
  const maxPages = Math.max(1, opts.maxPages ?? PDF_DEFAULT_MAX_PAGES);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Copy: pdf.js may transfer (detach) the underlying ArrayBuffer.
    pdf = await getDocumentProxy(new Uint8Array(buf), {
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') throw new UnsupportedMediaError('password-protected PDF', 'encrypted pdf');
    throw new UnsupportedMediaError('the PDF could not be parsed', 'pdf');
  }

  try {
    const total = pdf.numPages;
    const parts: string[] = [];
    let chars = 0;
    let truncated = total > maxPages;
    const last = Math.min(total, maxPages);
    for (let n = 1; n <= last; n++) {
      const page = await pdf.getPage(n);
      try {
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if ('str' in item) pageText += item.str + (item.hasEOL ? '\n' : '');
        }
        const cleaned = pageText.replace(/[ \t]+\n/g, '\n').trim();
        if (cleaned) {
          parts.push(cleaned);
          chars += cleaned.length;
        }
      } finally {
        page.cleanup();
      }
      if (chars > opts.maxChars) {
        truncated = truncated || n < total;
        break;
      }
    }
    return { text: parts.join('\n\n'), truncated, pages: total };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
