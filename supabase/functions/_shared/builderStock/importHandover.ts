/**
 * Builder stock — THE IMPORT'S HAND-OFF OF ITS PICTURES, AS IO.
 *
 * The rule and the evidence are in `importHandover.pure.ts`: an isolate that
 * parsed a PDF decodes none of its pictures, and for a brochure the
 * importer's own attach is the only one that attributes a picture — so the
 * import writes down what it read and decided, and its successor attaches.
 *
 * This is where that goes: the read (the pictures, as the document carries
 * them, and the page texts) in `builder_stock_document_reads` under purpose
 * `import`, and the decision in the same row's manifest, so the two can never
 * describe different attempts. A token binds the row to the checkpoint of the
 * attempt that wrote it.
 *
 * BEST-EFFORT IN EXACTLY ONE DIRECTION, like the read itself. A hand-off that
 * cannot be written leaves the import doing what it did before this existed;
 * one that cannot be taken leaves the successor reading the document again.
 * Neither can put a different reading behind a property.
 */
import {
  discardDocumentRead, loadDocumentRead, writeDocumentRead,
  type LoadedDocumentRead,
} from './documentRead.ts';
import { worthCarrying, type DocumentReadSource } from './documentRead.pure.ts';
import {
  composeImportHandover, readImportHandover, type ImportDecision,
} from './importHandover.pure.ts';

export type HandedOver =
  | { handedOver: true; token: string; pictures: number }
  | { handedOver: false; reason: string };

/**
 * Should this import hand its pictures on at all?
 *
 * Exactly where the read is worth carrying: a PAGINATED document with
 * pictures, which is the one whose read is the PDF engine and whose pictures
 * then need decoding. A spreadsheet, a page, a document with no pictures —
 * none of them decodes anything beside a parse, so each keeps its one
 * invocation.
 */
export function picturesWorthHandingOver(
  source: Pick<DocumentReadSource, 'pageTexts' | 'media'>,
): boolean {
  return worthCarrying(source);
}

/**
 * Write the read and the decision down for a successor.
 *
 * The token is minted here and returned for the caller to record in its
 * checkpoint — AFTER this succeeds, so a checkpoint never names a hand-off
 * that was not written.
 */
export async function handPicturesOver(db: any, input: {
  organisationId: string;
  uploadId: string;
  documentSha256: string;
  source: DocumentReadSource;
  decision: ImportDecision;
}): Promise<HandedOver> {
  const token = crypto.randomUUID();
  const written = await writeDocumentRead(db, {
    organisationId: input.organisationId,
    uploadId: input.uploadId,
    purpose: 'import',
    documentSha256: input.documentSha256,
    source: input.source,
    handover: composeImportHandover(token, input.decision),
  });
  return written.written
    ? { handedOver: true, token, pictures: written.pictures }
    : { handedOver: false, reason: written.reason };
}

export interface TakenHandover {
  decision: ImportDecision;
  loaded: LoadedDocumentRead;
}

/**
 * The read and decision THIS attempt handed on, restored, or null.
 *
 * Null for every way it cannot be trusted whole: no row, a different
 * document, a reader or extractor that has since moved on, a picture that is
 * missing or does not hash to what was recorded, and — the one that matters —
 * a decision minted for a different attempt than the checkpoint names.
 */
export async function takeHandedOverPictures(db: any, input: {
  organisationId: string;
  uploadId: string;
  documentSha256: string;
  token: string;
}): Promise<TakenHandover | null> {
  const loaded = await loadDocumentRead(db, {
    organisationId: input.organisationId,
    uploadId: input.uploadId,
    purpose: 'import',
    documentSha256: input.documentSha256,
  });
  if (!loaded) return null;
  const decision = readImportHandover(loaded.manifest.handover, input.token);
  if (!decision) return null;
  return { decision, loaded };
}

/** Put the hand-off away once the import it served is over. Best-effort. */
export async function discardHandedOverPictures(db: any, input: {
  organisationId: string;
  uploadId: string;
}): Promise<void> {
  await discardDocumentRead(db, { ...input, purpose: 'import' });
}
