/**
 * TWO LINES OF TYPE THAT ARE ONE LINE ON THE PAGE.
 *
 * `layoutLines` groups a page's runs by baseline, and two production shapes
 * broke that grouping on 23 September 2026 (see `liftedSuperscripts` and
 * `joinDriftedLabelValues`): a raised `²` landing on a HEADING's baseline
 * rather than its figure's, and a `Total:` label set 2.9 points above its own
 * value. Both rules are about the TYPE — sizes, rises and positions — and
 * both decline wherever the extractor supplied no heights, which every fixture
 * written before heights existed relies on.
 *
 * Every case below has a twin one condition away that must NOT change, because
 * a rule that merges lines is a rule that can merge the wrong ones.
 */
import { describe, expect, it } from 'vitest';

import {
  layoutLines,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const run = (y: number, x: number, width: number, height: number, text: string): PdfTextItem =>
  ({ text, x, y, width, height });

const textOf = (items: PdfTextItem[]) =>
  layoutLines(items).map((line) => line.cells.map((cell) => cell.text));

describe('a superscript belongs to the figure it abuts', () => {
  const heading = run(111.9, 27.3, 78.3, 14, 'Specifications');
  const label = run(109.7, 29.5, 38.8, 10, 'Enclosed:');
  const figure = run(109.7, 101.5, 28.7, 10, '91.91m');

  it('even when another run shares its baseline', () => {
    const raised = run(113.0, 130.1, 3.0, 5.8, '2');
    expect(textOf([heading, raised, label, figure])).toEqual([
      ['Specifications'],
      ['Enclosed:', '91.91m2'],
    ]);
  });

  it('but not when it stands clear of the figure', () => {
    // Nine points from the figure's end: a separate run, not its exponent.
    const apart = run(113.0, 139.2, 3.0, 5.8, '2');
    expect(textOf([heading, apart, label, figure])).toEqual([
      ['Specifications', '2'],
      ['Enclosed:', '91.91m'],
    ]);
  });

  it('nor when it is set as large as the figure', () => {
    const large = run(113.0, 130.1, 6.0, 9.0, '2');
    expect(textOf([heading, large, label, figure])[0]).toEqual(['Specifications', '2']);
  });

  it('nor when it is raised a whole line or more', () => {
    const high = run(120.0, 130.1, 3.0, 5.8, '2');
    expect(textOf([high, label, figure])).toEqual([['2'], ['Enclosed:', '91.91m']]);
  });

  it('and nothing moves where the extractor supplied no heights', () => {
    const bare = (item: PdfTextItem) => ({ ...item, height: undefined });
    const raised = run(113.0, 130.1, 3.0, 5.8, '2');
    expect(textOf([heading, raised, label, figure].map(bare))).toEqual([
      ['Specifications', '2'],
      ['Enclosed:', '91.91m'],
    ]);
  });
});

describe("a label's value set a few points off its baseline", () => {
  const total = run(70.7, 29.5, 22.4, 10, 'Total:');
  const value = run(67.8, 101.5, 31.6, 10, '129.5m2');

  it('is on the label\'s line', () => {
    expect(textOf([total, value])).toEqual([['Total:', '129.5m2']]);
  });

  it('whichever of the two sits higher', () => {
    const above = run(73.6, 101.5, 31.6, 10, '129.5m2');
    expect(textOf([total, above])).toEqual([['Total:', '129.5m2']]);
  });

  it('but not a line apart', () => {
    const below = run(66.2, 101.5, 31.6, 10, '129.5m2');
    expect(textOf([total, below])).toEqual([['Total:'], ['129.5m2']]);
  });

  it('nor directly under the label, which is the pair reader\'s to read', () => {
    const under = run(67.8, 29.5, 31.6, 10, '129.5m2');
    expect(textOf([total, under])).toEqual([['Total:'], ['129.5m2']]);
  });

  it('nor beside a line that is not asking for a value', () => {
    const heading = run(70.7, 29.5, 22.4, 10, 'Totals');
    expect(textOf([heading, value])).toEqual([['Totals'], ['129.5m2']]);
  });

  it('nor set at a very different size', () => {
    const display = run(67.8, 101.5, 90, 22, '129.5m2');
    expect(textOf([total, display])).toEqual([['Total:'], ['129.5m2']]);
  });

  it('nor half a page to the right', () => {
    const far = run(67.8, 420, 31.6, 10, '129.5m2');
    expect(textOf([total, far])).toEqual([['Total:'], ['129.5m2']]);
  });

  it('and nothing moves where the extractor supplied no heights', () => {
    const bare = [total, value].map((item) => ({ ...item, height: undefined }));
    expect(textOf(bare)).toEqual([['Total:'], ['129.5m2']]);
  });
});
