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
import type { RowLinkDiscovery } from './suppliedEvidence.pure.ts';
import { importStockRecords } from './importStock.ts';
import { NOTION_NO_PROPERTIES_MESSAGE } from './urlSource.pure.ts';
import type { AnchoredAssets } from './sourceAssets.pure.ts';

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
  if (!rows.length && extraction.visionImages.length) {
    const modelResult = await extractStockRowsFromImages(
      extraction.visionImages,
      { filename: upload.original_filename, organisationName: input.organisationName },
      { deadlineAt: Date.now() + MODEL_BUDGET_MS },
    );
    rows = modelResult.rows;
    strategy = `${strategy}+model`;
  } else if (!rows.length && extraction.text) {
    const modelResult = await extractStockRowsFromText(
      extraction.text,
      { filename: upload.original_filename, organisationName: input.organisationName },
      { deadlineAt: Date.now() + MODEL_BUDGET_MS },
    );
    rows = modelResult.rows;
    strategy = `${strategy}+model`;
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
    return fail('no_properties_found', sourceKind === 'url'
      ? 'No properties could be read from that page. Check that it lists one property per row, or upload the stock list instead.'
      : 'No properties could be read from that file. Check that it lists one property per row with column headings.');
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
