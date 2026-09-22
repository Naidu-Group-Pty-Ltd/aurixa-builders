/**
 * THE IMPORTER STOPS BEFORE THE RUNTIME STOPS IT.
 *
 * `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf` reached `546 CPU Time
 * exceeded` eight seconds into processing, three of those spent storing
 * pictures after the document had already been read. The measurement behind
 * the fix (`docs/builder-portal/54-what-the-importer-spends.md`) says the
 * importer has exactly two expensive stages, and this file pins the rules
 * that follow from that — the derivation of the ceiling, the shape of the
 * checkpoint, and the orderings that make a hand-off actually hand off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EXPENSIVE_SPEND_CEILING_MS, OCR_PAGE_MS, RASTER_STEP_MS,
  expensiveSpendMs, mayRecognisePage, mayStoreImage, remainingExpensiveMs,
} from '../../../supabase/functions/_shared/builderStock/importResumeBudget.pure.ts';
import {
  MAX_CHECKPOINT_PAGE_CHARS, MAX_CHECKPOINT_TOTAL_CHARS, MAX_IMPORT_CONTINUATIONS,
  checkpointPages, checkpointSettledPages, mayContinue, openCheckpoint,
  readCheckpoint, withContinuation, withRecogniserUnavailable,
  withRecognisedPage, withRefusedPage,
} from '../../../supabase/functions/_shared/builderStock/importCheckpoint.pure.ts';
import {
  importOutcomeColumns,
} from '../../../supabase/functions/_shared/builderStock/recordImportOutcome.ts';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

// ---------------------------------------------------------------------------
describe('the ceiling is derived from the two step costs, not chosen', () => {
  /**
   * The derivation, restated as arithmetic so it cannot quietly stop holding.
   * The shortest production run measured to be KILLED is 6.4 seconds of wall
   * clock, and compute is a subset of wall clock — so the worst overshoot
   * (the ceiling plus the largest single step, because the test is asked
   * BEFORE the step) has to stay under it.
   */
  const SHORTEST_MEASURED_KILL_MS = 6_400;

  it('the ceiling plus the largest step stays under the shortest measured kill', () => {
    const largestStep = Math.max(RASTER_STEP_MS, OCR_PAGE_MS);
    expect(EXPENSIVE_SPEND_CEILING_MS + largestStep)
      .toBeLessThan(SHORTEST_MEASURED_KILL_MS);
  });

  it('a native single-property document never approaches it', () => {
    // `stress-heavy-brochure`, 5.63 MB, measured: 0.35 s of ledger total.
    const heavyBrochure = {
      document_open_ms: 6, native_text_ms: 62, positioned_layout_ms: 55,
      ocr_ms: 52, normalisation_ms: 3, segmentation_ms: 1,
      property_reader_ms: 32, image_discovery_ms: 11, image_store_ms: 76,
      db_write_ms: 44, initial_image_work_ms: 3, finalisation_ms: 5,
    };
    expect(expensiveSpendMs(heavyBrochure)).toBeLessThan(EXPENSIVE_SPEND_CEILING_MS);
    expect(mayStoreImage(heavyBrochure)).toBe(true);
    expect(mayRecognisePage(heavyBrochure)).toBe(true);
  });

  it('the eight-image document stops long before it has stored eight', () => {
    // `stress-multi-property`, measured: image_store 9,388 ms for 8 pictures.
    const perImage = Math.round(9_388 / 8);
    const ledger: Record<string, unknown> = { image_discovery_ms: 16, native_text_ms: 8 };
    let stored = 0;
    while (mayStoreImage(ledger)) {
      ledger.image_store_ms = (Number(ledger.image_store_ms) || 0) + perImage;
      stored += 1;
      if (stored > 20) break;
    }
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(8);
    expect(expensiveSpendMs(ledger)).toBeLessThan(6_400);
  });

  it('metadata is never charged, because it was measured at 485 ms over eight documents', () => {
    const metadataOnly = {
      db_write_ms: 9_000, initial_image_work_ms: 9_000, finalisation_ms: 9_000,
    };
    expect(expensiveSpendMs(metadataOnly)).toBe(0);
    expect(mayStoreImage(metadataOnly)).toBe(true);
  });

  it('a caller with no ledger is unbudgeted, exactly as before', () => {
    expect(mayStoreImage(null)).toBe(true);
    expect(mayRecognisePage(undefined)).toBe(true);
    expect(remainingExpensiveMs(null)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
describe('a checkpoint belongs to one document', () => {
  it('a checkpoint for other bytes is discarded whole, never merged', () => {
    const mine = withRecognisedPage(openCheckpoint('aaa'), 3, 'page three');
    expect(readCheckpoint(mine, 'aaa')).not.toBeNull();
    // The linked-stock-list case: the builder edited the sheet, so the digest
    // moved. Yesterday's recognised text describes a document that no longer
    // says that.
    expect(readCheckpoint(mine, 'bbb')).toBeNull();
  });

  it('an unreadable or unknown-version value is no checkpoint at all', () => {
    expect(readCheckpoint(null, 'aaa')).toBeNull();
    expect(readCheckpoint('not an object', 'aaa')).toBeNull();
    expect(readCheckpoint([1, 2, 3], 'aaa')).toBeNull();
    expect(readCheckpoint({ v: 99, sha256: 'aaa' }, 'aaa')).toBeNull();
  });

  it('carries recognised pages back as the recogniser own map', () => {
    let cp = openCheckpoint('aaa');
    cp = withRecognisedPage(cp, 2, 'two');
    cp = withRecognisedPage(cp, 5, 'five');
    const back = readCheckpoint(JSON.parse(JSON.stringify(cp)), 'aaa')!;
    expect([...checkpointPages(back).entries()]).toEqual([[2, 'two'], [5, 'five']]);
  });

  it('settles a refused page so it is never asked again, and no others', () => {
    let cp = openCheckpoint('aaa');
    cp = withRecognisedPage(cp, 1, 'one');
    cp = withRefusedPage(cp, 4);
    expect([...checkpointSettledPages(cp)].sort()).toEqual([1, 4]);
  });

  it('declines past either bound rather than growing without limit', () => {
    const oversizePage = 'x'.repeat(MAX_CHECKPOINT_PAGE_CHARS + 1);
    expect(withRecognisedPage(openCheckpoint('a'), 1, oversizePage))
      .toEqual(openCheckpoint('a'));

    let cp = openCheckpoint('a');
    const page = 'y'.repeat(MAX_CHECKPOINT_PAGE_CHARS);
    for (let n = 1; n <= 20; n += 1) cp = withRecognisedPage(cp, n, page);
    const total = [...checkpointPages(cp).values()].reduce((sum, t) => sum + t.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_CHECKPOINT_TOTAL_CHARS);
  });

  it('crossings are bounded, and a deployment with no recogniser stops at once', () => {
    let cp = openCheckpoint('a');
    for (let n = 0; n < MAX_IMPORT_CONTINUATIONS; n += 1) {
      expect(mayContinue(cp)).toBe(true);
      cp = withContinuation(cp);
    }
    expect(mayContinue(cp)).toBe(false);
    expect(mayContinue(withRecogniserUnavailable(openCheckpoint('a')))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the outcome row is composed once, so two isolates cannot disagree', () => {
  const result = {
    uploadStatus: 'enriching',
    summary: { detected: 3, imported: 3, updated: 0, failed: 0, failures: [] },
  };

  it('states the same columns whichever invocation finishes the import', () => {
    const columns = importOutcomeColumns(result, null);
    expect(columns.status).toBe('enriching');
    expect(columns.records_detected).toBe(3);
    expect(columns.records_imported).toBe(3);
    expect(columns.processing_completed_at).toBeTruthy();
  });

  it('a row-level failure still wins the message over a source notice', () => {
    const columns = importOutcomeColumns({
      uploadStatus: 'partially_complete',
      summary: {
        detected: 3, imported: 2, updated: 0, failed: 1,
        failures: [{ label: 'Lot 9', reason: 'This row could not be saved.' }],
      },
    }, { code: 'source_links_unavailable', message: 'Links were not readable.' });
    expect(columns.error_code).toBeNull();
    expect(columns.error_message).toBe('1 row(s) could not be saved.');
  });

  it('both callers spread it rather than spelling the columns themselves', () => {
    const portal = read('supabase/functions/builder-portal-stock/index.ts');
    const continuation = read('supabase/functions/_shared/builderStock/continueImport.ts');
    expect(portal).toContain('importOutcomeColumns(result, sourceNotice)');
    expect(continuation).toContain('importOutcomeColumns(result, null)');
    // Neither may restate the status column inline beside the counts again.
    expect(portal).not.toContain('status: result.uploadStatus');
    expect(continuation).not.toContain('status: result.uploadStatus');
  });
});

// ---------------------------------------------------------------------------
describe('a hand-off actually hands off', () => {
  const runImport = read('supabase/functions/_shared/builderStock/runImport.ts');
  const claim = read('supabase/functions/_shared/builderStock/importClaim.ts');
  const portal = read('supabase/functions/builder-portal-stock/index.ts');
  const continuation = read('supabase/functions/_shared/builderStock/continueImport.ts');

  it('the run does not dispatch while it still holds the claim', () => {
    // A successor dispatched from inside the run would find the row claimed,
    // decline correctly, and the import would then wait for the minute tick —
    // which is the cron dependency this whole design removes.
    expect(runImport).not.toContain("rpc('builder_stock_dispatch_import_continuation'");
  });

  it('the release comes before the dispatch, in one place', () => {
    expect(claim).toContain('export async function releaseThenContinue');
    expect(claim.indexOf('await claim?.release();'))
      .toBeLessThan(claim.indexOf("rpc('builder_stock_dispatch_import_continuation'"));
  });

  it('every import path ends at the one pairing', () => {
    expect(portal).toContain('await releaseThenContinue(supabase, claim ?? null, uploadId);');
    expect(continuation).toContain('await releaseThenContinue(supabase, claim, uploadId);');
  });

  it('the hand-off writes no count and no completion stamp', () => {
    // The 22 September lie exactly: `records_detected: 0` on an upload whose
    // properties arrive a few seconds later.
    const branch = portal.slice(
      portal.indexOf('if (isImportContinuation(result)) {'),
      portal.indexOf('still_importing: true') + 400,
    );
    expect(branch).not.toContain('records_detected');
    expect(branch).not.toContain('processing_completed_at');
    expect(branch).toContain('still_importing: true');
  });

  it('only a caller that can be reproduced from stored bytes is handed off', () => {
    // A linked source carries documentName, baseUrl, rowAssets, linkDiscovery
    // and sheetTab alongside its bytes; a successor re-reading the snapshot
    // alone would produce a different document.
    expect(runImport).toContain('ocrOutstanding.length && input.resumableFromStoredBytes');
    const linked = portal.slice(portal.indexOf("if (operation === 'import_url')"));
    expect(linked).not.toContain('resumableFromStoredBytes');
  });

  it('a release names the token it took', () => {
    const migration = read(
      'supabase/migrations/20260922140000_an_import_too_big_for_one_isolate_hands_off_rather_than_dying.sql');
    expect(migration).toContain('AND import_claim_token = p_token');
    // And writes nothing else: a release hands back a lease, never progress.
    const release = migration.slice(
      migration.indexOf('FUNCTION public.builder_stock_release_import'),
      migration.indexOf('COMMENT ON FUNCTION public.builder_stock_release_import'),
    );
    expect(release).not.toContain('status =');
    expect(release).not.toContain('import_checkpoint =');
  });

  it('the successor is an operation on the function that already imports', () => {
    // A second edge function would be a second implementation of "read this
    // document", which is how two import paths come to behave differently.
    expect(portal).toContain("if (operation === 'continue_import')");
    expect(portal).toContain('verifyInternal(supabase, req, rawBody)');
    // And it is gated before the portal session is resolved.
    expect(portal.indexOf("operation === 'continue_import'"))
      .toBeLessThan(portal.indexOf('resolveBuilderSession(supabase, req)'));
  });
});

// ---------------------------------------------------------------------------
describe('the raster loop that was unbounded is bounded', () => {
  const importStock = read('supabase/functions/_shared/builderStock/importStock.ts');

  it('asks before each picture, not once before all of them', () => {
    const loop = importStock.slice(importStock.indexOf('for (const [index, media] of input.media.entries())'));
    expect(loop.indexOf('if (!mayStoreImage(input.ledger))'))
      .toBeLessThan(loop.indexOf('.upload(path, media.bytes'));
  });

  it('charges a picture whether it stored or threw', () => {
    // A ceiling that only counts successes is one a run of failures walks
    // straight through.
    expect(importStock).toContain("} finally {\n      // Charged whether it stored or threw");
  });

  it('reports what it left behind rather than dropping it silently', () => {
    expect(importStock).toContain('input.onImageryDeferred?.(deferred)');
    expect(importStock).toContain('onImageryDeferred: () => { outcome.imageryOutstanding = true; }');
  });

  it('the repair sweep passes no ledger, so it declines nothing', () => {
    const repair = read('supabase/functions/_shared/builderStock/repairSourceImages.ts');
    expect(repair).not.toContain('ledger:');
  });
});

// ---------------------------------------------------------------------------
describe('recognition can stop without refusing', () => {
  const ocr = read('supabase/functions/_shared/builderStock/ocr/recogniseScan.ts');

  it('a deferral is a third state, separate from a refusal', () => {
    expect(ocr).toContain('deferred: number[];');
    expect(ocr).toContain('deferred.push(raster.page);');
  });

  it('only refusals about the PAGE are final', () => {
    // `out_of_time` and `engine_unavailable` describe the attempt and the
    // deployment; treating either as final loses a readable page for ever.
    expect(ocr).toContain(
      "export const FINAL_OCR_REFUSAL_REASONS: ReadonlyArray<OcrPageRefusal['reason']> =\n"
      + "  ['no_raster', 'too_large', 'unreadable'];");
  });

  it('a recognised page is made durable before the next one is attempted', () => {
    const loop = ocr.slice(ocr.indexOf('text.set(raster.page, read);'));
    expect(loop.indexOf('await options.onPage?.(raster.page, read);'))
      .toBeLessThan(loop.indexOf('} catch {'));
  });

  it('only the pages the plan wants are decompressed', () => {
    const extract = read('supabase/functions/_shared/builderStock/extract.ts');
    expect(extract).toContain('maxPages: OCR_MAX_PAGES, pages: outstanding,');
  });
});
