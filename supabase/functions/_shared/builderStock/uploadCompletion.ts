/**
 * BUILDER STOCK — AN UPLOAD'S OWN STATUS IS SETTLED BY THE SERVER.
 *
 * WHAT HAPPENED. Every stage of imagery moved into the backend settler —
 * reading the builder's own documents, ranking what a card may draw, retiring
 * a picture whose source is gone — so an import now finishes with nobody
 * watching. The upload ROW's status did not move with it: `enriching` →
 * `complete`, and the `image_stage_summary` audit record beside it, was
 * written in exactly one place — the `enrich_images` operation, which is the
 * loop the Builder Portal runs WHILE SOMEBODY HAS THE PAGE OPEN.
 *
 * MEASURED, 2 SEPTEMBER 2026: upload `tq.csv` imported at 14:04 (14 rows
 * detected, 14 updated, 0 failed) and ninety minutes later its eleven live
 * properties were all `settled`, ten of them drawing the builder's own
 * brochure render — while the upload still read `enriching` with
 * `image_stage_summary: {}`. The work was done; the RECORD of it was waiting
 * for a browser. A builder reading that history is told an import is still
 * churning hours after it finished, and the audit summary is empty precisely
 * where a reader looks for it.
 *
 * So the rule lives here, once, and both callers ask it: the portal's loop
 * (settling the upload a person is watching) and the settler's tick (settling
 * every upload nobody is watching). Two implementations of "is this import
 * finished" is how one of them comes to be wrong.
 *
 * Three rules carry it.
 *
 *   - COMPLETION IS DECIDED ON THE PROPERTIES ALONE. An upload is finished
 *     when no active property of its own is still owed enrichment. Whether
 *     the settlement queue has caught up is a different question, and gating
 *     on it would leave a source too large to settle inside one budget
 *     reading `enriching` for ever. That is the rule the portal already
 *     applied, kept verbatim rather than re-derived.
 *   - A READ THAT FAILED IS NOT AN IMPORT THAT FINISHED. A failed count and
 *     an incomplete paged read both refuse to settle, because writing
 *     `complete` with an empty summary on a database fault produces an audit
 *     record that states, permanently and wrongly, that no images were
 *     processed. The portal's copy read `stagePage.rows` without consulting
 *     `stagePage.failed`, which is exactly that defect.
 *   - THE IMPORT'S OWN VERDICT DECIDES THE FINAL STATUS: an upload that could
 *     not save every row settles to `partially_complete`, never `complete`.
 *
 * THE SAME MODULE ANSWERS ONE MORE QUESTION ABOUT AN UPLOAD ROW'S OWN STATE:
 * whether a `parsing` row is still being read, or was abandoned by a request
 * that died. Both recovery doors were shut on the second case —
 * `process_upload` answers "This file has already been processed" (it has
 * not) and `reprocess_upload` answers "This source is being read right now"
 * (it is not) — so a builder whose import was killed mid-parse could never
 * import that file again, and their only recourse was deleting the source,
 * which archives its properties. An edge invocation cannot outlive its own
 * ceiling of roughly 150 seconds, and worker kills are a measured, ordinary
 * event in this pipeline, so a `parsing` row older than a generous multiple
 * of that ceiling is not in flight.
 */
import { readAllRows } from './pagedRead.ts';

/** The statuses an upload may still be completed FROM. */
export const COMPLETABLE_UPLOAD_STATUSES = ['enriching', 'partially_complete'];

/** Enrichment states meaning a property has not been through imagery yet. */
export const UNFINISHED_ENRICHMENT_STATUSES = ['pending', 'enriching'];

/**
 * The item-work ladder's terminal rung.
 *
 * Named here rather than imported so this module keeps no dependency on the
 * settler, and spelled once so the completion rule and its test cannot drift.
 */
export const SETTLED_ITEM_WORK_STAGE = 'settled';

/** Uploads one settler tick will look at. Cheap reads, and resumable. */
const MAX_UPLOADS_PER_PASS = 25;

/**
 * How many property ids go into one image query's filter.
 *
 * The list travels in the URL, so it is chunked rather than sent whole: a
 * thousand uuids is about 37 kB of query string and servers refuse it long
 * before that. Two hundred keeps a request comfortably short while an ordinary
 * upload of a few dozen properties still needs exactly one.
 */
const ITEM_FILTER_CHUNK = 200;

/**
 * How long a `parsing` row may be believed.
 *
 * An edge invocation is capped at roughly 150 seconds and stamps
 * `processing_started_at` before it begins, so six times that ceiling cannot
 * mistake a running import for an abandoned one — while a request killed on
 * its resource limit stops refusing the retry a quarter of an hour later
 * rather than never.
 */
export const ABANDONED_PARSE_MS = 15 * 60 * 1000;

/**
 * Is this `parsing` row a request that died, rather than one still running?
 *
 * Answers false for every other status: only a `parsing` row makes the claim
 * this question is about.
 */
export function parseIsAbandoned(
  upload: { status?: unknown; processing_started_at?: unknown },
  now: number = Date.now(),
): boolean {
  if (String(upload?.status) !== 'parsing') return false;
  const startedAt = Date.parse(String(upload?.processing_started_at ?? ''));
  /*
   * Every path that sets `parsing` stamps the start in the same write, so a
   * row without one cannot be an import in flight — and refusing the retry on
   * an unreadable stamp is the failure this exists to end.
   */
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ABANDONED_PARSE_MS;
}

export type SettledUploadStatus = 'complete' | 'partially_complete';

export type CompletionRefusal =
  | 'not_found'
  | 'not_completable'
  | 'items_outstanding'
  | 'read_failed';

export interface UploadCompletionOutcome {
  /** The status written, or null when nothing was written. */
  status: SettledUploadStatus | null;
  /** Why nothing was written. Absent on success. */
  refusal?: CompletionRefusal;
}

interface StageRow { source_stage: unknown; processing_status: unknown }

/**
 * The audit record a builder reads: how many images of each source stage
 * ended in each processing state.
 */
export function summariseImageStages(
  rows: StageRow[],
): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const stage = String(row.source_stage);
    const state = String(row.processing_status);
    summary[stage] = summary[stage] ?? {};
    summary[stage][state] = (summary[stage][state] ?? 0) + 1;
  }
  return summary;
}

/**
 * Is this entry a STAGE COUNT, rather than another tenant's metadata?
 *
 * `summariseImageStages` returns `Record<stage, Record<state, number>>`, so a
 * stage entry is an object whose every value is a number — `{ ready: 78 }`.
 * Everything else in the document belongs to somebody else and is not this
 * function's to recompute: `repairSourceImages` keeps
 * `notion_row_assets_version: 23` here, a scalar, which fails this test and
 * survives.
 *
 * An empty object IS stage-shaped and is treated as one, which is right: a
 * stage that counted nothing is still a stage key.
 */
export function isStageCountEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((count) => typeof count === 'number' && Number.isFinite(count));
}

/**
 * The document to write: fresh stage counts, other tenants untouched.
 *
 * THE STAGE KEYS ARE REPLACED AS A SET, NOT MERGED KEY BY KEY. A spread of the
 * old document under the new one preserves `notion_row_assets_version` — the
 * thing it was added for — but it also preserves any stage the recomputation
 * NO LONGER produces. An upload whose Street View image has since been retired
 * would keep `street_view: { ready: 1 }` for ever beside its true counts, and
 * the contract for this column is that its stage counts are recomputed.
 *
 * So the old stage entries are dropped wholesale and the new ones stand alone,
 * while every non-stage key is carried across.
 */
export function mergeStageSummary(
  existing: unknown,
  fresh: Record<string, Record<string, number>>,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  const document = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(document)) {
    if (!isStageCountEntry(value)) carried[key] = value;
  }
  return { ...carried, ...fresh };
}

/** The import's own verdict, not the imagery's. */
export function finalUploadStatus(recordsFailed: unknown): SettledUploadStatus {
  return Number(recordsFailed ?? 0) > 0 ? 'partially_complete' : 'complete';
}

/**
 * Settle ONE upload, if its properties are finished with enrichment.
 *
 * Returns the status written, or the reason nothing was. Never throws: a
 * caller settles records as housekeeping and must not fail its own work over
 * it.
 */
export async function settleUploadCompletion(
  db: any,
  params: { uploadId: string; organisationId?: string | null },
): Promise<UploadCompletionOutcome> {
  const uploadId = String(params.uploadId ?? '');
  if (!uploadId) return { status: null, refusal: 'not_found' };

  try {
    let uploadQuery = db
      .from('builder_stock_uploads')
      .select('id, organisation_id, status, records_failed, deleted_at, image_stage_summary')
      .eq('id', uploadId);
    if (params.organisationId) {
      uploadQuery = uploadQuery.eq('organisation_id', params.organisationId);
    }
    const { data: upload, error: uploadError } = await uploadQuery.maybeSingle();
    if (uploadError) return { status: null, refusal: 'read_failed' };
    if (!upload) return { status: null, refusal: 'not_found' };
    if (upload.deleted_at) return { status: null, refusal: 'not_completable' };
    if (!COMPLETABLE_UPLOAD_STATUSES.includes(String(upload.status))) {
      return { status: null, refusal: 'not_completable' };
    }

    /*
     * The properties alone decide, and a FAILED count is not a count of zero:
     * a database fault must leave the upload exactly as it found it.
     *
     * AND A SETTLED LADDER IS FINISHED, WHATEVER THE LEGACY LATCH SAYS.
     *
     * `enrichment_status` is written by the fallback ladder, from the ladder's
     * own opinion of whether a property still owes a rung. A property whose
     * picture came from the builder's own document never needs that ladder, so
     * nothing writes the column and it keeps the `pending` its import gave it —
     * for ever. This question then answers "outstanding" about a property that
     * has been finished for hours, and the upload can never be completed.
     *
     * MEASURED 7 SEPTEMBER 2026: 83 of 91 active properties across this
     * deployment were `image_work_stage = 'settled'` and carrying their image
     * while still reading `enrichment_status = 'pending'`, so 15 of the 17
     * uploads made in two days sat at `enriching` permanently. A builder is
     * told an import is still churning long after every photograph landed.
     *
     * `image_work_stage` is what actually does this work now and `settled` is
     * its terminal rung, so it is asked here as well. The two are ANDed, which
     * only ever makes completion more reachable: an upload that completes today
     * still completes, and a property that is genuinely mid-ladder is still
     * outstanding under either column.
     *
     * Deliberately NOT changed: how displayability is judged, what the ladder
     * writes, and `readFallbackQueue`, which still selects on
     * `enrichment_status` alone. Marking a property terminal in THAT queue is
     * how one stops being offered the ladder it is owed, which is a worse
     * failure than a stale label — so this reads the column and never writes it.
     */
    const { count, error: countError } = await db
      .from('builder_stock_items')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', upload.organisation_id)
      .eq('upload_id', uploadId)
      .eq('lifecycle_status', 'active')
      .in('enrichment_status', UNFINISHED_ENRICHMENT_STATUSES)
      .neq('image_work_stage', SETTLED_ITEM_WORK_STAGE);
    if (countError) return { status: null, refusal: 'read_failed' };
    if ((count ?? 0) > 0) return { status: null, refusal: 'items_outstanding' };

    /*
     * THE SUMMARY FOLLOWS THE PROPERTIES, NOT THE IMAGE ROW'S `upload_id`.
     *
     * The column's contract is "per-stage image counts" for this upload, and
     * the Builder Portal renders it as `Images: uploaded document 78 · …`.
     * This read used to ask for image rows carrying THIS upload's id, and an
     * image keeps the id of the upload that stored it — so on a RE-UPLOAD,
     * where every row is matched and re-pointed to the new upload, not one
     * image carries the new id and the summary is written `{}`.
     *
     * MEASURED 7 SEPTEMBER 2026 on upload `5412982c`, 78 properties each
     * carrying its builder's own photograph: 78 images carried the superseded
     * upload's id, 156 carried none at all, and none carried the current
     * upload's. The audit record then stated, permanently, that no images were
     * processed — the exact falsehood the paged read below already refuses to
     * write on a database fault, reached by a different route.
     *
     * So the properties are read first and their images second. A NULL
     * `upload_id` on an image is thereby irrelevant rather than fatal, which
     * is the point: what makes an image this upload's is the property it
     * belongs to.
     *
     * Every item of this upload counts, at any lifecycle. A first-time
     * import's rows may still be `staged` when it completes, and narrowing to
     * `active` would empty the summary for exactly the path that works today.
     */
    const itemPage = await readAllRows<{ id: unknown }>(
      () => db
        .from('builder_stock_items')
        .select('id')
        .eq('organisation_id', upload.organisation_id)
        .eq('upload_id', uploadId)
        .order('id', { ascending: true }));
    if (itemPage.failed) return { status: null, refusal: 'read_failed' };

    const itemIds = itemPage.rows
      .map((row) => String(row.id ?? ''))
      .filter((id) => id.length > 0);

    /*
     * Paged, because the API caps a response at 1,000 rows however the limit
     * is written — and an incomplete read is never written from, because the
     * summary it would produce understates the work permanently.
     *
     * Chunked as well, because the property list goes into the request as a
     * filter and an unbounded `in` is a URL long enough to be refused.
     */
    const stageRows: StageRow[] = [];
    for (let at = 0; at < itemIds.length; at += ITEM_FILTER_CHUNK) {
      const chunk = itemIds.slice(at, at + ITEM_FILTER_CHUNK);
      const stagePage = await readAllRows<StageRow>(
        () => db
          .from('builder_stock_item_images')
          .select('id, source_stage, processing_status')
          .in('stock_item_id', chunk)
          .order('id', { ascending: true }));
      if (stagePage.failed) return { status: null, refusal: 'read_failed' };
      stageRows.push(...stagePage.rows);
    }

    const status = finalUploadStatus(upload.records_failed);
    /*
     * This document has another tenant. `repairSourceImages` records
     * `notion_row_assets_version` here — its own comment says the key "is
     * MERGED, never written over the stage counts beside it" — while this
     * write replaced the whole document and silently dropped it, costing that
     * upload a re-fetch of its live source on every later run.
     *
     * `mergeStageSummary` keeps that key and replaces the stage counts AS A
     * SET, so a stage this recomputation no longer produces disappears rather
     * than standing for ever beside the true numbers.
     */
    const { error: writeError } = await db
      .from('builder_stock_uploads')
      .update({
        status,
        image_stage_summary: mergeStageSummary(
          upload.image_stage_summary, summariseImageStages(stageRows)),
      })
      .eq('id', uploadId);
    if (writeError) return { status: null, refusal: 'read_failed' };

    console.info('[builderStock] upload settled', {
      phase: 'upload_completion', upload_id: uploadId, status,
    });
    return { status };
  } catch (error) {
    console.warn('[builderStock] upload completion failed', {
      phase: 'upload_completion', upload_id: uploadId,
      message: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
    return { status: null, refusal: 'read_failed' };
  }
}

export interface UploadCompletionPassOutcome {
  inspected: number;
  settled: number;
}

/**
 * Settle every upload whose properties have finished — the pass the settler
 * runs, because an import that completes headlessly has nobody to settle it.
 *
 * Enumerates its own work rather than being handed a queue: an upload waiting
 * for its status is not settlement work, and the steady state — nothing left
 * to settle — is exactly when this matters.
 */
export async function settleCompletedUploads(
  db: any,
  params: { organisationId?: string | null; limit?: number } = {},
): Promise<UploadCompletionPassOutcome> {
  const outcome: UploadCompletionPassOutcome = { inspected: 0, settled: 0 };
  try {
    let query = db
      .from('builder_stock_uploads')
      .select('id')
      .is('deleted_at', null)
      .in('status', COMPLETABLE_UPLOAD_STATUSES)
      .order('created_at', { ascending: true })
      .limit(Math.max(1, params.limit ?? MAX_UPLOADS_PER_PASS));
    if (params.organisationId) {
      query = query.eq('organisation_id', params.organisationId);
    }
    const { data: rows, error } = await query;
    if (error || !rows?.length) return outcome;

    for (const row of rows as Array<{ id: string }>) {
      outcome.inspected += 1;
      const settled = await settleUploadCompletion(db, {
        uploadId: String(row.id),
        organisationId: params.organisationId ?? null,
      });
      if (settled.status) outcome.settled += 1;
    }
  } catch (error) {
    // Housekeeping must never fail the tick it rides in.
    console.warn('[builderStock] upload completion pass failed', {
      phase: 'upload_completion',
      message: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
  return outcome;
}
