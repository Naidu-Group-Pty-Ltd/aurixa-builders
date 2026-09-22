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
import {
  completionDeadlineFrom, openImportBudget, storageDeadlineFrom,
} from './importBudget.pure.ts';
import {
  completionMayMerge, completionWorthAsking, mergeCompletion, missingVitalFields,
} from './stockFieldCompletion.pure.ts';
import type { StockFileClassification } from './fileTypes.pure.ts';
import { extractStockFile, StockExtractionError } from './extract.ts';
import {
  countIn, ledgerTotalMs, recordStage,
  type ImportStageLedger,
} from './importStageLedger.pure.ts';
import { watchImportTermination } from './importTermination.ts';
import type { PdfDeterministicDiagnostics } from './extract.ts';
import { extractStockRowsFromImages, extractStockRowsFromText } from './modelExtract.ts';
import { StockModelExtractionError, modelFailureFromRouterError } from './modelExtractionFailure.pure.ts';
import { assistedReaderFailure, SOURCE_HAS_COLUMNS } from './assistedReaderFailure.pure.ts';
import { createAiBudget } from './aiBudget.ts';
import {
  assistedReaderDisposition, assistedReaderEnabled,
} from './assistedReaderPolicy.pure.ts';
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
   * The stage ledger this run continues, where it continues one.
   *
   * Present on a RESUMED import: the stages this invocation runs are added to
   * the account of the ones a previous invocation ran, rather than opening a
   * second account of the same upload. Absent — which is every caller that
   * does not resume — starts a fresh ledger and behaves exactly as before.
   * See `importStageLedger.pure.ts`.
   */
  ledger?: Record<string, unknown> | null;
  /**
   * WHAT THE DOCUMENT IS CALLED, as distinct from what this upload is LABELLED.
   *
   * `original_filename` is a display label. For a file it happens to be the
   * document's own name; for a URL it is `host/…/segment`, composed to read
   * well in a list. The deterministic reader uses a name as EVIDENCE — it
   * will settle which field an unplaced page line belongs to when the name
   * echoes it — so handing it a label let a HOSTNAME name a house design.
   * Measured, with the numbers, in `documentName.pure.ts`.
   *
   * Absent means the transport did not supply one and nothing may be
   * corroborated, which is the same position a file called `download.pdf`
   * leaves the reader in. A caller that omits it for a FILE gets the file's
   * own name, because for a file the label and the name are the same thing.
   */
  documentName?: string | null;
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
    /** And why, where the document's images were never decompressed at all. */
    imageryDeferred?: string | null;
    /**
     * Fields the deterministic reader could not prove and a model supplied.
     *
     * Named rather than counted, and reported on the SUCCESS path, because
     * "read off the page" and "completed from the same page by a model" are
     * different provenance for the same figure and a record that cannot tell
     * them apart cannot be audited.
     */
    completedFields?: string[];
    warnings: string[];
    failures: Array<{ label: string; reason: string }>;
  };
  strategy: string;
  detectedMime: string | null;
  byteSize: number;
  enrichmentPending: number;
  /**
   * What the deterministic PDF reader made of the document, carried out so
   * the one telemetry line can say why a field is empty. Absent for every
   * other format.
   */
  deterministicReading?: PdfDeterministicDiagnostics | null;
  /**
   * The lines the deterministic reader saw and attributed to nothing.
   *
   * ON THE SUCCESS PATH, WHICH IS WHERE IT WAS MISSING. A document that fails
   * to import is diagnosable — the refusal already carries its unaccounted
   * lines — and a document that imports with five of its twelve fields empty
   * is not, because the only thing production ever recorded about the rest of
   * the page was how many lines there were. `LOT 266 Crowlea Estate` imported
   * with no address, no suburb, no state, no estate and no design beside 359
   * ignored lines, and nothing anywhere can say whether that brochure states
   * a street address at all.
   *
   * DOCUMENT TEXT, so it never joins `deterministicReading`, which is the
   * safe-to-log projection. It travels to the upload row's `error_detail`,
   * which `get_upload` and `projectUploadListRow` both project away.
   */
  deterministicIgnored?: string[] | null;
  /** Where each of those lines was drawn, aligned by index. Numbers only. */
  deterministicPlacement?: string[] | null;
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
      imageryDeferred: result.ok ? (result.summary.imageryDeferred ?? null) : null,
      completedFields: result.ok ? (result.summary.completedFields ?? null) : null,
      // The safe CODE, never the builder-facing sentence and never the detail:
      // a detail is a provider's own words about a document we do not own.
      outcome: result.ok ? 'imported' : result.code,
      /*
       * AND WHY A FIELD IS EMPTY, on a run that SUCCEEDED. Logged only on
       * the failure path before, which left "it imported but the land size
       * is blank" answerable in no way except by obtaining the PDF.
       */
      deterministic: result.ok && result.deterministicReading
        ? {
          status: result.deterministicReading.status,
          reason: result.deterministicReading.reason,
          fieldsRead: result.deterministicReading.diagnostics.fieldsRead,
          disputedFields: result.deterministicReading.diagnostics.disputedFields ?? null,
          visualOnlyFields: result.deterministicReading.diagnostics.visualOnlyFields ?? null,
          declinedFields: result.deterministicReading.diagnostics.declinedFields ?? null,
          readBy: result.deterministicReading.diagnostics.readBy ?? null,
          ignoredLines: result.deterministicReading.diagnostics.ignoredLines ?? null,
          unaccountedLines: result.deterministicReading.diagnostics.unaccountedLines ?? null,
        }
        : null,
    }));
  } catch { /* a line that cannot be written is not an import failure */ }
  return result;
}

async function importOnce(input: RunImportInput): Promise<RunImportResult> {
  const { supabase, upload, bytes, organisationId } = input;
  const sourceKind = input.sourceKind ?? 'file';
  /*
   * ONE CLOCK, OPENED HERE, SPENT BY BOTH EXPENSIVE PHASES.
   *
   * Reading the document and storing its pictures are two phases of one
   * invocation and they were budgeted as neither: extraction had no deadline
   * at all, and the image phase's eight seconds were measured from the moment
   * IT began — which is after extraction had already spent whatever it spent.
   * A budget that starts after the unbudgeted phase bounds that phase and
   * nothing in front of it. See `importBudget.pure.ts`.
   */
  const runBudget = openImportBudget(Date.now(), bytes.length);

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * THE LEDGER, AND WHY IT IS COMMITTED AT EVERY STAGE RATHER THAN AT THE END
   * ═══════════════════════════════════════════════════════════════════════
   *
   * MEASURED 22 September 2026: `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`
   * (8,530,307 bytes) reached `POST builder-portal-stock -> 546  CPU Time
   * exceeded` eight seconds into processing, and the row it left behind read
   * `stage_timings: null`. The run that survives tells you what it spent; the
   * run that DIES tells you nothing, and the run that dies is the only one
   * worth measuring.
   *
   * So each stage commits before the next one starts. One small UPDATE per
   * stage, awaited, and a worker killed anywhere leaves a row naming the last
   * stage that finished and what every finished stage cost — the stage after
   * the last entry is the one that killed it.
   *
   * BEST-EFFORT AND NEVER FATAL: a deployment whose migration has not been
   * dispatched has no column for this, and an import must not fail over a
   * diagnostic. See `importStageLedger.pure.ts`.
   */
  const ledger: ImportStageLedger = (input.ledger as ImportStageLedger | undefined) ?? {};
  /*
   * AND IF THE RUNTIME TAKES THE WORKER, IT SAYS WHICH RESOURCE IT TOOK IT
   * FOR. `546` means the worker went away and nothing else; the last
   * completed stage plus the reason is the whole diagnosis. See
   * `importTermination.ts`.
   */
  const termination = watchImportTermination('builderStock');
  termination.watch(ledger);
  const commitLedger = async (current: ImportStageLedger): Promise<void> => {
    try {
      await supabase.from('builder_stock_uploads')
        .update({ stage_timings: { ...current, total_ms: ledgerTotalMs(current) } })
        .eq('id', upload.id)
        .eq('organisation_id', organisationId);
    } catch { /* a diagnostic never fails the deliverable */ }
  };
  /** Run one of THIS module's stages into the same ledger the extractor uses. */
  const stage = async <T>(
    name: Parameters<typeof recordStage>[1], run: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      recordStage(ledger, name, Date.now() - startedAt);
      await commitLedger(ledger);
    }
  };

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
  const sha = await stage('document_open',
    () => sha256Hex(bytes as Uint8Array<ArrayBuffer>));

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

  /*
   * A FILE'S LABEL IS ITS NAME; A URL'S IS NOT. `documentName` is stated by
   * the URL transport, which is the only one that can tell the difference —
   * and where it states nothing, nothing is invented. A file transport
   * supplies no `documentName` and its label stands, because a builder
   * choosing what to call a file they are attaching IS naming the document.
   */
  const documentName = input.documentName !== undefined
    ? (input.documentName ?? '')
    : (sourceKind === 'url' ? '' : upload.original_filename);
  if (classification.kind === 'unsupported') {
    return fail('unsupported_file_type', classification.reason ?? 'That file type cannot be read.');
  }

  let extraction;
  try {
    extraction = await extractStockFile(bytes, upload.original_filename, classification, {
      documentName,
      baseUrl: input.baseUrl,
      /*
       * The uploading organisation's own name, for the deterministic PDF
       * reader alone: a builder's brochure carries the builder's name on
       * every page and it is never the estate or the design. The assisted
       * reader has been handed it since it was written.
       */
      organisationName: input.organisationName,
      budget: runBudget,
      // ONE ACCOUNT OF ONE RUN: the extractor records its stages into the
      // same ledger and commits through the same hook.
      ledger,
      onStage: commitLedger,
    });
  } catch (error) {
    if (error instanceof StockExtractionError) {
      return fail(error.code, error.safeMessage, String((error as { underlying?: unknown }).underlying ?? ''));
    }
    throw error;
  }

  /*
   * WHAT THE READER SAW, REPORTED THE MOMENT IT IS KNOWN.
   *
   * The import's own telemetry line is written after everything else has run,
   * so a worker killed later takes the reading's account with it — which is
   * exactly what happened on upload `6d195db5` at 08:59 on 21 September 2026:
   * the run died during the field completion and left NOTHING anywhere saying
   * what the deterministic reader had made of the document. Two rounds were
   * then spent guessing at it.
   *
   * This is known as soon as `extractStockFile` returns and costs one line.
   * Safe by construction, the same contract `diagnostics` already carries:
   * counts, status words and canonical field NAMES, never a value the
   * document stated.
   */
  if (extraction.deterministicReading) {
    try {
      console.info(`${TELEMETRY_PREFIX} deterministic reading`, {
        phase: 'deterministic_read',
        upload_id: upload.id,
        organisation_id: organisationId,
        status: extraction.deterministicReading.status,
        reason: extraction.deterministicReading.reason,
        fields_read: extraction.deterministicReading.diagnostics.fieldsRead,
        visual_only: extraction.deterministicReading.diagnostics.visualOnlyFields ?? null,
        count_evidence: extraction.deterministicReading.diagnostics.countEvidence ?? null,
        counts_corroborated:
          extraction.deterministicReading.diagnostics.countsCorroborated ?? false,
        unaccounted_lines:
          extraction.deterministicReading.diagnostics.unaccountedLines ?? 0,
        ignored_lines: extraction.deterministicReading.diagnostics.ignoredLines ?? 0,
      });
    } catch { /* a line that cannot be written is not an import failure */ }
  }

  let rows = extraction.rows;
  let strategy = extraction.strategy;

  /*
   * =======================================================================
   * WHAT THE DOCUMENT STATES IS THE IMPORT.
   * =======================================================================
   *
   * THE ORDER USED TO BE THE OTHER WAY ROUND, AND THAT WAS THE DEFECT. A
   * deterministic reading that stood down was treated as NO reading, a model
   * was asked, and the deterministic evidence was brought back only as a
   * rescue if the model failed. So a paid vendor account sat between an
   * ordinary builder brochure and the marketplace, on the ordinary path,
   * every single time.
   *
   * MEASURED. `Lot 37 - Miami 190 - Property Package.pdf`, 21 September 2026:
   * 7 pages, 3,962 characters of text extracted cleanly, import FAILED with
   * zero properties because `openrouter/openai/gpt-5.6-luna` answered 402 —
   * an account with no credit. `LOT 817 - ELARA 18 TEMPIO LIGHT` the same
   * morning, `LOT 315 - ENZO 8.5 LUCA` the day before.
   *
   * `provisional` is what the reader had already read when it stood down, and
   * every gate below the one that refused has been applied to it: the record
   * names a property, is not a summary row, carries at least
   * `MIN_BROCHURE_FIELDS`, maps to canonical headers and survives
   * `normaliseStockRow`. Each value in it was read off the page by a named
   * reader. Nothing is inferred, and a field nothing claimed stays absent —
   * absent is never zero.
   *
   * IT IS RECORDED AS WHAT IT IS. `parse_strategy` says the reading was
   * partial, so a thin record can never be mistaken for a complete one.
   */
  if (!rows.length) {
    const standing = extraction.deterministicProvisional ?? [];
    if (standing.length) {
      rows = standing;
      strategy = 'pdf_deterministic_partial';
      try {
        console.info(`${TELEMETRY_PREFIX} deterministic reading stands`, {
          phase: 'deterministic_partial',
          upload_id: upload.id,
          organisation_id: organisationId,
          rows: standing.length,
          deterministic_reason: extraction.deterministicReading?.reason ?? null,
          deterministic_fields: extraction.deterministicReading?.diagnostics.fieldsRead ?? null,
        });
      } catch { /* a line that cannot be written is not an import failure */ }
    }
  }

  /*
   * =======================================================================
   * AND THE ASSISTED READER, WHICH IS OPTIONAL AND CANNOT DECIDE ANYTHING.
   * =======================================================================
   *
   * Reached only where the document yielded nothing at all AND an operator
   * has switched it on by name. Off — which is the default, and the state of
   * every deployment that has not opted in — this makes no request, reserves
   * no budget and waits for nothing. See `assistedReaderPolicy.pure.ts`.
   *
   * ITS FAILURE IS NEVER THE IMPORT'S. Whatever happens here, the outcome
   * below is decided by what the document supports: rows, or the honest
   * `no_properties_found`. A vendor's billing state is not a fact about a
   * builder's brochure and can no longer be reported as one.
   */
  const assistedOn = assistedReaderEnabled(Deno.env);
  const disposition = assistedReaderDisposition({
    enabled: assistedOn,
    deterministicRows: rows.length,
  });
  /*
   * CONSTRUCTED ONLY WHERE IT WILL BE SPENT. It used to be built
   * unconditionally, which was harmless while it was merely an object — and
   * is exactly the "reserve no budget" this path must now honour.
   */
  const budget = disposition.consulted ? createAiBudget(supabase) : null;
  try {
    if (!disposition.consulted) {
      // Nothing to do: either the document already answered, or the optional
      // reader is off. Recorded on the import line, never as a failure.
    } else if (!rows.length && extraction.visionImages.length) {
      const modelResult = await extractStockRowsFromImages(
        extraction.visionImages,
        { filename: upload.original_filename, organisationName: input.organisationName },
        { deadlineAt: Date.now() + MODEL_BUDGET_MS, budget: budget! },
      );
      rows = modelResult.rows;
      strategy = `${strategy}+model`;
    } else if (!rows.length && extraction.text) {
      const modelResult = await extractStockRowsFromText(
        extraction.text,
        { filename: upload.original_filename, organisationName: input.organisationName },
        { deadlineAt: Date.now() + MODEL_BUDGET_MS, budget: budget! },
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

    /*
     * =====================================================================
     * AND THE READING WE ALREADY HAVE IS BETTER THAN NOTHING AT ALL.
     * =====================================================================
     *
     * EVERY failure code that reaches here is a fact about US. The union says
     * so in its own words: an unconfigured credential, a provider outage, a
     * timeout, a spent allowance, an account out of credit, a model that
     * answered in the wrong shape. Not one of them is a statement about the
     * builder's document — which this reader had already read.
     *
     * MEASURED, 21 SEPTEMBER 2026.
     * `LOT 817 - ELARA 18 TEMPIO LIGHT - BROCHURE V002 (1).pdf`, 8,840,575
     * bytes, 6 pages, 13,079 characters of text extracted cleanly. The
     * deterministic reader read `development_name`, `expected_completion`,
     * `house_design` and `price`, stood down on ONE unaccounted line, and the
     * assisted reader it deferred to answered
     * `openrouter/openai/gpt-5.6-luna: refused 402` — no credit on the
     * account. Four fields read off the document were discarded because a
     * vendor was unpaid, and the builder was told their stock list could not
     * be imported. Every brochure the deterministic reader does not fully own
     * fails this way for as long as that account stays empty: one vendor's
     * billing state is the whole pathway.
     *
     * THE BROCHURE GATE'S REASONING IS UNCHANGED AND STILL RIGHT. It stands a
     * document down so as not to "SUPPRESS the assisted reader, which can
     * read both" — and that is conditional on the assisted reader existing.
     * Here it demonstrably does not, so there is nothing left to suppress and
     * deferring is simply discarding.
     *
     * WHAT IS IMPORTED IS THINNER, NEVER WRONGER. `provisionalFrom` applied
     * every gate below the one that refused: the record names a property, is
     * not a summary row, carries at least `MIN_BROCHURE_FIELDS`, maps to
     * canonical headers and survives `normaliseStockRow`. Each value in it was
     * read off the page by a named reader. Nothing is inferred, and a field
     * nothing claimed stays absent rather than being guessed — this
     * repository's own rule, paid for by `rentalEvidence` and
     * `placesAvailability`: absent is never zero.
     *
     * AND IT IS RECORDED AS WHAT IT IS. `parse_strategy` says the reading was
     * partial, so a thin record can never be mistaken for a full one, and
     * re-reading the source once the assisted reader is available replaces it
     * — `reprocess_upload` exists for exactly that and matches on identity.
     */
    /*
     * =====================================================================
     * AND IT CHANGES NOTHING ABOUT THE IMPORT.
     * =====================================================================
     *
     * This used to `return` a failure here — `assisted_reader_refused`,
     * status 503 — so a vendor's billing state became the outcome of reading
     * a builder's document. `Lot 37 - Miami 190 - Property Package.pdf` was
     * written off that way with seven readable pages in hand.
     *
     * The deterministic reading has ALREADY been taken, above, before this
     * reader was consulted at all. So reaching here means the document
     * yielded nothing that could be identified, and the honest outcome is the
     * one the document earns: `no_properties_found`, decided below, which
     * says we read it and could not find a property in it.
     *
     * THE DIAGNOSIS IS STILL RECORDED. Which models were tried and how each
     * failed is on the `assisted reader failed` line above, with the router's
     * own per-attempt categories. What it no longer does is speak for the
     * document.
     */
  }

  /*
   * =======================================================================
   * WHAT THE READER COULD NOT PROVE IS ASKED FOR BY NAME.
   * =======================================================================
   *
   * THE DETERMINISTIC READER STAYS THE AUTHORITY AND STOPS BEING THE ONLY
   * READER. It reads what the document labels; what it could not prove is a
   * SHORT LIST OF NAMED FIELDS, and those go to the model instead of the
   * whole document going to the model. Nothing it claimed can be overwritten
   * — `mergeCompletion` has no branch that replaces a held value — so this
   * cannot cost accuracy, only fill absence.
   *
   * MEASURED, 21 SEPTEMBER 2026, over every property this deployment holds:
   * bedrooms, bathrooms and car spaces were absent on SEVEN OF EIGHT, and the
   * gaps disagreed between template families — the NEX 20 carried an address
   * and no price, the ZIMI a price and no address. That is the inconsistency
   * a reader sees on the marketplace, card beside card.
   *
   * AND IT IS NOT A VOCABULARY GAP. The brochure prints `3 2.5 1` beside bed,
   * bath and car ICONS, and an icon is an image: the text says which numbers
   * the property has and never which is which. Assuming the conventional
   * order is what wrote `bathrooms: 9` onto a real property that morning, so
   * `readIconCountRow` accepts the row only where the floor plan NAMES its
   * bedrooms as text — true of one flyer here and of nothing else. Teaching
   * the reader more words cannot close it, which is why this is not more
   * words.
   *
   * WHY THIS IS THE GENERAL FIX. It needs nothing known in advance about any
   * template: a design nobody has seen completes exactly as a familiar one
   * does, and a template whose vocabulary is later learned simply asks for
   * less. The ordering this product insists on is unchanged — deterministic
   * first, the model last, and now only for the residue rather than for the
   * document.
   *
   * IT CAN NEVER FAIL THE IMPORT. Every refusal below is silent and the
   * reading stands: no budget, no credential, a provider down, a timeout, two
   * rows on either side. The card is then exactly as complete as it is today,
   * which is the behaviour this replaces rather than risks.
   */
  let completedFields: string[] = [];
  /*
   * ASKED BEFORE IT STARTS, NEVER AFTER — the rule this file already answers
   * to twice over, and the one the first cut of this completion broke.
   *
   * MEASURED 21 SEPTEMBER 2026: the completion was handed
   * `Date.now() + MODEL_BUDGET_MS`, ninety seconds against a thirty-second
   * run bound, at the point where the run is closest to its ceiling. It
   * failed `model_refused` at 08:59:13.663 and the worker was killed on CPU
   * at 08:59:16.717 — a whole import lost to filling in a card.
   *
   * A completion is the LEAST important thing an import does: the record is
   * already correct and already about to be written. So it begins only where
   * the run can afford it, and it is held to the smaller of its own allowance
   * and what is left.
   */
  /*
   * AND IT IS THE OPTIONAL READER TOO, UNDER THE SAME SWITCH.
   *
   * This pass is a model call on the ordinary PDF path — the second one, and
   * the easier to miss, because it runs on a SUCCESSFUL import to fill gaps
   * in a card. Measured 21 September 2026 on `LOT 266 Crowlea Estate`: every
   * import logged `field completion unavailable … model_refused` against the
   * same unpaid account. Nothing was lost, because it is silent by design —
   * but it is a vendor round trip on every upload, and a wait, for a feature
   * nobody switched on. Off by default, with everything else. See
   * `assistedReaderPolicy.pure.ts`.
   */
  const completionDeadline = assistedOn
    ? completionDeadlineFrom(runBudget, Date.now())
    : null;
  if (completionDeadline !== null
    && rows.length === 1 && completionWorthAsking(rows[0]) && extraction.text) {
    try {
      const completion = await extractStockRowsFromText(
        extraction.text,
        { filename: upload.original_filename, organisationName: input.organisationName },
        { deadlineAt: completionDeadline, budget: createAiBudget(supabase) },
      );
      if (completionMayMerge(rows, completion.rows)) {
        const merged = mergeCompletion(rows[0], completion.rows[0]);
        if (merged.completed.length) {
          rows = [merged.row];
          completedFields = merged.completed;
          strategy = `${strategy}+completed`;
        }
      }
    } catch (error) {
      /*
       * SILENT, AND THE READING STANDS. This is the last resort filling an
       * absence, not the reader of the document: a builder whose brochure was
       * read has nothing to do about a model that could not be reached, and
       * telling them the import failed over it would undo the whole point of
       * the fallback shipped beside this.
       */
      try {
        console.warn(`${TELEMETRY_PREFIX} field completion unavailable`, {
          phase: 'field_completion',
          upload_id: upload.id,
          organisation_id: organisationId,
          missing: missingVitalFields(rows[0]),
          detail: String((error as { code?: string })?.code ?? 'unknown'),
        });
      } catch { /* a line that cannot be written is not an import failure */ }
    }
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

  const recordsStartedAt = Date.now();
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
    // And where on a page each property was drawn, for the documents whose
    // pages carry more than one. Absent everywhere else.
    pdfRegions: extraction.pdfRegions,
    pageOrderAuthoritative: extraction.pageOrderAuthoritative,
    filename: upload.original_filename,
    // Derived from the run's own clock rather than restarted here, which is
    // the half of this defect that had a budget and spent it from zero.
    imageDeadlineAt: storageDeadlineFrom(runBudget, Date.now()),
    // ONE ACCOUNT OF ONE RUN. The raster half of that call records itself.
    ledger,
    onStage: commitLedger,
  });
  /*
   * THE ROW WRITES ARE WHAT IS LEFT ONCE THE RASTER WORK IS TAKEN OUT.
   *
   * `importStockRecords` does two different kinds of work in one call and
   * only one of them is expensive per byte. Timing the whole call as
   * `db_write` would put the photographs' cost under a metadata heading and
   * hide the thing the measurement is for; subtracting what the raster stage
   * already recorded is the same rule the reader and the segmenter answer to
   * one level up.
   */
  const imageStoreMs = typeof ledger.image_store_ms === 'number' ? ledger.image_store_ms : 0;
  recordStage(ledger, 'db_write',
    Math.max(0, (Date.now() - recordsStartedAt) - imageStoreMs));
  await commitLedger(ledger);

  /*
   * WHAT THIS RUN SPENT IS ALREADY WRITTEN DOWN — this block used to do it
   * here, at the end, and that is exactly why the 22 September CPU kill left
   * `stage_timings: null` on an import that had spent eight seconds. The
   * ledger is committed at every stage boundary now; what is added here is
   * only what this point of the run knows and the stages did not.
   */
  countIn(ledger, 'rows_detected', outcome.detected);
  ledger.strategy = strategy;

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
    /*
     * WHAT THE READER ACTUALLY SAW, RECORDED WITH THE REFUSAL.
     *
     * This path carried no `detail` at all, and while a model stood behind it
     * that was survivable: a document reaching here had already been offered
     * to a second reader, and the record that mattered was the model's. With
     * the model gone this IS the outcome, and an outcome nobody can diagnose
     * is one that can only be investigated by asking the builder to send the
     * file again — which is the loop this work exists to end.
     *
     * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property
     * Package.pdf`: the row said `conflicting_values:development_name` and
     * nothing else, over a document whose text had extracted cleanly at
     * 3,962 characters. Which two estates it named was unknowable from the
     * record.
     *
     * `detail` is the internal diagnosis — `RunImportFailure` says so, and
     * `get_upload` and `projectUploadListRow` both project it away — which is
     * what makes it the right home for document text.
     */
    const reading = extraction.deterministicReading;
    const detail = reading
      ? JSON.stringify({
        deterministic_status: reading.status,
        deterministic_reason: reading.reason,
        fields_read: reading.diagnostics.fieldsRead ?? null,
        conflict_field: reading.diagnostics.conflictField ?? null,
        disputed_fields: reading.diagnostics.disputedFields ?? null,
        // These live BESIDE the projection, never inside it: the projection
        // is the safe-to-log one and a value the document stated may not
        // enter it. See their notes on `StockExtraction`.
        provisional_rows: (extraction.deterministicProvisional ?? []).length,
        unaccounted: extraction.deterministicUnaccounted ?? null,
        ignored: extraction.deterministicIgnored ?? null,
        placement: extraction.deterministicPlacement ?? null,
      })
      : undefined;
    if (SOURCE_HAS_COLUMNS.has(classification.kind)) {
      return fail('no_properties_found', sourceKind === 'url'
        ? 'No properties could be read from that page. Check that it lists one property per row, or upload the stock list instead.'
        : 'No properties could be read from that file. Check that it lists one property per row with column headings.',
        detail);
    }
    return fail('no_properties_found',
      `We read that ${what}, but it did not describe a property we could list.`
      + ' If it should, check that it names the lot or address and its price.',
      detail);
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
  const kickStartedAt = Date.now();
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
  recordStage(ledger, 'initial_image_work', Date.now() - kickStartedAt);
  await commitLedger(ledger);
  const finalisationStartedAt = Date.now();

  /*
   * AND ASK WHETHER THIS UPLOAD CAN BE PUBLISHED, BECAUSE NOTHING ELSE WILL
   * ASK ON A RE-READ.
   *
   * `publish_builder_stock_upload` had exactly ONE caller: the image settler,
   * after an item's work completes — under its own comment, "there is nothing
   * else watching". That is true, and it is the whole defect. Publication is
   * also what APPLIES a held-back patch, so on a list whose photographs are
   * already settled a re-read produces no image work, nothing claims an item,
   * nobody asks, and a corrected reading sits in `pending_patch` for ever.
   *
   * MEASURED 21 SEPTEMBER 2026. `LOT 266 Crowlea Estate` was re-read at
   * 10:49 with the right answer — `development_name:leading_field_name`,
   * `land_size_sqm:below` — and the settler's next three ticks reported
   * `claimed: 0, claimable: 0, outstanding: 0`. Fixing the publication
   * function so it applies a patch on a second publication was necessary and
   * was not sufficient: a function nobody calls cannot apply anything.
   *
   * SAFE ON EVERY OTHER PATH, because the function decides and this only
   * asks. A first upload is not ready this early — its photographs have not
   * settled — so it answers `not_ready` and changes nothing but the reason it
   * already writes. A deleted or superseded upload refuses before anything
   * else. The readiness rule is evaluated inside the same statement that
   * flips the rows, so asking twice can never publish half a cutover.
   *
   * BEST-EFFORT, LIKE THE KICK ABOVE: the settler still asks after every
   * completed item, so a failure here costs latency and never work.
   */
  try {
    await input.supabase.rpc('publish_builder_stock_upload', {
      p_upload_id: input.upload.id,
    });
  } catch { /* the settler and the cron tick both ask again */ }
  recordStage(ledger, 'finalisation', Date.now() - finalisationStartedAt);
  await commitLedger(ledger);
  /*
   * THE RUN IS OVER, so a termination from here on is the ordinary end-of-
   * request drop and must not be reported as an import dying mid-stage.
   */
  termination.done();

  return {
    ok: true,
    summary: {
      detected: outcome.detected,
      imported: outcome.imported,
      updated: outcome.updated,
      failed: outcome.failed,
      withSourceImage: outcome.withSourceImage,
      /*
       * IMAGERY DECLINED AT DISCOVERY IS IMAGERY OUTSTANDING. The storage
       * phase raises this flag for what IT declined; a document whose
       * pictures were never decompressed has the same thing owed to it, and
       * reporting `false` there would tell a builder their brochure holds no
       * photograph.
       */
      imageryOutstanding: outcome.imageryOutstanding || Boolean(extraction.imageryDeferred),
      imageryDeferred: extraction.imageryDeferred ?? null,
      completedFields,
      warnings,
      failures: outcome.failures,
    },
    strategy,
    detectedMime: detection.mime,
    byteSize: bytes.length,
    enrichmentPending: outcome.itemIds.length,
    uploadStatus: outcome.failed > 0 ? 'partially_complete' : 'enriching',
    deterministicReading: extraction.deterministicReading ?? null,
    deterministicIgnored: extraction.deterministicIgnored ?? null,
    deterministicPlacement: extraction.deterministicPlacement ?? null,
  };
}

function fail(code: string, message: string, detail?: string): RunImportFailure {
  return { ok: false, code, message, detail, status: 400 };
}
