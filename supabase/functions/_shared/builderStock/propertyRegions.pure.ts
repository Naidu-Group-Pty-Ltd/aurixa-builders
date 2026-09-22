/**
 * ===========================================================================
 * ONE PAGE, SEVERAL PROPERTIES — AND WHICH EVIDENCE BELONGS TO WHICH.
 * ===========================================================================
 *
 * A builder's stock sheet often sets two or three properties side by side:
 *
 *     LOT 10                  LOT 11
 *     ENZO 18                 MIAMI 20
 *     350 m²                  420 m²
 *     $700,000                $760,000
 *     [render A]              [render B]
 *
 * The brochure reader reads a PAGE. Handed that page it produces ONE record
 * carrying evidence from both sides — a property that exists nowhere, with
 * Lot 10's land against Lot 11's price. This module is what stops that: it
 * decides, from the page's own geometry, whether the page carries several
 * independent property regions, and it hands each region its own evidence.
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 * ===========================================================================
 *
 * NOT A COLUMN COUNT. Nothing here assumes two of anything. The page is split
 * wherever its own whitespace says it is split, on either axis, as many times
 * as the geometry supports — so one, two, three and a grid are the same
 * mechanism rather than three special cases.
 *
 * NOT A VISUAL SPLIT. **A visual column is not a property.** Half the
 * brochures in the corpus set their text on the left and their render on the
 * right, and a great many set a specification block beside a floor plan.
 * Splitting those produces two half-properties where there was one whole one,
 * which is strictly worse than the defect this closes. So geometry only ever
 * PROPOSES; what decides is property-level evidence, and the bar is
 * deliberately high — see `qualifies` below.
 *
 * NOT A NEW VOCABULARY. Which words name a field is `fieldForHeader`'s, and
 * what a value may be is `acceptFieldValue`'s. This asks those two and knows
 * nothing else about documents. A module that had its own idea of what a lot
 * looks like would be the fourth, and they would drift.
 *
 * ===========================================================================
 * SHARED EVIDENCE AND PROPERTY-LOCAL EVIDENCE
 * ===========================================================================
 *
 * Some of a page is about every property on it — the builder's name, the
 * estate, the stage, the disclaimer across the foot. Some of it is about one
 * property — its lot, its design, its sizes, its price, its picture.
 *
 * The distinction is geometric and it is decided the only way that cannot be
 * argued with: **a run that crosses a gutter cannot belong to one side of
 * it.** A full-width estate heading spans every column, so it is shared and
 * every region inherits it. A lot number sits inside one column, so it is
 * that region's and it NEVER reaches another.
 *
 * That asymmetry is the safety property. Inheriting a shared heading can at
 * worst give two properties the same (correct) estate. Leaking a local value
 * puts Lot 10's price on Lot 11, which is a wrong record about a real house.
 *
 * Pure: no IO, no clock, no document knowledge beyond the two modules above.
 */
import { fieldForHeader } from './normalise.pure.ts';
import { acceptFieldValue } from './fieldTypes.pure.ts';
import type { PdfTextItem } from './pdfDeterministicRows.pure.ts';

/** A rectangle on the page, in the reader's own units. */
export interface RegionBox { x0: number; y0: number; x1: number; y1: number }

export interface PageRegion {
  /** Reading order: left to right, then top to bottom. */
  index: number;
  box: RegionBox;
  /** This region's own runs. Never another region's. */
  items: PdfTextItem[];
}

export interface PageSegmentation {
  regions: PageRegion[];
  /** Runs that belong to the page rather than to any one region. */
  shared: PdfTextItem[];
  /** A stable machine word for the import log. Never document text. */
  reason: string;
}

/**
 * A gutter must be wider than this multiple of the page's own type size.
 *
 * DERIVED, NOT TUNED. A word space on a page set at height `h` is around
 * `0.25h` and the widest inter-word gap a justified line produces is under
 * `1.5h`; the narrowest column gutter any of the corpus's multi-property
 * layouts uses is `3.1h`. Two and a half sits between those with room on
 * both sides, and the page-width floor below is what stops a page set in
 * very small type proposing gutters everywhere.
 */
const GUTTER_TYPE_MULTIPLE = 2.5;
/** And it must be this share of the content's own width. */
const GUTTER_WIDTH_SHARE = 0.035;

/**
 * A run this wide cannot be one column's.
 *
 * Used only to keep headings and rules OUT of the gutter search, so a
 * full-width estate heading does not hide the gutter beneath it. It does not
 * decide anything on its own — what makes a run shared is crossing a gutter
 * that was found without it.
 */
const SPANNING_SHARE = 0.55;

/**
 * AND A RUN THIS MANY TIMES THE PAGE'S OWN TYPICAL RUN IS FURNITURE TOO.
 *
 * MEASURED, AND THE SHARE ALONE WAS NOT ENOUGH. A three-card release sheet
 * whose footer reads "All prices subject to change. Images are artist
 * impressions." sets that line 208.5 points wide on a page whose content is
 * 425.8 wide — 49%, under the share above, so the search kept it. It begins
 * in the first column and ends inside the second, so merging the spans
 * closed the first gutter completely and the page came back as one property
 * carrying three lots. Nothing was wrong with the page and nothing was wrong
 * with the cards; one line of small print decided it.
 *
 * So the second question is asked against the page's OWN runs rather than
 * against its width: a cell is about as wide as the other cells, and a
 * heading, a footer or a rule is several times that. Measured over the two
 * shapes this closes — the widest CELL on either is 1.6 times the page's
 * median run, and the narrowest piece of FURNITURE is 5.1 times it. Three
 * sits between them with room on both sides.
 *
 * IT CAN ONLY PROPOSE. Excluding a run from the search decides nothing about
 * where that run belongs: the assignment below is purely geometric, so a
 * long address line inside one card is still that card's — it overlaps one
 * band and lands in it. Getting this wrong costs a gutter that is proposed
 * or not proposed, and the evidence gate disposes of either.
 */
const FURNITURE_RUN_MULTIPLE = 3;

/** Below this many property-local fields, a band is not a property. */
const MIN_REGION_FIELDS = 2;

/**
 * Above this many of ONE identity kind, a band is a table column rather than
 * a property card.
 *
 * A property states its lot once, its price once and its design once. A
 * column of a schedule states eight prices and nothing else — and it is a
 * COLUMN, so the geometry proposes it exactly as it proposes a card. This is
 * what tells them apart without knowing anything about tables.
 */
const MAX_IDENTITIES_PER_KIND = 2;

/** The fields that are about ONE property and must never cross a gutter. */
const PROPERTY_LOCAL_FIELDS: ReadonlySet<string> = new Set([
  'lot_number', 'unit_number', 'house_design', 'price', 'expected_completion',
  'land_size_sqm', 'building_size_sqm', 'bedrooms', 'bathrooms', 'car_spaces',
  'external_reference', 'address_line',
]);

/**
 * The fields that identify WHICH property a region is about.
 *
 * A region needs one of these to be a property at all. Sizes and room counts
 * describe a house without saying which house, so a band holding only those
 * is a specification panel beside a property rather than a second property.
 */
const IDENTITY_FIELDS = ['lot_number', 'unit_number', 'price', 'house_design'] as const;
type IdentityField = typeof IDENTITY_FIELDS[number];

const text = (item: PdfTextItem): string => String(item?.text ?? '').trim();
const right = (item: PdfTextItem): number => item.x + (item.width || 0);

/** The median drawn height, which is the page's own sense of scale. */
function typeScale(items: readonly PdfTextItem[]): number {
  const heights = items
    .map((item) => Number(item.height ?? 0))
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  if (!heights.length) return 0;
  return heights[Math.floor(heights.length / 2)];
}

/**
 * The empty intervals along one axis, wide enough to be gutters.
 *
 * The spans are merged first, so what comes back is the whitespace the page
 * actually leaves rather than the gaps between consecutive runs — two runs
 * that overlap leave no gap between them however far apart their origins are.
 */
function gutters(
  spans: ReadonlyArray<readonly [number, number]>,
  minWidth: number,
): Array<[number, number]> {
  if (spans.length < 2 || !(minWidth > 0)) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const found: Array<[number, number]> = [];
  let [, end] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [start, stop] = sorted[i];
    if (start - end >= minWidth) found.push([end, start]);
    if (stop > end) end = stop;
  }
  return found;
}

/** What a band states about properties, in the product's own vocabulary. */
interface BandEvidence {
  fields: number;
  identities: Map<IdentityField, string[]>;
}

/**
 * READ THE BAND THE WAY THE READER WILL.
 *
 * A label beside or above a value is what every other reader here looks for,
 * so that is what this looks for: each run is offered to `fieldForHeader` as
 * a label, and the run after it on the same line — or the nearest run below —
 * is offered to `acceptFieldValue` as its value. A value that no label
 * explains is counted only where it is unmistakable on its own: money with a
 * currency marker, and an area with its unit.
 *
 * It does not have to be RIGHT about every field. It has to be right about
 * whether this band is a property, and both halves of that are conservative:
 * an under-read band simply does not qualify, and the page stays one.
 */
function readBand(items: readonly PdfTextItem[]): BandEvidence {
  const evidence: BandEvidence = { fields: 0, identities: new Map() };
  const note = (field: string, value: string) => {
    if (!PROPERTY_LOCAL_FIELDS.has(field)) return;
    evidence.fields += 1;
    if ((IDENTITY_FIELDS as readonly string[]).includes(field)) {
      const key = field as IdentityField;
      const held = evidence.identities.get(key) ?? [];
      held.push(value.toLowerCase());
      evidence.identities.set(key, held);
    }
  };

  const ordered = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  for (let i = 0; i < ordered.length; i += 1) {
    const label = fieldForHeader(text(ordered[i]));
    if (label && PROPERTY_LOCAL_FIELDS.has(label)) {
      // Beside, then below — the two pairings the brochure reader uses.
      for (const candidate of [ordered[i + 1], ordered[i + 2]]) {
        if (!candidate) continue;
        const verdict = acceptFieldValue(label, text(candidate));
        if (verdict.accepted) { note(label, verdict.value); break; }
      }
      continue;
    }
    /*
     * A VALUE THAT NEEDS NO LABEL. Money says it is money and an area says
     * it is an area; nothing else is counted unlabelled, because a bare
     * number is the thing this whole subsystem refuses to guess about.
     */
    const bare = text(ordered[i]);
    if (/[$£€]/.test(bare) && acceptFieldValue('price', bare).accepted) {
      note('price', bare);
    } else if (/(?:m²|m2|sqm)\s*$/i.test(bare)
      && acceptFieldValue('land_size_sqm', bare).accepted) {
      evidence.fields += 1;
    }
  }
  return evidence;
}

/** Is this band a property in its own right? */
function qualifies(evidence: BandEvidence): boolean {
  if (evidence.fields < MIN_REGION_FIELDS) return false;
  let identities = 0;
  for (const values of evidence.identities.values()) {
    // A column of eight prices is a schedule's column, not a property card.
    if (values.length > MAX_IDENTITIES_PER_KIND) return false;
    identities += values.length;
  }
  return identities > 0;
}

/**
 * Do these bands describe DIFFERENT properties?
 *
 * Two bands stating the same lot are one property the page drew twice, or a
 * heading repeated down a column. Distinctness is asked of the strongest
 * identity the bands share, and where they share none it is not asked at all
 * — two bands with a lot each and no overlap in any kind are two properties.
 */
function distinct(bands: readonly BandEvidence[]): boolean {
  for (const field of IDENTITY_FIELDS) {
    const stated = bands.map((band) => band.identities.get(field) ?? []);
    if (!stated.every((values) => values.length)) continue;
    const seen = new Set<string>();
    for (const values of stated) {
      const key = values.slice().sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }
  // No identity kind is stated by every band — they cannot be compared, and
  // an uncomparable pair is not proof of two properties.
  return false;
}

const boxOf = (items: readonly PdfTextItem[]): RegionBox => ({
  x0: Math.min(...items.map((i) => i.x)),
  x1: Math.max(...items.map(right)),
  y0: Math.min(...items.map((i) => i.y)),
  y1: Math.max(...items.map((i) => i.y + Number(i.height ?? 0))),
});

/** Split one band along an axis, or return it whole. */
function splitBand(
  items: readonly PdfTextItem[],
  axis: 'x' | 'y',
  scale: number,
  contentWidth: number,
): { bands: PdfTextItem[][]; crossing: PdfTextItem[] } {
  const lo = (item: PdfTextItem) => axis === 'x' ? item.x : item.y;
  const hi = (item: PdfTextItem) => axis === 'x'
    ? right(item)
    : item.y + Number(item.height ?? 0);

  const minGutter = Math.max(
    GUTTER_TYPE_MULTIPLE * scale, GUTTER_WIDTH_SHARE * contentWidth);

  /*
   * THE GUTTER IS SOUGHT BENEATH THE HEADINGS, NOT THROUGH THEM. A run
   * spanning most of the width sits across every column, so leaving it in
   * would fill the very gap this is looking for. It is put back below, and
   * whether it is SHARED is then decided by whether it crosses a gutter that
   * was found without it — never by how wide it is.
   *
   * TWO QUESTIONS, AND THE ANSWER IS THE SMALLER. One is about the page's
   * width and one is about the page's own runs; a footer can be under half
   * the width and still five times any cell on the sheet. See
   * `FURNITURE_RUN_MULTIPLE` for the measurement that put it there.
   */
  const extents = items.map((item) => hi(item) - lo(item))
    .filter((extent) => Number.isFinite(extent) && extent > 0)
    .sort((a, b) => a - b);
  const median = extents.length ? extents[Math.floor(extents.length / 2)] : 0;
  const furniture = Math.min(
    SPANNING_SHARE * contentWidth,
    median > 0 ? FURNITURE_RUN_MULTIPLE * median : Infinity);
  const narrow = items.filter((item) => (hi(item) - lo(item)) < furniture);
  const cuts = gutters(narrow.map((item) => [lo(item), hi(item)] as const), minGutter);
  if (!cuts.length) return { bands: [[...items]], crossing: [] };

  const edges = [-Infinity, ...cuts.map(([, start]) => start), Infinity];
  const bands: PdfTextItem[][] = edges.slice(0, -1).map(() => []);
  const crossing: PdfTextItem[] = [];
  for (const item of items) {
    const a = lo(item); const b = hi(item);
    let band = -1; let spans = false;
    for (let i = 0; i < edges.length - 1; i += 1) {
      const from = edges[i]; const to = edges[i + 1];
      const overlaps = a < to && b > from;
      if (!overlaps) continue;
      if (band >= 0) { spans = true; break; }
      band = i;
    }
    if (spans || band < 0) crossing.push(item);
    else bands[band].push(item);
  }
  return { bands: bands.filter((band) => band.length), crossing };
}

/**
 * How many independent property regions does this page carry?
 *
 * Returns null wherever the answer is "one", which is the overwhelming
 * majority of pages and every page this reader handled before. A caller that
 * gets null must behave exactly as it did.
 */
export function segmentPropertyRegions(
  items: readonly PdfTextItem[],
): PageSegmentation | null {
  const usable = (items ?? []).filter((item) => text(item)
    && Number.isFinite(item.x) && Number.isFinite(item.y));
  if (usable.length < 6) return null;

  const scale = typeScale(usable);
  if (!(scale > 0)) return null;
  const contentWidth = Math.max(...usable.map(right)) - Math.min(...usable.map((i) => i.x));
  if (!(contentWidth > 0)) return null;

  const byColumn = splitBand(usable, 'x', scale, contentWidth);
  let bands = byColumn.bands;
  let shared = byColumn.crossing;

  /*
   * AND THEN DOWN, where the columns themselves stack. A page of six cards
   * in two columns of three is the same question asked twice, so it is the
   * same code asked twice — and a band that does not split simply comes back
   * whole. The vertical pass runs only where the horizontal one already
   * found more than one band, because splitting a single-column page by its
   * own paragraph gaps would cut one property into its sections.
   */
  if (bands.length > 1) {
    const stacked: PdfTextItem[][] = [];
    for (const band of bands) {
      const height = Math.max(...band.map((i) => i.y + Number(i.height ?? 0)))
        - Math.min(...band.map((i) => i.y));
      const split = splitBand(band, 'y', scale, height);
      stacked.push(...split.bands);
      shared = shared.concat(split.crossing);
    }
    if (stacked.length >= bands.length) bands = stacked;
  }

  if (bands.length < 2) return null;

  const read = bands.map(readBand);
  const keep: number[] = [];
  bands.forEach((_, index) => { if (qualifies(read[index])) keep.push(index); });

  /*
   * ONE QUALIFYING BAND IS ONE PROPERTY, and this is the guard that protects
   * every brochure in the corpus: text on the left and a render on the right
   * splits into two bands, of which exactly one states a lot. The page is
   * left alone, whole, and the reader sees precisely what it saw before.
   */
  if (keep.length < 2) return null;
  if (!distinct(keep.map((index) => read[index]))) return null;

  /*
   * A BAND THAT DID NOT QUALIFY IS NOT DISCARDED — it is SHARED. It is part
   * of the page and the page is about all of these properties; dropping it
   * would lose the estate block that happens to sit in its own column, and
   * assigning it to a neighbour would be the leak this module exists to
   * prevent. Shared is the only safe home for evidence that belongs to no
   * one region.
   */
  bands.forEach((band, index) => { if (!keep.includes(index)) shared = shared.concat(band); });

  const regions = keep
    .map((index) => bands[index])
    .map((band) => ({ band, box: boxOf(band) }))
    .sort((a, b) => (b.box.y1 - a.box.y1) || (a.box.x0 - b.box.x0))
    .map((entry, index) => ({ index, box: entry.box, items: entry.band }));

  return { regions, shared, reason: `regions:${regions.length}` };
}

/**
 * Which region owns a picture drawn at this rectangle?
 *
 * WRONG IMAGE IS WORSE THAN NO IMAGE, so this answers null far more often
 * than it answers a region. A picture belongs to a region when the region's
 * own column contains it — judged on the HORIZONTAL axis, because that is
 * what separates the cards, and because a render commonly sits above or
 * below the text it belongs to and would fail a containment test.
 *
 * Two rules refuse. A picture overlapping more than one region's column is a
 * page-wide banner or a straddling graphic and belongs to nobody. A picture
 * that overlaps none is a logo in the margin, and belongs to nobody. Neither
 * is attached to whichever region happens to be nearest.
 */
export function regionForImage<T extends { box: RegionBox }>(
  regions: readonly T[],
  drawn: { x: number; width: number },
): T | null {
  if (!regions.length || !Number.isFinite(drawn?.x) || !(drawn.width > 0)) return null;
  const x0 = drawn.x; const x1 = drawn.x + drawn.width;
  const overlapping = regions.filter((region) => {
    const overlap = Math.min(x1, region.box.x1) - Math.max(x0, region.box.x0);
    // A shared edge is not an overlap; a real one covers a third of the
    // picture or a third of the region, whichever is the smaller claim.
    const smaller = Math.min(x1 - x0, region.box.x1 - region.box.x0);
    return overlap > 0 && smaller > 0 && overlap / smaller >= 0.34;
  });
  return overlapping.length === 1 ? overlapping[0] : null;
}

/** The anchor a region's property carries. One vocabulary, minted here. */
export const pdfRegionAnchor = (page: number, region: number): string =>
  `pdf:page${page}#r${region}`;

/** The page and region an anchor names, or null when it is not one of ours. */
export function pdfAnchorRegion(
  anchor: string | null | undefined,
): { page: number; region: number } | null {
  const match = /^pdf:page(\d+)#r(\d+)$/.exec(String(anchor ?? ''));
  return match ? { page: Number(match[1]), region: Number(match[2]) } : null;
}
