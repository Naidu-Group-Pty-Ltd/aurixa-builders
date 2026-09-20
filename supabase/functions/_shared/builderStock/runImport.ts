/**
 * Builder stock lists — the one import pipeline.
 *
 * Bytes in, stock items out. A file the builder uploaded and a document the
 * server fetched from a URL both arrive here, and everything after this point
 * is identical for both: the same duplicate guard, the same detection, the
 * same extraction, the same model fallback under the same "never invent a
 * value" schema, the same `importStockRecords`, the same statuses on the same
 * audit row.
 *
 * This module exists so that sentence stays true. Before URL sources the
 * pipeline lived inline in `process_upload`; a second copy for URLs is exactly
 * how two import paths start behaving differently.
 */
import { detectDocumentMime, sha256Hex } from '../immutableDocuments.ts';
import { classifyStockFile, MAX_STOCK_FILE_BYTES } from './fileTypes.pure.ts';
import type { StockFileClassification } from './fileTypes.pure.ts';
import { extractStockFile, StockExtractionError } from './extract.ts';
import { extractStockRowsFromImages, extractStockRowsFromText } from './modelExtract.ts';
import { StockModelExtractionError, modelFailureFromRouterError } from './modelExtractionFailure.pure.ts';
import { assistedReaderFailure, SOURCE_HAS_COLUMNS } from './assistedReaderFailure.pure.ts';
import { createAiBudget } from './aiBudget.ts';
import type { RowLinkDiscovery } from './suppliedEvidence.pure.ts';
import { importStockRecords } from './importStock.ts';
import { NOTION_NO_PROPERTIES_MESSAGE } from './urlSource.pure.ts';
import type { AnchoredAssets } from './sourceAssets.pure.ts';
import { TELEMETRY_PREFIX, uploadTelemetry } from './importTelemetry.pure.ts';

/** Wall clock allowed to the model, leaving room for the import itself. */
const MODEL_BUDGET_MS = 90_000;

export interface RunImportInput {
  supabase: any;
  organisationId: string;
  organisationName: string | null;
  builderUserId: string;
  upload: { id: string; original_filename: string };
  bytes: Uint8Array;
  /**
   * Pre-decided reading strategy. URL sources classify from the response as
   * well as the bytes; a file classifies from its name and its bytes, which is
   * what this module does when the caller passes nothing.
   */
  classification?: StockFileClassification;
  /** Shapes the "nothing readable" message. */
  sourceKind?: 'file' | 'url';
  /**
   * Shapes the "nothing readable" message, and NOTHING ELSE. This flag must
   * never be allowed to imply anything about whether the page could be read —
   * see the note in the zero-row branch below.
   */
  isNotionSource?: boolean;
  /**
   * The address the document was fetched from, when there was one. Used to
   * resolve a relative `<img src>` against the page that published it — a
   * source-supplied photograph is usually linked relatively, and resolving it
   * against a placeholder is how it stopped being fetchable.
   */
  baseUrl?: string;
  /**
   * Imagery the SOURCE tied to one of its own rows, keyed by the anchor those
   * rows carry. Supplied by callers that read a source this module cannot
   * re-read — a Notion collection, whose covers live in the record map rather
   * than in the CSV it becomes.
   */
  rowAssets?: AnchoredAssets[];
  /**
   * What the FETCH managed to see of the source's link layer, for a source
   * whose links live outside the bytes handed over — a Google Sheet, whose
   * proven CSV carries labels while the targets travel separately. Absent for
   * a source whose links are native to its own bytes; this module then stamps
   * the rows from the reading strategy instead. See `RowLinkDiscovery`.
   */
  linkDiscovery?: RowLinkDiscovery | null;
  /**
   * WHICH WORKSHEET THE FETCH SETTLED ON, for the record alone.
   *
   * Nothing in the pipeline reads it — the tab was decided in `fetchSource`
   * and the bytes are already that tab's. It is carried purely so the one
   * line this import writes can say which tab it read and on whose authority,
   * because production once read a hidden worksheet, answered 200 and left
   * nothing anywhere saying so.
   */
  sheetTab?: { gid: string; authority: string; tabCount: number } | null;
}

export interface RunImportFailure {
  ok: false;
  code: string;
  /** Safe to show the builder. */
  message: string;
  /** Internal diagnosis. Recorded on the row, never returned to a caller. */
  detail?: string;
  status: number;
  duplicateUploadId?: string;
}

export interface RunImportSuccess {
  ok: true;
  summary: {
    detected: number;
    imported: number;
    updated: number;
    failed: number;
    /** Properties whose card now shows the builder's own picture. */
    withSourceImage: number;
    /** Pictures the import budget left for the enrichment pass. */
    imageryOutstanding: boolean;
    warnings: string[];
    failures: Array<{ label: string; reason: string }>;
  };
  strategy: string;
  detectedMime: string | null;
  byteSize: number;
  enrichmentPending: number;
  /** The status the upload row was left in. */
  uploadStatus: 'enriching' | 'partially_complete';
}

export type RunImportResult = RunImportSuccess | RunImportFailure;

/**
 * Run the pipeline for one upload row whose bytes are already in hand.
 *
 * The caller owns the row's lifecycle either side of this: it sets `parsing`
 * before, and writes the failure or the success this returns.
 */
export async function runStockImport(input: RunImportInput): Promise<RunImportResult> {
  const result = await importOnce(input);
  /*
   * ONE LINE PER IMPORT, ON EVERY PATH.
   *
   * Written HERE rather than at each return because there are nine of them
   * and a tenth added later would silently write nothing — which is the exact
   * shape of the failure this record exists to end. Best-effort: a telemetry
   * fault must never change what a builder is told.
   */
  try {
    console.info(`${TELEMETRY_PREFIX} stock import`, uploadTelemetry({
      uploadId: input.upload.id,
      organisationId: input.organisationId,
      sourceKind: input.sourceKind ?? 'file',
      strategy: result.ok ? result.strategy : null,
      byteSize: input.bytes.length,
      sheetGid: input.sheetTab?.gid ?? null,
      sheetAuthority: input.sheetTab?.authority ?? null,
      sheetTabCount: input.sheetTab?.tabCount ?? null,
      linkDiscovery: input.linkDiscovery?.state ?? null,
      detected: result.ok ? result.summary.detected : null,
      imported: result.ok ? result.summary.imported : null,
      updated: result.ok ? result.summary.updated : null,
      failed: result.ok ? result.summary.failed : null,
      withSourceImage: result.ok ? result.summary.withSourceImage : null,
      imageryOutstanding: result.ok ? result.summary.imageryOutstanding : null,
      // The safe CODE, never the builder-facing sentence and never the detail:
      // a detail is a provider's own words about a document we do not own.
      outcome: result.ok ? 'imported' : result.code,
    }));
  } catch { /* a line that cannot be written is not an import failure */ }
  return result;
}

async function importOnce(input: RunImportInput): Promise<RunImportResult> {
  const { supabase, upload, bytes, organisationId } = input;
  const sourceKind = input.sourceKind ?? 'file';

  if (!bytes.length) {
    return fail('empty_file', sourceKind === 'url'
      ? 'That address returned an empty document.'
      : 'That file is empty.');
  }
  if (bytes.length > MAX_STOCK_FILE_BYTES) {
    return fail('file_too_large', 'That file is larger than the 25 MB limit.');
  }

  // `sha256Hex` is typed for a plain-ArrayBuffer view; a Uint8Array that
  // reached us through a stream reader carries the wider `ArrayBufferLike`.
  const sha = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);

  // Duplicate guard. The same BYTES from the same organisation have already
  // produced whatever they were going to — which is why a URL is not the key:
  // a stock-list page keeps its address and changes its contents.
  const { data: duplicate } = await supabase
    .from('builder_stock_uploads')
    .select('id, original_filename, source_title, created_at')
    .eq('organisation_id', organisationId)
    .eq('file_sha256', sha)
    .is('deleted_at', null)
    .neq('id', upload.id)
    .maybeSingle();
  if (duplicate) {
    const label = duplicate.source_title || duplicate.original_filename;
    return {
      ok: false,
      code: 'duplicate_file',
      message: `This is the same content as "${label}", already imported.`,
      status: 409,
      duplicateUploadId: duplicate.id,
    };
  }

  const detection = detectDocumentMime(bytes);
  if (detection.executable) {
    return fail('executable_file', 'That file is a program, not a document.');
  }

  const classification = input.classification
    ?? classifyStockFile(upload.original_filename, detection.mime, detection.reason);
  if (classification.kind === 'unsupported') {
    return fail('unsupported_file_type', classification.reason ?? 'That file type cannot be read.');
  }

  let extraction;
  try {
    extraction = await extractStockFile(bytes, upload.original_filename, classification, {
      baseUrl: input.baseUrl,
    });
  } catch (error) {
    if (error instanceof StockExtractionError) {
      return fail(error.code, error.safeMessage, String((error as { underlying?: unknown }).underlying ?? ''));
    }
    throw error;
  }

  // A table is normalised deterministically. Prose and photographs are read by
  // a model first, then normalised by exactly the same code.
  let rows = extraction.rows;
  let strategy = extraction.strategy;
  /*
   * THE MONTHLY CEILING, BOUND TO THE CLIENT THIS IMPORT ALREADY HOLDS.
   *
   * Built here rather than inside `modelExtract` so the reader can be tested
   * against a fake, and so this stays the one place that decides an import
   * may spend money. It is constructed unconditionally and used only on the
   * branches below — a deterministic table never reaches it, and a table that
   * parsed costs nothing to have built.
   */
  const budget = createAiBudget(supabase);
  try {
    if (!rows.length && extraction.visionImages.length) {
      const modelResult = await extractStockRowsFromImages(
        extraction.visionImages,
        { filename: upload.original_filename, organisationName: input.organisationName },
        { deadlineAt: Date.now() + MODEL_BUDGET_MS, budget },
      );
      rows = modelResult.rows;
      strategy = `${strategy}+model`;
    } else if (!rows.length && extraction.text) {
      const modelResult = await extractStockRowsFromText(
        extraction.text,
        { filename: upload.original_filename, organisationName: input.organisationName },
        { deadlineAt: Date.now() + MODEL_BUDGET_MS, budget },
      );
      rows = modelResult.rows;
      strategy = `${strategy}+model`;
    }
  } catch (error) {
    /*
     * THE ASSISTED READER FAILING IS A FACT ABOUT US, NOT ABOUT THE DOCUMENT.
     *
     * `callLLM` throws when every model in the chain refuses — including the
     * case where none is configured at all. That exception used to travel all
     * the way out of `runStockImport` to the handler's catch-all, which wrote
     * the upload off with "That page could not be processed." Measured
     * 18 September 2026 on project htfluofznhxeumblwbww: three imports failed
     * that way with `provider_not_configured` on both gateway models, and the
     * message named the builder's page for a credential this deployment had
     * never been given. Nothing in it was true and nothing in it was
     * actionable.
     *
     * So it became a NAMED failure — and the first version of that name was
     * still wrong in two ways, measured on this deployment on 20 September
     * 2026 against `LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf`:
     *
     *  1. ONE CODE FOR FOUR FAILURES. A missing credential, a provider
     *     outage, a timeout and a model answering with arguments that would
     *     not parse all wrote `assisted_reader_unavailable` and the same
     *     sentence. The router had already told us which — `LLMError.attempts`
     *     carries a per-model, already-sanitised account — and the catch kept
     *     only `error.message`, so the row recorded "All 2 models failed" and
     *     nothing else. `modelExtractionFailure.pure.ts` reads those attempts.
     *
     *  2. IT TOLD A BROCHURE TO GROW COLUMNS. The sentence ended "If the file
     *     lists one property per row, giving it column headings lets it import
     *     without assistance" — shown for every source type, including the
     *     document kinds the assisted reader exists BECAUSE they are not
     *     tables. A builder was asked to repair a 6.8 MB PDF brochure that was
     *     never the problem. `assistedReaderFailure.pure.ts` offers that hint
     *     only for the grid kinds it is true of.
     *
     * The underlying diagnosis travels in `detail`, which is recorded on the
     * row and never shown.
     */
    const failure = error instanceof StockModelExtractionError
      ? error
      : modelFailureFromRouterError(error);
    const reading = assistedReaderFailure({
      code: failure.code,
      sourceKind,
      classificationKind: classification.kind,
    });

    /*
     * ENOUGH TO DIAGNOSE THIS WITHOUT THE BUILDER'S DOCUMENT.
     *
     * Safe by construction: ids, the classification, the strategy, sizes, and
     * the router's own sanitised per-attempt categories. Never the document's
     * text, never a signed URL, never a credential — `summariseAttempts`
     * copies no provider body, and the extracted prose is reported only as a
     * LENGTH, which is what tells "the PDF gave us nothing to send" apart from
     * "we sent 40,000 characters and the reader was down".
     */
    try {
      console.error(`${TELEMETRY_PREFIX} assisted reader failed`, {
        phase: 'assisted_extraction',
        upload_id: upload.id,
        organisation_id: organisationId,
        source_kind: sourceKind,
        classification: classification.kind,
        extraction_strategy: extraction.strategy,
        text_extracted: Boolean(extraction.text),
        text_length: extraction.text?.length ?? 0,
        page_count: extraction.pageTexts?.length ?? null,
        vision_images: extraction.visionImages.length,
        assisted_extraction_started: true,
        failure_code: failure.code,
        error_code: reading.code,
        retryable: reading.retryable,
        model_attempts: failure.attemptCount,
        attempt_categories: failure.categories,
        diagnosis: failure.diagnosis,
        /*
         * WHY A MODEL WAS REACHED AT ALL. A PDF now goes to the assisted
         * reader only because the deterministic reader stood down, and this
         * says which of its four answers it gave — a label with no value, two
         * prices, a shape it does not claim to read. Safe by construction:
         * `diagnostics` carries counts, status words and canonical field
         * NAMES, never a value the document stated.
         */
        deterministic_status: extraction.deterministicReading?.status ?? null,
        deterministic_reason: extraction.deterministicReading?.reason ?? null,
        deterministic_fields: extraction.deterministicReading?.diagnostics.fieldsRead ?? null,
        deterministic_candidates: extraction.deterministicReading?.diagnostics.candidates ?? null,
      });
    } catch { /* a line that cannot be written is not an import failure */ }

    return {
      ok: false,
      code: reading.code,
      message: reading.message,
      // Structured, so the row says which models were tried and how each
      // failed rather than only that some number of them did.
      detail: JSON.stringify({
        failure: failure.code,
        attempts: failure.attemptCount,
        categories: failure.categories,
        diagnosis: failure.diagnosis,
        strategy: extraction.strategy,
        text_length: extraction.text?.length ?? 0,
      }).slice(0, 1500),
      status: reading.status,
    };
  }

  const { error: stampError } = await supabase.from('builder_stock_uploads').update({
    status: 'imported',
    detected_content_type: detection.mime,
    file_sha256: sha,
    byte_size: bytes.length,
    parse_strategy: strategy,
  }).eq('id', upload.id);
  // The unique index on (organisation_id, file_sha256) is the duplicate
  // guard's second half: if two imports of the same bytes raced past the
  // lookup above, this is where the loser finds out.
  if (stampError && /duplicate key/i.test(stampError.message || '')) {
    return {
      ok: false,
      code: 'duplicate_file',
      message: 'This content has already been imported.',
      status: 409,
    };
  }

  /*
   * EVERY ROW SAYS WHETHER ITS LINK LAYER WAS READ. The caller's stamp wins —
   * it is the only party that knows how a Google Sheet's separately-travelling
   * targets fared — and a source whose links are native to the bytes just read
   * (a workbook's relationships, a CSV's own text, a PDF's annotations, a
   * Notion record map) is stamped `complete` from the strategy that read it.
   * The stamp is what lets `readSuppliedEvidence` tell "this row supplied
   * nothing" from "we could not see what this row supplied" — see
   * `suppliedEvidence.pure.ts`, which is the one reader of it.
   */
  const linkDiscovery: RowLinkDiscovery = input.linkDiscovery
    ?? { state: 'complete', method: `native:${strategy}` };

  const outcome = await importStockRecords(supabase, {
    organisationId,
    uploadId: upload.id,
    builderUserId: input.builderUserId,
    rows,
    media: extraction.media,
    linkDiscovery,
    // The caller's assets first: a Notion collection knows which row owns
    // which cover, and the CSV it became cannot.
    rowAssets: [...(input.rowAssets ?? []), ...extraction.rowAssets],
    // A PDF's properties come out of prose and carry no anchor of their own;
    // these are what lets one be tied back to the page it was described on.
    pageTexts: extraction.pageTexts,
    pageOrderAuthoritative: extraction.pageOrderAuthoritative,
    filename: upload.original_filename,
  });

  if (!outcome.detected) {
    /**
     * ZERO ROWS IS NOT A PERMISSION FINDING.
     *
     * This branch used to answer `notion_not_public` for any Notion source
     * that produced no rows, which meant the pipeline was reporting on a
     * page's SHARING STATE from evidence that says nothing about it. A public
     * page whose columns we did not recognise, a public page that is genuinely
     * empty, and a private page all reach here identically.
     *
     * Accessibility is settled BEFORE the pipeline runs, by the fetch status
     * and by `assessNotionReadability` looking for an explicit gate; nothing
     * in here may contradict that. What this branch knows is only that the
     * content produced no properties, so that is all it says.
     */
    if (input.isNotionSource) {
      return fail('no_properties_found', NOTION_NO_PROPERTIES_MESSAGE);
    }
    /*
     * THE SAME COLUMN-HEADING RULE AS THE FAILURE ABOVE. This sentence used to
     * end "Check that it lists one property per row with column headings" for
     * every source, so a brochure the reader had genuinely found no property
     * in was also told to become a spreadsheet. `SOURCE_HAS_COLUMNS` is the
     * one place that decides which sources that advice is true of.
     */
    const what = sourceKind === 'url' ? 'page' : 'file';
    if (SOURCE_HAS_COLUMNS.has(classification.kind)) {
      return fail('no_properties_found', sourceKind === 'url'
        ? 'No properties could be read from that page. Check that it lists one property per row, or upload the stock list instead.'
        : 'No properties could be read from that file. Check that it lists one property per row with column headings.');
    }
    return fail('no_properties_found',
      `We read that ${what}, but it did not describe a property we could list.`
      + ' If it should, check that it names the lot or address and its price.');
  }

  /**
   * SAY WHETHER THE BUILDER'S OWN IMAGERY LANDED.
   *
   * An import that read the properties and produced no picture used to look
   * exactly like one that produced every picture — the difference only showed
   * up later as an empty frame on a card, with nothing anywhere to explain it.
   */
  const warnings = [...extraction.warnings];
  /**
   * Only where the source ACTUALLY CARRIED imagery this import could see. A
   * stock list whose pictures live behind a package link each row carries has
   * none at this point and every one of them a few seconds later, when the
   * settlement stage follows those links — warning here would be false on
   * exactly the source type that takes longest to resolve.
   */
  const sawImagery = extraction.media.length > 0
    || (extraction.rowAssets ?? []).some((row) => row.assets.length > 0)
    || (input.rowAssets ?? []).some((row) => row.assets.length > 0);
  if (outcome.itemIds.length && sawImagery && !outcome.withSourceImage
    && !outcome.imageryOutstanding) {
    warnings.push(
      'No supplied image could be identified for these properties, so their cards '
      + 'will show no photograph.');
  }

  /*
   * START THE IMAGE WORK NOW — the import is the moment work exists, and a
   * six-property list must begin six-wide immediately instead of trickling
   * through the cron at two workers a minute (measured 2026-09-15: ~25
   * minutes for six properties). The kick re-arms the watchdog schedule and
   * fans out signed settler invocations sized to the claimable backlog.
   * BEST-EFFORT BY DESIGN: the every-minute tick reaches the same queue, so
   * a deployment mid-migration or a pg_net hiccup costs latency, never work.
   */
  try {
    const { error: kickError } = await input.supabase
      .rpc('builder_stock_kick_image_work', { p_upload_id: input.upload.id });
    if (kickError) {
      console.warn('[builderStock] image work kick unavailable; cron will drive', {
        phase: 'image_work_dispatch', upload_id: input.upload.id,
        detail: String(kickError.message ?? kickError).slice(0, 160),
      });
    }
  } catch { /* the cron tick is the guarantee */ }

  return {
    ok: true,
    summary: {
      detected: outcome.detected,
      imported: outcome.imported,
      updated: outcome.updated,
      failed: outcome.failed,
      withSourceImage: outcome.withSourceImage,
      imageryOutstanding: outcome.imageryOutstanding,
      warnings,
      failures: outcome.failures,
    },
    strategy,
    detectedMime: detection.mime,
    byteSize: bytes.length,
    enrichmentPending: outcome.itemIds.length,
    uploadStatus: outcome.failed > 0 ? 'partially_complete' : 'enriching',
  };
}

function fail(code: string, message: string, detail?: string): RunImportFailure {
  return { ok: false, code, message, detail, status: 400 };
}
