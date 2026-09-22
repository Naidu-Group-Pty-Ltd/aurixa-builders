/**
 * ===========================================================================
 * WHERE THE OCR MODEL LIVES, AND WHY IT STOPPED LIVING IN THE CODE.
 * ===========================================================================
 *
 * `languageData.ts` used to import the trained model as a generated
 * TypeScript module — 2.95 MB of gzip as 3.9 MB of base64 — under a header
 * that considered a bucket and rejected it, because a capability depending on
 * a seeded object is absent on every clone while looking, from the code,
 * exactly like it is present. `CLONE_PROVISIONING_GAPS.md` is a whole
 * document about that failure and the reasoning was sound.
 *
 * IT WAS ALSO FATAL, AND THE MEASUREMENT IS THE POINT.
 *
 * Merged to main on 22 September 2026, the deploy answered
 *
 *     unexpected deploy status 413: {"message":"request entity too large"}
 *     deploy failed for: builder-portal-stock builder-stock-image-settler
 *
 * and those two alone — the customer's upload entry point and the sweep that
 * settles every image — stayed on the previous build while the other 25
 * shipped. `verify-functions-deployed.mjs` caught it and failed the run,
 * which is the only reason this was not silent.
 *
 * `supabase functions deploy --use-api` uploads a function's whole module
 * graph in ONE request, and measured with `deno info`:
 *
 *     builder-portal-stock          6,588,010 bytes  (139 local modules)
 *       of which the model          3,937,754 bytes  (60%)
 *       without it                  2,650,256 bytes  ← the size that shipped
 *     builder-stock-image-settler   6,523,920 bytes
 *     builder-stock-link-callback     494,582 bytes  ← shipped fine
 *
 * A DYNAMIC IMPORT DOES NOT HELP, and that was checked rather than assumed:
 * `languageData.ts` already imported the generated module dynamically, and it
 * is still in the graph, because the graph is what a deploy uploads. Nor does
 * splitting it across modules — the limit is on the request, not the file.
 *
 * So the module graph is not a viable home for an asset of this size in a
 * function that also carries the stock pipeline, at any encoding. The three
 * options were a CDN at runtime, a bucket, and the graph; the graph is now
 * excluded by evidence and the CDN is excluded by the original reasoning,
 * which still stands — a core capability must not depend on a third party
 * being reachable at the moment a builder uploads.
 *
 * WHAT MAKES THE BUCKET SAFE IS THAT IT IS NOT SEEDED. The object is uploaded
 * by the DEPLOY, on every deploy, idempotently
 * (`scripts/ops/upload-ocr-language.mjs`) — so it travels with the code the
 * way the code does, and a clone that has been deployed has it. That is the
 * remedy `CLONE_PROVISIONING_GAPS.md` itself names: reference data has to be
 * able to travel as code. It is not a migration's INSERT and it is not a step
 * somebody has to remember.
 *
 * And its absence is still a named, honest refusal rather than a guess: no
 * model means no recognition, which means a scan reads as a document with no
 * text, which this pipeline already refuses in words a builder can act on.
 */

/** The bucket the model is stored in. Private; read with the service role. */
export const OCR_ASSET_BUCKET = 'builder-stock-lists';

/**
 * The object key.
 *
 * VERSIONED IN THE PATH, deliberately. The model and the thresholds measured
 * against it are one thing: a deployment that changed the model without
 * changing the key would recognise differently while every test and every
 * recorded measurement still named the old one. A new model is a new key.
 */
export const OCR_LANGUAGE_KEY = 'system/ocr/4.0.0_best_int/eng.traineddata.gz';

/**
 * The size the object must be, to the byte, and the digest it must have.
 *
 * ASSERTED ON READ, not trusted. A truncated download and a wrong object are
 * the two ways this goes wrong quietly, and both produce an engine that
 * either fails to initialise or — worse — reads badly. Checked here so the
 * answer is `unavailable` rather than a bad reading.
 */
export const OCR_LANGUAGE_BYTES = 2_952_873;
export const OCR_LANGUAGE_SHA256 =
  '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';

/** Is this the object we measured our thresholds against? */
export function languageBytesAreExpected(
  bytes: Uint8Array | null | undefined,
): boolean {
  return !!bytes && bytes.length === OCR_LANGUAGE_BYTES;
}
