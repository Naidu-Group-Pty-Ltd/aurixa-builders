#!/usr/bin/env node
/**
 * THE OCR MODEL AND ENGINE SHIP WITH THE DEPLOY, OR THE CAPABILITY DOES NOT
 * EXIST.
 *
 * `supabase functions deploy --use-api` uploads a function's module graph in
 * one request, and the graph carrying the model answered 413 — so the model is
 * an asset in the project's own storage instead, and this is what puts it
 * there. `ocr/languageSource.pure.ts` carries the measurement.
 *
 * THE ENGINE IS THE SECOND ASSET, for the same reason and one more. Tesseract
 * compiled to WebAssembly is 2.86 MB, and `ocr/engine.ts` runs it in the
 * isolate that asks, because the worker `tesseract.js` runs it in never started
 * on the hosted runtime (measured 23 September 2026 — `ocr/engineSource.pure.ts`).
 * The function fetches it from here and refuses it unless its digest is the one
 * pinned there and below.
 *
 * WHY THIS RUNS ON EVERY DEPLOY rather than once, by hand.
 * `CLONE_PROVISIONING_GAPS.md` is a whole document about a capability that
 * depends on a seeded object: the rows a migration inserts do not travel, so
 * the feature is absent on every clone while looking, from the code, exactly
 * like it is present. The remedy it names is that reference data has to be
 * able to travel as code — so this is a deploy step, idempotent, and a clone
 * that has been deployed has both assets. Nobody has to remember anything.
 *
 * NO NEW SECRET. The service key is resolved from the Management API with the
 * `SUPABASE_ACCESS_TOKEN` this workflow already holds, exactly as
 * `apply-migrations.mjs` resolves its query endpoint from the same token — a
 * lane that cannot run until somebody adds a credential is a lane that stays
 * unrun.
 *
 * IDEMPOTENT BY EFFECT, NOT BY ASSUMPTION. Each object is read back first
 * and skipped when its size and digest already match; otherwise it is
 * uploaded with upsert and read back again. The check is what the object
 * HOLDS rather than a local flag or a header, because the question is what
 * production holds and not what this run believes — and the key is versioned,
 * so a different asset is a different key, never the same key with different
 * bytes.
 *
 * Needs: SUPABASE_ACCESS_TOKEN, PROJECT_REF
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const BUCKET = 'builder-stock-lists';

/*
 * PINNED HERE AND IN THE MODULES THE FUNCTIONS READ (`ocr/languageSource.pure.ts`,
 * `ocr/engineSource.pure.ts`); a spec holds the two to each other.
 */
const ASSETS = [
  {
    what: 'ocr model',
    asset: 'assets/ocr/eng.traineddata.gz',
    key: 'system/ocr/4.0.0_best_int/eng.traineddata.gz',
    bytes: 2_952_873,
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    contentType: 'application/gzip',
    vendor: 'npm run ocr:vendor-language',
  },
  {
    what: 'ocr engine',
    asset: 'assets/ocr/tesseract-core-simd-lstm.wasm',
    key: 'system/ocr/tesseract.js-core-5.1.1/tesseract-core-simd-lstm.wasm',
    bytes: 2_859_709,
    sha256: '66b601224a0c4a8977bc9d92dd39841189f9ca22cc4122fcd7208cdb0961eeef',
    contentType: 'application/wasm',
    vendor: 'npm run ocr:vendor-engine',
  },
];

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.PROJECT_REF;
if (!token || !projectRef) {
  console.error(
    '::error::upload-ocr-language: SUPABASE_ACCESS_TOKEN and PROJECT_REF are required — nothing was uploaded.',
  );
  process.exit(1);
}

/*
 * EVERY FILE IN THE REPOSITORY IS CHECKED BEFORE ANYTHING IS SHIPPED. The OCR
 * thresholds were measured against these exact bytes; uploading anything else
 * would change how this product reads with nothing reporting it — and the
 * engine is code the functions will execute.
 */
const payloads = ASSETS.map((entry) => {
  if (!existsSync(entry.asset)) {
    console.error(
      `::error::upload-ocr-language: ${entry.asset} is missing. Run \`${entry.vendor}\` and commit it.`,
    );
    process.exit(1);
  }
  const bytes = readFileSync(entry.asset);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entry.bytes || sha !== entry.sha256) {
    console.error(
      `::error::upload-ocr-language: ${entry.asset} is not the ${entry.what} this product was measured against.\n`
      + `  expected ${entry.bytes} bytes, sha256 ${entry.sha256}\n`
      + `  received ${bytes.length} bytes, sha256 ${sha}`,
    );
    process.exit(1);
  }
  return { ...entry, data: bytes };
});

/** The project's URL and service key, from the token this workflow holds. */
async function projectCredentials() {
  const keys = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!keys.ok) {
    throw new Error(`api-keys: HTTP ${keys.status} ${(await keys.text()).slice(0, 200)}`);
  }
  const body = await keys.json();
  const service = (Array.isArray(body) ? body : []).find(
    (k) => k?.name === 'service_role' || k?.type === 'secret',
  );
  if (!service?.api_key) throw new Error('api-keys: no service_role key in the response');
  return { url: `https://${projectRef}.supabase.co`, key: service.api_key };
}

/**
 * What the project's storage holds under one key, read back IN FULL: its size
 * and its digest, or the status that refused.
 *
 * WHY NOT A HEAD. This script used to ask a HEAD for `content-length`, and on
 * the deploy that first shipped the engine it read the freshly uploaded
 * object as 0 bytes — while the functions, which check the engine's SHA-256
 * before a byte of it runs, fetched and ran it minutes later. A HEAD answered
 * through a compressing proxy need not carry a length at all, and a missing
 * header read as `0` is the configuration standing in for the effect. So the
 * object is fetched the way the functions fetch it and judged the way they
 * judge it: by what arrives.
 */
async function storedObject(object, auth) {
  const response = await fetch(object, { headers: auth });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { ok: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const isTheAsset = (read, entry) =>
  read.ok && read.bytes === entry.bytes && read.sha256 === entry.sha256;

/** Put one asset where the functions read it, and prove it is there. */
async function ship(entry, { url, key }) {
  const object = `${url}/storage/v1/object/${BUCKET}/${entry.key}`;
  const auth = { Authorization: `Bearer ${key}`, apikey: key };

  // What does production hold NOW? The only question that matters.
  if (isTheAsset(await storedObject(object, auth), entry)) {
    console.log(`${entry.what} already present: ${BUCKET}/${entry.key} (${entry.bytes} bytes, sha256 ${entry.sha256})`);
    return true;
  }

  const put = await fetch(object, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': entry.contentType,
      'x-upsert': 'true',
      'Cache-Control': 'max-age=31536000',
    },
    body: entry.data,
  });
  if (!put.ok) {
    throw new Error(`${entry.what} upload: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  }

  /*
   * ASSERTED BY EFFECT, NEVER BY THE UPLOAD'S OWN ANSWER — the rule the
   * retention purge, the verification self-test and the function verifier
   * beside this file all answer to. A 200 from a write is not a statement
   * about what is stored, and nor is a header about it.
   */
  const stored = await storedObject(object, auth);
  if (!isTheAsset(stored, entry)) {
    console.error(
      `::error::upload-ocr-language: the ${entry.what} was uploaded, but it reads back as ${
        stored.ok ? `${stored.bytes} bytes, sha256 ${stored.sha256}` : `HTTP ${stored.status}`
      } rather than ${entry.bytes} bytes, sha256 ${entry.sha256}. OCR will decline on this deployment.`,
    );
    return false;
  }
  console.log(`${entry.what} shipped: ${BUCKET}/${entry.key} (${entry.bytes} bytes, sha256 ${entry.sha256})`);
  return true;
}

try {
  const credentials = await projectCredentials();
  let shipped = true;
  for (const entry of payloads) shipped = (await ship(entry, credentials)) && shipped;
  if (!shipped) process.exit(1);
} catch (error) {
  console.error(`::error::upload-ocr-language: ${String(error?.message ?? error)}`);
  process.exit(1);
}
