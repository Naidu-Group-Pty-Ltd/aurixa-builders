/**
 * FETCHING A LINKED STOCK LIST — ONCE, FOR BOTH THE PEOPLE WHO NEED IT.
 *
 * ## The defect this exists for
 *
 * A stock list added by LINK is snapshotted at the moment it is imported, and
 * "Read again" re-runs the parsers over that snapshot. That is right for a
 * FILE — the builder's file is the file, and re-reading it is how a parser
 * correction reaches rows that already exist. For a LINK it is the opposite of
 * what the builder asked for: they linked their sheet precisely BECAUSE they
 * keep editing it, and re-reading yesterday's copy of it reports "47 updated"
 * over an import that changed nothing.
 *
 * So there was no way to import a changed sheet, and the only route that
 * worked was to DELETE the source and add it again — which archives every
 * property the source supplies and takes the builder's whole catalogue off the
 * Command Centre marketplace until the new list republishes.
 *
 * Measured on Mairandi Developers, 18–19 September 2026. Three deletes, each
 * stamped `archived: 47`, each followed within 25 seconds by the SAME
 * docs.google.com address being added back:
 *
 * ```
 * 18 Sep 09:41:29  builder_stock_source_deleted   archived: 47
 * 18 Sep 09:41:46  builder_stock_url_source_added docs.google.com
 * 19 Sep 08:39:36  builder_stock_source_deleted   archived: 47
 * 19 Sep 08:40:01  builder_stock_url_source_added docs.google.com
 * 19 Sep 09:23:44  builder_stock_source_deleted   archived: 47   ← not re-added
 * ```
 *
 * Delete-then-immediately-re-add-the-same-address is nobody removing stock. It
 * is a builder re-importing, through the only door that worked. The third one
 * left 47 live properties archived and the marketplace empty.
 *
 * `reprocess_upload`'s own comment had already condemned exactly this — "the
 * only route was to DELETE the source and upload it again, which discards the
 * audit trail and every selection made against those properties" — and closed
 * it for files. A link is the case where the source genuinely changes, and it
 * was the half left open.
 *
 * ## Why this module exists rather than a second fetch
 *
 * Reaching a linked source is not one call. It is normalisation, a fetch that
 * distinguishes five refusals, MIME detection against the declared type, a
 * classification, the Notion public-content recovery with its own access-gate
 * and missing-view findings, and the naming of the snapshot. Two copies of
 * that is how the re-fetch comes to read a Notion page differently from the
 * import — so there is ONE, and `import_url` and `reprocess_upload` differ
 * only in what they do with the answer: create a row, or re-fill one.
 *
 * ## The rules
 *
 * **A fetch that failed is never laundered into a re-read of the stale copy.**
 * Every refusal below is returned as a refusal with its own code, and the
 * caller leaves the source exactly as it was. A builder whose sheet has been
 * unshared must be told that, not handed yesterday's rows a second time under
 * the word "updated".
 *
 * **What it refuses, it refuses for the same reason at both call sites** —
 * an unreadable content type, a Notion page behind an access gate, a link
 * naming a view the page does not have. A re-fetch cannot be more permissive
 * than the first import, because the rows it writes replace the ones that are
 * live.
 *
 * **Nothing here writes.** It fetches and prepares; storage and the row are
 * the caller's, because creating a source and re-filling one are genuinely
 * different acts and hiding that difference in here is how one of them
 * silently starts doing the other.
 */
import { detectDocumentMime } from '../immutableDocuments.ts';
import {
  classifyFetchedSource, safeObjectName,
} from './fileTypes.pure.ts';
import {
  fetchStockSource, SourceFetchError, type FetchedSource,
} from './fetchSource.ts';
import { sourceDocumentName } from './documentName.pure.ts';
import {
  NOTION_NOT_PUBLIC_MESSAGE, normaliseStockSourceUrl, snapshotFileName,
  stockSourceDisplayName,
} from './urlSource.pure.ts';
import {
  assessNotionReadability, extractHtmlTitle, extractNotionGridTables, readHtmlSource,
} from './htmlSource.pure.ts';
import {
  recoverNotionPublicContent, type NotionRecovery,
} from './notionPublicContent.ts';
import type { AnchoredAssets } from './sourceAssets.pure.ts';

/** A refusal carries the status and code the caller answers with, unchanged. */
export interface LinkedSourceRefusal {
  ok: false;
  status: number;
  error: string;
  code: string;
}

/** Everything a caller needs to snapshot the source and run the import. */
export interface PreparedLinkedSource {
  ok: true;
  /** The normalised address, which is what is stored as `source_url`. */
  url: string;
  host: string;
  isNotion: boolean;
  /** Where the fetch actually landed, after redirects. */
  finalUrl: string;
  declaredContentType: string | null;
  /** The bytes to snapshot AND import — the same bytes, always. */
  importBytes: Uint8Array;
  snapshotContentType: string;
  classification: ReturnType<typeof classifyFetchedSource>;
  /** A readable name for the history row, and the object's own name. */
  displayName: string;
  objectName: string;
  /**
   * WHAT THE DOCUMENT IS CALLED, or null where nothing named it.
   *
   * Deliberately NOT `displayName`, which is host + ellipsis + segment and is
   * built to be legible in a list. The deterministic reader treats a name as
   * evidence, so a display label reaching it lets a HOSTNAME corroborate a
   * property field. See `documentName.pure.ts`.
   */
  documentName: string | null;
  rowAssets: AnchoredAssets[];
  /** Only present where a Notion source produced nothing worth importing. */
  notionDiagnostics: Record<string, unknown> | null;
  /** Passed through to the import, which stamps them on every row it writes. */
  hyperlinks: FetchedSource['hyperlinks'];
  hyperlinkMethod: FetchedSource['hyperlinkMethod'];
  sheetTab: FetchedSource['sheetTab'] | null;
}

export type LinkedSourceOutcome = PreparedLinkedSource | LinkedSourceRefusal;

/**
 * Fetch a linked stock list and prepare it for import.
 *
 * Moved here verbatim from `builder-portal-stock`'s `import_url`, which is why
 * every finding below keeps its original wording and status: the point of the
 * extraction is that the two callers cannot diverge, so nothing about what a
 * first import accepts may change on the way in.
 */
export async function prepareLinkedStockSource(
  rawUrl: unknown,
): Promise<LinkedSourceOutcome> {
  const normalised = normaliseStockSourceUrl(rawUrl);
  if (!normalised.ok) {
    return { ok: false, status: 400, error: normalised.reason, code: normalised.code };
  }

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
      return { ok: false, status: 400, error: message, code: error.code };
    }
    console.error('[linkedSource] url fetch failed', error);
    return {
      ok: false, status: 400,
      error: 'That address could not be read.', code: 'source_unreachable',
    };
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
    return {
      ok: false, status: 400,
      error: classification.reason ?? 'That address did not return a stock list we can read.',
      code: 'unsupported_source',
    };
  }

  // A page title makes the history row readable; it is only available for
  // markup, and `stockSourceDisplayName` falls back to a shortened URL.
  let pageTitle = classification.kind === 'markup'
    ? extractHtmlTitle(new TextDecoder('utf-8', { fatal: false }).decode(fetched.bytes))
    : null;

  let importBytes = fetched.bytes;
  let snapshotContentType = fetched.declaredContentType || 'application/octet-stream';
  let notionDiagnostics: Record<string, unknown> | null = null;
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
      console.warn('[linkedSource] notion access gate', {
        source_host: normalised.host,
        http_status: fetched.status,
        content_type: fetched.declaredContentType || null,
        byte_length: fetched.bytes.length,
        page_title: pageTitle,
        gate_marker: readability.marker,
      });
      return {
        ok: false, status: 400,
        error: NOTION_NOT_PUBLIC_MESSAGE, code: 'notion_not_public',
      };
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
        console.error('[linkedSource] notion recovery failed', {
          source_host: normalised.host,
          message: String((error as { message?: string })?.message ?? error),
        });
      }

      notionDiagnostics = {
        source_host: normalised.host,
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
        console.warn('[linkedSource] notion access denied', notionDiagnostics);
        return {
          ok: false, status: 400,
          error: NOTION_NOT_PUBLIC_MESSAGE, code: 'notion_not_public',
        };
      }

      /*
       * THE LINKED VIEW DECIDES WHICH PROPERTIES THIS LIST HOLDS, so a
       * link naming a view the page does not have is refused rather than
       * answered from something else. Falling through here would import
       * the page shell — a different set of properties — and replace the
       * builder's stock with it.
       */
      if (recovery && !recovery.ok && recovery.reason === 'requested_view_missing') {
        console.warn('[linkedSource] notion view not found', notionDiagnostics);
        return {
          ok: false, status: 400,
          error: 'That link names a view this Notion page does not have. Open the '
            + 'view you want to import and copy the address from your browser.',
          code: 'notion_view_not_found',
        };
      }

      if (recovery?.ok) {
        // The recovered content REPLACES the shell as the snapshot, so the
        // stored object is what was actually imported rather than a page
        // of script tags.
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
  const documentName = sourceDocumentName({
    finalUrl: fetched.finalUrl,
    contentDisposition: fetched.contentDisposition,
  });

  return {
    ok: true,
    url: normalised.url,
    host: normalised.host,
    isNotion: normalised.isNotion,
    finalUrl: fetched.finalUrl,
    declaredContentType: fetched.declaredContentType || null,
    importBytes,
    snapshotContentType,
    classification,
    displayName,
    objectName,
    documentName,
    rowAssets: sourceRowAssets,
    notionDiagnostics,
    hyperlinks: fetched.hyperlinks,
    hyperlinkMethod: fetched.hyperlinkMethod,
    sheetTab: fetched.sheetTab ?? null,
  };
}
