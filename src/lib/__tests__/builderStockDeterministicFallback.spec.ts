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

describe('the importer falls back rather than failing', () => {
  const run = read(RUN);
  const block = run.slice(
    run.indexOf('AND THE READING WE ALREADY HAVE IS BETTER THAN NOTHING AT ALL'),
    run.indexOf('const { error: stampError }'));

  it('uses the provisional reading when the assisted reader could not run', () => {
    expect(block).toContain('extraction.deterministicProvisional');
    expect(block).toMatch(/rows = provisional;/);
  });

  /*
   * EVERY code that reaches this catch is a fact about US — the union says so
   * itself: an unconfigured credential, an outage, a timeout, a spent
   * allowance, an account out of credit, an unusable answer. None of them is
   * a statement about the builder's document, which this reader had read.
   */
  it('does not discriminate between our failures, because none is the document', () => {
    const codes = read('supabase/functions/_shared/builderStock/modelExtractionFailure.pure.ts');
    for (const code of ['model_unavailable', 'model_timeout', 'model_refused',
      'model_budget_exhausted', 'model_invalid_response', 'model_missing_tool_call']) {
      expect(codes).toContain(code);
    }
    // The fallback is keyed on having a reading, never on which of ours failed.
    expect(block).not.toMatch(/failure\.code ===/);
  });

  it('records the reading as partial, so it cannot pass for a full one', () => {
    expect(block).toContain("strategy = 'pdf_deterministic_partial'");
  });

  it('still fails honestly when there is nothing to fall back on', () => {
    // A document the reader could not identify a property in has no record to
    // stand on, and inventing one is the failure this whole module refuses.
    expect(block).toMatch(/\} else \{\s*\n\s*return \{\s*\n\s*ok: false,/);
  });

  it('says in the log that the partial reading stood', () => {
    expect(block).toContain("phase: 'deterministic_fallback'");
  });
});

describe('the messages do not promise what the product does not do', () => {
  const failure = read(FAILURE);

  it('claims no alert, because nothing alerts', () => {
    /*
     * Three messages said "Our team has been alerted" and one carried a
     * comment asserting that was true. Nothing in this repository alerts on
     * these: the only trace is a `console.error` in the edge log and
     * `error_detail` on the row, which nothing watches and `get_upload`
     * projects away. A promise the product does not keep is worse than no
     * promise — it tells a builder to stop looking.
     */
    expect(failure).not.toContain('Our team has been alerted');
  });

  it('names the account on a refusal, rather than describing a broken feature', () => {
    // "not currently able to run for this workspace" describes a fault in the
    // product. A 402 is an unpaid account, and the two send an operator to
    // different places.
    const refused = failure.slice(failure.indexOf("case 'model_refused':"),
      failure.indexOf("case 'model_budget_exhausted':"));
    expect(refused).toMatch(/credentials or credit/);
  });
});

describe('a vocabulary gap can be closed without the document', () => {
  const reader = read(READER);
  const run = read(RUN);
  const extract = read(EXTRACT);
  const fn = read('supabase/functions/builder-portal-stock/index.ts');

  /*
   * MEASURED ACROSS 21 SEPTEMBER 2026: nine of twelve brochures imported with
   * NO model call at all. Every one that did not was a template this reader
   * had not yet learned — `LOT 717 - ENZO 10.5 MODERN - BROCHURE V002.pdf`
   * failed at 03:09 and 03:24 and imported at 04:07 from the SAME 8,425,036
   * bytes, once the vocabulary widened. So the pathway is not
   * model-dependent by design; it is model-dependent exactly where the
   * vocabulary has a hole, and the only thing needed to close one is knowing
   * WHICH line. `diagnostics.unaccountedLines` is a count and cannot be
   * acted on.
   */
  it('carries the unaccounted lines out with the refusal', () => {
    expect(reader).toMatch(/unaccounted: string\[\];/);
    expect(reader).toMatch(/provisionalFrom\(claimed\), stillUnresolved, ignoredText, placedAt\)/);
  });

  it('bounds them, because a column is not a place to copy a document', () => {
    expect(reader).toContain('MAX_UNACCOUNTED_REPORTED');
    expect(reader).toContain('MAX_UNACCOUNTED_LINE_CHARS');
    expect(reader).toMatch(/unaccounted\.slice\(0, MAX_UNACCOUNTED_REPORTED\)/);
  });

  it('keeps them out of the safe-to-log diagnostics', () => {
    /*
     * `diagnostics`' contract is that no value a document stated appears in
     * it, because it is written to the import log and a builder's price is
     * not ours to put in a log line. These are document text.
     */
    const diagnostics = reader.slice(
      reader.indexOf('  diagnostics: {'), reader.indexOf('function provisionalFrom('));
    expect(diagnostics).not.toContain('unaccounted:');
    expect(extract).toMatch(/deterministicUnaccounted\?: string\[\];/);
  });

  it('records them only where a builder cannot be shown them', () => {
    // `error_detail` is projected away by the upload select.
    expect(run).toContain('deterministic_unaccounted');
    const projection = read('supabase/functions/_shared/builderStock/projection.pure.ts');
    const select = projection.slice(projection.indexOf('STOCK_UPLOAD_SELECT'));
    expect(select.slice(0, 600)).not.toContain('error_detail');
  });

  it('raises the row ceiling past the payload, or the evidence is cut off', () => {
    // At 2,000 the JSON truncated before reaching the lines, so the field
    // would have recorded a diagnosis with its own evidence missing. The
    // payload now also carries the lines the reader PLACED and could not
    // name (80 at 120 characters), so both ceilings moved with it and the
    // outer one still sits above the inner.
    expect(run).toContain('.slice(0, 120_000)');
    expect(fn).toMatch(/String\(detail\)\.slice\(0, 128_000\)/);
  });
});

/**
 * AND THE SAME EVIDENCE ON THE PATH THAT SUCCEEDED.
 *
 * A document that fails to import is diagnosable. A document that imports
 * with five of its twelve fields empty is not — the upload reads `enriching`,
 * the card draws what there is, and nothing anywhere says what the other
 * three hundred lines of the page were. That is the state `LOT 266 Crowlea
 * Estate` was left in, and closing the gap it names has meant guessing at
 * the document or asking a builder to send the file.
 */
describe('a successful import records what it could not name', () => {
  const extract = read('supabase/functions/_shared/builderStock/extract.ts');
  const run = read('supabase/functions/_shared/builderStock/runImport.ts');
  const fn = read('supabase/functions/builder-portal-stock/index.ts');

  it('carries the lines out of the extraction and out of the run', () => {
    expect(extract).toMatch(/deterministicIgnored\?: string\[\];/);
    expect(extract).toContain('result.deterministicIgnored = reading.ignored;');
    expect(run).toMatch(/deterministicIgnored\?: string\[\] \| null;/);
    expect(run).toContain('deterministicIgnored: extraction.deterministicIgnored ?? null');
  });

  it('writes them on the SUCCESS path, which is where they were missing', () => {
    expect(fn).toContain('deterministic_ignored: result.deterministicIgnored');
  });

  it('merges into `error_detail` rather than replacing what is there', () => {
    /*
     * `sourceNotice.detail` carries a `reason` the link-recovery path reads
     * back off the row. Overwriting it would silently stop a sheet whose
     * export permissions were the problem from ever being asked for again.
     */
    expect(fn).toMatch(/\.\.\.\(outcomeDetail \?\? \{\}\), \.\.\.\(importDiagnosis \?\? \{\}\)/);
    expect(fn).toContain('sourceNotice ? sourceNotice.detail : null');
  });

  it('never invents a failure out of a diagnosis', () => {
    // An import that succeeded still reads as one: the diagnosis sets no
    // `error_code` and no `error_message`, so nothing a builder sees moves.
    const write = fn.slice(fn.indexOf('const importDiagnosis'));
    const block = write.slice(0, write.indexOf('processing_completed_at'));
    expect(block).toMatch(/error_code: result\.summary\.failures\.length/);
    expect(block).toMatch(/error_message: result\.summary\.failures\.length/);
  });

  it('keeps them off the wire and out of the log', () => {
    // Document text: internal only, and never in `deterministicReading`,
    // which is the safe-to-log projection the telemetry line writes.
    const projection = read('supabase/functions/_shared/builderStock/projection.pure.ts');
    const select = projection.slice(projection.indexOf('STOCK_UPLOAD_SELECT'));
    expect(select.slice(0, 600)).not.toContain('error_detail');
    const reader = read(
      'supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts');
    const diagnostics = reader.slice(
      reader.indexOf('  diagnostics: {'), reader.indexOf('function provisionalFrom('));
    expect(diagnostics).not.toContain('ignored:');
  });
});
