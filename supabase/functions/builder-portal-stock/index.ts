/**
 * Builder / Developer Portal — Stock List
 *
 * The builder's half of the Stock List → Property Marketplace feature. Mirrors
 * `builder-portal-inventory` operation for operation: cookie session,
 * governance gate, server-held active organisation, deny-by-default permission
 * resolution, CSRF on every mutation.
 *
 * ORGANISATION SCOPE IS THE WHOLE SECURITY MODEL HERE. Stock belongs to an
 * organisation, not to a project, so there is no project grant to resolve
 * through — which makes it more important, not less, that the organisation is
 * never taken from the request. `activeOrganisationId` comes from the stored
 * session, every query filters on it, and every write re-reads the target row
 * with that filter applied before it changes anything. A stock item id in the
 * body is a lookup key, never authority.
 *
 * Operations
 *   create_upload | process_upload | reprocess_upload | enrich_images
 *   create_builder_image | attach_builder_image
 *   list_uploads | get_upload
 *   list_stock | get_stock_item | set_availability | set_manual_stats
 *   archive_stock_item
 *   confirm_brochure_image | undo_brochure_image
 *   image_url
 *   list_selections | acknowledge_selection
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import {
  stockDocumentNotes, unreadDocumentCount,
  stockPackageDocuments, MAX_STOCK_DOCUMENT_NOTES,
  brochureConfirmationViews, withConfirmationChoices,
} from '../_shared/builderStock/imageProgress.pure.ts';
import { confirmedLotOf } from '../_shared/builderStock/brochureConfirmation.pure.ts';
import {
  confirmBrochureImage, readListingsWithLots, readStandingConfirmations, undoBrochureImage,
  type StandingConfirmation,
} from '../_shared/builderStock/brochureConfirmation.ts';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../_shared/validate.ts';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
  builderCan,
  logBuilderProjectActivity,
} from '../_shared/builderPortalAuth.ts';
import {
  MAX_STOCK_FILE_BYTES, STOCK_LIST_BUCKET, STOCK_IMAGE_BUCKET,
  STOCK_LIST_STORAGE_PREFIX, STOCK_ALLOWED_DECLARED_MIME,
  classifyStockFile, isAcceptableStockStoragePath, safeObjectName,
} from '../_shared/builderStock/fileTypes.pure.ts';
import {
  isImportContinuation, runStockImport, type RunImportResult,
} from '../_shared/builderStock/runImport.ts';
import {
  claimImport, releaseThenContinue, type ImportClaim,
} from '../_shared/builderStock/importClaim.ts';
import { continueStockImport } from '../_shared/builderStock/continueImport.ts';
import { discardDocumentRead } from '../_shared/builderStock/documentRead.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import {
  SOURCE_LINKS_UNAVAILABLE, sourceAccessNoticeFor,
} from '../_shared/builderStock/sourceAccessNotice.pure.ts';
import {
  linkRecoveryWebhookConfigured, requestLinkRecovery,
} from '../_shared/builderStock/requestLinkRecovery.ts';
import {
  MANUAL_REFRESH_WINDOW_SECONDS, isRecoverableStoredAvailability, projectUploadListRow,
  shouldRequestLinkRecovery,
} from '../_shared/builderStock/linkRecovery.pure.ts';
import {
  parseIsAbandoned, settleUploadCompletion,
} from '../_shared/builderStock/uploadCompletion.ts';
import { googleSheetsRef } from '../_shared/builderStock/googleSheetsSource.pure.ts';
import { serveStockImage } from '../_shared/builderStock/serveStockImage.ts';
import { closeRefusedUpload } from '../_shared/builderStock/closeRefusedUpload.ts';
import {
  importFailureColumns, importOutcomeColumns,
} from '../_shared/builderStock/recordImportOutcome.ts';
import {
  isTraversableBranch, rowSourceBranches, unmappedWithRecoveredLinks,
} from '../_shared/builderStock/sourceBranches.pure.ts';
import {
  designOfStoredRow, isBuilderSuppliedPath, propertyImageStoragePath,
} from '../_shared/builderStock/builderSuppliedImage.pure.ts';
import {
  attachBuilderImage, builderImageReference,
} from '../_shared/builderStock/attachBuilderImage.ts';
import {
  roleFromBuilderProperty,
} from '../_shared/builderStock/sourceImageRole.pure.ts';
import { validateSourceImageBytes } from '../_shared/builderStock/sourceAssets.pure.ts';
import {
  PROCESSED_LIFECYCLE, SERVED_LIFECYCLE, type StockLifecycle,
} from '../_shared/builderStock/stockLifecycle.pure.ts';
import { sha256Hex } from '../_shared/builderStock/rasterPng.ts';
import { consumeRateLimit } from '../_shared/requestSecurity.ts';
import type { HyperlinkAvailability } from '../_shared/builderStock/sheetHyperlinks.pure.ts';
import {
  BUILDER_SYNC_STATE_SELECT,
  readSyncStateRow,
} from '../_shared/builderStock/distributionState.pure.ts';
import {
  linkDiscoveryFromAvailability,
} from '../_shared/builderStock/suppliedEvidence.pure.ts';
import {
  itemsToArchiveOnSourceDelete,
} from '../_shared/builderStock/sourceDeletion.pure.ts';
import {
  enrichStockItem, type EnrichableStockItem,
} from '../_shared/builderStock/images.ts';
import { repairSourceImagesForUpload } from '../_shared/builderStock/repairSourceImages.ts';
import { settleMarketplaceEligibility } from '../_shared/builderStock/settleMarketplaceEligibility.ts';
import { enforceStrictPrimaryImages } from '../_shared/builderStock/primaryImage.ts';
import {
  settleUploadSourceImages, uploadsNeedingSettlement,
} from '../_shared/builderStock/settleSourceImages.ts';
import { newRepairBudget } from '../_shared/builderStock/settleImageSanitization.ts';
import { readAllRows } from '../_shared/builderStock/pagedRead.ts';
import {
  BUILDER_ANNOUNCEMENT_SELECT, STOCK_AVAILABILITY_STATUSES, STOCK_IMAGE_SELECT,
  STOCK_ITEM_SELECT, STOCK_UPLOAD_SELECT, stockPagination,
} from '../_shared/builderStock/projection.pure.ts';
import {
  applyManualStatsToAll, parseManualStats, readManualStats,
} from '../_shared/builderStock/manualStats.pure.ts';
import {
  applyStatedLocation, parseStatedLocation, readStatedLocation,
} from '../_shared/builderStock/statedLocation.pure.ts';
import {
  prepareLinkedStockSource,
} from '../_shared/builderStock/linkedSource.ts';

/** Signed read URLs are short-lived — a leaked link outlives nothing. */
const IMAGE_URL_TTL_SECONDS = 300;

/**
 * Enrichment runs against a wall clock, not a queue. The edge ceiling is about
 * 150s and two network stages per property is a second or two each, so a batch
 * stops when the budget is spent and reports what is left; the page asks again.
 * That is the same shape the investment-report loop uses, and for the same
 * reason.
 */
const ENRICHMENT_BUDGET_MS = 90_000;
const ENRICHMENT_MAX_ITEMS = 25;
/**
 * Sources whose imagery one invocation may bring up to the current rules.
 *
 * A source is a document read and, for a package link, a folder listing plus a
 * brochure per property — so this is deliberately far smaller than the item
 * batch. The work is resumable and the browser's loop comes back, so a small
 * number costs another round trip and never a timeout.
 */
const SETTLEMENT_MAX_UPLOADS = 5;

function cleanText(value: unknown, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Bounded BEFORE the session is resolved below, so an unauthenticated
    // caller cannot make this isolate buffer a body of any size it likes.
    /*
     * AND THE RAW TEXT IS KEPT, because one caller needs it.
     *
     * `verifyInternal` hashes the EXACT bytes the signer hashed. Re-serialising
     * a parsed object is a different string — key order, spacing, number
     * formatting — so a re-stringify would fail every signature, always, in a
     * way that reads as a broken secret rather than as a bug here.
     *
     * Every other path is byte-identical to `readBoundedJson`: the same limit,
     * the same parse, and the same `{}` on a body that is too large or is not
     * JSON, so an oversized request still falls through to "unknown operation"
     * exactly as it did.
     */
    const bounded = await enforceRawBodyLimit(req, DEFAULT_MAX_BODY_BYTES)
      .catch(() => ({ ok: false } as { ok: false }));
    let body: Record<string, any> = {};
    if (bounded.ok && bounded.raw) {
      try { body = JSON.parse(bounded.raw) as Record<string, any>; } catch { body = {}; }
    }
    const rawBody = bounded.ok ? bounded.raw : '';
    const operation = String(body.operation || '');

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE SUCCESSOR INVOCATION OF AN IMPORT THAT RAN OUT OF CPU
     * ═══════════════════════════════════════════════════════════════════════
     *
     * BEFORE THE SESSION GATE, because there is no session: this is dispatched
     * by the database through `cron_invoke_signed_function`, the same signed
     * internal transport that fans out the image settler, and it is gated by
     * `verifyInternal` exactly as the settler is.
     *
     * IT LIVES HERE RATHER THAN IN A NEW FUNCTION. The whole point of the
     * hand-off is that the successor reads the document the same way the
     * first invocation did — same extractor, same reader, same segmentation,
     * same image ownership. A second edge function is a second implementation
     * of that, which is how two import paths come to behave differently. What
     * changes between the two callers is the authentication and the
     * organisation, and that is exactly what is written out below.
     *
     * NO SESSION MEANS NO SESSION-HELD ORGANISATION, so the organisation comes
     * from the upload ROW — which is the only correct source here and is not a
     * weakening: a browser-supplied organisation is refused as ever, because
     * no browser can reach this branch.
     */
    if (operation === 'continue_import') {
      const gate = await verifyInternal(supabase, req, rawBody);
      if (!gate.ok) {
        console.warn('[builder-portal-stock] continue_import denied', {
          phase: 'import_continuation', errorCode: (gate as { errorCode?: string }).errorCode,
        });
        return json({ error: 'Forbidden' }, 403);
      }
      const outcome = await continueStockImport(supabase, cleanText(body.upload_id, 64), {
        /*
         * THE SAME AUDIT RECORD THE BROWSER'S FINISH WRITES, for an import a
         * successor finished. There is no person on this request, so it is
         * written as the system on behalf of the builder who uploaded it —
         * and it says it was continued, because it was.
         */
        onFinished: async ({ upload: finished, result }) => {
          if (!result.ok) return;
          await logBuilderProjectActivity(supabase, req, {
            actorType: 'system',
            builderUserId: finished.uploaded_by_builder_user_id ?? null,
            organisationId: finished.organisation_id,
            action: 'builder_stock_upload_processed',
            entityType: 'stock_upload', entityId: finished.id,
            metadata: {
              detected: result.summary.detected, imported: result.summary.imported,
              updated: result.summary.updated, failed: result.summary.failed,
              strategy: result.strategy, continued: true,
            },
          });
        },
      });
      return json(outcome, outcome.success === false ? 409 : 200);
    }

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error || 'Unauthorised', code: session.code }, session.status || 401);
    }
    const me = session.user;
    const governanceError = builderGovernanceError(session);
    if (governanceError) return json({ error: 'Portal setup required', code: governanceError }, 403);

    // Server-held. A browser-supplied organisation_id is never consulted.
    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }
    const organisationName = session.active_organisation?.trading_name
      ?? session.active_organisation?.legal_name
      ?? null;

    /**
     * THE PAGE MUST NOT BE LYING ABOUT WHO IT IS.
     *
     * `activeOrganisationId` above is server-held and correct — that is not in
     * question and never was. The problem is that the BROWSER can be showing a
     * different organisation than the cookie names.
     *
     * `__Host-builder_session_token` is one cookie name per origin, so signing
     * into a second builder account destroys the first tab's token and
     * replaces it. That tab is told nothing: it keeps rendering the previous
     * organisation's name and stock while every request it sends now carries
     * the new account's credential. REPORTED AND CONFIRMED 12 SEPTEMBER 2026 —
     * a stock list uploaded from a page headed with one organisation was filed
     * under a different one. The audit log shows the first session last
     * used at 01:19:04, a second account logging in at 01:21:28 and the upload
     * at 01:22:32 attributed to that second account. Every server-side check passed, correctly, on the
     * credential it was given.
     *
     * So the client now sends the organisation IT believes it is acting as,
     * from its own per-tab state, and a mismatch is refused rather than filed
     * under whoever the cookie now names. It is advisory in one direction
     * only: absent, nothing changes; present and wrong, the write stops.
     * It can never WIDEN access — `activeOrganisationId` still decides what is
     * reachable, and this only ever refuses.
     */
    const expectedOrganisationId = cleanText(body.expected_organisation_id, 64);
    if (expectedOrganisationId && expectedOrganisationId !== activeOrganisationId) {
      return json({
        error: 'You are signed in as a different organisation than this page is showing. '
          + 'Reload the page and try again.',
        code: 'organisation_context_changed',
        active_organisation_id: activeOrganisationId,
      }, 409);
    }

    /**
     * Stock is inventory the organisation is offering, so it rides the
     * existing `inventory` permission key rather than inventing a parallel
     * one. Deny by default, resolved in the database.
     */
    const can = (level: 'view' | 'edit' | 'delete') =>
      builderCan(supabase, session, activeOrganisationId, 'inventory', level);

    if (!await can('view')) {
      return json({ error: 'You do not have access to stock', code: 'permission_denied' }, 403);
    }

    /**
     * AN ID THAT DOES NOT RESOLVE HERE IS USUALLY A PAGE THAT HAS MOVED ON.
     *
     * Every id below is resolved BY id AND active organisation, so a row
     * belonging to somebody else answers "not found" rather than "forbidden".
     * That stays exactly as it is: the reply must never disclose that the row
     * exists in another organisation.
     *
     * What changes is the WORDING, because a bare "not found" is a dead end
     * and on 12 SEPTEMBER 2026 it was the wrong one. Two delete attempts at
     * 06:20:12 and 06:20:17 were answered 404 while the operator watched the
     * stock list they were trying to remove sit on the screen. Both were
     * correct: the tab was still listing one organisation's uploads after the
     * single `__Host-` session cookie had been replaced by a second account's,
     * so the id was real and simply not theirs any more. They were told the
     * stock list did not exist. What was true is that it does not exist FOR
     * THE ORGANISATION THEY ARE NOW SIGNED IN AS.
     *
     * Naming that organisation discloses nothing — it is the caller's own
     * session, already drawn in their own chrome — and it turns a mystery
     * into the one instruction that resolves it.
     */
    const notFoundHere = (what: string, extra: Record<string, unknown> = {}) => json({
      ...extra,
      error: organisationName
        ? `${what} was not found in ${organisationName}. If the page was showing a `
          + 'different organisation, this browser has since signed in as another one — '
          + 'reload the page and try again.'
        : `${what} was not found in the organisation you are signed in as. Reload the `
          + 'page and try again.',
      code: 'not_found_in_active_organisation',
      active_organisation_id: activeOrganisationId,
    }, 404);

    /** Load one upload, scoped. A row outside the organisation is "not found". */
    const loadUpload = async (uploadId: string) => {
      if (!uploadId) return null;
      const { data } = await supabase
        .from('builder_stock_uploads')
        .select('*')
        .eq('id', uploadId)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      return data;
    };

    /** Load one stock item, scoped, the same way. */
    const loadItem = async (itemId: string) => {
      if (!itemId) return null;
      const { data } = await supabase
        .from('builder_stock_items')
        .select('*')
        .eq('id', itemId)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      return data;
    };

    /** Mark a source as being read. Shared by the file and URL paths. */
    const markParsing = async (uploadId: string) => {
      await supabase.from('builder_stock_uploads').update({
        status: 'parsing',
        processing_started_at: new Date().toISOString(),
        error_code: null, error_message: null, error_detail: null,
        /*
         * A PERSON STARTING THE IMPORT AGAIN IS A NEW ATTEMPT.
         *
         * The recovery sweep bounds itself at three restarts, so a document
         * that dies every time cannot loop the minute tick for ever. That
         * bound must not survive the builder trying again — otherwise a file
         * that failed three times last week can never be re-read, and the
         * only symptom would be an import that quietly never resumes.
         *
         * `processing_started_at` above is reset for the same reason and has
         * always been: this is one statement about one attempt.
         */
        import_recovery_attempts: 0,
      }).eq('id', uploadId).eq('organisation_id', activeOrganisationId);
    };

    /**
     * Record a failure on the source and answer the builder.
     *
     * `error_detail` is the internal diagnosis and is written to the row but
     * never returned — `get_upload` projects it away, and so does
     * `projectUploadListRow`.
     *
     * THE CEILING FOLLOWS THE PAYLOAD, AND WAS 2,000, THEN 6,000, THEN
     * 16,000. The diagnosis carries
     * the lines the deterministic reader could not account for, which is the
     * one fact that turns "this template failed" into a vocabulary fix — and
     * at 2,000 the JSON was truncated before reaching them, so the field
     * would have recorded a diagnosis with its own evidence cut off. It now
     * also carries the lines the reader PLACED and could not name, which is
     * where a field that a document states in words this reader has not
     * learned will be sitting.
     *
     * A CEILING ON A BOUNDED PAYLOAD, never a licence to copy a document
     * into a column: the reader bounds what it reports at the source (12
     * unaccounted lines and 80 ignored ones, 120 characters each), and this
     * sits above the largest payload those bounds can produce so that a
     * diagnosis is never stored with its own evidence cut off mid-string.
     */
    const failUpload = async (
      uploadId: string, code: string, message: string, detail?: unknown,
    ) => {
      await supabase.from('builder_stock_uploads')
        .update(importFailureColumns(code, message, detail))
        .eq('id', uploadId).eq('organisation_id', activeOrganisationId);
      return json({ success: false, error: message, code }, 400);
    };

    /**
     * Write the outcome of `runStockImport` to the source row and answer.
     *
     * One place, so a file import and a URL import cannot report their results
     * differently.
     */
    const finishImport = async (
      uploadId: string,
      result: RunImportResult,
      extraMetadata: Record<string, unknown>,
      /**
       * How much of a spreadsheet source we could actually read.
       *
       * Absent for a file upload and for every other kind of source. Present
       * and not `resolved` means the rows came through and the link targets
       * did not — a successful import with a source-access notice, never a
       * failure. See `sourceAccessNotice.pure.ts`.
       */
      sourceHyperlinks?: HyperlinkAvailability,
      /** The URL the rows came from, for a Google Sheets recovery ask. */
      sourceUrlForRecovery?: string | null,
      /**
       * The import claim this caller holds, where it holds one.
       *
       * Passed so the HAND-OFF is paired here rather than at four call sites:
       * the release must happen before the dispatch, and `finishImport` is the
       * one place every import path ends. A caller holding no claim passes
       * nothing and only the dispatch happens.
       */
      claim?: ImportClaim | null,
    ) => {
      if (!result.ok) {
        if (result.code === 'duplicate_file') {
          // The one implementation of "a refusal closes the row", shared with
          // the acceptance gate so the two cannot drift. See
          // `closeRefusedUpload.ts`.
          await closeRefusedUpload(supabase, {
            uploadId, organisationId: activeOrganisationId,
            code: result.code, message: result.message,
          });
          return json({
            success: false, error: result.message, code: result.code,
            duplicate_upload_id: result.duplicateUploadId,
          }, result.status);
        }
        return await failUpload(uploadId, result.code, result.message, result.detail);
      }

      /*
       * ═══════════════════════════════════════════════════════════════════
       * THE IMPORT IS NOT OVER; IT MOVED
       * ═══════════════════════════════════════════════════════════════════
       *
       * This invocation spent its CPU allowance on the one stage that has
       * nowhere else to go — recognising a scanned page — and handed the rest
       * to a successor it has already dispatched. Nothing is written here:
       * the row stays `parsing`, no count is recorded and
       * `processing_completed_at` stays null, because a document that has not
       * been read has nothing true to say about how many properties it holds.
       *
       * WRITING A SUCCESS HERE WOULD BE THE 22 SEPTEMBER LIE EXACTLY:
       * `records_detected: 0` on an upload whose properties arrive a few
       * seconds later. Writing a failure would be worse — it would send a
       * builder to re-upload a list that is mid-import.
       *
       * The browser is told to keep watching. It already knows how: the page
       * polls `get_upload` for a `parsing` row, and closing the tab changes
       * nothing, because the work is the dispatcher's now and not this
       * request's.
       */
      if (isImportContinuation(result)) {
        // RELEASE, THEN DISPATCH — in that order, once, for every path that
        // ends here. See `releaseThenContinue`.
        await releaseThenContinue(supabase, claim ?? null, uploadId);
        return json({
          success: true,
          still_importing: true,
          code: 'import_continuing',
          // Not "large": a brochure's pictures are always attached by a
          // second invocation now (`importHandover.pure.ts`), whatever its size.
          message: 'This document is read in stages, and it is still being read '
            + '— you can close this page.',
          outstanding: result.outstanding,
          continuations: result.continuations,
        });
      }

      /*
       * A SOURCE THAT GAVE US ITS ROWS AND NOT ITS LINKS IS A SUCCESSFUL
       * IMPORT WITH SOMETHING TO SAY.
       *
       * `status` is untouched — the rows are in, and marking the upload failed
       * would send a builder to re-upload a list that already imported. What
       * it gets is a recorded, machine-readable condition the portal shows as
       * a source-access error beside the successful row counts, and which no
       * amount of waiting will change: unavailable is terminal.
       *
       * A row-level failure still wins the message, because rows that could
       * not be saved are the more serious of the two.
       */
      /**
     * Ask for this sheet's link addresses, where all four conditions hold.
     *
     * Every refusal is silent and operational: this is an auxiliary recovery,
     * so a builder whose sheet is not a Google Sheet, or whose links were read
     * cleanly, sees no difference from one whose recovery ran.
     */
    const maybeRequestLinkRecovery = async (
      recoveryUploadId: string,
      sourceUrl: string | null | undefined,
      availability: HyperlinkAvailability | null | undefined,
    ): Promise<void> => {
      try {
        const ref = googleSheetsRef(sourceUrl ?? null);
        if (!shouldRequestLinkRecovery({
          importSucceeded: true,
          availability,
          spreadsheetId: ref?.spreadsheetId ?? null,
          webhookConfigured: linkRecoveryWebhookConfigured(),
        })) return;

        await requestLinkRecovery(supabase, {
          organisationId: activeOrganisationId,
          uploadId: recoveryUploadId,
          spreadsheetId: ref!.spreadsheetId,
          gid: ref!.gid,
          origin: 'import',
        });
      } catch (error) {
        // NEVER FATAL. The import is already complete and recorded.
        console.warn('[builder-portal-stock] link recovery could not be requested', {
          phase: 'link_recovery_dispatch', upload_id: recoveryUploadId,
          detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
        });
      }
    };

    const sourceNotice = sourceAccessNoticeFor(sourceHyperlinks);
      /*
       * WHAT THE DOCUMENT SAID THAT BECAME NO FIELD, ON A SUCCESSFUL IMPORT.
       *
       * The failure path has carried its diagnosis for a while; the success
       * path is where it was needed and was not there. A brochure that
       * imports with an address, a suburb, a state, an estate and a design
       * all empty is not a failure anything reports — the upload reads
       * `enriching`, the card draws what there is, and the only record of the
       * other three hundred lines was a count. Closing that gap has meant
       * guessing, or asking a builder for a file.
       *
       * ADDITIVE AND SUBORDINATE. It is merged into whatever `error_detail`
       * already carries rather than replacing it, so `sourceNotice`'s
       * `reason` — which the link-recovery path reads back — is untouched,
       * and it never invents an `error_code` or an `error_message`: an
       * import that succeeded still reads as one.
       */
      /*
       * THE WHOLE OUTCOME IS NOW COMPOSED IN ONE PLACE, not just the counts.
       *
       * This statement used to spell the status, the two error columns and
       * the diagnosis inline, under a comment saying that only the COUNTS are
       * alike across callers. That was true while the other callers were the
       * reader sweep and the acceptance gate. It stopped being true the
       * moment an import could be finished by a CONTINUATION: the browser's
       * invocation and the dispatcher's are the same import split across
       * isolates, so a status that differed between them would make what an
       * import means depend on how big the document was.
       *
       * What stays here is what is genuinely this caller's: the organisation
       * filter and the `select` its HTTP response needs.
       */
      const { data: updated } = await supabase.from('builder_stock_uploads')
        .update(importOutcomeColumns(result, sourceNotice))
        .eq('id', uploadId).eq('organisation_id', activeOrganisationId)
        .select(STOCK_UPLOAD_SELECT).single();

      /*
       * A SHEET THAT GAVE US ITS ROWS AND NOT ITS LINK ADDRESSES MAY BE
       * READABLE BY SOMEBODY ELSE.
       *
       * `unavailable_source_export` means the workbook itself never arrived —
       * the one reading a different, authorised reader can change. Every other
       * reading either has the links already or had the file and could not use
       * it, and asking again would spend a metered operation to learn nothing.
       *
       * AFTER the upload row is written and BEFORE nothing: the import is
       * already complete and its result is already recorded, so this cannot
       * delay, alter or fail it. `requestLinkRecovery` never throws.
       */
      await maybeRequestLinkRecovery(uploadId, sourceUrlForRecovery, sourceHyperlinks);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_upload_processed',
        entityType: 'stock_upload', entityId: uploadId,
        metadata: {
          detected: result.summary.detected, imported: result.summary.imported,
          updated: result.summary.updated, failed: result.summary.failed,
          strategy: result.strategy, ...extraMetadata,
        },
      });

      return json({
        success: true,
        upload: updated,
        summary: result.summary,
        // The page enriches next. Images never block the import.
        enrichment_pending: result.enrichmentPending,
      });
    };

    // =====================================================================
    // Upload
    // =====================================================================

    if (operation === 'create_upload') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to upload stock', code: 'permission_denied' }, 403);
      }

      const filename = cleanText(body.filename, 240);
      if (!filename) return json({ error: 'A file name is required' }, 400);

      const declared = cleanText(body.content_type, 200).toLowerCase().split(';')[0].trim();
      if (!STOCK_ALLOWED_DECLARED_MIME.has(declared)) {
        return json({ error: 'That file type cannot be uploaded.', code: 'unsupported_file_type' }, 400);
      }

      const byteSize = Number(body.byte_size);
      if (!Number.isFinite(byteSize) || byteSize < 1) {
        return json({ error: 'That file is empty.', code: 'empty_file' }, 400);
      }
      if (byteSize > MAX_STOCK_FILE_BYTES) {
        return json({
          error: `That file is larger than ${Math.round(MAX_STOCK_FILE_BYTES / (1024 * 1024))} MB.`,
          code: 'file_too_large',
        }, 400);
      }

      // The extension is checked here so an obviously unreadable file is
      // refused before it is stored. The BYTES are checked again at
      // processing time, which is the check that counts.
      const preflight = classifyStockFile(filename, null, 'unknown_content_signature');
      if (preflight.kind === 'unsupported') {
        return json({ error: preflight.reason, code: 'unsupported_file_type' }, 400);
      }

      const uploadId = crypto.randomUUID();
      const storagePath = `${STOCK_LIST_STORAGE_PREFIX}${activeOrganisationId}/${uploadId}/${safeObjectName(filename)}`;

      const { data: upload, error: insertError } = await supabase
        .from('builder_stock_uploads')
        .insert({
          id: uploadId,
          organisation_id: activeOrganisationId,
          uploaded_by_builder_user_id: me.id,
          original_filename: filename,
          declared_content_type: declared || null,
          byte_size: Math.round(byteSize),
          storage_bucket: STOCK_LIST_BUCKET,
          storage_path: storagePath,
          status: 'uploaded',
        })
        .select(STOCK_UPLOAD_SELECT)
        .single();
      if (insertError) {
        console.error('[builder-portal-stock] upload insert failed', insertError.message);
        return json({ error: 'The upload could not be started.' }, 500);
      }

      const { data: signed, error: signError } = await supabase.storage
        .from(STOCK_LIST_BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed?.signedUrl) {
        // Same bucket as the URL snapshot, and it was equally silent when that
        // bucket was missing — a file upload failed with nothing in the logs at
        // all. Named here for the same reason.
        console.error('[builder-portal-stock] signed upload url failed', {
          bucket: STOCK_LIST_BUCKET,
          storage_path: storagePath,
          status: (signError as { statusCode?: string | number } | null)?.statusCode ?? null,
          message: signError?.message ?? 'no signed url returned',
        });
        await supabase.from('builder_stock_uploads')
          .update({ status: 'failed', error_code: 'storage_unavailable', error_message: 'Storage could not accept the file.' })
          .eq('id', uploadId)
          // Scoped like every other write here. `uploadId` is this handler's
          // own and cannot be another organisation's — but a write that
          // identifies a row by id ALONE is one refactor away from being a
          // cross-tenant write, and this file's rule is that there is no such
          // write. `builderStockTenantIsolation.test.ts` enforces it.
          .eq('organisation_id', activeOrganisationId);
        return json({ error: 'Storage could not accept the file.' }, 502);
      }

      const raw = signed.signedUrl;
      const absolute = raw.startsWith('http')
        ? raw
        : `${Deno.env.get('SUPABASE_URL')}/storage/v1${raw.startsWith('/') ? '' : '/'}${raw}`;

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_upload_started',
        entityType: 'stock_upload', entityId: uploadId,
        metadata: { filename, declared_content_type: declared },
      });

      return json({ success: true, upload, signed_url: absolute, token: signed.token });
    }

    if (operation === 'process_upload') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to upload stock', code: 'permission_denied' }, 403);
      }

      const upload = await loadUpload(cleanText(body.upload_id, 64));
      if (!upload) return notFoundHere('That stock list');
      if (upload.deleted_at) return notFoundHere('That stock list');
      if (!isAcceptableStockStoragePath(upload.storage_path)) {
        return json({ error: 'That file location is not allowed' }, 400);
      }
      // A second click while the first run is in flight must not import the
      // file twice.
      if (!['uploaded', 'failed'].includes(String(upload.status))) {
        return json({
          error: 'This file has already been processed.',
          code: 'already_processed',
          upload,
        }, 409);
      }

      /*
       * ONE WORKER PER IMPORT, AND THE CLAIM IS TAKEN BEFORE THE ROW MOVES.
       *
       * The status check above stops a SECOND CLICK, and it always did. What
       * it cannot stop is a continuation already reading this document in
       * another isolate: the row is `parsing` in that case, which this branch
       * refuses anyway — but the reverse race is real, and so is a builder
       * hitting a `failed` row that the recovery sweep has just picked up.
       * `builder_stock_claim_import` is one conditional UPDATE and settles
       * every one of them. See `importClaim.ts`.
       *
       * `held` is refused; `unavailable` — a deployment whose migration has
       * not arrived — proceeds exactly as every import did before this.
       */
      const claimed = await claimImport(supabase, upload.id);
      if (!claimed.ok && claimed.reason === 'held') {
        return json({
          error: 'This file is already being read. It will finish on its own.',
          code: 'import_in_progress',
        }, 409);
      }
      const claim = claimed.ok ? claimed.claim : null;
      /*
       * THE HAND-OFF RELEASES AND DISPATCHES; THE `finally` ONLY RELEASES.
       *
       * `releaseThenContinue` does both, in that order, and sets this so the
       * `finally` below does not release a second time — which would be
       * harmless (the release is idempotent and token-scoped) but would read
       * as two people handing back one lease.
       */
      let handedOff = false;

      await markParsing(upload.id);

      try {
        const { data: blob, error: downloadError } = await supabase.storage
          .from(upload.storage_bucket).download(upload.storage_path);
        if (downloadError || !blob) {
          return await failUpload(upload.id, 'file_missing',
            'The uploaded file could not be read. Please upload it again.', downloadError?.message);
        }

        const result = await runStockImport({
          supabase,
          organisationId: activeOrganisationId,
          organisationName,
          builderUserId: me.id,
          upload: { id: upload.id, original_filename: upload.original_filename },
          bytes: new Uint8Array(await blob.arrayBuffer()),
          sourceKind: 'file',
          /*
           * WHAT A PREVIOUS ATTEMPT AT THESE BYTES ALREADY RECOGNISED.
           *
           * Discarded unless its digest matches the document in hand, so a
           * re-upload of a DIFFERENT file under the same row inherits
           * nothing. `resumed` is absent, so the crossing counter starts
           * again: this is a fresh attempt, not a successor.
           */
          storedCheckpoint: upload.import_checkpoint,
          // A stored file IS its own bytes, so a successor reading them again
          // reproduces this run exactly. See `resumableFromStoredBytes`.
          resumableFromStoredBytes: true,
        });
        // The hand-off's release-then-dispatch is `finishImport`'s, so it is
        // written once for every import path rather than four times.
        handedOff = isImportContinuation(result);
        return await finishImport(upload.id, result, {}, undefined, undefined, claim);
      } catch (error) {
        console.error('[builder-portal-stock] processing failed', error);
        return await failUpload(upload.id, 'processing_failed',
          'That file could not be processed. Please check the format and try again.',
          (error as { message?: string })?.message);
      } finally {
        /*
         * HANDED BACK ON EVERY PATH, INCLUDING THE HAND-OFF.
         *
         * A continuation has already been dispatched by the time the hand-off
         * returns, and it cannot claim a row this invocation still holds — so
         * releasing here is what lets the successor start NOW rather than in
         * ninety seconds. The release is token-scoped, so doing it while a
         * successor somehow already holds the row is a no-op rather than a
         * theft. See `importClaim.ts`.
         */
        if (!handedOff) await claim?.release();
      }
    }

    /*
     * =====================================================================
     * The picture a builder hands over directly
     * =====================================================================
     *
     * Every image this product serves is READ out of something — a column
     * naming a URL, a brochure page naming a lot, a page cover. That works
     * until there is nothing to read, and on the one live source thirteen of
     * twenty-six published properties attach no document at all. The
     * pipeline's fallbacks then offered a Simonds display home, an ABC Homes
     * display home and the land developer's estate marketing for those rows,
     * and refused all three, correctly. The cards were blank because there was
     * nothing to read, and no reader fixes that.
     *
     * So the builder can hand the picture over. Two routes, one act: a render
     * FOR A DESIGN, which serves every row of theirs stating it — three
     * uploads cover those thirteen properties and every future one — or a
     * picture FOR ONE PROPERTY, which is the exception and the guarantee.
     *
     * Uploaded exactly as a stock list is: a signed URL, the browser PUTs to
     * it, and a second call confirms. The bytes are validated SERVER-SIDE on
     * that second call, out of storage, so what is registered is what was
     * actually stored rather than what the browser said it sent.
     */
    if (operation === 'create_builder_image') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to add images', code: 'permission_denied' }, 403);
      }

      const filename = cleanText(body.filename, 200) || 'image';
      const stockItemId = cleanText(body.stock_item_id, 64);
      if (!stockItemId) {
        return json({ error: 'Say which property this picture is for.' }, 400);
      }

      const item = await loadItem(stockItemId);
      if (!item) return notFoundHere('That property');
      const storagePath = propertyImageStoragePath({
        organisationId: activeOrganisationId,
        stockItemId,
        filename: safeObjectName(filename),
      });
      const { data: signed, error: signError } = await supabase.storage
        .from(STOCK_IMAGE_BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed?.signedUrl) {
        console.error('[builder-portal-stock] builder image signed url failed', {
          bucket: STOCK_IMAGE_BUCKET,
          storage_path: storagePath,
          message: signError?.message ?? 'no signed url returned',
        });
        return json({ error: 'Storage could not accept the image.' }, 502);
      }
      const raw = signed.signedUrl;
      return json({
        success: true,
        storage_path: storagePath,
        upload_url: raw.startsWith('http')
          ? raw
          : `${Deno.env.get('SUPABASE_URL')}/storage/v1${raw.startsWith('/') ? '' : '/'}${raw}`,
        token: signed.token,
      });
    }

    if (operation === 'attach_builder_image') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to add images', code: 'permission_denied' }, 403);
      }

      const storagePath = cleanText(body.storage_path, 400);
      /*
       * The path arrives in the body and is therefore a LOOKUP KEY, never
       * authority — the same rule every other write in this function keeps.
       * It must be one this product wrote, under this organisation's own
       * prefix, or a caller could register somebody else's object.
       */
      if (!isBuilderSuppliedPath(storagePath) || !storagePath.includes(`/${activeOrganisationId}/`)) {
        return json({ error: 'That image location is not allowed' }, 400);
      }

      const { data: blob, error: downloadError } = await supabase.storage
        .from(STOCK_IMAGE_BUCKET).download(storagePath);
      if (downloadError || !blob) {
        return json({ error: 'That image was not uploaded. Please try again.' }, 400);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      /*
       * VALIDATED OUT OF STORAGE, not off the request. What is registered is
       * what was actually stored, so a browser cannot declare a PNG and put a
       * PDF there — and the size, format and minimum-dimension rules are the
       * ones every other source image already passes.
       */
      const checked = validateSourceImageBytes(bytes);
      if (checked.ok !== true) {
        await supabase.storage.from(STOCK_IMAGE_BUCKET).remove([storagePath]);
        return json({ error: checked.reason }, 400);
      }
      const sha256 = await sha256Hex(bytes);

      const stockItemId = cleanText(body.stock_item_id, 64);
      const suppliedBy = 'builder' as const;

      /*
       * ONE PROPERTY, ALWAYS. A builder-supplied picture names the property it
       * is of, and nothing here fans one picture across several — see the
       * module header for why that capability was withdrawn.
       */
      if (!stockItemId) {
        return json({ error: 'Say which property this picture is for.' }, 400);
      }
      {
        const item = await loadItem(stockItemId);
        if (!item) return notFoundHere('That property');
        const attached = await attachBuilderImage(supabase, {
          organisationId: activeOrganisationId,
          stockItemId,
          uploadId: item.upload_id ?? null,
          storageBucket: STOCK_IMAGE_BUCKET,
          storagePath,
          contentType: checked.contentType,
          byteSize: bytes.length,
          sha256,
          role: roleFromBuilderProperty({
            suppliedBy,
            property: stockPropertyLabel(item),
          }),
        });
        if ('error' in attached) return json({ error: 'The image could not be stored.' }, 500);
        /*
         * `attachBuilderImage` requeues the property itself — see its header.
         * THE KICK IS WHAT MAKES SOMETHING RUN. The requeue puts the property
         * back in the queue; it does not start a worker, and it does not keep
         * the every-minute job alive. That job UNSCHEDULES ITSELF when
         * nothing is outstanding, and since a first stock list can publish
         * part of itself, "nothing outstanding" is now reachable while a
         * builder still has properties to fix — so the picture would sit in
         * the table with nothing looking at it. This is also simply the right
         * shape: the act a builder performs should start the work, not wait
         * up to a minute for a tick.
         *
         * Never fatal. The picture IS stored and requeued, so answering with
         * an error over a failed kick would report a loss that did not happen.
         */
        const { error: kickError } = await supabase
          .rpc('builder_stock_kick_image_work', { p_upload_id: null });
        if (kickError) {
          console.warn('[builder-stock] supplied image stored but the queue was not kicked',
            { stock_item_id: stockItemId, message: kickError.message });
        }
        await logBuilderProjectActivity(supabase, req, {
          builderUserId: me.id, organisationId: activeOrganisationId,
          action: 'builder_stock_image_supplied',
          entityType: 'stock_item', entityId: stockItemId,
          metadata: { storage_path: storagePath, scope: 'property' },
        });
        return json({ success: true, scope: 'property', properties: 1 });
      }
    }

    /*
     * =====================================================================
     * Re-read a source this organisation already imported
     * =====================================================================
     *
     * THE READERS IMPROVE, AND WHAT THEY LEARN HAS TO REACH ROWS THAT ALREADY
     * EXIST. A stock list is read once at upload and never again, so every
     * correction to the parsers — a column mapping, a link target, a page
     * rule — applied only to the NEXT builder's file. The rows already
     * published kept whatever the reader believed on the day.
     *
     * Measured on the one live source: its brochure links were discarded
     * because an uploaded workbook was read for its values alone, and its
     * `LAND $` column was written into `land_size_sqm`, so twenty-six
     * published properties carried a 428,000 m2 block, no price and no
     * document. Both are fixed in the readers; neither reaches those rows
     * without re-reading the file.
     *
     * AND RE-UPLOADING IS NOT THE ANSWER. A unique index on
     * `(organisation_id, file_sha256)` refuses the same bytes twice — rightly,
     * because a builder who uploads their list again is usually doing it by
     * accident — so the only route was to DELETE the source and upload it
     * again, which discards the audit trail and every selection made against
     * those properties.
     *
     * It is the SAME `runStockImport` the first pass ran, on the SAME bytes
     * out of the same private bucket. Nothing here re-implements an import:
     * the rows are matched by the identity rule the import already uses and
     * updated in place, so a property keeps its id, its history and anything a
     * client has done with it.
     *
     * The one precondition is that a run is not already in flight. Every other
     * status may be re-read, which is the difference from `process_upload` —
     * that operation's guard exists to stop a double-click importing a file
     * twice, and this operation's whole purpose is to import it again.
     */
    if (operation === 'reprocess_upload') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to upload stock', code: 'permission_denied' }, 403);
      }

      const upload = await loadUpload(cleanText(body.upload_id, 64));
      if (!upload) return notFoundHere('That stock list');
      if (upload.deleted_at) return notFoundHere('That stock list');
      if (!isAcceptableStockStoragePath(upload.storage_path)) {
        return json({ error: 'That file location is not allowed' }, 400);
      }
      /*
       * A LIVE READ IS REFUSED; AN ABANDONED ONE IS THE WHOLE POINT OF THIS
       * OPERATION. A request killed on its resource limit leaves the row at
       * `parsing` for ever, and both doors then refuse it — `process_upload`
       * with "already processed" and this one with "being read right now",
       * neither of which is true. See `parseIsAbandoned`.
       */
      if (String(upload.status) === 'parsing' && !parseIsAbandoned(upload)) {
        return json({
          error: 'This source is being read right now. Try again when it finishes.',
          code: 'already_processing',
          upload,
        }, 409);
      }
      // Nothing has been read yet, so this is an ordinary first pass and the
      // builder should be sent to the operation that performs one — which
      // reports its own progress and its own duplicate refusal.
      if (['uploaded', 'failed'].includes(String(upload.status))) {
        return json({
          error: 'This source has not been read yet. Process it instead.',
          code: 'not_yet_processed',
          upload,
        }, 409);
      }

      /*
       * =====================================================================
       * A LINKED SOURCE IS FETCHED AGAIN. A FILE IS RE-READ.
       * =====================================================================
       *
       * These are different acts and running one of them for both is the
       * defect this branch was extended to close. A builder who UPLOADED a
       * file owns those bytes: the file has not changed and re-reading it is
       * how a parser correction reaches rows that already exist. A builder
       * who LINKED a sheet linked it precisely BECAUSE they keep editing it —
       * so re-reading the snapshot taken on the day reports "47 updated" over
       * an import that changed nothing, and the only route that DID import
       * their edit was to delete the source and add it back.
       *
       * Deleting archives every property the source supplies. Measured on
       * Mairandi Developers 18–19 September 2026: three deletes stamped
       * `archived: 47`, two of them followed within 25 seconds by the same
       * docs.google.com address being added again, and the third leaving 47
       * live properties archived and the marketplace empty. That is not a
       * builder removing stock; it is a builder re-importing through the only
       * door that worked.
       *
       * Re-fetching keeps every row's id, so nothing is archived, no
       * selection is lost, and the marketplace is never empty for a moment.
       *
       * The fetch is the SAME `prepareLinkedStockSource` the first import
       * ran, so a re-fetch cannot be more permissive than the import that
       * accepted the source — which matters, because the rows it writes
       * replace ones that are live.
       */
      const isLinkedSource = String(upload.source_type) === 'url'
        && typeof upload.source_url === 'string' && upload.source_url.length > 0;

      if (isLinkedSource) {
        /*
         * PREPARED BEFORE ANYTHING IS TOUCHED. A sheet that has been unshared,
         * moved or made private must leave the source exactly as it was — with
         * its rows still live — and say so. Marking it `parsing` first would
         * park a healthy list in "being read" on a fetch that never returned
         * anything to read, and falling back to the stored snapshot would
         * launder "we could not reach your sheet" into a second import of
         * yesterday's copy under the word "updated".
         */
        const refetched = await prepareLinkedStockSource(upload.source_url);
        if (!refetched.ok) {
          return json({
            error: refetched.error, code: refetched.code, upload,
          }, refetched.status);
        }

        await markParsing(upload.id);
        try {
          /*
           * The snapshot is REPLACED rather than added beside. The stored
           * object's contract is "the bytes this source was last imported
           * from", and after a re-fetch that is these bytes — a stale copy
           * kept under the row would make the next re-read import the page
           * as it was two edits ago. What the previous import did is in the
           * activity log and in the rows themselves.
           */
          const storagePath =
            `${STOCK_LIST_STORAGE_PREFIX}${activeOrganisationId}/${upload.id}/${refetched.objectName}`;
          const { error: snapshotError } = await supabase.storage
            .from(STOCK_LIST_BUCKET)
            .upload(storagePath, refetched.importBytes, {
              contentType: refetched.snapshotContentType,
              upsert: true,
            });
          if (snapshotError) {
            console.error('[builder-portal-stock] re-fetch snapshot failed', {
              bucket: STOCK_LIST_BUCKET,
              storage_path: storagePath,
              status: (snapshotError as { statusCode?: string | number }).statusCode ?? null,
              message: snapshotError.message,
              source_host: refetched.host,
            });
            return await failUpload(upload.id, 'snapshot_failed',
              'That page could not be saved for import.', snapshotError.message);
          }

          // What the source IS, now — read from this fetch and never carried
          // over. A sheet that has been renamed, redirected or served as a
          // different type describes itself here.
          await supabase.from('builder_stock_uploads').update({
            final_url: refetched.finalUrl,
            source_title: refetched.displayName,
            original_filename: refetched.objectName,
            declared_content_type: refetched.declaredContentType,
            byte_size: refetched.importBytes.length,
            storage_bucket: STOCK_LIST_BUCKET,
            storage_path: storagePath,
            retrieved_at: new Date().toISOString(),
          }).eq('id', upload.id).eq('organisation_id', activeOrganisationId);

          await logBuilderProjectActivity(supabase, req, {
            builderUserId: me.id, organisationId: activeOrganisationId,
            action: 'builder_stock_source_refetched',
            entityType: 'stock_upload', entityId: upload.id,
            metadata: { host: refetched.host, notion: refetched.isNotion },
          });

          const result = await runStockImport({
            supabase,
            organisationId: activeOrganisationId,
            organisationName,
            builderUserId: me.id,
            upload: { id: upload.id, original_filename: refetched.displayName },
            bytes: refetched.importBytes,
            classification: refetched.classification,
            sourceKind: 'url',
            // Read from THIS fetch, like everything else on this path — a
            // server that has started stating a `Content-Disposition`, or a
            // link that now redirects to a named file, describes itself here.
            documentName: refetched.documentName,
            isNotionSource: refetched.isNotion,
            baseUrl: refetched.finalUrl,
            rowAssets: refetched.rowAssets,
            /*
             * READ FROM THIS FETCH, never from the row's stored notice. The
             * stored one describes what the ORIGINAL fetch could see, and a
             * sheet whose export permissions have since been fixed would
             * otherwise keep being stamped "we could not see the links" for
             * ever.
             */
            linkDiscovery: linkDiscoveryFromAvailability(
              refetched.hyperlinks, refetched.hyperlinkMethod),
            sheetTab: refetched.sheetTab,
          });
          return await finishImport(upload.id, result, {
            reprocessed: true, refetched: true, strategy_source: 'url',
          }, refetched.hyperlinks, refetched.url);
        } catch (error) {
          console.error('[builder-portal-stock] re-fetch failed', error);
          return await failUpload(upload.id, 'processing_failed',
            'That source could not be read again. Please check the link and try again.',
            (error as { message?: string })?.message);
        }
      }

      await markParsing(upload.id);

      try {
        const { data: blob, error: downloadError } = await supabase.storage
          .from(upload.storage_bucket).download(upload.storage_path);
        if (downloadError || !blob) {
          return await failUpload(upload.id, 'file_missing',
            'The stored file could not be read, so it cannot be re-read.', downloadError?.message);
        }

        /*
         * A FILE'S RE-READ RUNS ON THE STORED BYTES — which for a file is the
         * builder's own file, unchanged. (A LINKED source is re-fetched
         * above; it used to come through here, which is the defect that
         * branch records.) So what it can see of a Google
         * Sheet's links is exactly what the ORIGINAL fetch saw: a stored CSV
         * from a resolved fetch carries the merged URL columns in its own
         * text, and one from a refused fetch carries labels with no targets
         * anywhere. The refusal was recorded on the upload row when it
         * happened (`sourceAccessNoticeFor` → `error_detail.reason`), so it is
         * read back here and stamped onto the re-written rows — a re-read
         * must not launder "we could not see the links" into "there are no
         * links".
         */
        const storedAvailability = upload.error_code === SOURCE_LINKS_UNAVAILABLE
          ? String((upload.error_detail as { reason?: string } | null)?.reason
            ?? 'unavailable_source_export')
          : null;
        const result = await runStockImport({
          supabase,
          organisationId: activeOrganisationId,
          organisationName,
          builderUserId: me.id,
          upload: { id: upload.id, original_filename: upload.original_filename },
          bytes: new Uint8Array(await blob.arrayBuffer()),
          sourceKind: 'file',
          linkDiscovery: linkDiscoveryFromAvailability(storedAvailability),
          /*
           * THE SAME BYTES, SO THE SAME RECOGNISED TEXT.
           *
           * A re-read re-runs the READER, which is what it is for. It does
           * not need to re-run the RECOGNISER: the pages are keyed on the
           * digest of the stored document, and this path downloads exactly
           * those stored bytes, so anything carried describes this document
           * or it is discarded. Three seconds a page for nothing is the
           * alternative.
           */
          storedCheckpoint: upload.import_checkpoint,
          // This branch is the FILE re-read — a linked source is re-fetched
          // above and carries metadata a stored-bytes successor could not
          // reproduce. See `resumableFromStoredBytes`.
          resumableFromStoredBytes: true,
        });
        /*
         * NO CLAIM IS TAKEN ON THIS PATH, AND THAT IS A DECISION.
         *
         * The guard above already refuses a row that is `parsing` and not
         * abandoned — which is exactly what a live continuation looks like,
         * because a continuation keeps the row `parsing` and never refreshes
         * `processing_started_at`. The only window it leaves is a
         * continuation still running after fifteen minutes, and a
         * continuation is bounded at ten crossings of a few seconds each.
         *
         * Adding a lease here would buy nothing and cost something real: a
         * re-read that failed would hold the row shut for ninety seconds
         * against a builder who is trying again, which is the state this
         * operation exists to get people OUT of.
         */
        return await finishImport(upload.id, result, { reprocessed: true });
      } catch (error) {
        console.error('[builder-portal-stock] reprocessing failed', error);
        return await failUpload(upload.id, 'processing_failed',
          'That source could not be re-read. Please check the format and try again.',
          (error as { message?: string })?.message);
      }
    }

    // =====================================================================
    // Import from a URL
    //
    // The same pipeline reached a different way. The server does the fetch —
    // a browser cannot be trusted to hand us the bytes and say where they came
    // from — snapshots what it got into the same private bucket a file lands
    // in, and then calls exactly the same `runStockImport`.
    // =====================================================================

    if (operation === 'import_url') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to add stock', code: 'permission_denied' }, 403);
      }

      /*
       * ONE IMPLEMENTATION OF "REACH THE LINK AND PREPARE IT".
       *
       * Normalisation, the fetch and its five refusals, MIME detection,
       * classification, the Notion public-content recovery with its
       * access-gate and missing-view findings, and the naming of the snapshot
       * — all of it moved to `linkedSource.ts` unchanged, because
       * `reprocess_upload` now has to do exactly this too. Two copies is how
       * a re-fetch comes to read a Notion page differently from the import
       * that first accepted it.
       */
      const prepared = await prepareLinkedStockSource(body.url);
      if (!prepared.ok) {
        return json({ error: prepared.error, code: prepared.code }, prepared.status);
      }
      const {
        importBytes, snapshotContentType, classification, displayName, objectName,
        documentName, notionDiagnostics,
      } = prepared;

      const uploadId = crypto.randomUUID();
      const storagePath = `${STOCK_LIST_STORAGE_PREFIX}${activeOrganisationId}/${uploadId}/${objectName}`;

      // The snapshot is what keeps the import auditable after the page
      // changes, and it is why the Command Centre never has to re-fetch a
      // third-party URL to show the stock.
      const { error: snapshotError } = await supabase.storage
        .from(STOCK_LIST_BUCKET)
        .upload(storagePath, importBytes, {
          contentType: snapshotContentType,
          upsert: true,
        });
      if (snapshotError) {
        /**
         * Everything needed to diagnose this WITHOUT another production
         * repro. The first failure of this path logged only the provider's
         * message — "Bucket not found" — which named neither the bucket nor
         * anything else, so the cause (the migration that creates
         * `builder-stock-lists` had never been applied to the project) was
         * indistinguishable from a permissions or payload fault.
         *
         * Server-side only, and deliberately not the source URL: a link can
         * carry a token in its query string. The HOST is enough to identify
         * the provider, and the object path carries no secret.
         */
        console.error('[builder-portal-stock] snapshot failed', {
          bucket: STOCK_LIST_BUCKET,
          storage_path: storagePath,
          status: (snapshotError as { statusCode?: string | number }).statusCode ?? null,
          name: (snapshotError as { name?: string }).name ?? null,
          message: snapshotError.message,
          declared_content_type: prepared.declaredContentType,
          snapshot_content_type: snapshotContentType,
          classified_as: classification.kind,
          byte_length: importBytes.length,
          source_host: prepared.host,
        });
        return json({ error: 'That page could not be saved for import.', code: 'snapshot_failed' }, 502);
      }

      const { data: upload, error: insertError } = await supabase
        .from('builder_stock_uploads')
        .insert({
          id: uploadId,
          organisation_id: activeOrganisationId,
          uploaded_by_builder_user_id: me.id,
          source_type: 'url',
          source_url: prepared.url,
          final_url: prepared.finalUrl,
          source_title: displayName,
          retrieved_at: new Date().toISOString(),
          original_filename: objectName,
          declared_content_type: prepared.declaredContentType,
          byte_size: importBytes.length,
          storage_bucket: STOCK_LIST_BUCKET,
          storage_path: storagePath,
          status: 'parsing',
          processing_started_at: new Date().toISOString(),
        })
        .select(STOCK_UPLOAD_SELECT)
        .single();
      if (insertError || !upload) {
        console.error('[builder-portal-stock] url upload insert failed', insertError?.message);
        return json({ error: 'The import could not be started.' }, 500);
      }

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_url_source_added',
        entityType: 'stock_upload', entityId: uploadId,
        metadata: { host: prepared.host, notion: prepared.isNotion },
      });

      try {
        const result = await runStockImport({
          supabase,
          organisationId: activeOrganisationId,
          organisationName,
          builderUserId: me.id,
          upload: { id: uploadId, original_filename: displayName },
          bytes: importBytes,
          classification,
          sourceKind: 'url',
          /*
           * The document's own name where the source stated one, and NULL
           * where it did not — never `displayName`, which is host + ellipsis
           * + path segment. The reader corroborates a page line against a
           * name, so a display label let a hostname name a house design.
           * Measured in `documentName.pure.ts`.
           */
          documentName,
          isNotionSource: prepared.isNotion,
          baseUrl: prepared.finalUrl,
          rowAssets: prepared.rowAssets,
          /*
           * A Google Sheet's link targets travel SEPARATELY from its proven
           * CSV, so the fetch's own reading of how that went is stamped onto
           * every row this import writes. `null` for every other kind of URL —
           * their links are native to the fetched bytes, and `runStockImport`
           * stamps them from the strategy that read them.
           */
          linkDiscovery: linkDiscoveryFromAvailability(
            prepared.hyperlinks, prepared.hyperlinkMethod),
          // Carried for the import's own log line only — see `sheetTab`.
          sheetTab: prepared.sheetTab,
        });

        /**
         * A Notion source that produced nothing is the case this whole path
         * used to get wrong, so it is the case that gets the full record.
         * Server-side only, and note what is absent: no URL (a link can carry
         * a token in its query string), no cookie, no header, no key. The HOST
         * identifies the provider and nothing here identifies a credential.
         */
        /*
         * A CONTINUATION IS NOT "PRODUCED NOTHING".
         *
         * It is a document that has not finished being READ, so it has no
         * strategy, no count and no failure code — and warning here would file
         * an import that is still running as a Notion source that failed. The
         * successor reaches this same line when it finishes.
         */
        const readIt = isImportContinuation(result) ? null : result;
        if (notionDiagnostics && readIt
          && (!readIt.ok || readIt.summary.detected === 0)) {
          console.warn('[builder-portal-stock] notion produced no stock', {
            ...notionDiagnostics,
            parse_strategy: readIt.ok ? readIt.strategy : null,
            rows_detected: readIt.ok ? readIt.summary.detected : 0,
            failure_code: readIt.ok ? null : readIt.code,
          });
        }

        return await finishImport(uploadId, result, {
          strategy_source: 'url',
          ...(notionDiagnostics ? { notion_recovery: notionDiagnostics.recovery_ok } : {}),
          ...(prepared.hyperlinks ? { source_hyperlinks: prepared.hyperlinks } : {}),
        }, prepared.hyperlinks, prepared.url);
      } catch (error) {
        console.error('[builder-portal-stock] url processing failed', error);
        return await failUpload(uploadId, 'processing_failed',
          'That page could not be processed.', (error as { message?: string })?.message);
      }
    }

    // =====================================================================
    // Image enrichment — stages 2 and 3, resumable
    // =====================================================================

    /**
     * Recover source imagery for stock that is ALREADY imported.
     *
     * The smallest thing that repairs the seventy live properties whose cards
     * show a Street View while their builder's renders sit on the source's own
     * rows. It re-reads the source and attaches what it finds; it creates
     * nothing, edits no property field, and leaves every client selection,
     * availability and audit row exactly where it was. Asking a builder to
     * delete and re-upload a stock list to fix a picture is not a repair.
     */
    if (operation === 'reprocess_source_images') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }

      const uploadId = cleanText(body.upload_id, 64);
      let sourceIds: string[] = [];
      if (uploadId) {
        const upload = await loadUpload(uploadId);
        if (!upload || upload.deleted_at) return notFoundHere('That stock list');
        sourceIds = [upload.id];
      } else {
        const { data: uploads } = await supabase
          .from('builder_stock_uploads')
          .select('id')
          .eq('organisation_id', activeOrganisationId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(20);
        sourceIds = (uploads ?? []).map((row: { id: string }) => row.id);
      }

      const startedAt = Date.now();
      const results = [];
      for (const id of sourceIds) {
        if (Date.now() - startedAt > ENRICHMENT_BUDGET_MS) break;
        const result = await repairSourceImagesForUpload(supabase, {
          organisationId: activeOrganisationId,
          uploadId: id,
          // A row's own package document is a couple of megabytes, so the run
          // is budgeted and resumable: rows that already hold a source image
          // are skipped, and `incomplete` tells the page to ask again.
          deadlineAt: startedAt + ENRICHMENT_BUDGET_MS,
        });
        // Server-side only: the problem list can name a source object path.
        if (result.problems.length) {
          console.warn('[builder-portal-stock] source image repair problems', {
            upload_id: id, problems: result.problems.slice(0, 10),
          });
        }
        results.push({
          upload_id: result.uploadId,
          rows_read: result.rowsRead,
          rows_with_imagery: result.rowsWithImagery,
          matched: result.matched,
          images_stored: result.imagesStored,
          from_package: result.fromPackage,
          package_not_identified: result.packageNotIdentified,
          package_unreachable: result.packageUnreachable,
          incomplete: result.incomplete,
          demoted: result.demoted,
          primary_updated: result.primaryUpdated,
          error: result.error ?? null,
        });
      }

      /**
       * Judge display eligibility for anything stored before it was judged,
       * BEFORE primaries are settled — otherwise a picture would be nominated
       * and only then found to be a marketing tile.
       */
      const eligibility = await settleMarketplaceEligibility(
        supabase, activeOrganisationId, { deadlineAt: startedAt + ENRICHMENT_BUDGET_MS });

      /**
       * Settle EVERY property, not only the ones this run touched.
       *
       * A property whose pointer no longer matches what the ranking would pick
       * — an image re-judged a marketing tile since it was chosen, a builder
       * cover that has arrived for a property showing a fallback — must end the
       * run pointing at the current answer rather than the old one.
       *
       * It settles to the SAME ranking the per-item path uses
       * (`chooseCardImage`). This comment used to say the opposite: that a
       * property whose builder supplied nothing must end with no image "rather
       * than the Street View it had before the rule changed". That was true of
       * the builder-or-nothing rule and stopped being true when
       * `imagePriority.pure.ts` reinstated the fallback tiers; the function it
       * describes went on enforcing the repealed rule, and this operation is
       * the caller that could reach it. See `enforceStrictPrimaryImages`.
       */
      const primaries = await enforceStrictPrimaryImages(supabase, activeOrganisationId);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_source_images_reprocessed',
        entityType: 'stock_upload', entityId: sourceIds[0] ?? null,
        metadata: { sources: results.length, results, primaries, eligibility },
      });

      return json({ success: true, results, primaries, eligibility });
    }

    if (operation === 'enrich_images') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }

      const uploadId = cleanText(body.upload_id, 64);
      /*
       * BOTH PROCESSED LIFECYCLES, WHICH IS THE ONLY SET THIS CONTROL CAN
       * USEFULLY SERVE.
       *
       * "Retry image lookup" filtered `lifecycle_status = 'active'` — the
       * published set, which by definition already has its photographs. The
       * rows that need it are the STAGED ones an unpublished upload is
       * waiting on, and they were the one set it could not touch. Measured
       * 18 September 2026: 47 staged properties held an import invisible
       * while this button answered "Nothing was waiting for images" on every
       * press, because all 47 were staged and none was active.
       *
       * `PROCESSED_LIFECYCLE` is the set the image engine already works on
       * (`stockLifecycle.pure.ts`), so this is the operator's half of the
       * same rule: every queue, claim and repair widens, while every SERVING
       * read stays `active` exactly as it was.
       */
      let query = supabase
        .from('builder_stock_items')
        .select('id, organisation_id, address_line, suburb, state, postcode, development_name, project_name, lot_number, unit_number')
        .eq('organisation_id', activeOrganisationId)
        .in('lifecycle_status', PROCESSED_LIFECYCLE)
        .in('enrichment_status', ['pending', 'enriching'])
        .order('created_at', { ascending: true })
        .limit(ENRICHMENT_MAX_ITEMS);
      if (uploadId) query = query.eq('upload_id', uploadId);

      const { data: pending } = await query;
      const startedAt = Date.now();
      let processed = 0;

      /**
       * PHASE 0 — THE BUILDER'S OWN IMAGERY, BEFORE ANYBODY GOES OUT TO GOOGLE.
       *
       * This loop is what the browser already drives after every import, and
       * until now it only ever ran stages 2 and 3. Stage 1 — reading the
       * builder's own source — happened at import or not at all, so a stock
       * list whose imagery was written under older rules needed a person to
       * press "Source images" before its cards had pictures.
       *
       * Settling it here costs nothing on an upload that is already current
       * (a marker read), converges because the marker is terminal, and reuses
       * the SAME implementation the manual repair uses rather than a second
       * copy of it. `remaining` counts it, so the browser's existing loop keeps
       * asking until the work is done.
       */
      let settlementRemaining = 0;
      try {
        const outstanding = await uploadsNeedingSettlement(supabase, {
          organisationId: activeOrganisationId,
          uploadId: uploadId || null,
          limit: SETTLEMENT_MAX_UPLOADS,
        });
        /*
         * ONE overlay-repair allowance for the whole call, not one per upload
         * — the same rule, for the same measured reason, as the settler's own
         * tick. A repair is a full-resolution decode plus a reconstruction or
         * up to four model calls, and this worker dies on its RESOURCE limit
         * long before `ENRICHMENT_BUDGET_MS` does; five uploads each minting
         * the module's default allowance is ten of them, which is a 546 with
         * nothing written. `settleImageSanitization` defaults to a fresh
         * budget only for a caller repairing ONE upload by hand — a loop must
         * bring its own and thread it, so the call spends it once.
         */
        const repairBudget = newRepairBudget();
        for (const id of outstanding) {
          if (Date.now() - startedAt > ENRICHMENT_BUDGET_MS) break;
          const settlement = await settleUploadSourceImages(supabase, {
            organisationId: activeOrganisationId,
            uploadId: id,
            deadlineAt: startedAt + ENRICHMENT_BUDGET_MS,
            repairBudget,
          });
          /**
           * PROGRESS, not completion. The browser stops looping on a batch
           * that moved nothing, and a source too big to settle inside one
           * budget moves plenty without finishing — so counting only the
           * finished ones would abandon exactly the imports that need the
           * most work.
           */
          const moved = settlement.settled
            || (settlement.repair?.imagesStored ?? 0) > 0
            || (settlement.repair?.primaryUpdated ?? 0) > 0
            || (settlement.repair?.demoted ?? 0) > 0;
          if (moved) processed += 1;
        }
        settlementRemaining = (await uploadsNeedingSettlement(supabase, {
          organisationId: activeOrganisationId,
          uploadId: uploadId || null,
          limit: SETTLEMENT_MAX_UPLOADS,
        })).length;
      } catch (error) {
        // Stage 1 failing must not stop stages 2 and 3, and must not be silent.
        console.warn('[builder-portal-stock] source image settlement failed', {
          upload_id: uploadId || null,
          phase: 'source_image_settlement',
          message: String((error as { message?: string })?.message ?? error).slice(0, 300),
        });
      }

      for (const item of pending ?? []) {
        if (Date.now() - startedAt > ENRICHMENT_BUDGET_MS) break;
        try {
          /*
           * WHILE ANY SOURCE IS STILL BEING READ, THE PAID STAGES WAIT.
           *
           * `settlementRemaining` is the count of uploads whose imagery has
           * not finished settling, and a property in one of them may be about
           * to gain the builder's own render. Buying a search or a Street View
           * against it spends money to be discarded — and worse, can put a
           * fallback on a card that is about to have the real picture. The
           * browser's loop keeps calling until this reaches zero, so nothing
           * is skipped, only deferred.
           */
          await enrichStockItem(supabase, {
            ...(item as EnrichableStockItem),
            sourceSettlementComplete: settlementRemaining === 0,
          }, organisationName);
        } catch (error) {
          // Enrichment is allowed to fail. The property stays.
          console.warn('[builder-portal-stock] enrichment failed', {
            item: (item as { id: string }).id,
            message: String((error as { message?: string })?.message ?? error),
          });
          await supabase.from('builder_stock_items')
            .update({ enrichment_status: 'failed', enriched_at: new Date().toISOString() })
            .eq('id', (item as { id: string }).id)
            // Same rule: the row came from an organisation-scoped read, and
            // the write says so too rather than relying on that.
            .eq('organisation_id', activeOrganisationId);
        }
        processed += 1;
      }

      // The same set the work query above reads, or the count would report
      // "nothing left" while staged rows were still waiting.
      let remainingQuery = supabase
        .from('builder_stock_items')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', activeOrganisationId)
        .in('lifecycle_status', PROCESSED_LIFECYCLE)
        .in('enrichment_status', ['pending', 'enriching']);
      if (uploadId) remainingQuery = remainingQuery.eq('upload_id', uploadId);
      const { count: remaining } = await remainingQuery;
      /**
       * What the BROWSER should come back for, which is both stages. The
       * upload's own status below is settled on the ITEMS alone: it means "the
       * properties have been through image enrichment", and gating it on
       * settlement as well would leave an upload reading `enriching` for ever
       * on a source too large to settle inside one budget.
       */
      const outstanding = (remaining ?? 0) + settlementRemaining;

      /*
       * THE UPLOAD'S OWN STATUS IS SETTLED BY THE SHARED RULE.
       *
       * This block used to be the ONLY place an import was marked finished,
       * and it runs only while somebody has this page open — so an import
       * that completed headlessly stayed `enriching` with an empty
       * `image_stage_summary` for ever. `uploadCompletion.ts` holds the rule
       * now and the settler's tick asks it too; the call here keeps a person
       * who IS watching from waiting on a tick, and the decision is the same
       * either way. It also no longer writes a summary from an incomplete
       * read — see that module's header.
       */
      if (uploadId && !remaining) {
        await settleUploadCompletion(supabase, {
          uploadId, organisationId: activeOrganisationId,
        });
      }

      return json({
        success: true,
        processed,
        remaining: outstanding,
        source_images_outstanding: settlementRemaining,
      });
    }

    // =====================================================================
    // Reads
    // =====================================================================

    if (operation === 'list_uploads') {
      const { page, pageSize, from, to } = stockPagination(body);
      /*
       * `error_detail` is read here and never sent: `projectUploadListRow`
       * strips it and answers `link_recovery_available` in its place, the
       * same read `refresh_brochure_links` makes — so the page can offer the
       * act exactly where the server would accept it, without ever seeing
       * the diagnosis.
       */
      const { data, count } = await supabase
        .from('builder_stock_uploads')
        .select(`${STOCK_UPLOAD_SELECT}, error_detail`, { count: 'exact' })
        .eq('organisation_id', activeOrganisationId)
        // A deleted source leaves the builder's active history. The row stays
        // for the stock and the selections that reference it.
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(from, to);
      return json({
        success: true,
        records: (data ?? []).map(projectUploadListRow),
        pagination: {
          page, page_size: pageSize, total: count ?? 0,
          total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        },
      });
    }

    if (operation === 'image_progress') {
      /*
       * THE TRUTHFUL AGGREGATE the page's banner draws from: real counts of
       * real item state per recent upload — photos_ready counts READY
       * builder-source primaries only, so a card can say "4 of 6 photos
       * ready" and mean it. Read-only, org-scoped by the session, computed
       * by the database in one call.
       */
      const { data, error } = await supabase
        .rpc('builder_stock_image_progress', { p_organisation_id: activeOrganisationId });
      if (error) {
        // A deployment mid-migration has no RPC yet; the page keeps its
        // per-item derivation and loses only the aggregate line.
        return json({ success: true, records: [], unavailable: true });
      }
      return json({ success: true, records: data ?? [] });
    }

    if (operation === 'get_upload') {
      const upload = await loadUpload(cleanText(body.upload_id, 64));
      if (!upload) return notFoundHere('That stock list');
      // The row is selected in full above so the handler can read it;
      // `projectUploadListRow` keeps `error_detail` off the wire and answers
      // `link_recovery_available` in its place, and `storage_path` stays
      // internal too.
      const { storage_path: _path, ...safe } = upload;
      return json({ success: true, record: projectUploadListRow(safe) });
    }

    if (operation === 'list_stock') {
      const { page, pageSize, from, to } = stockPagination(body);
      const search = cleanText(body.search, 120);
      const availability = cleanText(body.availability_status, 40);
      const uploadId = cleanText(body.upload_id, 64);

      /*
       * WHICH LIFECYCLE THIS READ SERVES, VALIDATED RATHER THAN INTERPOLATED.
       *
       * `active` stays the default and is what the marketplace list draws —
       * unchanged. `staged` is what a builder needs to SEE to act on: an
       * upload is held until every property carries a builder-source
       * photograph, and the remedy for a property whose documents name none
       * is the builder adding one. `attach_builder_image` has always accepted
       * a staged row; until now nothing could list one, so the remedy existed
       * with no way to reach it and 47 held properties read as an empty page.
       *
       * The value is checked against the lifecycle vocabulary instead of being
       * passed through: an unrecognised string used to reach `.eq()` and
       * return zero rows, which is indistinguishable from a builder with no
       * stock.
       */
      const requestedLifecycle = cleanText(body.lifecycle_status, 20);
      const lifecycle: StockLifecycle = requestedLifecycle === 'staged'
        || requestedLifecycle === 'archived'
        || requestedLifecycle === 'active'
        ? requestedLifecycle
        : SERVED_LIFECYCLE;

      let query = supabase
        .from('builder_stock_items')
        .select(STOCK_ITEM_SELECT, { count: 'exact' })
        .eq('organisation_id', activeOrganisationId)
        .eq('lifecycle_status', lifecycle);
      if (uploadId) query = query.eq('upload_id', uploadId);
      if (availability && (STOCK_AVAILABILITY_STATUSES as readonly string[]).includes(availability)) {
        query = query.eq('availability_status', availability);
      }
      if (search) {
        const escaped = search.replace(/[%,()]/g, ' ');
        query = query.or(
          ['address_line', 'suburb', 'development_name', 'project_name', 'external_reference']
            .map((column) => `${column}.ilike.%${escaped}%`).join(','),
        );
      }

      const { data, count } = await query
        .order('created_at', { ascending: false })
        .range(from, to);

      const items = data ?? [];
      const decorated = await decorateItems(supabase, items, activeOrganisationId);

      /*
       * WHERE THIS STOCK ACTUALLY GOES.
       *
       * The list used to be headed "these are what the Command Centre sees"
       * unconditionally, and for an organisation with no authorised
       * connection that is false — the whole defect this reading exists to
       * end. The state is the server's view, and a read that FAILS carries no
       * state at all rather than reviving the claim: `describeDistribution`
       * answers `unknown` and the page says nothing about sharing.
       */
      let distribution: Record<string, unknown> | null = null;
      try {
        const { data: sync } = await supabase
          .from('builder_network_sync_state')
          .select(BUILDER_SYNC_STATE_SELECT)
          .eq('builder_organisation_id', activeOrganisationId)
          .maybeSingle();
        // Checked rather than cast: this deployment keeps no generated
        // `Database` type, so the shape is established here or not at all.
        const reading = readSyncStateRow(sync);
        if (reading) {
          distribution = {
            state: reading.state,
            authorised_destinations: reading.authorisedDestinations,
            active_stock_count: reading.activeStockCount,
            events_queued: reading.eventsQueued,
            last_delivered_at: reading.lastDeliveredAt,
          };
        }
      } catch {
        // A distribution reading is never worth failing a stock list for.
        distribution = null;
      }

      return json({
        success: true,
        records: decorated,
        distribution,
        pagination: {
          page, page_size: pageSize, total: count ?? 0,
          total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        },
      });
    }

    if (operation === 'get_stock_item') {
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');
      const [decorated] = await decorateItems(supabase, [item], activeOrganisationId);
      return json({ success: true, record: decorated });
    }

    if (operation === 'image_url') {
      /*
       * THE STEP BETWEEN THE POINTER AND THE PICTURE, and it lives in
       * `serveStockImage.ts` rather than here so the acceptance gate can prove
       * it by CALLING it. Six lines copied into a harness prove that the six
       * lines work; they prove nothing about the function a customer's browser
       * reaches. The tenant filter, the external-URL case and the short-lived
       * signed URL are all that module's, and its header says why each one is
       * the way it is.
       */
      const served = await serveStockImage(supabase, {
        imageId: cleanText(body.image_id, 64),
        organisationId: activeOrganisationId,
        ttlSeconds: IMAGE_URL_TTL_SECONDS,
        bucket: STOCK_IMAGE_BUCKET,
      });
      if (!served.ok) {
        return served.reason === 'not_found'
          ? notFoundHere('That image')
          : json({ error: 'The image could not be prepared' }, 502);
      }
      return served.external
        ? json({ success: true, url: served.url, external: true })
        : json({ success: true, url: served.url, expires_in: served.expiresIn });
    }

    // =====================================================================
    // Mutations on stock
    // =====================================================================

    if (operation === 'set_availability') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');

      const status = cleanText(body.availability_status, 40);
      if (!(STOCK_AVAILABILITY_STATUSES as readonly string[]).includes(status)) {
        return json({ error: 'That availability status is not recognised' }, 400);
      }

      const { data, error } = await supabase
        .from('builder_stock_items')
        .update({ availability_status: status })
        .eq('id', item.id)
        .eq('organisation_id', activeOrganisationId)
        .select(STOCK_ITEM_SELECT)
        .single();
      if (error) return json({ error: 'The property could not be updated' }, 400);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_availability_changed',
        entityType: 'stock_item', entityId: item.id,
        previousState: { availability_status: item.availability_status },
        newState: { availability_status: status },
      });
      return json({ success: true, record: data });
    }

    /*
     * THE FIGURES A BUILDER STATES THEMSELVES.
     *
     * Their stock list does not always say how many bedrooms a house has —
     * measured on the prime, the three PDF-sourced properties missing bed,
     * bath and car are all DUAL-KEY homes, where the brochure states two sets
     * of figures for two self-contained dwellings and the extraction rightly
     * declined to collapse them into one. The document cannot be parsed
     * harder into carrying a fact it does not carry; the builder supplies it.
     *
     * IT NEVER WRITES THE EXTRACTION'S OWN COLUMNS. `manual_stats` is a
     * column `writablePatch` does not name, which is the whole point: a
     * figure written to `bedrooms` would survive a silent stock list and be
     * destroyed by the next one that speaks. The overlay happens on read.
     *
     * AND WHERE THE PROPERTY IS. `Lot 101 - PICO - BROCHURE v002.pdf` names
     * its lot and its estate and no street, suburb, state or postcode, so no
     * marketplace could place it. The same statement carries those four parts
     * (`statedLocation.pure.ts`), under the same rule and for the same reason:
     * the address columns are cleared by a same-source re-read that states
     * nothing, so an address typed into them would not outlive the next
     * reader release.
     */
    if (operation === 'set_manual_stats') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');

      const recordedAt = new Date().toISOString();
      /*
       * THE FIGURES AND THE PLACE ARE ONE STATEMENT, stored together in
       * `manual_stats.values` and written in one update, so a builder's
       * correction is never half-saved.
       *
       * A PART THE REQUEST DOES NOT MENTION IS KEPT, NOT WITHDRAWN. The
       * dialog sends both, every time, with `null` for a cleared box — that
       * is a withdrawal. A request with no `location` at all is a client that
       * predates stating one (a tab opened before the deploy), and treating
       * its silence as "clear the address" would erase a builder's statement
       * because somebody else saved a bedroom count. The same holds for
       * `stats` the other way round.
       */
      const figures = body.stats === undefined
        ? { stats: readManualStats(item.manual_stats), errors: [] }
        : parseManualStats(body.stats, { recordedAt, recordedBy: me.id });
      const place = body.location === undefined
        ? { location: readStatedLocation(item.manual_stats) ?? {}, errors: [] }
        : parseStatedLocation(body.location);
      const errors = [...figures.errors, ...place.errors];
      /*
       * REFUSED, NEVER CLAMPED. Turning a mistyped 3000 into 99 records a
       * bedroom count nobody stated, on a card a client reads — the same
       * class as a fabricated price, which is the one thing the extraction
       * prompt's first rule exists to prevent. A suburb with a number in it
       * is refused for the same reason: it is a postcode or a lot in the
       * wrong box, and storing it would place the property somewhere else.
       */
      if (errors.length) {
        return json({ error: errors[0].message, code: 'invalid_stat', fields: errors }, 400);
      }
      const values = { ...(figures.stats?.values ?? {}), ...place.location };
      // Every part cleared is a withdrawal of the whole statement.
      const stats = Object.keys(values).length
        ? { values, recorded_at: recordedAt, recorded_by: me.id }
        : null;

      const { data, error } = await supabase
        .from('builder_stock_items')
        .update({ manual_stats: stats })
        .eq('id', item.id)
        .eq('organisation_id', activeOrganisationId)
        .select(STOCK_ITEM_SELECT)
        .single();
      if (error) {
        console.error('[builder-portal-stock] manual stats write failed', error.message);
        return json({ error: 'The property could not be updated' }, 400);
      }

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: stats ? 'builder_stock_manual_stats_set' : 'builder_stock_manual_stats_cleared',
        entityType: 'stock_item', entityId: item.id,
        // What the document said, beside what the builder stated, so the log
        // records the disagreement rather than only the outcome.
        previousState: {
          manual_stats: (item as { manual_stats?: unknown }).manual_stats ?? null,
          extracted: {
            bedrooms: item.bedrooms ?? null, bathrooms: item.bathrooms ?? null,
            car_spaces: item.car_spaces ?? null,
            building_size_sqm: item.building_size_sqm ?? null,
            land_size_sqm: item.land_size_sqm ?? null,
            address_line: item.address_line ?? null, suburb: item.suburb ?? null,
            state: item.state ?? null, postcode: item.postcode ?? null,
          },
        },
        newState: { manual_stats: stats },
      });

      const [decorated] = await decorateItems(supabase, [data], activeOrganisationId);
      return json({ success: true, record: decorated });
    }

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * "USE BROCHURE IMAGE" — A BUILDER SAYS A BROCHURE IS THEIRS
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The page sends the link and the lot it showed the builder, and both are
     * lookup keys: the act re-reads the stored refusal under that link and
     * refuses unless it is still the mismatch stating that lot, and re-reads
     * the organisation's listings to refuse a brochure another listing
     * already uses the photograph of. Editing stock is the permission, the
     * same one "Add picture" asks for. See `brochureConfirmation.ts`.
     */
    if (operation === 'confirm_brochure_image' || operation === 'undo_brochure_image') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');
      const actor = { id: me.id ?? null, name: cleanText(me.name || me.email, 160) };

      const outcome = operation === 'confirm_brochure_image'
        ? await confirmBrochureImage(supabase, {
          organisationId: activeOrganisationId,
          stockItemId: item.id,
          // Never cleaned: it is compared, byte for byte, with the key its
          // stored answer lives under, and a link has no whitespace to lose.
          documentReference: typeof body.document_key === 'string'
            ? body.document_key.slice(0, 2048) : '',
          states: cleanText(body.states, 40),
          actor,
        })
        : await undoBrochureImage(supabase, {
          organisationId: activeOrganisationId,
          stockItemId: item.id,
          confirmationId: cleanText(body.confirmation_id, 64),
          actor,
        });
      if (!outcome.ok) {
        if (outcome.code === 'not_found') return notFoundHere('That brochure confirmation');
        const status = outcome.code === 'invalid' || outcome.code === 'not_confirmable' ? 400
          : outcome.code === 'unavailable' ? 503
            : 409;
        return json({
          error: outcome.message,
          code: outcome.code,
          ...('in_use_by' in outcome && outcome.in_use_by ? { in_use_by: outcome.in_use_by } : {}),
        }, status);
      }

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: operation === 'confirm_brochure_image'
          ? 'builder_stock_brochure_image_confirmed'
          : 'builder_stock_brochure_image_confirmation_undone',
        entityType: 'stock_item', entityId: item.id,
        metadata: operation === 'confirm_brochure_image'
          ? {
            confirmation_id: outcome.id,
            document: typeof body.document_key === 'string' ? body.document_key.slice(0, 400) : null,
            states: cleanText(body.states, 40),
            already_confirmed: 'already' in outcome ? outcome.already : false,
          }
          : {
            confirmation_id: outcome.id,
            images_withdrawn: 'imagesWithdrawn' in outcome ? outcome.imagesWithdrawn : 0,
          },
      });

      const { data: fresh } = await supabase
        .from('builder_stock_items')
        .select(STOCK_ITEM_SELECT)
        .eq('id', item.id)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      const [decorated] = fresh
        ? await decorateItems(supabase, [fresh], activeOrganisationId)
        : [null];
      return json({ success: true, confirmation_id: outcome.id, record: decorated });
    }

    if (operation === 'archive_stock_item') {
      if (!await can('delete')) {
        return json({ error: 'You do not have permission to remove stock', code: 'permission_denied' }, 403);
      }
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');

      const { data, error } = await supabase
        .from('builder_stock_items')
        .update({ lifecycle_status: 'archived' })
        .eq('id', item.id)
        .eq('organisation_id', activeOrganisationId)
        .select(STOCK_ITEM_SELECT)
        .single();
      if (error) return json({ error: 'The property could not be archived' }, 400);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_item_archived',
        entityType: 'stock_item', entityId: item.id,
      });
      return json({ success: true, record: data });
    }

    // =====================================================================
    // Removing a stock-list source
    // =====================================================================

    /*
     * "Refresh brochure links" — the same recovery, asked again by hand.
     *
     * OFFERED ONLY WHERE IT CAN DO SOMETHING. The upload must be this
     * organisation's, must be a Google Sheets source, and must currently carry
     * the one availability an authorised re-read can change. Anything else is
     * refused rather than quietly doing nothing, so the button in the portal
     * and the server agree about when it applies.
     *
     * It re-reads the SOURCE ONLY. No rows are re-imported, no stock data is
     * touched, and nothing about the marketplace changes until stage 1 opens a
     * recovered document through the pipeline that already exists.
     */
    if (operation === 'refresh_brochure_links') {
      // Same level as every other act that changes a stock list: this one
      // inserts a recovery request and sends a webhook out of the deployment,
      // which is not something a viewer may do. It sat under the `view` gate
      // alone while `reprocess_source_images` and `enrich_images` — the same
      // shape of upload-scoped re-read — have always required `edit`.
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const uploadId = String(body.upload_id || '');
      if (!uploadId) return json({ success: false, error: 'upload_id is required.' }, 400);

      const { data: upload } = await supabase.from('builder_stock_uploads')
        .select('id, source_type, source_url, error_code, error_detail, deleted_at')
        .eq('id', uploadId).eq('organisation_id', activeOrganisationId).maybeSingle();
      if (!upload || upload.deleted_at) {
        return notFoundHere('That stock list', { success: false });
      }

      /*
       * The upload's OWN recorded reason, and both spellings of it. A row
       * written before that reading was split in two carries the old name; it
       * describes the same restricted export and the same act recovers it.
       */
      const availability = (upload.error_detail ?? {})?.reason ?? null;
      if (!isRecoverableStoredAvailability(availability)) {
        return json({
          success: false,
          error: 'This stock list does not have brochure links waiting to be recovered.',
        }, 409);
      }

      const ref = googleSheetsRef(upload.source_url);
      if (!ref) {
        return json({ success: false, error: 'This stock list is not a Google Sheet.' }, 409);
      }

      if (!linkRecoveryWebhookConfigured()) {
        return json({
          success: false,
          error: 'Brochure link recovery is not configured for this deployment.',
        }, 409);
      }

      // One refresh per upload per window, on the SERVER, so a disabled button
      // is a convenience rather than the control.
      const limit = await consumeRateLimit(
        supabase, `bs:link-refresh:${uploadId}`, 1, MANUAL_REFRESH_WINDOW_SECONDS);
      if (!limit.allowed) {
        return json({
          success: false,
          error: 'Brochure links were refreshed for this list recently. Try again shortly.',
        }, 429);
      }

      const outcome = await requestLinkRecovery(supabase, {
        organisationId: activeOrganisationId,
        uploadId,
        spreadsheetId: ref.spreadsheetId,
        gid: ref.gid,
        origin: 'manual_refresh',
      });

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_brochure_links_refresh_requested',
        entityType: 'stock_upload', entityId: uploadId,
        metadata: { requested: outcome.requested },
      });

      return json({
        success: outcome.requested,
        requested: outcome.requested,
        error: outcome.requested ? undefined
          : 'Brochure links could not be requested just now. Your stock list is unchanged.',
      }, outcome.requested ? 200 : 503);
    }

    if (operation === 'delete_upload') {
      // Removing a source is a delete, so it needs the delete level — adding
      // one only needs edit.
      if (!await can('delete')) {
        return json({ error: 'You do not have permission to remove stock lists', code: 'permission_denied' }, 403);
      }

      // Resolved by id AND active organisation. An upload id from another
      // organisation is "not found", never "forbidden".
      const upload = await loadUpload(cleanText(body.upload_id, 64));
      if (!upload || upload.deleted_at) return notFoundHere('That stock list');

      // Everything this organisation holds that named the source. Read before
      // anything changes, so the decision is made against stored state.
      /*
       * PAGED, and a failed read refuses the whole act. `.limit(20000)` is
       * capped at 1,000 by the API, and this list decides which properties a
       * source deletion ARCHIVES — so a truncated read silently spares stock
       * the builder asked to remove, and an errored one would read as an
       * upload supplying nothing at all. See `pagedRead.ts`.
       */
      const itemPage = await readAllRows<{
        id: string; upload_id: string | null;
        first_upload_id: string | null; lifecycle_status: string | null;
      }>(() => supabase
        .from('builder_stock_items')
        .select('id, upload_id, first_upload_id, lifecycle_status')
        .eq('organisation_id', activeOrganisationId)
        .or(`upload_id.eq.${upload.id},first_upload_id.eq.${upload.id}`)
        .order('id', { ascending: true }));
      if (itemPage.failed) {
        return json({ success: false, error: 'stock_could_not_be_read' }, 503);
      }
      const rows = itemPage.rows;
      // The rule lives in `sourceDeletion.pure.ts`: only stock this source is
      // CURRENTLY supplying is deactivated. A property re-supplied by a newer
      // list keeps standing, which is the whole point of storing both ids.
      const archiveIds = itemsToArchiveOnSourceDelete(rows, upload.id);
      const retained = rows.length - archiveIds.length;

      // Counted, never touched. A selection a workspace already announced
      // against a property survives the builder tidying up their sources —
      // the network edition counts announcements, the only selection record
      // this side of the boundary holds.
      let affectedSelections = 0;
      if (archiveIds.length) {
        const { count, error: selectionCountError } = await supabase
          .from('builder_stock_selection_announcements')
          .select('id', { count: 'exact', head: true })
          .eq('organisation_id', activeOrganisationId)
          .in('stock_item_id', archiveIds)
          .neq('status', 'withdrawn');
        if (selectionCountError) {
          // The count decides what the confirmation SAYS; refusing beats
          // reporting "0 selections affected" over a failed read.
          console.error('[builder-portal-stock] announcement count failed', selectionCountError.message);
          return json({ success: false, error: 'stock_could_not_be_read' }, 503);
        }
        affectedSelections = count ?? 0;

        // Archived, not deleted. Both marketplace reads filter on
        // `lifecycle_status = active`, so this is what removes the stock from
        // the Property Marketplace — through the rules that were already there.
        const { error: archiveError } = await supabase
          .from('builder_stock_items')
          .update({ lifecycle_status: 'archived' })
          .eq('organisation_id', activeOrganisationId)
          .in('id', archiveIds);
        if (archiveError) {
          console.error('[builder-portal-stock] archive failed', archiveError.message);
          return json({ error: 'The stock list could not be removed.' }, 400);
        }
      }

      const { error: deleteError } = await supabase
        .from('builder_stock_uploads')
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_builder_user_id: me.id,
        })
        .eq('id', upload.id)
        .eq('organisation_id', activeOrganisationId)
        .is('deleted_at', null);
      if (deleteError) {
        console.error('[builder-portal-stock] source delete failed', deleteError.message);
        return json({ error: 'The stock list could not be removed.' }, 400);
      }

      // The stored copy goes with it. The audit row and its counts remain, so
      // the history still records what this source once imported.
      if (isAcceptableStockStoragePath(upload.storage_path)) {
        const { error: objectError } = await supabase.storage
          .from(upload.storage_bucket || STOCK_LIST_BUCKET)
          .remove([upload.storage_path]);
        if (objectError) {
          // The source is already gone as far as the builder is concerned;
          // a stranded object is an operational matter, not a failed delete.
          console.warn('[builder-portal-stock] snapshot removal failed', objectError.message);
        }
      }
      // And the reads of it this pipeline kept so that no isolate parses a
      // PDF and decodes its pictures too (`documentRead.pure.ts`): they are
      // copies of the document's own pictures, and the document is gone.
      // Best-effort, like the object above.
      for (const purpose of ['import', 'settle'] as const) {
        await discardDocumentRead(supabase, {
          organisationId: activeOrganisationId, uploadId: upload.id, purpose,
        });
      }

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_source_deleted',
        entityType: 'stock_upload', entityId: upload.id,
        metadata: {
          archived: archiveIds.length,
          retained_because_resupplied: retained,
          affected_selections: affectedSelections,
        },
      });

      return json({
        success: true,
        removed: {
          archived: archiveIds.length,
          retainedBecauseResupplied: retained,
          affectedSelections,
        },
      });
    }

    // =====================================================================
    // Activations — the builder's side of the two-way link
    // =====================================================================

    if (operation === 'list_selections') {
      const { page, pageSize, from, to } = stockPagination(body);
      // BUILDER_ANNOUNCEMENT_SELECT is the network contract: connection,
      // property, the workspace's opaque ref and chosen label, status and
      // timestamps. The builder learns THAT one of their properties was
      // selected, never who by or for whom — the announcement table never
      // carried a client column to strip.
      const { data, count, error } = await supabase
        .from('builder_stock_selection_announcements')
        .select(BUILDER_ANNOUNCEMENT_SELECT, { count: 'exact' })
        .eq('organisation_id', activeOrganisationId)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) {
        console.error('[builder-portal-stock] announcement list failed', error.message);
        return json({ success: false, error: 'selections_could_not_be_read' }, 503);
      }

      const announcements = data ?? [];
      const itemIds = Array.from(new Set(announcements.map((row: any) => row.stock_item_id)));
      const connectionIds = Array.from(new Set(announcements.map((row: any) => row.connection_id)));
      const [{ data: items }, { data: connections }] = await Promise.all([
        itemIds.length
          ? supabase.from('builder_stock_items')
            .select('id, address_line, suburb, state, development_name, project_name, lot_number, unit_number, external_reference, price, availability_status')
            .eq('organisation_id', activeOrganisationId)
            .in('id', itemIds)
          : Promise.resolve({ data: [] } as any),
        connectionIds.length
          ? supabase.from('workspace_connections')
            .select('id, workspace_id')
            .in('id', connectionIds)
          : Promise.resolve({ data: [] } as any),
      ]);
      const itemById = new Map((items ?? []).map((item: any) => [item.id, item]));

      // The workspace's DISPLAY NAME is directory data the workspace itself
      // asserted to the network; showing the builder which connection
      // selected their property is the point of the announcement.
      const workspaceIds = Array.from(new Set((connections ?? []).map((c: any) => c.workspace_id)));
      const { data: registry } = workspaceIds.length
        ? await supabase.from('workspace_registry')
          .select('id, slug, display_name').in('id', workspaceIds)
        : { data: [] };
      const workspaceById = new Map((registry ?? []).map((w: any) => [w.id, w]));
      const workspaceByConnection = new Map((connections ?? []).map((c: any) => {
        const workspace = workspaceById.get(c.workspace_id) as
          | { slug: string; display_name: string | null } | undefined;
        return [c.id, workspace ? (workspace.display_name || workspace.slug) : null];
      }));

      return json({
        success: true,
        records: announcements.map((row: any) => ({
          ...row,
          // The honest name for what created_at records here.
          announced_at: row.created_at,
          workspace_label: workspaceByConnection.get(row.connection_id) ?? null,
          stock_item: itemById.get(row.stock_item_id) ?? null,
        })),
        pagination: {
          page, page_size: pageSize, total: count ?? 0,
          total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        },
      });
    }

    if (operation === 'acknowledge_selection') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const selectionId = cleanText(body.selection_id, 64);
      if (!selectionId) return notFoundHere('That selection');

      // One transactional command: the acknowledgement stamp, the outbound
      // stock.selection.acknowledged event and the activity entry commit
      // together — the workspace that announced the selection is told, and
      // cannot be told without the stamp having happened.
      const { data, error } = await supabase.rpc('builder_stock_acknowledge_announcement', {
        _announcement_id: selectionId,
        _organisation_id: activeOrganisationId,
        _builder_user_id: me.id,
      });
      if (error) {
        const message = String(error.message);
        if (message.includes('BUILDER_ANNOUNCEMENT_NOT_FOUND')) return notFoundHere('That selection');
        if (message.includes('BUILDER_ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE')) {
          return json({ error: 'This selection has already moved on.', code: 'not_acknowledgeable' }, 409);
        }
        console.error('[builder-portal-stock] acknowledge failed', message);
        return json({ error: 'The selection could not be updated' }, 400);
      }

      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row) return json({ error: 'The selection could not be updated' }, 400);
      // Project to the announcement contract — the RPC returns the row, the
      // browser receives the same columns every other read serves.
      return json({
        success: true,
        record: {
          id: row.id,
          connection_id: row.connection_id,
          stock_item_id: row.stock_item_id,
          organisation_id: row.organisation_id,
          remote_selection_ref: row.remote_selection_ref,
          remote_client_label: row.remote_client_label ?? null,
          status: row.status,
          agency_name: row.agency_name ?? null,
          agency_contact: row.agency_contact ?? null,
          activation_task_id: row.activation_task_id ?? null,
          activation_project_id: row.activation_project_id ?? null,
          announced_at: row.created_at,
          acknowledged_at: row.acknowledged_at ?? null,
          acknowledged_by_builder_user_id: row.acknowledged_by_builder_user_id ?? null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
      });
    }

    return json({ error: `Unknown operation: ${operation}` }, 400);
  } catch (error) {
    console.error('[builder-portal-stock] unhandled', error);
    return new Response(
      JSON.stringify({ error: 'The stock service is unavailable.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Attach images and the live selection state to a page of items.
 *
 * One query per collection rather than per row: a 100-row stock page must not
 * become 201 round trips.
 */

/** How a property is named to a person, for the record a role assignment writes. */
function stockPropertyLabel(item: Record<string, unknown>): string {
  const parts = [
    item.lot_number ? `Lot ${String(item.lot_number)}` : '',
    String(item.address_line ?? ''),
    String(item.development_name ?? ''),
    String(item.suburb ?? ''),
  ].map((part) => part.trim()).filter(Boolean);
  return parts.join(', ') || 'this property';
}

/**
 * Put properties back in front of the image ladder.
 *
 * The link recovery's rule, in its own words: reopened only where there is
 * something to gain. A property already holding a picture is left alone —
 * except that here the picture may BE the one just supplied, so the sweep is
 * what re-decides the card, not this.
 */
async function reopenImageWork(
  supabase: any,
  organisationId: string,
  stockItemIds: string[],
): Promise<void> {
  if (!stockItemIds.length) return;
  await supabase.from('builder_stock_items').update({
    enrichment_status: 'pending',
    image_work_stage: 'source',
    image_work_claim_until: null,
    image_work_next_attempt_at: new Date().toISOString(),
    image_work_updated_at: new Date().toISOString(),
  }).eq('organisation_id', organisationId).in('id', stockItemIds);
}

async function decorateItems(
  supabase: any,
  items: any[],
  organisationId: string,
): Promise<any[]> {
  if (!items.length) return [];
  /*
   * THE BUILDER'S OWN FIGURES, LAID OVER THE DOCUMENT'S, ONCE AND HERE.
   *
   * Applied to the incoming rows rather than inside the mapper below, so
   * everything downstream — the spread, the eligibility reading, anything
   * added later — sees the effective property rather than the extraction.
   * Both read paths do exactly this, and the "every read path
   * applies the overlay" case in `builderStockManualStats.test.ts` reads both
   * sources and fails either one that stops.
   */
  /*
   * THE PLACE FIRST. `applyManualStats` rewrites `manual_stats` to the five
   * figures, so a stated location read after it would read nothing — and the
   * builder's address would vanish from their own card while still being
   * stored. See `_shared/builderStock/statedLocation.pure.ts`.
   */
  items = applyManualStatsToAll(items.map(applyStatedLocation));
  const ids = items.map((item) => item.id);

  const [{ data: images }, { data: selections }, { data: rows }] = await Promise.all([
    supabase.from('builder_stock_item_images')
      .select(STOCK_IMAGE_SELECT)
      .in('stock_item_id', ids)
      .eq('organisation_id', organisationId)
      .order('position', { ascending: true }),
    supabase.from('builder_stock_selection_announcements')
      .select('id, stock_item_id, status, created_at, acknowledged_at')
      .in('stock_item_id', ids)
      .eq('organisation_id', organisationId)
      .neq('status', 'withdrawn'),
    /*
     * WHY A PROPERTY HAS NO PICTURE, WHERE THE ANSWER IS THE BUILDER'S TO FIX.
     *
     * Read here rather than added to `STOCK_ITEM_SELECT`, because that list is
     * a disclosure boundary and `source_row` is the builder's whole raw row.
     * What leaves this function is a COUNT — how many documents this property's
     * own row attaches — and never an address, so the page can say "your stock
     * list attaches no document to this row" without the row travelling.
     *
     * On the one live source that is thirteen of twenty-six properties, and it
     * is the only reason among them that a person can act on: no reader
     * conjures a document nobody attached, and until this the page said only
     * "No image yet", which reads as something the product is still doing.
     */
    supabase.from('builder_stock_items')
      .select('id, source_row, source_provenance_result')
      .in('id', ids)
      .eq('organisation_id', organisationId),
  ]);

  const imagesByItem = new Map<string, any[]>();
  for (const image of images ?? []) {
    const list = imagesByItem.get(image.stock_item_id) ?? [];
    list.push(image);
    imagesByItem.set(image.stock_item_id, list);
  }
  const selectionsByItem = new Map<string, any[]>();
  for (const selection of selections ?? []) {
    const list = selectionsByItem.get(selection.stock_item_id) ?? [];
    list.push(selection);
    selectionsByItem.set(selection.stock_item_id, list);
  }

  /*
   * What each property's own images say they were extracted from. Read from
   * the images rather than from the row, because that record proves the
   * document was READ.
   */
  const packagesByItem = new Map<string, ReturnType<typeof stockPackageDocuments>>();
  for (const item of items) {
    packagesByItem.set(
      String(item.id),
      stockPackageDocuments(imagesByItem.get(item.id) ?? []),
    );
  }

  /*
   * Counted with `rowSourceBranches` — the same function the image pipeline
   * uses to decide what it will try — so the page cannot say a property has a
   * document the pipeline would not read, or none where it would find five.
   */
  const documentsByItem = new Map<string, number>();
  const unreadByItem = new Map<string, { unprocessed: number; unreachable: number }>();
  const documentProvenanceByItem = new Map<string, unknown>();
  /*
   * The links each row carries NOW, derived exactly as the settler derives
   * its branches — so a confirmation about a link the row no longer has says
   * so, rather than reading "pending" about a brochure nothing will read.
   */
  const linkedByItem = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const unmapped = (row?.source_row as { unmapped?: Record<string, string> } | null)?.unmapped;
    linkedByItem.set(String(row.id), new Set(rowSourceBranches(
      unmappedWithRecoveredLinks(unmapped, row?.source_row as Record<string, unknown> | null))
      .map((branch) => branch.url)));
    documentsByItem.set(
      String(row.id),
      rowSourceBranches(unmapped).filter(isTraversableBranch).length,
    );
    const storedProvenance = (row as { source_provenance_result?: unknown })
      ?.source_provenance_result ?? null;
    unreadByItem.set(String(row.id), unreadDocumentCount(storedProvenance));
    documentProvenanceByItem.set(String(row.id), storedProvenance);
  }

  /*
   * THE BUILDER'S OWN CONFIRMATIONS, AND WHAT BECAME OF EACH.
   *
   * A mismatch the builder has confirmed against is drawn as that
   * confirmation — who made it, what became of it, and the undo — rather than
   * as the mismatch again (`stockDocumentNotes`). A read that failed shows
   * the page as it was before any confirmation: the choice is offered again,
   * and making it again answers with the confirmation that stands.
   */
  const confirmationsRead = await readStandingConfirmations(supabase, {
    organisationId, stockItemIds: ids,
  });
  if (!confirmationsRead.ok) {
    console.warn('[builder-portal-stock] brochure confirmations could not be read', {
      phase: 'brochure_confirmations', detail: confirmationsRead.error,
    });
  }
  const confirmationsByItem = new Map<string, StandingConfirmation[]>();
  for (const row of confirmationsRead.ok ? confirmationsRead.rows : []) {
    const list = confirmationsByItem.get(row.stock_item_id) ?? [];
    list.push(row);
    confirmationsByItem.set(row.stock_item_id, list);
  }
  const confirmationInputs = (itemId: string) => (confirmationsByItem.get(itemId) ?? [])
    .map((row) => ({
      id: row.id, document: row.document_reference, lot: row.confirmed_lot,
      confirmed_by: row.confirmed_by_name, confirmed_at: row.confirmed_at,
    }));
  const notesByItem = new Map<string, ReturnType<typeof stockDocumentNotes>>();
  for (const item of items) {
    notesByItem.set(String(item.id), stockDocumentNotes(
      documentProvenanceByItem.get(String(item.id)) ?? null, MAX_STOCK_DOCUMENT_NOTES,
      { confirmations: confirmationInputs(String(item.id)) }));
  }
  /*
   * AND, FOR EACH MISMATCH, WHETHER ANOTHER LISTING ALREADY USES THAT
   * BROCHURE'S PHOTOGRAPH — read once for the page, from the organisation's
   * own listings, and only where a mismatch exists to ask about.
   */
  const statedLots = [...notesByItem.values()].flat()
    .filter((note) => note.finding === 'identity_mismatch' && note.document_key)
    .map((note) => confirmedLotOf(note.states))
    .filter((lot): lot is string => !!lot);
  const listings = statedLots.length
    ? await readListingsWithLots(supabase, { organisationId, lots: statedLots })
    : [];

  return items.map((item) => ({
    ...item,
    images: imagesByItem.get(item.id) ?? [],
    /*
     * How many builder documents this property's own row attaches. Zero is the
     * one reason for a missing picture that the builder can fix, and it is a
     * count rather than a list because an address is not needed to say so.
     */
    /*
     * AND THE PACKAGE THE STOCK LIST ITSELF WAS, which the count above cannot
     * see: `rowSourceBranches` reads the LINKS a spreadsheet row carries, and
     * a stock list uploaded AS a package PDF carries none — `unmapped` is
     * `{}`. So a property built out of a 10 MB brochure, with that brochure's
     * page-1 rasters in its images table, was told "No brochure on this row".
     * The builder re-uploaded the same file twice; the second upload was
     * byte-identical to the first. See `stockPackageDocuments`.
     *
     * EITHER/OR, NEVER A SUM. Where a row DOES attach links, those links are
     * its documents and the images were extracted from them — so adding the
     * package reading would count the same brochure twice. The package count
     * answers only the case the link count cannot see: a row with no links at
     * all, whose document is the file the whole list arrived as.
     */
    source_documents: (documentsByItem.get(String(item.id)) ?? 0)
      || (packagesByItem.get(String(item.id))?.documents.length ?? 0),
    /*
     * And how many we could not read, split by WHOSE failure it was. Counts,
     * never reasons — see `unreadDocumentCount`: the mechanism stays on this
     * side. They are two fields because they lead to two different sentences,
     * and one of those sentences asks the builder to go and check something.
     */
    source_documents_unprocessed:
      unreadByItem.get(String(item.id))?.unprocessed ?? 0,
    source_documents_unreachable:
      unreadByItem.get(String(item.id))?.unreachable ?? 0,
    /*
     * AND WHAT THE DOCUMENTS WE DID READ ACTUALLY SAID.
     *
     * The counts above are deliberately reasonless because they cover OUR
     * failures. These are the opposite case: an `inspected` refusal is a
     * finding about the builder's own document, recorded with a `detail` that
     * `negativeProvenance.pure.ts` has always marked safe to surface — and
     * which no screen has ever shown. Without it, a brochure for the wrong
     * property is indistinguishable from a brochure with no photograph, and
     * the one person who can correct the sheet is told nothing.
     *
     * `stockDocumentNotes` is the gate: `operational` reasons never leave
     * this side.
     */
    source_document_notes: [
      ...withConfirmationChoices(notesByItem.get(String(item.id)) ?? [], {
        stockItemId: String(item.id),
        suburb: item.suburb,
        developmentName: item.development_name,
        listings,
      }),
      /*
       * The same finding for an uploaded package. It is recorded in a
       * different place — `selection_reason` on the image rows rather than a
       * branch record — because nothing fetched a link, and reading only the
       * branches is why the one row that needed this sentence never got it.
       */
      ...(packagesByItem.get(String(item.id))?.notes ?? []),
    ].slice(0, MAX_STOCK_DOCUMENT_NOTES),
    /*
     * The brochures the builder confirmed are theirs, each with who confirmed
     * it and what became of it. See `brochureConfirmationViews`.
     */
    brochure_confirmations: brochureConfirmationViews(
      documentProvenanceByItem.get(String(item.id)) ?? null,
      confirmationInputs(String(item.id)),
      { linkedDocuments: linkedByItem.get(String(item.id)) ?? null }),
    // The builder's activation signal: how many workspace selection
    // announcements this property carries, and where the most recent one is
    // up to. `announced_at` is the announcement row's created_at — when the
    // network learned of the selection.
    selection_count: (selectionsByItem.get(item.id) ?? []).length,
    latest_selection: (selectionsByItem.get(item.id) ?? [])
      .map((row: any) => ({
        id: row.id, status: row.status,
        announced_at: row.created_at, acknowledged_at: row.acknowledged_at ?? null,
      }))
      .sort((a, b) => String(b.announced_at).localeCompare(String(a.announced_at)))[0] ?? null,
  }));
}
