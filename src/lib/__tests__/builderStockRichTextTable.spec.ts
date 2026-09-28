import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRichText } from '../../../supabase/functions/_shared/builderStock/otherFormats.pure.ts';
import { keyRowsByHeader, parseDelimited } from '../../../supabase/functions/_shared/builderStock/table.pure.ts';

/**
 * `\pard` RESETS A PARAGRAPH'S FORMATTING; IT DOES NOT END ONE.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, phase
 * `stock-tier0-formats`): an RTF stock list — a format the picker offers and
 * the reader claims to parse as a table — was refused with "We read that file,
 * but it did not describe a property we could list." The reader turned `\pard`
 * into a line break as well as `\par`, and LibreOffice (like Word) opens every
 * table cell with `\pard…\intbl`, so each cell landed on a line of its own, the
 * `\cell` tab that should have separated it from its neighbour was trimmed off
 * the line's end, and no row of the table survived to be read.
 *
 * The rule is RTF's: `\par` ends a paragraph, `\cell` ends a cell, `\row` ends
 * a row, and `\pard` only resets formatting.
 */
const readTable = (rtf: string) => keyRowsByHeader(parseDelimited(readRichText(rtf), '\t'));

describe('an RTF stock list', () => {
  it('reads the table of the stock list the live product refused (the measured defect)', () => {
    const rtf = readFileSync(resolve(__dirname, '../../../scripts/ops/fixtures/tier0/rtf.rtf'), 'latin1');
    const keyed = readTable(rtf);
    expect(keyed).not.toBeNull();
    const rows = keyed!.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const values = rows.map((row) => Object.values(row).map(String));
    expect(values[0]).toEqual(expect.arrayContaining(['T0-441', 'Kestrel Grove', '441', '10 Formatcheck Street', 'Truganina', 'Pine 21']));
    expect(values[1]).toEqual(expect.arrayContaining(['T0-442', '442', '12 Formatcheck Street', 'Pine 23']));
  });

  it('keeps a cell that opens with \\pard in its own column', () => {
    const rtf = String.raw`{\rtf1\ansi
\trowd\cellx2000\cellx4000\cellx6000
\pard\plain\intbl{Lot}\cell\pard\plain\intbl{Street Address}\cell\pard\plain\intbl{Package Price}\cell\row
\trowd\cellx2000\cellx4000\cellx6000
\pard\plain\intbl{101}\cell\pard\plain\intbl{12 Proofline Way}\cell\pard\plain\intbl{$749,900}\cell\row
}`;
    const keyed = readTable(rtf);
    expect(keyed).not.toBeNull();
    expect((keyed!.rows as Array<Record<string, unknown>>).map((row) => Object.values(row).map(String)))
      .toEqual([expect.arrayContaining(['101', '12 Proofline Way', '$749,900'])]);
  });

  it('still ends a paragraph at \\par, with or without a \\pard after it', () => {
    const text = readRichText(String.raw`{\rtf1\ansi\pard First line\par\pard Second line\par Third line\par}`);
    expect(text.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['First line', 'Second line', 'Third line']);
  });
});
