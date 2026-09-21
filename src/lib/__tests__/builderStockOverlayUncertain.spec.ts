/**
 * A CONTROL THAT CANNOT BE SATISFIED IS AN OUTAGE, NOT A CONTROL.
 *
 * `overlay_uncertain` hides a picture and hands the question to the overlay
 * repair. The repair acts on REGIONS the strict pass located — and this state
 * is reached only when the strict pass located none, so there is nothing to
 * remove and nothing to re-decide. Measured on `LOT 48 - EMBER - FLYER.pdf`,
 * 21 September 2026: the repair logged `repaired 0, cleared 0, refused 0` and
 * the property settled with its own designated photograph hidden, for ever,
 * and its upload unpublished behind "awaiting source photographs".
 *
 * THE CORPUS, because this is a safety gate and one sample is not a
 * distribution. Of 900 measured images on this deployment: 666 eligible, 230
 * convicted `annotated_marketing_tile`, and 4 rows carrying just TWO distinct
 * pictures `uncertain`. The faint pass is well calibrated — 666 clean
 * photographs produced no faint line at all — so what is wrong is not its
 * sensitivity but that its answer is terminal.
 */
import { describe, expect, it } from 'vitest';
import {
  decideMarketplaceEligibility, marketplaceEligibilityDetail,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';

/** The Lot 48 render's measurement, verbatim from production. */
const LOT_48 = {
  annotated: false,
  uncertain: true,
  largestShare: 0,
  totalShare: 0,
  regionCount: 0,
  textHeightShare: 0,
  textLineCount: 0,
  faintTextHeightShare: 0.045,
  faintTextLineCount: 1,
};

describe('a faint-only uncertainty the document can settle', () => {
  it('is still hidden where nothing designated the picture', () => {
    const verdict = decideMarketplaceEligibility(LOT_48, false);
    expect(verdict.state).toBe('pending');
    expect(verdict.reason).toBe('overlay_uncertain');
  });

  it('is cleared where the source document designated it the cover', () => {
    const verdict = decideMarketplaceEligibility(LOT_48, true);
    expect(verdict.state).toBe('eligible');
    expect(verdict.reason).toBeNull();
  });

  /* A served picture must always be able to say what cleared it. */
  it('records what settled it, and never claims it on an ordinary pass', () => {
    expect(decideMarketplaceEligibility(LOT_48, true).resolvedBy)
      .toBe('cover_designation');
    expect(marketplaceEligibilityDetail(
      decideMarketplaceEligibility(LOT_48, true)).marketplace_resolved_by)
      .toBe('cover_designation');
    const clean = { ...LOT_48, uncertain: false, faintTextLineCount: 0 };
    expect(decideMarketplaceEligibility(clean, true).resolvedBy).toBeUndefined();
    expect(marketplaceEligibilityDetail(decideMarketplaceEligibility(clean, true))
      .marketplace_resolved_by).toBeNull();
  });
});

describe('the strict pass is untouched', () => {
  /*
   * Anything the strict pass convicts is `annotated` and never reaches the
   * uncertainty branch at all. A designation cannot rescue it.
   */
  it('never lets a designation rescue a convicted tile', () => {
    for (const designated of [false, true]) {
      const verdict = decideMarketplaceEligibility(
        { ...LOT_48, annotated: true, uncertain: false, textLineCount: 3,
          textHeightShare: 0.2 },
        designated);
      expect(verdict.state).toBe('ineligible');
      expect(verdict.reason).toBe('annotated_marketing_tile');
    }
  });

  /*
   * The bound is total silence from the strict pass. A picture it measured
   * ANYTHING on keeps its uncertainty however the document describes it.
   */
  it('refuses where the strict pass measured anything at all', () => {
    const partial = [
      { regionCount: 1 }, { textLineCount: 1 }, { largestShare: 0.02 },
      { totalShare: 0.03 }, { textHeightShare: 0.01 },
    ];
    for (const field of partial) {
      expect(decideMarketplaceEligibility({ ...LOT_48, ...field }, true).state)
        .toBe('pending');
    }
  });

  /*
   * One faint line is the shape this admits. More than one is a block of
   * type, and a banner prominent enough to matter is prominent enough for the
   * strict pass — which is what `annotated` is for. No threshold is fitted to
   * the two observations that exist; the bound is the shape.
   */
  it('refuses more than a single faint line', () => {
    expect(decideMarketplaceEligibility(
      { ...LOT_48, faintTextLineCount: 2 }, true).state).toBe('pending');
  });

  it('leaves an undecodable picture exactly where it was', () => {
    expect(decideMarketplaceEligibility(null, true).state).toBe('pending');
    expect(decideMarketplaceEligibility(null, true).measured).toBe(false);
  });

  it('changes nothing for a picture the passes agreed was clean', () => {
    const clean = { ...LOT_48, uncertain: false, faintTextLineCount: 0,
      faintTextHeightShare: 0 };
    expect(decideMarketplaceEligibility(clean, false))
      .toEqual(decideMarketplaceEligibility(clean, true));
    expect(decideMarketplaceEligibility(clean, false).state).toBe('eligible');
  });

  /* The default is the old behaviour, so an un-updated caller cannot widen it. */
  it('defaults to refusing', () => {
    expect(decideMarketplaceEligibility(LOT_48).state).toBe('pending');
  });
});
