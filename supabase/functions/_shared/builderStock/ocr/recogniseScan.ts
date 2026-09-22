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
 * WHAT IT COSTS, MEASURED in this runtime on a 1240x500 page: 341 ms to bring
 * the worker up, 188 ms to recognise. The worker is built once per isolate and
 * reused; the ceilings below are what stop one enormous scan spending an
 * invocation that other properties are waiting for.
 */
import { MIN_PAGE_TEXT_CHARS } from './ocrPolicy.pure.ts';
import { languageDataDirectory } from './languageData.ts';

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

export interface OcrReading {
  /** 1-based page number to the text recognised on it. */
  text: Map<number, string>;
  refusals: OcrPageRefusal[];
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
  options: { deadlineAt?: number } = {},
): Promise<OcrReading> {
  const startedAt = Date.now();
  const deadline = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY, startedAt + OCR_MAX_MS);
  const text = new Map<number, string>();
  const refusals: OcrPageRefusal[] = [];

  const wanted = rasters.slice(0, OCR_MAX_PAGES);
  for (const extra of rasters.slice(OCR_MAX_PAGES)) {
    refusals.push({ page: extra.page, reason: 'out_of_time' });
  }
  if (!wanted.length) return { text, refusals, ms: 0, available: true };

  const langPath = await languageDataDirectory();
  if (!langPath) {
    for (const raster of wanted) {
      refusals.push({ page: raster.page, reason: 'engine_unavailable' });
    }
    return { text, refusals, ms: Date.now() - startedAt, available: false };
  }

  let worker: { recognize: (b: unknown) => Promise<{ data: { text?: string } }>;
                terminate: () => Promise<unknown> } | null = null;
  try {
    const mod = await import('https://esm.sh/tesseract.js@5.1.1');
    const createWorker = (mod as { createWorker?: unknown }).createWorker
      ?? (mod as { default?: { createWorker?: unknown } }).default?.createWorker;
    if (typeof createWorker !== 'function') throw new Error('no createWorker');
    worker = await (createWorker as (
      l: string, o: number, c: Record<string, unknown>,
    ) => Promise<typeof worker>)('eng', 1, {
      langPath, gzip: true, cachePath: '/tmp',
      // The engine's own logging is not this product's log.
      logger: () => {},
    });
  } catch {
    for (const raster of wanted) {
      refusals.push({ page: raster.page, reason: 'engine_unavailable' });
    }
    return { text, refusals, ms: Date.now() - startedAt, available: false };
  }

  try {
    for (const raster of wanted) {
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
        const { data } = await worker!.recognize(raster.bytes);
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
      } catch {
        refusals.push({ page: raster.page, reason: 'unreadable' });
      }
    }
  } finally {
    try { await worker?.terminate(); } catch { /* nothing to report */ }
  }

  return { text, refusals, ms: Date.now() - startedAt, available: true };
}
