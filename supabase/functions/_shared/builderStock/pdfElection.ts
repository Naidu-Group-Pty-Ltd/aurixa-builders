/**
 * BUILDER STOCK — THE ELECTION, AS ONE NAMED UNIT.
 *
 * WHY THIS MODULE EXISTS. This is the smallest indivisible CPU-heavy unit in
 * the whole builder-stock path: read a document's page texts, judge from them
 * whether the document was readable at all, and elect the one image that is
 * this property's. Both halves parse the same multi-megabyte PDF and neither
 * can be split from the other — the election is handed the texts the read
 * produced.
 *
 * MEASURED 8 SEPTEMBER 2026, from the platform's own per-execution telemetry.
 * A thirteen-property cold start killed the settler thirteen times, and every
 * kill was `reason: CPUTime`: successful executions ended at 1,828 ms of CPU
 * or less, killed ones at 2,031 ms or more, against a 2,000 ms limit. Memory
 * peaked at 108 MB of a 256 MB ceiling — 42% — so the memory ceiling was never
 * the constraint and no scheduling rule could have helped. An indivisible
 * ~2.4 s task does not fit a 2.0 s budget.
 *
 * SO THE WORK MOVES RATHER THAN SHRINKS, and the first thing that needed doing
 * was to NAME it. This module is that name. It is the same TypeScript lifted
 * VERBATIM out of `extractFromDocument` — the same slot, the same thresholds,
 * the same winners — and it is the module BOTH ends run: the Edge path when it
 * runs the election in process, and `builder-stock-pdf-worker` when it runs it
 * where there is CPU for it. Nothing here is a second implementation, and
 * nothing about which image wins is decided anywhere else.
 *
 * WHAT DELIBERATELY DID NOT MOVE. The fetch, the guarded fetcher and its SSRF
 * rules, the `%PDF-` sniff and the "a link to an image is not a package
 * document" identity rule all sit BEFORE this in `extractFromDocument` and are
 * cheap; moving them would have duplicated security logic for no CPU. Every
 * database write — branch attempts, provenance, the image pointer, upload
 * settlement — stays in the Supabase path, so this boundary reads a document
 * and answers, and touches no state at all.
 *
 * Pure of IO except the decoding itself: no database, no network, no clock.
 */
import { selectPdfPropertyPrimaryHoldingSlot } from './pdfSourcePhoto.ts';
import { withPdfDecodeSlot } from './pdfDecodeSlot.pure.ts';
import { coverIdentityQuote } from './pdfPrimaryImage.pure.ts';
// Type-only, so it is erased at compile time and no runtime cycle exists
// between this module and the one that calls it.
import type { PackageOutcome } from './packageImages.ts';

/**
 * Everything the election needs to know about the property, and nothing else.
 *
 * This is the WHOLE of what crosses the boundary beside the bytes. It carries
 * no identifier of any kind — no row id, no organisation, no upload — because
 * the worker decides nothing about the property and must not be able to.
 */
export interface ElectionContext {
  /** The property this package is supposed to be about. */
  label: string;
  /**
   * HOW THIS DOCUMENT CAME TO BE THIS PROPERTY'S. See the same parameter on
   * `extractFromDocument`: `folder_structure` licenses the structural cover,
   * `direct_link` establishes nothing and the document must state its property
   * in text like any other.
   */
  identifiedBy: 'folder_structure' | 'direct_link';
  /** The row's stated house design, for the design fallback. */
  design?: string | null;
  /** The row's other identity names, for the cover rule's corroboration test. */
  identityHints?: readonly string[] | null;
  /** Used only to build the elected image's reference string. */
  documentName: string;
  /** Recorded on the result as the document's own address. */
  url: string;
}

/**
 * The text read and the election over the same bytes, inside one decode slot.
 *
 * Lifted verbatim from `extractFromDocument`. A test asserts that this file
 * and the call site together still say what the single function said.
 */
export async function electFromPdfBytes(
  bytes: Uint8Array,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  context: ElectionContext,
): Promise<PackageOutcome> {
  const { label, identifiedBy, design, identityHints, documentName, url } = context;
  /*
   * THE WHOLE HEAVY PATH, INSIDE ONE SLOT.
   *
   * The slot used to be taken by `selectPdfPropertyPrimary` alone — so the
   * text read, which runs FIRST and parses the same multi-megabyte document,
   * was never behind it. Measured 7 September 2026 on the six brochures that
   * had failed: the text read costs 400–1,029 ms against the election's
   * 670–1,215 ms, so very nearly half the heavy work stood outside the guard
   * that exists to stop heavy work piling up. That is why a slot which had
   * already proved the principle did not save them: N documents could be in
   * their text stage together, and five concurrent reads peak at 429 MB
   * against a 256 MB ceiling.
   *
   * Taken ONCE, around both stages, so one document is read from end to end
   * before another begins. `selectPdfPropertyPrimaryHoldingSlot` is the
   * variant that does not re-enter — taking the slot twice in one call stack
   * is a deadlock rather than a bound.
   */
  return await withPdfDecodeSlot(async () => {
  const textResult = await readPageTexts(bytes);
  if (!textResult.ok) {
    return {
      status: 'unreachable',
      detail: `That document’s text could not be read (${"reason" in textResult ? textResult.reason : "unknown"}).`,
    };
  }
  /*
   * And zero pages is the same fault wearing a different hat, whichever reader
   * produced it: a PDF always has pages, so an empty list is the read failing
   * rather than the document being silent. Judged here rather than inside one
   * reader so every reader is held to it — the production one, and the ones
   * tests inject to stand in for it.
   */
  if (!textResult.pages.length) {
    return {
      status: 'unreachable',
      detail: 'That document\'s text could not be read (no pages came back).',
    };
  }
  /*
   * AND PAGES THAT CAME BACK EMPTY ARE THE SAME FAULT AGAIN.
   *
   * A package whose every page yields no text at all is not a package that says
   * nothing about the property — it is a package this reader cannot read. The
   * live list has them: "LOT 914 • COVELLA • GREENBANK QLD.pdf" is three pages
   * of designed brochure exported as images, and its first page carries the
   * lot, the estate, the suburb, the price, the land and house sizes and the
   * facade render, all of it drawn rather than set. Text extraction returns
   * zero characters from every page.
   *
   * Recording that as "the document names no image for this property" banks a
   * finished negative produced by a reader that never read the document — and
   * `negativeProvenanceStillStands` would then suppress the source until a
   * version bump. So it is operational, and the property is asked again: the
   * answer changes for free the day this can read a drawn page.
   *
   * PARTIAL emptiness is deliberately NOT this. A document with text on some
   * pages was read; that it says nothing identifying on the others is a fact
   * about the document.
   */
  const textFree = textResult.pages.every((text) => !String(text ?? '').trim());
  if (textFree && identifiedBy !== 'folder_structure') {
    return {
      status: 'unreachable',
      detail: 'That document\'s pages carry no extractable text, so it could not be read.',
    };
  }
  const pageTexts = textResult.pages;
  const selection = await selectPdfPropertyPrimaryHoldingSlot(bytes, {
    label,
    design,
    identityHints: identityHints ?? [],
    pageTexts,
    // Supplied ONLY when the builder's folder already named this document for
    // this one property and the document itself can say nothing. See
    // `assignPdfMediaRoles`.
    structuralCoverPage: textFree ? 1 : null,
  });
  const photo = selection.primary;
  if (!photo) {
    /*
     * A document nothing could be read from has still established nothing, even
     * where its first page was structurally eligible and presented no single
     * photograph. Recording a negative for it would bank an answer this reader
     * never earned, so it stays operational and the property is asked again.
     */
    if (textFree) {
      return {
        status: 'unreachable',
        detail: 'That document\'s pages carry no extractable text and its first page '
          + 'presents no single photograph, so it could not be read.',
      };
    }
    /*
     * AND IT SAYS WHAT THE DOCUMENT IS INSTEAD, BECAUSE THAT IS THE FIX.
     *
     * The refusal on its own is correct and useless: "this is not that
     * property's cover" cannot tell a builder whether their brochure has no
     * photograph in it or is simply the wrong file. Measured on the live list,
     * it was the second — `Lot 1037 · Vanta 20` links a document whose cover
     * reads `NEX 20 — Lot 1307 Fuchsia Street`, a duplicate of the sibling
     * row's brochure. Quoting the cover turns an opaque refusal into an
     * obvious data error the person holding the sheet can correct in a minute.
     *
     * A QUOTE, NEVER A CONCLUSION. It reports what the first page reads and
     * draws no inference about which property the document belongs to —
     * asserting that would be a second identity judgement, made with less
     * evidence than the one that just declined.
     */
    const says = coverIdentityQuote(pageTexts[0]);
    return {
      status: 'not_identified',
      detail: 'That document does not present a page as this property\'s package cover, '
        + 'so it names no image for it.'
        + (says ? ` Its first page reads “${says}”.` : ''),
    };
  }

  const suffix = photo.provenance.method === 'page_crop'
    ? `crop(${photo.provenance.crop?.top}-${photo.provenance.crop?.bottom})`
    : photo.provenance.resourceName;
  return {
    status: 'recovered',
    image: {
      bytes: photo.bytes,
      contentType: photo.contentType,
      reference: `${documentName}#page${photo.provenance.page}:${suffix}`,
      documentName,
      documentUrl: url,
      provenance: photo.provenance,
      role: photo.role,
    },
  };
  });
}

/*
 * MOVED, NOT COPIED. The refusal composed in `pdfPrimaryImage.pure.ts` needs
 * the same quote — an UPLOADED package records its reason there and never
 * reaches this function at all — and two implementations of "what does the
 * cover say" is how two screens come to quote different things.
 */
export { coverIdentityQuote } from './pdfPrimaryImage.pure.ts';
