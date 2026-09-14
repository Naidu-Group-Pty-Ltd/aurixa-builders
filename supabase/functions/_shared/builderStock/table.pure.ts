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
 */
export function parseDelimited(input: string, delimiter?: string): string[][] {
  // Escaped rather than literal: a raw BOM in source is invisible and lint
  // rejects it as irregular whitespace.
  const text = input.replace(/^\uFEFF/, '');
  const sep = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === sep) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
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
