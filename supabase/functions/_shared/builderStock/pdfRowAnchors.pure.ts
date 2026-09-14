/**
 * Builder stock — which page of an uploaded PDF a property came off.
 *
 * A PDF stock list has no rows and no cells: its properties are read out of
 * prose, and the prose arrives as one string per page. That page number is the
 * only structure the document offers, and it is enough — a property described
 * on page 3 and the photograph drawn on page 3 are about the same house.
 *
 * So this answers one question: which page does each imported property belong
 * to? The answer becomes an ordinary source anchor, the same reserved
 * mechanism a Notion row id and a spreadsheet cell already travel through, and
 * `attributeDocumentMedia` then does the attaching.
 *
 * TWO RULES, AND THEY REFUSE MORE OFTEN THAN THEY ANSWER:
 *
 *   • A property anchors to a page only when EXACTLY ONE page names it. Two
 *     pages naming the same lot is the document declining to say which one is
 *     its record, and the answer to that is no anchor and no picture.
 *   • A document that produced exactly ONE property is that property's
 *     document, and it anchors to the FIRST page presenting a photograph —
 *     the page the brochure leads with, which is the same rule a package PDF
 *     reached through a Notion row already follows. Later pages stay
 *     unanchored: a display-village shot on page 4 is kept against the upload
 *     and shown against nobody.
 *
 * Pure: no IO and no clock.
 */
import {
  findPropertyCoverPages, resolvePropertyCover,
} from './pdfPrimaryImage.pure.ts';

/** The anchor vocabulary. Minted here so both halves cannot drift. */
export const pdfPageAnchor = (page: number): string => `pdf:page${page}`;

/** The page an anchor names, or null when the anchor is not one of ours. */
export function pdfAnchorPage(anchor: string | null | undefined): number | null {
  const match = /^pdf:page(\d+)$/.exec(String(anchor ?? ''));
  return match ? Number(match[1]) : null;
}

/** Tokens of a label, in order, punctuation and case removed. */
function tokenise(value: string): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

/**
 * How much of a label has to appear on a page before the page is said to name
 * it.
 *
 * The whole label rarely appears verbatim: a PDF breaks lines wherever the
 * layout did, so "Lot 537 Kirramingly Avenue, Donnybrook" can arrive as three
 * fragments. Matching the label's tokens as a SET survives that, and requiring
 * several of them keeps "Lot 5" from matching every page that mentions a 5.
 */
const MIN_TOKENS = 2;
const MAX_TOKENS = 8;

/** Does this page name this property? */
export function pageNamesLabel(pageText: string, label: string): boolean {
  const tokens = tokenise(label).slice(0, MAX_TOKENS);
  if (tokens.length < MIN_TOKENS) return false;
  const haystack = ` ${tokenise(pageText).join(' ')} `;
  return tokens.every((token) => haystack.includes(` ${token} `));
}

/**
 * The page each property belongs to, or null where the document does not say.
 *
 * `photoPages` is the pages that actually presented a photograph, in document
 * order. It is used only for the single-property rule, where a document about
 * one house needs no text matching to be unambiguous.
 */
export function anchorPdfRowsToPages(
  labels: string[],
  pageTexts: string[],
  photoPages: number[] = [],
  /**
   * Did the document's own page tree establish the order?
   *
   * When it did not, a page number names the third-lowest object rather than
   * the third page, and anchoring a property to one would tie it to whichever
   * page happened to sort there. Nothing is anchored in that case.
   */
  pageOrderAuthoritative = true,
  /**
   * The row's other identity names — the estate, the project — index-aligned
   * with `labels`. A builder's flyer identifies a lot the way the estate's
   * marketing does ("Lot 27, HAVENWOOD") while the row's label carries the
   * street and suburb the document never mentions, so without these the
   * corroboration test has nothing to match and the document's own cover is
   * refused. `stockIdentityHints` is what supplies them; the linked-document
   * path has passed them since the Watsons Reach fix and the uploaded-PDF
   * path never did.
   */
  identityHintsByRow: ReadonlyArray<readonly string[]> = [],
): Array<string | null> {
  if (!labels.length) return [];
  if (!pageOrderAuthoritative) return labels.map(() => null);
  const hintsFor = (index: number): readonly string[] => identityHintsByRow[index] ?? [];

  /**
   * ONE PROPERTY: the document is that property's, and its record is the page
   * that presents it AS A PACKAGE — the page stating its identity together
   * with its price, its configuration or its sizes.
   *
   * It used to be "the first page that produced a photograph", which is a fact
   * about rasters and not about the property. On the live Lot 537 contract the
   * first page producing a photograph was the third page a person sees, whose
   * heading is INCLUSIONS and whose picture is a bedroom.
   */
  if (labels.length === 1) {
    // Sole property: its own estate name corroborates, and another lot printed
    // on the page is context rather than a competitor. See `pageStatesIdentity`.
    const covers = findPropertyCoverPages(pageTexts, labels[0], hintsFor(0), true);
    if (covers.length === 1) return [pdfPageAnchor(covers[0].page)];
    /*
     * SEVERAL COVERS, ONE PROPERTY — WHICH IS NOT AMBIGUITY.
     *
     * This used to `return [null]`, and it cost a whole brochure. MEASURED
     * 11 SEPTEMBER 2026 on `LOT 717 - ENZO 10.5 MODERN - BROCHURE V002.pdf`:
     * pages 1 AND 2 both state "Lot 717, Serenity Road" with package facts —
     * page 1 is the cover carrying the 1920x1080 render, page 2 is the floor
     * plan carrying the same address block. Two covers, so no anchor; no
     * anchor, so `repairSourceImages` asked `assetsByAnchor` for nothing and
     * the property stored ZERO images out of its own seven-page brochure. It
     * then fell through to an internet search, which returned two dead
     * realestate.com.au URLs, and the card was blank.
     *
     * The refusal is right for a document listing MANY properties: two pages
     * naming one lot is the document declining to say which is its record,
     * and guessing puts somebody else's house on a card. With exactly ONE
     * property there is nothing else in the document to confuse it with — the
     * question is not "whose page is this" but "which of this property's
     * pages leads", and that question already has an answer.
     *
     * `resolvePropertyCover` is that answer, and it is the SAME function the
     * election runs (`pdfPrimaryImage.pure.ts` opens with
     * `resolvePropertyCover(covers) ?? structural`). Deferring to it is what
     * stops the anchor refusing a document the election would have read: run
     * against the live file it elects page 1 with full cover evidence in
     * 944 ms. A genuine tie still returns null, because that is what the
     * resolver itself answers.
     */
    if (covers.length > 1) {
      const chosen = resolvePropertyCover(covers);
      return [chosen ? pdfPageAnchor(chosen.page) : null];
    }
    if (photoPages.length >= 1) return [pdfPageAnchor(photoPages[0])];
    return [null];
  }

  return labels.map((label) => {
    const matches: number[] = [];
    pageTexts.forEach((text, index) => {
      if (pageNamesLabel(text, label)) matches.push(index + 1);
    });
    // Exactly one page, or nothing. A property named on two pages has not been
    // located by the document, and a guess here becomes somebody else's house
    // on a client's card.
    return matches.length === 1 ? pdfPageAnchor(matches[0]) : null;
  });
}
