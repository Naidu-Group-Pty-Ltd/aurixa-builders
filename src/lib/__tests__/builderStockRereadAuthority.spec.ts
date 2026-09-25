/**
 * A RE-READ OF THE SAME FILE IS THE PARSER CHANGING ITS MIND, NOT THE SOURCE
 * FALLING SILENT.
 *
 * MEASURED, 21 SEPTEMBER 2026, and it is the reason this file exists.
 * `LOT 266 Crowlea Estate` stored `land_size_sqm: 334000` from a
 * `LAND $334,000` line. The rule that refuses a priced measurement shipped at
 * 09:51, the builder pressed Read again at 10:01, and the import recorded
 * `declined: land_size_sqm` exactly as designed — and the card still drew
 * `334,000 m²`, because `writablePatch` skips a null and the corrected
 * reading states nothing there. The correction lost to the document it
 * corrects, which is #2347 in another costume.
 *
 * These are source-level assertions on purpose: `writablePatch` is not
 * exported, the import path it sits in needs a database, and what has to be
 * guaranteed is the SHAPE of the rule — which columns may be unsaid, that
 * identity is not among them, and that both halves of the write agree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const importStock = read('supabase/functions/_shared/builderStock/importStock.ts');
const migration = read(
  'supabase/migrations/20260921103000_a_held_back_patch_says_what_it_means.sql');

/** What a row is FOUND by. Unsaying one orphans a live property. */
const IDENTITY_COLUMNS = [
  'external_reference', 'development_name', 'project_name',
  'lot_number', 'unit_number',
];

/** What a parser owns and may therefore retract. */
const PARSED_COLUMNS = [
  'address_line', 'suburb', 'state', 'postcode',
  'bedrooms', 'bathrooms', 'car_spaces', 'property_type',
  'land_size_sqm', 'building_size_sqm',
  'price', 'price_display', 'expected_completion', 'description',
];

function unsayableSet(): string[] {
  const block = importStock.slice(
    importStock.indexOf('const UNSAYABLE_ON_REREAD'),
    importStock.indexOf('function writablePatch('));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('a re-read of the same file may unsay what it no longer states', () => {
  it('clears only on a same-source re-read, and never otherwise', () => {
    // A NEW source that stops mentioning a column is silent about it, not
    // withdrawing it — a builder must not lose a figure because their next
    // spreadsheet had fewer columns.
    expect(importStock).toMatch(
      /if \(value !== null && value !== undefined && value !== ''\) patch\[column\] = value;/);
    // Unsaid to what the property's own brochure stated, or to null where it
    // stated nothing (`documentFigureFallback`): the stock list's silence is
    // not a correction of the brochure. See builder-portal doc 57.
    expect(importStock).toMatch(
      /else if \(options\.sameSourceReread && UNSAYABLE_ON_REREAD\.has\(column\)\) \{\s*patch\[column\] = documentFigureFallback\(options\.documentFigures, column\);/);
  });

  it('decides "same source" from the row\'s own previous supplier', () => {
    // Not from an operation name: `reprocess_upload` and a re-upload of the
    // same file are the same act to the row, and a flag threaded down from a
    // handler is a flag some other caller forgets.
    expect(importStock).toMatch(
      /supplierBefore\.get\(existingId as string\) === input\.uploadId/);
  });

  it('may unsay every column a parser owns', () => {
    for (const column of PARSED_COLUMNS) expect(unsayableSet()).toContain(column);
  });

  it('may never unsay an identity column', () => {
    // These are what `stockMatchKeys` and the development/unit key are built
    // from. Clearing one strands a live property from its supplier and from
    // the imagery earned against its id.
    for (const column of IDENTITY_COLUMNS) expect(unsayableSet()).not.toContain(column);
  });

  it('cannot reach a builder\'s own stated figures', () => {
    // An override lives in `manual_stats`, which this patch does not name.
    // That separation is exactly why the override lives there.
    const patch = importStock.slice(
      importStock.indexOf('function writablePatch('),
      importStock.indexOf('  return patch;'));
    expect(patch).not.toContain('manual_stats');
  });
});

describe('both halves of the write agree about an unsaid column', () => {
  /*
   * A published row's patch is HELD BACK in `pending_patch` and applied later
   * by `publish_builder_stock_upload`. That function read every column with
   * `coalesce(patch->>'col', i.col)`, which takes an explicit null as "not
   * stated" — so the direct update would clear and the deferred one would
   * not, and which a builder got would depend on whether their property
   * happened to be live at the time.
   */
  it('applies the patch by KEY PRESENCE, not by null-ness', () => {
    for (const column of [...PARSED_COLUMNS, ...IDENTITY_COLUMNS]) {
      expect(migration).toContain(`i.pending_patch ? '${column}'`);
    }
  });

  it('leaves no PATCH column reading its value through coalesce', () => {
    /*
     * `source_row` is the one exception and it is not a patch column at all:
     * the deferred branch writes it beside `pending_patch` rather than in it,
     * so that read is defensive and can never see a null the patch put there.
     */
    const applied = migration.slice(
      migration.indexOf('UPDATE public.builder_stock_items AS i'),
      migration.indexOf('WHERE i.pending_upload_id = p_upload_id'));
    const coalesced = [...applied.matchAll(/coalesce\(i\.pending_patch->>?'([a-z_]+)'/g)]
      .map((m) => m[1]).filter((column) => column !== 'source_row');
    expect(coalesced).toEqual([]);
    const patchBuilder = importStock.slice(
      importStock.indexOf('function writablePatch('),
      importStock.indexOf('  return patch;'));
    expect(patchBuilder).not.toContain("'source_row'");
  });

  it('decides which columns may be unsaid in ONE place', () => {
    // The SQL applies the patch it is handed and decides nothing. Two
    // implementations of that rule is how the two come to disagree.
    for (const column of IDENTITY_COLUMNS) {
      expect(migration).toContain(`i.pending_patch ? '${column}'`);
    }
    expect(unsayableSet().length).toBe(PARSED_COLUMNS.length);
  });
});
