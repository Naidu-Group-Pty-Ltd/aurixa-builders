/**
 * ===========================================================================
 * THE OCR ENGINE, FETCHED FROM THIS PROJECT'S OWN STORAGE AND STARTED IN THE
 * ISOLATE THAT ASKS — AND ITS ABSENCE IS A NAMED, LOGGED REFUSAL.
 * ===========================================================================
 *
 * `engineDriver.ts` runs Tesseract in-process from bytes it is handed; this is
 * where the bytes come from. The engine is an asset the deploy ships
 * (`engineSource.pure.ts`), fetched with the service role every edge function
 * already holds — no third party, no new credential, nothing reachable that
 * this deployment does not already talk to — and the language model is the
 * copy `languageData.ts` already wrote to `/tmp`.
 *
 * THREE RULES.
 *
 * THE ENGINE IS CHECKED BY ITS DIGEST before a byte of it runs. It is code;
 * a truncated download, a wrong object and a changed one all answer
 * `engine_not_measured`, and nothing is recognised.
 *
 * ONLY SUCCESS IS REMEMBERED. The verified bytes are kept for the life of the
 * isolate; a refusal is not, so a storage fault in one invocation does not
 * outlive it.
 *
 * EVERY REFUSAL IS LOGGED WITH ITS REASON. Production answered
 * `recognition_unavailable` on 23 September 2026 with nothing in the log to
 * say why, because the engine's start-up swallowed its own error. A capability
 * that declines silently cannot be told apart from one that was never asked.
 */
import { OCR_ASSET_BUCKET } from './languageSource.pure.ts';
import { engineBytesAreExpected, hexDigest, OCR_ENGINE_KEY } from './engineSource.pure.ts';
import { startEngine, type EngineRecogniser, type EngineRefusal } from './engineDriver.ts';

/** A copy already on this machine — the reading trace provides one, as it does the model. */
const ENGINE_FILE = '/tmp/ocr-engine/tesseract-core-simd-lstm.wasm';

/** How long the download may take before the capability declines. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type EngineUnavailable =
  | 'engine_not_shipped'
  | 'engine_unreachable'
  | 'engine_not_measured'
  | 'language_unreadable'
  | EngineRefusal;

export type EngineOpening =
  | { ok: true; recogniser: EngineRecogniser }
  | { ok: false; unavailable: EngineUnavailable; detail: string };

let verifiedEngine: Uint8Array | undefined;

async function isTheMeasuredEngine(bytes: Uint8Array): Promise<boolean> {
  // A read's `Uint8Array` carries the wider `ArrayBufferLike`; the digest is
  // typed for the narrow one. The same cast `rasterPng.ts` makes.
  const digest = hexDigest(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
  return engineBytesAreExpected(bytes, digest);
}

type BinaryReading =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; unavailable: EngineUnavailable; detail: string };

async function engineBinary(): Promise<BinaryReading> {
  if (verifiedEngine) return { ok: true, bytes: verifiedEngine };

  const local = await Deno.readFile(ENGINE_FILE).catch(() => null);
  if (local && await isTheMeasuredEngine(local)) {
    verifiedEngine = local;
    return { ok: true, bytes: local };
  }

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    return { ok: false, unavailable: 'engine_unreachable', detail: 'no project url or service key' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${url.replace(/\/+$/, '')}/storage/v1/object/${OCR_ASSET_BUCKET}/${OCR_ENGINE_KEY}`,
      { headers: { Authorization: `Bearer ${key}`, apikey: key }, signal: controller.signal },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      /*
       * A 404 is "this deployment has not shipped the engine" — the deploy
       * ships it after the code, so this is also what the seconds between the
       * two look like. Anything else is a fault. Different people fix them.
       */
      return {
        ok: false,
        unavailable: response.status === 404 ? 'engine_not_shipped' : 'engine_unreachable',
        detail: `HTTP ${response.status}`,
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!await isTheMeasuredEngine(bytes)) {
      return { ok: false, unavailable: 'engine_not_measured', detail: `${bytes.length} bytes` };
    }
    verifiedEngine = bytes;
    return { ok: true, bytes };
  } catch (error) {
    return {
      ok: false,
      unavailable: 'engine_unreachable',
      detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The engine, started in this isolate with the model in `langDir`, or the
 * reason it could not be. Never throws.
 */
export async function openInProcessRecogniser(langDir: string): Promise<EngineOpening> {
  const opening = await open(langDir);
  if (!opening.ok) {
    console.warn('[builderStock] ocr engine unavailable', {
      phase: 'ocr_engine', reason: opening.unavailable, detail: opening.detail,
    });
  }
  return opening;
}

async function open(langDir: string): Promise<EngineOpening> {
  const binary = await engineBinary();
  if (!binary.ok) return binary;
  let model: Uint8Array;
  try {
    model = await Deno.readFile(`${langDir}/eng.traineddata.gz`);
  } catch (error) {
    return {
      ok: false,
      unavailable: 'language_unreadable',
      detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
    };
  }
  const started = await startEngine({ wasmBinary: binary.bytes, model });
  return started.ok
    ? { ok: true, recogniser: started.recogniser }
    : { ok: false, unavailable: started.refusal, detail: started.detail };
}
