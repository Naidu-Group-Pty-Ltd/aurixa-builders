/**
 * THE FIGURE READER'S ENGINE STARTS IN THE PROCESS THAT ASKS — PROVED BY
 * STARTING IT, NOT BY READING THE CODE THAT SAYS SO.
 *
 * Measured in production on 23 September 2026: the figure stage answered
 * `recognition_unavailable` over the stored `Lot 101` brochure, which the same
 * code read as `124.50` in CI. Every gate had passed, because every gate ran
 * the engine through `tesseract.js`, which starts a worker, under a runtime
 * that could start one. So this spec runs the REAL engine — the vendored
 * loader and the pinned WebAssembly the deploy ships — in this process, with
 * workers refused, over a real prepared picture, and holds the pins that decide
 * which engine that is to each other.
 *
 * The picture is synthetic: the held-out fixture's area schedule
 * (`make-corpus.py`, `area_schedule_picture`), as the product prepares it for
 * recognition (`figureRaster.pure.ts`, `encodePng`). It carries no customer's
 * document.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  engineBytesAreExpected, hexDigest, OCR_ENGINE_BYTES, OCR_ENGINE_KEY, OCR_ENGINE_SHA256,
} from '../../../supabase/functions/_shared/builderStock/ocr/engineSource.pure';
import {
  OCR_LANGUAGE_BYTES, OCR_LANGUAGE_KEY, OCR_LANGUAGE_SHA256,
} from '../../../supabase/functions/_shared/builderStock/ocr/languageSource.pure';
import { startEngine } from '../../../supabase/functions/_shared/builderStock/ocr/engineDriver';
import { readPictureSchedule } from '../../../supabase/functions/_shared/builderStock/areaSchedulePicture.pure';

const repo = (path: string) => resolve(process.cwd(), path);
const bytesOf = (path: string) => new Uint8Array(readFileSync(repo(path)));
const textOf = (path: string) => readFileSync(repo(path), 'utf8');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const ENGINE = 'assets/ocr/tesseract-core-simd-lstm.wasm';
const MODEL = 'assets/ocr/eng.traineddata.gz';
const LOADER = 'supabase/functions/_shared/builderStock/ocr/tesseractCore.generated.js';
const PICTURE = 'src/lib/__tests__/fixtures/area-schedule-inset.png';

describe('the engine this product runs is one pinned artefact, everywhere it is named', () => {
  it('the file in the repository is the engine the functions will accept', () => {
    const engine = bytesOf(ENGINE);
    expect(engine.length).toBe(OCR_ENGINE_BYTES);
    expect(sha256(engine)).toBe(OCR_ENGINE_SHA256);
    expect(engineBytesAreExpected(engine, sha256(engine))).toBe(true);
  });

  it('a changed byte or a short download is refused, never run', () => {
    const engine = bytesOf(ENGINE);
    const changed = engine.slice();
    changed[1000] ^= 0xff;
    expect(engineBytesAreExpected(changed, sha256(changed))).toBe(false);
    const short = engine.slice(0, engine.length - 1);
    expect(engineBytesAreExpected(short, sha256(short))).toBe(false);
    expect(engineBytesAreExpected(null, OCR_ENGINE_SHA256)).toBe(false);
  });

  it('spells a digest the way the pin is written', () => {
    expect(hexDigest(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
  });

  it('the deploy ships the same two objects, under the same keys, with the same pins', () => {
    const script = textOf('scripts/ops/upload-ocr-language.mjs');
    const pinned = (bytes: number) => bytes.toLocaleString('en-US').replace(/,/g, '_');
    for (const [key, bytes, digest] of [
      [OCR_ENGINE_KEY, OCR_ENGINE_BYTES, OCR_ENGINE_SHA256],
      [OCR_LANGUAGE_KEY, OCR_LANGUAGE_BYTES, OCR_LANGUAGE_SHA256],
    ] as const) {
      expect(script).toContain(`key: '${key}'`);
      expect(script).toContain(`bytes: ${pinned(bytes)}`);
      expect(script).toContain(`sha256: '${digest}'`);
    }
    expect(sha256(bytesOf(MODEL))).toBe(OCR_LANGUAGE_SHA256);
  });

  it('the acceptance stack serves the engine from the key the functions fetch', () => {
    const run = textOf('scripts/stock-acceptance/run.sh');
    const [directory, file] = [OCR_ENGINE_KEY.slice(0, OCR_ENGINE_KEY.lastIndexOf('/')), OCR_ENGINE_KEY.split('/').pop()];
    expect(run).toContain(`acceptance-storage/builder-stock-lists/${directory}`);
    expect(run).toContain(`cp ${ENGINE} "$ENGINE_OBJ/${file}"`);
  });
});

describe('the loader is the package\'s, changed in exactly the two ways it says', () => {
  const loader = textOf(LOADER);

  it('takes no host branch, so it reads no file and needs no Node', () => {
    expect(loader.split('fa=!1,ha=!1,ia=!1').length - 1).toBe(1);
    expect(loader).not.toContain('"string"==typeof process.versions.node');
    expect(loader).not.toContain('"object"==typeof window,');
  });

  it('exports its factory to an ES module and nowhere else, and starts no worker of any kind', () => {
    expect(loader.trimEnd().endsWith('export default TesseractCore;')).toBe(true);
    expect(loader).not.toMatch(/module\.exports|define\(\[\]|exports\["TesseractCore"\]/);
    expect(loader).not.toMatch(/new Worker\(|worker_threads|importScripts\(/);
  });
});

describe('the engine, started in this process', () => {
  const realWorker = (globalThis as { Worker?: unknown }).Worker;
  let workersRequested = 0;

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
  });

  const refuseWorkers = () => {
    workersRequested = 0;
    (globalThis as { Worker?: unknown }).Worker = class {
      constructor() {
        workersRequested += 1;
        throw new Error('a worker was requested');
      }
    };
  };

  it('reads the held-out area schedule, and the schedule reader proves its total', async () => {
    refuseWorkers();
    const started = await startEngine({ wasmBinary: bytesOf(ENGINE), model: bytesOf(MODEL) });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    try {
      await started.recogniser.setParameters({ tessedit_pageseg_mode: '6', user_defined_dpi: '300' });
      const { data } = await started.recogniser.recognize(bytesOf(PICTURE));
      expect(data.text).toMatch(/TOTAL/);
      const schedule = readPictureSchedule(data.text);
      expect(schedule.reading?.value).toBe('129.59');
      expect(schedule.reading?.provedBy).toContain('squares');
    } finally {
      await started.recogniser.terminate();
    }
    expect(workersRequested).toBe(0);
    await expect(started.recogniser.recognize(bytesOf(PICTURE))).rejects.toThrow(/released/);
  }, 60_000);

  it('answers a wrong engine with a named refusal, and throws nothing', async () => {
    const garbage = new Uint8Array(4096).map((_, index) => (index * 31) & 0xff);
    const started = await startEngine({ wasmBinary: garbage, model: bytesOf(MODEL) });
    expect(started).toMatchObject({ ok: false, refusal: 'engine_start_failed' });
  }, 60_000);
});

describe('the figure reader asks this engine, and nothing that starts a worker', () => {
  const OCR = 'supabase/functions/_shared/builderStock/ocr/';

  it('recognises figures with the in-process engine, never the worker opener', () => {
    const source = textOf(`${OCR}recogniseScan.ts`);
    const figures = source.slice(source.indexOf('export async function recogniseFigures('));
    expect(figures.length).toBeGreaterThan(0);
    expect(figures).toContain('openInProcessRecogniser(langPath)');
    expect(figures).not.toContain('openRecogniser(');
  });

  it('the engine modules import no worker-based library and start no worker', () => {
    for (const file of ['engine.ts', 'engineDriver.ts', 'engineSource.pure.ts']) {
      const source = textOf(`${OCR}${file}`)
        // What a comment says about the library is not an import of it.
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/tesseract\.js@|npm:tesseract|worker_threads|new Worker\(/);
    }
  });

  it('every refusal the engine can give is logged with its reason', () => {
    const source = textOf(`${OCR}engine.ts`);
    expect(source).toMatch(/console\.warn\('\[builderStock\] ocr engine unavailable', \{\s*phase: 'ocr_engine', reason: opening\.unavailable, detail: opening\.detail,/);
  });

  it('the reading trace provides the engine it will check, beside the model', () => {
    const trace = textOf('scripts/ops/stockFigureTrace.ts');
    expect(trace).toContain("['/tmp/ocr-engine', 'tesseract-core-simd-lstm.wasm']");
    expect(textOf(`${OCR}engine.ts`)).toContain("'/tmp/ocr-engine/tesseract-core-simd-lstm.wasm'");
  });
});
