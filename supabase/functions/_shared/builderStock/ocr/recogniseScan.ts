/**
 * ===========================================================================
 * ORDINARY OCR. NOT A MODEL, AND NOT A SECOND READER.
 * ===========================================================================
 *
 * Tesseract, compiled to WebAssembly, reading pixels into characters. It is
 * document extraction and nothing else: what it produces is page text, which
 * goes to `normaliseUnits` and then to the same property readers and the same
 * typed validators as text a PDF stated itself.
 *
 * WHY NOT A GENERATIVE MODEL. A model asked to "read this brochure" does not
 * read it — it writes a plausible one, and the failure mode is a confident
 * property that does not exist. Recognition can misread a character and say so
 * in its confidence; it cannot invent a lot number. That difference is the
 * whole reason this exists, and it is why no model host is reachable from this
 * path.
 *
 * WHERE IT RUNS: IN THE ISOLATE THAT ASKS (`engine.ts`, `engineDriver.ts`).
 * `tesseract.js` runs the same engine in a worker it spawns, and the hosted
 * edge runtime will not construct one — measured in production on
 * 23 September 2026, the scanned-page pass logged `Not implemented:
 * Worker.prototype.constructor` and a fully scanned brochure was refused
 * `pdf_no_text_layer`. The figure reader had already moved for the same
 * reason. Same engine build, same model, same calls and the same parameters —
 * the library's own worker defaults and nothing else — so the same text:
 * fourteen scanned pages across six documents, recognised both ways, came
 * back byte-identical.
 *
 * WHAT IT COSTS, MEASURED under the Deno CLI on 1240x1754 scans: 250-620 ms
 * for a sparse page and 4.1-4.4 s for one dense with text. That is the whole
 * cost of the isolate that asks, which is why a stored document is never
 * recognised in the isolate that parsed it (`ocr/scanRaster.pure.ts`). The
 * ceilings below are what stop one enormous scan spending an invocation that
 * other properties are waiting for.
 */
import { MIN_PAGE_TEXT_CHARS } from './ocrPolicy.pure.ts';
import { languageDataDirectory } from './languageData.ts';
import { openInProcessRecogniser } from './engine.ts';

/**
 * The bounds, stated rather than discovered.
 *
 * `MAX_PAGES` — a stock list is not recognised page by page for ever; past
 * this the document is doing something other than describing one property.
 * `MAX_PIXELS` — a 300 DPI A4 scan is about 8.7 megapixels, and recognition
 * cost rises with area. A page above this is downscaled by the caller or left
 * unread and SAID to be unread; it is never silently truncated.
 * `MAX_MS` — the whole recognition pass, so a document cannot spend an
 * invocation that properties behind it are waiting for.
 */
export const OCR_MAX_PAGES = 8;
export const OCR_MAX_PIXELS = 12_000_000;
export const OCR_MAX_MS = 45_000;

/** A page this could not read, and why. Never silence. */
export interface OcrPageRefusal {
  page: number;
  reason: 'no_raster' | 'too_large' | 'out_of_time' | 'unreadable' | 'engine_unavailable';
}

/**
 * WHICH REFUSALS ARE FINAL, AND WHY THE DISTINCTION IS LOAD-BEARING.
 *
 * A checkpointed import asks these pages again in a fresh isolate, so it has
 * to know which refusals are statements about the PAGE and which are
 * statements about the ATTEMPT. `too_large`, `unreadable` and `no_raster`
 * describe the page and will say the same thing for ever — re-asking spends
 * three seconds to be told again. `out_of_time` and `engine_unavailable`
 * describe this invocation and this deployment, and treating either as final
 * would silently lose a readable page the moment the budget was tight.
 *
 * The caller's checkpoint settles only what this list names.
 */
export const FINAL_OCR_REFUSAL_REASONS: ReadonlyArray<OcrPageRefusal['reason']> =
  ['no_raster', 'too_large', 'unreadable'];

export const isFinalOcrRefusal = (refusal: OcrPageRefusal): boolean =>
  FINAL_OCR_REFUSAL_REASONS.includes(refusal.reason);

export interface OcrReading {
  /** 1-based page number to the text recognised on it. */
  text: Map<number, string>;
  refusals: OcrPageRefusal[];
  /**
   * Pages this invocation neither read NOR refused, because it ran out of the
   * CPU it may spend before reaching them.
   *
   * A THIRD STATE, AND IT HAS TO BE. A refusal is a statement about the PAGE —
   * too large, unreadable, no raster — and it is final: nobody asks again. A
   * deferral is a statement about this INVOCATION, and the whole point of it
   * is that somebody asks again, in a fresh isolate, with a fresh allowance.
   * Filing one as the other either loses a readable page for ever or asks the
   * recogniser for ever for a page it has already said it cannot read.
   */
  deferred: number[];
  /** Milliseconds spent, for the import log. */
  ms: number;
  /** False where the engine or its language data could not be obtained. */
  available: boolean;
}

/** What the caller hands over: one raster per page that needs reading. */
export interface OcrPageRaster {
  page: number;
  bytes: Uint8Array;
  /** Where known, so an oversized page is refused before it is decoded. */
  width?: number;
  height?: number;
}

/**
 * Recognise the pages handed over, in order, within one budget.
 *
 * NEVER THROWS. A document that cannot be recognised is a document with no
 * text, which is a state this pipeline already has an honest answer for — so
 * an engine that will not load, a language file that is not there and a page
 * that will not decode all come back as refusals with reasons, and the caller
 * keeps whatever the PDF itself stated.
 */
export async function recogniseScannedPages(
  rasters: readonly OcrPageRaster[],
  options: {
    deadlineAt?: number;
    /**
     * Asked BEFORE each page, and the answer stops the pass without refusing
     * anything. This is how a scanned document crosses isolates: recognition
     * is the one document-class stage measured to exceed any sane CPU budget
     * on its own (9,223 ms over three pages), and it is already page-wise, so
     * the only thing missing was somewhere to stop and somewhere to put what
     * had been read. Absent means "as far as the deadline allows", which is
     * exactly today's behaviour.
     */
    mayRecognise?: (() => boolean) | null;
    /**
     * Handed each page AS IT IS READ, so the successor does not pay for it
     * again. Awaited, because a checkpoint written after the worker is gone is
     * not a checkpoint. A throw here is swallowed: durability is an
     * optimisation and recognition is the deliverable.
     */
    onPage?: ((page: number, text: string) => Promise<void> | void) | null;
  } = {},
): Promise<OcrReading> {
  const startedAt = Date.now();
  const deadline = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY, startedAt + OCR_MAX_MS);
  const text = new Map<number, string>();
  const refusals: OcrPageRefusal[] = [];
  const deferred: number[] = [];

  const wanted = rasters.slice(0, OCR_MAX_PAGES);
  for (const extra of rasters.slice(OCR_MAX_PAGES)) {
    refusals.push({ page: extra.page, reason: 'out_of_time' });
  }
  if (!wanted.length) return { text, refusals, deferred, ms: 0, available: true };

  const langPath = await languageDataDirectory();
  if (!langPath) {
    for (const raster of wanted) {
      refusals.push({ page: raster.page, reason: 'engine_unavailable' });
    }
    return { text, refusals, deferred, ms: Date.now() - startedAt, available: false };
  }

  /*
   * THE ENGINE, IN THIS ISOLATE, WITH THE PARAMETERS A PAGE HAS ALWAYS BEEN
   * READ WITH: `engineDriver.ts` sets the library's own worker defaults and
   * this pass sets nothing over them, exactly as it set nothing over the
   * library's. A refusal is logged by the opener with the step that refused.
   */
  const opening = await openInProcessRecogniser(langPath);
  if (!opening.ok) {
    for (const raster of wanted) {
      refusals.push({ page: raster.page, reason: 'engine_unavailable' });
    }
    return { text, refusals, deferred, ms: Date.now() - startedAt, available: false };
  }
  const worker = opening.recogniser;

  try {
    for (const raster of wanted) {
      /*
       * THE HAND-OFF POINT. Asked before the page, so the page that would
       * exceed the allowance is the one that does not run — the rule
       * `importStock.ts` has stated since it was written. Every remaining
       * page is DEFERRED rather than refused, and they are enumerated rather
       * than the loop being broken, so the caller's checkpoint knows exactly
       * which pages a successor still owes.
       */
      if (options.mayRecognise && !options.mayRecognise()) {
        deferred.push(raster.page);
        continue;
      }
      if (Date.now() > deadline) {
        refusals.push({ page: raster.page, reason: 'out_of_time' });
        continue;
      }
      const pixels = Number(raster.width ?? 0) * Number(raster.height ?? 0);
      if (pixels > OCR_MAX_PIXELS) {
        refusals.push({ page: raster.page, reason: 'too_large' });
        continue;
      }
      if (!raster.bytes?.length) {
        refusals.push({ page: raster.page, reason: 'no_raster' });
        continue;
      }
      try {
        const { data } = await worker.recognize(raster.bytes);
        const read = String(data?.text ?? '').trim();
        /*
         * A READING THAT SAYS ALMOST NOTHING IS NOT A READING. The same floor
         * the policy uses to call a page blank: a handful of characters off a
         * photograph is noise, and passing it downstream would let the reader
         * attribute a property to marks on paper.
         */
        const printable = (read.match(/[\p{L}\p{N}]/gu) ?? []).length;
        if (printable < MIN_PAGE_TEXT_CHARS) {
          refusals.push({ page: raster.page, reason: 'unreadable' });
          continue;
        }
        text.set(raster.page, read);
        // DURABLE BEFORE THE NEXT PAGE IS ATTEMPTED. Three seconds of CPU is
        // what this line is protecting; a throw inside it costs that and
        // nothing else, so it is swallowed.
        try { await options.onPage?.(raster.page, read); } catch { /* see above */ }
      } catch {
        refusals.push({ page: raster.page, reason: 'unreadable' });
      }
    }
  } finally {
    try { await worker.terminate(); } catch { /* nothing to report */ }
  }

  return { text, refusals, deferred, ms: Date.now() - startedAt, available: true };
}

/**
 * ===========================================================================
 * A FIGURE, NOT A PAGE.
 * ===========================================================================
 *
 * The same engine and the same model, asked a narrower question: the text of
 * one small picture a brochure prints a table in — its area schedule
 * (`areaSchedulePicture.pure.ts`). Two settings differ from a page, and both
 * were measured on that picture rather than chosen: the picture is read as ONE
 * BLOCK of text (`psm 6`), because a table read as a page is laid out as
 * columns and its rows are lost, and the density is stated (300 dpi), because
 * the picture is handed over already enlarged to it (`figureRaster.pure.ts`).
 *
 * There is no character floor here. A page with forty characters on it is a
 * page with something to say; a figure is judged by what it says, and by the
 * arithmetic that must prove it, never by how much it says.
 *
 * THE ENGINE RUNS IN THIS ISOLATE (`engine.ts`), not in the worker
 * `tesseract.js` spawns. Measured in production on 23 September 2026, the
 * hosted runtime never started that worker, and the stored `Lot 101` brochure
 * the Deno CLI read as `124.50` answered `recognition_unavailable`. It is the
 * same engine build and the same model, driven by the same calls, so the text
 * is the text the figure reader's thresholds were measured on. The page pass
 * above runs on the same engine, for the same reason.
 *
 * NEVER THROWS, like the pass above: an engine that will not come up answers
 * `available: false`, logs why, and every figure goes unread.
 */
export interface FigureRecognition {
  /** Recognised text, by the caller's own figure index. */
  text: Map<number, string>;
  /** False where the engine or its model could not be obtained. */
  available: boolean;
  ms: number;
}

export async function recogniseFigures(
  figures: ReadonlyArray<{ index: number; png: Uint8Array }>,
  options: {
    deadlineAt?: number;
    /** The page segmentation mode. `6`, one block, is what was measured. */
    psm?: string;
  } = {},
): Promise<FigureRecognition> {
  const startedAt = Date.now();
  const text = new Map<number, string>();
  if (!figures.length) return { text, available: true, ms: 0 };
  const langPath = await languageDataDirectory();
  if (!langPath) return { text, available: false, ms: Date.now() - startedAt };
  const opening = await openInProcessRecogniser(langPath);
  if (!opening.ok) return { text, available: false, ms: Date.now() - startedAt };
  const worker = opening.recogniser;
  try {
    await worker.setParameters?.({ tessedit_pageseg_mode: options.psm ?? '6', user_defined_dpi: '300' });
    for (const figure of figures) {
      if (options.deadlineAt && Date.now() > options.deadlineAt) break;
      try {
        const { data } = await worker.recognize(figure.png);
        text.set(figure.index, String(data?.text ?? ''));
      } catch {
        /* an unreadable figure says nothing, and says it by being absent */
      }
    }
  } finally {
    try { await worker.terminate(); } catch { /* nothing to report */ }
  }
  return { text, available: true, ms: Date.now() - startedAt };
}
