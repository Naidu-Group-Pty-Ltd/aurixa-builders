/**
 * ===========================================================================
 * WHERE THE OCR ENGINE LIVES, AND WHAT IT MUST BE.
 * ===========================================================================
 *
 * The engine is Tesseract compiled to WebAssembly — `tesseract.js-core@5.1.1`,
 * the SIMD + LSTM build, which is the one `tesseract.js` itself loads on every
 * host this product was measured on. It lives where the language model lives
 * (`languageSource.pure.ts`), for the same measured reason: a function's
 * module graph answered 413 at 6.59 MB, and this is 2.86 MB. The deploy puts
 * it there (`scripts/ops/upload-ocr-language.mjs`), so it travels with the
 * code the way the code does.
 *
 * WHY THE ENGINE IS NOW CALLED DIRECTLY AT ALL. `tesseract.js` runs its engine
 * in a worker — a `worker_threads` Worker spawned from a file inside the npm
 * package, or a Web Worker — and never in the isolate that asks. Measured in
 * production on 23 September 2026, the hosted runtime did not start it: the
 * figure read answered `recognition_unavailable` on the stored `Lot 101`
 * brochure that the same code read as `124.50` under the Deno CLI in CI.
 * `engine.ts` loads the same engine in the isolate instead.
 *
 * WHAT ARRIVED IS CHECKED, NEVER TRUSTED — and here the check is the DIGEST,
 * not only the length the language model is held to, because this is code the
 * isolate will execute. A truncated download, a wrong object or a changed one
 * all answer `null`: no engine, no recognition, a figure left unread and said
 * to be unread.
 *
 * Pure: no IO. The digest is computed by the caller.
 */

/**
 * The object key. VERSIONED IN THE PATH, like the model's: a different engine
 * is a different key, never the same key with different bytes.
 */
export const OCR_ENGINE_KEY = 'system/ocr/tesseract.js-core-5.1.1/tesseract-core-simd-lstm.wasm';

/** The size the object must be, to the byte, and the digest it must have. */
export const OCR_ENGINE_BYTES = 2_859_709;
export const OCR_ENGINE_SHA256 =
  '66b601224a0c4a8977bc9d92dd39841189f9ca22cc4122fcd7208cdb0961eeef';

/** Is this the engine this product was measured against? */
export function engineBytesAreExpected(
  bytes: Uint8Array | null | undefined,
  sha256Hex: string | null | undefined,
): boolean {
  return !!bytes && bytes.length === OCR_ENGINE_BYTES && sha256Hex === OCR_ENGINE_SHA256;
}

/** Lower-case hex, the spelling the constant above is written in. */
export function hexDigest(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
