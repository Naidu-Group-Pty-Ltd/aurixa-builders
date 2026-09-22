/**
 * ===========================================================================
 * WHEN A PDF'S OWN TEXT IS NOT ENOUGH, AND WHICH PAGES NEED READING.
 * ===========================================================================
 *
 * A scanned brochure is a PDF whose pages are photographs of paper. It has no
 * text layer, so `readPdfPageTexts` returns empty strings and the extractor
 * refuses it as `pdf_no_text_layer` — an honest refusal, and one this product
 * is supposed to be able to answer instead of make.
 *
 * THE DECISION IS PER PAGE, NEVER PER DOCUMENT, and that is what makes a MIXED
 * document work. A builder scans a signed contract page into an otherwise
 * native brochure; the native pages must keep their own text, which is exact,
 * and only the scanned ones go through recognition, which is not. Judging the
 * document as a whole would either discard good text or leave the scan unread.
 *
 * AND NOTHING HERE IS ABOUT PROPERTY. This decides that a page has no readable
 * text on it. What the words mean is the reader's business, and the words
 * recognition produces go through exactly the same normalisation, the same
 * evidence model and the same typed validators as words a PDF stated itself.
 * There is no OCR reader, no OCR vocabulary and no OCR field rule.
 */

/**
 * How many printable characters a page must carry to count as having text.
 *
 * A scanned page is not empty: a PDF's text layer picks up stray marks, a
 * digital signature's label, a page number the scanner's software stamped on.
 * Zero would therefore declare a scan "has text" on the strength of a
 * watermark, which is `SCANNED_ROUTING.md`'s own lesson in the sibling repo —
 * a stray watermark character must not make a scanned page look native.
 *
 * Forty is about one short line. Below it there is nothing a property could be
 * read from, and above it a page states something.
 */
export const MIN_PAGE_TEXT_CHARS = 40;

/** Letters and digits only: punctuation and rules are not statements. */
function printableCount(page: string): number {
  return (String(page ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export interface OcrPlan {
  /** 1-based page numbers whose text must be recognised rather than read. */
  pages: number[];
  /** Every page carried text; nothing to recognise. */
  sufficient: boolean;
  /** No page carried text at all — the document is a scan. */
  imageOnly: boolean;
}

/**
 * Which pages of this document need recognising.
 *
 * `pageTexts` is what the PDF itself states, page by page, in reading order.
 */
export function planOcr(pageTexts: readonly string[]): OcrPlan {
  const counts = pageTexts.map(printableCount);
  const pages = counts
    .map((count, index) => (count < MIN_PAGE_TEXT_CHARS ? index + 1 : 0))
    .filter((page) => page > 0);
  return {
    pages,
    sufficient: pages.length === 0,
    imageOnly: pageTexts.length > 0 && pages.length === pageTexts.length,
  };
}

/**
 * Put recognised text back where the page it came from sits.
 *
 * ONE ARRAY OUT, IN READING ORDER, because everything downstream reads
 * `pageTexts[i]` as "what page i+1 says" — the brochure reader pairs a label
 * with the unit below it and never crosses a page boundary, and the anchor a
 * property is identified by is `pdf:pageN`. A recognised page that landed at
 * the wrong index would attribute one page's property to another's picture.
 *
 * A page recognition could not read keeps whatever the PDF stated, which for a
 * scan is nothing — the honest answer, and the one the refusal already makes.
 */
export function mergeRecognisedPages(
  pageTexts: readonly string[],
  recognised: ReadonlyMap<number, string>,
): string[] {
  return pageTexts.map((text, index) => {
    const read = recognised.get(index + 1);
    if (!read || !read.trim()) return text;
    // The page's own text is kept AHEAD of the recognised text where it had
    // any: a mixed page states some words exactly and the rest as pixels, and
    // what the document states itself is never displaced by a reading of it.
    return text.trim() ? `${text}\n${read}` : read;
  });
}
