/**
 * ===========================================================================
 * A VISUAL COLUMN IS NOT A PROPERTY.
 * ===========================================================================
 *
 * `propertyRegions.pure.ts` decides whether one page carries several
 * independent properties. It is geometry proposing and evidence disposing,
 * and the evidence half is the one that matters: the corpus is full of
 * brochures set in two visual columns that describe ONE house, and splitting
 * those is strictly worse than the defect the module closes.
 *
 * So this file is deliberately weighted towards the refusals. Every positive
 * case has a negative twin that differs only in the evidence.
 */
import { describe, expect, it } from 'vitest';

import {
  pdfAnchorRegion, pdfRegionAnchor, regionForImage, segmentPropertyRegions,
} from '../../../supabase/functions/_shared/builderStock/propertyRegions.pure';

type Item = { text: string; x: number; y: number; width: number; height: number };

/** A run of text, drawn where a page would draw it. */
const at = (text: string, x: number, y: number, width = text.length * 5): Item =>
  ({ text, x, y, width, height: 10 });

/** One property card, written at an origin. `y` descends down the page. */
const card = (x: number, top: number, lot: string, design: string,
  land: string, price: string): Item[] => [
  at('Lot', x, top, 18), at(lot, x + 22, top, 20),
  at(design, x, top - 20, 60),
  at('Land', x, top - 40, 24), at(land, x + 28, top - 40, 45),
  at('Price', x, top - 60, 28), at(price, x + 32, top - 60, 50),
];

describe('a page that carries several properties', () => {
  it('splits two cards drawn side by side', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
    ];
    const out = segmentPropertyRegions(page);
    expect(out?.regions).toHaveLength(2);
    // Left first, and neither holds the other's evidence.
    const left = out!.regions[0].items.map((i) => i.text);
    const right = out!.regions[1].items.map((i) => i.text);
    expect(left).toContain('10');
    expect(left).not.toContain('11');
    expect(right).toContain('11');
    expect(right).not.toContain('10');
    expect(left).toContain('$700,000');
    expect(left).not.toContain('$760,000');
  });

  it('splits three cards, because nothing here counts to two', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      ...card(260, 700, '11', 'Miami 20', '420 m²', '$760,000'),
      ...card(480, 700, '12', 'Aspen 22', '500 m²', '$820,000'),
    ];
    expect(segmentPropertyRegions(page)?.regions).toHaveLength(3);
  });

  it('splits a grid, by asking the same question on the other axis', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
      ...card(40, 400, '12', 'Aspen 22', '500 m²', '$820,000'),
      ...card(320, 400, '13', 'Coral 16', '300 m²', '$640,000'),
    ];
    expect(segmentPropertyRegions(page)?.regions).toHaveLength(4);
  });
});

describe('what a region must never inherit, and what it must', () => {
  const twoCards = () => [
    at('PALOMINO ESTATE — SPRING RELEASE', 40, 780, 520),
    ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
    ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
    at('Prices subject to change. Images are artist impressions.', 40, 100, 520),
  ];

  it("treats a heading that crosses the gutter as the page's, not a region's", () => {
    const out = segmentPropertyRegions(twoCards());
    const shared = out!.shared.map((i) => i.text);
    expect(shared).toContain('PALOMINO ESTATE — SPRING RELEASE');
    expect(shared).toContain('Prices subject to change. Images are artist impressions.');
    for (const region of out!.regions) {
      expect(region.items.map((i) => i.text))
        .not.toContain('PALOMINO ESTATE — SPRING RELEASE');
    }
  });

  it('never lets a property-local value cross a gutter', () => {
    const out = segmentPropertyRegions(twoCards());
    const local = ['10', '11', '$700,000', '$760,000', '350 m²', '420 m²'];
    for (const region of out!.regions) {
      const held = region.items.map((i) => i.text).filter((t) => local.includes(t));
      // Everything a region holds from that list is its own: three values,
      // and never one of the other side's three.
      expect(held).toHaveLength(3);
    }
  });
});

describe('the refusals, which are most of the work', () => {
  it('leaves one property set in two visual columns alone', () => {
    // The commonest brochure in the corpus: specification left, render right.
    // The right column states nothing that identifies a property.
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      at('Artist impression', 320, 700, 90),
      at('Facade shown is Urban', 320, 680, 110),
      at('Landscaping not included', 320, 660, 120),
    ];
    expect(segmentPropertyRegions(page)).toBeNull();
  });

  it('leaves text beside an image alone', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      at('.', 340, 700, 200),
    ];
    expect(segmentPropertyRegions(page)).toBeNull();
  });

  it('refuses two bands that name the SAME property', () => {
    // One property drawn twice, or a heading repeated — never two houses.
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      ...card(320, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
    ];
    expect(segmentPropertyRegions(page)).toBeNull();
  });

  it('refuses a schedule column, which states one kind many times', () => {
    // Geometry proposes these columns exactly as it proposes a card. What
    // tells them apart is that a property states its price once.
    const page: Item[] = [];
    for (let row = 0; row < 8; row += 1) {
      page.push(at('Lot', 40, 700 - row * 20, 18));
      page.push(at(String(300 + row), 62, 700 - row * 20, 20));
      page.push(at(`$${700 + row},000`, 320, 700 - row * 20, 50));
    }
    expect(segmentPropertyRegions(page)).toBeNull();
  });

  it('refuses a band that describes a house without identifying one', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      at('Bedrooms', 320, 700, 50), at('4', 380, 700, 8),
      at('Bathrooms', 320, 680, 55), at('2', 380, 680, 8),
    ];
    expect(segmentPropertyRegions(page)).toBeNull();
  });

  it('refuses a page with too little on it to judge', () => {
    expect(segmentPropertyRegions([at('Lot 10', 40, 700)])).toBeNull();
    expect(segmentPropertyRegions([])).toBeNull();
  });

  it('refuses runs with no drawn height, because the scale is unknown', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
    ].map(({ height: _height, ...rest }) => rest as Item);
    expect(segmentPropertyRegions(page)).toBeNull();
  });
});

describe('which region owns a picture', () => {
  const page = [
    ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
    ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
  ];
  const regions = segmentPropertyRegions(page)!.regions;

  it('gives each side its own render', () => {
    expect(regionForImage(regions, { x: 40, width: 200 })?.index).toBe(0);
    expect(regionForImage(regions, { x: 320, width: 200 })?.index).toBe(1);
  });

  it('gives a page-wide banner to nobody', () => {
    expect(regionForImage(regions, { x: 20, width: 560 })).toBeNull();
  });

  it('gives a picture in the margin to nobody', () => {
    expect(regionForImage(regions, { x: 560, width: 30 })).toBeNull();
  });

  /*
   * THIS CASE WAS WRITTEN WRONG FIRST, and the correction is the point of
   * keeping it. It asked for `x: 200, width: 220` — which, measured against
   * the boxes these cards actually produce (left 40–122, right 320–402),
   * starts in the GUTTER and ends having covered the right card completely.
   * The module called it the right card's, and it was right: a render wider
   * than the text beneath it is still that property's render. What "straddle"
   * has to mean is substantial overlap of MORE THAN ONE region, which is what
   * is asked here.
   */
  it('gives a picture covering two regions to nobody', () => {
    expect(regionForImage(regions, { x: 40, width: 380 })).toBeNull();
  });

  it('gives a picture that merely spills into the gutter to its own region', () => {
    expect(regionForImage(regions, { x: 200, width: 220 })?.index).toBe(1);
  });

  it('answers nothing where there are no regions', () => {
    expect(regionForImage([], { x: 40, width: 100 })).toBeNull();
  });
});

describe('the anchor vocabulary', () => {
  it('round-trips', () => {
    expect(pdfRegionAnchor(3, 1)).toBe('pdf:page3#r1');
    expect(pdfAnchorRegion('pdf:page3#r1')).toEqual({ page: 3, region: 1 });
  });

  it('does not claim a plain page anchor', () => {
    // `pdf:page3` stays `pdfRowAnchors`' — a single-property page is
    // unchanged by any of this, down to the string it carries.
    expect(pdfAnchorRegion('pdf:page3')).toBeNull();
    expect(pdfAnchorRegion(null)).toBeNull();
  });
});

/**
 * ===========================================================================
 * WHAT A REAL PAGE DID THAT NO HAND-WRITTEN FIXTURE HAD.
 * ===========================================================================
 *
 * These two were found by putting generated PDFs through the real layout
 * reader and reading the coordinates back, which is the only way either could
 * have been found: both are about the RELATIVE size of runs on a page, and a
 * fixture written by hand is written with the rule already in mind.
 */
describe('a line of small print may not close a gutter', () => {
  /*
   * MEASURED, on `FERNLEIGH - THREE RELEASES.pdf` at the real coordinates the
   * layout reader returns. Three cards at x = 42.5, 232.4 and 422.4, content
   * 425.8 wide — and one footer, 208.5 wide, beginning in the first column
   * and ending inside the second.
   *
   * 208.5 is 49% of the content, UNDER the 55% share that keeps a heading out
   * of the gutter search, so the search kept it, its span merged with the
   * first column's and reached past the second column's origin. The first
   * gutter vanished, the page came back as one property, and that property
   * wore three lots. One line of small print decided it.
   *
   * What separates that footer from a cell is not the page's width: it is
   * that it is five times any other run on the sheet.
   */
  const threeCards = (footerWidth: number) => [
    at('FERNLEIGH PARK - AUTUMN RELEASE', 42.5, 779.5, 344),
    ...card(42.5, 722.8, '21', 'Alder 16', '294 m²', '$598,000'),
    ...card(232.4, 722.8, '22', 'Briar 19', '336 m²', '$655,000'),
    ...card(422.4, 722.8, '23', 'Cobalt 24', '420 m²', '$749,000'),
    at('All prices subject to change.', 42.5, 473.4, footerWidth),
  ];

  it('divides the page although the footer crosses the first gutter', () => {
    const out = segmentPropertyRegions(threeCards(208.5));
    expect(out?.regions).toHaveLength(3);
    expect(out!.shared.map((i) => i.text)).toContain('All prices subject to change.');
  });

  it('divides it the same way when the footer is narrow enough to sit in one column',
    () => {
      // The control: the same page with a footer that crosses nothing. The
      // answer must not depend on the footer at all.
      const out = segmentPropertyRegions(threeCards(60));
      expect(out?.regions).toHaveLength(3);
    });
});

describe('a long line inside one card belongs to that card', () => {
  /*
   * THE OTHER HALF OF THE SAME RULE, and the reason the width test may only
   * PROPOSE. A card whose address runs the width of its own column is several
   * times the page's median run, so it is kept out of the gutter search — and
   * it must still land in its own region, because a street name inherited by
   * the property next to it is the leak this module exists to prevent.
   *
   * The assignment is geometric and the search is not: excluding a run from
   * the search decides nothing about where that run belongs.
   */
  it('never promotes it to the page', () => {
    const page = [
      ...card(40, 700, '10', 'Enzo 18', '350 m²', '$700,000'),
      at('Lot 10 Kirramingly Avenue, Donnybrook VIC 3064', 40, 620, 230),
      ...card(320, 700, '11', 'Miami 20', '420 m²', '$760,000'),
      at('Lot 11 Kirramingly Avenue, Donnybrook VIC 3064', 320, 620, 230),
    ];
    const out = segmentPropertyRegions(page);
    expect(out?.regions).toHaveLength(2);
    const left = out!.regions[0].items.map((i) => i.text);
    const right = out!.regions[1].items.map((i) => i.text);
    expect(left).toContain('Lot 10 Kirramingly Avenue, Donnybrook VIC 3064');
    expect(left).not.toContain('Lot 11 Kirramingly Avenue, Donnybrook VIC 3064');
    expect(right).toContain('Lot 11 Kirramingly Avenue, Donnybrook VIC 3064');
    expect(out!.shared).toHaveLength(0);
  });
});
