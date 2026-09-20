/**
 * The deterministic PDF stage, where it meets the pipeline.
 *
 * Three things are proved here and they are different kinds of evidence.
 *
 * WHAT THE OTHER FORMATS DO is proved by RUNNING them: `extractStockFile`'s
 * static imports are all local pure modules, so a CSV, a TSV and an HTML table
 * go through the real reader in this process and their rows are compared
 * against what they produced before this stage existed.
 *
 * WHAT SPENDS MONEY is proved by running the real `extractStockRowsFromText`
 * against a fake budget: it is the only door to a provider, and it takes a
 * hold before it opens. So "the model was not called" and "nothing was
 * reserved" are one fact rather than two, and the first is what the row count
 * decides.
 *
 * WHERE THE DECISION IS MADE is pinned at the SOURCE, the way this repository
 * already pins an Edge handler it cannot import into Node — the PDF branch
 * reaches pdf.js through an esm.sh URL that does not resolve here. The
 * property that matters is not what the branch computes but that it writes
 * `result.rows` on ONE status and that `runImport`'s existing guard is the
 * only thing that decides whether a model runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const callLLM = vi.fn();
vi.mock('../../../supabase/functions/_shared/llmRouter.ts', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

// eslint-disable-next-line import/first
import {
  extractStockRowsFromText,
} from '../../../supabase/functions/_shared/builderStock/modelExtract';
// eslint-disable-next-line import/first
import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract';
// eslint-disable-next-line import/first
import { classifyStockFile } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';
// eslint-disable-next-line import/first
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
// eslint-disable-next-line import/first
import type { AiBudgetPort } from '../../../supabase/functions/_shared/builderStock/aiBudget';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// H — every other format reads exactly as it did
// ---------------------------------------------------------------------------

const CSV = [
  'ACME HOMES — STOCK LIST',
  '',
  'Estate,Lot,Design,Beds,Bath,Car,Land,Package Price',
  'Palomino Estate,315,Enzo 8.5,4,2,2,350,"$863,850"',
  'Society 1056,717,Enzo 10.5,3,2,2,271,"$741,655"',
].join('\n');

describe('the formats this change does not touch', () => {
  it('CSV still reads its table deterministically', async () => {
    const result = await extractStockFile(
      bytes(CSV), 'stock.csv', classifyStockFile('stock.csv', 'text/csv'));
    expect(result.strategy).toBe('delimited_table');
    expect(result.rows).toHaveLength(2);
    expect(result.deterministicReading).toBeUndefined();

    const records = result.rows.map((row) => normaliseStockRow(row)!);
    expect(records.map((r) => [r.development_name, r.lot_number, r.price]))
      .toEqual([['Palomino Estate', '315', 863850], ['Society 1056', '717', 741655]]);
  });

  it('TSV still reads its table deterministically', async () => {
    const tsv = CSV.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, '\t').replace(/"/g, '');
    const result = await extractStockFile(
      bytes(tsv), 'stock.tsv', classifyStockFile('stock.tsv', 'text/tab-separated-values'));
    expect(result.strategy).toBe('delimited_table');
    expect(result.rows).toHaveLength(2);
    expect(result.deterministicReading).toBeUndefined();
  });

  it('delimited prose with no headings still falls to text, not to rows', async () => {
    const result = await extractStockFile(
      bytes('Welcome to Palomino Estate.\nHomes for families.'),
      'note.csv', classifyStockFile('note.csv', 'text/csv'));
    expect(result.rows).toEqual([]);
    expect(result.text).toBeTruthy();
    // The assisted reader is still what reads this, exactly as before.
    expect(result.deterministicReading).toBeUndefined();
  });

  it('an HTML table still reads its rows', async () => {
    const html = '<table><tr><th>Estate</th><th>Lot</th><th>Package Price</th></tr>'
      + '<tr><td>Palomino Estate</td><td>315</td><td>$863,850</td></tr></table>';
    const result = await extractStockFile(
      bytes(html), 'stock.html', classifyStockFile('stock.html', 'text/html'));
    expect(result.strategy).toBe('html_table');
    expect(result.rows).toHaveLength(1);
    expect(result.deterministicReading).toBeUndefined();
  });

  it('the deterministic reading is set by the PDF branch and by nothing else', () => {
    const source = read('supabase/functions/_shared/builderStock/extract.ts');
    const assignments = source.match(/result\.deterministicReading\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    // And it sits inside the PDF branch, after the images are settled.
    expect(source.indexOf("if (classification.kind === 'pdf')"))
      .toBeLessThan(source.indexOf('result.deterministicReading ='));
    expect(source.indexOf("if (classification.kind === 'opendocument')"))
      .toBeGreaterThan(source.indexOf('result.deterministicReading ='));
  });
});

// ---------------------------------------------------------------------------
// I — what spends money, and what cannot
// ---------------------------------------------------------------------------

function fakeBudget() {
  const reserved: number[] = [];
  const port: AiBudgetPort = {
    async reserve({ amountMicros }: { amountMicros: number }) {
      reserved.push(amountMicros);
      return { ok: true, reservationId: 'res-1', reservedMicros: amountMicros };
    },
    async settle() { /* nothing to assert here */ },
    async release() { /* nothing to assert here */ },
  } as unknown as AiBudgetPort;
  return { port, reserved };
}

describe('the ceiling is taken by the model path and by nothing else', () => {
  it('the ONE door to a provider takes a hold before it opens', async () => {
    const { port, reserved } = fakeBudget();
    callLLM.mockResolvedValueOnce({
      modelUsed: 'openai/gpt-5.6-luna',
      toolCall: { name: 'record_stock_items', arguments: { items: [] } },
      attempts: [{ ok: true, status: 200 }],
    });
    await extractStockRowsFromText('LOT 315', { filename: 'a.pdf', organisationName: null },
      { deadlineAt: Date.now() + 60_000, budget: port }).catch(() => undefined);
    // Whatever it answered, it reserved first. That is the fact the row count
    // then decides: no call, no hold.
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toBeGreaterThan(0);
    expect(callLLM).toHaveBeenCalled();
  });

  it('nothing outside the two extractors reserves', () => {
    const source = read('supabase/functions/_shared/builderStock/modelExtract.ts');
    expect((source.match(/budget\.reserve\(/g) ?? [])).toHaveLength(1);
    const deterministic = read(
      'supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts');
    const layout = read('supabase/functions/_shared/builderStock/pdfTextLayout.ts');
    for (const module of [deterministic, layout]) {
      expect(module).not.toContain('budget');
      expect(module).not.toContain('callLLM');
      expect(module).not.toContain('llmRouter');
      expect(module).not.toContain('openrouter');
    }
  });
});

// ---------------------------------------------------------------------------
// The decision point
// ---------------------------------------------------------------------------

describe('where a model is decided on', () => {
  const runImport = read('supabase/functions/_shared/builderStock/runImport.ts');

  it('the existing guard is the only thing that reaches the assisted reader', () => {
    // Untouched: rows present means no model, for every format alike.
    expect(runImport).toContain('if (!rows.length && extraction.visionImages.length)');
    expect(runImport).toContain('} else if (!rows.length && extraction.text) {');
    // Exactly two calls into the model path, and both are inside that guard.
    expect((runImport.match(/extractStockRowsFrom(Text|Images)\(/g) ?? [])).toHaveLength(2);
    // No second opinion about whether a PDF should be read by a model.
    expect(runImport).not.toContain('deterministicReading?.status ===');
    expect(runImport).not.toContain("classification.kind === 'pdf'");
  });

  it('the PDF branch writes rows on `complete` and on nothing else', () => {
    const source = read('supabase/functions/_shared/builderStock/extract.ts');
    expect(source).toContain(
      "if (reading.status === 'complete' && reading.rows.length && reading.strategy");
    // And never a truncated set, which would lose rows the model would have read.
    expect(source).toContain('reading.rows.length <= MAX_ROWS');
    expect(source).toContain('result.rows = reading.rows;');
    // One assignment to rows in the whole PDF branch, under that condition.
    const branch = source.slice(source.indexOf("if (classification.kind === 'pdf')"));
    const pdfBranch = branch.slice(0, branch.indexOf("if (classification.kind === 'opendocument')"));
    expect((pdfBranch.match(/result\.rows\s*=/g) ?? [])).toHaveLength(1);
    expect(pdfBranch.indexOf("reading.status === 'complete'"))
      .toBeLessThan(pdfBranch.indexOf('result.rows ='));
  });

  it('a reading that throws leaves the document exactly as it was', () => {
    const source = read('supabase/functions/_shared/builderStock/extract.ts');
    const branch = source.slice(source.indexOf('THE MISSING MIDDLE'));
    // The whole stage is inside one try, and its catch adds no warning and
    // raises nothing — the text and the images are already settled above it.
    expect(branch).toContain('} catch {');
    expect(branch.slice(0, branch.indexOf('return result;')))
      .not.toContain('throw new StockExtractionError');
  });

  it('the PDF text reader keeps its contract for its two existing callers', () => {
    const pdfText = read('supabase/functions/_shared/builderStock/pdfText.ts');
    expect(pdfText).toContain('export async function readPdfPageTexts');
    expect(pdfText).toContain("const { text } = await reader.extractText(pdf, { mergePages: false });");
    // The layout reader is a SEPARATE door on the same pinned version.
    expect(pdfText).toContain("import('https://esm.sh/unpdf@0.12.1')");
    expect(read('supabase/functions/_shared/builderStock/pdfTextLayout.ts'))
      .toContain("import('https://esm.sh/unpdf@0.12.1')");
  });

  it('positions are read only behind the screen, so a brochure pays nothing', () => {
    const source = read('supabase/functions/_shared/builderStock/extract.ts');
    expect(source).toContain('if (mayHoldSchedule(pageTexts)) {');
    expect(source.indexOf('if (mayHoldSchedule(pageTexts)) {'))
      .toBeLessThan(source.indexOf("await import('./pdfTextLayout.ts')"));
  });

  it('the images, the page texts and the order are settled before any of this', () => {
    const source = read('supabase/functions/_shared/builderStock/extract.ts');
    const branch = source.slice(source.indexOf("if (classification.kind === 'pdf')"));
    for (const settled of [
      'result.pageTexts = pages;',
      'result.pageOrderAuthoritative = found.pageOrderAuthoritative;',
      'result.media.push({',
    ]) {
      expect(branch.indexOf(settled)).toBeGreaterThan(-1);
      expect(branch.indexOf(settled)).toBeLessThan(branch.indexOf('THE MISSING MIDDLE'));
    }
  });
});
