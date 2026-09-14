/**
 * Builder stock — the FOURTH question about an image.
 *
 * Three were already asked and answered, each by its own module, and none of
 * them is this one:
 *
 *   1  PROVENANCE   did these exact bytes come out of the builder's source?
 *                   (`sourceImages.ts`, and the hashes in `source_detail`)
 *   2  OWNERSHIP    can they be tied to THIS property deterministically?
 *                   (`sourceAssets.pure.ts`, the anchors, the page tree)
 *   3  ROLE         did the source present them as its primary image?
 *                   (`sourceImageRole.pure.ts`)
 *   4  DISPLAY      is that image one to put on a marketplace card?
 *
 * ALL THREE OF THE FIRST CAN ANSWER YES AND THE FOURTH STILL BE NO. Lot 13
 * Hummock Rise and Lot 1663 Ringer Street are exactly that: the builder's own
 * bytes, of that exact property, designated by the source as its listing image
 * — and the picture is the facade under green pills reading "Completed" and
 * "SMSF", a red one reading "$25,000 Rebate", and suburb and state banners.
 * Provenance is perfect and the card is still wrong.
 *
 * SO THE ANSWER IS RECORDED SEPARATELY AND NOTHING ELSE IS TOUCHED. The role
 * stays `primary_property`, because that is what the source said and falsifying
 * it to hide the picture would put a lie in the audit trail. What changes is
 * one extra fact stored beside it, and the display rule reads both.
 *
 * IT FAILS CLOSED, AND THAT IS THE POINT OF THE THIRD STATE. There are three
 * answers and not two:
 *
 *   eligible     measured, and carries no promotional treatment
 *   ineligible   measured, and does
 *   pending      NOT measured — an encoding no decoder here reads, a file that
 *                broke one, a picture past the resource ceiling
 *
 * `pending` is not `eligible`. An unreadable container, and an image this
 * classifier cannot confidently call clean, must never be a way for a marketing
 * tile to walk past the rule: "we could not tell" and "we looked and it was
 * clean" are different facts and are stored as different values. The card shows
 * nothing either way.
 *
 * ALL THREE ARE TERMINAL FOR THE VERSION THAT PRODUCED THEM. `pending` hides
 * the picture; it is not a request to try again on the next tick. What brings a
 * pending row back is the version below moving, which is how a better decoder
 * or a better classifier reaches images that were stored before it existed.
 *
 * WHAT MAY NOT HAPPEN WHEN AN IMAGE IS REFUSED OR PENDING. Nothing may take
 * its place except another image that independently passes all four questions
 * for the same property. Not an interior, not a floorplan, not a masterplan,
 * not a location map, not another lot's facade, and none of the location or
 * search stages. Where there is no such image, the card shows nothing.
 *
 * Pure: no IO, no clock, no database. The two imports are sibling pure
 * modules, and they are here so that what a sweep WILL judge is stated
 * once rather than agreed twice — see `sweepWillJudge`.
 */
import { isPrimaryRole, readStoredRole } from './sourceImageRole.pure.ts';
import { sanitizationSettled, storedOriginalSha } from './sanitizedDerivative.pure.ts';
import { readRepairRegion } from './repairRegion.pure.ts';

/**
 * Bumped when the decision would change for bytes already assessed.
 *
 * DELIBERATELY NOT `PROVENANCE_VERSION`. Provenance is about where bytes came
 * from and never changes when a display rule does; tying the two would mean
 * every classifier improvement re-fetched every source, and every source
 * change re-ran every classification. They move independently, and a row
 * carries both numbers.
 *
 *   1  first release: flat coloured blocks; prominent overlay typography
 *      regardless of colour or whether anything is drawn behind it; and a
 *      contrast-normalised second pass that reports `overlay_uncertain` rather
 *      than letting faint typography read as a clean picture
 *   2  a run of ink must be wide enough to be a LINE of type before it counts
 *      as one. A single 17x12px mark — foliage against sky, in the top corner
 *      of a recovered Sandpiper facade that carries no overlay at all —
 *      convicted a clean builder photograph and hid it. Every verdict version 1
 *      recorded was reached with that mark counting, so all of them are stale.
 *
 * IT HAS A SECOND HALF IN THE DATABASE. `builder_stock_settlement_target`
 * carries the version production is being brought TO, because the sweep's cron
 * job decides in SQL whether any work is left and SQL cannot see this constant.
 * A bump ships both: this number, and a migration calling
 * `set_builder_stock_eligibility_target` with the same one. A test reads the
 * migrations and fails when they disagree — a bump that ships only this half
 * changes new imports and silently leaves every stored image on the old rules.
 */
export const MARKETPLACE_ELIGIBILITY_VERSION = 2;

/** The three answers. `pending` is the one that keeps this failing closed. */
export type MarketplaceEligibilityState = 'eligible' | 'ineligible' | 'pending';

/** Why an image the source designated may not be drawn on a card. */
export type MarketplaceRejection =
  /** Measured, and carrying promotional treatment. */
  | 'annotated_marketing_tile'
  /**
   * Measured, and NOT established as clean.
   *
   * Something with the geometry of a line of type is faintly there, against
   * surroundings quiet enough that a photograph's own detail does not explain
   * it — but not strongly enough for the strict pass, whose thresholds are
   * fitted so no real photograph trips them. Hidden rather than refused.
   */
  | 'overlay_uncertain'
  /** Not measured: no decoder here reads this container. */
  | 'decoder_unsupported'
  /** Not measured: the decoder failed, or the picture was past its ceiling. */
  | 'decoder_failed';

/** What was measured, kept so a decision can be explained without re-reading. */
export interface MarketplaceOverlaySummary {
  largestShare: number;
  totalShare: number;
  regionCount: number;
  /** Tallest overlay text as a share of the picture's height, 0 for none. */
  textHeightShare: number;
  textLineCount: number;
  /** The same for the faint pass, which produces `overlay_uncertain`. */
  faintTextHeightShare: number;
  faintTextLineCount: number;
}

export interface MarketplaceEligibility {
  state: MarketplaceEligibilityState;
  reason: MarketplaceRejection | null;
  /** False when the container could not be decoded at all. */
  measured: boolean;
  overlay: MarketplaceOverlaySummary | null;
}

/** The eligibility of an image nothing could read. NOT displayable. */
export function unmeasured(
  reason: 'decoder_unsupported' | 'decoder_failed',
): MarketplaceEligibility {
  return { state: 'pending', reason, measured: false, overlay: null };
}

/**
 * Turn an overlay measurement into the display decision.
 *
 * One rule: a picture carrying promotional treatment laid over it is not a
 * card image. What counts as promotional treatment is
 * `marketingOverlay.pure.ts`, and it names no word, colour, font or position.
 */
export function decideMarketplaceEligibility(
  overlay:
    | {
      annotated: boolean;
      uncertain?: boolean;
      largestShare: number;
      totalShare: number;
      regionCount: number;
      textHeightShare: number;
      textLineCount: number;
      faintTextHeightShare?: number;
      faintTextLineCount?: number;
    }
    | null,
): MarketplaceEligibility {
  if (!overlay) return unmeasured('decoder_failed');
  const summary: MarketplaceOverlaySummary = {
    largestShare: overlay.largestShare,
    totalShare: overlay.totalShare,
    regionCount: overlay.regionCount,
    textHeightShare: overlay.textHeightShare,
    textLineCount: overlay.textLineCount,
    faintTextHeightShare: overlay.faintTextHeightShare ?? 0,
    faintTextLineCount: overlay.faintTextLineCount ?? 0,
  };
  if (overlay.annotated) {
    return {
      state: 'ineligible', reason: 'annotated_marketing_tile', measured: true, overlay: summary,
    };
  }
  /*
   * MEASURED, AND STILL NOT ELIGIBLE.
   *
   * `eligible` means the picture was analysed under the current algorithm AND
   * there is enough evidence that it carries no prominent overlay treatment.
   * Where the faint pass found the shape of a line of type against quiet
   * surroundings, that second half does not hold — so the picture is hidden as
   * `pending`, not passed as clean and not convicted as a tile.
   *
   * `measured` stays true: the pixels WERE read. What is missing is confidence,
   * not the decode, and the two are different facts.
   */
  if (overlay.uncertain) {
    return { state: 'pending', reason: 'overlay_uncertain', measured: true, overlay: summary };
  }
  return { state: 'eligible', reason: null, measured: true, overlay: summary };
}

export interface MarketplaceEligibilityDetail {
  [key: string]: unknown;
  marketplace_display_eligible: boolean;
  marketplace_eligibility_state: MarketplaceEligibilityState;
  marketplace_rejection_reason: MarketplaceRejection | null;
  marketplace_measured: boolean;
  marketplace_measured_sha256: string | null;
  marketplace_overlay: {
    largest_share: number;
    total_share: number;
    region_count: number;
    text_height_share: number;
    text_line_count: number;
    faint_text_height_share: number;
    faint_text_line_count: number;
  } | null;
  marketplace_eligibility_version: number;
}

/**
 * The `source_detail` keys the decision contributes.
 *
 * Stored beside the role rather than replacing anything in it, so a reader can
 * always see BOTH what the source said and what the marketplace did about it.
 * `marketplace_display_eligible` stays a boolean for anything already reading
 * it, and is true ONLY for the eligible state.
 */
export function marketplaceEligibilityDetail(
  eligibility: MarketplaceEligibility,
  /**
   * The SHA-256 of the bytes that were actually measured, where the caller
   * has them — which every writer does, because judging requires the bytes.
   *
   * THE VERDICT WAS THE ONE SERVING RECORD NOT BOUND TO ITS BYTES. A
   * derivative, a clearance and a repair region all name the exact original
   * by hash and stop resolving when the object changes; the eligibility
   * verdict — the record that lets an ORIGINAL be served — named nothing, so
   * a row re-stored with different bytes kept a verdict reached about the old
   * ones, and the settler saw a current version and never looked again.
   * Optional so a caller that genuinely lacks the bytes writes an unbound
   * verdict (read exactly as before), never a wrong one.
   */
  measuredSha256?: string | null,
): MarketplaceEligibilityDetail {
  return {
    marketplace_display_eligible: eligibility.state === 'eligible',
    marketplace_eligibility_state: eligibility.state,
    marketplace_rejection_reason: eligibility.reason,
    marketplace_measured: eligibility.measured,
    marketplace_measured_sha256: measuredSha256 ?? null,
    marketplace_overlay: eligibility.overlay
      ? {
        largest_share: eligibility.overlay.largestShare,
        total_share: eligibility.overlay.totalShare,
        region_count: eligibility.overlay.regionCount,
        text_height_share: eligibility.overlay.textHeightShare,
        text_line_count: eligibility.overlay.textLineCount,
        faint_text_height_share: eligibility.overlay.faintTextHeightShare,
        faint_text_line_count: eligibility.overlay.faintTextLineCount,
      }
      : null,
    marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION,
  };
}

/**
 * The stored state, or `pending` where none was ever made.
 *
 * AN UNJUDGED IMAGE IS PENDING, WHICH IS NOT ELIGIBLE. A row written before
 * this existed has not been judged, and treating "never looked" as "looked and
 * it was fine" is precisely the fail-open this module refuses. The autonomous
 * settler brings them all through assessment; until it has, their cards show
 * nothing.
 */
export function readMarketplaceState(
  sourceDetail: Record<string, unknown> | null | undefined,
): MarketplaceEligibilityState {
  /*
   * A VERDICT ABOUT OTHER BYTES IS NO VERDICT. Where the decision recorded
   * which bytes it measured AND the row records which bytes it holds, and the
   * two disagree, the current bytes are unjudged — `pending`, the fail-closed
   * answer, whatever the stored state says. This is the same hash binding a
   * derivative and a clearance already refuse on; the eligibility verdict was
   * the one serving record without it. GRANDFATHERED DELIBERATELY: a verdict
   * written before the measured hash existed, or a row without a stored hash,
   * reads exactly as it always did — nothing in production changes until a
   * new verdict is written, and only a REPLACED object can differ then.
   *
   * (This binds detail to detail. An object swapped in the bucket underneath
   * an unchanged row is caught for derivatives by the settler re-hashing real
   * bytes; catching it here would mean hashing on every card read.)
   */
  const measured = (sourceDetail ?? {}).marketplace_measured_sha256;
  const stored = (sourceDetail ?? {}).stored_sha256;
  if (typeof measured === 'string' && measured
    && typeof stored === 'string' && stored
    && measured !== stored) {
    return 'pending';
  }

  const raw = (sourceDetail ?? {}).marketplace_eligibility_state;
  if (raw === 'eligible' || raw === 'ineligible' || raw === 'pending') return raw;
  // A row written by the first shape of this feature, which stored only the
  // boolean. True still means measured-and-clean; anything else is unjudged.
  return (sourceDetail ?? {}).marketplace_display_eligible === true ? 'eligible' : 'pending';
}

/** The version the stored decision was made under. 0 when never made. */
export function readEligibilityVersion(
  sourceDetail: Record<string, unknown> | null | undefined,
): number {
  const raw = (sourceDetail ?? {}).marketplace_eligibility_version;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** May this image be drawn on a card? ONLY an explicit `eligible` may. */
export function isMarketplaceEligible(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  return readMarketplaceState(sourceDetail) === 'eligible';
}

/**
 * Does this stored decision need making again?
 *
 * ONE TEST, AND IT IS THE VERSION. A row judged under the current algorithm is
 * finished with, whichever of the three answers it reached.
 *
 * INCLUDING `pending`, WHICH IS THE PART THAT WAS WRONG. A pending row used to
 * come back on every pass, on the reasoning that a better decoder might read it
 * next time. But a better decoder arrives with a version bump, never between
 * two ticks of the same one — so the row was re-downloaded, re-decoded and
 * re-refused every five minutes for ever, while the upload's marker said its
 * eligibility work was complete. The two statements contradicted each other,
 * and the sweep could never go quiet.
 *
 * So all three states are TERMINAL FOR THE VERSION THAT PRODUCED THEM. Pending
 * still hides the picture — that has not changed and is the whole point of the
 * third state — it simply stops being a reason to do the same work again.
 * Improving a decoder or the classifier means bumping
 * `MARKETPLACE_ELIGIBILITY_VERSION` (and the database-side target beside it),
 * which is what brings every one of them back for a real second look.
 *
 * A row that has never been judged reads as version 0, so it is outstanding.
 */
export function needsEligibilityAssessment(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  /*
   * DELIBERATELY NOT EXTENDED WITH THE HASH-MISMATCH TEST above. Where the
   * bucket's bytes genuinely disagree with the row's recorded hash, a
   * re-judge writes a fresh verdict bound to the actual bytes — still
   * mismatched against `stored_sha256` — and a sweep keyed on that mismatch
   * would re-download and re-judge the same row on every pass for ever,
   * which is exactly the never-quiet failure the version-terminal rule
   * exists to prevent. The read side already fails such a row closed; what
   * brings every stored verdict through the binding is the next version
   * bump, which re-judges everything under the current rules once.
   */
  return readEligibilityVersion(sourceDetail) < MARKETPLACE_ELIGIBILITY_VERSION;
}

// ---------------------------------------------------------------------------
// WILL ANY SWEEP EVER JUDGE THIS ROW?
// ---------------------------------------------------------------------------

/**
 * The row filter BOTH verdict sweeps apply before they spend anything.
 *
 * MEASURED 11 SEPTEMBER 2026, and it is the whole of why a property can sit on
 * "Finding a picture…" for ever. `settleMarketplaceEligibility` and
 * `settleImageSanitization` each open their loop with
 * `if (!isPrimaryRole(readStoredRole(detail))) continue;` — only the image a
 * source DESIGNATED as the property's hero is worth a decode. That is right,
 * and it means a row of any other role is owed nothing by either sweep: its
 * eligibility version stays 0 and its sanitization stays unsettled, for ever,
 * BY DESIGN.
 *
 * `nextImageStage` asked the second half of that question and not the first.
 * It read "eligibility version 0" as EVIDENCE THAT HAS NOT ARRIVED and
 * answered `wait` — the one answer in that function with no exit — so the
 * fallback ladder was never entered, `enrichment_status` stayed `pending`,
 * the row never left `readFallbackQueue`, and the settler re-claimed it at
 * `fallback` immediately because a tick that attempted something reports
 * progress. Production, one 80-second invocation: 126 iterations of the same
 * property at the same stage, resolving nothing.
 *
 * The shape that reaches it is ordinary and will recur for every builder:
 * a package document whose pages store fine but which the election REFUSES,
 * because no page states this property's identity. Every image it left behind
 * carries `role: "unknown"`. `Lot 1037 Wollert Rise · Vanta 20` is one, and
 * the next wrong brochure anybody links is the next one.
 *
 * So the filter is named ONCE, here, and imported by all three readers. Two
 * modules deciding separately what is owed is what produced a question that
 * could never be answered.
 */
export function sweepWillJudge(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  return isPrimaryRole(readStoredRole(sourceDetail));
}

/**
 * Is a verdict about this stored image still genuinely on its way?
 *
 * TRUE means a sweep will write something here and the ladder must wait for
 * it. FALSE means the question is CLOSED — either judged, or never going to
 * be — and a caller deciding what to do next may proceed.
 *
 * The asymmetry is the point: "not yet judged" and "will never be judged"
 * look identical in the column and mean opposite things to anybody choosing
 * whether to spend money on a search.
 */
export function sourceVerdictOutstanding(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  if (!sweepWillJudge(sourceDetail)) return false;
  const detail = sourceDetail ?? {};
  /*
   * SANITIZATION IS OWED ONLY WHERE THE SANITIZATION SWEEP WOULD TAKE THE
   * ROW. This used to demand a sanitization stamp from EVERY primary, and
   * the sweep only ever stamps the rows it admits — so a verdict the
   * eligibility pass left `pending` (an uncertain overlay, an unreadable
   * container) was owed a stamp nobody would ever write, this answered
   * `outstanding` for ever, `nextImageStage` answered `wait` — the one
   * answer with no exit — and the property looped at `fallback` under the
   * stall guard for the rest of time.
   *
   * MEASURED 12 SEPTEMBER 2026 on `LOT 48 - EMBER - FLYER.pdf`: a clean
   * facade render whose one faint mark is the sunlit rim of a CLOUD, judged
   * `overlay_uncertain` (its summary is indistinguishable from pale type on
   * a pale sky — four candidate instruments were calibrated on the real
   * bytes against the protected pale-typography corpus and none separates
   * the two populations). The verdict is honest; what was wrong is that the
   * ladder waited on a repair the repair sweep is built to refuse:
   * "'we could not read it' is not 'there is a badge on it'", its own
   * header says, and an uncertain mark is no more a badge than an
   * unreadable one. Eight, then thirty-eight claims of one property at one
   * stage, every completion `stalled: fallback reported progress without
   * leaving the stage`.
   *
   * The rule is the module's own rule, applied to its second half: asked of
   * the sweeps, not of the column. `sanitizationSweepAdmits` is the sweep's
   * admission filter, imported by the sweep itself, so the two cannot
   * disagree about what is owed.
   */
  return needsEligibilityAssessment(detail)
    || (sanitizationSweepAdmits(detail)
      && !sanitizationSettled(detail, storedOriginalSha(detail)));
}

/**
 * Would `settleImageSanitization` take this row, once the role filter has
 * passed it?
 *
 * THE SWEEP'S OWN SECOND FILTER, NAMED ONCE AND IMPORTED BY THE SWEEP. It
 * repairs a designated primary the display gate CONVICTED of carrying a
 * laid-over graphic, and a primary somebody recorded a repair region
 * against — and nothing else: not a `pending` verdict ("we could not read
 * it" is not "there is a badge on it") and not an `eligible` one (a clean
 * photograph must never go through an encoder for no reason). Those two
 * sentences are the sweep's header; this function is them as a predicate.
 *
 * `sourceVerdictOutstanding` reads it so the fallback ladder waits for a
 * sanitization verdict exactly where one will ever be written. A second
 * copy of this condition inside the sweep is how the ladder came to wait,
 * for ever, on rows the sweep is built to skip.
 *
 * The region read fails closed (malformed, mis-attributed or oversized
 * reads as none), which is the right direction twice over: the sweep
 * without a region falls back to the conviction test, and the ladder
 * without one stops waiting.
 */
export function sanitizationSweepAdmits(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  const detail = sourceDetail ?? {};
  if (readRepairRegion(detail, storedOriginalSha(detail))) return true;
  return readMarketplaceState(detail) === 'ineligible'
    && detail.marketplace_rejection_reason === 'annotated_marketing_tile';
}
