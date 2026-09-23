/**
 * Builder stock — THE READ OF A DOCUMENT, CARRIED FROM THE ISOLATE THAT OPENED
 * IT TO THE ONES THAT DECODE ITS PICTURES.
 *
 * The rule and the evidence for it are in `documentRead.pure.ts`. This is the
 * IO: where the pictures' bytes go (the upload's own prefix in the stock-list
 * bucket, beside the document they came out of), where the rest goes
 * (`builder_stock_document_reads`, one row per upload and PURPOSE — the
 * importer's and the settler's reads are different readings of one document
 * and never stand in for each other), and the one write that must never lose
 * an answer (`builder_stock_document_read_learn_kinds`, which MERGES a batch
 * of decoded kinds rather than replacing the set).
 *
 * BEST-EFFORT IN EXACTLY ONE DIRECTION. Every failure here answers "there is
 * no read", and the caller then does what every caller did before this
 * existed: it opens the document itself. A read that cannot be written or
 * cannot be restored costs a second parse; it can never cost a wrong picture.
 */
import {
  composeDocumentRead, currentManifest, documentReadPhase, knownKinds,
  kindsOutstanding, planKindDecodes, restoreDocumentRead, worthCarrying,
  KIND_DECODE_BUDGET_MS,
  type DocumentReadManifest, type DocumentReadPhase, type DocumentReadPurpose,
  type DocumentReadSource, type RestoredDocumentRead,
} from './documentRead.pure.ts';
import {
  classifyVisualKind, visualKindCandidates, visualKindPixels,
} from './assessSourceImage.ts';
import { roleDecodeMs } from './importResumeBudget.pure.ts';
import { DETERMINISTIC_READER_VERSION } from './readerVersion.pure.ts';
import { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';
import { sha256Hex } from './rasterPng.ts';
import { sourceWorkUploadId } from './stockLifecycle.pure.ts';
import { classifyClaim, type ClaimClass } from './workAllowance.pure.ts';
import type { VisualKind } from './sourceImageVision.pure.ts';

/** Private, unrestricted by type, and already where the document itself lives. */
const READ_BUCKET = 'builder-stock-lists';
const READ_TABLE = 'builder_stock_document_reads';

/** What a read is valid for: this reader, this extractor. */
export const DOCUMENT_READ_VERSIONS = {
  readerVersion: DETERMINISTIC_READER_VERSION,
  provenanceVersion: PROVENANCE_VERSION,
} as const;

export type WrittenDocumentRead =
  | { written: true; pictures: number; kindCandidates: number; mediaBytes: number }
  | { written: false; reason: string };

/**
 * Write down what reading a document produced.
 *
 * THE BYTES FIRST AND THE ROW LAST, so a row always describes pictures that
 * are already there: a reader that finds the row finds every picture it
 * names, or the integrity check in `restoreDocumentRead` refuses the whole
 * read. A new read replaces the old one's kinds, because they described
 * different bytes or a different extractor.
 */
export async function writeDocumentRead(db: any, input: {
  organisationId: string;
  uploadId: string;
  purpose: DocumentReadPurpose;
  documentSha256: string;
  source: DocumentReadSource;
  /** The importer's decision, on an `import` read. See `importHandover.pure.ts`. */
  handover?: unknown;
}): Promise<WrittenDocumentRead> {
  if (!worthCarrying(input.source)) {
    return { written: false, reason: 'not a paginated document with pictures' };
  }
  try {
    const digests: string[] = [];
    for (const media of input.source.media) digests.push(await sha256Hex(media.bytes));
    const composed = composeDocumentRead({
      organisationId: input.organisationId,
      uploadId: input.uploadId,
      purpose: input.purpose,
      documentSha256: input.documentSha256,
      versions: DOCUMENT_READ_VERSIONS,
      source: input.source,
      digests,
      kindCandidates: visualKindCandidates(input.source.media),
      handover: input.handover,
    });
    if (!composed.ok) return { written: false, reason: composed.reason };
    for (const blob of composed.blobs) {
      const { error } = await db.storage.from(READ_BUCKET).upload(blob.path, blob.bytes, {
        contentType: 'application/octet-stream', upsert: true,
      });
      if (error) {
        return { written: false, reason: `a picture could not be kept: ${String(error.message ?? error).slice(0, 120)}` };
      }
    }
    const { error: rowError } = await db.from(READ_TABLE).upsert({
      upload_id: input.uploadId,
      purpose: input.purpose,
      organisation_id: input.organisationId,
      document_sha256: input.documentSha256,
      manifest: composed.manifest,
      visual_kinds: {},
      media_bytes: composed.mediaBytes,
    }, { onConflict: 'upload_id,purpose' });
    if (rowError) {
      return { written: false, reason: `the read could not be recorded: ${String(rowError.message ?? rowError).slice(0, 120)}` };
    }
    return {
      written: true,
      pictures: composed.manifest.pictures.length,
      kindCandidates: composed.manifest.kindCandidates.length,
      mediaBytes: composed.mediaBytes,
    };
  } catch (error) {
    return { written: false, reason: String((error as { message?: string })?.message ?? error).slice(0, 160) };
  }
}

export interface LoadedDocumentRead {
  manifest: DocumentReadManifest;
  known: Map<number, VisualKind | null>;
  restored: RestoredDocumentRead;
}

/**
 * The current read of this upload's document, restored, or null.
 *
 * Null is the ordinary answer for every upload read before this existed, for
 * a document that has since changed, for a build whose reader or extractor
 * has moved on, and for a read whose pictures no longer check out.
 */
export async function loadDocumentRead(db: any, input: {
  organisationId: string;
  uploadId: string;
  purpose: DocumentReadPurpose;
  documentSha256: string | null | undefined;
}): Promise<LoadedDocumentRead | null> {
  if (!input.documentSha256) return null;
  try {
    const { data: row, error } = await db.from(READ_TABLE)
      .select('document_sha256, manifest, visual_kinds')
      .eq('upload_id', input.uploadId)
      .eq('purpose', input.purpose)
      .eq('organisation_id', input.organisationId)
      .maybeSingle();
    if (error || !row) return null;
    const manifest = currentManifest(
      row, input.documentSha256, DOCUMENT_READ_VERSIONS, input.purpose);
    if (!manifest) return null;
    const bytesByIndex = new Map<number, Uint8Array>();
    const digestsByIndex = new Map<number, string>();
    for (const picture of manifest.pictures) {
      const { data: blob, error: downloadError } = await db.storage
        .from(READ_BUCKET).download(picture.path);
      if (downloadError || !blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      bytesByIndex.set(picture.index, bytes);
      digestsByIndex.set(picture.index, await sha256Hex(bytes));
    }
    const known = knownKinds(row.visual_kinds);
    const restored = restoreDocumentRead({ manifest, bytesByIndex, digestsByIndex, known });
    if (!restored) return null;
    return { manifest, known, restored };
  } catch {
    return null;
  }
}

/**
 * Where an upload's read stands, WITHOUT fetching the read.
 *
 * Asked before a settler takes a `source` claim, to decide which class of
 * isolate may run it. It selects the handful of scalars the answer needs and
 * never the page texts, because the question is asked on the hot path of every
 * claim and the answer must cost a round trip, not a document.
 */
export async function documentReadPhaseFor(db: any, input: {
  uploadId: string;
  purpose: DocumentReadPurpose;
  documentSha256: string | null | undefined;
}): Promise<{ phase: DocumentReadPhase; kindsKnown: number }> {
  const none = { phase: 'read' as const, kindsKnown: 0 };
  if (!input.documentSha256) return none;
  try {
    const { data: row, error } = await db.from(READ_TABLE)
      .select('document_sha256, v:manifest->v, manifestPurpose:manifest->purpose, '
        + 'readerVersion:manifest->readerVersion, '
        + 'provenanceVersion:manifest->provenanceVersion, documentSha256:manifest->documentSha256, '
        + 'kindCandidates:manifest->kindCandidates, visual_kinds')
      .eq('upload_id', input.uploadId)
      .eq('purpose', input.purpose)
      .maybeSingle();
    if (error || !row) return none;
    // The same currency test the full read applies, over the same fields.
    const manifest = currentManifest({
      document_sha256: row.document_sha256,
      manifest: {
        v: row.v, purpose: row.manifestPurpose,
        readerVersion: row.readerVersion, provenanceVersion: row.provenanceVersion,
        documentSha256: row.documentSha256, kindCandidates: row.kindCandidates,
        pictures: [], rows: [], pageTexts: [], rowAssets: [],
      },
    }, input.documentSha256, DOCUMENT_READ_VERSIONS, input.purpose);
    const known = knownKinds(row.visual_kinds);
    return { phase: documentReadPhase(manifest, known), kindsKnown: manifest ? known.size : 0 };
  } catch {
    return none;
  }
}

/**
 * THE CLASS OF A CLAIM, decided before the claim is run.
 *
 * Every stage but `source` is classed by its name, exactly as before — and so
 * is a `source` claim whose document is not a PDF, because only a PDF's
 * parse is an isolate's worth of CPU and only a PDF's pictures are decoded
 * beside it. A PDF's `source` claim is classed by where its document's read
 * stands — see `classifyClaim`. Anything that cannot be read answers the
 * classing it always had, because a wrong guess here costs a hand-off and
 * never a kill.
 */
export async function resolveClaimClass(db: any, item: {
  image_work_stage?: string | null;
  upload_id?: string | null;
  pending_upload_id?: string | null;
}): Promise<ClaimClass> {
  const stage = String(item.image_work_stage ?? 'source');
  if (stage !== 'source') return classifyClaim(stage);
  const uploadId = sourceWorkUploadId(item);
  if (!uploadId) return classifyClaim(stage);
  try {
    const { data: upload, error } = await db.from('builder_stock_uploads')
      .select('file_sha256, original_filename, declared_content_type')
      .eq('id', uploadId)
      .maybeSingle();
    if (error || !upload) return classifyClaim(stage);
    const pdf = String(upload.declared_content_type ?? '').toLowerCase() === 'application/pdf'
      || /\.pdf$/i.test(String(upload.original_filename ?? ''));
    if (!pdf) return classifyClaim(stage);
    const standing = await documentReadPhaseFor(db, {
      uploadId, purpose: 'settle', documentSha256: upload.file_sha256 ?? null,
    });
    return classifyClaim(stage, { ...standing, pdf });
  } catch {
    return classifyClaim(stage);
  }
}

/**
 * Decode the next batch of a read's outstanding kinds and write them back.
 *
 * MERGED, NEVER REPLACED. Two settlers working two properties of one document
 * can each learn a batch at once; `builder_stock_document_read_learn_kinds`
 * adds this batch to whatever is already known, so neither can erase the
 * other's answers. The kinds themselves are deterministic — the same bytes
 * always decode to the same answer — so the worst a race can do is decode a
 * picture twice.
 */
export async function learnOutstandingKinds(db: any, input: {
  uploadId: string;
  purpose: DocumentReadPurpose;
  loaded: LoadedDocumentRead;
  budgetMs?: number;
}): Promise<{ learned: number; outstanding: number; recorded: boolean }> {
  const { manifest, known, restored } = input.loaded;
  const outstanding = kindsOutstanding(manifest, known);
  if (!outstanding.length) return { learned: 0, outstanding: 0, recorded: true };
  const plan = planKindDecodes(
    outstanding,
    (index) => roleDecodeMs(visualKindPixels(restored.media[index] ?? {})),
    input.budgetMs ?? KIND_DECODE_BUDGET_MS,
  );
  const learned: Record<string, VisualKind | null> = {};
  for (const index of plan) {
    const media = restored.media[index];
    if (!media) continue;
    const kind = await classifyVisualKind(media.bytes);
    learned[String(index)] = kind;
    known.set(index, kind);
    media.visualKind = kind;
  }
  let recorded = false;
  try {
    const { data, error } = await db.rpc('builder_stock_document_read_learn_kinds', {
      p_upload_id: input.uploadId,
      p_purpose: input.purpose,
      p_document_sha256: manifest.documentSha256,
      p_kinds: learned,
    });
    recorded = !error && data === true;
  } catch { /* the answers are kept in memory for this isolate either way */ }
  return {
    learned: Object.keys(learned).length,
    outstanding: kindsOutstanding(manifest, known).length,
    recorded,
  };
}

/**
 * Put a read away: its row and the pictures it names.
 *
 * THE ROW FIRST, AND ITS PICTURES FROM WHAT THE ROW SAID. Deleting the row is
 * what makes the read unreachable — `loadDocumentRead` finds nothing and the
 * caller reads the document again — so a picture whose removal then fails is
 * an orphaned object, never a half-read somebody could restore. The paths come
 * back from the delete itself, so this needs no listing and names nothing the
 * row did not.
 *
 * Best-effort: a read that cannot be put away costs storage, never a result.
 */
export async function discardDocumentRead(db: any, input: {
  organisationId: string;
  uploadId: string;
  purpose: DocumentReadPurpose;
}): Promise<{ discarded: boolean; pictures: number }> {
  try {
    const { data, error } = await db.from(READ_TABLE)
      .delete()
      .eq('upload_id', input.uploadId)
      .eq('purpose', input.purpose)
      .eq('organisation_id', input.organisationId)
      .select('manifest');
    if (error || !Array.isArray(data) || !data.length) return { discarded: false, pictures: 0 };
    const paths: string[] = [];
    for (const row of data) {
      const pictures = (row?.manifest as { pictures?: Array<{ path?: unknown }> } | null)?.pictures;
      for (const picture of Array.isArray(pictures) ? pictures : []) {
        // Only a path inside this upload's own read prefix is ever removed.
        const path = String(picture?.path ?? '');
        if (path.startsWith(`stock-lists/${input.organisationId}/${input.uploadId}/document-read/${input.purpose}/`)) {
          paths.push(path);
        }
      }
    }
    if (paths.length) {
      const { error: removeError } = await db.storage.from(READ_BUCKET).remove(paths);
      if (removeError) {
        console.warn('[builderStock] a document read\'s pictures could not be removed', {
          phase: 'document_read_discard', upload_id: input.uploadId, purpose: input.purpose,
          pictures: paths.length,
          detail: String(removeError.message ?? removeError).slice(0, 160),
        });
      }
    }
    return { discarded: true, pictures: paths.length };
  } catch {
    return { discarded: false, pictures: 0 };
  }
}
