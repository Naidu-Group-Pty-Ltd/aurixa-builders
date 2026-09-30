import { describe, expect, it } from 'vitest';
import {
  decodeAscii85, imageStreamFlags,
} from '../../../supabase/functions/_shared/builderStock/pdfAscii85.pure';
import { pictureFromStream } from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';

/**
 * MEASURED 30 SEPTEMBER 2026. Nine Mairandi properties had no photograph
 * because their builder's brochure draws the cover picture as
 * `/Filter [/ASCII85Decode /DCTDecode]`, and the reader took any stream whose
 * first filter was not Flate to be the picture already.
 */
function encodeAscii85(data: Uint8Array): Uint8Array {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    const count = chunk.length;
    let value = 0;
    for (let j = 0; j < 4; j++) value = value * 256 + (j < count ? chunk[j] : 0);
    if (count === 4 && value === 0) { out += 'z'; continue; }
    const digits: number[] = [];
    for (let j = 0; j < 5; j++) { digits.unshift(value % 85); value = Math.floor(value / 85); }
    out += digits.slice(0, count + 1).map((d) => String.fromCharCode(d + 33)).join('');
  }
  return new TextEncoder().encode(`${out}~>`);
}

describe('ASCII85', () => {
  it('round-trips every length, including runs of zero bytes', () => {
    for (let length = 0; length < 40; length++) {
      const data = new Uint8Array(length).map((_, i) => (i % 7 === 0 ? 0 : (i * 37 + 11) & 255));
      expect([...decodeAscii85(encodeAscii85(data))!]).toEqual([...data]);
    }
  });

  it('ignores whitespace and the optional <~ prefix', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const text = new TextDecoder().decode(encodeAscii85(data));
    const spaced = new TextEncoder().encode(`<~ ${text.slice(0, 4)}\r\n${text.slice(4)}`);
    expect([...decodeAscii85(spaced)!]).toEqual([...data]);
  });

  it('answers null for a stream that is not ASCII85', () => {
    expect(decodeAscii85(new TextEncoder().encode('ab\u007fcd~>'))).toBeNull();
    expect(decodeAscii85(new TextEncoder().encode('a~>'))).toBeNull();
  });

  it('reads which wrappers a filter chain carries', () => {
    expect(imageStreamFlags(['ASCII85Decode', 'DCTDecode'])).toEqual({ ascii85: true, flate: false });
    expect(imageStreamFlags(['ASCII85Decode', 'FlateDecode'])).toEqual({ ascii85: true, flate: true });
    expect(imageStreamFlags(['FlateDecode'])).toEqual({ ascii85: false, flate: true });
    expect(imageStreamFlags(['DCTDecode'])).toEqual({ ascii85: false, flate: false });
  });
});

describe('a picture wrapped in ASCII85', () => {
  const jpeg = new Uint8Array(4096).map((_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : (i * 31) & 255));

  it('is the JPEG once unwrapped, byte for byte', async () => {
    const wrapped = encodeAscii85(jpeg);
    const document = new Uint8Array(wrapped.length + 20);
    document.set(wrapped, 10);
    const picture = await pictureFromStream(document, {
      start: 10, end: 10 + wrapped.length, flate: false, ascii85: true, width: 64, height: 64,
    });
    expect(picture?.contentType).toBe('image/jpeg');
    expect([...picture!.bytes]).toEqual([...jpeg]);
    expect(picture!.transformation).toBeNull();
  });

  it('is still refused when not marked as wrapped (the old behaviour)', async () => {
    const wrapped = encodeAscii85(jpeg);
    expect(await pictureFromStream(wrapped, {
      start: 0, end: wrapped.length, flate: false, width: 64, height: 64,
    })).toBeNull();
  });
});

describe('a property the builder calls a unit, not a lot', () => {
  it('finds the pack named for that unit, exactly', async () => {
    const { selectPackageDocument, unitFrom, selectLotFolder } = await import(
      '../../../supabase/functions/_shared/builderStock/drivePackage.pure'
    );
    expect(unitFrom('Unit 9 Thornton NSW · Industrial')).toBe('9');
    expect(unitFrom('Lot 4 Somewhere VIC')).toBeNull();
    const pdf = 'application/pdf';
    const entries = [
      { id: 'a', name: 'Thornton Unit 9 Industrial 5 Kestrel Ave Pack.pdf', mimeType: pdf },
      { id: 'b', name: 'Thornton Unit 11 Industrial 5 Kestrel Ave Pack.pdf', mimeType: pdf },
      { id: 'c', name: 'Thornton Unit 1 Industrial 5 Kestrel Ave Pack.pdf', mimeType: pdf },
    ];
    expect(selectPackageDocument(entries, { lot: '9', design: null, word: 'unit' })?.id).toBe('a');
    expect(selectPackageDocument(entries, { lot: '1', design: null, word: 'unit' })?.id).toBe('c');
    // As a LOT the same number finds nothing: a unit is never read as a lot.
    expect(selectPackageDocument(entries, { lot: '9', design: null })).toBeNull();
    expect(selectLotFolder([{ id: 'f', name: 'Unit 9', mimeType: 'application/vnd.google-apps.folder' }], '9', 'unit')).toBe('f');
    expect(selectLotFolder([{ id: 'f', name: 'Unit 9', mimeType: 'application/vnd.google-apps.folder' }], '9')).toBeNull();
  });
});

describe('the padding and tenure a builder puts in a pack name', () => {
  it('reads "Unit 09" as unit 9, and never unit 19 as unit 9', async () => {
    const { carriesDesignation, selectPackageDocument } = await import(
      '../../../supabase/functions/_shared/builderStock/drivePackage.pure'
    );
    expect(carriesDesignation('thornton unit 09 industrial pack', 'unit', '9')).toBe(true);
    expect(carriesDesignation('thornton unit 9 industrial pack', 'unit', '09')).toBe(true);
    expect(carriesDesignation('thornton unit 19 industrial pack', 'unit', '9')).toBe(false);
    expect(carriesDesignation('thornton unit 90 industrial pack', 'unit', '9')).toBe(false);
    // Lots stay exact.
    expect(carriesDesignation('lot 05 foo', 'lot', '5')).toBe(false);
    const pdf = 'application/pdf';
    const entries = [
      { id: 'a', name: 'Thornton Unit 09 Industrial Pack.pdf', mimeType: pdf },
      { id: 'b', name: 'Thornton Unit 19 Industrial Pack.pdf', mimeType: pdf },
    ];
    expect(selectPackageDocument(entries, { lot: '9', design: null, word: 'unit' })?.id).toBe('a');
  });

  it('tells two packs of one lot apart by the dual-key the row states', async () => {
    const { selectPackageDocument, dualKeyStated } = await import(
      '../../../supabase/functions/_shared/builderStock/drivePackage.pure'
    );
    const pdf = 'application/pdf';
    const entries = [
      { id: 'plain', name: 'Lot 113 Millfield 180 Pack.pdf', mimeType: pdf },
      { id: 'dual', name: 'Lot 113 Millfield Dual Key Pack.pdf', mimeType: pdf },
    ];
    expect(dualKeyStated('Lot 113 Millfield NSW · 210 Dual-Key')).toBe(true);
    expect(dualKeyStated('Lot 113 Millfield NSW · 180')).toBe(false);
    expect(selectPackageDocument(entries, { lot: '113', design: null, dualKey: true })?.id).toBe('dual');
    expect(selectPackageDocument(entries, { lot: '113', design: null, dualKey: false })?.id).toBe('plain');
    // Without the row's statement the folder still declines, as it always did.
    expect(selectPackageDocument(entries, { lot: '113', design: null })).toBeNull();
    // Two that agree is still the source declining to say.
    const twoPlain = [entries[0], { id: 'plain2', name: 'Lot 113 Millfield 200 Pack.pdf', mimeType: pdf }];
    expect(selectPackageDocument(twoPlain, { lot: '113', design: null, dualKey: false })).toBeNull();
  });
});

describe('a cover that pads its unit number', () => {
  it('reads "UNIT 09" as the property the row calls "Unit 9", and only that one', async () => {
    const { coverIdentityRefusal } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure'
    );
    const label = 'Unit 9 Thornton NSW · Industrial';
    const hints = ['Thornton Industrial'];
    const page = (unit: string) => `THORNTON INDUSTRIAL UNIT ${unit} 5 KESTREL AVE THORNTON NSW 2322`;
    expect(coverIdentityRefusal(page('09'), label, hints)).toBeNull();
    expect(coverIdentityRefusal(page('9'), label, hints)).toBeNull();
    expect(coverIdentityRefusal(page('19'), label, hints)).not.toBeNull();
    expect(coverIdentityRefusal(page('90'), label, hints)).not.toBeNull();
  });
});

describe('a unit pack the builder’s folder tied to this property', () => {
  const LABEL = 'Unit 9 Thornton NSW · Industrial';
  const HINTS = ['Thornton Industrial - 5 Kestrel Ave NSW 2322'];
  // Page 1 names the unit and states ONE package fact (a price) — Thornton’s packs.
  const PAGE_1 = 'THORNTON INDUSTRIAL PACK UNIT 09 5 KESTREL AVE THORNTON NSW 2322 PRICE $684,000';
  const PAGE_2 = 'FLOOR PLAN UNIT 09 162 m2';
  const media = [{ page: 1, name: null, placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.6 }];

  it('is not a cover by the ordinary rule: one fact is a coincidence', async () => {
    const m = await import('../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(m.findPropertyCoverPages([PAGE_1, PAGE_2], LABEL, HINTS)).toEqual([]);
    const roles = m.assignPdfMediaRoles({
      label: LABEL, pageTexts: [PAGE_1, PAGE_2], pageOrderAuthoritative: true, media,
      identityHints: HINTS,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });

  it('is the cover once the folder tied it and its first page states the unit', async () => {
    const m = await import('../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(m.coverIdentityRefusal(PAGE_1, LABEL, HINTS)).toBeNull();
    const roles = m.assignPdfMediaRoles({
      label: LABEL, pageTexts: [PAGE_1, PAGE_2], pageOrderAuthoritative: true, media,
      identityHints: HINTS, structuralCoverPage: 1,
    });
    expect(roles[0].role).toBe('primary_property');
    expect(m.coverSearchPages({
      label: LABEL, pageTexts: [PAGE_1, PAGE_2], identityHints: HINTS, structuralCoverPage: 1,
    })).toEqual([1]);
  });

  it('is NOT promoted when the page states another unit — the folder alone attributes nothing', async () => {
    const m = await import('../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    const other = PAGE_1.replace('UNIT 09', 'UNIT 19');
    const roles = m.assignPdfMediaRoles({
      label: LABEL, pageTexts: [other, PAGE_2], pageOrderAuthoritative: true, media,
      identityHints: HINTS, structuralCoverPage: 1,
    });
    expect(roles[0].role).not.toBe('primary_property');
  });
});

describe('a display home the builder filed under its design and estate', () => {
  const LABEL = 'Deanside VIC · Mira 22 Display Home';
  it('is its cover when the page states the whole design and no lot', async () => {
    const { displayHomeCoverStated } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(displayHomeCoverStated('Mira 22 — 6 Elodina Street · Monarch', LABEL, 'Mira 22')).toBe(true);
  });
  it('is not, for another design, a page naming a lot, a listing with a lot, or no design at all', async () => {
    const { displayHomeCoverStated } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(displayHomeCoverStated('Mira 25 — 6 Elodina Street', LABEL, 'Mira 22')).toBe(false);
    expect(displayHomeCoverStated('Lot 419 · Mira 22 facade', LABEL, 'Mira 22')).toBe(false);
    expect(displayHomeCoverStated('Mira 22', 'Lot 12 Deanside VIC · Mira 22', 'Mira 22')).toBe(false);
    expect(displayHomeCoverStated('Mira 22', LABEL, null)).toBe(false);
    expect(displayHomeCoverStated('22 Main Street', LABEL, '22')).toBe(false);
  });
  it('is asked only where the folder attributed the document, and only after the ordinary rule', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/pdfElection.ts', 'utf8');
    const rule = source.slice(source.indexOf("identifiedBy === 'folder_structure'"));
    expect(rule.indexOf('!findPropertyCoverPages(')).toBeLessThan(rule.indexOf('displayHomeCoverStated('));
    expect(rule.indexOf('displayHomeCoverStated(')).toBeLessThan(rule.indexOf('? 1 : null'));
  });
  it('is elected by the role gate too, not only nominated — and never without the design', async () => {
    const m = await import('../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    const PAGE_1 = 'Mira 22\n6 Elodina Street,\nDeanside VIC';
    const PAGE_2 = 'Floor plan Mira 22 living 22.4 squares';
    const media = [{ page: 1, name: null, placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.6 }];
    const base = {
      label: LABEL, pageTexts: [PAGE_1, PAGE_2], pageOrderAuthoritative: true, media,
      identityHints: ['Monarch Estate Deanside VIC'], structuralCoverPage: 1,
    };
    expect(m.coverIdentityRefusal(PAGE_1, LABEL, base.identityHints)).not.toBeNull();
    expect(m.assignPdfMediaRoles({ ...base, design: 'mira 22' })[0].role).toBe('primary_property');
    expect(m.assignPdfMediaRoles({ ...base, design: null })[0].role).not.toBe('primary_property');
    expect(m.assignPdfMediaRoles({ ...base, design: 'mira 25' })[0].role).not.toBe('primary_property');
    expect(m.assignPdfMediaRoles({ ...base, design: 'mira 22', structuralCoverPage: null })[0].role)
      .not.toBe('primary_property');
  });
});
