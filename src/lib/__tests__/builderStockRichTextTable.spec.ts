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

/**
 * A `\uN` IS FOLLOWED BY ITS FALLBACK, AND A READER THAT UNDERSTANDS `\u`
 * SKIPS IT.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (phase `stock-tier0-formats`,
 * run mulp2q808ecae7): both properties of the RTF stock list stored a
 * description that printed exactly like the document's, "PROOF ONLY — not for
 * sale.", and was not equal to it. Word and LibreOffice write an em dash as
 * `舒\'97` — the code point, then the byte a reader without Unicode shows
 * instead. The reader decoded every `\'hh` BEFORE it read `\uN`, so the
 * fallback survived as its Latin-1 reading, the invisible C1 control U+0097,
 * beside the dash. `\ucN` says how many fallback characters follow (one by
 * default, and `\'hh` is one character).
 */
describe('an RTF Unicode escape', () => {
  it('stores the stock list\'s description exactly as the document states it (the measured defect)', () => {
    const rtf = readFileSync(resolve(__dirname, '../../../scripts/ops/fixtures/tier0/rtf.rtf'), 'latin1');
    const rows = readTable(rtf)!.rows as Array<Record<string, unknown>>;
    const descriptions = rows.map((row) => Object.values(row).map(String).find((v) => v.startsWith('PROOF ONLY')));
    expect(descriptions).toEqual(['PROOF ONLY — not for sale.', 'PROOF ONLY — not for sale.']);
    expect(descriptions.join('')).not.toMatch(/[\u0080-\u009f]/);
  });

  // Plain strings, not String.raw: the test transform cooks `\u` escapes even
  // inside a raw template, which hands the reader the wrong character.
  const B = '\\';
  it('skips a fallback however it is written', () => {
    expect(readRichText(`{${B}rtf1 A${B}u8212${B}'97 B}`)).toBe('A— B');
    expect(readRichText(`{${B}rtf1 A${B}u8212? B}`)).toBe('A— B');
    expect(readRichText(`{${B}rtf1 A${B}u8212 ?B}`)).toBe('A—B');
    expect(readRichText(`{${B}rtf1${B}uc2 A${B}u8212${B}'97${B}'97 B}`)).toBe('A— B');
  });

  it('skips nothing where \\uc0 says there is no fallback', () => {
    expect(readRichText(`{${B}rtf1${B}uc0 A${B}u8212 B}`)).toBe('A—B');
    expect(readRichText(`{${B}rtf1${B}uc0 caf${B}u233 s}`)).toBe('cafés');
  });

  it('never takes a control word or a brace for a fallback', () => {
    expect(readRichText(`{${B}rtf1 A${B}u8212${B}par B}`)).toBe('A—\nB');
    expect(readRichText(`{${B}rtf1 {A${B}u8212}B}`)).toBe('A— B');
  });

  it('still decodes a plain \\\'hh escape and a negative \\u', () => {
    expect(readRichText(`{${B}rtf1 caf${B}'e9}`)).toBe('café');
    expect(readRichText(`{${B}rtf1 ${B}u-4064?}`)).toBe(String.fromCharCode(61472));
  });
});
