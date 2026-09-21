/**
 * THE PLAN NAMES THE ROOMS, SO THE ROW CAN BE READ — WITHOUT A MODEL.
 *
 * A brochure prints its configuration as three bare numbers beside bed, bath
 * and car ICONS. The icons are images, so the text states which numbers the
 * property has and never which is which. Assuming the conventional order
 * wrote `bathrooms: 9` onto a real property on 21 September 2026.
 *
 * A spreadsheet import reads these figures without difficulty because every
 * value sits under an explicit HEADING — and a floor plan is the same shape:
 * `BED 1`, `BED 2`, `MASTER`, `BATH`, `ENS`, `GARAGE`. So the row supplies the
 * VALUES and the plan proves the POSITIONS. Six possible assignments, reduced
 * by evidence until one survives, and nothing claimed where more than one does.
 */
import { describe, expect, it } from 'vitest';
import {
  bedroomsFromPlan,
  bindCountRow,
  countRoomsNamed,
} from '../../../supabase/functions/_shared/builderStock/floorPlanCounts.pure.ts';

const units = (...text: string[]) => text.map((t) => ({ text: t }));

describe('counting the rooms a plan names', () => {
  /*
   * THE DEFECT THIS OPENS. `BEDROOM_LABEL` was anchored at both ends —
   * `/^(?:bed|bedroom)\s*\d{1,2}$/` — so it matched a bare `BED 2` and missed
   * `BED 2  3.0 x 3.1`, which is how nearly every floor plan is drawn.
   */
  it('reads a room named with its dimensions beside it', () => {
    const plan = countRoomsNamed(units(
      'MASTER 3.6 x 3.4', 'BED 2 3.0 x 3.1', 'BED 3 3.0 x 3.0',
      'ENS 2.4 x 1.7', 'BATH 2.4 x 2.0', 'GARAGE 5.9 x 5.6',
    ));
    expect(plan.bedrooms).toBe(3);
    expect(plan.bathrooms).toBe(2);
  });

  it('counts a room named twice as one room', () => {
    // A brochure prints its plan and then a dimensions table of the same rooms.
    const plan = countRoomsNamed(units(
      'BED 2 3.0 x 3.1', 'BED 2', 'MASTER', 'MASTER BED 3.6 x 3.4',
    ));
    expect(plan.bedrooms).toBe(2);
  });

  it('does not count an inclusions heading as a room', () => {
    // A brochure's inclusions page prints `BATHROOM` over a list of taps.
    const plan = countRoomsNamed(units(
      'BATHROOM SELECTIONS', 'BATHROOM INCLUSIONS', 'BED 1', 'BED 2'));
    expect(plan.bathrooms).toBeNull();
    expect(plan.bedrooms).toBe(2);
  });

  it('does not count a word that merely starts like a room', () => {
    expect(countRoomsNamed(units('BEDDING PACKAGE', 'CARPET')).bedrooms).toBeNull();
  });

  it('names no car spaces from a garage, because a garage names no number', () => {
    expect(countRoomsNamed(units('GARAGE 5.9 x 5.6')).carSpaces).toBeNull();
  });

  it('counts car spaces where the plan numbers them', () => {
    expect(countRoomsNamed(units('CAR 1', 'CAR 2')).carSpaces).toBe(2);
  });

  it('reports a powder room separately from a bathroom', () => {
    const plan = countRoomsNamed(units('BATH', 'ENS', 'POWDER'));
    expect(plan.bathrooms).toBe(2);
    expect(plan.powderRooms).toBe(1);
  });

  it('answers null where a document has no plan at all', () => {
    const plan = countRoomsNamed(units('HARLOW ESTATE', 'NEX 20', '$730,000'));
    expect(plan).toMatchObject({ bedrooms: null, bathrooms: null, carSpaces: null });
  });
});

describe('binding the row the document printed', () => {
  /*
   * THE PRODUCTION CASE. `3 2.5 1` beside three icons. The fraction can only
   * be a bathroom count — nothing else here is ever written with a half — and
   * that single fact binds the middle position outright. The plan's three
   * bedrooms then bind the first, and the last follows by elimination.
   */
  it('reads 3 2.5 1 with no convention assumed', () => {
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3', 'ENS', 'BATH', 'POWDER'));
    const bound = bindCountRow([3, 2.5, 1], plan);
    expect(bound).toMatchObject({ bedrooms: 3, bathrooms: 2.5, car_spaces: 1 });
    expect(bound!.evidence).toContain('fraction_is_bathrooms');
  });

  it('reads a whole-number row from the plan alone', () => {
    // `4 2 2` has no fraction, so the plan has to carry it: four bedrooms bind
    // the first position and two bathrooms the second.
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3', 'BED 4', 'ENS', 'BATH'));
    expect(bindCountRow([4, 2, 2], plan))
      .toMatchObject({ bedrooms: 4, bathrooms: 2, car_spaces: 2 });
  });

  it('reads a row printed in an unconventional order', () => {
    // THE WHOLE POINT. A document that prints car, bed, bath is read as what
    // it says — a rule that could only ever agree with bed-bath-car would get
    // this wrong and never know.
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3', 'ENS', 'BATH', 'POWDER'));
    expect(bindCountRow([1, 3, 2.5], plan))
      .toMatchObject({ car_spaces: 1, bedrooms: 3, bathrooms: 2.5 });
  });

  it('claims nothing where the plan cannot settle it', () => {
    // No fraction and no plan: six assignments survive and none is the answer.
    expect(bindCountRow([4, 2, 2], countRoomsNamed(units('NEX 20')))).toBeNull();
  });

  it('claims nothing — not even the first position — on an unreadable row', () => {
    // Taking `row[0]` as bedrooms because it usually is would be the same
    // inference under a smaller name.
    const plan = countRoomsNamed(units('MASTER', 'BED 2'));
    expect(bindCountRow([4, 2, 2], plan)).toBeNull();
  });

  it('refuses where the plan contradicts the row', () => {
    // Three named bedrooms against a row holding no 3 is a document
    // disagreeing with itself, and this module never picks a side.
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3'));
    expect(bindCountRow([4, 2, 1], plan)).toBeNull();
  });

  /*
   * A PLAN'S BATHROOM COUNT IS REPORTED AND CONSTRAINS NOTHING, and the
   * brochure corpus is what established that on the first run. Bedrooms are
   * numbered, so counting the names counts the rooms; bathing rooms are not
   * — a plan writes BATH, ENS, POWDER, sometimes BATH 1 and BATH 2, and
   * sometimes nothing where the room is drawn uncaptioned. A three-bedroom
   * home printing `3 2 1` beside a plan read as ONE bathroom would be bound
   * as one bathroom and two car spaces: confident, wrong, and exactly the
   * assumption this module exists to refuse.
   */
  it('never lets a plan\'s bathroom count decide a position', () => {
    const plan = countRoomsNamed(units('BED 1', 'BED 2', 'BED 3', 'BATH'));
    expect(plan.bathrooms).toBe(1);
    // Three bedrooms bind the first position; 2 and 1 remain indistinguishable
    // with no fraction to separate them, so nothing is claimed — rather than
    // one bathroom and two car spaces being asserted from a partial plan.
    expect(bindCountRow([3, 2, 1], plan)).toBeNull();
  });

  it('still reads the same row once the document prints a fraction', () => {
    const plan = countRoomsNamed(units('BED 1', 'BED 2', 'BED 3', 'BATH'));
    expect(bindCountRow([3, 2.5, 1], plan))
      .toMatchObject({ bedrooms: 3, bathrooms: 2.5, car_spaces: 1 });
  });

  it('never lets a fraction be anything but a bathroom', () => {
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3'));
    // The plan says three bedrooms, and 2.5 sits first. No assignment can put
    // bedrooms on a fraction, so this is unreadable rather than forced.
    expect(bindCountRow([2.5, 3, 1], plan)).toMatchObject({ bathrooms: 2.5, bedrooms: 3 });
    expect(bindCountRow([2.5, 2.5, 1], plan)).toBeNull();
  });

  it('refuses a row that is not three counts', () => {
    const plan = countRoomsNamed(units('MASTER', 'BED 2', 'BED 3'));
    expect(bindCountRow([3, 2], plan)).toBeNull();
    expect(bindCountRow([3, 2, 1, 1], plan)).toBeNull();
    expect(bindCountRow([3, Number.NaN, 1], plan)).toBeNull();
  });
});

describe('a plan with no row still names its bedrooms', () => {
  /*
   * Distinct numbered bedrooms plus a master is a direct count of labelled
   * rooms — the same kind of reading as a spreadsheet column.
   */
  it('counts them', () => {
    expect(bedroomsFromPlan(countRoomsNamed(units('MASTER', 'BED 2', 'BED 3')))).toBe(3);
  });

  it('offers nothing where the plan named none', () => {
    expect(bedroomsFromPlan(countRoomsNamed(units('NEX 20')))).toBeNull();
  });
});

describe('the reader uses it, and records what settled the row', () => {
  const source = String(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').readFileSync(
      require('node:path').join(process.cwd(),
        'supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts'), 'utf8'),
  );

  it('reads the plan across the whole document, not one page', () => {
    // A brochure draws its icon row on the cover and its plan three pages
    // later, so the evidence is not on the page the row is on.
    expect(source).toContain('countRoomsNamed(pages.flat())');
  });

  it('no longer proves one position and assumes the rest', () => {
    // The old rule was `bedroomsNamedOn === row[0]`, which could only ever
    // agree with one printing order.
    expect(source).not.toMatch(/if \(bedrooms !== row\[0\]\) return null;/);
    expect(source).toContain('bindCountRow(row, rooms)');
  });

  it('records the evidence rather than a bare flag', () => {
    expect(source).toContain('diagnostics.countEvidence = counts.evidence');
  });

  it('attributes the value to the row and the reading to the evidence', () => {
    // `icon_row` names where the VALUE came from; the plan is the key that
    // reads it, and how it was keyed is `countEvidence`.
    expect(source).toContain("readBy.set(claim.field, 'icon_row')");
    expect(source).toContain('diagnostics.countEvidence');
  });
});

// ===========================================================================
// End to end — the shape a real brochure is actually drawn in
// ===========================================================================

import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure.ts';
import { readPdfBrochure } from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts';

const IDENTITY = [
  'Lot 805 DAYLILLY ROAD',
  'Estate: Harlow Estate',
  'Home Design: NEX 20',
];

describe('a brochure whose plan prints its dimensions, read end to end', () => {
  /*
   * THE PRODUCTION SHAPE. `LOT 805 - NEX 20` imported on 21 September 2026
   * with `bedrooms`, `bathrooms` and `car_spaces` all null and reported as
   * `visual_only` — the counts printed beside icons and nothing able to read
   * them. Its floor plan names its rooms; the reader could not see them,
   * because `BEDROOM_LABEL` was anchored at both ends and every real plan
   * prints the room WITH its dimensions.
   */
  const brochure = (counts: string) => readPdfBrochure([[
    'NEX 20',
    counts,
    ...IDENTITY,
    'Land Size: 350 m2',
    'House Size: 182.78 m2',
    'MASTER 3.6 x 3.4',
    'BED 2 3.0 x 3.1',
    'BED 3 3.0 x 3.0',
    'ENS 2.4 x 1.7',
    'BATH 2.4 x 2.0',
    'GARAGE 5.9 x 5.6',
  ].join('\n')]);

  it('reads all three counts where the row carries a fraction', () => {
    const reading = brochure('3 2.5 1');
    expect(reading.diagnostics.fieldsRead)
      .toEqual(expect.arrayContaining(['bedrooms', 'bathrooms', 'car_spaces']));
    expect(reading.status).toBe('complete');
    const row = normaliseStockRow(reading.rows[0])!;
    expect(row.bedrooms).toBe(3);
    expect(row.bathrooms).toBe(2.5);
    expect(row.car_spaces).toBe(1);
  });

  it('names the evidence that settled the positions', () => {
    const reading = brochure('3 2.5 1');
    expect(reading.diagnostics.countEvidence).toContain('fraction_is_bathrooms');
    expect(reading.diagnostics.countEvidence).toContain('plan_named_bedrooms');
    // And nothing is left reported as unreadable.
    expect(reading.diagnostics.visualOnlyFields ?? []).toEqual([]);
  });

  it('reads a whole-number row through the rule this preserves', () => {
    // No fraction to separate the last two, so the original test carries it:
    // the plan's three bedrooms agreeing with the row's first number.
    const reading = brochure('3 2 1');
    const row = normaliseStockRow(reading.rows[0])!;
    expect(row.bedrooms).toBe(3);
    expect(row.bathrooms).toBe(2);
    expect(row.car_spaces).toBe(1);
    expect(reading.diagnostics.countEvidence)
      .toContain('plan_named_bedrooms_at_first_position');
  });

  it('reads a row printed in another order, which the old rule could not', () => {
    // `1 3 2.5` — car, bed, bath. The preserved rule would compare 3 against
    // the leading 1, fail, and claim nothing; the binding reads it.
    const reading = brochure('1 3 2.5');
    const row = normaliseStockRow(reading.rows[0])!;
    expect(row.bedrooms).toBe(3);
    expect(row.bathrooms).toBe(2.5);
    expect(row.car_spaces).toBe(1);
  });

  it('still refuses a row its plan contradicts', () => {
    // Three named bedrooms against a row holding no 3 anywhere.
    const reading = brochure('5 4 2');
    expect(reading.diagnostics.visualOnlyFields)
      .toEqual(['bathrooms', 'bedrooms', 'car_spaces']);
  });
});
