/**
 * A LINK IS KEPT WHOLE OR NOT AT ALL — pinned.
 *
 * THE DEFECT THESE PIN, measured in production-rollout run 36013693485
 * (24 September 2026). A `Brochure URL` column held signed links of about 500
 * characters. An unrecognised column kept 300 characters of its cell, so every
 * request the settler made was for an address exactly 300 characters long,
 * and the host refused each one `InvalidJWT: Invalid Compact JWS`. The
 * properties cycled source → fallback → source as "a fault on our side".
 *
 * `unmapped` is where a row's brochure links live — `rowSourceBranches` reads
 * them out of it — so the assertions are made where the settler reads, on the
 * branches, as well as on the stored cell.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LINK_CHARS,
  UNMAPPED_PROSE_CHARS,
  keptUnmappedCell,
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { rowSourceBranches } from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';

/** An invented signed link of the measured shape, `length` characters long. */
function signedLink(length: number, name = 'lot-4127-aster-21-brochure.pdf'): string {
  const head = `https://fixture-project.supabase.co/storage/v1/object/sign/brochures/${name}?token=`;
  return head + 'a'.repeat(length - head.length);
}

const ROW = { Lot: '4127', Suburb: 'Wattlebank', State: 'VIC', Postcode: '3977' };

describe('a brochure link in an unrecognised column', () => {
  it('reaches the settler whole, past the 300 characters it was cut at', () => {
    const link = signedLink(488);
    const record = normaliseStockRow({ ...ROW, 'Brochure URL': link })!;
    expect(record.unmapped['Brochure URL']).toBe(link);
    expect(rowSourceBranches(record.unmapped).map((b) => b.url)).toEqual([link]);
  });

  it('keeps every link in a cell whole, in order, and clips only the prose', () => {
    const first = signedLink(947, 'lot-4133-briar-19.pdf');
    const second = signedLink(520, 'lot-4133-briar-19-plan.pdf');
    const prose = 'Package brochure and floor plan, current release. '.repeat(10).trim();
    const kept = keptUnmappedCell(`${prose} ${first} ${second}`);

    expect(kept.split(' ').filter((t) => t.startsWith('https://'))).toEqual([first, second]);
    const keptProse = kept.split(' ').filter((t) => !t.startsWith('https://')).join(' ');
    expect(keptProse.length).toBeLessThanOrEqual(UNMAPPED_PROSE_CHARS);
    expect(prose.startsWith(keptProse)).toBe(true);
  });

  it('leaves out a link longer than the bound image links have always had', () => {
    const tooLong = signedLink(MAX_LINK_CHARS + 1);
    const fits = signedLink(MAX_LINK_CHARS);
    expect(keptUnmappedCell(`${tooLong} ${fits}`)).toBe(fits);
  });

  it('never keeps the start of a link the cell\'s own read ended', () => {
    const whole = signedLink(600, 'first.pdf');
    const cut = signedLink(700, 'second.pdf').slice(0, 450);
    // The read ended inside the last token: that token is not a link.
    expect(keptUnmappedCell(`${whole} ${cut}`, true)).toBe(whole);
    // Nothing ended it: the same text is two links.
    expect(keptUnmappedCell(`${whole} ${cut}`, false)).toBe(`${whole} ${cut}`);
  });

  it('knows when the 4,000-character read ended the cell', () => {
    const filler = `${'x'.repeat(3000)} ${signedLink(1500, 'crosses-the-read.pdf')}`;
    const record = normaliseStockRow({ ...ROW, 'Brochure URL': filler })!;
    // The link crossed the read's end, so it is not kept as a shorter link.
    expect(rowSourceBranches(record.unmapped)).toEqual([]);
  });
});

describe('a cell with no link is kept exactly as it always was', () => {
  it('prose past the clip is cut at 300 characters, byte for byte as before', () => {
    const prose = 'Estate notes: '.padEnd(900, 'lorem ipsum ');
    const record = normaliseStockRow({ ...ROW, 'Legal Memo': prose })!;
    expect(record.unmapped['Legal Memo']).toBe(prose.slice(0, 300));
  });

  it('a cell no longer than the clip is untouched, link or not', () => {
    const short = 'Brochure: https://drive.google.com/file/d/Fixture01/view?usp=drive_link';
    expect(keptUnmappedCell(short)).toBe(short);
    expect(keptUnmappedCell('Titled, registered')).toBe('Titled, registered');
  });

  it('agrees with the old clip on every cell that carries no link', () => {
    for (let n = 0; n <= 700; n += 7) {
      const cell = 'word '.repeat(n).trim();
      expect(keptUnmappedCell(cell)).toBe(cell.slice(0, 300));
    }
  });
});
