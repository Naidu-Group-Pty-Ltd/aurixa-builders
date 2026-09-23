/**
 * ===========================================================================
 * THE HOSTED EDGE RUNTIME STARTS NO WORKER, AND NEITHER DOES THIS GATE.
 * ===========================================================================
 *
 * Measured in production on 23 September 2026 (`production-rollout`, run
 * 35877700148, `stock-scan-proof` in observe mode): a fully scanned brochure
 * uploaded through the portal was refused `pdf_no_text_layer` in 10.7 s, and
 * the one line the recogniser wrote was
 *
 *   [builderStock] ocr engine unavailable { phase: "ocr_engine",
 *     engine: "tesseract.js", detail: "Not implemented: Worker.prototype.constructor" }
 *
 * `tesseract.js` runs its engine in a worker it spawns, and the hosted runtime
 * refuses to construct one. The Deno CLI this gate runs under constructs them
 * happily — which is how the scanned-page path, and the figure reader before
 * it, passed every gate and read nothing in production. A gate that can start
 * what production cannot is proving a runtime nobody ships.
 *
 * So this module refuses BOTH kinds of worker a library can ask for — the web
 * `Worker` and `node:worker_threads`, which is what the npm build of
 * `tesseract.js` calls — with the runtime's own words, and counts every
 * request. It is imported FIRST by every entry point that runs the importer
 * (`harness.ts`, `cpu-profile.ts`, `latency.ts`), before any product module
 * has loaded; the product imports its recogniser lazily, but a refusal that
 * depended on that would be a coincidence rather than a rule.
 *
 * The library itself is NOT replaced: the import map still resolves it to its
 * real npm build, so an old path run through this gate fails the way it fails
 * in production — in the library's own worker constructor — rather than in a
 * stand-in written to fail.
 */
import workerThreads from 'node:worker_threads';

/** What the hosted runtime answers `new Worker(...)` with, verbatim. */
export const HOSTED_WORKER_REFUSAL = 'Not implemented: Worker.prototype.constructor';

let requested = 0;

class RefusedWorker {
  constructor() {
    requested += 1;
    throw new Error(HOSTED_WORKER_REFUSAL);
  }
}

(globalThis as { Worker?: unknown }).Worker = RefusedWorker;
(workerThreads as unknown as { Worker: unknown }).Worker = RefusedWorker;

/** How many workers anything in this process has asked for. */
export const workersRequested = (): number => requested;
