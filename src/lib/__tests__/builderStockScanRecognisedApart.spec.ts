/**
 * A SCANNED PAGE IS LOCATED WHERE ITS DOCUMENT IS PARSED, AND RECOGNISED
 * WHERE NOTHING IS.
 *
 * Measured in production on 23 September 2026 (`production-rollout` run
 * 35877700148): the scanned-page pass logged `ocr engine unavailable …
 * "Not implemented: Worker.prototype.constructor"` and a fully scanned
 * brochure was refused `pdf_no_text_layer`, because `tesseract.js` runs its
 * engine in a worker the hosted runtime will not construct. The engine now runs
 * in the isolate that asks — so that isolate must never be the one that parsed
 * the PDF. This file pins the three things that make that safe:
 *
 *   • the picture a recognition isolate makes from a recorded location is,
 *     byte for byte, the picture the single pass made — both halves of one
 *     function, on a real scan and on a flattened page;
 *   • the checkpoint carries the locations, and never lets a page be
 *     recognised twice, even across a worker that died mid-page;
 *   • the engine reads the fixture's pages to exactly the text the old library
 *     produced, with every worker refused.
 *
 * The scan is the held-out fixture the isolated production proof imports
 * (`scripts/ops/fixtures/scanned-brochure-lot-57.pdf`). It carries no
 * customer's document.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  extractPdfPagePhoto, extractPdfPhotosByPage, locatePdfPagePhoto, locatePdfPhotosByPage,
  photoAtLocation, recordedScanRaster, recoverCompressedObjects,
} from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';
import {
  readScanRasterLocation, type ScanRasterLocation,
} from '../../../supabase/functions/_shared/builderStock/ocr/scanRaster.pure';
import {
  MAX_IMPORT_CONTINUATIONS, checkpointPages, checkpointSettledPages, freshAttempt,
  lostRecognitions, mayContinue, openCheckpoint, readCheckpoint, scanRastersOwed,
  withContinuation, withRecognisedPage, withRecognitionBegun, withRecognitionEnded,
  withRecognitionLost, withRecogniserUnavailable, withRefusedPage, withScanRasters,
} from '../../../supabase/functions/_shared/builderStock/importCheckpoint.pure';
import { startEngine } from '../../../supabase/functions/_shared/builderStock/ocr/engineDriver';

const repo = (path: string) => resolve(process.cwd(), path);
const bytesOf = (path: string) => new Uint8Array(readFileSync(repo(path)));
const textOf = (path: string) => readFileSync(repo(path), 'utf8');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const SCAN = 'scripts/ops/fixtures/scanned-brochure-lot-57.pdf';
const SHARED = 'supabase/functions/_shared/builderStock/';
const OCR_MAX_PAGES = 8;

/**
 * A one-page PDF whose page IS one raw RGB raster: flat paper above and below
 * a band of photographic pixels. The single pass cuts the band out of it
 * (`page_crop`), which is the second path a located page can take.
 */
function flattenedPagePdf(): Uint8Array {
  const width = 240;
  const height = 320;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let y = 100; y < 220; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      pixels[at] = (x * 7 + y * 3) & 255;
      pixels[at + 1] = (x * 3 + y * 11) & 255;
      pixels[at + 2] = (x * 13 + y * 5) & 255;
    }
  }
  const image = deflateSync(pixels);
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  const parts: Array<string | Uint8Array> = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === 'string' ? Buffer.byteLength(part, 'latin1') : part.length;
  };
  const object = (body: string) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`);
  };
  push('%PDF-1.4\n');
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
    + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
  object(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  offsets.push(length);
  push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`);
  push(new Uint8Array(image));
  push('\nendstream\nendobj\n');
  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    const chunk = typeof part === 'string' ? new Uint8Array(Buffer.from(part, 'latin1')) : part;
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A location as the checkpoint carries it: recorded, stored as JSON, read back. */
async function throughTheCheckpoint(
  bytes: Uint8Array, location: ScanRasterLocation,
): Promise<ScanRasterLocation> {
  const stored = JSON.parse(JSON.stringify(await recordedScanRaster(bytes, location)));
  const read = readScanRasterLocation(stored);
  expect(read).not.toBeNull();
  return read!;
}

describe('the picture a recognition isolate makes is the picture one pass made', () => {
  it('on every page of a real scan, from the stream alone', async () => {
    const bytes = bytesOf(SCAN);
    const { objects: recovered } = await recoverCompressedObjects(bytes);
    for (const index of [0, 1, 2]) {
      const direct = await extractPdfPagePhoto(bytes, index, recovered);
      expect(direct, `page ${index + 1}`).not.toBeNull();
      const location = await locatePdfPagePhoto(bytes, index, recovered);
      expect(location?.page).toBe(index + 1);
      const made = await photoAtLocation(bytes, await throughTheCheckpoint(bytes, location!));
      expect(made?.provenance.method).toBe('embedded_raster');
      expect(sha256(made!.bytes)).toBe(sha256(direct!.bytes));
      expect(made!.provenance).toEqual(direct!.provenance);
      expect(made!.contentType).toBe(direct!.contentType);
    }
  });

  it('on a flattened page, whose photograph is cut out of the builder\'s pixels', async () => {
    const bytes = flattenedPagePdf();
    const direct = await extractPdfPagePhoto(bytes, 0);
    expect(direct?.provenance.method).toBe('page_crop');
    const location = await locatePdfPagePhoto(bytes, 0);
    expect(location?.embedded).toBeNull();
    expect(location?.flattened).not.toBeNull();
    const made = await photoAtLocation(bytes, await throughTheCheckpoint(bytes, location!));
    expect(sha256(made!.bytes)).toBe(sha256(direct!.bytes));
    expect(made!.provenance).toEqual(direct!.provenance);
  });

  it('locates the pages the single pass rasterised, and no others', async () => {
    const bytes = bytesOf(SCAN);
    const options = { maxPages: OCR_MAX_PAGES, pages: [1, 3] };
    const located = await locatePdfPhotosByPage(bytes, options);
    const rasterised = await extractPdfPhotosByPage(bytes, options);
    expect(located.map((location) => location.page)).toEqual(rasterised.map((entry) => entry.page));
    expect(located.map((location) => location.page)).toEqual([1, 3]);
  });

  it('a recorded stream that is not in these bytes makes nothing — not the other path either', async () => {
    const bytes = bytesOf(SCAN);
    const location = await throughTheCheckpoint(bytes, (await locatePdfPagePhoto(bytes, 0))!);
    const wrongDigest = { ...location, embedded: { ...location.embedded!, sha256: '0'.repeat(64) } };
    expect(await photoAtLocation(bytes, wrongDigest)).toBeNull();
    const changed = bytes.slice();
    changed[location.embedded!.start + 10] ^= 0xff;
    expect(await photoAtLocation(changed, location)).toBeNull();
  });
});

describe('a stored location is read on its own terms, and dropped rather than repaired', () => {
  const good = {
    page: 2,
    embedded: {
      start: 10, end: 20, flate: false, width: 4, height: 4, objectNumber: 7,
      resourceName: 'Im0', pageAreaShare: 0.97, sha256: 'a'.repeat(64),
    },
    flattened: null,
  };

  it('keeps an exact location', () => {
    expect(readScanRasterLocation(good)).toEqual(good);
  });

  it('refuses anything a slice or a decode could not trust', () => {
    expect(readScanRasterLocation({ ...good, page: 0 })).toBeNull();
    expect(readScanRasterLocation({ ...good, embedded: { ...good.embedded, sha256: undefined } })).toBeNull();
    expect(readScanRasterLocation({ ...good, embedded: { ...good.embedded, end: 10 } })).toBeNull();
    expect(readScanRasterLocation({ ...good, embedded: { ...good.embedded, start: -1 } })).toBeNull();
    expect(readScanRasterLocation({ ...good, embedded: { ...good.embedded, flate: 'no' } })).toBeNull();
    // A path that was stored and does not read is not a location with one path fewer.
    expect(readScanRasterLocation({ ...good, flattened: { start: 1 } })).toBeNull();
    expect(readScanRasterLocation({ ...good, embedded: null })).toBeNull();
    expect(readScanRasterLocation('page 2')).toBeNull();
  });
});

describe('the checkpoint carries the locations and never lets a page be read twice', () => {
  const SHA = 'c'.repeat(64);
  const at = (page: number): ScanRasterLocation => ({
    page,
    embedded: {
      start: page * 100, end: page * 100 + 50, flate: false, width: 10, height: 10,
      objectNumber: page, resourceName: `Im${page}`, pageAreaShare: 1, sha256: 'd'.repeat(64),
    },
    flattened: null,
  });

  it('survives the row, and owes exactly the located pages nobody has settled', () => {
    let checkpoint = withScanRasters(openCheckpoint(SHA), [at(3), at(1), at(2)]);
    checkpoint = withRecognisedPage(checkpoint, 1, 'page one');
    checkpoint = withRefusedPage(checkpoint, 3);
    const back = readCheckpoint(JSON.parse(JSON.stringify(checkpoint)), SHA)!;
    expect(scanRastersOwed(back).map((location) => location.page)).toEqual([2]);
    expect(back.ocr?.rasters?.['2']).toEqual(at(2));
    // A location for another document never survives: the checkpoint is its.
    expect(readCheckpoint(JSON.parse(JSON.stringify(checkpoint)), 'e'.repeat(64))).toBeNull();
  });

  it('a page begun and never reported is lost, and a page reported is not', () => {
    let checkpoint = withRecognitionBegun(withScanRasters(openCheckpoint(SHA), [at(1), at(2)]), [2]);
    expect(lostRecognitions(checkpoint)).toEqual([2]);
    expect(lostRecognitions(withRecognisedPage(checkpoint, 2, 'two'))).toEqual([]);
    expect(lostRecognitions(withRefusedPage(checkpoint, 2))).toEqual([]);
    // The pass that ends normally leaves nothing to be mistaken for a loss.
    checkpoint = withRecognitionEnded(checkpoint);
    expect(checkpoint.ocr?.begun).toBeUndefined();
    expect(lostRecognitions(checkpoint)).toEqual([]);
  });

  it('a lost page is settled and ends recognition for the attempt', () => {
    let checkpoint = withRecognitionBegun(withScanRasters(openCheckpoint(SHA), [at(1), at(2), at(3)]), [2]);
    checkpoint = withRecognitionLost(checkpoint, lostRecognitions(checkpoint));
    expect(checkpoint.ocr?.lost).toEqual([2]);
    expect(checkpoint.ocr?.begun).toBeUndefined();
    expect(checkpointSettledPages(checkpoint).has(2)).toBe(true);
    expect(mayContinue(checkpoint)).toBe(false);
    const back = readCheckpoint(JSON.parse(JSON.stringify(checkpoint)), SHA)!;
    expect(back.ocr?.lost).toEqual([2]);
    expect(mayContinue(back)).toBe(false);
  });

  it('a fresh attempt keeps what is true of the page and forgets what was true of an attempt', () => {
    let checkpoint = withScanRasters(openCheckpoint(SHA), [at(1), at(2), at(3)]);
    checkpoint = withRecognisedPage(checkpoint, 1, 'page one');
    checkpoint = withRefusedPage(checkpoint, 3);
    checkpoint = withRecognitionLost(withRecognitionBegun(checkpoint, [2]), [2]);
    checkpoint = withRecogniserUnavailable(withContinuation(checkpoint));
    const fresh = freshAttempt(checkpoint);
    expect(checkpointPages(fresh).get(1)).toBe('page one');
    expect(fresh.ocr?.refused).toEqual([3]);
    expect(fresh.ocr?.rasters).toBeUndefined();
    expect(fresh.ocr?.begun).toBeUndefined();
    expect(fresh.ocr?.lost).toBeUndefined();
    expect(fresh.ocr?.unavailable).toBe(false);
    expect(fresh.continuations).toBe(0);
    expect(mayContinue(fresh)).toBe(true);
  });

  it('the worst scan the recogniser accepts fits inside the crossing bound', () => {
    // One crossing out of the isolate that located the pages, one out of each
    // isolate that recognised one.
    expect(1 + OCR_MAX_PAGES).toBeLessThanOrEqual(MAX_IMPORT_CONTINUATIONS);
    expect(textOf(`${SHARED}ocr/recogniseScan.ts`)).toContain(`export const OCR_MAX_PAGES = ${OCR_MAX_PAGES};`);
  });
});

describe('the engine reads a scanned page exactly as the old library did, with no worker', () => {
  const realWorker = (globalThis as { Worker?: unknown }).Worker;
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
  });

  /*
   * What `tesseract.js` 5.1.1 — the engine this pass ran before, in its
   * worker, as `openRecogniser` built it — produced for each page of the
   * fixture, recorded under the Deno CLI where that worker starts.
   */
  const OLD_ENGINE_TEXT: Record<number, string> = {
    1: 'LOT 57 - ASTER 22\n57 Heathland Avenue\nTarneit VIC 3029\n\nPackage Price $689,000\n',
    2: 'ASTER 22 - SPECIFICATIONS\n4 bed 2 bath 2 car\nLand 392m2 Build 207m2\n',
    3: 'STANDARD INCLUSIONS\n2590mm ceilings throughout\n\nStone benchtops to the kitchen\n'
      + 'Prices and inclusions subject to change\n',
  };

  it('byte for byte, on every page, from the picture a recognition isolate makes', async () => {
    let workersRequested = 0;
    (globalThis as { Worker?: unknown }).Worker = class {
      constructor() {
        workersRequested += 1;
        throw new Error('Not implemented: Worker.prototype.constructor');
      }
    };
    const bytes = bytesOf(SCAN);
    const started = await startEngine({
      wasmBinary: bytesOf('assets/ocr/tesseract-core-simd-lstm.wasm'),
      model: bytesOf('assets/ocr/eng.traineddata.gz'),
    });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    try {
      // The page pass sets NO parameter over the engine's worker defaults.
      for (const location of await locatePdfPhotosByPage(bytes, { maxPages: OCR_MAX_PAGES })) {
        const picture = await photoAtLocation(bytes, await throughTheCheckpoint(bytes, location));
        const { data } = await started.recogniser.recognize(picture!.bytes);
        expect(data.text, `page ${location.page}`).toBe(OLD_ENGINE_TEXT[location.page]);
      }
    } finally {
      await started.recogniser.terminate();
    }
    expect(workersRequested).toBe(0);
  }, 120_000);
});

describe('the wiring: recognised apart, never beside a parse, never by a worker', () => {
  const recogniseScan = textOf(`${SHARED}ocr/recogniseScan.ts`);
  const runImport = textOf(`${SHARED}runImport.ts`);
  const extract = textOf(`${SHARED}extract.ts`);

  it('the page pass opens the in-process engine and sets nothing over its defaults', () => {
    const pass = recogniseScan.slice(
      recogniseScan.indexOf('export async function recogniseScannedPages('),
      recogniseScan.indexOf('export interface FigureRecognition'));
    expect(pass).toContain('openInProcessRecogniser(langPath)');
    expect(pass).not.toContain('setParameters');
    expect(recogniseScan).not.toContain('openRecogniser(');
  });

  it('no product module imports a worker-based engine or starts a worker', () => {
    const files = [
      'ocr/recogniseScan.ts', 'ocr/engine.ts', 'ocr/engineDriver.ts', 'ocr/languageData.ts',
      'ocr/scanRaster.pure.ts', 'extract.ts', 'runImport.ts', 'pdfSourcePhoto.ts',
      'readFigures.ts', 'repairSourceImages.ts', 'continueImport.ts',
    ];
    for (const file of files) {
      expect(withoutComments(textOf(`${SHARED}${file}`)), file)
        .not.toMatch(/tesseract\.js@|npm:tesseract|worker_threads|new Worker\(/);
    }
  });

  it('a stored document is never recognised where it was parsed', () => {
    expect(runImport).toContain("const ocrMode: 'inline' | 'handoff' | 'carried' = !input.resumableFromStoredBytes\n"
      + "    ? 'inline'\n"
      + "    : (mayContinue(checkpoint) && !recognitionUnrecordable ? 'handoff' : 'carried');");
    // The fallback, where the locations cannot be written down, reads without
    // them — and puts back the checkpoint that named them, so no later write
    // carries locations nobody will recognise.
    const fallback = runImport.slice(runImport.indexOf("owed pages could not be recorded; reading without them"));
    expect(fallback.indexOf('checkpoint = beforeHandOff;'))
      .toBeLessThan(fallback.indexOf("extraction = await extractAs('carried');"));
    expect(runImport).not.toContain("extractAs('inline')");
  });

  it('recognition never resumes once the document has been read', () => {
    // A picture hand-off is written by the isolate that read the document.
    expect(runImport).toContain(
      'if (input.resumed && input.resumableFromStoredBytes && !pictureHandover(checkpoint)) {');
    expect(runImport.indexOf('!pictureHandover(checkpoint)) {'))
      .toBeLessThan(runImport.indexOf('const owed = scanRastersOwed(checkpoint);'));
  });

  it('the isolate that recognises hands on and reads nothing', () => {
    const branch = runImport.slice(
      runImport.indexOf('if (input.resumed && input.resumableFromStoredBytes && !pictureHandover(checkpoint)) {\n'
        + '    const lost'),
      runImport.indexOf('THE SUCCESSOR OF A PICTURE HAND-OFF READS NOTHING'));
    expect(branch.length).toBeGreaterThan(0);
    // The mark is written, and must be, before the engine is asked.
    expect(branch.indexOf('withRecognitionBegun(')).toBeLessThan(branch.indexOf('recogniseScannedPages('));
    expect(branch.indexOf('if (await commitCheckpoint()) {'))
      .toBeLessThan(branch.indexOf('recogniseScannedPages('));
    // A picture made from its recorded stream, never a page read to find it.
    expect(branch).toContain('photoAtLocation(bytes, location)');
    expect(branch).not.toMatch(/extractStockFile\(|extractAs\(|locatePdf|readPdfPage|recoverCompressedObjects/);
    expect(branch).toContain("reason: 'ocr_outstanding',");
  });

  it('the isolate that locates returns before the reading, and before the refusal of an empty text', () => {
    const handoff = extract.indexOf("if (mode === 'handoff') {");
    const hand = extract.indexOf('return result;', handoff);
    expect(handoff).toBeGreaterThan(-1);
    expect(hand).toBeLessThan(extract.indexOf("'pdf_no_text_layer'", handoff));
    expect(extract.slice(handoff, hand)).not.toContain('recogniseScannedPages(');
    expect(extract.slice(handoff, hand)).not.toContain('extractPdfPhotosByPage(');
  });

  it('the image settler reads what the import recognised and never recognises', () => {
    const repair = textOf(`${SHARED}repairSourceImages.ts`);
    expect(repair).toContain("ocrMode: 'carried',");
    expect(repair).toContain('readCheckpoint(upload.import_checkpoint, await sha256Hex(bytes))');
  });
});
