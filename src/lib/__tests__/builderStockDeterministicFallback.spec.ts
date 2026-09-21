/**
 * THE ASSISTED READER IS THE LAST RESORT, NOT THE LOAD-BEARING ONE.
 *
 * MEASURED IN PRODUCTION, 21 SEPTEMBER 2026.
 * `LOT 817 - ELARA 18 TEMPIO LIGHT - BROCHURE V002 (1).pdf` — 8,840,575
 * bytes, 6 pages, 13,079 characters of text extracted cleanly, no resource
 * kill. The deterministic reader read four fields off it:
 *
 *   deterministic_status:  "incomplete"
 *   deterministic_reason:  "unaccounted_specification_lines"
 *   deterministic_fields:  development_name, expected_completion,
 *                          house_design, price
 *
 * and stood down on ONE line it could not account for. The assisted reader it
 * deferred to answered `refused 402` — an account with no credit — so all four
 * fields were discarded and the builder was told the stock list could not be
 * imported. Every brochure the deterministic reader does not fully own failed
 * that way for as long as that account stayed empty: one vendor's billing
 * state was the entire pathway.
 *
 * The brochure gate's reasoning is unchanged and still right — it stands a
 * document down so as not to suppress a reader that can read more. This pins
 * the part that was missing: when that reader cannot run, there is nothing to
 * suppress, and deferring is only discarding.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const READER = 'supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts';
const RUN = 'supabase/functions/_shared/builderStock/runImport.ts';
const EXTRACT = 'supabase/functions/_shared/builderStock/extract.ts';
const FAILURE = 'supabase/functions/_shared/builderStock/assistedReaderFailure.pure.ts';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('a refusal carries what it had already read', () => {
  const reader = read(READER);

  it('keeps it out of `rows`, which must stay empty on a refusal', () => {
    /*
     * The field's own note is the rule: "a refusal that carried rows would be
     * one edit away from importing them." That stands. The provisional record
     * is a DIFFERENT field so no existing reader of `rows` can pick it up by
     * accident.
     */
    expect(reader).toMatch(/function refuse\([\s\S]*?rows: \[\],/);
    expect(reader).toMatch(/provisional: Array<Record<string, unknown>>;/);
  });

  it('is empty on a complete reading, where the rows ARE the reading', () => {
    const completes = reader.match(/status: 'complete',[\s\S]{0,240}?provisional: \[\],\n\s*unaccounted: \[\],/g) ?? [];
    expect(completes.length).toBeGreaterThanOrEqual(2);
  });

  it('is built only at the gate the production failure hit', () => {
    // Not every refusal: `no_labelled_fields` read nothing, and a reading that
    // threw is no reading. Only the document that WAS read and stood down on
    // an unaccounted line has anything worth carrying.
    expect(reader).toMatch(
      /refuse\('incomplete', 'unaccounted_specification_lines', diagnostics,\s*\n?\s*provisionalFrom\(claimed\), stillUnresolved, ignoredText, placedAt\)/);
  });
});

describe('a provisional record clears every gate a complete one clears', () => {
  const reader = read(READER);
  const fn = reader.slice(
    reader.indexOf('function provisionalFrom('),
    reader.indexOf('function refuse('));

  /*
   * THIS IS THE SAFETY ARGUMENT. What the refusal was about is the account of
   * every LINE on the page. Every gate about the RECORD still applies, in the
   * same order, over the same inputs — so a provisional record is thinner than
   * a complete one and never wronger.
   */
  it('refuses a record with no identity field', () => {
    // A row with no identity cannot be matched, re-matched or de-duplicated.
    // Importing one creates a property nothing can ever find again.
    expect(fn).toContain('IDENTITY_FIELDS.filter');
    expect(fn).toMatch(/if \(!identity\.length\) return \[\];/);
  });

  it('refuses a summary row', () => {
    expect(fn).toContain('SUMMARY_IDENTITY_LABELS');
  });

  it('holds the same field floor', () => {
    expect(fn).toContain('MIN_BROCHURE_FIELDS');
  });

  it('refuses a field with no canonical header rather than mis-filing it', () => {
    expect(fn).toContain('CANONICAL_HEADER');
    expect(fn).toMatch(/if \(!header\) return \[\];/);
  });

  it('goes through the same normaliser both paths meet at', () => {
    expect(fn).toContain('normaliseStockRow(raw)');
  });

  it('invents nothing: every value comes from the claimed map', () => {
    // No defaulting, no coalescing, no inference. A field nothing claimed
    // stays absent — `rentalEvidence`'s rule, and `placesAvailability`'s:
    // absent is never zero.
    const building = fn.slice(fn.indexOf('const raw:'));
    expect(building).toMatch(/for \(const \[field, value\] of claimed\)/);
    expect(building).toMatch(/raw\[header\] = value;/);
    // No defaulting where the record is built. (The identity guard above it
    // uses `?? ''` to read a value it is only TESTING, which writes nothing.)
    expect(building).not.toMatch(/\?\?/);
  });
});

describe('the values never reach a log', () => {
  const extract = read(EXTRACT);

  it('keeps them out of the safe-to-log projection', () => {
    /*
     * `deterministicReading` exists to be safe to log — counts, field names
     * and status words, never a value the document stated. A read record
     * inside it would put a builder's price in an import log.
     */
    const projection = extract.slice(
      extract.indexOf('export interface PdfDeterministicDiagnostics'),
      extract.indexOf('const MAX_ROWS'));
    expect(projection).not.toContain('provisional');
  });

  it('carries them on a field of their own instead', () => {
    expect(extract).toMatch(/deterministicProvisional\?: Array<Record<string, unknown>>;/);
  });
});

/*
 * ===========================================================================
 * AND THE FALLBACK BECAME THE PATH.
 * ===========================================================================
 *
 * This block used to pin the provisional reading as a RESCUE: taken inside
 * the catch, after the assisted reader had been called and had failed. That
 * was the right repair for `LOT 817` and it left the defect standing, because
 * an ordinary brochure still had to reach a vendor and be refused before its
 * own evidence was allowed to count.
 *
 * `Lot 37 - Miami 190 - Property Package.pdf`, 21 September 2026, is what
 * that cost: 7 pages, 3,962 characters of clean text, import FAILED with zero
 * properties because `openrouter/openai/gpt-5.6-luna` answered 402.
 *
 * The reading is now taken BEFORE a model is considered at all, and the
 * assisted reader is off unless a deployment switches it on by name. So these
 * assertions move to the new site. Every guarantee they made is still made,
 * and two are stronger: nothing is asked of any vendor on the ordinary path,
 * and a document that supports no record is reported as such rather than as
 * an AI-account problem.
 */
describe('the deterministic reading is the import', () => {
  const run = read(RUN);
  const block = run.slice(
    run.indexOf('WHAT THE DOCUMENT STATES IS THE IMPORT'),
    run.indexOf('AND THE ASSISTED READER, WHICH IS OPTIONAL'));

  it('uses the provisional reading without consulting any model', () => {
    expect(block).toContain('extraction.deterministicProvisional');
    expect(block).toMatch(/rows = standing;/);
    // Nothing in this block reaches a model, a budget or a deadline.
    expect(block).not.toMatch(/extractStockRowsFrom|createAiBudget|MODEL_BUDGET_MS/);
  });

  /*
   * It is keyed on HAVING a reading, never on which of our failures happened
   * — and now not on a failure at all, because none has occurred yet.
   */
  it('is keyed on having a reading, not on a model outcome', () => {
    expect(block).not.toMatch(/failure\.code|disposition\.consulted/);
  });

  it('records the reading as partial, so it cannot pass for a full one', () => {
    expect(block).toContain("strategy = 'pdf_deterministic_partial'");
  });

  it('says in the log that the deterministic reading stood', () => {
    expect(block).toContain("phase: 'deterministic_partial'");
  });

  /*
   * A document the reader could not identify a property in has no record to
   * stand on, and inventing one is the failure this module refuses. What
   * changed is WHICH outcome it earns: `no_properties_found` — we read it and
   * found no property — rather than a sentence about an unpaid AI account.
   */
  it('fails honestly, and about the document, when there is nothing to stand on', () => {
    expect(run).toMatch(/fail\('no_properties_found'/);
    const afterCatch = run.slice(run.indexOf('AND IT CHANGES NOTHING ABOUT THE IMPORT'));
    expect(afterCatch.slice(0, 1600)).not.toMatch(/return \{\s*\n?\s*ok: false/);
  });
});
