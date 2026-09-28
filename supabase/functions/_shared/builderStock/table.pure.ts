/**
 * Builder stock lists — turning a rectangle of cells into rows.
 *
 * Two jobs, both pure:
 *   1. parse delimited text (CSV / TSV) into a matrix, quotes and all;
 *   2. find the HEADER row in a matrix and key the rows by it.
 *
 * (2) is the one that matters. Real stock lists open with a logo row, a
 * "STOCK LIST — MARCH" title, a blank line and then the headings, so taking
 * row 0 as the header produces a table keyed by `__EMPTY_3` and imports
 * nothing. The header is found by asking which row's cells are the most
 * recognisable column names, which is a question `normalise.pure.ts` already
 * answers cell by cell.
 */
import { fieldForHeader } from './normalise.pure.ts';

/**
 * Parse CSV/TSV. RFC-4180 quoting: `""` inside a quoted field is a literal
 * quote, and a newline inside quotes does not end the record.
 *
 * The rows only. A record whose quotation marks do not pair up is left out
 * rather than returned with another row's text in its cells — see
 * `parseDelimitedReport`, which also says which records those were.
 */
export function parseDelimited(input: string, delimiter?: string): string[][] {
  return parseDelimitedReport(input, delimiter).rows;
}

/** A record the reader could not split into cells, and so did not return. */
export interface MalformedRecord {
  /** The 1-based line of the input the record STARTS on — a cell may span lines. */
  line: number;
  /** The start of the record's own text, on one line, at most 60 characters. */
  preview: string;
}

export interface DelimitedReport {
  /** Every record read, blank ones dropped. A malformed record is never here. */
  rows: string[][];
  /** The first `MALFORMED_ROWS_KEPT` records whose quotation marks did not pair up, in the order read. */
  malformed: MalformedRecord[];
  /** How many records were broken in all. */
  malformedTotal: number;
}

/** How much of a broken record is quoted back to the builder. */
const PREVIEW_CHARS = 60;

/**
 * Parse CSV/TSV, and say which records could not be read.
 *
 * RFC-4180 quoting, as `parseDelimited` describes. A quote that closes is
 * simply followed by whatever comes next, which is what lets a sloppy
 * `"Stunning" home` read as `Stunning home`.
 *
 * ONE STRAY QUOTE USED TO FLIP THE REST OF THE FILE. MEASURED 28 SEPTEMBER
 * 2026 in production (Tier-0 audit, `scripts/ops/fixtures/tier0/neg/
 * malformed.csv`): a row whose price opened with a quotation mark and never
 * closed it — `…,150,"$500,000,Available,PROOF ONLY` — was read as one quoted
 * cell running on into the next row. The list imported ONE property, lot 701,
 * whose `price_display` was `$500,000,Available,PROOF ONLY T0-702,Kestrel
 * Grove,702,3 Edg…` (111 characters of the next row), lost lot 702 entirely,
 * and reported `detected 1, failed 0`. The builder was told nothing.
 *
 * A reader cannot know which quote was the mistake, but two shapes are only
 * ever made by one:
 *
 *   1. the input ENDS inside a quoted section;
 *   2. a quoted section that CROSSED A LINE BREAK is closed by a quote that is
 *      not followed by the separator, a line break or the end of the input.
 *      A real multi-line cell — a description with line breaks in it, common
 *      in real exports — always closes where its cell ends.
 *
 * A quoted section that stays on one line and closes before other text is
 * neither: `"Stunning" home` parses exactly as it always has.
 *
 * Either shape takes back the quote that OPENED the section: it becomes an
 * ordinary character and the record is read on from there as though it had
 * never opened anything, so the record ends at its own line break. That
 * record is reported in `malformed` and not returned — its columns do not
 * line up and nothing says where they went wrong — and every record after it
 * is read as normal. Each take-back is of a quote further on than the last,
 * so the reader always finishes, and a file with several broken rows has
 * each of them recovered.
 *
 * On input where neither shape occurs, `rows` is byte for byte what this
 * reader returned before any of this existed.
 */
export function parseDelimitedReport(input: string, delimiter?: string): DelimitedReport {
  // Escaped rather than literal: a raw BOM in source is invisible and lint
  // rejects it as irregular whitespace.
  const text = input.replace(/^\uFEFF/, '');
  const sep = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  const malformed: MalformedRecord[] = [];
  let malformedTotal = 0;
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // The record being read: where it began, and whether it was found broken.
  let line = 1;
  let recordStart = 0;
  let recordLine = 1;
  let recordBroken = false;

  // The quoted section being read — enough to take its opening quote back.
  let openedAt = 0;
  let openedOnLine = 1;
  let fieldBeforeQuote = '';
  let crossedLine = false;

  const endRecord = (end: number) => {
    row.push(field);
    if (recordBroken) {
      malformedTotal += 1;
      // Bounded: a pathological file can break every line, and only the first
      // few are ever named to the builder.
      if (malformed.length < MALFORMED_ROWS_KEPT) {
        malformed.push({ line: recordLine, preview: previewOf(text.slice(recordStart, end)) });
      }
    } else if (row.some((cell) => cell.trim() !== '')) {
      rows.push(row);
    }
    row = [];
    field = '';
    recordBroken = false;
  };

  /*
   * The opening quote becomes an ordinary character of its cell, and reading
   * resumes just after it with no section open. Nothing but the cell grew
   * while the section was open — a line break inside quotes ends no record —
   * so the cell and the line count are all there is to put back. Returns the
   * quote's own index; the loop's step moves past it.
   */
  const takeBack = (): number => {
    field = `${fieldBeforeQuote}"`;
    quoted = false;
    line = openedOnLine;
    recordBroken = true;
    return openedAt;
  };

  for (let i = 0; i < text.length || quoted; i++) {
    // Shape 1: the input ended inside a quoted section.
    if (i >= text.length) { i = takeBack(); continue; }
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else {
          quoted = false;
          // Shape 2: it crossed a line, and did not close where a cell ends.
          if (crossedLine && !closesCell(text, i + 1, sep)) i = takeBack();
        }
      } else {
        if (char === '\n') { crossedLine = true; line++; }
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      openedAt = i;
      openedOnLine = line;
      fieldBeforeQuote = field;
      crossedLine = false;
      continue;
    }
    if (char === sep) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      endRecord(i);
      line++;
      recordStart = i + 1;
      recordLine = line;
      continue;
    }
    field += char;
  }

  if (field.length || row.length) endRecord(text.length);
  return { rows, malformed, malformedTotal };
}

/** Where a quoted cell may close: before a separator, a line break or the end. */
function endsCell(next: string | undefined, sep: string): boolean {
  return next === undefined || next === sep || next === '\r' || next === '\n';
}

/**
 * Where a quoted cell may close, allowing the spaces a hand-edited sheet puts
 * after a closing quote (`"…with pool" ,500000`) — never the separator itself,
 * so a tab-separated file keeps its tabs.
 */
function closesCell(text: string, from: number, sep: string): boolean {
  let at = from;
  while ((text[at] === ' ' || text[at] === '\t') && text[at] !== sep) at += 1;
  return endsCell(text[at], sep);
}

/** A broken record's text on one line, cut to what a sentence can quote. */
function previewOf(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
}

/** Broken rows named one by one; any beyond this are counted in one line. */
const MALFORMED_ROWS_NAMED = 10;
/** Broken records a report holds; any beyond this are counted, not kept. */
export const MALFORMED_ROWS_KEPT = 100;

/**
 * What a builder is told about the records `parseDelimitedReport` could not
 * read: one sentence per record, naming its line and quoting its start so it
 * can be found, and saying what to do about it.
 *
 * "Import the corrected list", not "read it again": reading an UPLOADED file
 * again re-reads the same bytes (`sourceReread.pure.ts`), so the corrected
 * list has to arrive as a new upload, or through its link if it was linked.
 */
export function malformedRecordWarnings(
  malformed: readonly MalformedRecord[],
  total: number = malformed.length,
): string[] {
  const warnings = malformed.slice(0, MALFORMED_ROWS_NAMED).map(({ line, preview }) =>
    `Line ${line} could not be read: its quotation marks do not pair up, so its columns `
    + `cannot be told apart. Correct the quotes in that row${preview ? ` (it begins “${preview}”)` : ''} `
    + 'and import the corrected list.');
  const rest = Math.max(total, malformed.length) - warnings.length;
  if (rest > 0) {
    warnings.push(`…and ${rest} more row${rest === 1 ? '' : 's'} could not be read for the same reason.`);
  }
  return warnings;
}

/** Comma unless the first few lines clearly prefer a tab or a semicolon. */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts: Array<[string, number]> = [
    [',', (sample.match(/,/g) || []).length],
    ['\t', (sample.match(/\t/g) || []).length],
    [';', (sample.match(/;/g) || []).length],
    ['|', (sample.match(/\|/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** How many of a row's cells look like column headings we recognise. */
export function headerScore(cells: unknown[]): number {
  const seen = new Set<string>();
  for (const cell of cells) {
    const field = fieldForHeader(cell);
    if (field) seen.add(field);
  }
  return seen.size;
}

export interface KeyedRows {
  headerRowIndex: number;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  /**
   * `rowIndexes[i]` is the index in the ORIGINAL matrix that `rows[i]` came
   * from. Blank rows are skipped and a header row sits above them, so the two
   * indexes are never the same number — and an image anchored to sheet row 12
   * has to be able to find the property that sheet row 12 became.
   */
  rowIndexes: number[];
}

/**
 * Key a matrix by its header row.
 *
 * Scans the first `maxScan` rows for the best header candidate and requires at
 * least two recognised columns before accepting one. Below that threshold the
 * matrix is not a stock table — an LLM pass will read it as text instead,
 * which is the right answer for a brochure laid out in a Word table.
 */
export function keyRowsByHeader(
  matrix: unknown[][],
  options: { maxScan?: number; minScore?: number } = {},
): KeyedRows | null {
  const maxScan = options.maxScan ?? 15;
  const minScore = options.minScore ?? 2;

  let bestIndex = -1;
  let bestScore = 0;
  const limit = Math.min(matrix.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const score = headerScore(matrix[i] ?? []);
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  if (bestIndex < 0 || bestScore < minScore) return null;

  const headerCells = matrix[bestIndex] ?? [];
  const headers = headerCells.map((cell, column) => {
    const label = String(cell ?? '').replace(/\s+/g, ' ').trim();
    // A blank heading still needs a stable key, or two blank columns collapse
    // onto one another and the second silently wins.
    return label || `column_${column + 1}`;
  });

  const rows: Array<Record<string, unknown>> = [];
  const rowIndexes: number[] = [];
  for (let i = bestIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    if (!cells.some((cell) => String(cell ?? '').trim() !== '')) continue;
    const row: Record<string, unknown> = {};
    for (let column = 0; column < headers.length; column++) {
      row[headers[column]] = cells[column] ?? null;
    }
    rows.push(row);
    rowIndexes.push(i);
  }

  return { headerRowIndex: bestIndex, headers, rows, rowIndexes };
}
