#!/usr/bin/env node
/**
 * THE OCR MODEL SHIPS WITH THE DEPLOY, OR THE CAPABILITY DOES NOT EXIST.
 *
 * `supabase functions deploy --use-api` uploads a function's module graph in
 * one request, and the graph carrying this model answered 413 — so the model
 * is an asset in the project's own storage instead, and this is what puts it
 * there. `ocr/languageSource.pure.ts` carries the measurement.
 *
 * WHY THIS RUNS ON EVERY DEPLOY rather than once, by hand.
 * `CLONE_PROVISIONING_GAPS.md` is a whole document about a capability that
 * depends on a seeded object: the rows a migration inserts do not travel, so
 * the feature is absent on every clone while looking, from the code, exactly
 * like it is present. The remedy it names is that reference data has to be
 * able to travel as code — so this is a deploy step, idempotent, and a clone
 * that has been deployed has the model. Nobody has to remember anything.
 *
 * NO NEW SECRET. The service key is resolved from the Management API with the
 * `SUPABASE_ACCESS_TOKEN` this workflow already holds, exactly as
 * `apply-migrations.mjs` resolves its query endpoint from the same token — a
 * lane that cannot run until somebody adds a credential is a lane that stays
 * unrun.
 *
 * IDEMPOTENT BY EFFECT, NOT BY ASSUMPTION. The object is HEADed first and
 * skipped when its length already matches; otherwise it is uploaded with
 * upsert. The check is the LENGTH rather than a local flag, because the
 * question is what production holds and not what this run believes.
 *
 * Needs: SUPABASE_ACCESS_TOKEN, PROJECT_REF
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const ASSET = 'assets/ocr/eng.traineddata.gz';
const BUCKET = 'builder-stock-lists';
const KEY = 'system/ocr/4.0.0_best_int/eng.traineddata.gz';
const EXPECT_BYTES = 2_952_873;
const EXPECT_SHA256 =
  '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.PROJECT_REF;
if (!token || !projectRef) {
  console.error(
    '::error::upload-ocr-language: SUPABASE_ACCESS_TOKEN and PROJECT_REF are required — nothing was uploaded.',
  );
  process.exit(1);
}

if (!existsSync(ASSET)) {
  console.error(
    `::error::upload-ocr-language: ${ASSET} is missing. Run \`npm run ocr:vendor-language\` and commit it.`,
  );
  process.exit(1);
}

const bytes = readFileSync(ASSET);
const sha = createHash('sha256').update(bytes).digest('hex');
/*
 * THE FILE IN THE REPOSITORY IS CHECKED BEFORE IT IS SHIPPED. The OCR
 * thresholds were measured against these exact bytes; uploading anything else
 * would change how this product reads a scan with nothing reporting it.
 */
if (bytes.length !== EXPECT_BYTES || sha !== EXPECT_SHA256) {
  console.error(
    `::error::upload-ocr-language: ${ASSET} is not the model this product was measured against.\n`
    + `  expected ${EXPECT_BYTES} bytes, sha256 ${EXPECT_SHA256}\n`
    + `  received ${bytes.length} bytes, sha256 ${sha}`,
  );
  process.exit(1);
}

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

try {
  const { url, key } = await projectCredentials();
  const object = `${url}/storage/v1/object/${BUCKET}/${KEY}`;
  const auth = { Authorization: `Bearer ${key}`, apikey: key };

  // What does production hold NOW? The only question that matters.
  const head = await fetch(object, { method: 'HEAD', headers: auth });
  if (head.ok && Number(head.headers.get('content-length') ?? '0') === EXPECT_BYTES) {
    console.log(`ocr model already present: ${BUCKET}/${KEY} (${EXPECT_BYTES} bytes)`);
    process.exit(0);
  }

  const put = await fetch(object, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/gzip',
      'x-upsert': 'true',
      'Cache-Control': 'max-age=31536000',
    },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`upload: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  }

  /*
   * ASSERTED BY EFFECT, NEVER BY THE UPLOAD'S OWN ANSWER — the rule the
   * retention purge, the verification self-test and the function verifier
   * beside this file all answer to. A 200 from a write is not a statement
   * about what is stored.
   */
  const confirm = await fetch(object, { method: 'HEAD', headers: auth });
  const stored = Number(confirm.headers.get('content-length') ?? '0');
  if (!confirm.ok || stored !== EXPECT_BYTES) {
    console.error(
      `::error::upload-ocr-language: uploaded, but the object reads back as ${
        confirm.ok ? `${stored} bytes` : `HTTP ${confirm.status}`
      } rather than ${EXPECT_BYTES}. OCR will decline on this deployment.`,
    );
    process.exit(1);
  }
  console.log(`ocr model shipped: ${BUCKET}/${KEY} (${EXPECT_BYTES} bytes, sha256 ${sha})`);
} catch (error) {
  console.error(`::error::upload-ocr-language: ${String(error?.message ?? error)}`);
  process.exit(1);
}
