/**
 * ===========================================================================
 * WHICH PAGES NEED READING, AND WHAT HAPPENS TO WHAT IS READ.
 * ===========================================================================
 *
 * The recognition engine itself is exercised by the acceptance corpus against
 * real scanned PDF bytes — that is where "can this product read a scan" is
 * answered. What is asserted here is the POLICY, which is pure: the decision
 * is per page, a stray mark is not a text layer, and a document's own words
 * are never displaced by a reading of them.
 */
import { describe, expect, it } from 'vitest';

import {
  MIN_PAGE_TEXT_CHARS, mergeRecognisedPages, planOcr,
} from '../../../supabase/functions/_shared/builderStock/ocr/ocrPolicy.pure';

describe('which pages need recognising', () => {
  const native = 'Lot 214 Fairweather Drive, Clyde North VIC 3978 — Package Price $662,900';

  it('recognises nothing where every page states its own text', () => {
    expect(planOcr([native, native])).toEqual({
      pages: [], sufficient: true, imageOnly: false,
    });
  });

  it('names a document with no text at all as image-only', () => {
    expect(planOcr(['', '  \n '])).toEqual({
      pages: [1, 2], sufficient: false, imageOnly: true,
    });
  });

  it('is PER PAGE, which is what makes a mixed document work', () => {
    // A scanned specification sheet appended to a native marketing page. The
    // native page keeps its own exact text; only the scan is recognised.
    expect(planOcr([native, ''])).toEqual({
      pages: [2], sufficient: false, imageOnly: false,
    });
  });

  it('is not fooled by a watermark or a stamped page number', () => {
    /*
     * A scanned page is not empty: the text layer picks up a scanner's stamp,
     * a signature label, a page number. Zero would declare a scan "has text"
     * on the strength of one of those.
     */
    expect(planOcr(['Page 1 of 4']).pages).toEqual([1]);
    expect(planOcr(['CONFIDENTIAL']).pages).toEqual([1]);
    // And one short real line is still not a property.
    expect('Lot 214'.length).toBeLessThan(MIN_PAGE_TEXT_CHARS);
    expect(planOcr(['Lot 214']).pages).toEqual([1]);
  });

  it('counts letters and digits, never punctuation', () => {
    // A page of rules and dot leaders states nothing.
    expect(planOcr(['.'.repeat(200)]).pages).toEqual([1]);
  });
});

describe('what happens to the text that was read', () => {
  it('puts each page back where it belongs, in reading order', () => {
    /*
     * Everything downstream reads `pageTexts[i]` as "what page i+1 says" — the
     * brochure reader never pairs across a page boundary and a property's
     * anchor is `pdf:pageN`. A recognised page at the wrong index would
     * attribute one page's property to another's picture.
     */
    const merged = mergeRecognisedPages(['', '', ''], new Map([[2, 'SECOND']]));
    expect(merged).toEqual(['', 'SECOND', '']);
  });

  it('never displaces what the document states itself', () => {
    // A page can be both: one native line over a scanned sheet. What the PDF
    // drew is exact; what was read off it is not, so the exact text leads.
    const merged = mergeRecognisedPages(
      ['Package Price: $712,000'], new Map([[1, 'SPECIFICATION SHEET\nSite Area 375 m2']]));
    expect(merged[0].startsWith('Package Price: $712,000')).toBe(true);
    expect(merged[0]).toContain('Site Area 375 m2');
  });

  it('leaves a page recognition could not read exactly as it was', () => {
    // Which for a scan is nothing — the honest answer, and the one the
    // existing refusal already makes.
    expect(mergeRecognisedPages(['', 'kept'], new Map())).toEqual(['', 'kept']);
    expect(mergeRecognisedPages(['a'], new Map([[1, '   ']]))).toEqual(['a']);
  });
});
