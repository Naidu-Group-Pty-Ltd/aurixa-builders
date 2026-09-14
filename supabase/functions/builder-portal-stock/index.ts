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
 *   image_url
 *   list_selections | acknowledge_selection
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import {
  stockDocumentNotes, unreadDocumentCount,
  stockPackageDocuments, MAX_STOCK_DOCUMENT_NOTES,
} from '../_shared/builderStock/imageProgress.pure.ts';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
  builderCan,
  logBuilderProjectActivity,
} from '../_shared/builderPortalAuth.ts';
import { detectDocumentMime } from '../_shared/immutableDocuments.ts';
import {
  MAX_STOCK_FILE_BYTES, STOCK_LIST_BUCKET, STOCK_IMAGE_BUCKET,
  STOCK_LIST_STORAGE_PREFIX, STOCK_ALLOWED_DECLARED_MIME,
  classifyFetchedSource, classifyStockFile, isAcceptableStockStoragePath, safeObjectName,
} from '../_shared/builderStock/fileTypes.pure.ts';
import {
  runStockImport, type RunImportResult,
} from '../_shared/builderStock/runImport.ts';
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
import {
  isTraversableBranch, rowSourceBranches,
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
import { PROCESSED_LIFECYCLE } from '../_shared/builderStock/stockLifecycle.pure.ts';
import { sha256Hex } from '../_shared/builderStock/rasterPng.ts';
import { consumeRateLimit } from '../_shared/requestSecurity.ts';
import { fetchStockSource, SourceFetchError } from '../_shared/builderStock/fetchSource.ts';
import type { HyperlinkAvailability } from '../_shared/builderStock/sheetHyperlinks.pure.ts';
import {
  linkDiscoveryFromAvailability,
} from '../_shared/builderStock/suppliedEvidence.pure.ts';
import {
  NOTION_NOT_PUBLIC_MESSAGE, normaliseStockSourceUrl, snapshotFileName,
  stockSourceDisplayName,
} from '../_shared/builderStock/urlSource.pure.ts';
import {
  assessNotionReadability, extractHtmlTitle, extractNotionGridTables, readHtmlSource,
} from '../_shared/builderStock/htmlSource.pure.ts';
import {
  recoverNotionPublicContent, type NotionRecovery,
} from '../_shared/builderStock/notionPublicContent.ts';
import {
  itemsToArchiveOnSourceDelete,
} from '../_shared/builderStock/sourceDeletion.pure.ts';
import {
  enrichStockItem, type EnrichableStockItem,
} from '../_shared/builderStock/images.ts';
import type { AnchoredAssets } from '../_shared/builderStock/sourceAssets.pure.ts';
import { repairSourceImagesForUpload } from '../_shared/builderStock/repairSourceImages.ts';
import { settleMarketplaceEligibility } from '../_shared/builderStock/settleMarketplaceEligibility.ts';
import { enforceStrictPrimaryImages } from '../_shared/builderStock/primaryImage.ts';
import {
  settleUploadSourceImages, uploadsNeedingSettlement,
} from '../_shared/builderStock/settleSourceImages.ts';
import { newRepairBudget } from '../_shared/builderStock/settleImageSanitization.ts';
import { readAllRows } from '../_shared/builderStock/pagedRead.ts';
import {
  BUILDER_SELECTION_SELECT, STOCK_AVAILABILITY_STATUSES, STOCK_IMAGE_SELECT,
  STOCK_ITEM_SELECT, STOCK_UPLOAD_SELECT, stockPagination,
} from '../_shared/builderStock/projection.pure.ts';
import { applyManualStatsToAll, parseManualStats } from '../_shared/builderStock/manualStats.pure.ts';

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

/**
 * The host of a URL, for diagnostics. The HOST and never the URL: a link a
 * builder pasted can carry a token or a signature in its query string, and a
 * log line is the wrong place for either.
 */
function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
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

    const body = await req.json().catch(() => ({} as Record<string, any>));
    const operation = String(body.operation || '');

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
      }).eq('id', uploadId).eq('organisation_id', activeOrganisationId);
    };

    /**
     * Record a failure on the source and answer the builder.
     *
     * `error_detail` is the internal diagnosis and is written to the row but
     * never returned — `get_upload` projects it away.
     */
    const failUpload = async (
      uploadId: string, code: string, message: string, detail?: unknown,
    ) => {
      await supabase.from('builder_stock_uploads').update({
        status: 'failed',
        error_code: code,
        error_message: message,
        error_detail: detail ? { detail: String(detail).slice(0, 2000) } : null,
        processing_completed_at: new Date().toISOString(),
      }).eq('id', uploadId).eq('organisation_id', activeOrganisationId);
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
    ) => {
      if (!result.ok) {
        if (result.code === 'duplicate_file') {
          await supabase.from('builder_stock_uploads').update({
            status: 'failed',
            error_code: result.code,
            error_message: result.message,
            processing_completed_at: new Date().toISOString(),
          }).eq('id', uploadId).eq('organisation_id', activeOrganisationId);
          return json({
            success: false, error: result.message, code: result.code,
            duplicate_upload_id: result.duplicateUploadId,
          }, result.status);
        }
        return await failUpload(uploadId, result.code, result.message, result.detail);
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
      const { data: updated } = await supabase.from('builder_stock_uploads').update({
        status: result.uploadStatus,
        records_detected: result.summary.detected,
        records_imported: result.summary.imported,
        records_updated: result.summary.updated,
        records_failed: result.summary.failed,
        error_code: result.summary.failures.length ? null : (sourceNotice?.code ?? null),
        error_detail: result.summary.failures.length
          ? { failures: result.summary.failures }
          : (sourceNotice ? sourceNotice.detail : null),
        error_message: result.summary.failures.length
          ? `${result.summary.failed} row(s) could not be saved.`
          : (sourceNotice?.message ?? null),
        processing_completed_at: new Date().toISOString(),
      }).eq('id', uploadId).eq('organisation_id', activeOrganisationId)
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
        });
        return await finishImport(upload.id, result, {});
      } catch (error) {
        console.error('[builder-portal-stock] processing failed', error);
        return await failUpload(upload.id, 'processing_failed',
          'That file could not be processed. Please check the format and try again.',
          (error as { message?: string })?.message);
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
        // `attachBuilderImage` requeues the property itself — see its header.
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

      await markParsing(upload.id);

      try {
        const { data: blob, error: downloadError } = await supabase.storage
          .from(upload.storage_bucket).download(upload.storage_path);
        if (downloadError || !blob) {
          return await failUpload(upload.id, 'file_missing',
            'The stored file could not be read, so it cannot be re-read.', downloadError?.message);
        }

        /*
         * A RE-READ RUNS ON THE STORED BYTES, so what it can see of a Google
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
        });
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

      const normalised = normaliseStockSourceUrl(body.url);
      if (!normalised.ok) {
        return json({ error: normalised.reason, code: normalised.code }, 400);
      }

      // Fetch BEFORE creating the row: a URL that cannot be read should not
      // leave a failed source in the builder's history for every typo.
      let fetched;
      try {
        fetched = await fetchStockSource(normalised.url);
      } catch (error) {
        if (error instanceof SourceFetchError) {
          // A Notion page that refuses us is a permission problem the builder
          // can fix, and deserves the wording that says so.
          const message = normalised.isNotion
            && ['source_forbidden', 'source_not_found'].includes(error.code)
            ? NOTION_NOT_PUBLIC_MESSAGE
            : error.safeMessage;
          return json({ error: message, code: error.code }, 400);
        }
        console.error('[builder-portal-stock] url fetch failed', error);
        return json({ error: 'That address could not be read.', code: 'source_unreachable' }, 400);
      }

      const head = new TextDecoder('utf-8', { fatal: false })
        .decode(fetched.bytes.subarray(0, 1024)).trimStart().toLowerCase();
      const looksLikeHtml = head.startsWith('<!doctype html') || head.startsWith('<html')
        || head.startsWith('<?xml') && head.includes('xhtml');

      const detection = detectDocumentMime(fetched.bytes);
      let classification = classifyFetchedSource({
        detectedMime: detection.mime,
        detectionReason: detection.reason,
        declaredContentType: fetched.declaredContentType,
        finalUrl: fetched.finalUrl,
        looksLikeHtml,
      });
      if (classification.kind === 'unsupported') {
        // A content type we cannot read is a statement about the CONTENT. It
        // used to answer "this Notion page is not publicly accessible", which
        // is a claim about sharing settings that nothing here has evidence for.
        return json({
          error: classification.reason ?? 'That address did not return a stock list we can read.',
          code: 'unsupported_source',
        }, 400);
      }

      // A page title makes the history row readable; it is only available for
      // markup, and `stockSourceDisplayName` falls back to a shortened URL.
      let pageTitle = classification.kind === 'markup'
        ? extractHtmlTitle(new TextDecoder('utf-8', { fatal: false }).decode(fetched.bytes))
        : null;

      /**
       * What actually gets snapshotted and imported.
       *
       * For every source but one these ARE the fetched bytes. The exception is
       * a published Notion page, whose HTML is a rendering shell that contains
       * none of the page — see below.
       */
      let importBytes = fetched.bytes;
      let snapshotContentType = fetched.declaredContentType || 'application/octet-stream';
      let notionDiagnostics: Record<string, unknown> | null = null;
      /**
       * The imagery the Notion page tied to its own rows.
       *
       * It cannot travel in the CSV — a cover is a file reference, not a cell
       * — so it is carried beside it, keyed by the anchor the CSV does carry.
       */
      let sourceRowAssets: AnchoredAssets[] = [];

      // =================================================================
      // Public Notion pages
      //
      // ACCESSIBILITY AND EXTRACTION ARE SEPARATE QUESTIONS, and conflating
      // them is what made this path tell builders their published stock list
      // was private. Accessibility is settled here, from evidence: the HTTP
      // status (already handled above), an explicit access-gate marker in the
      // markup, or a 401/403 from Notion's own endpoints. Nothing else may
      // produce `notion_not_public`.
      // =================================================================
      if (normalised.isNotion && classification.kind === 'markup') {
        const html = new TextDecoder('utf-8', { fatal: false }).decode(fetched.bytes);
        const page = readHtmlSource(html, fetched.finalUrl);
        const readability = assessNotionReadability(html, page.text);

        if (readability.gated) {
          // Evidence: the page itself said we may not read it.
          console.warn('[builder-portal-stock] notion access gate', {
            source_host: normalised.host,
            final_host: hostOf(fetched.finalUrl),
            http_status: fetched.status,
            content_type: fetched.declaredContentType || null,
            byte_length: fetched.bytes.length,
            page_title: pageTitle,
            gate_marker: readability.marker,
          });
          return json({ error: NOTION_NOT_PUBLIC_MESSAGE, code: 'notion_not_public' }, 400);
        }

        // No gate, and the shell carried no table. Recover the page's own
        // content from Notion's public, unauthenticated endpoints.
        if (!page.tables.length) {
          let recovery: NotionRecovery | null = null;
          try {
            recovery = await recoverNotionPublicContent(fetched.finalUrl, html);
          } catch (error) {
            // A recovery that throws is a retrieval fault, never a permission
            // finding. The import continues on the shell and reports whatever
            // the pipeline makes of it.
            console.error('[builder-portal-stock] notion recovery failed', {
              source_host: normalised.host,
              message: String((error as { message?: string })?.message ?? error),
            });
          }

          notionDiagnostics = {
            source_host: normalised.host,
            final_host: hostOf(fetched.finalUrl),
            http_status: fetched.status,
            content_type: fetched.declaredContentType || null,
            byte_length: fetched.bytes.length,
            page_title: pageTitle,
            html_tables: page.tables.length,
            notion_grids: extractNotionGridTables(html).length,
            readable_text_chars: readability.textLength,
            access_gate_marker: readability.marker,
            client_rendered_shell: readability.clientRendered,
            recovery_ok: recovery?.ok ?? false,
            recovery_reason: recovery && !recovery.ok ? recovery.reason : null,
            ...(recovery?.diagnostics ?? {}),
          };

          if (recovery && !recovery.ok && recovery.reason === 'access_denied') {
            console.warn('[builder-portal-stock] notion access denied', notionDiagnostics);
            return json({ error: NOTION_NOT_PUBLIC_MESSAGE, code: 'notion_not_public' }, 400);
          }

          /*
           * THE LINKED VIEW DECIDES WHICH PROPERTIES THIS LIST HOLDS, so a
           * link naming a view the page does not have is refused rather than
           * answered from something else. Falling through here would import
           * the page shell — a different set of properties — and replace the
           * builder's stock with it.
           */
          if (recovery && !recovery.ok && recovery.reason === 'requested_view_missing') {
            console.warn('[builder-portal-stock] notion view not found', notionDiagnostics);
            return json({
              error: 'That link names a view this Notion page does not have. Open the '
                + 'view you want to import and copy the address from your browser.',
              code: 'notion_view_not_found',
            }, 400);
          }

          if (recovery?.ok) {
            // The recovered content REPLACES the shell as the snapshot, so the
            // stored object is what was actually imported rather than a page
            // of script tags. A table becomes CSV and goes through the
            // delimited reader; prose stays markup for the model-assisted path.
            if (recovery.matrix) {
              importBytes = new TextEncoder().encode(recovery.csv);
              classification = { kind: 'delimited', extension: 'csv' };
              snapshotContentType = 'text/csv';
              sourceRowAssets = recovery.assets;
            } else {
              importBytes = new TextEncoder().encode(recovery.text);
              classification = { kind: 'delimited', extension: 'txt' };
              snapshotContentType = 'text/plain';
            }
            pageTitle = recovery.title ?? pageTitle;
          }
        }
      }

      const displayName = stockSourceDisplayName(fetched.finalUrl, pageTitle);
      const objectName = safeObjectName(snapshotFileName(fetched.finalUrl, classification.extension));

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
          declared_content_type: fetched.declaredContentType || null,
          detected_content_type: detection.mime,
          snapshot_content_type: snapshotContentType,
          classified_as: classification.kind,
          byte_length: importBytes.length,
          source_host: normalised.host,
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
          source_url: normalised.url,
          final_url: fetched.finalUrl,
          source_title: displayName,
          retrieved_at: new Date().toISOString(),
          original_filename: objectName,
          declared_content_type: fetched.declaredContentType || null,
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
        metadata: { host: normalised.host, notion: normalised.isNotion },
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
          isNotionSource: normalised.isNotion,
          baseUrl: fetched.finalUrl,
          rowAssets: sourceRowAssets,
          /*
           * A Google Sheet's link targets travel SEPARATELY from its proven
           * CSV, so the fetch's own reading of how that went is stamped onto
           * every row this import writes. `null` for every other kind of URL —
           * their links are native to the fetched bytes, and `runStockImport`
           * stamps them from the strategy that read them.
           */
          linkDiscovery: linkDiscoveryFromAvailability(
            fetched.hyperlinks, fetched.hyperlinkMethod),
        });

        /**
         * A Notion source that produced nothing is the case this whole path
         * used to get wrong, so it is the case that gets the full record.
         * Server-side only, and note what is absent: no URL (a link can carry
         * a token in its query string), no cookie, no header, no key. The HOST
         * identifies the provider and nothing here identifies a credential.
         */
        if (notionDiagnostics && (!result.ok || result.summary.detected === 0)) {
          console.warn('[builder-portal-stock] notion produced no stock', {
            ...notionDiagnostics,
            parse_strategy: result.ok ? result.strategy : null,
            rows_detected: result.ok ? result.summary.detected : 0,
            failure_code: result.ok ? null : result.code,
          });
        }

        return await finishImport(uploadId, result, {
          strategy_source: 'url',
          ...(notionDiagnostics ? { notion_recovery: notionDiagnostics.recovery_ok } : {}),
          ...(fetched.hyperlinks ? { source_hyperlinks: fetched.hyperlinks } : {}),
        }, fetched.hyperlinks, normalised.url);
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
      let query = supabase
        .from('builder_stock_items')
        .select('id, organisation_id, address_line, suburb, state, postcode, development_name, project_name, lot_number, unit_number')
        .eq('organisation_id', activeOrganisationId)
        .eq('lifecycle_status', 'active')
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

      let remainingQuery = supabase
        .from('builder_stock_items')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', activeOrganisationId)
        .eq('lifecycle_status', 'active')
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

      let query = supabase
        .from('builder_stock_items')
        .select(STOCK_ITEM_SELECT, { count: 'exact' })
        .eq('organisation_id', activeOrganisationId)
        .eq('lifecycle_status', cleanText(body.lifecycle_status, 20) || 'active');
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

      return json({
        success: true,
        records: decorated,
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
      const imageId = cleanText(body.image_id, 64);
      const { data: image } = await supabase
        .from('builder_stock_item_images')
        .select('id, storage_bucket, storage_path, external_url, organisation_id')
        .eq('id', imageId)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      if (!image) return notFoundHere('That image');
      if (image.external_url && !image.storage_path) {
        return json({ success: true, url: image.external_url, external: true });
      }
      const { data: signed, error } = await supabase.storage
        .from(image.storage_bucket || STOCK_IMAGE_BUCKET)
        .createSignedUrl(image.storage_path, IMAGE_URL_TTL_SECONDS);
      if (error || !signed?.signedUrl) return json({ error: 'The image could not be prepared' }, 502);
      return json({ success: true, url: signed.signedUrl, expires_in: IMAGE_URL_TTL_SECONDS });
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
     */
    if (operation === 'set_manual_stats') {
      if (!await can('edit')) {
        return json({ error: 'You do not have permission to manage stock', code: 'permission_denied' }, 403);
      }
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return notFoundHere('That property');

      const { stats, errors } = parseManualStats(body.stats, {
        recordedAt: new Date().toISOString(),
        recordedBy: me.id,
      });
      /*
       * REFUSED, NEVER CLAMPED. Turning a mistyped 3000 into 99 records a
       * bedroom count nobody stated, on a card a client reads — the same
       * class as a fabricated price, which is the one thing the extraction
       * prompt's first rule exists to prevent.
       */
      if (errors.length) {
        return json({ error: errors[0].message, code: 'invalid_stat', fields: errors }, 400);
      }

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
          },
        },
        newState: { manual_stats: stats },
      });

      const [decorated] = await decorateItems(supabase, [data], activeOrganisationId);
      return json({ success: true, record: decorated });
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

      // Counted, never touched. A selection an adviser already made for a
      // buyer survives the builder tidying up their sources.
      let affectedSelections = 0;
      if (archiveIds.length) {
        const { count } = await supabase
          .from('builder_stock_selections')
          .select('id', { count: 'exact', head: true })
          .eq('organisation_id', activeOrganisationId)
          .in('stock_item_id', archiveIds)
          .neq('status', 'withdrawn');
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
      const { data, count } = await supabase
        .from('builder_stock_selections')
        // BUILDER_SELECTION_SELECT omits client_id, selected_by_user_id and
        // internal_notes. The builder learns THAT one of their properties was
        // selected, never who by or for whom.
        .select(BUILDER_SELECTION_SELECT, { count: 'exact' })
        .eq('organisation_id', activeOrganisationId)
        .order('selected_at', { ascending: false })
        .range(from, to);

      const selections = data ?? [];
      const itemIds = Array.from(new Set(selections.map((row: any) => row.stock_item_id)));
      const { data: items } = itemIds.length
        ? await supabase.from('builder_stock_items')
          .select('id, address_line, suburb, state, development_name, project_name, lot_number, unit_number, external_reference, price, availability_status')
          .eq('organisation_id', activeOrganisationId)
          .in('id', itemIds)
        : { data: [] };
      const itemById = new Map((items ?? []).map((item: any) => [item.id, item]));

      return json({
        success: true,
        records: selections.map((row: any) => ({
          ...row,
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
      const { data: selection } = await supabase
        .from('builder_stock_selections')
        .select('id, status, organisation_id, stock_item_id')
        .eq('id', selectionId)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      if (!selection) return notFoundHere('That selection');
      if (selection.status !== 'selected') {
        return json({ error: 'This selection has already moved on.', code: 'not_acknowledgeable' }, 409);
      }

      const { data, error } = await supabase
        .from('builder_stock_selections')
        .update({
          status: 'builder_acknowledged',
          acknowledged_at: new Date().toISOString(),
          acknowledged_by_builder_user_id: me.id,
        })
        .eq('id', selection.id)
        .eq('organisation_id', activeOrganisationId)
        .select(BUILDER_SELECTION_SELECT)
        .single();
      if (error) return json({ error: 'The selection could not be updated' }, 400);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_stock_selection_acknowledged',
        entityType: 'stock_selection', entityId: selection.id,
      });
      return json({ success: true, record: data });
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
  items = applyManualStatsToAll(items);
  const ids = items.map((item) => item.id);

  const [{ data: images }, { data: selections }, { data: rows }] = await Promise.all([
    supabase.from('builder_stock_item_images')
      .select(STOCK_IMAGE_SELECT)
      .in('stock_item_id', ids)
      .eq('organisation_id', organisationId)
      .order('position', { ascending: true }),
    supabase.from('builder_stock_selections')
      .select('id, stock_item_id, status, selected_at, acknowledged_at')
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
  for (const row of rows ?? []) {
    const unmapped = (row?.source_row as { unmapped?: Record<string, string> } | null)?.unmapped;
    documentsByItem.set(
      String(row.id),
      rowSourceBranches(unmapped).filter(isTraversableBranch).length,
    );
    const storedProvenance = (row as { source_provenance_result?: unknown })
      ?.source_provenance_result ?? null;
    unreadByItem.set(String(row.id), unreadDocumentCount(storedProvenance));
    documentProvenanceByItem.set(String(row.id), storedProvenance);
  }

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
      ...stockDocumentNotes(documentProvenanceByItem.get(String(item.id)) ?? null),
      /*
       * The same finding for an uploaded package. It is recorded in a
       * different place — `selection_reason` on the image rows rather than a
       * branch record — because nothing fetched a link, and reading only the
       * branches is why the one row that needed this sentence never got it.
       */
      ...(packagesByItem.get(String(item.id))?.notes ?? []),
    ].slice(0, MAX_STOCK_DOCUMENT_NOTES),
    // The builder's activation signal: how many Command Centre selections this
    // property has, and where the most recent one is up to.
    selection_count: (selectionsByItem.get(item.id) ?? []).length,
    latest_selection: (selectionsByItem.get(item.id) ?? [])
      .sort((a, b) => String(b.selected_at).localeCompare(String(a.selected_at)))[0] ?? null,
  }));
}
