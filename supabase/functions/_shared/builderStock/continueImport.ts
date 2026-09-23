/**
 * Builder stock — THE SUCCESSOR INVOCATION OF AN IMPORT THAT RAN OUT OF CPU.
 *
 * ===========================================================================
 * WHAT THIS IS AND WHAT IT DELIBERATELY IS NOT.
 * ===========================================================================
 *
 * It is `process_upload` again, on the same bytes, with the checkpoint the
 * previous invocation left — SAME extractor, SAME deterministic reader, SAME
 * segmentation, SAME image ownership, SAME `finishImport`. It is not a second
 * import path and must never become one: two implementations of "read this
 * document" is how a customer's brochure comes to import one way through the
 * browser and another way through a continuation.
 *
 * So this module holds only what differs between the two callers, and the
 * list is short:
 *
 *   • THE ORGANISATION COMES FROM THE ROW. There is no session here — the
 *     caller is the database, through the signed internal dispatcher — so the
 *     server-held organisation every other operation uses does not exist. The
 *     upload row's own `organisation_id` is the only correct source, and it
 *     is not a weakening of the rule that a browser-supplied organisation is
 *     never trusted: no browser can reach this code.
 *
 *   • IT REFUSES ANYTHING THAT IS NOT MID-IMPORT. A row that is `failed`,
 *     `enriching`, published, deleted or superseded has nothing owed to it,
 *     and a continuation that ran on one would re-read a finished document
 *     and write its properties a second time.
 *
 *   • IT TAKES THE CLAIM. The dispatch is immediate and best-effort, and the
 *     recovery sweep reaches the same row, so a double dispatch is expected
 *     rather than exceptional. `builder_stock_claim_import` is what makes the
 *     second one do nothing at all.
 *
 * ===========================================================================
 * THE STATUS IS NEVER WRITTEN BY THIS PATH UNLESS THE IMPORT IS OVER.
 * ===========================================================================
 *
 * `markParsing` is not re-run: `processing_started_at` measures the whole
 * import, not one invocation of it, and refreshing it on every crossing would
 * push the abandonment window out by one crossing each time — a run that
 * could never be recovered because it kept saying it had only just started.
 * That is the shape of defect the investment-report watchdog already paid
 * for.
 */
import { runStockImport, isImportContinuation } from './runImport.ts';
import type { RunImportFailure, RunImportSuccess } from './runImport.ts';
import {
  claimImport, releaseThenContinue, type ImportClaim,
} from './importClaim.ts';
import { isAcceptableStockStoragePath } from './fileTypes.pure.ts';
import { tradingName } from './organisationName.ts';
import {
  importFailureColumns, importOutcomeColumns,
} from './recordImportOutcome.ts';

/** What one continuation did, for the dispatcher's log and nothing else. */
export interface ContinueImportOutcome {
  success: boolean;
  /** The one word that says what happened. Never a builder-facing sentence. */
  state:
    | 'continued'      // more work remains; another successor is on its way
    | 'completed'      // the document is read and the properties are written
    | 'failed'         // the document could not be read at all
    | 'not_found'
    | 'not_importing'  // the row is not mid-import; nothing is owed
    | 'held';          // somebody else is reading it right now
  upload_id?: string;
  detail?: string;
}

/**
 * Resume one import. Answers a word, never a document and never a customer's
 * data: the caller is a dispatcher and its log is not a place for either.
 */
export async function continueStockImport(
  supabase: any,
  uploadId: string,
  hooks: {
    /**
     * Told once, when THIS invocation is the one that finished the import,
     * with what it answered — after the row has been written.
     *
     * For the caller's audit trail: the browser's own finish writes
     * `builder_stock_upload_processed`, an import finished by a successor is
     * the same import, and a paginated brochure is now always finished by
     * one — so without this a builder's audit trail would lose the
     * processing record of nearly every PDF it holds. And for the acceptance
     * gate, which compares the reading a successor finished with the reading
     * an uninterrupted import produced. Never able to change the outcome: a
     * hook that throws is swallowed.
     */
    onFinished?: (finished: {
      upload: { id: string; organisation_id: string; uploaded_by_builder_user_id?: string | null };
      result: RunImportSuccess | RunImportFailure;
    }) => Promise<void>;
  } = {},
): Promise<ContinueImportOutcome> {
  if (!uploadId) return { success: false, state: 'not_found' };

  const { data: upload } = await supabase
    .from('builder_stock_uploads')
    .select('*')
    .eq('id', uploadId)
    .maybeSingle();
  if (!upload || upload.deleted_at) return { success: false, state: 'not_found', upload_id: uploadId };

  /*
   * ONLY A ROW THAT IS STILL BEING READ. `parsing` is the status the import
   * sets before it starts and clears when it finishes, so it is exactly the
   * window in which a continuation is owed anything.
   */
  if (String(upload.status) !== 'parsing') {
    return { success: true, state: 'not_importing', upload_id: uploadId };
  }
  if (!isAcceptableStockStoragePath(upload.storage_path)) {
    return { success: false, state: 'failed', upload_id: uploadId, detail: 'storage_path_not_allowed' };
  }

  /*
   * ONE RESOLUTION OF THE ORGANISATION'S NAME, shared with the reader sweep.
   * Two spellings of "what is this builder called" is how two invocations of
   * one import come to read the same brochure differently.
   */
  const organisationName = await tradingName(supabase, upload.organisation_id);

  const claimed = await claimImport(supabase, uploadId);
  // `held` is a normal answer: the predecessor is still alive, or the other
  // dispatch got here first. Doing nothing is the correct response to both.
  if (!claimed.ok && claimed.reason === 'held') {
    return { success: true, state: 'held', upload_id: uploadId };
  }
  const claim: ImportClaim | null = claimed.ok ? claimed.claim : null;
  let handedOff = false;

  try {
    const { data: blob, error: downloadError } = await supabase.storage
      .from(upload.storage_bucket).download(upload.storage_path);
    if (downloadError || !blob) {
      /*
       * THE SOURCE IS GONE MID-IMPORT. Recorded as a failure rather than left
       * `parsing` for the fifteen-minute sweep: the row cannot be finished by
       * anybody, and a status that says "still working" about work nobody can
       * do is the lie this whole programme is closing.
       */
      await supabase.from('builder_stock_uploads')
        .update(importFailureColumns('file_missing',
          'The uploaded file could not be read. Please upload it again.'))
        .eq('id', uploadId).eq('organisation_id', upload.organisation_id);
      return { success: false, state: 'failed', upload_id: uploadId, detail: 'file_missing' };
    }

    const result = await runStockImport({
      supabase,
      organisationId: upload.organisation_id,
      /*
       * READ, NOT INHERITED, AND THAT MATTERS TO THE READING.
       *
       * The deterministic PDF reader uses the uploading organisation's own
       * name as EVIDENCE — a builder's brochure carries the builder's name on
       * every page and it is never the estate or the design. The browser's
       * invocation takes it from the session; there is no session here, so it
       * is read from the organisation row.
       *
       * Leaving it null would be the worst available outcome: the successor
       * would read the same document differently from its predecessor, and
       * which reading a customer got would depend on where the CPU ran out.
       */
      organisationName: organisationName,
      builderUserId: upload.uploaded_by_builder_user_id ?? null,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes: new Uint8Array(await blob.arrayBuffer()),
      sourceKind: 'file',
      // WHAT THE PREDECESSOR PAID FOR, so this invocation does not pay again.
      storedCheckpoint: upload.import_checkpoint,
      ledger: upload.stage_timings ?? null,
      resumed: true,
      resumableFromStoredBytes: true,
    });

    if (isImportContinuation(result)) {
      // RELEASE FIRST, THEN DISPATCH — the ordering `releaseThenContinue`
      // exists to make unforgettable. A successor cannot claim a row its
      // predecessor still holds.
      handedOff = true;
      await releaseThenContinue(supabase, claim, uploadId);
      return { success: true, state: 'continued', upload_id: uploadId };
    }
    const told = async (finished: RunImportSuccess | RunImportFailure) => {
      try {
        await hooks.onFinished?.({
          upload: {
            id: upload.id,
            organisation_id: upload.organisation_id,
            uploaded_by_builder_user_id: upload.uploaded_by_builder_user_id ?? null,
          },
          result: finished,
        });
      } catch { /* an audit line that cannot be written is not an import failure */ }
    };
    if (!result.ok) {
      await supabase.from('builder_stock_uploads')
        .update(importFailureColumns(result.code, result.message, result.detail))
        .eq('id', uploadId).eq('organisation_id', upload.organisation_id);
      await told(result);
      return { success: false, state: 'failed', upload_id: uploadId, detail: result.code };
    }

    /*
     * THE SAME COLUMNS THE BROWSER'S OWN FINISH WRITES.
     *
     * `sourceNotice` is null because a continuation always resumes from
     * STORED BYTES, and stored bytes carry no hyperlinks that could have
     * failed to be read — so this is a fact about the source rather than this
     * caller declining to look. See `importOutcomeColumns`.
     */
    await supabase.from('builder_stock_uploads')
      .update(importOutcomeColumns(result, null))
      .eq('id', uploadId).eq('organisation_id', upload.organisation_id);
    await told(result);
    return { success: true, state: 'completed', upload_id: uploadId };
  } finally {
    // ALWAYS, and token-scoped, so a successor's claim can never be released
    // by this one. See `importClaim.ts`. Skipped where the hand-off has
    // already released and dispatched.
    if (!handedOff) await claim?.release();
  }
}
