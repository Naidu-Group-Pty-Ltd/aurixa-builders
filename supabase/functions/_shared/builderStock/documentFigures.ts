/**
 * BUILDER STOCK — READ OWED PROPERTIES' FIGURES FROM THEIR OWN BROCHURES.
 *
 * One property at a time, claimed (`claim_builder_stock_document_figures`):
 *
 *   1. fetch the link its photograph came from, as the ladder fetches it;
 *   2. have the PDF worker parse it (`readFigureEvidenceOnWorker`) — the text
 *      reading, whether it presents this design, and which pictures could
 *      print the house's area schedule;
 *   3. where the text gave no floor area and a picture might, recognise those
 *      pictures HERE, with Tesseract (`readFigures`) — this isolate parsed
 *      nothing, so it may decode;
 *   4. decide what the document may give (`decideDocumentFigures`) and record
 *      it (`record_builder_stock_document_figures`), which fills only a column
 *      that is still empty, in the same statement.
 *
 * A read that learned nothing — a fetch that failed, a worker that did not
 * answer — is `retry`, with backoff, and is never a statement about the
 * document. No model is called anywhere on this path.
 */
import {
  DOCUMENT_FIGURES_VERSION, decideDocumentFigures, wantsPicture, retryDelaySeconds,
  readDocumentFiguresRecord, type BrochureFigureEvidence, type DocumentFiguresRecord,
} from './brochureFigures.pure.ts';
import type { FigureReadContext, FigureEvidenceOutcome } from './brochureFigures.ts';
import { isConfirmableBranch } from './brochureConfirmation.pure.ts';
import { driveDownloadUrl, driveFileId } from './drivePackage.pure.ts';
import type { PackageFetcher } from './packageImages.ts';
import type { FigureVerdict, PdfFigure } from './pdfFigures.pure.ts';
import type { PdfOutlineFigure } from './pdfOutlineFigures.pure.ts';

export interface DocumentFigureDeps {
  fetchDocument?: PackageFetcher;
  /** The worker's reading. Injected in tests with the same shared function. */
  readEvidence?: (
    bytes: Uint8Array,
    context: FigureReadContext & { documentName: string; url: string },
  ) => Promise<FigureEvidenceOutcome | { ok: false; reason: string; unreadable?: boolean }>;
  readPictures?: (
    bytes: Uint8Array, figures: readonly PdfFigure[], outlines: readonly PdfOutlineFigure[],
    options: { deadlineAt?: number },
  ) => Promise<{ verdict: FigureVerdict }>;
  now?: () => Date;
}

export interface DocumentFiguresRun {
  /** Properties claimed and answered. */
  read: number;
  /** Columns filled across them. */
  filled: number;
  results: Array<{ id: string; state: string; standing?: string; filled: string[]; reason?: string }>;
}

const defaultFetch: PackageFetcher = async (url) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

const defaultEvidence: NonNullable<DocumentFigureDeps['readEvidence']> = async (bytes, context) => {
  const { readFigureEvidenceOnWorker } = await import('./pdfElectionClient.ts');
  return await readFigureEvidenceOnWorker(bytes, context);
};

const defaultPictures: NonNullable<DocumentFigureDeps['readPictures']> = async (
  bytes, figures, outlines, options,
) => {
  const { readFigures } = await import('./readFigures.ts');
  return await readFigures(bytes, figures, outlines, options);
};

/** How long a claim is held: one document, fetched, read and recognised. */
const LEASE_SECONDS = 150;

export async function readOwedDocumentFigures(
  db: any,
  options: { uploadId?: string | null; organisationId?: string | null; maxItems: number; deadlineAt: number },
  deps: DocumentFigureDeps = {},
): Promise<DocumentFiguresRun> {
  const run: DocumentFiguresRun = { read: 0, filled: 0, results: [] };
  const fetchDocument = deps.fetchDocument ?? defaultFetch;
  const readEvidence = deps.readEvidence ?? defaultEvidence;
  const readPictures = deps.readPictures ?? defaultPictures;
  const now = deps.now ?? (() => new Date());

  while (run.read < options.maxItems && Date.now() < options.deadlineAt - 20_000) {
    const { data, error } = await db.rpc('claim_builder_stock_document_figures', {
      p_version: DOCUMENT_FIGURES_VERSION,
      p_lease_seconds: LEASE_SECONDS,
      p_upload_id: options.uploadId ?? null,
      p_organisation_id: options.organisationId ?? null,
    });
    if (error) throw new Error(`claim_builder_stock_document_figures: ${error.message}`);
    const claimed = Array.isArray(data) ? data[0] : data;
    if (!claimed?.id) break;

    const record = await readOne(claimed, { fetchDocument, readEvidence, readPictures, now,
      deadlineAt: options.deadlineAt });
    const { data: written, error: writeError } = await db.rpc('record_builder_stock_document_figures', {
      p_item_id: claimed.id, p_claim_token: claimed.claim_token, p_record: record,
    });
    if (writeError) throw new Error(`record_builder_stock_document_figures: ${writeError.message}`);
    const filled: string[] = Array.isArray(written?.filled) ? written.filled : [];
    run.read += 1;
    run.filled += filled.length;
    run.results.push({
      id: claimed.id, state: record.state, standing: record.standing, filled,
      ...(record.reason ? { reason: record.reason } : {}),
    });
    try {
      console.info('[builderStock] document figures', {
        stock_item_id: claimed.id, state: record.state, standing: record.standing ?? null,
        reason: record.reason ?? null, read_by: record.read_by ?? null, filled,
      });
    } catch { /* the record is the deliverable */ }
  }
  return run;
}

async function readOne(
  claimed: {
    lot_number?: string | null; house_design?: string | null; document: string;
    confirmed_lots?: string[] | null; previous?: unknown;
  },
  deps: Required<Pick<DocumentFigureDeps, 'fetchDocument' | 'readEvidence' | 'readPictures' | 'now'>>
    & { deadlineAt: number },
): Promise<DocumentFiguresRecord & { reason?: string }> {
  const readAt = deps.now().toISOString();
  const base = { v: DOCUMENT_FIGURES_VERSION, document: claimed.document, read_at: readAt };
  const previous = readDocumentFiguresRecord(claimed.previous);
  const retry = (reason: string): DocumentFiguresRecord & { reason?: string } => {
    const attempts = (previous?.document === claimed.document && previous.state === 'retry'
      ? Number((claimed.previous as { attempts?: unknown })?.attempts ?? 0) : 0) + 1;
    return {
      ...base, state: 'retry', reason, attempts,
      next_attempt_at: new Date(deps.now().getTime() + retryDelaySeconds(attempts) * 1000).toISOString(),
    };
  };
  const answered = (reason: string): DocumentFiguresRecord & { reason?: string } =>
    ({ ...base, state: 'read', standing: 'none', reason, values: {} });

  // A folder's file is chosen by the lot inside it; that is not one document.
  if (!isConfirmableBranch(claimed.document)) return answered('not_one_document');

  let bytes: Uint8Array;
  try {
    const fileId = driveFileId(claimed.document);
    bytes = (await deps.fetchDocument(fileId ? driveDownloadUrl(fileId) : claimed.document)).bytes;
  } catch {
    return retry('fetch_failed');
  }
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return answered('not_a_pdf');
  }

  const read = await deps.readEvidence(bytes, {
    design: claimed.house_design ?? null,
    documentName: 'the linked document',
    url: claimed.document,
  }).catch((error) => ({ ok: false as const, reason: `evidence_failed:${String(error).slice(0, 60)}` }));
  if (!read.ok) {
    // A document the reader parsed and could not read is an answer about it.
    return (read as { unreadable?: boolean }).unreadable ? answered(read.reason) : retry(read.reason);
  }
  const evidence: BrochureFigureEvidence = read.evidence;
  const property = {
    lot_number: claimed.lot_number, house_design: claimed.house_design,
    confirmedLots: claimed.confirmed_lots ?? [],
  };
  let decision = decideDocumentFigures({ evidence, property });
  if (wantsPicture(evidence, decision) && Date.now() < deps.deadlineAt - 15_000) {
    try {
      const pictures = await deps.readPictures(bytes, evidence.figures, evidence.outlines,
        { deadlineAt: deps.deadlineAt - 10_000 });
      if (pictures.verdict.state === 'unavailable') return retry(`pictures_${pictures.verdict.reason}`);
      decision = decideDocumentFigures({ evidence, property, picture: pictures.verdict });
    } catch {
      return retry('pictures_failed');
    }
  }
  return {
    ...base,
    state: 'read',
    standing: decision.standing,
    reason: decision.reason,
    values: decision.values,
    read_by: decision.readBy,
  };
}
