/**
 * A KILLED IMPORT'S OWN OUTCOME IS RECOVERED FROM WHAT LANDED.
 *
 * MEASURED IN PRODUCTION, 21 SEPTEMBER 2026. Two POSTs to
 * `builder-portal-stock` answered 546; `function_logs` carries
 * `CPU Time exceeded` against both. The second belonged to upload
 * `5511d2e2`, a 9.5 MB brochure, and the kill landed NINE MILLISECONDS after
 * the run logged its own success — `outcome: "imported",
 * properties_imported: 1, with_source_image: 1`. The property, its nine
 * images and its settled imagery are all in the database. The upload ROW
 * reads `status: imported`, `processing_completed_at: null`,
 * `records_detected: 0`, `records_imported: 0`, and nothing in the product
 * could ever move it: `imported` is not in `COMPLETABLE_UPLOAD_STATUSES` and
 * `parseIsAbandoned` answers false for it.
 *
 * Upload `44896394` earlier the same morning is in the identical state, which
 * is what makes this a class rather than an incident.
 */
import { describe, expect, it } from 'vitest';
import {
  finalisationIsAbandoned,
  RECOVERABLE_UPLOAD_STATUSES,
  RECOVERED_FINALISATION_KEY,
  splitRecoveredCounts,
  ABANDONED_PARSE_MS,
  parseIsAbandoned,
} from '../../../supabase/functions/_shared/builderStock/uploadCompletion.ts';

const START = Date.parse('2026-09-21T06:45:37.878Z');

describe('which stranded rows may be recovered', () => {
  it('recognises the status a killed run strands its row in', () => {
    expect(RECOVERABLE_UPLOAD_STATUSES).toContain('imported');
  });

  it('leaves a run that is still writing its properties alone', () => {
    // `imported` is stamped BEFORE the properties are written, so it is a LIVE
    // status for the seconds an import spends in `importStockRecords`. Acting
    // on it immediately would recount a half-written import.
    expect(finalisationIsAbandoned(
      { status: 'imported', processing_started_at: new Date(START).toISOString() },
      START + 5_000,
    )).toBe(false);
  });

  it('recovers one the clock says cannot still be running', () => {
    expect(finalisationIsAbandoned(
      { status: 'imported', processing_started_at: new Date(START).toISOString() },
      START + ABANDONED_PARSE_MS + 1,
    )).toBe(true);
  });

  it('treats an unreadable start stamp as abandoned', () => {
    // Every path that sets this status stamps the start in the same write, so
    // a row without one cannot be an import in flight.
    expect(finalisationIsAbandoned({ status: 'imported', processing_started_at: null }))
      .toBe(true);
  });

  /*
   * THE TWO ABANDONMENTS ARE RECOVERED BY DIFFERENT ACTS, so neither
   * predicate may answer for the other's status. A `parsing` row has nothing
   * written and is recovered by reading the source AGAIN; an `imported` row
   * has everything written and is recovered by recording what is there.
   * Collapsing them would re-import a list that imported.
   */
  it('keeps the two abandonments apart', () => {
    const old = { processing_started_at: new Date(START).toISOString() };
    const late = START + ABANDONED_PARSE_MS + 1;

    expect(parseIsAbandoned({ ...old, status: 'parsing' }, late)).toBe(true);
    expect(finalisationIsAbandoned({ ...old, status: 'parsing' }, late)).toBe(false);

    expect(finalisationIsAbandoned({ ...old, status: 'imported' }, late)).toBe(true);
    expect(parseIsAbandoned({ ...old, status: 'imported' }, late)).toBe(false);
  });

  it('answers false for every terminal status', () => {
    for (const status of ['complete', 'partially_complete', 'failed', 'uploaded', 'enriching']) {
      expect(finalisationIsAbandoned(
        { status, processing_started_at: new Date(START).toISOString() },
        START + ABANDONED_PARSE_MS + 1,
      )).toBe(false);
    }
  });
});

describe('what the recount may claim', () => {
  const started = new Date(START).toISOString();
  const after = (ms: number) => new Date(START + ms).toISOString();
  const before = (ms: number) => new Date(START - ms).toISOString();

  it('reproduces the production row: one property, created by this run', () => {
    // Item 8a74279f was created at 06:45:44.187, six seconds after this
    // upload began reading and six seconds before the worker was killed.
    expect(splitRecoveredCounts([{ created_at: after(6_309) }], started))
      .toEqual({ detected: 1, imported: 1, updated: 0 });
  });

  it('calls a property older than the run a match, not a new import', () => {
    // `upload_id` is re-pointed on a match, which is why a pre-existing
    // property carries this upload's id at all.
    expect(splitRecoveredCounts([{ created_at: before(90_000) }], started))
      .toEqual({ detected: 1, imported: 0, updated: 1 });
  });

  it('counts a mixed list on both sides and totals every row', () => {
    const counts = splitRecoveredCounts([
      { created_at: after(1_000) },
      { created_at: after(2_000) },
      { created_at: before(1) },
    ], started);
    expect(counts).toEqual({ detected: 3, imported: 2, updated: 1 });
    expect(counts.imported + counts.updated).toBe(counts.detected);
  });

  /*
   * AN UNREADABLE CLOCK TAKES THE CONSERVATIVE SIDE. `imported` is the
   * stronger claim — this run brought a property into existence — and a count
   * that cannot be established must not make it. Nothing is lost from the
   * total either way.
   */
  it('refuses to claim an import it cannot establish', () => {
    expect(splitRecoveredCounts([{ created_at: 'not a date' }], started))
      .toEqual({ detected: 1, imported: 0, updated: 1 });
    expect(splitRecoveredCounts([{ created_at: after(1_000) }], null))
      .toEqual({ detected: 1, imported: 0, updated: 1 });
  });

  it('reports nothing found as nothing found', () => {
    // A run killed before it wrote a property genuinely imported none, and
    // this is the one reading where zero is the truth rather than a fault.
    expect(splitRecoveredCounts([], started))
      .toEqual({ detected: 0, imported: 0, updated: 0 });
  });
});

describe('the recovered counts say they were recounted', () => {
  it('names the key the audit record carries them under', () => {
    // A reader of these counts is owed the fact that they were recounted from
    // what landed rather than reported by the run that landed it.
    expect(RECOVERED_FINALISATION_KEY).toBe('recovered_finalisation');
  });
});
