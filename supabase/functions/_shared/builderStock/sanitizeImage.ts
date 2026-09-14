/**
 * Builder stock — the order the two repairs are tried in, and the proof.
 *
 * ONE ENTRY POINT, taking the builder's bytes and returning either a cleaned
 * copy of them or a refusal. Ingestion calls it as an image is stored and the
 * settler calls it for everything stored before it existed, so a picture
 * imported tomorrow and a picture imported last year get the identical
 * treatment from the identical code.
 *
 * THE ORDER IS DETERMINISTIC FIRST, ALWAYS.
 *
 *   clean            the detector found no laid-over graphic → NOTHING IS DONE.
 *                    The builder's file is served exactly as supplied. A repair
 *                    that runs on a picture nobody objected to is a change to a
 *                    photograph for no reason.
 *
 *   small and quiet  `sanitizeOverlay` — arithmetic, no model, no network, the
 *                    same bytes out every time. This is the preferred answer
 *                    and it is tried first even when the generative route is
 *                    available, because a reconstruction nobody has to trust
 *                    beats one somebody does.
 *
 *   large or busy    only then, `inpaintOverlay` — the same mask, the same
 *                    original, a model rebuilding what was behind it, and the
 *                    result composited at the mask alone.
 *
 * AND THE ANSWER IS CHECKED BEFORE IT IS OFFERED. Whatever produced it, the
 * result goes back through the SAME classifier that refused the original. A
 * repair that leaves the graphic legible measures as annotated a second time
 * and is refused here — recorded as work done, never served. That is the only
 * honest way to claim the marketing is gone: not that a repair ran, but that
 * the thing which objected no longer objects.
 *
 * NOTHING HERE CAN SUBSTITUTE AN IMAGE. Every path returns either a derivative
 * of these exact bytes or a refusal. There is no branch that reaches another
 * image, another property, a search, a map, a render or a generator, and the
 * refusal deliberately carries no candidate for a caller to fall back to.
 */
/*
 * `decodeThumbnailResult` is still needed in `finish`, and deliberately: that
 * one reads back the artefact that will be STORED, which is a check of the
 * encoder and not a second reading of the input. Only the input's double decode
 * is gone.
 */
import { decodeRasterBoth, decodeThumbnailResult } from './sourceImageRaster.ts';
import {
  measureFaintOverlayText, measureFlatColourRegions, overlayTextBoxes, readMarketingOverlay,
} from './marketingOverlay.pure.ts';
import { overlayPlateMask, promotionalRegions } from './overlayPlate.pure.ts';
import {
  decideOverlayClearance, type OverlayInspection,
} from './overlayClearance.pure.ts';
import { growOverlayMask, sanitizeOverlay } from './sanitizeOverlay.pure.ts';
import { inpaintOverlay, type InpaintInput } from './inpaintOverlay.ts';
import { encodePng } from './rasterPng.ts';
import { decideMarketplaceEligibility } from './marketplaceEligibility.pure.ts';
import type {
  SanitizationFailureReason, SanitizationTransformation,
} from './sanitizedDerivative.pure.ts';

export type SanitizeImageResult =
  | {
    ok: true;
    /** A PNG of the repaired picture. Lossless: nothing is re-compressed. */
    bytes: Uint8Array;
    width: number;
    height: number;
    transformation: SanitizationTransformation;
    repairedShare: number;
    regionsRemoved: number;
    model: string | null;
    /** The REPAIR's own verdict on itself. See `repairAccepted`. */
    verdict: 'eligible' | 'ineligible' | 'pending';
    /** What the display classifier makes of the result, recorded but not obeyed. */
    classifierState: 'eligible' | 'ineligible' | 'pending';
  }
  | {
    ok: false;
    reason: SanitizationFailureReason | 'not_annotated';
    detail: string;
    transformation: SanitizationTransformation | null;
    model: string | null;
    /**
     * THE REPAIR THAT WAS REFUSED, KEPT SO SOMEBODY CAN LOOK AT IT.
     *
     * Deliberately not called `bytes`, and deliberately never returned on any
     * path that could be mistaken for a result: this is a rejected render, and
     * the caller stores it under its own name where nothing serves it. "We
     * tried and the graphic is still there" is a claim an operator has to be
     * able to check, and a refusal that throws the evidence away makes the next
     * improvement guesswork.
     */
    rejected?: { bytes: Uint8Array; width: number; height: number };
    /**
     * TRUE WHEN NOTHING WAS LEARNED ABOUT THE PICTURE.
     *
     * A decoder that fell over, a mask that could not be placed, a model that
     * could not be reached — none of these is an answer about whether this
     * photograph carries a badge, and none may be written down as one. The
     * caller leaves the row untouched and comes back, exactly as it does for a
     * download that failed. Writing an operational fault into the ledger parks
     * a picture on "we tried" until the next version bump, which is how one
     * billing outage could permanently blank a card.
     */
    operational?: boolean;
    /**
     * THE PICTURE WAS INSPECTED AND CARRIES NOTHING TO REMOVE.
     *
     * Present only on the `nothing_to_remove` and `not_annotated` paths, and
     * only when every test in `overlayClearance.pure.ts` passed. It is not a
     * softer refusal: it licenses the caller to serve the builder's ORIGINAL,
     * which is the one thing a refusal must never do. A caller that ignores it
     * behaves exactly as before, which is what keeps this safe to add.
     */
    clearance?: OverlayInspection;
    /** Why no clearance was granted, when one was considered and refused. */
    clearanceRefusal?: string | null;
  };

export interface SanitizeImageOptions {
  /**
   * Whether the generative route may be used at all.
   *
   * A deployment with no credential, or one that has switched it off, still
   * gets the deterministic repair — the two are independent, and a missing key
   * must not turn a picture the arithmetic could have fixed into a blank card.
   */
  allowGenerative?: boolean;
  /** Injected in tests. Production passes nothing. */
  edit?: InpaintInput['edit'];
  /**
   * A repair region the CALLER has already established, as fractions of the
   * picture's own width and height.
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT A WAY ROUND THE DETECTOR. The detector
   * is the authority on whether a picture may be DRAWN, and nothing here
   * changes that: a caller supplying a region is not asking for a different
   * verdict, it is saying "I have identified this rectangle by other means,
   * rebuild it". The routine case remains detector-driven and is byte-for-byte
   * unchanged when this is absent.
   *
   * It exists because the detector's mask builder reads lines of TYPE, and a
   * plate whose lettering is below the measuring resolution has no measurable
   * extent — so a promotional plate can be real, visible to a person, and
   * still produce no mask. Without this there is no way to repair such a
   * picture except to move a global threshold, which was measured against real
   * clean production facades and is not safe.
   *
   * Fractions rather than pixels so a caller never has to know the size of the
   * reduction the classifier happens to measure on.
   *
   * IT GRANTS NO NEW POWERS. The supplied region chooses only which pixels are
   * rebuilt; every other rule is untouched — the deterministic route is still
   * tried first, the result still goes back through the same classifier before
   * it may be offered, and compositing still restricts the change to the mask.
   *
   * A LIST IS SEVERAL SEPARATED MARKS, NOT A BIGGER ONE. One picture can
   * carry a pill in one corner, a plate in another and a strip along the
   * bottom; a single rectangle spanning them is mostly house. The mask is the
   * union of the boxes, the ceiling applies to that union (`readRepairRegion`
   * enforced it before the record was ever handed here, and Barrier B
   * re-measures the final grown set regardless), and a single box behaves
   * exactly as it always did.
   */
  repairRegion?:
    | { left: number; top: number; right: number; bottom: number }
    | Array<{ left: number; top: number; right: number; bottom: number }>;
}

/**
 * A caller-supplied region, as a mask at the measured reduction's own size.
 *
 * Clamped to the picture and refused when it is empty or inverted, so a
 * malformed region is the same as none rather than a mask over the whole
 * photograph — and ONE malformed box voids the set, because a caller whose
 * record is partly nonsense is not a caller whose remaining rectangles can
 * be trusted to mean what they say.
 */
function suppliedRepairMask(
  region: SanitizeImageOptions['repairRegion'],
  width: number,
  height: number,
): { mask: Uint8Array; regions: number } | null {
  if (!region) return null;
  const boxes = Array.isArray(region) ? region : [region];
  if (!boxes.length) return null;
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(max, Math.round(value * max)));

  const mask = new Uint8Array(width * height);
  for (const box of boxes) {
    const left = clamp(box.left, width);
    const right = clamp(box.right, width);
    const top = clamp(box.top, height);
    const bottom = clamp(box.bottom, height);
    if (!(right > left) || !(bottom > top)) return null;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) mask[y * width + x] = 1;
    }
  }
  return { mask, regions: boxes.length };
}

/**
 * Clean this image, or say why it cannot be cleaned.
 *
 * Never throws: a decoder that falls over on a builder's file must not fail
 * their import, and the caller records the refusal like any other.
 */
export async function sanitizeSourceImage(
  bytes: Uint8Array,
  options: SanitizeImageOptions = {},
): Promise<SanitizeImageResult> {
  try {
    /*
     * ONE DECODE, BOTH READINGS. The full-size pixels are a thunk: the paths
     * that return before a repair is attempted never allocate them, exactly as
     * when this was two calls. See `decodeRasterBoth`.
     */
    const thumbnail = await decodeRasterBoth(bytes);
    if (thumbnail.ok === false) {
      // A picture nothing could decode is not a picture anything was learned
      // about. Operational, so the caller retries rather than recording it.
      return {
        ok: false, reason: 'unusable_input', transformation: null, model: null,
        operational: true,
        detail: `the picture could not be read (${thumbnail.reason})`,
      };
    }

    /*
     * THE DETECTOR IS ASKED ONCE, ON THE THUMBNAIL, AND IS NOT ADJUSTED.
     *
     * Its thresholds are fitted to the 400px reduction, and every one of them
     * would have to move to make a borderline picture reachable — which would
     * change what the marketplace refuses, not just what this repairs. A
     * picture this cannot clean stays a blank card; it does not become a reason
     * to loosen the rule that made it blank.
     */
    const verdict = readMarketingOverlay(thumbnail.thumbnail);
    const supplied = suppliedRepairMask(
      options.repairRegion, thumbnail.thumbnail.width, thumbnail.thumbnail.height);

    /*
     * THE PRECISE INSPECTION, MEASURED ONCE AND USED BY BOTH DECISIONS.
     *
     * Everything below — which pixels to rebuild, and whether there is anything
     * to rebuild at all — comes out of these four measurements, so the mask and
     * the clearance are reading one set of facts rather than two. Two readings
     * of the same picture is how a repair comes to remove a badge the clearance
     * has already decided is not there.
     *
     * THE FAINT PASS IS RUN HERE DELIBERATELY. `readMarketingOverlay` skips it
     * on a picture it has already convicted, and reports zero — which means "not
     * asked", not "asked and silent". A clearance built on that zero would be a
     * clearance built on a question nobody put.
     */
    const textBoxes = overlayTextBoxes(thumbnail.thumbnail);
    const flat = measureFlatColourRegions(thumbnail.thumbnail);
    const flatBoxes = flat.regions.map((region) => region.box);
    const promotional = promotionalRegions(thumbnail.thumbnail, flatBoxes);
    const faint = measureFaintOverlayText(thumbnail.thumbnail);

    const inspect = (plateCount: number): OverlayInspection => ({
      measured: true,
      textRunCount: textBoxes.length,
      strictTextLines: verdict?.textLineCount ?? 0,
      faintTextLines: faint.lineCount,
      flatRegionCount: flat.regions.length,
      promotionalRegionCount: promotional.length,
      plateCount,
    });

    if (!supplied && (!verdict || !verdict.annotated)) {
      /*
       * The classifier that convicted this picture and a fresh reading of the
       * same bytes disagree. That is a question for the eligibility sweep — but
       * it is also, on its own terms, a picture with nothing on it, so the
       * clearance is offered here too rather than only on the path below.
       */
      const clearance = decideOverlayClearance(inspect(0));
      return {
        ok: false, reason: 'not_annotated', transformation: null, model: null,
        detail: 'the detector found no laid-over graphic on this picture',
        clearance: clearance.cleared ? inspect(0) : undefined,
        clearanceRefusal: clearance.refusal,
      };
    }

    /*
     * THE MASK IS DERIVED FROM THE TYPE, NEVER FROM FLAT COLOUR.
     *
     * The classifier's flat-colour pass is the right instrument for "is there
     * promotional treatment here", where a false positive costs a blank card.
     * It is the WRONG instrument for "which pixels may I rebuild", where a
     * false positive removes whatever was there — and Lot 13 Hummock Rise is
     * the proof: its flat regions are the black garage door, a patch of sky,
     * and ONE of its two badges. Repairing that mask took the garage door off
     * the house and left the marketing on it.
     *
     * `overlayPlateMask` takes the lines of type the strict pass already found
     * and floods outward to find the plate each one is set on. A garage door
     * has no words on it and is never reached; neither is sky, a roof or a
     * wall. Type set straight onto the photograph has no plate, and that
     * contributes nothing rather than a guessed rectangle — such a picture
     * falls through to `nothing_to_remove`, is recorded as refused, and keeps
     * its blank card.
     */
    const plates = overlayPlateMask(thumbnail.thumbnail, textBoxes, flatBoxes);
    /*
     * A SUPPLIED REGION REPLACES THE DERIVED MASK AND NOTHING ELSE. The
     * caller has said which pixels to rebuild; it has not said anything about
     * how to rebuild them, whether the result is acceptable, or what may be
     * drawn afterwards.
     */
    const repair = supplied ?? { mask: plates.mask, regions: plates.plates.length };
    if (!supplied && !plates.plates.length) {
      /*
       * NOTHING TO REMOVE — AND THAT IS NOW TWO DIFFERENT ANSWERS.
       *
       * It can mean the picture is clean and the classifier convicted it for a
       * feature of the house, which is Lot 537 Kirramingly: no type anywhere,
       * one flat region, and that region is a WHITE GARAGE DOOR at 0.045
       * saturation. That picture gets a clearance and the builder's own file
       * goes on the card.
       *
       * Or it can mean there IS a badge and this could not find its extent —
       * type set straight onto the photograph with no plate under it. That gets
       * no clearance and keeps its blank card, exactly as before.
       *
       * The difference is decided in `overlayClearance.pure.ts` on measured
       * evidence, never on the absence of a mask. A mask that came out empty is
       * a fact about the mask builder; it is not a fact about the picture.
       */
      const clearance = decideOverlayClearance(inspect(0));
      return {
        ok: false, reason: 'nothing_to_remove',
        transformation: 'deterministic_overlay_reconstruction', model: null,
        detail: clearance.cleared
          ? 'this picture carries no promotional treatment to remove'
          : 'the graphic on this picture has no measurable extent to remove',
        clearance: clearance.cleared ? inspect(0) : undefined,
        clearanceRefusal: clearance.refusal,
      };
    }

    const raster = thumbnail.full();
    if (!raster) {
      return {
        ok: false, reason: 'unusable_input', transformation: null, model: null,
        operational: true,
        detail: 'the picture decoded as a thumbnail and not at full size',
      };
    }

    // The deterministic route first, always.
    const deterministic = sanitizeOverlay({
      width: raster.width,
      height: raster.height,
      pixels: raster.pixels,
      mask: repair.mask,
      regions: repair.regions,
      maskWidth: thumbnail.thumbnail.width,
      maskHeight: thumbnail.thumbnail.height,
    });

    if (deterministic.ok === true) {
      return await finish(
        deterministic.pixels, raster.width, raster.height,
        'deterministic_overlay_reconstruction', deterministic.repairedShare,
        deterministic.regionsRemoved, null,
        repair.mask, thumbnail.thumbnail.width, thumbnail.thumbnail.height);
    }

    /*
     * The deterministic route's two GATES are what the generative route exists
     * for; its two input faults are not. "Too much to rebuild" and "the
     * surroundings are structured" mean the arithmetic would smear — precisely
     * the case a model handles. "Nothing to remove" and "unusable input" mean
     * there is no repair to attempt, and asking a model to make one anyway is
     * how a picture with no badge on it comes back regenerated.
     */
    if (deterministic.reason !== 'background_too_detailed'
      && deterministic.reason !== 'too_much_to_rebuild') {
      return {
        ok: false, reason: deterministic.reason,
        transformation: 'deterministic_overlay_reconstruction', model: null,
        detail: `the deterministic repair had nothing it could do (${deterministic.reason})`,
      };
    }

    if (options.allowGenerative === false) {
      return {
        ok: false, reason: deterministic.reason,
        transformation: 'deterministic_overlay_reconstruction', model: null,
        detail: `the deterministic repair refused (${deterministic.reason}) and the `
          + 'generative route is not enabled here',
      };
    }

    const mask = growOverlayMask(
      repair.mask, thumbnail.thumbnail.width, thumbnail.thumbnail.height,
      raster.width, raster.height);
    if (!mask) {
      return {
        ok: false, reason: 'unusable_input',
        transformation: 'generative_overlay_inpaint', model: null,
        operational: true,
        detail: 'the mask could not be placed on the full-size picture',
      };
    }

    const generated = await inpaintOverlay({
      width: raster.width, height: raster.height, pixels: raster.pixels, mask,
      edit: options.edit,
    });
    if (generated.ok === false) {
      return {
        ok: false,
        reason: generated.reason === 'too_many_regions'
          ? 'too_much_to_rebuild' : generated.reason,
        transformation: 'generative_overlay_inpaint',
        model: null,
        detail: generated.detail,
      };
    }

    return await finish(
      generated.pixels, generated.width, generated.height,
      'generative_overlay_inpaint', generated.repairedShare, generated.regionsRemoved,
      generated.model,
      repair.mask, thumbnail.thumbnail.width, thumbnail.thumbnail.height);
  } catch (error) {
    // A thrown decoder, a thrown encoder, a thrown anything. Nothing was
    // established about the picture, so nothing is written down about it.
    return {
      ok: false, reason: 'unusable_input', transformation: null, model: null,
      operational: true,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
    };
  }
}

/**
 * Encode the repair and put it back through the classifier.
 *
 * PNG because it is lossless: a JPEG re-encode would put its own artefacts on
 * the builder's untouched pixels, which are supposed to survive this
 * byte-for-byte.
 */
async function finish(
  pixels: Uint8Array, width: number, height: number,
  transformation: SanitizationTransformation,
  repairedShare: number, regionsRemoved: number, model: string | null,
  repairedMask: Uint8Array, maskWidth: number, maskHeight: number,
): Promise<SanitizeImageResult> {
  const bytes = await encodePng(pixels, { width, height, components: 3 });
  if (!bytes) {
    // An encoder that failed says nothing about the badge. Operational.
    return {
      ok: false, reason: 'storage_failed', transformation, model,
      operational: true,
      detail: 'the repaired picture could not be encoded',
    };
  }

  /*
   * DIMENSIONS, READ OFF THE ARTEFACT THAT WILL BE STORED.
   *
   * Not off the buffer that produced it: the whole point of a validation gate
   * is to check the thing, and a re-crop or a re-scale that slipped through the
   * encoder would be invisible to a check of the inputs. The PNG header is four
   * bytes of width and four of height at a fixed offset, so this costs nothing.
   */
  const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
  if (header.getUint32(0) !== width || header.getUint32(4) !== height) {
    return {
      ok: false, reason: 'validation_failed', transformation, model,
      detail: 'the repaired picture is not the size the builder supplied',
    };
  }

  const check = await decodeThumbnailResult(bytes);
  if (check.ok === false) {
    return {
      ok: false, reason: 'validation_failed', transformation, model,
      detail: 'the repaired picture could not be read back',
    };
  }

  /*
   * THE ACCEPTANCE TEST IS ABOUT THE REPAIR'S OWN WORK, AND PRODUCTION IS WHY.
   *
   * The obvious test — put the result back through the display classifier and
   * require `eligible` — is the one I shipped first, and it is wrong in a way
   * Lot 13 Hummock Rise demonstrates exactly. Its repaired picture carries NO
   * type at all: both status pills are gone, the strict pass finds zero runs,
   * the faint pass finds zero. The classifier refuses it anyway, for one flat
   * coloured region measuring 7.6% of the frame at (90,116)-(193,179) — the
   * house's black garage door, which was there before the repair and is there
   * after it, and which is refused on the same false positive that hides the
   * completely unmarked Lot 537 Kirramingly.
   *
   * Holding the repair responsible for that is holding it responsible for a
   * judgement about a feature of the house. So the question asked here is the
   * one the repair can actually answer: IS THE MARKETING GONE, AND DID I LEAVE
   * ANYTHING BEHIND?
   *
   *   no type survives anywhere — strict pass or faint, and the faint pass is
   *   ASKED rather than read off a verdict that suppressed it — so a badge that
   *   was only partly removed still fails;
   *
   *   nothing I REBUILT came back as a flat coloured block, which is what
   *   catches a model that painted the mask over in one colour instead of
   *   reconstructing what was behind it;
   *
   *   and no flat block ANYWHERE on the result is filled with a brand colour,
   *   which is what catches a second badge the mask never covered — the case a
   *   supplied `repair_region` makes reachable, because the operator's
   *   rectangle replaces the derived mask entirely.
   *
   * A NEUTRAL flat block that does not overlap the repaired area is not the
   * repair's business and never was: that is the garage door, and holding the
   * repair to it would be holding it responsible for the house.
   */
  const surviving = readMarketingOverlay(check.thumbnail);
  const classifierState = decideMarketplaceEligibility(surviving).state;

  /*
   * THE FAINT PASS, ASKED EXPLICITLY — the same rule the pre-repair inspection
   * already states at its own call site: `readMarketingOverlay` skips the faint
   * pass on a picture it has already convicted and reports zero, and that zero
   * means "not asked", not "asked and silent". A repaired picture with a
   * surviving flat region — which is exactly the Lot 13 garage-door case this
   * gate deliberately tolerates — set `annotated` and therefore suppressed the
   * one measurement that could see pale residue. Every derivative served with
   * `classifier_state: 'ineligible'` had, by construction, never been asked the
   * faint question. So it is asked here, of the artefact that will be stored.
   */
  const survivingFaint = surviving.annotated
    ? measureFaintOverlayText(check.thumbnail)
    : { heightShare: surviving.faintTextHeightShare, lineCount: surviving.faintTextLineCount };

  if (surviving.textLineCount > 0 || survivingFaint.lineCount > 0) {
    return {
      ok: false, reason: 'still_annotated', transformation, model,
      detail: 'the repaired picture still carries laid-over type',
      rejected: { bytes, width, height },
    };
  }

  const survivingFlat = measureFlatColourRegions(check.thumbnail);
  const painted = survivingFlat.regions.find((region) =>
    boxTouchesMask(region.box, repairedMask, maskWidth, maskHeight,
      check.thumbnail.width, check.thumbnail.height));
  if (painted) {
    return {
      ok: false, reason: 'still_annotated', transformation, model,
      detail: 'the repaired area came back as a flat coloured block rather than a reconstruction',
      rejected: { bytes, width, height },
    };
  }

  /*
   * AND NO BRAND-COLOURED PLATE SURVIVES ANYWHERE — not just under the mask.
   *
   * The claim above ("a second badge that was never masked still fails") was
   * false for a wordless badge: its own flat region set `annotated`, which
   * suppressed the faint pass, and it sits away from the repaired area, which
   * is all the flat-block test looks at. The reachable case is a repair driven
   * by a supplied `repair_region`: the operator's rectangle replaces the
   * derived mask entirely, so a chromatic pill the detector can see is left
   * unmasked, survives the repair, and was served. The colour rule is the one
   * the mask builder and the clearance already trust — `isPromotionalFill`
   * excludes every neutral garage door, roof, wall and patch of sky — so this
   * cannot re-import the Lot 13 false positive; a saturated brand-colour block
   * on a repaired picture is a badge, and the repair is refused rather than
   * served with it on.
   */
  const survivingPromotional = promotionalRegions(
    check.thumbnail, survivingFlat.regions.map((region) => region.box));
  if (survivingPromotional.length) {
    return {
      ok: false, reason: 'still_annotated', transformation, model,
      detail: 'a promotional colour block survives on the repaired picture',
      rejected: { bytes, width, height },
    };
  }

  return {
    ok: true, bytes, width, height, transformation, repairedShare, regionsRemoved, model,
    verdict: 'eligible', classifierState,
  };
}

/** Does this box, in the result's raster, overlap anything the repair rebuilt? */
function boxTouchesMask(
  box: { left: number; top: number; right: number; bottom: number },
  mask: Uint8Array, maskWidth: number, maskHeight: number,
  width: number, height: number,
): boolean {
  if (!mask.length || maskWidth <= 0 || maskHeight <= 0 || width <= 0 || height <= 0) {
    return false;
  }
  for (let y = box.top; y <= box.bottom; y++) {
    const my = Math.min(maskHeight - 1, Math.max(0, Math.floor(y * maskHeight / height)));
    for (let x = box.left; x <= box.right; x++) {
      const mx = Math.min(maskWidth - 1, Math.max(0, Math.floor(x * maskWidth / width)));
      if (mask[my * maskWidth + mx]) return true;
    }
  }
  return false;
}
