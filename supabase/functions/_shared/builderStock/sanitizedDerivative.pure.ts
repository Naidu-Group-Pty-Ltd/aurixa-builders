/**
 * Builder stock — the record of a cleaned copy, and the rules for serving it.
 *
 * A sanitized derivative is a SECOND set of bytes made from ONE set of bytes:
 * the builder's own primary image for that exact property, with a graphic that
 * was laid over it removed. It is not a replacement and it is not an
 * alternative image. Nothing else is ever an input, and this module exists so
 * that claim is checkable rather than merely intended — every record names the
 * exact original by id and by SHA-256, and a derivative whose provenance does
 * not tie back to the bytes currently in the row is not served.
 *
 * IT IS STORED BESIDE THE ORIGINAL VERDICT, NEVER OVER IT. The original stays
 * `ineligible / annotated_marketing_tile`, because that is the truth about the
 * builder's file and overwriting it would erase the reason the derivative
 * exists. What changes is one extra fact — this record — and the display rule
 * reads both: a card may draw the original when it is eligible, or the frozen
 * derivative when one has been made and passed. Nothing else, ever.
 *
 * A FAILURE IS RECORDED TOO, AND IT IS NOT A DERIVATIVE. Where a repair was
 * attempted and refused — by the deterministic gates, by the validation gate,
 * or by the endpoint — that is written as a failure, under its own key, and the
 * card goes on showing nothing. No other image takes its place. The failure is
 * terminal for the version that produced it for exactly the reason the
 * eligibility verdict is: retrying identical work every five minutes for ever
 * is what the settlement programme spent a fortnight undoing.
 *
 * Pure: no imports, no IO, no clock.
 */

import { MAX_REPAIRED_SHARE } from './repairRegion.pure.ts';

/**
 * Bumped when a repair would come out differently for bytes already handled.
 *
 * ONE NUMBER FOR THE WHOLE STAGE, covering both routes. A record names which
 * route made it, but "is this record stale" is one question and must have one
 * answer: two counters would let a deterministic derivative be current while a
 * generative one from the same run was not, and nothing downstream could say
 * which of the two a card was showing.
 *
 * Deliberately not `MARKETPLACE_ELIGIBILITY_VERSION` and deliberately not
 * `PROVENANCE_VERSION`. Whether a picture may be drawn, where its bytes came
 * from, and how well a graphic can be taken off it are three questions that
 * improve on three different days.
 *
 *   1  first release: Laplace reconstruction for small quiet patches, masked
 *      generative inpainting for the rest, both gated on the same detector
 *   2  badges that carry no readable words are found by the colour of their
 *      plate (`overlayPlate.pure.ts`), and a picture proved to carry no
 *      promotional treatment at all is CLEARED rather than left blank
 *      (`overlayClearance.pure.ts`)
 */
export const SANITIZATION_VERSION = 2;

/** Where the record lives inside `source_detail`. */
export const DERIVATIVE_KEY = 'sanitized_derivative';
/** And where a refusal does. Never the same key: they are not the same fact. */
export const FAILURE_KEY = 'sanitization_failure';
/**
 * And where "we looked, and there is nothing on this picture" does.
 *
 * A THIRD KEY BECAUSE IT IS A THIRD FACT. A derivative says "here are new bytes
 * with the badge removed"; a failure says "we could not remove it"; a clearance
 * says "there was never anything to remove, serve the builder's own file". They
 * license different things — the first serves a NEW object, the third serves
 * the ORIGINAL, the second serves nothing — and collapsing any two of them into
 * one key would make the display rule guess which it was reading.
 */
export const CLEARANCE_KEY = 'sanitization_clearance';

/**
 * The `source_detail` keys the SANITIZATION stage owns, and no other stage may
 * write or destroy.
 *
 * Named as a set because the destroying is what happens by accident. Every
 * path that stores a source image composes `source_detail` as a fresh object
 * and upserts the row on `(stock_item_id, source_stage, source_reference)`, so
 * a re-import silently takes these three with it — see
 * `sanitizationCarryForward`, which is the repair and the explanation.
 */
export const SANITIZATION_KEYS: readonly string[] = [
  DERIVATIVE_KEY, FAILURE_KEY, CLEARANCE_KEY,
];

/**
 * How the overlay was taken off.
 *
 * Two routes and no third. The first is arithmetic — it has no model, no
 * network and no randomness, and the same bytes always produce the same bytes.
 * The second asks a model to reconstruct what was behind the mask, and is
 * reached ONLY where the first refuses.
 */
export type SanitizationTransformation =
  | 'deterministic_overlay_reconstruction'
  | 'generative_overlay_inpaint';

export interface SanitizedDerivative {
  transformation: SanitizationTransformation;
  sanitization_version: number;

  /* ---- the exact original, named twice ---- */
  /** The `builder_stock_item_images` row the bytes were read from. */
  original_image_id: string;
  /** And the bytes themselves. A row whose object changed invalidates this. */
  original_sha256: string;
  stock_item_id: string;
  organisation_id: string;
  /** The source row / package the original was recovered through, if any. */
  source_reference: string | null;

  /* ---- the frozen result ---- */
  storage_bucket: string;
  storage_path: string;
  derivative_sha256: string;
  width: number;
  height: number;

  /* ---- what was done ---- */
  /** Share of the frame rebuilt. */
  repaired_share: number;
  regions_removed: number;
  /** The model, for the generative route. Null for the deterministic one. */
  model: string | null;
  generated_at: string;

  /**
   * THE REPAIR'S VERDICT ON ITS OWN WORK, measured on the derivative's bytes.
   *
   * `eligible` means two things were checked and both held: no laid-over type
   * survives anywhere in the result, and nothing the repair rebuilt came back
   * as a flat coloured block. Anything else is stored and NOT served — the work
   * is recorded, the card stays empty, and nobody has to guess.
   *
   * DELIBERATELY NOT "the display classifier now passes it". That test is the
   * one this shipped with and it was wrong: Lot 13 Hummock Rise's repaired
   * picture carries no type at all, and the classifier refuses it for the
   * house's black garage door — a flat coloured block that was there before the
   * repair and after it, and the same false positive that hides the completely
   * unmarked Lot 537 Kirramingly. A repair cannot be held responsible for a
   * judgement about a feature of the house.
   */
  verdict: 'eligible' | 'ineligible' | 'pending';
  /**
   * And what the display classifier makes of the result, recorded and not
   * obeyed. Kept because the disagreement above is worth being able to see.
   */
  classifier_state?: 'eligible' | 'ineligible' | 'pending';
}

/** Why a repair did not produce a servable picture. */
export type SanitizationFailureReason =
  /** The deterministic route's own gates: see `sanitizeOverlay.pure.ts`. */
  | 'background_too_detailed'
  | 'too_much_to_rebuild'
  | 'nothing_to_remove'
  | 'unusable_input'
  /** The generative route could not be reached, or refused the request. */
  | 'inpaint_unavailable'
  | 'inpaint_failed'
  /** No square patch can hold the graphic without leaving the picture. */
  | 'uncoverable'
  /** It returned something, and the validation gate rejected it. */
  | 'validation_failed'
  /** The result was made and the classifier still sees a graphic on it. */
  | 'still_annotated'
  /** The bytes could not be written or the record could not be stored. */
  | 'storage_failed';

export interface SanitizationFailure {
  transformation: SanitizationTransformation | null;
  sanitization_version: number;
  original_image_id: string;
  original_sha256: string;
  reason: SanitizationFailureReason;
  /** Safe to surface: what happened, for an operator and for a retry. */
  detail: string;
  model: string | null;
  failed_at: string;
  /**
   * Where the refused render was kept, when there was one.
   *
   * NOT a derivative and never served: nothing reads this path except a person
   * looking at what the repair produced. It is here because "we tried and the
   * graphic is still there" is a claim somebody has to be able to check.
   */
  rejected_path?: string | null;
}

/**
 * The record that says a picture the classifier refused carries nothing to
 * remove, and that the builder's ORIGINAL is therefore what the card shows.
 *
 * IT NAMES NO NEW OBJECT, and that is the whole shape of it. There is no
 * storage path, no derivative hash, no width and no height, because nothing was
 * made: the bytes this licenses are the ones already in the row. A clearance
 * that carried a path would be a derivative wearing a different name, and the
 * one thing this must never do is put a second set of pixels on a card while
 * claiming nothing was changed.
 *
 * The evidence is recorded in full, because a clearance is the one outcome here
 * that OVERRIDES a refusal, and an override nobody can audit is an override
 * nobody should trust.
 */
export interface SanitizationClearance {
  sanitization_version: number;
  /** The exact original, named twice, exactly as a derivative names it. */
  original_image_id: string;
  original_sha256: string;
  stock_item_id: string;
  organisation_id: string;
  source_reference: string | null;
  /** What the inspection measured. See `overlayClearance.pure.ts`. */
  evidence: {
    text_run_count: number;
    strict_text_lines: number;
    faint_text_lines: number;
    flat_region_count: number;
    promotional_region_count: number;
    plate_count: number;
  };
  cleared_at: string;
}

/**
 * Read a stored clearance, if it is one this code may act on.
 *
 * THE SAME ORIGIN TEST A DERIVATIVE GETS, for the same reason: a row whose
 * object has been replaced must not go on serving under a finding made about
 * the old one. A builder who swaps the file has swapped the premise.
 *
 * AND THE OPPOSITE VERSION RULE, DELIBERATELY. A derivative stays servable
 * across a version bump; a clearance does NOT, and the asymmetry is the point.
 *
 * They are claims of different kinds. A derivative says a graphic WAS THERE and
 * was removed and the result was measured — evidence of presence, acted on, and
 * a later improvement to the inspection cannot make it false. A clearance says
 * nothing was found — evidence of ABSENCE, which is exactly the claim a better
 * inspection is most likely to overturn, since a version bump usually exists
 * because something was being missed. Version 2 is itself that: version 1 could
 * not see a badge whose words it could not read.
 *
 * So a clearance expires with the inspection that made it, and the picture is
 * hidden until the current one re-establishes it. Each rule fails in the safe
 * direction: a stale derivative shows a cleaned photograph, and a stale
 * clearance would show whatever the old inspection could not see.
 */
export function readServableClearance(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): SanitizationClearance | null {
  const raw = (sourceDetail ?? {})[CLEARANCE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<SanitizationClearance>;

  const version = Number(record.sanitization_version);
  if (!Number.isFinite(version) || version < SANITIZATION_VERSION) return null;

  if (typeof record.original_sha256 !== 'string' || !record.original_sha256) return null;
  if (!originalSha256 || record.original_sha256 !== originalSha256) return null;

  return record as SanitizationClearance;
}

/** The clearance a card may draw the ORIGINAL under, or null. */
export function servableClearanceFor(
  sourceDetail: Record<string, unknown> | null | undefined,
): SanitizationClearance | null {
  return readServableClearance(sourceDetail, storedOriginalSha(sourceDetail));
}

/**
 * Read a stored derivative, if it is one this code may serve.
 *
 * FOUR THINGS ARE CHECKED AND EVERY ONE OF THEM CAN REFUSE, because a
 * derivative is a claim about specific bytes and a claim that has drifted from
 * them is worse than no claim: it would put a picture on a card that nothing
 * can any longer prove came from that property's own file.
 *
 *   SHAPE     anything malformed is not a derivative
 *   VERSION   only that it is a real number, and see below
 *   ORIGIN    the SHA-256 named must be the SHA-256 the row currently holds —
 *             a builder who replaces the file has replaced the premise
 *   VERDICT   only `eligible`. A repair that did not remove the graphic is a
 *             record of work done, not a picture to draw.
 *
 * SERVING AND SCHEDULING ARE DIFFERENT QUESTIONS, AND THIS ANSWERS ONLY THE
 * FIRST. It used to refuse any record below `SANITIZATION_VERSION`, on the
 * reading that a stale repair should not be served — and that is wrong in a way
 * only a version bump reveals. The eleven repaired production images all carry
 * version-1 records; raising the constant to 2 would have un-served every one
 * of them the instant it shipped, and the four that need the generative route
 * cannot be remade while the vendor account is out of credit. Cards that had
 * been fixed would have gone blank, for a reason that has nothing to do with
 * the pictures.
 *
 * A derivative is a claim about SPECIFIC BYTES: this graphic was on them, it
 * was removed, and the result was measured. A better inspection arriving later
 * does not make that false. So the version governs `sanitizationSettled` — is
 * this row due another look — and nothing here. The two questions were
 * conflated because one number answered both, and one of the answers was wrong.
 *
 * Fails closed in every other direction. The cost of refusing wrongly is a
 * blank card, which is the state this whole area is trying to leave and is
 * still strictly better than showing a client an image nothing can vouch for.
 */
export function readServableDerivative(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): SanitizedDerivative | null {
  const raw = (sourceDetail ?? {})[DERIVATIVE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<SanitizedDerivative>;

  if (record.transformation !== 'deterministic_overlay_reconstruction'
    && record.transformation !== 'generative_overlay_inpaint') return null;

  const version = Number(record.sanitization_version);
  if (!Number.isFinite(version) || version < 1) return null;

  if (typeof record.storage_path !== 'string' || !record.storage_path) return null;
  if (typeof record.derivative_sha256 !== 'string' || !record.derivative_sha256) return null;

  // The original, compared exactly. No normalisation and no fallback to "the
  // row has no hash so assume it matches" — an unhashable original is one this
  // may not claim to be derived from.
  if (typeof record.original_sha256 !== 'string' || !record.original_sha256) return null;
  if (!originalSha256 || record.original_sha256 !== originalSha256) return null;

  if (record.verdict !== 'eligible') return null;

  /*
   * AND A FIFTH, ADDED AFTER THE FACT: HOW MUCH OF IT WAS REBUILT.
   *
   * The area ceiling is enforced twice before a derivative is ever made — on
   * the region that asks for the repair, and on the pixels the repair is
   * permitted to write. Neither reaches backwards. A derivative recorded
   * before those existed, or by any build that predates them, carries its own
   * `repaired_share` and is the only evidence available at serve time about
   * how much photograph the model replaced, so it is checked here too.
   *
   * A record with no readable share is refused rather than assumed small: an
   * unmeasurable repair is exactly the one that cannot be vouched for. The
   * cost of refusing is that the card falls back — to the builder's own clean
   * original where there is one, and otherwise to blank, which is the failure
   * this whole area exists to avoid but is still better than showing a client
   * a house the model mostly drew.
   */
  const share = Number(record.repaired_share);
  if (!Number.isFinite(share) || share < 0) return null;
  if (share > MAX_REPAIRED_SHARE) return null;

  return record as SanitizedDerivative;
}

/**
 * The hash of the bytes a row currently claims to hold.
 *
 * `stored_sha256` is what is in the bucket; `source_sha256` is what the builder
 * served. They are written from the same buffer and are normally identical, and
 * where a row carries only the older of the two keys the second is the fallback.
 */
export function storedOriginalSha(
  sourceDetail: Record<string, unknown> | null | undefined,
): string | null {
  const detail = sourceDetail ?? {};
  if (typeof detail.stored_sha256 === 'string' && detail.stored_sha256) {
    return detail.stored_sha256;
  }
  if (typeof detail.source_sha256 === 'string' && detail.source_sha256) {
    return detail.source_sha256;
  }
  return null;
}

/**
 * The derivative a card may draw for this row, or null.
 *
 * The one call every display path makes, so the client, the marketplace
 * endpoint and the portal endpoint cannot hold different opinions about which
 * object is served — a disagreement there would mean a card showing the cleaned
 * picture and the endpoint handing over the badged one, or the reverse.
 */
export function servableDerivativeFor(
  sourceDetail: Record<string, unknown> | null | undefined,
): SanitizedDerivative | null {
  return readServableDerivative(sourceDetail, storedOriginalSha(sourceDetail));
}

/**
 * Has this image already been through the repair at the current version?
 *
 * True for a stored derivative AND for a stored failure, which is the part
 * that keeps the sweep finite: "we tried and it did not work" is knowledge in
 * exactly the way "we read the package and it named no image" is, and throwing
 * it away is how a settler comes to re-run the same refused work for ever.
 *
 * A change of original bytes reopens both, through the same SHA-256 comparison
 * the reader above makes.
 */
export function sanitizationSettled(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): boolean {
  const detail = sourceDetail ?? {};
  for (const key of [DERIVATIVE_KEY, FAILURE_KEY, CLEARANCE_KEY]) {
    const raw = detail[key];
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { sanitization_version?: unknown; original_sha256?: unknown };
    const version = Number(record.sanitization_version);
    if (!Number.isFinite(version) || version < SANITIZATION_VERSION) continue;
    if (typeof record.original_sha256 !== 'string') continue;
    if (!originalSha256 || record.original_sha256 !== originalSha256) continue;
    return true;
  }
  return false;
}

/**
 * What a RE-STORE of the same image must put back.
 *
 * THE DEFECT THIS EXISTS FOR. Every path that stores a source image builds
 * `source_detail` as a fresh object and upserts it on
 * `(stock_item_id, source_stage, source_reference)`. The sanitization record is
 * written by a different stage, later, onto the same column — so re-importing a
 * stock list DESTROYED it. Measured on 4 September 2026: the same brochure
 * uploaded a second time took a repaired cover render off the card, although
 * the bytes were byte-identical (`3f37fb4d…`), the repair was still exactly a
 * repair OF those bytes, and its PNG was still in the bucket. The card blanked
 * until a fresh repair landed, and the model call was paid for again.
 *
 * THE RULE IS THE ONE THE READERS ALREADY APPLY, not a new one: a sanitization
 * record belongs to the bytes named by its `original_sha256`. Identical bytes
 * keep it — the row comes out of a re-store in exactly the state it went in.
 * Different bytes drop it, which is what `readServableDerivative` and
 * `sanitizationSettled` would decide about it anyway; carrying it would only
 * leave a record for somebody to read as current.
 *
 * WHAT IS DELIBERATELY NOT CARRIED is `sanitization_attempt`. That is a
 * cooldown, not a finding — the settler's note that a repair was tried a moment
 * ago — and a freshly imported row is entitled to be looked at now.
 *
 * NO VERSION TEST EITHER, on purpose. Carrying a record forward grants nothing:
 * whether it may be SERVED is decided by the readers, on the same terms as
 * before the re-store. Adding a floor here would make a re-import quietly
 * stricter than leaving the row alone, which is the asymmetry that produced
 * this defect in the first place.
 *
 * Pure: no IO. The caller supplies the hash of the bytes it is about to store.
 */
export function sanitizationCarryForward(
  existingDetail: Record<string, unknown> | null | undefined,
  storedSha256: string | null | undefined,
): Record<string, unknown> {
  const detail = existingDetail ?? {};
  const carried: Record<string, unknown> = {};
  if (!storedSha256) return carried;

  for (const key of SANITIZATION_KEYS) {
    const raw = detail[key];
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { original_sha256?: unknown };
    if (typeof record.original_sha256 !== 'string') continue;
    if (record.original_sha256 !== storedSha256) continue;
    carried[key] = raw;
  }
  return carried;
}

/** The `source_detail` keys a successful repair contributes. */
export function derivativeDetail(
  derivative: SanitizedDerivative,
): Record<string, unknown> {
  // The failure key is cleared: a repair that has now succeeded must not leave
  // a refusal standing beside it for an operator to read as the current state.
  //
  // And the clearance with it. A repair that ran found something to remove, so
  // any standing "there is nothing on this picture" is now false — and leaving
  // it would license the badged ORIGINAL onto a card beside the cleaned copy.
  return { [DERIVATIVE_KEY]: derivative, [FAILURE_KEY]: null, [CLEARANCE_KEY]: null };
}

/**
 * The `source_detail` keys a clearance contributes.
 *
 * The failure key is cleared for the same reason a derivative clears it: a
 * picture now known to carry nothing must not leave "we could not remove the
 * badge" standing beside that for an operator to read as the current state. The
 * DERIVATIVE key is cleared too, and only here — a clearance means no repair
 * was warranted, so a derivative from an earlier version being served alongside
 * it would put rebuilt pixels on a card this record says needs none.
 */
export function clearanceDetail(
  clearance: SanitizationClearance,
): Record<string, unknown> {
  return { [CLEARANCE_KEY]: clearance, [FAILURE_KEY]: null, [DERIVATIVE_KEY]: null };
}

/** And the keys a refusal contributes. */
export function failureDetail(
  failure: SanitizationFailure,
): Record<string, unknown> {
  // The derivative key is NOT cleared here. A previously servable derivative
  // whose original has not changed stays servable; a failure recorded against
  // NEW bytes will not match its SHA-256 and so will not be served anyway.
  //
  // THE CLEARANCE IS, and it is not the same call. A failure means a badge WAS
  // found and could not be taken off, which contradicts a clearance outright —
  // and of the two contradictory records the one that hides the picture is the
  // one to keep, because the cost of being wrong that way is a blank card and
  // the cost of being wrong the other way is marketing on a client's screen.
  return { [FAILURE_KEY]: failure, [CLEARANCE_KEY]: null };
}
