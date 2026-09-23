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
 *   - Import a first pass beside the builder's own. An `uploaded` row is adopted
 *     only once it is abandoned (`ABANDONED_UPLOAD_MS`) and only through a
 *     conditional claim, so a returning browser and a tick cannot both read it.
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
 *
 * ===========================================================================
 * AND IT READS THE WAY AN IMPORT READS: ACROSS ISOLATES, ONE CLAIM AT A TIME
 * ===========================================================================
 *
 * It used to re-read INLINE — `runStockImport` without
 * `resumableFromStoredBytes`, so a paginated brochure was parsed and its
 * pictures decoded in the same isolate. That is the shape the import was
 * rebuilt to avoid, and it is where `LOT 550 - ENZO 8.5 MODERN- BROCHURE
 * V002.pdf` killed the settler fifteen times over 22 and 23 September 2026:
 * a kill writes nothing, the row stayed outstanding with no bound on its
 * attempts, and the oldest-first queue put it back at the front of every quiet
 * tick. The reader version was fenced at 13 until this changed.
 *
 * Now a re-read is the same call "Read again" makes — the stored checkpoint,
 * `resumableFromStoredBytes` — and where the import hands its pictures to a
 * successor, so does the sweep:
 *
 *   • A row the sweep did not move to `parsing` (every settled list) is
 *     continued by the SWEEP: the claim is released, the next settler is
 *     dispatched now (`builder_stock_dispatch_reader_sweep`), and that tick
 *     resumes the checkpoint this one wrote. The fifteen-minute heartbeat is
 *     the recovery, never the transport. Its status is never touched, for the
 *     reason the rest of this module gives.
 *   • A row that IS `parsing` — a first pass the sweep adopted, or an import
 *     that was abandoned — is an import, and is handed to the import's own
 *     successor (`releaseThenContinue`), which finishes it with the columns
 *     every import finishes with.
 *
 * `claimImport` is taken before anything is read, so the sweep can never be a
 * second reader beside an import, a continuation or another settler. And
 * every tick is written down BEFORE it works (`readerSweepAttempt.pure.ts`),
 * so a tick the runtime kills is still counted, and a document that keeps
 * killing it is asked `MAX_UNFINISHED_SWEEP_TICKS` times at a version rather
 * than for ever.
 */
import type { runStockImport } from './runImport.ts';
import { isImportContinuation } from './importContinuation.pure.ts';
import { tradingName } from './organisationName.ts';
import {
  DETERMINISTIC_READER_VERSION, READER_SETTLED_VERSION_COLUMN,
  readerReReadRefusal, reReadSettlesAt,
  stampable, type ReaderSweepUpload,
} from './readerVersion.pure.ts';
import {
  READER_SWEEP_ATTEMPT_COLUMN, planSweepTick, readSweepAttempt,
  sweepHandedOn, sweepTickEnded, type ReaderSweepAttempt,
} from './readerSweepAttempt.pure.ts';
import { claimImport, releaseThenContinue } from './importClaim.ts';
import { isAcceptableStockStoragePath } from './fileTypes.pure.ts';
import { closeRefusedUpload } from './closeRefusedUpload.ts';
import { TELEMETRY_PREFIX } from './importTelemetry.pure.ts';

/** The columns the sweep reads. Named once so the two queries cannot drift. */
const SWEEP_COLUMNS = 'id, organisation_id, uploaded_by_builder_user_id, original_filename, '
  + 'status, source_type, source_url, storage_bucket, storage_path, deleted_at, '
  + `processing_started_at, error_code, error_detail, created_at, ${READER_SWEEP_ATTEMPT_COLUMN}`;

/**
 * What a re-read resumes from, read for the ONE upload being read and only
 * once its claim is held. `import_checkpoint` can carry a scanned document's
 * recognised text, so it is never part of the listing, which reads a page of
 * uploads at a time.
 */
const STATE_COLUMNS = 'status, processing_started_at, '
  + `${READER_SETTLED_VERSION_COLUMN}, ${READER_SWEEP_ATTEMPT_COLUMN}, `
  + 'import_checkpoint, stage_timings';

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
  /**
   * Uploads not read this tick, and why. Stamped, except where somebody else
   * is reading the document (`claimed_elsewhere`) or the row moved on under
   * the claim (`moved_on`): those are statements about right now.
   */
  refused: Array<{ uploadId: string; reason: string }>;
  /** Uploads left outstanding because the attempt failed. */
  failed: Array<{ uploadId: string; reason: string }>;
  /**
   * Uploads whose read was handed to a successor, and which one: the sweep's
   * own next tick, or the import's continuation. Still outstanding — the
   * successor stamps them.
   */
  handedOn: Array<{ uploadId: string; via: 'reader_sweep' | 'import_continuation' }>;
  /** True where the marker column is not deployed yet. */
  unavailable: boolean;
}

/**
 * ONE read STARTED per tick, and that is not a tuning knob.
 *
 * A re-read parses a document — the work that, with its pictures decoded
 * beside it, killed this worker at ~16s and again at ~20s on the import and
 * repair paths. The sweep converges over ticks rather than over uploads,
 * exactly as the three image markers do. A read that hands on or fails has
 * spent the tick's parse as surely as one that finishes, so it is the START
 * that is counted: a tick never parses a second document after a first.
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

/**
 * Write the marker — and, where this sweep read the document, how the read
 * ended, in the same write. Never throws: a marker that cannot be written is a
 * retry.
 */
async function stamp(
  db: any, upload: SweepUploadRow, attempt: ReaderSweepAttempt | null = null,
): Promise<void> {
  try {
    await db.from('builder_stock_uploads')
      .update({
        [READER_SETTLED_VERSION_COLUMN]: DETERMINISTIC_READER_VERSION,
        ...(attempt ? { [READER_SWEEP_ATTEMPT_COLUMN]: attempt } : {}),
      })
      .eq('id', upload.id)
      .eq('organisation_id', upload.organisation_id);
  } catch { /* outstanding is the safe side; the next tick asks again */ }
}

/**
 * Record where this upload's re-read stands. Answers whether it landed,
 * because the tick that records `started` is the one a kill would otherwise
 * erase — and a tick whose start could not be recorded is not started.
 */
async function recordAttempt(
  db: any, upload: SweepUploadRow, attempt: ReaderSweepAttempt,
): Promise<boolean> {
  try {
    const { error } = await db.from('builder_stock_uploads')
      .update({ [READER_SWEEP_ATTEMPT_COLUMN]: attempt })
      .eq('id', upload.id)
      .eq('organisation_id', upload.organisation_id);
    return !error;
  } catch {
    return false;
  }
}

/** What this one upload resumes from, read under its claim. Null where it cannot be read. */
async function readSweepState(
  db: any, upload: SweepUploadRow,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await db.from('builder_stock_uploads')
      .select(STATE_COLUMNS)
      .eq('id', upload.id)
      .eq('organisation_id', upload.organisation_id)
      .limit(1);
    if (error) return null;
    return ((data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * START THE NEXT SETTLER NOW, so a handed-on re-read continues in seconds.
 *
 * The same signed dispatcher every other hand-off uses, and the same
 * contract: an accelerator, never the guarantee. A dispatch that is lost
 * leaves the upload outstanding, and the heartbeat that runs the sweep every
 * fifteen minutes reaches it — later, never never.
 */
async function dispatchReaderSweep(db: any): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('builder_stock_dispatch_reader_sweep');
    return !error && data !== false;
  } catch {
    return false;
  }
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
    considered: 0, reread: 0, refused: [], failed: [], handedOn: [], unavailable: false,
  };

  const { rows, unavailable } = await outstandingUploads(
    db, Math.max(1, Math.min(input.limit ?? 25, 100)));
  if (unavailable) return { ...outcome, unavailable: true };

  const deadlineAt = input.deadlineAt ?? Number.MAX_SAFE_INTEGER;
  /** Reads this tick STARTED — see `MAX_REREADS_PER_TICK`. */
  let started = 0;

  /*
   * A RE-READ ALREADY UNDER WAY IS FINISHED BEFORE ANOTHER IS BEGUN. Its
   * pictures are sitting in storage waiting for the isolate that attaches
   * them, and starting a second document first would leave them there for
   * the length of that document's read as well as its own. Otherwise the
   * order is the listing's: oldest first.
   */
  const underWay = (row: SweepUploadRow) =>
    readSweepAttempt(row.reader_sweep_attempt, DETERMINISTIC_READER_VERSION)?.last === 'handed_on';
  const ordered = [...rows.filter(underWay), ...rows.filter((row) => !underWay(row))];

  for (const upload of ordered) {
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

    if (started >= MAX_REREADS_PER_TICK) break;
    if (Date.now() + READER_SWEEP_RESERVE_MS > deadlineAt) break;

    /*
     * ONE READER PER DOCUMENT, AND THE CLAIM COMES FIRST.
     *
     * The same `builder_stock_claim_import` every import and continuation
     * takes, taken before the row is looked at again, let alone read. `held`
     * means somebody else is reading this document right now — a builder's
     * import, a continuation, another settler resuming this very re-read —
     * and the right answer is to do nothing at all and write nothing down.
     * `unavailable` (a deployment the migration has not reached) proceeds
     * unclaimed, exactly as every import did before the claim existed.
     */
    const claimed = await claimImport(db, String(upload.id));
    if (!claimed.ok && claimed.reason === 'held') {
      outcome.refused.push({ uploadId: upload.id, reason: 'claimed_elsewhere' });
      continue;
    }
    const claim = claimed.ok ? claimed.claim : null;
    /** Set once the hand-off has released the claim itself. */
    let released = false;

    /*
     * WHAT THE ROW WAS BEFORE THIS TICK TOUCHED IT.
     *
     * The claim below rewrites `upload.status`, and two decisions downstream
     * read it: `writeImportOutcome` writes a status only for the states a
     * successful read plainly contradicts, and the failure branch below has
     * to know whether the `parsing` it is looking at is this tick's doing.
     * Reading the mutated value would make a claimed first pass look like an
     * ordinary re-read and leave it at `parsing` — which is the stranded
     * state this whole change exists to end, reintroduced one line later.
     */
    const statusBefore = String(upload.status ?? '');
    /** This tick adopts an `uploaded` row: nobody has ever imported it. */
    const adopts = statusBefore === 'uploaded';
    let firstPass = adopts;
    let tick: ReaderSweepAttempt | null = null;
    const now = () => new Date().toISOString();

    try {
      /*
       * READ AGAIN, UNDER THE CLAIM, WHAT THE LISTING SAW A MOMENT AGO.
       *
       * Between the listing and the claim a builder can have pressed "Read
       * again", or a successor can have finished this re-read and stamped
       * it. Either way the row has moved on and is not this tick's.
       */
      const state = await readSweepState(db, upload);
      if (!state) {
        outcome.failed.push({ uploadId: upload.id, reason: 'state_unreadable' });
        continue;
      }
      if (String(state.status ?? '') !== statusBefore
        || Number(state[READER_SETTLED_VERSION_COLUMN] ?? -1) >= DETERMINISTIC_READER_VERSION) {
        outcome.refused.push({ uploadId: upload.id, reason: 'moved_on' });
        continue;
      }

      /*
       * WHERE THIS TICK STANDS IN THE UPLOAD'S RE-READ, WRITTEN DOWN FIRST.
       *
       * A first pass is stamped with the moment this tick adopts it, and that
       * stamp is the attempt's fingerprint — so it is decided here, before
       * the record that carries it is written.
       */
      const claimedAt = now();
      const plan = planSweepTick(
        readSweepAttempt(state[READER_SWEEP_ATTEMPT_COLUMN], DETERMINISTIC_READER_VERSION),
        {
          version: DETERMINISTIC_READER_VERSION,
          processingStartedAt: adopts
            ? claimedAt
            : (typeof state.processing_started_at === 'string' ? state.processing_started_at : null),
          firstPass: adopts,
          now: claimedAt,
        },
      );
      tick = plan.next;
      firstPass = plan.next.first_pass;

      /*
       * A DOCUMENT THAT KEEPS KILLING THE TICK STOPS BEING ASKED.
       *
       * The fault this module was rebuilt for: a kill writes nothing, and a
       * row with no bound on its attempts stood at the head of the queue for
       * ever. What stops here is the RE-READ at this version; the rows the
       * document already produced are untouched, and "Read again" is the
       * builder's as it always was. A first pass has no rows, so it is put
       * down honestly rather than left to be adopted again.
       */
      if (plan.exhausted) {
        console.warn(`${TELEMETRY_PREFIX} reader sweep gave up`, {
          upload_id: upload.id,
          organisation_id: upload.organisation_id,
          reader_version: DETERMINISTIC_READER_VERSION,
          ticks: plan.next.ticks - 1,
          unfinished: plan.next.unfinished,
          handed_on: plan.next.handed_on,
        });
        if (firstPass) {
          await closeRefusedUpload(db, {
            uploadId: String(upload.id),
            organisationId: String(upload.organisation_id),
            code: 'processing_failed',
            message: 'That file could not be processed. Please check the format and try again.',
            detail: { phase: 'reader_sweep_attempts_exhausted' },
          });
        }
        await stamp(db, upload,
          sweepTickEnded({ ...plan.next, ticks: plan.next.ticks - 1 }, 'gave_up', now()));
        outcome.refused.push({ uploadId: upload.id, reason: 'attempts_exhausted' });
        continue;
      }

      if (!await recordAttempt(db, upload, plan.next)) {
        // Uncounted work is unbounded work: a tick that cannot say it started
        // does not start. Nothing else has been touched.
        outcome.failed.push({ uploadId: upload.id, reason: 'attempt_not_recorded' });
        continue;
      }
      started += 1;

      /*
       * A FIRST PASS IS CLAIMED; A RE-READ IS NOT.
       *
       * An `uploaded` row is one nobody has ever imported — the bytes landed,
       * the browser never came back, and `RE_READABLE_STATUSES` now admits it
       * so the file is not stranded for ever. That is the ONE case where this
       * sweep and a customer's own `process_upload` could both be about to
       * write the same properties, because every other re-readable status is
       * one the portal already refuses to start from.
       *
       * So the row is claimed: `uploaded` → `parsing`, conditional on it still
       * being `uploaded`. Whichever of the two gets there first is the one that
       * imports, and the other is refused by the status it now reads. The
       * condition is the whole guard — an unconditional update would claim a
       * row the browser had just claimed, and two imports of one file is the
       * duplicate fork this subsystem must never produce.
       *
       * A claim that takes nothing is not a failure: somebody else is doing
       * the work. The row is left alone and unstamped, and the next tick will
       * find it in whatever state they left it.
       */
      if (adopts) {
        const { data: claimedRows, error: claimError } = await db
          .from('builder_stock_uploads')
          .update({ status: 'parsing', processing_started_at: claimedAt })
          .eq('id', upload.id)
          .eq('organisation_id', upload.organisation_id)
          .eq('status', 'uploaded')
          .select('id');
        if (claimError) {
          // A fault, not a verdict: left outstanding, exactly as a failed read is.
          outcome.failed.push({ uploadId: upload.id, reason: 'claim_failed' });
          continue;
        }
        if (!(claimedRows ?? []).length) {
          outcome.refused.push({ uploadId: upload.id, reason: 'claimed_elsewhere' });
          continue;
        }
        upload.status = 'parsing';
      }

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
        // A CLAIMED ROW IS PUT DOWN, for the reason the failure branch below
        // states: this tick moved it, so this tick owes it a terminal status.
        if (firstPass) {
          await closeRefusedUpload(db, {
            uploadId: String(upload.id),
            organisationId: String(upload.organisation_id),
            code: 'file_missing',
            message: 'The uploaded file could not be read. Please upload it again.',
          });
        }
        await stamp(db, upload, sweepTickEnded(plan.next, 'object_missing', now()));
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
        /*
         * THE SAME CALL "READ AGAIN" MAKES ON A FILE, and a successor's where
         * this tick is one. The checkpoint is discarded unless its digest is
         * these bytes', so it can only ever carry facts about this document;
         * a FRESH attempt still takes its recognised pages and puts away
         * anything an earlier attempt handed on (`freshAttempt`).
         */
        storedCheckpoint: state.import_checkpoint ?? null,
        ledger: plan.resumes ? (state.stage_timings as Record<string, unknown> | null ?? null) : null,
        resumed: plan.resumes,
        resumableFromStoredBytes: true,
      });

      /*
       * HANDED ON: THE PICTURES GO TO AN ISOLATE THAT DID NOT PARSE THE
       * DOCUMENT, AND THE RE-READ STAYS OUTSTANDING UNTIL THAT ONE FINISHES.
       *
       * Recorded before the claim is let go, so whoever takes it next reads a
       * chain with a hand-off in it and resumes rather than starting again.
       */
      if (isImportContinuation(result)) {
        tick = sweepHandedOn(plan.next, now());
        await recordAttempt(db, upload, tick);
        let via: 'reader_sweep' | 'import_continuation';
        if (String(upload.status ?? '') === 'parsing'
          && isAcceptableStockStoragePath(String(upload.storage_path ?? ''))) {
          /*
           * AN IMPORT, SO THE IMPORT'S OWN SUCCESSOR. A `parsing` row is a
           * first pass this tick adopted or an import that was abandoned, and
           * `continueStockImport` finishes it with the columns every import
           * finishes with — its status, its counts, its reader version —
           * under the import's own recovery. Release first, then dispatch.
           */
          released = true;
          await releaseThenContinue(db, claim, String(upload.id));
          via = 'import_continuation';
        } else {
          /*
           * A SETTLED LIST, SO THE SWEEP'S OWN NEXT TICK, STARTED NOW. The
           * import's successor refuses anything that is not `parsing`, and
           * moving a settled list to `parsing` would make it look busy to its
           * builder — so the sweep continues its own read.
           */
          await claim?.release();
          released = true;
          await dispatchReaderSweep(db);
          via = 'reader_sweep';
        }
        outcome.handedOn.push({ uploadId: upload.id, via });
        console.info(`${TELEMETRY_PREFIX} reader sweep handed on`, {
          upload_id: upload.id,
          organisation_id: upload.organisation_id,
          reader_version: DETERMINISTIC_READER_VERSION,
          reason: result.reason,
          via,
          crossings: result.continuations,
          ticks: tick.ticks,
        });
        continue;
      }

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
         * EXCEPT A FIRST PASS, WHICH THIS TICK MOVED AND MUST THEREFORE PUT
         * DOWN.
         *
         * "Leave the upload exactly as it was" is a rule about a row somebody
         * else's import already settled. A claimed `uploaded` row was settled
         * by nobody — this tick moved it to `parsing` — so leaving it is not
         * leaving it as it was, it is abandoning it mid-flight with an error
         * nothing will ever clear. That is `closeRefusedUpload`'s whole
         * subject, and the same function the portal's own refusal path calls.
         */
        if (firstPass) {
          await closeRefusedUpload(db, {
            uploadId: String(upload.id),
            organisationId: String(upload.organisation_id),
            code: String(result.code),
            message: String((result as { message?: string }).message ?? ''),
          });
        }
        /*
         * A VERDICT IS FINISHED; A FAULT IS NOT. See `DOCUMENT_VERDICT_CODES`.
         * Re-asking the same bytes of the same reader cannot change a verdict,
         * so the source is stamped and stops being outstanding. A fault is
         * left exactly as it was, which is the paragraph above — save the
         * sweep's own record, which counts it towards the bound.
         */
        if (reReadSettlesAt(result.code)) {
          await supersedeOurFailure(db, upload, result);
          await stamp(db, upload, sweepTickEnded(plan.next, 'verdict', now()));
        } else {
          await recordAttempt(db, upload, sweepTickEnded(plan.next, 'fault', now()));
        }
        continue;
      }

      /*
       * THE STATUS IS WRITTEN ONLY WHERE A SUCCESSFUL READ CONTRADICTS IT: a
       * failure that was ours, or a first pass this sweep adopted — by this
       * tick or by an earlier tick of the same attempt, which is why it is
       * read off the attempt rather than off the row.
       */
      const writesStatus = statusBefore === 'failed' || firstPass;
      await writeImportOutcome(db, upload, result, writesStatus);
      await stamp(db, upload, sweepTickEnded(plan.next, 'read', now()));
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
        ticks: plan.next.ticks,
      });
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error).slice(0, 200);
      /*
       * AND HERE TOO, WHICH IS THE BRANCH THAT WOULD HAVE BEEN FORGOTTEN.
       *
       * A throw anywhere between the claim and the write leaves a row this
       * tick moved to `parsing` with no run behind it, and a `parsing` row
       * is re-readable — so the next tick claims nothing (it is no longer
       * `uploaded`), reads it as a re-read, and the status never becomes
       * terminal. Best-effort, inside its own guard: the fault being
       * reported must not be replaced by a fault reporting it.
       */
      if (firstPass) {
        try {
          await closeRefusedUpload(db, {
            uploadId: String(upload.id),
            organisationId: String(upload.organisation_id),
            code: 'processing_failed',
            message: 'That file could not be processed. Please check the format and try again.',
            detail: { phase: 'reader_sweep_first_pass', message },
          });
        } catch { /* reported below either way */ }
      }
      if (tick) {
        try { await recordAttempt(db, upload, sweepTickEnded(tick, 'fault', now())); } catch { /* counted as unfinished anyway */ }
      }
      outcome.failed.push({ uploadId: upload.id, reason: message });
      console.warn('[builderStock] reader sweep failed', {
        upload_id: upload.id, phase: 'reader_sweep', message,
      });
    } finally {
      // ALWAYS, and token-scoped, so a successor's claim can never be released
      // by this tick. Skipped where the hand-off already released it.
      if (!released) await claim?.release();
    }
  }

  return outcome;
}

/** The organisation's own name, for the messages an import composes. */
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
 * IT WRITES THE CURRENT READ'S ANSWER, ALWAYS — AND THE FIRST VERSION DID
 * NOT, WHICH COST A WHOLE DIAGNOSIS.
 *
 * That version replaced the reason only where the old one was OURS, on the
 * argument that an error already describing the FILE had reached the same
 * kind of answer and rewriting it would churn the row for nothing. MEASURED
 * ON THE VERY NEXT DEPLOY: `Lot 37` was re-read at reader version 4 by a
 * reader that no longer claims a bullet glyph as an estate — its own log
 * line shows the field set changing from four to three — and the row went on
 * displaying the evidence of the 16:56 read under version 3,
 * `development_name = ·`. The stamp said 4 and the diagnosis said 3, so the
 * one record an operator can consult described a reader that had been
 * replaced, and every conclusion drawn from it was about the wrong code.
 *
 * "Churn" was never the risk: the sweep reads a source once per reader
 * version and stamps it, so this writes once per version by construction.
 * The recorded reason is now whatever the CURRENT reader answers, which is
 * the only reading that can be acted on.
 *
 * The STATUS is still never touched here, for the reason the branch above
 * gives: rows this source already produced are live stock.
 */
async function supersedeOurFailure(
  db: any, upload: SweepUploadRow, result: any,
): Promise<void> {
  try {
    await db.from('builder_stock_uploads').update({
      error_code: String(result.code),
      error_message: String(result.message ?? ''),
      error_detail: result.detail ? { detail: String(result.detail) } : null,
    }).eq('id', upload.id).eq('organisation_id', upload.organisation_id);
  } catch { /* the read landed; the record of it is best-effort */ }
}

async function writeImportOutcome(
  db: any, upload: SweepUploadRow, result: any, writesStatus = false,
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
    /*
     * AN IMPORT THAT SUCCEEDED CLEARS THE REASON THE LAST ONE FAILED — AND
     * NOT ONLY WHERE THE STATUS SAID `failed`.
     *
     * MEASURED 21 SEPTEMBER 2026, on the read that finally worked.
     * `Lot 37 - Miami 190 - Property Package.pdf` came back
     * `records_detected: 1, records_imported: 1`, with the builder's own
     * photograph attached — and the row went on carrying
     * `error_code: no_properties_found` from the read before it, because the
     * status was `complete` rather than `failed` and only `failed` cleared an
     * error. A row that says it imported one property beside a code saying it
     * found none is a contradiction the builder is left to resolve, and it is
     * the same class as the stale reason this function was written to end,
     * reached from the other side.
     *
     * The STATUS is still only written where it said `failed`: that is the
     * one state a successful read plainly contradicts. A `complete` row is
     * left `complete` rather than being pushed back to `enriching`, because
     * the rows it already produced are live stock.
     */
    /*
     * AND A FIRST PASS, for the same reason and with more force.
     *
     * `failed` is written because a successful read plainly contradicts it.
     * A row this sweep CLAIMED is at `parsing` because this sweep put it
     * there, and `parsing` is not a state an import that has finished may be
     * left in — it means "still working", it is re-readable, and it is
     * precisely the shape that stranded sixteen rows in the acceptance
     * database. `result.uploadStatus` is the import's own answer, the same
     * field the portal's `finishImport` writes, so a swept first pass and a
     * builder's own import cannot end in different states.
     */
    const clearedFailure = writesStatus
      ? { status: result.uploadStatus, error_code: null, error_message: null }
      : { error_code: null, error_message: null };
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
