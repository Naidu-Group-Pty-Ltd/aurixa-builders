/**
 * BUILDER STOCK — BRINGING ALREADY-IMPORTED STOCK ONTO THE CURRENT READER.
 *
 * The sweep `readerVersion.pure.ts` describes. One upload per tick: re-read
 * the builder's OWN stored file through the SAME `runStockImport` the first
 * pass ran, then stamp the reader version on the upload row.
 *
 * WHAT IT IS ALLOWED TO CHANGE, and why that is safe.
 *
 * Nothing here re-implements an import. `runStockImport` matches rows by the
 * identity rule the import already uses and corrects them in place, so a
 * property keeps its id, its history, its selections and anything a client has
 * done with it — and `writablePatch`'s `sameSourceReread` is what lets the
 * SAME source retract a field it no longer states, which is the whole point:
 * a `unit_number` of `115.30m 12.41sq` has to be able to become nothing.
 *
 * The bytes are the builder's own file and have not changed, so this cannot
 * import anybody's edits and cannot reach the network for content. A LINKED
 * source — where re-reading WOULD mean deciding to import somebody's edits —
 * is refused by `readerReReadRefusal` and never reaches this module.
 *
 * WHAT IT MUST NEVER DO, and what enforces it:
 *
 *   - Archive a live property. The import supersedes by `upload_id` and this
 *     re-runs the SAME upload, so every row it touches is its own.
 *   - Start a first pass. `RE_READABLE_STATUSES` excludes `failed` and
 *     `uploaded`: a source nothing has ever read is the builder's to process.
 *   - Ask an unanswerable question twice. Every refusal is STAMPED, so an
 *     upload this sweep cannot act on leaves the queue rather than being
 *     re-asked every tick for ever — the liveness fault
 *     `repairSourceImagesForUpload` was once held still by.
 *   - Fail a tick. Every exit is a recorded outcome; a throw is caught, named
 *     and left OUTSTANDING, because an upload we could not read is not an
 *     upload we have read at this version.
 *
 * IT RIDES THE SAME PUBLICATION RULES AS ANY IMPORT. `runStockImport` kicks
 * the image work and asks `publish_builder_stock_upload` itself, so a
 * correction to a PUBLISHED list lands through `pending_patch` exactly as a
 * builder's own "Read again" does.
 */
import type { runStockImport } from './runImport.ts';
import {
  DETERMINISTIC_READER_VERSION, READER_SETTLED_VERSION_COLUMN,
  readerReReadRefusal, reReadSettlesAt, OUR_FAILURE_CODES,
  stampable, type ReaderSweepUpload,
} from './readerVersion.pure.ts';
import { TELEMETRY_PREFIX } from './importTelemetry.pure.ts';

/** The columns the sweep reads. Named once so the two queries cannot drift. */
const SWEEP_COLUMNS = 'id, organisation_id, uploaded_by_builder_user_id, original_filename, '
  + 'status, source_type, source_url, storage_bucket, storage_path, deleted_at, '
  + 'processing_started_at, error_code, error_detail, created_at';

interface SweepUploadRow extends ReaderSweepUpload {
  id: string;
  organisation_id: string;
  uploaded_by_builder_user_id?: string | null;
  original_filename?: string | null;
  error_code?: string | null;
  error_detail?: unknown;
}

export interface ReaderSweepOutcome {
  /** Uploads considered this tick. */
  considered: number;
  /** Uploads actually re-read. */
  reread: number;
  /** Uploads stamped without being read, and why. */
  refused: Array<{ uploadId: string; reason: string }>;
  /** Uploads left outstanding because the attempt failed. */
  failed: Array<{ uploadId: string; reason: string }>;
  /** True where the marker column is not deployed yet. */
  unavailable: boolean;
}

/**
 * ONE upload per tick, and that is not a tuning knob.
 *
 * A re-read parses a document, decodes every raster on every page it keeps and
 * classifies each one — the same work that killed this worker at ~16s and
 * again at ~20s on the import and repair paths. The sweep converges over ticks
 * rather than over uploads, exactly as the three image markers do.
 */
const MAX_REREADS_PER_TICK = 1;

/**
 * How much of the invocation a re-read needs before it is worth starting.
 * Below this the tick declines and leaves the upload outstanding — starting a
 * parse we cannot finish writes nothing and spends the budget anyway.
 */
export const READER_SWEEP_RESERVE_MS = 40_000;

/** Is anything outstanding? Cheap, so a tick with no work costs one query. */
export async function readerSweepPending(db: any): Promise<number | null> {
  try {
    const nulls = await db.from('builder_stock_uploads')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .is(READER_SETTLED_VERSION_COLUMN, null);
    if (nulls?.error) return null;
    const behind = await db.from('builder_stock_uploads')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .lt(READER_SETTLED_VERSION_COLUMN, DETERMINISTIC_READER_VERSION);
    if (behind?.error) return null;
    return Number(nulls.count ?? 0) + Number(behind.count ?? 0);
  } catch {
    return null;
  }
}

/**
 * The outstanding uploads, oldest first.
 *
 * Two plain indexed predicates rather than one `.or()` string — `IS NULL`
 * cannot be folded into a `<` comparison anyway, because PostgREST's `lt`
 * EXCLUDES nulls and nulls are precisely the rows that matter most here. The
 * same reasoning, and the same shape, as `readOutstandingUploads`.
 */
async function outstandingUploads(
  db: any, limit: number,
): Promise<{ rows: SweepUploadRow[]; unavailable: boolean }> {
  const base = () => db.from('builder_stock_uploads')
    .select(SWEEP_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  const results = await Promise.all([
    base().is(READER_SETTLED_VERSION_COLUMN, null),
    base().lt(READER_SETTLED_VERSION_COLUMN, DETERMINISTIC_READER_VERSION),
  ].map(async (read: any) => {
    try { return await read; } catch (error) { return { data: null, error }; }
  }));

  // Both failing the same way means the column is not deployed yet. The
  // settler must carry on with its other work rather than throwing.
  if (results.every((result: any) => result?.error)) return { rows: [], unavailable: true };

  const byId = new Map<string, SweepUploadRow>();
  for (const result of results as any[]) {
    if (result?.error) continue;
    for (const row of (result.data ?? []) as SweepUploadRow[]) {
      if (row?.id) byId.set(String(row.id), row);
    }
  }
  const rows = [...byId.values()].sort((a, b) =>
    String((a as any).created_at ?? '').localeCompare(String((b as any).created_at ?? ''))
    || String(a.id).localeCompare(String(b.id)));
  return { rows: rows.slice(0, limit), unavailable: false };
}

/** Write the marker. Never throws: a marker that cannot be written is a retry. */
async function stamp(db: any, upload: SweepUploadRow): Promise<void> {
  try {
    await db.from('builder_stock_uploads')
      .update({ [READER_SETTLED_VERSION_COLUMN]: DETERMINISTIC_READER_VERSION })
      .eq('id', upload.id)
      .eq('organisation_id', upload.organisation_id);
  } catch { /* outstanding is the safe side; the next tick asks again */ }
}

/**
 * Re-read every outstanding source this tick can afford.
 *
 * `deadlineAt` is the tick's own wall clock. Nothing is started without
 * `READER_SWEEP_RESERVE_MS` left, so the sweep never leaves a source part-read
 * with the marker unwritten AND the invocation gone.
 */
export async function settleReaderVersion(
  db: any,
  input: { deadlineAt?: number; limit?: number } = {},
  deps: { runImport?: typeof runStockImport } = {},
): Promise<ReaderSweepOutcome> {
  /*
   * IMPORTED WHERE IT IS SPENT, NEVER AT THE TOP.
   *
   * `runImport.ts` reaches the whole import pipeline — the readers, the
   * extractors, the raster decoder — and the overwhelming majority of ticks
   * call this function and re-read nothing at all. The same reasoning
   * `extract.ts` applies to the PDF asset discoverer: a guard must not
   * acquire an expensive dependency, and this module's decisions are also
   * what the ordinary test suite exercises, which a Deno-only import would
   * put out of reach. See `readerVersion.pure.ts`.
   */
  const runImport = deps.runImport
    ?? (async (...args: Parameters<typeof runStockImport>) =>
      (await import('./runImport.ts')).runStockImport(...args));
  const outcome: ReaderSweepOutcome = {
    considered: 0, reread: 0, refused: [], failed: [], unavailable: false,
  };

  const { rows, unavailable } = await outstandingUploads(
    db, Math.max(1, Math.min(input.limit ?? 25, 100)));
  if (unavailable) return { ...outcome, unavailable: true };

  const deadlineAt = input.deadlineAt ?? Number.MAX_SAFE_INTEGER;

  for (const upload of rows) {
    outcome.considered += 1;

    /*
     * THE REFUSALS FIRST, AND THEY ARE FREE.
     *
     * Tested before the budget, exactly as `repairSourceImagesForUpload` tests
     * its skip before its cap: the budget counts WORK, and stamping a linked
     * source is not work. Without this a tick whose queue opens with twenty
     * linked sources would spend its whole allowance reaching none of the
     * files it exists to re-read.
     */
    const refusal = readerReReadRefusal(upload, Date.now());
    if (refusal) {
      if (stampable(refusal)) {
        await stamp(db, upload);
        outcome.refused.push({ uploadId: upload.id, reason: refusal });
      } else {
        // A parse that is genuinely running. Left outstanding deliberately:
        // stamping it would record a version against a read we did not do.
        outcome.failed.push({ uploadId: upload.id, reason: refusal });
      }
      continue;
    }

    if (outcome.reread >= MAX_REREADS_PER_TICK) break;
    if (Date.now() + READER_SWEEP_RESERVE_MS > deadlineAt) break;

    try {
      const { data: blob, error: downloadError } = await db.storage
        .from(String(upload.storage_bucket))
        .download(String(upload.storage_path));
      if (downloadError || !blob) {
        /*
         * THE OBJECT IS GONE, AND THAT IS A FINISHED ANSWER.
         *
         * A source whose bytes no longer exist can never be re-read by
         * anything, so leaving it outstanding re-asks an unanswerable question
         * every tick. Stamped, and the rows it wrote are untouched — they are
         * still the builder's stock and nothing here judges them.
         */
        await stamp(db, upload);
        outcome.refused.push({ uploadId: upload.id, reason: 'object_missing' });
        continue;
      }

      const organisationName = await tradingName(db, upload.organisation_id);
      const result = await runImport({
        supabase: db,
        organisationId: String(upload.organisation_id),
        organisationName,
        /*
         * THE PERSON WHO UPLOADED IT, never the sweep. `created_by_builder_user_id`
         * is written on rows this import CREATES, and attributing those to a
         * cron tick would put a property in the register with no author. A row
         * with no recorded uploader keeps the empty string the column already
         * tolerates rather than inventing one.
         */
        builderUserId: String(upload.uploaded_by_builder_user_id ?? ''),
        upload: {
          id: String(upload.id),
          original_filename: String(upload.original_filename ?? ''),
        },
        bytes: new Uint8Array(await blob.arrayBuffer()),
        sourceKind: 'file',
      });

      if (!result.ok) {
        /*
         * A READ THAT FAILED LEAVES THE UPLOAD EXACTLY AS IT WAS.
         *
         * No status is written, no error code, no counts. The rows this source
         * already produced are live stock and a sweep that could not read the
         * file has learned nothing about them — writing `failed` over a
         * healthy list is the defect `49-re-importing-a-linked-stock-list.md`
         * records under "a read that FAILED is not a builder who has added
         * nothing". Left OUTSTANDING so a transient fault is retried.
         */
        outcome.failed.push({ uploadId: upload.id, reason: String(result.code) });
        /*
         * A VERDICT IS FINISHED; A FAULT IS NOT. See `DOCUMENT_VERDICT_CODES`.
         * Re-asking the same bytes of the same reader cannot change a verdict,
         * so the source is stamped and stops being outstanding. A fault is
         * left exactly as it was, which is the paragraph above.
         */
        if (reReadSettlesAt(result.code)) {
          await supersedeOurFailure(db, upload, result);
          await stamp(db, upload);
        }
        continue;
      }

      await writeImportOutcome(db, upload, result, String(upload.status ?? ''));
      await stamp(db, upload);
      outcome.reread += 1;
      console.info(`${TELEMETRY_PREFIX} reader sweep re-read`, {
        upload_id: upload.id,
        organisation_id: upload.organisation_id,
        reader_version: DETERMINISTIC_READER_VERSION,
        detected: result.summary.detected,
        updated: result.summary.updated,
        imported: result.summary.imported,
        failed: result.summary.failed,
        with_source_image: result.summary.withSourceImage,
      });
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error).slice(0, 200);
      outcome.failed.push({ uploadId: upload.id, reason: message });
      console.warn('[builderStock] reader sweep failed', {
        upload_id: upload.id, phase: 'reader_sweep', message,
      });
    }
  }

  return outcome;
}

/** The organisation's own name, for the messages an import composes. */
async function tradingName(db: any, organisationId: unknown): Promise<string | null> {
  try {
    const { data } = await db.from('builder_organisations')
      .select('trading_name, legal_name')
      .eq('id', organisationId)
      .maybeSingle();
    return (data?.trading_name ?? data?.legal_name ?? null) as string | null;
  } catch {
    return null;
  }
}

/**
 * The counts and the diagnosis, written the way the portal writes them.
 *
 * `status` is NOT written here and that is deliberate: the portal's
 * `finishImport` moves an upload forward through its own lifecycle under a
 * person's eyes, and a sweep re-reading a `complete` list must not move it back
 * to `enriching` and make a settled list look busy. What this records is what
 * the READ found — the counts and the unnamed lines — so a support question
 * about a swept row has the same answer a builder's own re-read would give.
 */
/**
 * REPLACE AN ERROR THAT WAS OURS WITH THE ANSWER THE DOCUMENT NOW GETS.
 *
 * `writeImportOutcome` clears a stale failure only where the STATUS is
 * `failed`, and that missed the case this whole incident is about.
 * MEASURED 21 SEPTEMBER 2026: `Lot 37 - Miami 190 - Property Package.pdf`
 * sits at status `imported` with `records_detected: 0` and
 * `error_code: assisted_reader_refused`, detail
 * `openrouter/openai/gpt-5.6-luna: refused 402` — an account with no credit.
 * It has since been re-read repeatedly with no model call at all, and the row
 * still showed the model's refusal, because the status was never `failed` and
 * nothing else clears an error.
 *
 * So a builder looking at that list is told their brochure failed for a
 * reason that has not applied since the model left this path.
 *
 * NARROW ON PURPOSE. It replaces the recorded reason only where that reason
 * is one of OURS — a credential, an account, a provider, an allowance, a
 * crash — because those are the ones that can be superseded by a read that
 * did not need them. An error already describing the FILE is left alone: the
 * re-read reached the same kind of answer and rewriting it would churn the
 * row for nothing. The STATUS is never touched here, for the reason the
 * branch above gives: rows this source already produced are live stock.
 */
async function supersedeOurFailure(
  db: any, upload: SweepUploadRow, result: any,
): Promise<void> {
  if (!OUR_FAILURE_CODES.has(String((upload as any).error_code ?? ''))) return;
  try {
    await db.from('builder_stock_uploads').update({
      error_code: String(result.code),
      error_message: String(result.message ?? ''),
      error_detail: result.detail ? { detail: String(result.detail) } : null,
    }).eq('id', upload.id).eq('organisation_id', upload.organisation_id);
  } catch { /* the read landed; the record of it is best-effort */ }
}

async function writeImportOutcome(
  db: any, upload: SweepUploadRow, result: any, statusBefore = '',
): Promise<void> {
  try {
    const diagnosis = result.deterministicIgnored?.length
      ? {
        deterministic_ignored: result.deterministicIgnored,
        deterministic_placement: result.deterministicPlacement ?? null,
      }
      : null;
    const failures = result.summary.failures?.length
      ? { failures: result.summary.failures }
      : null;
    /*
     * A FAILED UPLOAD THAT NOW IMPORTS MUST STOP SAYING FAILED.
     *
     * The rule above — a sweep writes no status — exists so a settled list is
     * not made to look busy by work nobody asked for. It means the opposite
     * here: the row says `failed` for a reason that was ours, this read
     * succeeded, and leaving the stamp hides a real import behind a stale
     * error. `result.uploadStatus` is the import's own answer, the same field
     * the portal's `finishImport` writes, so a swept row and a builder's own
     * re-read cannot end in different states.
     */
    const clearedFailure = statusBefore === 'failed'
      ? { status: result.uploadStatus, error_code: null, error_message: null }
      : {};
    await db.from('builder_stock_uploads').update({
      ...clearedFailure,
      records_detected: result.summary.detected,
      records_imported: result.summary.imported,
      records_updated: result.summary.updated,
      records_failed: result.summary.failed,
      error_detail: (failures || diagnosis)
        ? { ...(failures ?? {}), ...(diagnosis ?? {}) }
        : null,
      processing_completed_at: new Date().toISOString(),
    }).eq('id', upload.id).eq('organisation_id', upload.organisation_id);
  } catch { /* the read landed; the record of it is best-effort */ }
}
