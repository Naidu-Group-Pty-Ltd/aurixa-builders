/**
 * A LIST OF LOTS IS A LIST, AND A PRICE THE TEXT LAYER SPLIT IS STILL A PRICE.
 *
 * MEASURED 24 SEPTEMBER 2026, on a Google Sheet stock list whose every row
 * links that lot's own flyer. Twelve of its twenty-three properties came back
 * with no photograph, and the forensics run over their real flyers named two
 * causes, both in how the cover rule READS a page rather than in what it asks.
 *
 *   1. Each townhouse flyer states its lot — `Lot 29` — and then the lots its
 *      design is released on: `LOT 28, 29, 30, 36, 37, 40, 41, 43, 44`. The
 *      rule read that whole list as ONE designation of its first number (28,
 *      or 2829 fused), so the page "stated another lot" and was refused as
 *      this property's cover. The lot that happened to lead each list (28, 35)
 *      got its photograph; every other lot on the same flyer did not.
 *
 *   2. Lot 45's flyer prints its price as the exporter split it — `Price -
 *      $841, 000`, the thousands in a run of their own — and the price fact
 *      took one separator character, so the page carried one package fact
 *      against a cover's two.
 *
 * The page texts below are the flyers' shape with invented names; the
 * numbers are the measured shapes. The first block fails before the change;
 * the guards below it hold on both sides of it, because a list must never let
 * a sibling's flyer, a street number, a bedroom count or a price become a lot.
 */
import { describe, expect, it } from 'vitest';

import {
  coverIdentityRefusal,
  findPropertyCoverPages,
  packageFactsOn,
  statedOtherLotDesignation,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

/** A one-lot townhouse flyer: its own lot, then its design's release list. */
function flyer(lot: string, list: readonly string[] = ['LOT 212, 213, 214,', '220, 221, 223']): string {
  return [
    '7 Plover Walk, Mernda VIC 3754', 'Turn-Key Inclusions', 'Tallis', '3 2.5 1',
    'KESTREL GROVE', `Lot ${lot}`,
    'Front and rear landscaping, driveway + fencing',
    'Sale Price - $725,000', 'Land Size - 171sqm', 'Build Size - 153sqm',
    ...list,
  ].join('\n');
}

/** How a stock list row's label reads for these rows: the lot and the suburb. */
const label = (lot: string) => `Lot ${lot}, Mernda`;

describe('a flyer that lists the lots its design is released on', () => {
  it('is the cover of the lot it states, wherever that lot sits in the list', () => {
    for (const lot of ['212', '213', '214', '220', '221', '223']) {
      // Linked from a stock list row, so no whole-document waiver applies.
      const covers = findPropertyCoverPages([flyer(lot)], label(lot), [], false);
      expect(covers.map((c) => c.page), `lot ${lot}`).toEqual([1]);
    }
  });

  it('names no refusal for that lot', () => {
    expect(coverIdentityRefusal(flyer('220'), label('220'))).toBeNull();
  });

  it('reads a list joined by an ampersand or split across lines', () => {
    for (const list of [
      ['LOT 212, 213 & 223'],
      ['LOT 212, 213', '& 223'],
      ['LOTS 212, 213 and 223'],
      ['UNITS 212, 213 & 223'],
    ]) {
      const covers = findPropertyCoverPages([flyer('213', list)], label('213'), [], false);
      expect(covers, list.join(' / ')).toHaveLength(1);
    }
  });

  it('lets a page that names its lots only as a list present each of them', () => {
    // A release page for a group of townhouses: one render, three lots.
    const page = [
      'KESTREL GROVE', 'Tallis townhomes', 'LOTS 212, 213 & 214', 'Mernda VIC 3754',
      'From $725,000', 'Land Size - 171sqm',
    ].join('\n');
    for (const lot of ['212', '213', '214']) {
      expect(findPropertyCoverPages([page], label(lot), [], false), `lot ${lot}`).toHaveLength(1);
    }
    expect(findPropertyCoverPages([page], label('215'), [], false)).toHaveLength(0);
  });

  it('refuses a sibling\'s flyer for the lot it states, not for leaving ours out', () => {
    // Its list names 213; what it states as its OWN lot is 220.
    expect(coverIdentityRefusal(flyer('220'), label('213'))).toBe('the page states another lot');
  });

  it('names the lot a sibling\'s flyer is about, not a fusion of its list', () => {
    // A sibling's flyer linked on this row by mistake: its own lot is 220.
    expect(statedOtherLotDesignation(flyer('220'), label('213'))).toBe('220');
  });

  it('names a list that leaves this lot out', () => {
    const page = ['KESTREL GROVE', 'LOT 300, 301, 302', 'From $699,000', 'Land Size - 150sqm']
      .join('\n');
    expect(statedOtherLotDesignation(page, label('213'))).toBe('300, 301, 302');
  });
});

describe('a price the text layer split at its thousands', () => {
  it('is a package price', () => {
    for (const printed of ['Price - $841, 000', 'Price - $841 ,000', 'Price - $841,\n000',
      'Price - $1, 050, 000']) {
      expect(packageFactsOn(printed), printed).toContain('a package price');
    }
  });

  it('makes a flyer with only its price and its sizes a cover', () => {
    const page = [
      '11 Finch Way, Mernda VIC 3754', 'Turn-Key Inclusions', 'Oriole', '4 2.5 1',
      'KESTREL GROVE', 'Lot 318', 'Price - $841, 000', 'Land Size - 255sqm', 'LOT 318',
    ].join('\n');
    expect(packageFactsOn(page)).toEqual(['a package price', 'a land or build size']);
    expect(findPropertyCoverPages([page], label('318'), [], false)).toHaveLength(1);
    expect(findPropertyCoverPages([page], label('318'), [], true)).toHaveLength(1);
  });
});

describe('what a list must never make a lot', () => {
  it('keeps a sibling\'s flyer off this property, whatever its list says', () => {
    // The sibling's flyer lists 213 among its design's lots; its own lot is 220.
    expect(findPropertyCoverPages([flyer('220')], label('213'), [], false)).toHaveLength(0);
  });

  it('still refuses a page that states two lots of its own', () => {
    const priceList = [
      'KESTREL GROVE', 'Lot 213 Tallis $725,000 Land Size - 171sqm',
      'Lot 214 Tallis $730,000 Land Size - 174sqm', 'Mernda VIC 3754',
    ].join('\n');
    expect(findPropertyCoverPages([priceList], label('213'), [], false)).toHaveLength(0);
    expect(coverIdentityRefusal(priceList, label('213'))).toBe('the page states another lot');
  });

  it('refuses a list that does not include this lot', () => {
    const page = ['KESTREL GROVE', 'Lot 301', 'LOT 300, 301, 302', 'Mernda VIC 3754',
      'Price - $699,000', 'Land Size - 150sqm'].join('\n');
    expect(coverIdentityRefusal(page, label('213'))).toBe('the page does not state this lot');
  });

  it('never reads a street number after a lot as a second lot', () => {
    const page = ['Lot 906, 14 Heath Street', 'Riverstone NSW 2765', 'Land Size 395m2',
      'Price $684,000'].join('\n');
    expect(findPropertyCoverPages([page], 'Lot 906, Riverstone', [], false)).toHaveLength(1);
    expect(findPropertyCoverPages([page], 'Lot 14, Riverstone', [], false)).toHaveLength(0);
  });

  it('never reads a bedroom count, a size or a price as a lot', () => {
    const page = (line: string) =>
      ['KESTREL GROVE', line, 'Mernda VIC 3754', 'Price - $725,000', 'Land Size - 171sqm']
        .join('\n');
    expect(findPropertyCoverPages([page('Lot 12, 3 Bed')], label('3'), [], false)).toHaveLength(0);
    expect(findPropertyCoverPages([page('Lot 12, 3 Bed')], label('12'), [], false)).toHaveLength(1);
    expect(findPropertyCoverPages([page('Lot 12, 300m2')], label('300'), [], false)).toHaveLength(0);
    expect(findPropertyCoverPages([page('Lot 32, $699,000')], label('699'), [], false))
      .toHaveLength(0);
    expect(findPropertyCoverPages([page('Lot 32, 699,000')], label('699'), [], false))
      .toHaveLength(0);
    expect(findPropertyCoverPages([page('Lot 32, 699,000')], label('32'), [], false))
      .toHaveLength(1);
  });

  it('reads a lot grouped in thousands as that one lot', () => {
    const page = ['Lot 1,037 Fuchsia Street', 'Mernda VIC 3754', 'Price - $725,000',
      'Land Size - 171sqm'].join('\n');
    expect(findPropertyCoverPages([page], 'Lot 1037, Mernda', [], false)).toHaveLength(1);
  });

  it('keeps reading a lot number the exporter split', () => {
    const page = ['2 1 Lot 10 3 Watsons Reach Estate', 'Package $612,000', 'Land 350m2']
      .join('\n');
    expect(findPropertyCoverPages([page], 'Lot 103, Diggers Rest', ['Watsons Reach'], false))
      .toHaveLength(1);
  });

  it('leaves an uploaded one-property flyer exactly as it was', () => {
    expect(findPropertyCoverPages([flyer('213')], label('213'), [], true)).toHaveLength(1);
    expect(findPropertyCoverPages([flyer('212')], label('212'), [], true)).toHaveLength(1);
  });
});
