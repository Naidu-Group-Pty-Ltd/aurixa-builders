/**
 * Builder stock — a PDF's prose, one string per VISIBLE page.
 *
 * ONE implementation, because two callers need the same page numbering and a
 * disagreement between them is invisible. `extract.ts` reads a directly
 * uploaded PDF's text to find its properties; `packageImages.ts` reads a linked
 * package's text to find the page that presents the property as a package. If
 * those two numbered pages differently, a brochure uploaded through the portal
 * and the same brochure reached through a Notion row's link would attach
 * different pictures to the same house.
 *
 * `mergePages: false` is not an option here, it is the point: the page is the
 * only structure a PDF offers, and the merged string throws it away.
 *
 * pdf.js takes OWNERSHIP of the array it is handed and leaves the buffer
 * detached, which is why it is given its own copy — reading the text used to
 * empty the very bytes the photographs are then read out of.
 *
 * A PAGE'S TEXT IS NOT ONLY ITS CONTENT STREAM. `getTextContent` reads what the
 * page DRAWS, and a brochure produced by filling a template draws its labels
 * and carries its values in AcroForm fields — so the reader returned "Land
 * Price Land Size House Price Total Size" and not one number, and returned the
 * estate name and the lot for no page at all. Three of six sampled Luxton
 * brochures are that shape, and every one of them reported as a document that
 * simply does not name its property: `pageStatesIdentity` cannot match a lot
 * the reader never handed it, so the cover was never designated, so the card
 * stayed blank in front of a document whose page 2 states the address, the
 * price, the land size, the build size and the bed/bath/car count in five
 * named fields.
 *
 * `fieldTextByPage` reads them, and it reads them as PAGE TEXT rather than as a
 * new kind of fact: the values are appended to the page that carries the
 * fields, and every rule downstream — identity, package facts, the lot
 * exclusion — runs exactly as it does on a page whose text was set. See that
 * function for the three rules that keep it honest.
 */

/**
 * The outcome of trying, which is NOT the same as the outcome of reading.
 *
 * This used to return `string[]` and an empty array on any failure, and that
 * one collapse cost 44 properties their photographs. The reader imports pdf.js
 * from a CDN at call time; when that import does not resolve in the edge
 * runtime the catch returned `[]`, the package path found no page it could read
 * as a property's cover, and answered `not_identified` — "we read the document
 * and it names no image for this property". It had read nothing at all.
 *
 * "This document has no text" and "we could not extract text from this
 * document" lead to opposite handling: the first is a finding a caller may act
 * on and record, the second is an operational fault that must be retried and
 * must never be written down as a verdict. So the caller is told which it got.
 */
export type PdfPageTextResult =
  | { ok: true; pages: string[] }
  | { ok: false; reason: string };

/**
 * The reader, loaded on demand. Its own function so the module's real types can
 * be inferred rather than restated — a hand-written signature here would be a
 * second opinion about a third-party API, and the narrower of the two wins.
 */
function loadPdfReader() {
  return import('https://esm.sh/unpdf@0.12.1');
}

/**
 * The value of every field a person can SEE on each page, page by page.
 *
 * Three rules keep this from inventing text a document does not show.
 *
 * ONLY WHAT IS DISPLAYED. A widget marked hidden or no-view is skipped: a
 * template's working fields are exactly the ones a reader never sees, and text
 * nobody is shown must not be able to identify a property. `subtype` must be
 * `Widget`, so a comment, a stamp or a note somebody left on the file is not
 * page text either — an annotation is a reader's remark about a document,
 * never the document's own statement.
 *
 * ONLY THE VALUE, NEVER THE NAME. "Land Price" is the template author's label
 * for a box and it is already drawn on the page by the content stream; adding
 * it again would be this reader writing words into a document. What is missing
 * is `$405,100`, and that is all that is added.
 *
 * AND IT CAN NEVER FAIL THE READ. A document with no AcroForm, a reader build
 * with no annotation support, one page that throws — each yields no values for
 * the pages affected and leaves every other page exactly as extracted. The
 * text of a PDF is not worth losing over the fields of one.
 *
 * Exported for its tests alone: it takes the reader's page proxy structurally,
 * so the three rules above are provable against a stand-in without a network
 * fetch of pdf.js and without a fixture PDF for every shape of field.
 */
export async function fieldTextByPage(
  pdf: { numPages?: number; getPage(index: number): Promise<unknown> },
  pageCount: number,
): Promise<string[][]> {
  const out: string[][] = Array.from({ length: pageCount }, () => []);
  for (let index = 0; index < pageCount; index++) {
    try {
      const page = await pdf.getPage(index + 1) as {
        getAnnotations?: () => Promise<unknown[]>;
      };
      if (typeof page?.getAnnotations !== 'function') return out;
      const annotations = await page.getAnnotations();
      if (!Array.isArray(annotations)) continue;
      const seen = new Set<string>();
      for (const raw of annotations) {
        const annotation = raw as {
          subtype?: unknown; hidden?: unknown; noView?: unknown; fieldValue?: unknown;
        };
        if (String(annotation?.subtype ?? '') !== 'Widget') continue;
        if (annotation?.hidden === true || annotation?.noView === true) continue;
        /*
         * A multi-select field answers with an array; a text field with a
         * string. Anything else — a number, an object, a null — is not text a
         * page displays and is left alone rather than stringified.
         */
        const values = Array.isArray(annotation?.fieldValue)
          ? annotation.fieldValue
          : [annotation?.fieldValue];
        for (const value of values) {
          if (typeof value !== 'string') continue;
          const text = value.trim();
          // One page can carry the same value in two fields; the page shows it
          // twice and reads the same either way, so it is stated once.
          if (!text || seen.has(text)) continue;
          seen.add(text);
          out[index].push(text);
        }
      }
    } catch {
      /* this page contributes no field text; every other page is unaffected */
    }
  }
  return out;
}

/** Read every visible page's text, and say plainly if that could not be done. */
export async function readPdfPageTextResult(bytes: Uint8Array): Promise<PdfPageTextResult> {
  let reader: Awaited<ReturnType<typeof loadPdfReader>>;
  try {
    reader = await loadPdfReader();
  } catch (error) {
    // The reader itself is not here. Nothing has been learned about the PDF.
    return {
      ok: false,
      reason: `pdf text reader unavailable: ${String(
        (error as { message?: string })?.message ?? error).slice(0, 160)}`,
    };
  }

  try {
    const pdf = await reader.getDocumentProxy(bytes.slice());
    const { text } = await reader.extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [String(text ?? '')])
      .map((page) => String(page ?? ''));
    /*
     * Zero pages is not a document with nothing to say — a PDF always has
     * pages — so it is the reader failing quietly rather than the document
     * being empty. A scanned brochure with no text layer lands here too, and
     * "we cannot read this" is the honest answer for it as well.
     */
    if (!pages.length) return { ok: false, reason: 'pdf text reader returned no pages' };
    /*
     * The fields, APPENDED. A document with none is unchanged byte for byte,
     * which is why this is safe to run on every PDF: the overwhelming majority
     * carry no AcroForm at all and land back here with the same strings they
     * arrived with.
     */
    const fields = await fieldTextByPage(pdf, pages.length);
    return {
      ok: true,
      pages: pages.map((page, index) => {
        const values = fields[index];
        return values && values.length ? `${page}\n${values.join('\n')}` : page;
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `pdf text extraction failed: ${String(
        (error as { message?: string })?.message ?? error).slice(0, 160)}`,
    };
  }
}

/**
 * The text of each page, or an empty array.
 *
 * Kept for `extract.ts`, which already treats an empty result as a hard error
 * and raises `pdf_text_extraction_failed` — so the distinction above is one it
 * has always made for itself.
 */
export async function readPdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const result = await readPdfPageTextResult(bytes);
  return result.ok ? result.pages : [];
}
