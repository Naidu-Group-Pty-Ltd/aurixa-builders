import { describe, expect, it } from 'vitest';
import { readOpenDocument } from '../../../supabase/functions/_shared/builderStock/otherFormats.pure.ts';

/**
 * AN OPENDOCUMENT CELL'S TEXT IS ITS TEXT, NOT ITS MARKUP.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, phase
 * `stock-tier0-formats`): an ODT stock list whose table crossed a page imported
 * its second property as reference `T0-42 2`, address `12 For matcheck Street`,
 * suburb `Truga nina`, estate `Kestre l Grove` and design `Nutme g 20`, and lost
 * its price and status. LibreOffice records where a page break FELL while it
 * laid the document out as `<text:soft-page-break/>` — a layout marker with no
 * content — and the reader replaced every tag with a space.
 *
 * The rule is the ODF one: an element is whitespace only where the format says
 * it is (`text:s`, `text:tab`, `text:line-break`, a paragraph boundary), and
 * every other element — a soft page break, a formatting span, a bookmark —
 * contributes nothing of its own.
 */
const table = (...rows: string[][]) => `<office:document-content><office:body><office:text>
  <table:table table:name="Stock">${rows.map((cells) => `<table:table-row>${cells.map((cell) =>
    `<table:table-cell office:value-type="string">${cell}</table:table-cell>`).join('')}</table:table-row>`).join('')}
  </table:table></office:text></office:body></office:document-content>`;

describe('OpenDocument cell text', () => {
  it('reads a cell a page break fell inside as one value (the measured defect)', () => {
    const xml = table(
      ['<text:p>Stock Ref</text:p>', '<text:p>Suburb</text:p>', '<text:p>Package Price</text:p>'],
      ['<text:p>T0-42<text:soft-page-break/>2</text:p>', '<text:p>Truga<text:soft-page-break/>nina</text:p>',
        '<text:p>$612,<text:soft-page-break/>500</text:p>'],
    );
    expect(readOpenDocument(xml).tables[0][1]).toEqual(['T0-422', 'Truganina', '$612,500']);
  });

  it('reads a word formatted part-way through as one word', () => {
    const xml = table(
      ['<text:p>Estate</text:p>', '<text:p>Design</text:p>'],
      ['<text:p>Kes<text:span text:style-name="T1">trel</text:span> Grove</text:p>',
        '<text:p><text:bookmark text:name="d"/>Nutmeg<text:span text:style-name="T2"> 20</text:span></text:p>'],
    );
    expect(readOpenDocument(xml).tables[0][1]).toEqual(['Kestrel Grove', 'Nutmeg 20']);
  });

  it('keeps the whitespace the format encodes as elements', () => {
    const xml = table(
      ['<text:p>Street Address</text:p>', '<text:p>Description</text:p>'],
      ['<text:p>12<text:s/>Proofline<text:tab/>Way</text:p>',
        '<text:p>North<text:s text:c="3"/>facing<text:line-break/>yard</text:p><text:p>Second line</text:p>'],
    );
    expect(readOpenDocument(xml).tables[0][1]).toEqual(['12 Proofline Way', 'North facing yard Second line']);
  });

  it('reads the document text the same way', () => {
    const xml = `<office:document-content><office:body><office:text>
      <text:p>Kest<text:soft-page-break/>rel Grove — Stage <text:span text:style-name="T1">3</text:span></text:p>
    </office:text></office:body></office:document-content>`;
    expect(readOpenDocument(xml).text).toBe('Kestrel Grove — Stage 3');
  });
});

/*
 * FOUND BY THE INDEPENDENT REVIEW (28 September 2026): the space-count pattern
 * backtracked on an unterminated `<text:s` carrying many `text:c` attributes —
 * 172 KB took 4.3 s — so a crafted cell could stall its own import.
 */
describe('a crafted space element', () => {
  it('is read in linear time', () => {
    const cell = `<text:p>Lot<text:s ${'text:c="2" '.repeat(15_000)}</text:p>`;
    const started = performance.now();
    readOpenDocument(table(['<text:p>Stock Ref</text:p>'], [cell]));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('still counts the spaces a well-formed element asks for', () => {
    const { tables } = readOpenDocument(table(
      ['<text:p>Stock Ref</text:p>', '<text:p>Street Address</text:p>'],
      ['<text:p>T0-1</text:p>', '<text:p>12<text:s text:c="3"/>Proofline<text:s/>Way</text:p>'],
    ));
    expect(tables[0][1][1]).toBe('12 Proofline Way');
  });
});
