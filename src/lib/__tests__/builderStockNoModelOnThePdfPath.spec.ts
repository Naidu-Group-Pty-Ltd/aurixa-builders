/**
 * THE ASSISTED READER IS OPTIONAL, OFF, AND CANNOT DECIDE AN IMPORT.
 *
 * MEASURED ON THIS DEPLOYMENT, 21 September 2026.
 *
 *   Lot 37 - Miami 190 - Property Package.pdf   7 pages, 3,962 chars of text
 *     13:55:30 → 13:55:39   FAILED, 0 properties
 *     deterministic_status  "ambiguous"
 *     diagnosis             "openrouter/openai/gpt-5.6-luna: refused 402"
 *
 *   LOT 817 - ELARA 18 TEMPIO LIGHT - BROCHURE V002 (1).pdf   07:37, same
 *   LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf               the day before
 *
 * An account with no credit was the whole pathway for reading a builder's
 * brochure. The ORDER was the defect: a deterministic reading that stood
 * down was treated as no reading, the model was asked, and the deterministic
 * evidence was brought back only as a rescue if the model failed.
 *
 * These tests pin the two rules that end it: what the document states is the
 * import, and the model is off unless somebody switches it on by name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSISTED_READER_FLAG, assistedReaderDisposition, assistedReaderEnabled,
} from '../../../supabase/functions/_shared/builderStock/assistedReaderPolicy.pure';

const env = (value?: string) => ({ get: () => value });

describe('the switch', () => {
  it('is off when nothing is set', () => {
    expect(assistedReaderEnabled(env(undefined))).toBe(false);
    expect(assistedReaderEnabled(env(''))).toBe(false);
  });

  it('is off for anything that is not an explicit yes', () => {
    for (const v of ['false', '0', 'off', 'no', 'maybe', 'ON ', 'enabled']) {
      expect(assistedReaderEnabled(env(v))).toBe(assistedReaderEnabled(env(v.trim().toLowerCase())));
    }
    for (const v of ['false', '0', 'off', 'no', 'maybe', 'enabled']) {
      expect(assistedReaderEnabled(env(v))).toBe(false);
    }
  });

  it('is on only by name', () => {
    for (const v of ['on', 'ON', 'true', 'TRUE', '1', ' on ']) {
      expect(assistedReaderEnabled(env(v))).toBe(true);
    }
    expect(ASSISTED_READER_FLAG).toBe('BUILDER_STOCK_ASSISTED_READER');
  });
});

describe('when a model may be consulted at all', () => {
  /*
   * The rule that ends the incident: a document that stated something is
   * imported from what it stated, and nothing is asked of any vendor.
   */
  it('never, where the document already yielded rows', () => {
    for (const enabled of [false, true]) {
      expect(assistedReaderDisposition({ enabled, deterministicRows: 1 }))
        .toEqual({ consulted: false, skipped: 'deterministic_reading_stands' });
    }
  });

  it('never, where the optional reader is off', () => {
    expect(assistedReaderDisposition({ enabled: false, deterministicRows: 0 }))
      .toEqual({ consulted: false, skipped: 'disabled' });
  });

  it('only where the document yielded nothing AND it was switched on', () => {
    expect(assistedReaderDisposition({ enabled: true, deterministicRows: 0 }))
      .toEqual({ consulted: true, skipped: null });
  });
});

describe('the import path', () => {
  const runImport = readFileSync(join(process.cwd(),
    'supabase/functions/_shared/builderStock/runImport.ts'), 'utf8');

  /*
   * The deterministic reading is taken BEFORE the disposition is computed, so
   * a document that supports a record can never reach a vendor.
   */
  it('takes the deterministic reading before it considers a model', () => {
    const standing = runImport.indexOf('const standing = extraction.deterministicProvisional');
    const decide = runImport.indexOf('const disposition = assistedReaderDisposition(');
    expect(standing).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(standing);
  });

  /* "No model-budget reservations" — nothing is constructed where nothing is spent. */
  it('reserves no budget when no model will be called', () => {
    expect(runImport).toMatch(
      /const budget = disposition\.consulted \? createAiBudget\(supabase\) : null;/);
  });

  /*
   * The second model call on the ordinary path, and the easier to miss: it
   * runs on a SUCCESSFUL import to fill gaps in a card. Measured on every
   * `LOT 266 Crowlea Estate` import as `field completion unavailable …
   * model_refused` against the same unpaid account.
   */
  it('puts the field-completion pass behind the same switch', () => {
    expect(runImport).toMatch(
      /const completionDeadline = assistedOn\s*\n?\s*\? completionDeadlineFrom\(runBudget, Date\.now\(\)\)\s*\n?\s*: null;/);
  });

  /*
   * A vendor's billing state is not a fact about a builder's document. The
   * catch no longer returns an outcome at all — the import is decided by what
   * the document supports, which is `no_properties_found` where it supports
   * nothing.
   */
  it('never lets a model failure become the import outcome', () => {
    const catchStart = runImport.indexOf('AND IT CHANGES NOTHING ABOUT THE IMPORT');
    expect(catchStart).toBeGreaterThan(-1);
    const afterCatch = runImport.slice(catchStart, catchStart + 1600);
    expect(afterCatch).not.toMatch(/return \{\s*\n?\s*ok: false/);
    expect(afterCatch).not.toMatch(/code: reading\.code/);
  });

  it('still reports the honest document-level outcome', () => {
    expect(runImport).toMatch(/fail\('no_properties_found'/);
  });
});
