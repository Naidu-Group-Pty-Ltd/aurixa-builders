/**
 * Builder stock — proving a picture the classifier refused is actually clean.
 *
 * THE CONTRADICTION THIS RESOLVES. Two instruments look at the same photograph
 * and disagree. The coarse classifier — a 400px reduction, one flat-colour pass
 * and one type pass, tuned so that a false positive costs a blank card rather
 * than a marketing tile on one — says `annotated_marketing_tile`. The precise
 * inspection the repair runs, which decodes the picture at full size and works
 * out exactly which pixels a badge occupies, finds nothing it can remove.
 *
 * Something has to give, and until now the answer was "the card stays blank",
 * which is the wrong one: Lot 537 Kirramingly Avenue is a completely unmarked
 * builder render — no pill, no ribbon, no banner, no caption — and it was
 * refused because its WHITE GARAGE DOOR is a flat coloured block. The client
 * saw an empty frame where the house was.
 *
 * SO A CLEARANCE IS A POSITIVE FINDING, NEVER A SHRUG. It says: these exact
 * bytes were inspected, and there is no promotional treatment on them to
 * remove — therefore serve the builder's original, unchanged and untouched. It
 * is emphatically NOT "the repair could not think of anything to do".
 *
 * WHICH IS WHY IT IS SO NARROW, AND WHY EVERY ONE OF THE FOUR TESTS BELOW CAN
 * REFUSE IT. Getting this wrong in the permissive direction puts marketing on a
 * client's card — the exact defect the whole programme exists to remove — and
 * the evidence available is the evidence of ABSENCE, which is the weakest kind
 * there is. So absence has to be established four ways over, and any single
 * scrap of contrary evidence keeps the picture hidden.
 *
 * THE FOURTH TEST IS THE ONE THAT WAS MISSING AND IT COST FOUR CARDS. The first
 * shape of this cleared on "the strict type pass found no words", on the
 * evidence that the five refused-and-unrepairable production images all
 * measured zero text lines while the eleven genuine marketing tiles all
 * measured one to three. That correlation was real and the inference from it
 * was wrong: FOUR of those five are Cloverton Registered, which carries
 * "Registered" in 60px type on a green pill that the type detector cannot read
 * at any resolution. Clearing on silence from the type pass would have put four
 * marketing tiles onto cards, and they would have been *promoted* there by a
 * change made in the name of removing marketing.
 *
 * What actually separates them is the colour of the flat region the classifier
 * convicted on — a brand colour or a building material — and that test lives in
 * `overlayPlate.pure.ts` with the mask that removes it, so the two cannot
 * disagree about the same region.
 *
 * Pure: no imports, no IO, no clock.
 */

/**
 * What the precise inspection saw. Every field is MEASURED, never assumed.
 *
 * `faintTextLines` in particular has to be measured deliberately by the caller.
 * `readMarketingOverlay` skips its faint pass on a picture it has already
 * convicted — a second opinion on a refusal costs a blur of the whole frame and
 * cannot change the answer — so the zero it reports there means "not asked",
 * and reading it as "asked, and nothing" is exactly the fail-open this module
 * is built to refuse.
 */
export interface OverlayInspection {
  /** False when nothing could be decoded. An unread picture is never cleared. */
  measured: boolean;
  /** Runs the strict type pass found, from `overlayTextBoxes`. */
  textRunCount: number;
  /** Lines the strict type pass counted, from `readMarketingOverlay`. */
  strictTextLines: number;
  /** Lines the faint pass counted. MUST have been run, not defaulted to zero. */
  faintTextLines: number;
  /** Flat colour regions the classifier found, of any colour. */
  flatRegionCount: number;
  /** Of those, the ones whose fill is a brand colour rather than a material. */
  promotionalRegionCount: number;
  /** Plates the mask builder resolved. Anything above zero is something to remove. */
  plateCount: number;
}

/** Why a picture was not cleared. Each is a fact, not a failure to decide. */
export type ClearanceRefusal =
  /** Nothing was decoded, so nothing was established. Operational, retryable. */
  | 'not_inspected'
  /** The strict type pass read words laid over the photograph. */
  | 'type_present'
  /** The faint pass found the shape of a line of type. */
  | 'faint_type_present'
  /** A flat region is filled with a brand colour. */
  | 'promotional_plate_present'
  /** The mask builder resolved something to remove. */
  | 'removable_plate_present';

export interface ClearanceDecision {
  cleared: boolean;
  refusal: ClearanceRefusal | null;
}

/**
 * May the builder's original be served despite the classifier refusing it?
 *
 * ORDERED SO THE REPORTED REASON IS THE STRONGEST EVIDENCE AGAINST, not the
 * first test that happened to run. An operator reading `type_present` on a
 * picture that also has a green pill on it learns less than one reading
 * `promotional_plate_present`, but they learn the same thing about the card;
 * what matters is that the reason names something real that somebody can go and
 * look at.
 */
export function decideOverlayClearance(inspection: OverlayInspection): ClearanceDecision {
  if (!inspection.measured) return { cleared: false, refusal: 'not_inspected' };

  // Something to remove was actually found. Not a clearance under any reading:
  // this picture has a repair waiting for it, not a card.
  if (inspection.plateCount > 0) {
    return { cleared: false, refusal: 'removable_plate_present' };
  }
  // A brand colour on the picture, whether or not the mask could use it.
  if (inspection.promotionalRegionCount > 0) {
    return { cleared: false, refusal: 'promotional_plate_present' };
  }
  // Words laid over the photograph.
  if (inspection.strictTextLines > 0 || inspection.textRunCount > 0) {
    return { cleared: false, refusal: 'type_present' };
  }
  // And the shape of words, which is not proof of a badge but is proof that
  // this is not a picture anybody may call clean.
  if (inspection.faintTextLines > 0) {
    return { cleared: false, refusal: 'faint_type_present' };
  }

  /*
   * Everything the classifier convicted on is a neutral flat region: a garage
   * door, a roof plane, a rendered wall, a driveway, a patch of sky. Those are
   * the house. The picture carries no promotional treatment, and the builder's
   * own file is what the card shows.
   *
   * `flatRegionCount` is deliberately NOT required to be zero. It is normally
   * one or more — that is WHY the classifier refused the picture — and
   * demanding none would clear only images the classifier never objected to,
   * which are already displayed and never reach this code at all.
   */
  return { cleared: true, refusal: null };
}
