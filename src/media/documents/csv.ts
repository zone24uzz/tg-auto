/** Small RFC 4180 CSV parser (quoted fields, "" escapes, delimiters/newlines inside quotes). No eval, no deps. */

export const CSV_DEFAULT_MAX_ROWS = 200;
export const CSV_DEFAULT_MAX_COLS = 30;

export interface CsvParseOptions {
  /** Field delimiter; auto-detected (, ; tab |) when omitted. */
  delimiter?: string;
  maxRows?: number;
  maxCols?: number;
}

export interface CsvParseResult {
  rows: string[][];
  delimiter: string;
  /** More rows existed than maxRows. */
  truncatedRows: boolean;
  /** At least one row had more than maxCols fields. */
  truncatedCols: boolean;
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/** Picks the delimiter that occurs most often (outside quotes) in the first lines. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192);
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let lines = 0;
  for (let i = 0; i < sample.length && lines < 10; i++) {
    const ch = sample[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === '\n') lines++;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    const c = counts.get(d) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

export function parseCsv(input: string, opts: CsvParseOptions = {}): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = opts.delimiter && opts.delimiter.length === 1 ? opts.delimiter : detectDelimiter(text);
  const maxRows = Math.max(1, opts.maxRows ?? CSV_DEFAULT_MAX_ROWS);
  const maxCols = Math.max(1, opts.maxCols ?? CSV_DEFAULT_MAX_COLS);

  const rows: string[][] = [];
  let truncatedRows = false;
  let truncatedCols = false;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = (): boolean => {
    endField();
    const blank = row.length === 1 && row[0] === '';
    if (!blank) {
      if (rows.length >= maxRows) {
        truncatedRows = true;
        return false;
      }
      if (row.length > maxCols) {
        truncatedCols = true;
        row = row.slice(0, maxCols);
      }
      rows.push(row);
    }
    row = [];
    return true;
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      field = '';
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (!endRow()) break;
      continue;
    }
    // Leading spaces before an opening quote are tolerated (`a, "b"`).
    if (!(ch === ' ' && !fieldStarted && field.trim() === '')) fieldStarted = true;
    field += ch;
    i++;
  }
  if (!truncatedRows && (field !== '' || row.length > 0 || fieldStarted)) endRow();

  return { rows, delimiter, truncatedRows, truncatedCols };
}

/** CSV/TSV text → tab-separated text for the model. */
export function extractCsvText(
  input: string | Buffer,
  opts: CsvParseOptions = {},
): { text: string; truncated: boolean; rows: number } {
  const parsed = parseCsv(typeof input === 'string' ? input : input.toString('utf8'), opts);
  const lines = parsed.rows.map((r) =>
    r
      .map((cell) => cell.replace(/[\t\r\n]+/g, ' ').trim())
      .join('\t')
      .replace(/\t+$/, ''),
  );
  const notes: string[] = [];
  if (parsed.truncatedRows) notes.push(`only the first ${parsed.rows.length} rows are shown`);
  if (parsed.truncatedCols) notes.push(`only the first ${opts.maxCols ?? CSV_DEFAULT_MAX_COLS} columns are shown`);
  const body = lines.join('\n');
  return {
    text: notes.length ? `${body}\n[${notes.join('; ')}]` : body,
    truncated: parsed.truncatedRows || parsed.truncatedCols,
    rows: parsed.rows.length,
  };
}
