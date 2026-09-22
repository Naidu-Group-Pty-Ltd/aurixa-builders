/**
 * ===========================================================================
 * THE NORMALISATION LAYER, AND THE LINE IT MUST NOT CROSS.
 * ===========================================================================
 *
 * `documentNormalisation.pure.ts` sits at the one seam where raw PDF evidence
 * — page text, or positioned runs with their own set widths — becomes the
 * units every property reader consumes. It resolves three facts about TYPE:
 * the dot a designer uses to separate two fields, the letter-spacing applied
 * to a heading, and the wider gap between that heading's words.
 *
 * The danger is not that it fails to recognise letter-spacing. It is that it
 * recognises too much: "join every sequence of single characters" turns the
 * icon row `3 2 1` into the number three hundred and twenty-one, and turns a
 * page heading into a value. Both halves are asserted here, and the negatives
 * are the half that matters.
 */
import { describe, expect, it } from 'vitest';

import {
  collapseTrackedRun,
  normaliseUnits,
  splitOnFieldSeparators,
  trackedOutHeadings,
} from '../../../supabase/functions/_shared/builderStock/documentNormalisation.pure';
import {
  readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const flat = (lines: string[]) =>
  normaliseUnits(lines.map((text, row) => ({ text, x: 0, row })));

const texts = (lines: string[]) => flat(lines).map((u) => u.text);

// ---------------------------------------------------------------------------
// 1 · Letter-spaced type
// ---------------------------------------------------------------------------

describe('a word a designer tracked out', () => {
  it('is read as the word the page set', () => {
    expect(collapseTrackedRun('L O T')?.text).toBe('LOT');
    expect(collapseTrackedRun('E S T A T E')?.text).toBe('ESTATE');
    expect(collapseTrackedRun('B E D')?.text).toBe('BED');
  });

  it('keeps the word gap the page drew', () => {
    // Two spaces between the words, one between the letters. That gap is the
    // ONLY evidence of where the words are, which is why nothing upstream of
    // this may collapse whitespace.
    expect(collapseTrackedRun('T O T A L  H O M E')?.text).toBe('TOTAL HOME');
    expect(collapseTrackedRun('L O T  3 7')?.text).toBe('LOT 37');
  });

  it('carries the page’s own string beside the reading', () => {
    const [unit] = flat(['T O T A L  H O M E']);
    expect(unit.text).toBe('TOTAL HOME');
    expect(unit.raw).toBe('T O T A L  H O M E');
    expect(unit.normalisation).toMatchObject({
      rule: 'letter_spaced_word', sources: ['T O T A L  H O M E'],
    });
  });

  it('leaves ordinary prose exactly as the page drew it', () => {
    const line = 'Lot 37, Sandpiper Estate, Tweed Heads NSW';
    const [unit] = flat([line]);
    expect(unit.text).toBe(line);
    expect(unit.raw).toBe(line);
    expect(unit.normalisation).toBeUndefined();
  });
});

describe('what is NOT letter-spaced type', () => {
  /*
   * THE ONE THAT WAS CAUGHT BY THE SUITE ON ITS FIRST RUN. Every brochure in
   * the corpus draws `3 2 1` under its design name — bed, bath and car, three
   * values in three columns — and the first version of this layer read it as
   * `321`, because it was three single characters. Four fixtures lost their
   * counts. Letter-spacing is applied to WORDS; a run of bare digits is a row
   * of columns and is left alone.
   */
  it('does not join the icon row', () => {
    expect(collapseTrackedRun('3 2 1')).toBeNull();
    expect(collapseTrackedRun('4 2 2')).toBeNull();
    expect(texts(['Aspire 24', '3 2 1'])).toEqual(['Aspire 24', '3 2 1']);
  });

  it('does not join a run below the floor', () => {
    // `U 3` is a unit designation and `A B` is two tokens. Three single
    // characters is where the shape stops being something a page produces by
    // accident.
    expect(collapseTrackedRun('U 3')).toBeNull();
    expect(collapseTrackedRun('A B')).toBeNull();
  });

  it('does not join a sentence that contains a tracked run', () => {
    expect(collapseTrackedRun('Set out  A B C  below')).toBeNull();
    expect(collapseTrackedRun('Lot 37')).toBeNull();
  });

  it('does not join across a mixed run', () => {
    // `4 / 2` carries a token that is neither a letter nor a digit.
    expect(collapseTrackedRun('4 / 2')).toBeNull();
  });
});

describe('a tracked-out number is read only where a heading vouches for it', () => {
  /*
   * `L O T` and `3 7` are one display line the page drew as two runs. The word
   * proves the line is set that way; the digits beside it are the value it
   * introduces. Without the word there is no proof, which is exactly what
   * keeps the icon row out.
   */
  const withGeometry = (cells: Array<[string, number, number]>) =>
    normaliseUnits(cells.map(([text, x, width]) => ({ text, x, row: 0, width })));

  it('reads the value beside the heading', () => {
    const units = withGeometry([['L O T', 0, 30], ['3 7', 34, 14]]);
    expect(units.map((u) => u.text)).toEqual(['LOT', '37']);
    expect(units[1].normalisation?.rule).toBe('letter_spaced_number');
  });

  it('keeps them as two units, never one', () => {
    // Joining them would say the document wrote `LOT 37` where it wrote a
    // heading and a value. The pairing readers downstream exist to tell those
    // two apart, and cannot if this layer has already merged them.
    expect(withGeometry([['L O T', 0, 30], ['3 7', 34, 14]])).toHaveLength(2);
  });

  it('leaves a number with no heading beside it alone', () => {
    const units = withGeometry([['Aspire 24', 0, 60], ['3 2 1', 80, 20]]);
    expect(units.map((u) => u.text)).toEqual(['Aspire 24', '3 2 1']);
  });

  it('leaves a number a column away from the heading alone', () => {
    // The gap is measured against the heading's own set width. A phrase's
    // inter-word gap is of the order of its letter gaps; a column is not.
    const units = withGeometry([['L O T', 0, 30], ['3 7', 400, 14]]);
    expect(units.map((u) => u.text)).toEqual(['LOT', '3 7']);
  });
});

describe('two tracked-out words drawn as one phrase', () => {
  const withGeometry = (cells: Array<[string, number, number]>) =>
    normaliseUnits(cells.map(([text, x, width]) => ({ text, x, row: 0, width })));

  it('joins them where the page drew them together', () => {
    const units = withGeometry([['T O T A L', 0, 50], ['H O M E', 60, 40]]);
    expect(units.map((u) => u.text)).toEqual(['TOTAL HOME']);
    expect(units[0].normalisation).toMatchObject({
      rule: 'letter_spaced_phrase', sources: ['T O T A L', 'H O M E'],
    });
  });

  it('does not join across a column', () => {
    const units = withGeometry([['T O T A L', 0, 50], ['P A C K A G E', 400, 70]]);
    expect(units.map((u) => u.text)).toEqual(['TOTAL', 'PACKAGE']);
  });

  it('does not join across a row', () => {
    const units = normaliseUnits([
      { text: 'T O T A L', x: 0, row: 0, width: 50 },
      { text: 'H O M E', x: 0, row: 1, width: 40 },
    ]);
    expect(units.map((u) => u.text)).toEqual(['TOTAL', 'HOME']);
  });
});

// ---------------------------------------------------------------------------
// 1b · The same heading, arriving as glyphs rather than as a string
// ---------------------------------------------------------------------------

/**
 * THE TWO TRANSPORTS DISAGREE ABOUT WHAT A TRACKED HEADING IS.
 *
 * MEASURED 22 SEPTEMBER 2026 by building a brochure with real PDF character
 * spacing and reading the bytes back through this product's own extractor.
 * Flattened page text gives one string, `M A S T E R P L A N`, because the
 * extractor inserts a space wherever the glyphs did not abut — that is the
 * shape the production Lot 37 row recorded. Positioned runs give TEN CELLS,
 * `M` at x=57, `A` at 80, `S` at 101, because the cell assembler joins runs
 * that abut and tracked glyphs do not.
 *
 * The coordinates below are that page's own, to the tenth of a point.
 */
describe('a tracked heading that arrives as one cell per glyph', () => {
  const glyphs = (spec: Array<[string, number, number]>, row = 0) =>
    normaliseUnits(spec.map(([text, x, width]) => ({ text, x, row, width })));

  // `M A S T E R P L A N` as the page drew it: advance ~8.7, gap 12.0 every
  // time.
  const MASTERPLAN: Array<[string, number, number]> = [
    ['M', 56.7, 10.8], ['A', 79.5, 9.4], ['S', 100.9, 8.7], ['T', 121.6, 7.9],
    ['E', 141.6, 8.7], ['R', 162.3, 9.4], ['P', 183.7, 8.7], ['L', 204.3, 7.9],
    ['A', 224.3, 9.4], ['N', 245.7, 9.4],
  ];

  it('is read as the word the page set', () => {
    const units = glyphs(MASTERPLAN);
    expect(units.map((u) => u.text)).toEqual(['MASTERPLAN']);
    expect(units[0].normalisation?.rule).toBe('letter_spaced_word');
  });

  it('keeps the word gap the page measured', () => {
    // `T O T A L   P A C K A G E`: letter gap 11, word gap 26, one baseline.
    const units = glyphs([
      ['T', 56.7, 7.9], ['O', 75.3, 9.4], ['T', 94.7, 7.9], ['A', 113.0, 8.7],
      ['L', 132.0, 7.9], ['P', 165.0, 7.9], ['A', 184.0, 8.7], ['C', 203.0, 8.7],
      ['K', 222.5, 8.7], ['A', 242.0, 8.7], ['G', 261.5, 9.4], ['E', 282.0, 7.9],
    ]);
    expect(units.map((u) => u.text)).toEqual(['TOTAL PACKAGE']);
  });

  it('breaks the run at a sign that is not a letter', () => {
    // `L A N D  +  B U I L D`. Folding the lot together gives `LAND + BUILD`,
    // a phrase no vocabulary has, and loses the two labels the document wrote.
    const units = glyphs([
      ['L', 56.7, 7.9], ['A', 75.3, 8.7], ['N', 94.3, 8.7], ['D', 114.0, 8.7],
      ['+', 148.0, 6.2],
      ['B', 180.0, 8.7], ['U', 199.0, 8.7], ['I', 219.0, 3.4], ['L', 233.0, 7.9],
      ['D', 251.0, 8.7],
    ]);
    expect(units.map((u) => u.text)).toEqual(['LAND', '+', 'BUILD']);
  });

  it('leaves single-character cells at COLUMN positions alone', () => {
    /*
     * THE CONDITION THAT MAKES THE RULE SAFE. Three cells holding one
     * character each is also what a table of single-letter codes looks like,
     * and the difference is not the characters — it is that a tracked run's
     * gaps AGREE with each other and a column grid's do not. These are 100
     * points apart on a 9-point glyph.
     */
    const units = glyphs([['A', 57, 9], ['B', 157, 9], ['C', 257, 9]]);
    expect(units.map((u) => u.text)).toEqual(['A', 'B', 'C']);
  });

  it('leaves a run alone whose gaps do not agree', () => {
    /*
     * Bounded, on one baseline, all single letters — and the gaps are 6, 16,
     * 6 against a 9-point advance. Tracking is ONE gap repeated; this is four
     * things that happen to be near each other, and no sub-run of three
     * agrees either.
     */
    const units = glyphs([
      ['A', 57, 9], ['B', 72, 9], ['C', 97, 9], ['D', 112, 9],
    ]);
    expect(units.map((u) => u.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('never leaves its baseline', () => {
    const units = normaliseUnits([
      { text: 'L', x: 57, row: 0, width: 8 },
      { text: 'O', x: 77, row: 0, width: 9 },
      { text: 'T', x: 97, row: 1, width: 8 },
    ]);
    expect(units.map((u) => u.text)).toEqual(['L', 'O', 'T']);
  });

  it('does not fold a run with no letter in it', () => {
    // The icon row again, in its glyph form.
    const units = glyphs([['3', 57, 8], ['2', 77, 8], ['1', 97, 8]]);
    expect(units.map((u) => u.text)).toEqual(['3', '2', '1']);
  });

  it('does not fold a run with no widths to measure', () => {
    // Every bound here is relative to the run's own glyph advance. With no
    // advance there is no bound, and an unbounded rule would join a page.
    const units = normaliseUnits(
      [['M', 57], ['A', 80], ['S', 101]].map(([text, x]) =>
        ({ text: text as string, x: x as number, row: 0 })));
    expect(units.map((u) => u.text)).toEqual(['M', 'A', 'S']);
  });
});

// ---------------------------------------------------------------------------
// 2 · The field separator
// ---------------------------------------------------------------------------

describe('a middle dot between two fields', () => {
  it('separates them', () => {
    expect(splitOnFieldSeparators('Miami 190 · Spectral'))
      .toEqual(['Miami 190', 'Spectral']);
    expect(texts(['190.38 m² · 4 bed · 2 bath']))
      .toEqual(['190.38 m²', '4 bed', '2 bath']);
  });

  it('is not a separator without whitespace on both sides', () => {
    expect(splitOnFieldSeparators('Ph 1300·555·020'))
      .toEqual(['Ph 1300·555·020']);
    expect(splitOnFieldSeparators('190.38')).toEqual(['190.38']);
  });

  it('leaves a bullet alone — it opens a list, it does not separate', () => {
    expect(splitOnFieldSeparators('• Stone benchtops • Ducted heating'))
      .toEqual(['• Stone benchtops • Ducted heating']);
  });

  it('records what it split and from what', () => {
    const [first] = flat(['Miami 190 · Spectral']);
    expect(first).toMatchObject({
      text: 'Miami 190',
      raw: 'Miami 190 · Spectral',
      normalisation: { rule: 'field_separator' },
    });
  });
});

// ---------------------------------------------------------------------------
// 3 · Headings are labels, and never values
// ---------------------------------------------------------------------------

describe('the words a document set as display type', () => {
  it('are reported as its headings', () => {
    const units = flat(['L O T', 'E S T A T E', 'Sandpiper Estate', 'B E D']);
    expect([...trackedOutHeadings(units)].sort())
      .toEqual(['BED', 'ESTATE', 'LOT']);
  });

  it('never include a number, however it was set', () => {
    // `3 7` is the value the heading above it introduces. A rule that called
    // it a heading would refuse the one field the heading exists to name.
    const units = normaliseUnits([
      { text: 'L O T', x: 0, row: 0, width: 30 },
      { text: '3 7', x: 34, row: 0, width: 14 },
    ]);
    expect([...trackedOutHeadings(units)]).toEqual(['LOT']);
  });

  it('never include an ordinary name the page drew in capitals', () => {
    // `PROPLAUNCH` is set in capitals and is not tracked out. The rule is
    // about the TYPE, not about the case.
    expect([...trackedOutHeadings(flat(['PROPLAUNCH']))]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 · The two layers together, on the block that made both necessary
// ---------------------------------------------------------------------------

/**
 * THE RISK NORMALISATION CREATES, AND THE GATE THAT ANSWERS IT.
 *
 * These two layers are one change and have to be tested as one. Making
 * `L A N D` and `B U I L D` legible is correct — they ARE those words, and
 * resolving them is what this layer is for. It is also what puts two AREA
 * labels next to a package price, which no reader could have done before,
 * because no reader could read the heading.
 *
 * So the block is drawn here as the page draws it: a tracked-out heading row,
 * the figure under it. Normalisation must make the label legible AND the
 * figure must not become a land size.
 */
describe('a tracked-out LAND + BUILD heading over a package price', () => {
  const items: Array<[string, number, number, number]> = [
    ['T O T A L', 40, 700, 52], ['P A C K A G E', 100, 700, 72],
    ['L A N D', 40, 680, 42], ['+', 88, 680, 6], ['B U I L D', 100, 680, 48],
    ['$1,327,407', 40, 660, 70],
    ['Lot 37, Sandpiper Estate, Tweed Heads NSW', 40, 600, 240],
    ['Miami 190', 40, 580, 60],
    ['Price: $1,327,407', 40, 560, 90],
  ];
  const reading = () => readPdfBrochure(
    [items.map(([text]) => text).join('\n')],
    {
      positionedPages: [{
        page: 1,
        items: items.map(([text, x, y, width]) => ({ text, x, y, width })),
      }],
    },
  );

  it('reads the document rather than standing it down', () => {
    expect(reading().status).toBe('complete');
  });

  it('NEVER writes the package price into a land size', () => {
    const row = (reading().rows ?? [])[0] ?? {};
    expect(row.land_size_sqm).toBeUndefined();
    expect(row.building_size_sqm).toBeUndefined();
  });

  it('says WHY, in the gate’s own vocabulary', () => {
    // An import log that reports a missing measurement and an import log that
    // reports `money_is_not_an_area` send an operator to different places.
    expect(reading().diagnostics.declinedFields ?? []).toContain('land_size_sqm');
    expect(reading().diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:money_is_not_an_area');
  });

  it('still reads everything the document really states', () => {
    const row = (reading().rows ?? [])[0] ?? {};
    expect(row).toMatchObject({
      lot_number: '37',
      suburb: 'Tweed Heads',
      state: 'NSW',
      development_name: 'Sandpiper Estate',
      price: '$1,327,407',
    });
  });
});
