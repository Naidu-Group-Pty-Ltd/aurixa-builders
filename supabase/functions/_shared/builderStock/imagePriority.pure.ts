/**
 * Builder stock — WHICH PICTURE A CARD DRAWS, and in what order of preference.
 *
 * THE RULE THIS REPLACES was "the builder's own image, or nothing":
 * `chooseDisplayableImage` filtered to stage-1 source rows and returned null
 * for everything else. That was deliberate and it was right while the only
 * alternatives were an unverified search hit and a satellite tile — neither of
 * which is a photograph of the property, and both of which were being written
 * anyway. The cost was a marketplace of empty frames whenever a builder's
 * source carried no usable render.
 *
 * The rule is now a PRIORITY, and the ranking is the whole of it:
 *
 *   1  the builder's own file, measured clean or cleared
 *   2  the builder's own file with a promotional graphic rebuilt out of it
 *   3  a web-search photograph VERIFIED to be this exact property
 *   4  Street View of this exact address
 *   5  nothing
 *
 * FOUR THINGS THIS MODULE WILL NOT DO, and each is a defect it exists to
 * prevent rather than a preference:
 *
 * A FALLBACK NEVER OUTRANKS A SOURCE. Not a better-looking one, not a newer
 * one, not a higher-confidence one. If the builder supplied a usable picture
 * of the property, that is the picture — which is also what stops the
 * expensive stages from being worth running at all (`images.ts`).
 *
 * FINDING A URL IS NOT VERIFYING A PROPERTY. Every `internet_search` row this
 * system has ever written carries `verification_status: 'unverified'`, and
 * 439 of them exist in production. Those are candidates a model reported; not
 * one of them has been checked against the address. So displayability requires
 * a POSITIVE verification state that no historical row can have — see
 * `WEB_VERIFIED_VERIFICATION` — and the absence of one is never displayable.
 *
 * STREET VIEW IS OF AN ADDRESS, AND ONLY IF IT IS STREET VIEW. The existing
 * Google stage falls back from a Street View still to a satellite tile of the
 * same point. A satellite tile is not a photograph of a house and this ranking
 * does not treat it as one: `product` must say `streetview`.
 *
 * AND NOTHING HERE IS "BUILDER SUPPLIED" EXCEPT THE BUILDER'S OWN FILE. The
 * badge is derived from the same decision that picked the image, so the card
 * cannot say one thing while the ranking did another. See `provenanceOf`.
 *
 * Pure: no IO, no clock, no database.
 */
import {
  SOURCE_SUPPLIED_STAGE, SOURCE_SUPPLIED_VERIFICATION,
  chooseDisplayableImage, isDisplayableSourceImage, servesCleanOriginal,
  type DisplayableImage,
} from './primaryImage.ts';
import { sourceVerdictOutstanding } from './marketplaceEligibility.pure.ts';

/**
 * The reference a SKIPPED stage row carries, and the message it carries.
 *
 * A skip is not a finding about the property; it records that stage 1 answered
 * so the stages below were never asked. It used to be written under the same
 * `stage-status` reference as a stage that RAN and found nothing, which made
 * the two indistinguishable — see `stageWasAttempted`.
 */
export const STAGE_SKIPPED_REFERENCE = 'stage-skipped';
export const STAGE_SKIPPED_MESSAGE =
  'Skipped: the builder supplied an image for this property.';

/**
 * Did this stage actually RUN, or was it merely skipped?
 *
 * A skip is written when stage 1 has answered, and STAGE 1'S ANSWER CAN
 * CHANGE. A builder image measured clean today can be re-measured as a
 * marketing tile tomorrow — a new cover on the same row, a decoder that reads
 * more of the frame, a version bump. When it does, the skip rows written under
 * the old answer are still sitting there, and every test below that asks "is
 * there a row for this stage?" reads them as an exhausted stage.
 *
 * Measured in production: two properties settled with a displayable builder
 * cover, both paid stages recorded `Skipped: the builder supplied an image`,
 * and the cover was later refused as an annotated marketing tile. The cards
 * went blank holding two rows that said the fallback ladder had been tried.
 * Neither stage had ever been asked.
 *
 * Skips written before this reference existed are recognised by their message,
 * which is why it is a constant rather than a literal at the call site.
 */
/**
 * How many passes on which a stage COULD NOT RUN stand as that stage having run.
 *
 * A STAGE THAT DID NOT RUN IS NOT A STAGE THAT ANSWERED, and the distinction
 * is not `unavailable` versus `failed` — it is whether the provider was asked
 * and replied about THIS property.
 *
 *   answered   "No published imagery was found for this property."
 *              "That address could not be located."
 *              "The nearest panorama is 300 m away."
 *   never ran  "The property search service did not respond."   (an outage)
 *              "This property has no street address to look up." (a missing input)
 *              "Location imagery is not configured for this workspace."
 *              "The daily limit has been reached."
 *
 * An answer is knowledge about the property and the ladder moves on from it. A
 * pass that never ran is knowledge about US, and crediting it retires a rung
 * the property was never actually offered. Measured on one import: 58
 * properties had stage 2 retired by a provider being down, and 86 had stage 3
 * retired for want of an address that was in the row the whole time, split
 * across three columns.
 *
 * The ceiling is what keeps the correction from becoming the defect it
 * replaces. Withholding the rung without a bound asks a broken — or an
 * unconfigured — provider for the same stage on every claim, for ever, and
 * pays for it; that is the loop `stageWasAttempted` was widened to close in
 * the first place. Two passes is the same ceiling `MAX_PACKAGE_ATTEMPTS` sets
 * on a builder package, for the same reason: enough to ride out an outage, not
 * enough to fund one.
 */
export const MAX_BLOCKED_PASSES = 2;

/**
 * How many passes this stage has been blocked on.
 *
 * A row written before the counter existed carries ONE — itself. Reading it as
 * zero would let every historical row re-enter the ladder with a full budget,
 * which on a deployment-wide re-open is a bill rather than a repair.
 */
export function blockedPassCount(image: DisplayableImage): number {
  const detail = (image as DisplayableImage & { source_detail?: unknown }).source_detail;
  const raw = (detail && typeof detail === 'object')
    ? (detail as Record<string, unknown>).blocked_passes : null;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Did this row record a stage that RAN and answered about the property? */
function stageRanToAnAnswer(image: DisplayableImage): boolean {
  if (image.processing_status === 'failed') return false;
  const detail = (image as DisplayableImage & { source_detail?: unknown }).source_detail;
  const ran = (detail && typeof detail === 'object')
    ? (detail as Record<string, unknown>).stage_ran : undefined;
  /*
   * UNDECIDED MEANS ANSWERED, which is the behaviour that shipped. A row
   * written before this flag existed cannot be classified from its text, and
   * guessing would either strand a property or buy a stage again on every
   * historical row in the deployment. The one-time recovery for those is the
   * ladder generation, which CLEARS this bookkeeping rather than reinterpreting
   * it — see 20261027010000.
   */
  return ran !== false;
}

export function stageWasAttempted(image: DisplayableImage, stage: string): boolean {
  if (image.source_stage !== stage) return false;
  const row = image as DisplayableImage & {
    source_reference?: unknown; error_message?: unknown;
  };
  if (row.source_reference === STAGE_SKIPPED_REFERENCE) return false;
  if (row.error_message === STAGE_SKIPPED_MESSAGE) return false;
  if (!stageRanToAnAnswer(image)) return blockedPassCount(image) >= MAX_BLOCKED_PASSES;
  return true;
}

/** Where a web-search image lives. Unchanged; its VERIFICATION is what is new. */
export const WEB_SEARCH_STAGE = 'internet_search';

/**
 * The verification a web-search row must carry to be shown.
 *
 * DELIBERATELY NOT `verified`, and not any value already in the table. Every
 * historical row is `unverified`; a value they might plausibly have been given
 * by some earlier code path would make this rule retroactive, and the one
 * thing it must never be is retroactive. A row reaches this state only by
 * passing `verifiedWebIdentity`, which is written at the moment the identity
 * evidence is recorded.
 */
export const WEB_VERIFIED_VERIFICATION = 'property_identity_verified';

/** Where location imagery lives, and the only product of it that is a photograph. */
export const STREET_VIEW_STAGE = 'google_maps';
export const STREET_VIEW_PRODUCT = 'streetview';

/** What a card may honestly say about where its picture came from. */
export type ImageProvenance = 'builder_supplied' | 'web_sourced' | 'street_view';

export interface RankedImage<T extends DisplayableImage = DisplayableImage> {
  image: T;
  /** 1 = clean source … 4 = Street View. Lower wins. */
  rank: number;
  provenance: ImageProvenance;
}

/**
 * Does this row carry a web-search result whose identity was actually checked?
 *
 * Every clause is a separate way the old `unverified` rows fail, and they fail
 * on the FIRST one: the verification state itself. The rest guard a row that
 * has the state but not the evidence behind it — which is what a partial write
 * or a hand-edited row looks like.
 */
export function isVerifiedWebImage(image: DisplayableImage): boolean {
  if (image.source_stage !== WEB_SEARCH_STAGE) return false;
  if (image.verification_status !== WEB_VERIFIED_VERIFICATION) return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;

  const detail = (image.source_detail ?? {}) as Record<string, unknown>;
  const identity = detail.property_identity as Record<string, unknown> | undefined;
  if (!identity || typeof identity !== 'object') return false;
  // The evidence that was actually matched, and what it was matched against.
  // A verification that cannot say what it checked is not one.
  if (!Array.isArray(identity.matched) || !identity.matched.length) return false;
  if (typeof identity.verified_at !== 'string' || !identity.verified_at) return false;
  return true;
}

/**
 * Is this a Street View still of the property's own address?
 *
 * `product` is the discriminator and it is checked positively: the same stage
 * also stores `staticmap` satellite tiles, which are location imagery and are
 * not a photograph of a house. A row with no product recorded is not treated
 * as Street View.
 */
export function isStreetViewImage(image: DisplayableImage): boolean {
  if (image.source_stage !== STREET_VIEW_STAGE) return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;
  const detail = (image.source_detail ?? {}) as Record<string, unknown>;
  if (detail.product !== STREET_VIEW_PRODUCT) return false;
  // Bound to a geocode of this property's address, not to a place name.
  return typeof detail.address === 'string' && !!detail.address
    && Number.isFinite(Number(detail.latitude))
    && Number.isFinite(Number(detail.longitude));
}

/**
 * Rank one row, or refuse it.
 *
 * The source tiers are decided by the EXISTING rules
 * (`isDisplayableSourceImage`, `servesCleanOriginal`) rather than by anything
 * restated here, so provenance, role and eligibility keep exactly the meaning
 * they already had.
 */
export function rankImage<T extends DisplayableImage>(image: T): RankedImage<T> | null {
  if (isDisplayableSourceImage(image)) {
    return {
      image,
      rank: servesCleanOriginal(image) ? 1 : 2,
      provenance: 'builder_supplied',
    };
  }
  if (isVerifiedWebImage(image)) return { image, rank: 3, provenance: 'web_sourced' };
  /*
   * STREET VIEW IS NO LONGER A CARD IMAGE, AND THAT REVERSES A DECISION MADE
   * HERE DELIBERATELY.
   *
   * Rank 4 existed because "the builder's own image, or nothing" left a
   * marketplace of empty frames, and a Street View still of the property's own
   * address is at least a photograph of somewhere real. What it is not is a
   * photograph of the PROPERTY. These lots are house-and-land packages in
   * estates under construction, so the still is of bare dirt or, on Lot 502
   * Mambourin, a roundabout — reported as "street views that make no sense",
   * beside a repeated instruction that a card's picture comes from the
   * builder's uploaded stock.
   *
   * `isStreetViewImage` stays, and so does every row: this changes what may be
   * DRAWN, not what may be stored or recorded. A property whose only picture is
   * a Street View now reads as having none, which this marketplace already
   * says out loud and can act on — and which is the programme's own rule, that
   * a correct blank beats a wrong property's photograph.
   */
  return null;
}

/**
 * The picture this property shows, and what the card may say about it.
 *
 * Ties inside a tier are broken exactly as they always were — the source
 * evidence level first, then position, then id — by delegating tier 1/2 to
 * `chooseDisplayableImage`. A fallback tier has no evidence level to compare,
 * so position and id decide, which is stable and is all that is available.
 */
export function chooseCardImage<T extends DisplayableImage>(
  images: T[],
): RankedImage<T> | null {
  const ranked = (images ?? []).map(rankImage).filter(Boolean) as Array<RankedImage<T>>;
  if (!ranked.length) return null;

  const best = Math.min(...ranked.map((entry) => entry.rank));

  // Tiers 1 and 2 are the builder's own rows, and their ordering is the one
  // this programme already proved — including that a clean original outranks a
  // sanitized derivative of the same source.
  if (best <= 2) {
    const chosen = chooseDisplayableImage(ranked
      .filter((entry) => entry.rank <= 2)
      .map((entry) => entry.image));
    if (!chosen) return null;
    return {
      image: chosen,
      rank: servesCleanOriginal(chosen) ? 1 : 2,
      provenance: 'builder_supplied',
    };
  }

  return ranked
    .filter((entry) => entry.rank === best)
    .sort((a, b) =>
      (a.image.position ?? 0) - (b.image.position ?? 0)
      || String(a.image.id).localeCompare(String(b.image.id)))[0];
}

/** What the card says. Derived from the choice, never recorded beside it. */
export function provenanceOf(image: DisplayableImage): ImageProvenance | null {
  return rankImage(image)?.provenance ?? null;
}

/** The human label for a provenance. One place, so no surface can invent one. */
export const PROVENANCE_LABEL: Record<ImageProvenance, string> = {
  builder_supplied: 'Builder supplied',
  web_sourced: 'Web sourced',
  street_view: 'Street View',
};

/**
 * WHICH EXPENSIVE STAGE, IF ANY, THIS PROPERTY STILL NEEDS.
 *
 * The ordering rule that stops all three from being run and ranked afterwards:
 * a property with a usable source picture needs neither of the paid stages,
 * and one with a verified web photograph does not need Street View.
 *
 * `pending` is the case that must not be got wrong. A source image whose
 * display verdict has not been measured yet is EVIDENCE THAT HAS NOT ARRIVED,
 * not evidence of absence — spending a search on it is how a builder's own
 * render loses to a stock photo of somebody else's estate. So it answers
 * `wait`, and the caller tries again rather than paying.
 */
export type NextImageStage = 'none' | 'wait' | 'web_search' | 'street_view';

export function nextImageStage(
  images: DisplayableImage[],
  options: { sourceSettlementComplete: boolean },
): NextImageStage {
  const rows = images ?? [];
  if (rows.some((image) => isDisplayableSourceImage(image))) return 'none';

  /*
   * A source row that is still on its way to a verdict — stored but not yet
   * measured, or measured and now being repaired. Either way the question
   * "does this property have a picture of its own?" is unanswered.
   *
   * AND A REFUSAL IS AN ANSWER. This used to be `!isDisplayableSourceImage`
   * and nothing else, so a source image that had been measured, refused, and
   * whose repair question was closed too counted as evidence that had not
   * arrived — for ever. `wait` writes nothing and advances nothing, so such a
   * property never reached stage 2 or stage 3 however many times it was
   * claimed. It is the only answer here with no exit, which is what made it
   * the dangerous one to get wrong.
   *
   * ASKED OF THE SWEEPS, NOT OF THE COLUMN. This used to test the version and
   * the derivative directly — "the same test the eligibility sweep itself
   * uses", the comment said — and it was half of it. Both sweeps also skip any
   * row the source did not designate as the property's hero, so a row of any
   * other role reads unjudged for ever and this answered `wait` for ever:
   * measured, one property re-claimed 126 times inside a single invocation,
   * and its card said "Finding a picture…" indefinitely.
   * `sourceVerdictOutstanding` is the one place that says what is genuinely
   * owed, over `sweepWillJudge` — which both sweeps and `awaitingVerdict` now
   * call too, so no reader can drift from another. See its header for the
   * failure in full.
   *
   * A convicted image with both questions closed is a finished stage 1 with a
   * negative answer, and the ladder moves down — which is precisely what the
   * package-retirement path promises when it says a property "loses its
   * builder image and GAINS the fallback ladder".
   */
  const sourcePending = rows.some((image) => {
    if (image.source_stage !== SOURCE_SUPPLIED_STAGE) return false;
    if (image.verification_status !== SOURCE_SUPPLIED_VERIFICATION) return false;
    if (image.processing_status === 'failed') return false;
    if (isDisplayableSourceImage(image)) return false;
    return sourceVerdictOutstanding(image.source_detail);
  });
  if (sourcePending || !options.sourceSettlementComplete) return 'wait';

  /*
   * A STAGE THAT RAN AND FOUND NOTHING HAS BEEN TRIED.
   *
   * This used to count a stage as attempted only where it had left a `ready`
   * row, so a search that returned nothing — or returned only candidates the
   * identity check refused — read as a stage never run, and the ladder asked
   * for it again instead of moving down. Lot 1663 Ringer Street spent both of
   * its passes on `web_search`, was marked `failed`, and left the queue with
   * Street View NEVER ATTEMPTED; Lot 3 Yamanto and Lot 1342 Austin Estate the
   * same. All three showed blank on the live Marketplace with an untried stage
   * behind them. Any row for a stage is now the record that it ran.
   */
  if (rows.some((image) => isVerifiedWebImage(image))) return 'none';
  if (!rows.some((image) => stageWasAttempted(image, WEB_SEARCH_STAGE))) return 'web_search';

  if (rows.some((image) => isStreetViewImage(image))) return 'none';
  if (!rows.some((image) => stageWasAttempted(image, STREET_VIEW_STAGE))) return 'street_view';

  // Every stage has been tried and none produced a displayable picture.
  return 'none';
}
