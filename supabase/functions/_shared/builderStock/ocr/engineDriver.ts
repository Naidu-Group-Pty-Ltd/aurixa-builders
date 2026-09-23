/**
 * ===========================================================================
 * TESSERACT, DRIVEN IN THE ISOLATE THAT ASKS.
 * ===========================================================================
 *
 * The engine is one WebAssembly module and the loader that drives it
 * (`tesseractCore.generated.js`, vendored from `tesseract.js-core@5.1.1` by
 * `scripts/ocr/vendor-engine.mjs`). `tesseract.js` runs exactly these calls,
 * but inside a worker it spawns for the purpose — and measured in production
 * on 23 September 2026, the hosted edge runtime did not start that worker: a
 * figure the Deno CLI read as `124.50` answered `recognition_unavailable`
 * there, with nothing logged. So the calls are made here, in order, the way
 * `tesseract.js`'s own worker script makes them:
 *
 *   1. the engine is instantiated from the bytes it is HANDED (`wasmBinary`),
 *      so it reads no file and fetches nothing;
 *   2. the language model is written into the engine's own file system at
 *      `./eng.traineddata`, where `Init(null, 'eng', …)` looks for it;
 *   3. `Init` with OEM 1 (LSTM only), which is what `createWorker('eng', 1)`
 *      asked for;
 *   4. the defaults `tesseract.js` sets on every worker — page segmentation 6,
 *      an empty character whitelist — and then the caller's own;
 *   5. per picture: written to `/input`, `SetImageFile(exif, 0)`,
 *      `Recognize`, `GetUTF8Text`.
 *
 * Same engine build, same model, same parameters, so the same text: the
 * figure reader's thresholds were measured on exactly this.
 *
 * NO DENO API HERE, deliberately. What this needs — WebAssembly, `crypto`,
 * `performance`, `DecompressionStream` — every runtime this product runs
 * under has, so the unit suite runs the real engine in-process under Node and
 * the edge runtime runs the same module. Fetching the engine and the model is
 * `engine.ts`'s business.
 *
 * NEVER THROWS. An engine that will not start is an answer, not a fault — and
 * the answer says which step refused, because "unavailable" with no reason is
 * how this went unseen in production.
 */

import { pump } from '../rasterPng.ts';

/** The engine's calls this module makes, and nothing else. */
interface TessBaseApi {
  Init(datapath: string | null, language: string, oem: number): number;
  SetVariable(name: string, value: string): boolean;
  SetImageFile(exif: number, angle: number): number;
  Recognize(monitor: null): number;
  GetUTF8Text(): string;
  End(): void;
}

interface TessModule {
  FS: { writeFile(path: string, data: Uint8Array | string): void; unlink(path: string): void };
  TessBaseAPI: new () => TessBaseApi;
  destroy?: (object: unknown) => void;
}

type TesseractCoreFactory = (config: Record<string, unknown>) => Promise<TessModule>;

/** What `tesseract.js` recognises with, in the shape its callers read. */
export interface EngineRecogniser {
  recognize(png: Uint8Array): Promise<{ data: { text: string } }>;
  setParameters(params: Record<string, string>): Promise<void>;
  terminate(): Promise<void>;
}

/** Why the engine did not start. Each names the step that refused. */
export type EngineRefusal = 'engine_start_failed' | 'engine_init_failed';

export type EngineStart =
  | { ok: true; recogniser: EngineRecogniser }
  | { ok: false; refusal: EngineRefusal; detail: string };

/**
 * `tesseract.js`'s own defaults for a worker, set before the caller's
 * (`worker-script/constants/defaultParams.js`, less the `tessjs_` output
 * switches, which are the wrapper's and never reach the engine).
 */
const WORKER_DEFAULTS: Readonly<Record<string, string>> = {
  tessedit_pageseg_mode: '6',
  tessedit_char_whitelist: '',
};

/** OEM 1: the LSTM recogniser alone, as `createWorker('eng', 1)` asks. */
const OEM_LSTM_ONLY = 1;

/** Where `tesseract.js` puts the model and the picture in the engine's file system. */
const MODEL_PATH = './eng.traineddata';
const INPUT_PATH = '/input';

/**
 * The orientation `tesseract.js` reads out of a JPEG's EXIF before it hands
 * the picture over (`worker-script/utils/setImage.js`), kept verbatim so a
 * picture is set exactly as it would have been. A PNG carries none: 1.
 */
function exifOrientation(image: Uint8Array): number {
  const head = Array.from(image.subarray(0, 500)).join(' ');
  return parseInt(head.match(/1 18 0 3 0 0 0 1 0 (\d)/)?.[1] ?? '', 10) || 1;
}

/**
 * Unwrap a gzip stream with the platform's own decoder, through the one pump
 * this pipeline inflates with (`rasterPng.ts`): it bounds what a stream may
 * expand to, and a damaged stream rejects this call rather than the isolate.
 */
export function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return pump(new DecompressionStream('gzip'), bytes);
}

/** Is this a gzip stream? The two magic bytes, as `tesseract.js` tests them. */
export const isGzip = (bytes: Uint8Array): boolean =>
  (bytes[0] === 31 && bytes[1] === 139) || (bytes[1] === 31 && bytes[0] === 139);

const describe = (error: unknown): string =>
  String((error as { message?: string })?.message ?? error).slice(0, 200);

/**
 * Bring the engine up in this isolate with the bytes handed to it.
 *
 * `wasmBinary` is the engine; `model` is the language model, gzipped or not.
 * The recogniser holds the engine until `terminate`, which frees it.
 */
export async function startEngine(input: {
  wasmBinary: Uint8Array;
  model: Uint8Array;
}): Promise<EngineStart> {
  let module: TessModule;
  try {
    const loaded = await import('./tesseractCore.generated.js');
    const factory = (loaded as { default?: unknown }).default as TesseractCoreFactory | undefined;
    if (typeof factory !== 'function') throw new Error('the engine loader exported no factory');
    module = await factory({
      wasmBinary: input.wasmBinary,
      // The engine reports progress through this hook whether or not anybody
      // listens; `tesseract.js`'s worker always supplies one.
      TesseractProgress() {},
      // The engine's own console is not this product's log.
      print() {},
      printErr() {},
    });
  } catch (error) {
    return { ok: false, refusal: 'engine_start_failed', detail: describe(error) };
  }

  let api: TessBaseApi;
  try {
    const model = isGzip(input.model) ? await gunzip(input.model) : input.model;
    module.FS.writeFile(MODEL_PATH, model);
    api = new module.TessBaseAPI();
    if (api.Init(null, 'eng', OEM_LSTM_ONLY) === -1) {
      return { ok: false, refusal: 'engine_init_failed', detail: 'Init answered -1' };
    }
    for (const [name, value] of Object.entries(WORKER_DEFAULTS)) api.SetVariable(name, value);
  } catch (error) {
    return { ok: false, refusal: 'engine_init_failed', detail: describe(error) };
  }

  let ended = false;
  const recogniser: EngineRecogniser = {
    recognize(png) {
      if (ended) return Promise.reject(new Error('the engine has been released'));
      try {
        module.FS.writeFile(INPUT_PATH, png);
        if (api.SetImageFile(exifOrientation(png), 0) === 1) {
          throw new Error('the engine could not read the picture');
        }
        api.Recognize(null);
        const text = api.GetUTF8Text();
        return Promise.resolve({ data: { text: typeof text === 'string' ? text : '' } });
      } catch (error) {
        return Promise.reject(error);
      } finally {
        try { module.FS.unlink(INPUT_PATH); } catch { /* nothing was written */ }
      }
    },
    setParameters(params) {
      for (const [name, value] of Object.entries(params)) api.SetVariable(name, value);
      return Promise.resolve();
    },
    terminate() {
      if (!ended) {
        ended = true;
        try { api.End(); } catch { /* already gone */ }
        try { module.destroy?.(api); } catch { /* already gone */ }
      }
      return Promise.resolve();
    },
  };
  return { ok: true, recogniser };
}
