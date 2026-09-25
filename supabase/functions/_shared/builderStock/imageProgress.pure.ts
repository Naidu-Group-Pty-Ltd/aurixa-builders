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
import {
  DOCUMENT_IDENTITY_MISMATCH, IDENTITY_CONFIRMATION_KEY, NO_DETERMINISTIC_IMAGE,
  isDocumentFinding, type DocumentFinding,
} from './negativeProvenance.pure.ts';
import {
  brochureInUseByAnotherProperty, confirmedLotOf, isConfirmableBranch, sameDocument,
  statedLotListing, type ListingReference, type StockRowForConfirmation,
} from './brochureConfirmation.pure.ts';

/** The ladder's last rung. Everything before it is work outstanding. */
export const FAILED_WORK_STAGE = 'failed';
export const SETTLED_WORK_STAGE = 'settled';

export type StockImageProgress =
  /** A picture is on the card. Nothing is owed. */
  | 'drawn'
  /** The engine still owes this property a stage. Wait. */
  | 'working'
  /**
   * Processing is exhausted and a PERSON is owed — the terminal 'failed'
   * work stage. Distinct from `working` (nothing further happens on its
   * own) and from `none_found` (the documents were never the problem).
   */
  | 'attention'
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
  /*
   * TERMINAL FAILURE IS NOT "WORKING". The 'failed' stage means our
   * processing gave out and support is on it; reading it as `working` would
   * put "Finding a picture…" back on a card nothing is finding a picture
   * for — the exact indefinite spinner this taxonomy exists to end.
   */
  const unprocessed = Number(input.unprocessedDocuments ?? 0);
  const unreachable = Number(input.unreachableDocuments ?? 0);
  if (stage === FAILED_WORK_STAGE) {
    /*
     * AND WHOSE TERMINAL FAILURE IT IS, BECAUSE THE TWO ASK OPPOSITE THINGS.
     *
     * `attention` says "our team has been alerted", which is a promise that
     * somebody here is working on it. That is true of a row whose documents
     * we could not read — and FALSE of a row whose documents we read fine.
     *
     * MEASURED, 19 SEPTEMBER 2026. Lot 1037 Vanta 20 attaches three
     * documents, all three were read, and its brochure's cover reads
     * `NEX 20 — Lot 1307 Fuchsia Street` — the sibling row's file. Nothing
     * here can fix that; only the person holding the sheet can. Telling them
     * we are on it is how a correctable data error waits forever.
     *
     * The counts already say which it is: a row that attaches documents and
     * had NONE go unprocessed or unreachable was read from end to end, so the
     * terminal state is a finding about the documents (`none_found`, which
     * names the two acts that change it) rather than about us. Derived from
     * the fields the projection already carries — the server is still the
     * only side that decides, and no mechanism reaches a screen through it.
     */
    if (input.sourceDocuments > 0
      && Number.isFinite(unprocessed) && unprocessed <= 0
      && Number.isFinite(unreachable) && unreachable <= 0) return 'none_found';
    return 'attention';
  }
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
  if (Number.isFinite(unprocessed) && unprocessed > 0) return 'unreadable';
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
  attention: 'Photo needs attention',
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
  attention: 'Needs attention',
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
  attention: 'This property\u2019s photo could not be processed and our team has '
    + 'been alerted. You can also add a picture yourself with \u201cAdd picture\u201d.',
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
  /**
   * The CLASS of the finding, where the reading earned one, and what the
   * document said instead.
   *
   * Only `identity_mismatch` exists, and it is the one refusal a builder can
   * correct in a minute: the brochure they linked is for a different
   * property. It travels as a code rather than as prose because the screen
   * has to treat it differently, and a screen that told it apart by matching
   * substrings of `detail` would be a rule nobody can see and every rewording
   * breaks.
   *
   * Absent on every other `inspected` refusal, which keeps exactly the
   * wording it has today — a brochure with no photograph in it, a cover of
   * plans and graphics, a page that states nothing identifying at all.
   */
  finding?: DocumentFinding;
  /** What the document designates instead, e.g. `Lot 1307`. */
  states?: string;
  /** The page's own most identifying lines, verbatim. May be empty. */
  quote?: string;
  /**
   * THE LINK A MISMATCH IS ABOUT, exactly as the builder's own row carries it
   * — on a mismatch and nowhere else, because it is what "Use brochure image"
   * names when it asks the server to record a confirmation. The server treats
   * it as a lookup key and re-reads the stored finding under it; it is never
   * authority. It is the builder's own link, shown to the builder.
   */
  document_key?: string;
  /**
   * WHETHER "USE BROCHURE IMAGE" IS OFFERED. On a mismatch alone, and false
   * only where the link is not one document. A brochure another listing
   * already shows is still offered: the builder decides (`in_use_by`).
   */
  confirmable?: boolean;
  /**
   * The listing that already shows this brochure's photograph. A caution the
   * builder is shown before confirming, never a refusal: the owner's rule is
   * that a builder who wants the photograph in the brochure they linked may
   * use it.
   */
  in_use_by?: ListingReference;
  /** A listing whose lot is the one the brochure states. Cautions, never refuses. */
  stated_lot_listing?: ListingReference;
}

/**
 * A builder's confirmation, as the notes and the screen read it.
 *
 * `document` is the branch key the confirmation was recorded against, and
 * `lot` the digits of the lot the brochure's image page states.
 */
export interface StockBrochureConfirmationInput {
  id: string;
  document: string;
  lot: string;
}

/**
 * THE WORDS THE BUILDER SEES FOR A MISMATCH, IN ONE PLACE.
 *
 * Here rather than in the component for the reason every other builder-facing
 * string in this module is here: the portal reads it, the specs read it, and
 * two copies of a sentence is how two screens come to say different things
 * about one finding. No pipeline vocabulary appears in any of them — no
 * election, no provenance, no branch, no exhaustion, no result code. A
 * builder is told what happened to their brochure and what to do about it.
 */
export const STOCK_DOCUMENT_MISMATCH_COPY = {
  heading: 'Brochure details don\u2019t match this property',
  body: 'The linked brochure was read successfully, but the page its property image '
    + 'would come from identifies a different property. To prevent the wrong photo '
    + 'from being displayed, the image was not added.',
  listingLabel: 'This listing',
  documentLabel: 'Brochure image page',
  action: 'Check the brochure linked to this property, or add the correct property image.',
} as const;

/**
 * THE WORDS FOR "USE BROCHURE IMAGE", IN ONE PLACE — for the reason the
 * mismatch copy above is here. The server's refusals and the portal's dialog
 * both read them, so a builder is told the same thing wherever they are told.
 */
export const STOCK_BROCHURE_CONFIRMATION_COPY = {
  action: 'Use brochure image',
  dialogTitle: 'Use the image from this brochure?',
  dialogBody: (states: string, listing: string) =>
    `The brochure\u2019s image page identifies ${states}, but this listing is `
    + `${listing}. Only continue if this brochure is for this property.`,
  transposed: 'The two lot numbers use the same digits in a different order. That is '
    + 'often a typing error in the brochure or in the stock list, so check which one '
    + 'is right before you continue.',
  statedLotListing: (identity: string) => `${identity} is also in your stock list.`,
  checks: 'The image still has to pass the usual photo checks before it is shown, '
    + 'and you can undo this at any time.',
  cancel: 'Cancel',
  confirm: 'Confirm and use image',
  confirmedToastTitle: 'Brochure image confirmed',
  confirmedToastBody: (listing: string) =>
    `The image from this brochure will be added to ${listing} shortly.`,
  inUse: (identity: string) => `${identity} in your stock list already shows the image from `
    + 'this brochure.',
  inUseDialog: (identity: string) => `${identity} already shows this image. If you continue, `
    + 'both listings will show it.',
  confirmedBy: (name: string, date: string) =>
    `Brochure image confirmed by ${name}${date ? ` on ${date}` : ''}.`,
  pending: 'Adding the image from the brochure\u2026',
  notApplied: 'The brochure\u2019s image page still couldn\u2019t be used for this property:',
  unreadable: 'The brochure couldn\u2019t be read just now, so its image hasn\u2019t been added.',
  unlinked: 'This brochure is no longer linked to this property in your stock list, so the '
    + 'confirmation no longer applies.',
  undo: 'Undo',
  undoTitle: 'Undo brochure confirmation?',
  undoBody: 'The image from this brochure will be removed from this listing, and the '
    + 'brochure will be shown as not matching this property again.',
  undoKeep: 'Keep it',
  undoConfirm: 'Undo confirmation',
  undoneToastTitle: 'Confirmation undone',
  undoneToastBody: 'The brochure image has been removed from this listing.',
} as const;

/** Does this row carry a brochure that names somebody else's property? */
export function hasDocumentIdentityMismatch(
  notes: readonly StockDocumentNote[] | null | undefined,
): boolean {
  return (notes ?? []).some((note) => note.finding === DOCUMENT_IDENTITY_MISMATCH);
}

/** At most this many notes reach a row. A status line, not a log. */
export const MAX_STOCK_DOCUMENT_NOTES = 4;

export function stockDocumentNotes(
  storedProvenance: unknown,
  limit: number = MAX_STOCK_DOCUMENT_NOTES,
  /**
   * The confirmations this property holds. A refusal the builder has since
   * confirmed against, or an answer reached under a confirmation that still
   * holds, is drawn as that confirmation (`brochureConfirmationStates`) and
   * not as a note — the same fact twice is how a card says two things.
   */
  options: { confirmations?: readonly StockBrochureConfirmationInput[] | null } = {},
): StockDocumentNote[] {
  const root = storedProvenance as { branches?: Record<string, unknown> } | null;
  const branches = root && typeof root === 'object' ? root.branches : null;
  if (!branches || typeof branches !== 'object') return [];
  const confirmations = options.confirmations ?? [];
  const notes: StockDocumentNote[] = [];
  for (const [key, value] of Object.entries(branches)) {
    if (notes.length >= Math.max(0, limit)) break;
    if (!value || typeof value !== 'object') continue;
    const record = value as {
      result?: unknown; exhaustion?: unknown; detail?: unknown;
      finding?: unknown; finding_evidence?: unknown;
      identity_confirmation?: { id?: unknown } | null;
    };
    if (record.result !== 'no_deterministic_image') continue;
    // The one gate. `operational` is ours and never leaves this side.
    if (record.exhaustion !== 'inspected') continue;
    // Drawn as the confirmation it was reached under, or confirmed against.
    const stamp = record.identity_confirmation?.id;
    if (stamp && confirmations.some((c) => c.id === String(stamp))) continue;
    const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
    if (!detail) continue;
    const note: StockDocumentNote = { document: documentLabel(key), detail };
    /*
     * The class, and only where the record carries one AND names what the
     * document said instead. Both, because the message this unlocks accuses
     * a builder's file of being the wrong file and a claim with no evidence
     * beside it is worse than the wording it replaces. A record written
     * before this field existed carries neither and reads exactly as before.
     */
    const evidence = record.finding_evidence as Record<string, unknown> | undefined;
    const states = typeof evidence?.states === 'string' ? evidence.states.trim() : '';
    if (isDocumentFinding(record.finding) && states) {
      const lot = confirmedLotOf(states);
      if (!stamp && lot && confirmations.some((c) =>
        c.lot === lot && sameDocument(c.document, key))) continue;
      note.finding = record.finding;
      note.states = states;
      note.quote = typeof evidence?.quote === 'string' ? evidence.quote.trim() : '';
      note.document_key = key;
    }
    notes.push(note);
  }
  return notes;
}

/** What became of a builder's confirmation, as their screen says it. */
export type StockBrochureConfirmationState =
  /** The brochure has not been read again under it yet. */
  | 'pending'
  /** Read under it, and its image page gave the property its picture. */
  | 'applied'
  /** Read under it, and the page still could not be this property's cover. */
  | 'not_applied'
  /** We could not read the brochure under it. Ours, never the document's. */
  | 'unreadable'
  /**
   * The row no longer links that brochure — the stock list was re-imported
   * with another link — so nothing will ever read it under the confirmation.
   * Said, rather than left reading "pending" for ever.
   */
  | 'unlinked';

export interface StockBrochureConfirmationReading extends StockBrochureConfirmationInput {
  state: StockBrochureConfirmationState;
  /** The recorded reason, verbatim, for `not_applied` alone. */
  detail?: string;
}

/**
 * WHAT BECAME OF EACH CONFIRMATION, read from the stored answer for its
 * document and nothing else.
 *
 * An answer counts only where it was reached under THIS confirmation — the
 * stamp — so a picture the brochure gave before, or a refusal recorded under
 * a confirmation since replaced, says nothing about this one. `unreadable`
 * carries no reason: an answer about OUR failure never leaves this side, the
 * same rule `stockDocumentNotes` keeps.
 */
export function brochureConfirmationStates(
  storedProvenance: unknown,
  confirmations: readonly StockBrochureConfirmationInput[] | null | undefined,
  options: {
    /**
     * The links the row carries NOW, exactly as the settler derives its
     * branches. Absent: not known, and nothing is said about it.
     */
    linkedDocuments?: ReadonlySet<string> | null;
  } = {},
): StockBrochureConfirmationReading[] {
  const root = storedProvenance as { branches?: Record<string, unknown> } | null;
  const branches = root && typeof root === 'object' && root.branches
    && typeof root.branches === 'object' ? root.branches : {};
  return (confirmations ?? []).map((confirmation) => {
    if (options.linkedDocuments && !options.linkedDocuments.has(confirmation.document)) {
      return { ...confirmation, state: 'unlinked' as const };
    }
    const record = (branches as Record<string, unknown>)[confirmation.document] as {
      result?: unknown; exhaustion?: unknown; detail?: unknown;
      [IDENTITY_CONFIRMATION_KEY]?: { id?: unknown } | null;
    } | undefined;
    const stamped = !!record
      && String(record[IDENTITY_CONFIRMATION_KEY]?.id ?? '') === confirmation.id;
    if (!stamped || !record) return { ...confirmation, state: 'pending' as const };
    if (record.result === NO_DETERMINISTIC_IMAGE) {
      if (record.exhaustion !== 'inspected') return { ...confirmation, state: 'unreadable' as const };
      const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
      return { ...confirmation, state: 'not_applied' as const, ...(detail ? { detail } : {}) };
    }
    if (record.result === 'image_recovered') return { ...confirmation, state: 'applied' as const };
    return { ...confirmation, state: 'pending' as const };
  });
}

/**
 * WHAT A BUILDER MAY DO ABOUT EACH MISMATCH, decided from the organisation's
 * own listings and nothing the page sent.
 *
 * `listings` are the organisation's live listings whose lot is one a mismatch
 * states (`readListingsWithLots`). Null means they could not be read: the
 * choice is still offered where the link allows it, because the act re-reads
 * them and refuses there — the page cannot confirm anything the server has
 * not checked — and a caution the product cannot vouch for is left unsaid.
 */
export function withConfirmationChoices(
  notes: readonly StockDocumentNote[],
  input: {
    stockItemId: string;
    suburb?: unknown;
    developmentName?: unknown;
    listings: readonly StockRowForConfirmation[] | null;
  },
): StockDocumentNote[] {
  return notes.map((note) => {
    if (note.finding !== DOCUMENT_IDENTITY_MISMATCH || !note.document_key || !note.states) return note;
    const lot = confirmedLotOf(note.states);
    if (!lot) return { ...note, confirmable: false };
    const inUse = input.listings
      ? brochureInUseByAnotherProperty(input.listings, {
        stockItemId: input.stockItemId, documentReference: note.document_key, statedLot: lot,
      })
      : null;
    const stated = input.listings && !inUse
      ? statedLotListing(input.listings, {
        stockItemId: input.stockItemId, statedLot: lot,
        suburb: input.suburb, developmentName: input.developmentName,
      })
      : null;
    return {
      ...note,
      confirmable: isConfirmableBranch(note.document_key),
      ...(inUse ? { in_use_by: inUse } : {}),
      ...(stated ? { stated_lot_listing: stated } : {}),
    };
  });
}

/** A confirmation as the builder's screen draws it. */
export interface StockBrochureConfirmationView {
  id: string;
  /** The document, as a person would name it. */
  document: string;
  /** The link exactly as the row carries it. */
  document_key: string;
  lot: string;
  /** What the brochure's image page states, as the mismatch said it. */
  states: string;
  confirmed_by: string;
  confirmed_at: string;
  state: StockBrochureConfirmationState;
  detail?: string;
}

/**
 * Each standing confirmation, with what became of it, for the screen. The
 * reading is `brochureConfirmationStates`; this only names the document the
 * way every other line on the page names it.
 */
export function brochureConfirmationViews(
  storedProvenance: unknown,
  confirmations: ReadonlyArray<StockBrochureConfirmationInput & {
    confirmed_by?: unknown; confirmed_at?: unknown;
  }> | null | undefined,
  options: { linkedDocuments?: ReadonlySet<string> | null } = {},
): StockBrochureConfirmationView[] {
  const list = confirmations ?? [];
  return brochureConfirmationStates(storedProvenance, list, options).map((reading, index) => ({
    id: reading.id,
    document: documentLabel(reading.document),
    document_key: reading.document,
    lot: reading.lot,
    states: `Lot ${reading.lot}`,
    confirmed_by: String(list[index]?.confirmed_by ?? '').trim() || 'A builder',
    confirmed_at: String(list[index]?.confirmed_at ?? ''),
    state: reading.state,
    ...(reading.detail ? { detail: reading.detail } : {}),
  }));
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
