/**
 * Builder stock — what a property can HONESTLY say about its picture.
 *
 * THE REPORT, VERBATIM: "if there its running on the backend. There needs to
 * be some kind of indication to let the users know that its running on the
 * backend please wait or some kind of progress bar."
 *
 * PRODUCTION, 4 SEPTEMBER 2026. Three properties on one screen, all three
 * reading "No image yet", and no two of them for the same reason:
 *
 *   Lot 5629 The Grove   a package recovery was RUNNING, started 03:21
 *   Lot 521 Timbarra     four documents read, none presents a cover
 *   Lot 123 Solara       three documents read, one is an image not a package
 *
 * The first is work in flight and the words are a lie by omission — the row
 * looked exactly like a row nothing would ever happen to, so the honest thing
 * for a person to do was assume the product was broken and re-upload the list.
 * Which is what happened, twice, and re-uploading is what destroyed a repaired
 * photograph earlier the same morning.
 *
 * THE RULE. A row says "still looking" when the engine still owes it a stage,
 * and says the picture is not coming only when the engine has FINISHED and
 * come back with nothing. The two are different sentences because they call
 * for different actions: wait, or fix the row's documents.
 *
 * `settled` is the finished stage — the ladder's last rung — so anything else
 * is work outstanding. An unrecognised stage reads as WORKING rather than as
 * finished, because a stage this module has not been taught about is one the
 * engine may still act on, and promising "no picture is coming" about a row
 * the engine is about to photograph is the failure worth avoiding.
 *
 * Pure: no IO, no clock.
 */
import { isPrimaryRole, readStoredRole } from './sourceImageRole.pure.ts';

/** The ladder's last rung. Everything before it is work outstanding. */
export const SETTLED_WORK_STAGE = 'settled';

export type StockImageProgress =
  /** A picture is on the card. Nothing is owed. */
  | 'drawn'
  /** The engine still owes this property a stage. Wait. */
  | 'working'
  /** Finished, and the row attaches no document to read a picture out of. */
  | 'no_document'
  /**
   * Finished, and at least one of this row's documents was never actually
   * READ — we could not open it, or opening it failed.
   *
   * SEPARATE FROM `none_found` BECAUSE IT IS A DIFFERENT SENTENCE ABOUT A
   * DIFFERENT THING. `none_found` is a finding about the builder's document;
   * this is a fact about us reaching it. Collapsing the two is what told six
   * properties on the 7 September upload that their brochures contained no
   * photograph, when the brochures each hold a facade render that this same
   * extractor elects in about a second — the worker had died reading them and
   * the card reported that as the document's own answer.
   *
   * It never names a mechanism. A crash, a memory ceiling, a timeout and a
   * retry count are this pipeline's vocabulary and a builder can do nothing
   * with any of them; what they are owed is that the document has not been
   * read yet and that this is being retried.
   */
  | 'unreadable'
  /**
   * Finished, and one of this row's documents could not be REACHED — it 404s,
   * it wants a sign-in, it is not a document. A fact about the link, and the
   * one failure on this list a builder can actually act on.
   */
  | 'source_unavailable'
  /** Finished, the documents were read, and none of them names a picture. */
  | 'none_found';

export interface StockImageProgressInput {
  /** Whether the card has a picture to draw. */
  hasImage: boolean;
  /** How many readable documents this property's own row attaches. */
  sourceDocuments: number;
  /**
   * `image_work_stage`. Absent for a deployment whose projection predates
   * this — which reads as FINISHED, because that is how those rows behaved
   * before the field existed and inventing progress for them would be worse
   * than the silence it replaces.
   */
  workStage?: string | null;
  /**
   * How many of this row's documents OUR processing failed on. Supplied by
   * the server, which is the only side that can see why a branch stopped; the
   * client is handed a count and never a reason, so no mechanism can reach a
   * screen through this field.
   */
  unprocessedDocuments?: number;
  /** How many could not be reached at all — a 404, a sign-in wall, not a
   *  document. Counted apart because only this one is the builder's to fix. */
  unreachableDocuments?: number;
}

/** What this property's imagery honestly amounts to right now. */
export function stockImageProgress(input: StockImageProgressInput): StockImageProgress {
  if (input.hasImage) return 'drawn';
  /*
   * A row with no stage at all is not "working". The field arrived with this
   * change, so an older projection would otherwise turn every pictureless row
   * on the page into a promise that something is about to happen.
   */
  const stage = typeof input.workStage === 'string' ? input.workStage.trim() : '';
  if (stage && stage !== SETTLED_WORK_STAGE) return 'working';
  if (input.sourceDocuments <= 0) return 'no_document';
  /*
   * A DOCUMENT WE NEVER READ IS NOT A DOCUMENT THAT SAID NOTHING, and this is
   * the one line that keeps those two apart on screen. Checked before
   * `none_found`, because a row where one document failed and the others were
   * read has NOT established that its documents name no picture.
   */
  /*
   * OUR FAILURE FIRST, because the two call for opposite things from the
   * reader. A document we could not PROCESS is ours to fix and asking the
   * builder to check their link would send them after a file that is fine; a
   * document we could not REACH is theirs, and telling them it is retried
   * automatically would be false — an unreachable link retires on its own
   * budget and a better worker never re-chases it.
   */
  const unprocessed = Number(input.unprocessedDocuments ?? 0);
  if (Number.isFinite(unprocessed) && unprocessed > 0) return 'unreadable';
  const unreachable = Number(input.unreachableDocuments ?? 0);
  if (Number.isFinite(unreachable) && unreachable > 0) return 'source_unavailable';
  return 'none_found';
}

/**
 * The words each state gets, and why they are these words.
 *
 * `working` never names a stage — "sanitization" and "eligibility" are this
 * pipeline's vocabulary, not a builder's, and a person waiting on a
 * photograph is owed the fact that it is coming rather than a term they would
 * have to look up. The two finished states each name the ACT that would
 * change them, because a status nobody can act on is just an apology.
 */
export const STOCK_IMAGE_PROGRESS_LABEL: Record<StockImageProgress, string> = {
  drawn: 'Image ready',
  working: 'Finding a picture…',
  no_document: 'No brochure on this row',
  unreadable: 'Picture not available yet',
  source_unavailable: 'A linked document could not be opened',
  none_found: 'No picture in the supplied documents',
};

/**
 * THE SAME STATES, IN THE WIDTH A CHIP ACTUALLY HAS.
 *
 * The builder's Stock List gives its Images column 15% of a table that only
 * renders at 1400px and up, which is 154px of text after the chip's icon and
 * padding. MEASURED in a browser against the built stylesheet, four of these
 * six fit that and two do not: `A linked document could not be opened` wants
 * 220px and `No picture in the supplied documents` wants 207px, so both were
 * drawn clipped — the second reading `No picture in the s…`, which states
 * nothing at all and is the defect this fixes.
 *
 * The four that fit KEEP THEIR WORDS. Only the two that cannot are shortened,
 * and they are shortened rather than truncated so the chip still says which
 * of the three no-picture states this is: nothing attached, not read yet, a
 * link that would not open, or read and no photograph in it. The full
 * sentence is not lost — it stays on the chip as its accessible name and the
 * detail below it is still the `title`.
 *
 * This mirrors `STOCK_IMAGE_STAGE_SHORT_LABELS` in the page that draws it,
 * which exists for the same reason.
 */
export const STOCK_IMAGE_PROGRESS_BADGE: Record<StockImageProgress, string> = {
  drawn: 'Image ready',
  working: 'Finding a picture…',
  no_document: 'No brochure on this row',
  unreadable: 'Picture not available yet',
  // Still points at the link, because that failure is the link's.
  source_unavailable: 'Link unavailable',
  // Still a finding about the documents, because here one was reached.
  none_found: 'No picture found',
};

export const STOCK_IMAGE_PROGRESS_DETAIL: Record<StockImageProgress, string> = {
  drawn: 'This property has a picture on its card.',
  working: 'The documents on this row are being read now. '
    + 'This finishes on its own — the page updates when it does.',
  no_document: 'This stock list attaches no brochure or plan to this property. '
    + 'Add a link to its row and the photograph is read from it.',
  /*
   * NEUTRAL AND TERMINAL, and deliberately asks the builder for nothing. The
   * documents on this row are fine; we did not finish reading one. Promising
   * a retry would be a promise about our own release schedule, and pointing
   * at the link would send somebody to check a file that was never the
   * problem — which is the softer version of the lie this state exists to
   * end. So it says only what is true, and offers the one act that always
   * works.
   */
  unreadable: 'This property does not have a picture from its documents yet. '
    + 'You can add one with “Add picture”.',
  source_unavailable: 'A document linked on this row could not be opened — it '
    + 'may have been moved, deleted, or not shared. Check the link opens for '
    + 'anyone with it, or add a picture with “Add picture”.',
  none_found: 'Every document on this row was read and none of them presents a '
    + "photograph of this property. Add a picture with “Add picture”, or link a "
    + 'brochure that shows the house.',
};

/** How many properties on a page are still being worked. */
export function countWorkingImages(
  items: readonly StockImageProgressInput[],
): number {
  return items.filter((item) => stockImageProgress(item) === 'working').length;
}

/**
 * The upload statuses that mean properties may still be ARRIVING.
 *
 * A replacement stock list writes its new properties invisible and publishes
 * them only once their imagery has been looked for — which is what stops a
 * marketplace filling with blank cards mid-import. The cost is a window in
 * which a list that detected 125 rows shows 95, with the other thirty staged
 * and unlistable, and nothing on the page accounting for the difference.
 *
 * That window is exactly where somebody concludes the import dropped their
 * rows and uploads the file again. It is the same missing sentence as a row
 * that says "No image yet" while being read, one level up.
 */
const ARRIVING_UPLOAD_STATUSES: readonly string[] = [
  'uploaded', 'parsing', 'imported', 'enriching',
];

/** Is this stock list still bringing properties in? */
export function uploadIsArriving(status: string | null | undefined): boolean {
  return ARRIVING_UPLOAD_STATUSES.includes(String(status ?? '').trim());
}

/** How many of these stock lists are still bringing properties in. */
export function countArrivingUploads(
  uploads: readonly { status?: string | null; deleted_at?: string | null }[],
): number {
  return uploads.filter(
    (upload) => !upload.deleted_at && uploadIsArriving(upload.status),
  ).length;
}

/**
 * How many of a row's documents we could not read, SPLIT BY WHOSE FAILURE.
 *
 * THE ONE PLACE THAT LOOKS AT WHY A BRANCH STOPPED, and it is deliberately
 * server-side: the client is handed the resulting COUNT and never the reason,
 * so a mechanism — a kill, a memory ceiling, a timeout, an attempt tally —
 * has no route to a screen.
 *
 * `unprocessed` is ours: a step that began and never returned, or a
 * retirement stamped with the runtime that failed. `unreachable` is the
 * link's: a 404, a sign-in wall, something that is not a document. They are
 * counted apart because they call for opposite things from the reader — one
 * is ours to fix and asks nothing, the other is worth checking a link over.
 *
 * An `inspected` retirement is NEITHER: that one was read, and what it says
 * about the document is true.
 */
export function unreadDocumentCount(storedProvenance: unknown): {
  unprocessed: number; unreachable: number;
} {
  const root = storedProvenance as { branches?: Record<string, unknown> } | null;
  const branches = root && typeof root === 'object' ? root.branches : null;
  if (!branches || typeof branches !== 'object') return { unprocessed: 0, unreachable: 0 };
  let unprocessed = 0;
  let unreachable = 0;
  for (const value of Object.values(branches)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as {
      result?: unknown; exhaustion?: unknown; runtime_version?: unknown;
    };
    // A step that began and never came back: the shape a kill leaves.
    if (record.result === 'package_recovery_attempt') { unprocessed += 1; continue; }
    if (record.result !== 'no_deterministic_image') continue;
    if (record.exhaustion !== 'operational') continue;
    /*
     * BOTH KINDS ARE `operational`, AND THE STAMP IS WHAT SEPARATES THEM.
     * `recordPackageUnprocessable` writes a `runtime_version` because the
     * worker is what failed; `recordPackageUnreachable` deliberately does not,
     * because a 404 is not something a better worker opens. That single field
     * is therefore the honest test for whose failure this was — and it is the
     * same field the runtime re-arm keys on, so the screen and the queue
     * cannot disagree about which documents are ours to fix.
     */
    if (record.runtime_version === undefined || record.runtime_version === null) {
      unreachable += 1;
    } else {
      unprocessed += 1;
    }
  }
  return { unprocessed, unreachable };
}

/**
 * WHAT A READ DOCUMENT ACTUALLY SAID, FOR THE BUILDER WHO CAN FIX IT.
 *
 * Every refusal already records a `detail`, and `negativeProvenance.pure.ts`
 * documents that field as "safe to surface: why the package named nothing".
 * Nothing ever surfaced it. So a row whose brochure is for a DIFFERENT
 * property read exactly like a row whose brochure has no photograph in it —
 * both said "No picture found" — and the only person who could correct the
 * sheet was the one person never told anything was wrong with it.
 *
 * MEASURED, 11 SEPTEMBER 2026: `Lot 1037 Wollert Rise · Vanta 20` links a
 * document whose own cover reads `NEX 20 — Lot 1307 Fuchsia Street`. It is a
 * second copy of the sibling row's brochure, and the facade render inside the
 * two is byte-identical. The election read it, refused it because the cover
 * names another property, and recorded precisely that. The builder saw a
 * shrug.
 *
 * ONLY `inspected` REFUSALS TRAVEL. That is the whole safety rule and it is
 * the same one `unreadDocumentCount` keeps: an `inspected` answer is
 * knowledge about the BUILDER'S DOCUMENT and theirs to act on, while an
 * `operational` one is knowledge about US — a kill, a ceiling, a timeout —
 * and a builder can do nothing with it except distrust a file that is fine.
 * A count is all that has ever been allowed to leave for those, and that does
 * not change here.
 *
 * Bounded because a row can link many documents and a status line is not a
 * log: the first few are what a person acts on, and the rest would be scroll.
 */
export interface StockDocumentNote {
  /** The document this is about, as the builder's own sheet names it. */
  document: string;
  /** The recorded reason, verbatim. Never composed here. */
  detail: string;
}

/** At most this many notes reach a row. A status line, not a log. */
export const MAX_STOCK_DOCUMENT_NOTES = 4;

export function stockDocumentNotes(
  storedProvenance: unknown,
  limit: number = MAX_STOCK_DOCUMENT_NOTES,
): StockDocumentNote[] {
  const root = storedProvenance as { branches?: Record<string, unknown> } | null;
  const branches = root && typeof root === 'object' ? root.branches : null;
  if (!branches || typeof branches !== 'object') return [];
  const notes: StockDocumentNote[] = [];
  for (const [key, value] of Object.entries(branches)) {
    if (notes.length >= Math.max(0, limit)) break;
    if (!value || typeof value !== 'object') continue;
    const record = value as { result?: unknown; exhaustion?: unknown; detail?: unknown };
    if (record.result !== 'no_deterministic_image') continue;
    // The one gate. `operational` is ours and never leaves this side.
    if (record.exhaustion !== 'inspected') continue;
    const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
    if (!detail) continue;
    notes.push({ document: documentLabel(key), detail });
  }
  return notes;
}

/**
 * The document, as a person would name it.
 *
 * A branch key is the link the builder's own sheet carried, and a Drive URL
 * says nothing to anybody. Where the link has a readable file name it is
 * used; otherwise the host, so the note still points at something. No id is
 * printed: `1rE8rvWHNN1KDtJvO_0bP2i8-TZyeS3O0` is not a document to a reader.
 */
function documentLabel(reference: string): string {
  const raw = String(reference ?? '').trim();
  if (!raw) return 'A linked document';
  let host = '';
  let path = raw;
  try {
    const url = new URL(raw);
    host = url.hostname.replace(/^www\./, '');
    path = decodeURIComponent(url.pathname);
  } catch {
    // Not a URL. Whatever it is, it is still what the sheet said.
  }
  const last = path.split('/').filter(Boolean).pop() ?? '';
  if (/\.(pdf|png|jpe?g|webp|docx?|xlsx?)$/i.test(last)) return last;
  return host ? `A document on ${host}` : 'A linked document';
}

// ---------------------------------------------------------------------------
// WHEN THE STOCK LIST *IS* THE DOCUMENT
// ---------------------------------------------------------------------------

/**
 * The package documents this property's own IMAGES came out of, and why any
 * of them named no picture.
 *
 * MEASURED 11 SEPTEMBER 2026, and it is the reason a builder uploaded the
 * same 10 MB brochure twice. `source_documents` is counted with
 * `rowSourceBranches(row.source_row.unmapped)` — the LINKS a spreadsheet row
 * carries in its cells. A stock list that IS a package PDF has no such link:
 * `unmapped` is `{}`. So the count is zero, `stockImageProgress` answers
 * `no_document`, and the page says
 *
 *     "No brochure on this row"
 *     "This stock list attaches no brochure or plan to this property."
 *
 * about a property built out of a brochure, whose two page-1 rasters are
 * sitting in the images table. It is not merely unhelpful, it is FALSE, and
 * it tells the one person who could fix the real problem to go and do the one
 * thing that cannot help. They did it twice; the second upload was
 * byte-identical to the first (`sha256 be95c902…`, 10,239,959 bytes both
 * times), so nothing could possibly have changed.
 *
 * The same blindness hides the reason. `stockDocumentNotes` reads the branch
 * records, and branches exist only for LINKED documents — so the election's
 * recorded refusal, which for an uploaded package lives on the image rows as
 * `selection_reason`, reached no screen at all. On the live row it reads
 * "no page states this property's identity together with its package
 * information": the row is `Lot 1037 Fuchsia Street` (taken from the file's
 * NAME) while the document's own cover states a different lot. One sentence
 * on screen turns that into a thirty-second correction.
 *
 * So a document is a document however it arrived. This reads the images'
 * own provenance — `origin: "document_media"` and the filename each was
 * extracted from — because that is the record that proves the document was
 * READ, rather than a second opinion about what the row attaches.
 */
export interface StockPackageDocuments {
  /** Distinct package documents this property's images were extracted from. */
  documents: string[];
  /** Why each one named no picture. Empty for a document that yielded one. */
  notes: StockDocumentNote[];
}

/** Provenance said the image came out of a document rather than off the web. */
const DOCUMENT_MEDIA_ORIGIN = 'document_media';

export function stockPackageDocuments(
  images: unknown,
  limit = MAX_STOCK_DOCUMENT_NOTES,
): StockPackageDocuments {
  const empty: StockPackageDocuments = { documents: [], notes: [] };
  if (!Array.isArray(images)) return empty;

  /** filename → did any image from it become this property's designated hero. */
  const elected = new Map<string, boolean>();
  /** filename → the refusal the election recorded against it. */
  const refusal = new Map<string, string>();

  for (const image of images) {
    const detail = (image as { source_detail?: unknown } | null)?.source_detail;
    if (!detail || typeof detail !== 'object') continue;
    const record = detail as Record<string, unknown>;
    if (record.origin !== DOCUMENT_MEDIA_ORIGIN) continue;
    const name = String(record.filename ?? '').trim();
    if (!name) continue;

    if (!elected.has(name)) elected.set(name, false);
    if (isPrimaryRole(readStoredRole(record))) elected.set(name, true);

    /*
     * The FIRST reason recorded for a document, not the last. Every image the
     * election declined carries the same sentence — it is a statement about
     * the document, written once per run — so any of them is the answer and
     * overwriting it would only churn.
     */
    const reason = String(record.selection_reason ?? '').trim();
    if (reason && !refusal.has(name)) refusal.set(name, reason);
  }

  const documents = [...elected.keys()];
  const bounded = Math.max(0, Math.trunc(limit));
  const notes: StockDocumentNote[] = [];
  for (const name of documents) {
    if (notes.length >= bounded) break;
    if (elected.get(name)) continue;
    const reason = refusal.get(name);
    if (!reason) continue;
    notes.push({
      document: name,
      /*
       * The recorded clause, in a sentence. `pdfPrimaryImage.pure.ts` composes
       * it "in the source's own terms" — what the document does or does not
       * say — and never in ours, which is what makes it safe to surface under
       * the same rule the branch notes travel by.
       */
      detail: `Nothing in that document is presented as this property’s picture: ${reason}.`,
    });
  }
  return { documents, notes };
}
