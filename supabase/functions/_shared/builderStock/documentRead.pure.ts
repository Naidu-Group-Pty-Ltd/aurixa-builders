/**
 * Builder stock — A DOCUMENT IS READ IN ONE ISOLATE AND ITS PICTURES ARE
 * DECODED IN ANOTHER.
 *
 * ===========================================================================
 * WHAT PRODUCTION SAID, 23 SEPTEMBER 2026.
 * ===========================================================================
 *
 * `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf` (8,530,307 bytes) was
 * imported through the live portal after the resumable importer shipped, and
 * the runtime killed it again, on both of the portal's paths and in the image
 * settler's re-read of the same bytes (`function_logs`):
 *
 *   05:35:36  process_upload       546  reader done, killed inside the
 *                                        pictures' role decode, no notice
 *   05:40:08  settler re-read      546  `beforeunload` reason "cpu" printed
 *                                        the ledger: document stages 1,155 ms
 *                                        (three parses), image_decode 485 ms —
 *                                        and the hard kill 10 ms later
 *   05:40:42  "Read again"         546  the same place
 *   05:43:07  settler re-read      546  and again at 05:45:08
 *
 * while a settler invocation that parsed the SAME document and decoded
 * nothing (`source`, 4.8 s of wall clock, `decodes: 0`) finished cleanly. On
 * 22 September the same brochure had been killed thirteen times in a row, by
 * the portal and then twelve times by the settler's re-read of it, before one
 * survived.
 *
 * The ledger's own ceiling (3,000 ms) was never reached: the platform charges
 * CPU the ledger cannot see — the isolate's own start-up, the eight-megabyte
 * download, three passes of the PDF engine through a cold JIT. What the
 * evidence does support, without a single number that has to be guessed, is
 * the rule `workAllowance.pure.ts` already measured for the settler on
 * 22 September: every invocation that survived spent its CPU on ONE KIND of
 * heavy work, and the ones that mixed opening a document with decoding a
 * picture were the ones the runtime killed.
 *
 * So the rule is structural, not a threshold: AN ISOLATE THAT PARSED A PDF
 * DECODES NONE OF ITS PICTURES.
 *
 * ===========================================================================
 * WHAT CARRIES THE DOCUMENT ACROSS THE BOUNDARY.
 * ===========================================================================
 *
 * The isolate that reads the document writes down EXACTLY what the read
 * produced — the rows, the row assets, the page texts, the regions, the page
 * order verdict, and every picture's bytes with the metadata the extractor
 * attached to it — and the isolate that decodes restores it and carries on
 * as if it had read the document itself. Nothing is re-derived and nothing is
 * summarised, so no decision downstream can come out differently: the same
 * inputs reach the same code.
 *
 * TWO PARTS OF THE PIPELINE PARSE A PDF, AND BOTH CARRY THEIR READ. The
 * importer (`importHandover.pure.ts`) writes its read beside the reading it
 * decided and hands both to the successor that attaches the pictures; the
 * image settler's `source` stage writes its own and works from it over the
 * claims that follow. They are two different readings of the same bytes — the
 * importer's is taken with evidence the settler's repair has never been
 * handed — so each is kept under its own purpose and never served as the
 * other's (`DocumentReadPurpose`).
 *
 * AND THE ONE EXPENSIVE ANSWER IS KEPT. Deciding what each picture IS (photo,
 * floor plan, graphic) is a decode per picture and the role decision needs all
 * of them. Each answer is written back as it is reached, so the decoding can
 * be spread over as many isolates as it needs and is never done twice — and a
 * `null` ("nothing is known") is kept as an answer, never re-asked.
 *
 * ===========================================================================
 * WHAT MAKES A READ STALE.
 * ===========================================================================
 *
 * A read describes one document, read by one version of the reader, for one
 * version of the picture extractor. Any of the three changing makes it a read
 * of something else, and it is ignored — never merged, never partly trusted —
 * and the document is simply read again. That is the rule
 * `importCheckpoint.pure.ts` applies to recognised text, for the same reason.
 *
 * Pure: no IO, no clock.
 */
import type { AnchoredAssets } from './sourceAssets.pure.ts';
import type { VisualKind } from './sourceImageVision.pure.ts';

/** The shape's own version, so a reader can refuse one it does not know. */
export const DOCUMENT_READ_VERSION = 1;

/**
 * BOUNDS, AND THEY FAIL TOWARDS THE OLD PATH.
 *
 * Past any of them nothing is written and the caller reads and decodes in one
 * invocation, exactly as every invocation did before this existed. A read that
 * cannot be carried is a cost; a row nobody can read is a fault.
 */
export const MAX_DOCUMENT_READ_MEDIA = 64;
/** The JSON half: page texts, regions, rows and picture metadata. */
export const MAX_DOCUMENT_READ_MANIFEST_CHARS = 1_500_000;
/** The bytes half, summed across every picture. */
export const MAX_DOCUMENT_READ_MEDIA_BYTES = 64 * 1024 * 1024;

/**
 * How much picture decoding one isolate takes on while it works through a
 * document's kinds, in the production-measured currency of
 * `ROLE_DECODE_MS_PER_MEGAPIXEL`.
 *
 * TAKEN FROM WHAT SURVIVED, NOT FROM WHAT DIED. Lot 516's 2.5-megapixel hero
 * (about a second of decode) settled in production beside a 10.6 MB document
 * walk (`assessSourceImage.ts`); an isolate that does NOTHING but decode has
 * that and the document's share to spend. At least one picture is always
 * taken, and no picture decoded here exceeds the inline cap, so the worst
 * single step is bounded by that cap rather than by this number.
 */
export const KIND_DECODE_BUDGET_MS = 1_000;

/**
 * How many of a document's pictures the role decision ever looks at.
 *
 * Named HERE, and imported by the decoder (`assessSourceImage.ts`) and by the
 * import's crossing bound (`importCheckpoint.pure.ts`), because both are
 * statements about the same set: the bound on how many isolates the kinds can
 * cost is only a proof while it counts the pictures the decoder actually
 * takes. A cover page carries a handful of unique rasters; twenty-four is
 * generous for a brochure and small enough that a pathological document
 * cannot spend an import's whole allowance on decoding.
 */
export const MAX_KIND_CANDIDATES = 24;

/**
 * The part of a picture's placement the kind decision reads; the rest travels
 * untouched. Structural, so the extractor's own type is carried as it is.
 */
export type MediaPlacement = { placementsOnPage?: number; pagesDrawnOn?: number };

/** One picture, as the read carries it. The bytes travel separately. */
export interface DocumentReadPicture {
  index: number;
  name: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  /** Where the bytes were put, inside the upload's own storage prefix. */
  path: string;
  /** Each optional field is present exactly where the extractor set it. */
  anchor?: string | null;
  enumeration?: unknown;
  provenance?: unknown;
  placement?: MediaPlacement | null;
}

export interface DocumentReadManifest {
  v: number;
  purpose: DocumentReadPurpose;
  readerVersion: number;
  provenanceVersion: number;
  documentSha256: string;
  rows: Array<Record<string, unknown>>;
  rowAssets: AnchoredAssets[];
  pageTexts: string[];
  /** Absent where the extractor produced none; kept absent, never []. */
  pdfRegions: unknown[] | null;
  pageOrderAuthoritative: boolean;
  pictures: DocumentReadPicture[];
  /** The pictures whose kind the role decision reads, in decode order. */
  kindCandidates: number[];
  /**
   * What the IMPORTER decided from this read, on an `import` read alone —
   * opaque here and validated by `importHandover.pure.ts`, which owns it.
   */
  handover?: unknown;
}

/** What one read of a document produced — the extractor's own output, in part. */
export interface DocumentReadSource {
  rows: Array<Record<string, unknown>>;
  rowAssets: AnchoredAssets[];
  pageTexts: string[];
  pdfRegions?: unknown[] | null;
  pageOrderAuthoritative?: boolean;
  media: Array<{
    name: string;
    bytes: Uint8Array;
    contentType: string;
    anchor?: string | null;
    enumeration?: unknown;
    provenance?: unknown;
    placement?: MediaPlacement | null;
  }>;
}

export interface DocumentReadVersions {
  readerVersion: number;
  provenanceVersion: number;
}

/**
 * WHOSE READ THIS IS — and the two are never interchangeable.
 *
 *   `import`  the IMPORTER's read: taken with the organisation's name and the
 *             document's own name as evidence, and carrying the reading the
 *             importer decided. Consumed by the import's successor and
 *             discarded when the import is over. See `importHandover.pure.ts`.
 *   `settle`  the image settler's read, taken the way its source repair has
 *             always read a stored document.
 *
 * The two produce DIFFERENT rows from the same bytes, because the importer
 * reads with evidence the settler's repair has never been handed. Serving one
 * as the other would put a different reading behind the same property, so
 * the purpose is part of every key: the table's, every picture's path, and
 * the manifest's own.
 */
export type DocumentReadPurpose = 'import' | 'settle';

/** Where a picture of a read is kept: inside the upload's own prefix. */
export function documentReadPicturePath(
  organisationId: string, uploadId: string, purpose: DocumentReadPurpose,
  documentSha256: string, index: number,
): string {
  return `stock-lists/${organisationId}/${uploadId}/document-read/${purpose}/${documentSha256}/${index}`;
}

const OPTIONAL_KEYS = ['anchor', 'enumeration', 'provenance', 'placement'] as const;

export type ComposedDocumentRead =
  | {
    ok: true;
    manifest: DocumentReadManifest;
    blobs: Array<{ path: string; bytes: Uint8Array }>;
    mediaBytes: number;
  }
  | { ok: false; reason: string };

/**
 * Write a read down, or say why it cannot be.
 *
 * `digests` is each picture's SHA-256, by index — hashed by the caller, which
 * has the async digest this module must not reach for. `kindCandidates` is
 * `visualKindCandidates` over the same media — computed by the caller because
 * it reads headers, and stored so every later isolate agrees on which
 * pictures the role decision needs without re-deciding it.
 */
export function composeDocumentRead(input: {
  organisationId: string;
  uploadId: string;
  purpose: DocumentReadPurpose;
  documentSha256: string;
  versions: DocumentReadVersions;
  source: DocumentReadSource;
  digests: readonly string[];
  kindCandidates: number[];
  /** The importer's decision, on an `import` read. See `DocumentReadManifest.handover`. */
  handover?: unknown;
}): ComposedDocumentRead {
  const { source } = input;
  if (!/^[0-9a-f]{64}$/.test(input.documentSha256)) {
    return { ok: false, reason: 'the document has no digest to key a read on' };
  }
  if (source.media.length > MAX_DOCUMENT_READ_MEDIA) {
    return { ok: false, reason: `the document carries ${source.media.length} pictures` };
  }
  let mediaBytes = 0;
  const pictures: DocumentReadPicture[] = [];
  const blobs: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [index, media] of source.media.entries()) {
    if (!(media.bytes instanceof Uint8Array)) {
      return { ok: false, reason: `picture ${index} has no bytes` };
    }
    const digest = input.digests[index];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: `picture ${index} has no digest` };
    }
    mediaBytes += media.bytes.length;
    const path = documentReadPicturePath(
      input.organisationId, input.uploadId, input.purpose, input.documentSha256, index);
    const picture: DocumentReadPicture = {
      index,
      name: media.name,
      contentType: media.contentType,
      byteSize: media.bytes.length,
      sha256: digest,
      path,
    };
    for (const key of OPTIONAL_KEYS) {
      if (media[key] !== undefined) (picture as unknown as Record<string, unknown>)[key] = media[key];
    }
    pictures.push(picture);
    blobs.push({ path, bytes: media.bytes });
  }
  if (mediaBytes > MAX_DOCUMENT_READ_MEDIA_BYTES) {
    return { ok: false, reason: `the document's pictures total ${mediaBytes} bytes` };
  }
  const manifest: DocumentReadManifest = {
    v: DOCUMENT_READ_VERSION,
    purpose: input.purpose,
    readerVersion: input.versions.readerVersion,
    provenanceVersion: input.versions.provenanceVersion,
    documentSha256: input.documentSha256,
    rows: source.rows,
    rowAssets: source.rowAssets,
    pageTexts: source.pageTexts,
    pdfRegions: source.pdfRegions ?? null,
    pageOrderAuthoritative: source.pageOrderAuthoritative !== false,
    pictures,
    kindCandidates: [...input.kindCandidates],
    ...(input.handover !== undefined ? { handover: input.handover } : {}),
  };
  const chars = JSON.stringify(manifest).length;
  if (chars > MAX_DOCUMENT_READ_MANIFEST_CHARS) {
    return { ok: false, reason: `the read would be ${chars} characters` };
  }
  return { ok: true, manifest, blobs, mediaBytes };
}

/** A stored row, as a reader of the table sees it. */
export interface StoredDocumentRead {
  document_sha256?: unknown;
  manifest?: unknown;
  visual_kinds?: unknown;
}

/**
 * The manifest a stored row offers for THIS document under THIS build, or null.
 *
 * Null for: nothing stored, an unreadable shape, a format this build does not
 * know, a read taken for the other purpose, a read of a different document,
 * and a read taken by a different reader or extractor version.
 */
export function currentManifest(
  row: StoredDocumentRead | null | undefined,
  documentSha256: string | null | undefined,
  versions: DocumentReadVersions,
  purpose: DocumentReadPurpose,
): DocumentReadManifest | null {
  if (!row || !documentSha256) return null;
  if (row.document_sha256 !== documentSha256) return null;
  const manifest = row.manifest as Partial<DocumentReadManifest> | null | undefined;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (manifest.v !== DOCUMENT_READ_VERSION) return null;
  // Asked of the manifest as well as the row's key: a read written for one
  // purpose is never served as the other's, whichever way it was fetched.
  if (manifest.purpose !== purpose) return null;
  if (manifest.documentSha256 !== documentSha256) return null;
  if (manifest.readerVersion !== versions.readerVersion) return null;
  if (manifest.provenanceVersion !== versions.provenanceVersion) return null;
  if (!Array.isArray(manifest.pictures) || !Array.isArray(manifest.rows)
    || !Array.isArray(manifest.pageTexts) || !Array.isArray(manifest.kindCandidates)
    || !Array.isArray(manifest.rowAssets)) {
    return null;
  }
  return manifest as DocumentReadManifest;
}

const KINDS: ReadonlySet<string> = new Set(['photo', 'floorplan', 'graphic']);

/**
 * The kinds already reached, by picture index. A value that is not a known
 * kind and not null is ignored rather than trusted — it becomes "not yet
 * decoded", which costs a decode and never a wrong answer.
 */
export function knownKinds(stored: unknown): Map<number, VisualKind | null> {
  const out = new Map<number, VisualKind | null>();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    if (value === null) out.set(index, null);
    else if (typeof value === 'string' && KINDS.has(value)) out.set(index, value as VisualKind);
  }
  return out;
}

/** The candidates whose kind nobody has reached yet, in decode order. */
export function kindsOutstanding(
  manifest: Pick<DocumentReadManifest, 'kindCandidates'>,
  known: ReadonlyMap<number, VisualKind | null>,
): number[] {
  return manifest.kindCandidates.filter((index) => !known.has(index));
}

/**
 * Which outstanding pictures THIS isolate decodes.
 *
 * In decode order, at least one, then as many more as fit the budget — so an
 * isolate always advances and never takes on a decode the budget says will
 * not fit beside the ones it already took.
 */
export function planKindDecodes(
  outstanding: readonly number[],
  estimateMs: (index: number) => number,
  budgetMs = KIND_DECODE_BUDGET_MS,
): number[] {
  const plan: number[] = [];
  let spent = 0;
  for (const index of outstanding) {
    const cost = Math.max(0, estimateMs(index));
    if (plan.length > 0 && spent + cost > budgetMs) break;
    plan.push(index);
    spent += cost;
  }
  return plan;
}

/**
 * Where an item's `source` work stands, which is what decides the CLASS of
 * the isolate it may run in:
 *
 *   `read`    no current read: the document must be opened (document class)
 *   `kinds`   read, but some pictures' kinds are still to be decoded (decode)
 *   `attach`  read and every kind known: attach the pictures (decode)
 */
export type DocumentReadPhase = 'read' | 'kinds' | 'attach';

export function documentReadPhase(
  manifest: DocumentReadManifest | null,
  known: ReadonlyMap<number, VisualKind | null>,
): DocumentReadPhase {
  if (!manifest) return 'read';
  return kindsOutstanding(manifest, known).length ? 'kinds' : 'attach';
}

export interface RestoredDocumentRead {
  rows: Array<Record<string, unknown>>;
  rowAssets: AnchoredAssets[];
  pageTexts: string[];
  pdfRegions: unknown[] | undefined;
  pageOrderAuthoritative: boolean;
  media: Array<{
    name: string;
    bytes: Uint8Array;
    contentType: string;
    anchor?: string | null;
    enumeration?: unknown;
    provenance?: unknown;
    placement?: MediaPlacement | null;
    visualKind?: VisualKind | null;
  }>;
}

/**
 * Put a read back together, or refuse.
 *
 * INTEGRITY FIRST. Every picture's bytes must be present and hash to what the
 * reading isolate recorded; one that does not makes the WHOLE read unusable,
 * because a role decision over a set missing a member is a decision on
 * partial evidence. The caller then reads the document again.
 */
export function restoreDocumentRead(input: {
  manifest: DocumentReadManifest;
  bytesByIndex: ReadonlyMap<number, Uint8Array>;
  /** Each downloaded picture's SHA-256, by index, hashed by the caller. */
  digestsByIndex: ReadonlyMap<number, string>;
  known: ReadonlyMap<number, VisualKind | null>;
}): RestoredDocumentRead | null {
  const media: RestoredDocumentRead['media'] = [];
  for (const picture of input.manifest.pictures) {
    const bytes = input.bytesByIndex.get(picture.index);
    if (!bytes || bytes.length !== picture.byteSize) return null;
    if (input.digestsByIndex.get(picture.index) !== picture.sha256) return null;
    const entry: RestoredDocumentRead['media'][number] = {
      name: picture.name,
      bytes,
      contentType: picture.contentType,
    };
    for (const key of OPTIONAL_KEYS) {
      if (key in picture) (entry as unknown as Record<string, unknown>)[key] = picture[key];
    }
    if (input.known.has(picture.index)) entry.visualKind = input.known.get(picture.index) ?? null;
    media.push(entry);
  }
  // Pictures are stored in document order and indexed from zero; a gap is a
  // read that was written by something else.
  if (media.length !== input.manifest.pictures.length) return null;
  return {
    rows: input.manifest.rows,
    rowAssets: input.manifest.rowAssets,
    pageTexts: input.manifest.pageTexts,
    pdfRegions: input.manifest.pdfRegions ?? undefined,
    pageOrderAuthoritative: input.manifest.pageOrderAuthoritative !== false,
    media,
  };
}

/**
 * Should this read be taken at all?
 *
 * Only a PAGINATED document with pictures is worth carrying: it is the one
 * whose read is expensive (the PDF engine) AND whose pictures then need
 * decoding. A spreadsheet reads in milliseconds and a document with no
 * pictures has nothing to decode, so both keep their single invocation.
 */
export function worthCarrying(source: Pick<DocumentReadSource, 'pageTexts' | 'media'>): boolean {
  return source.pageTexts.length > 0 && source.media.length > 0;
}
