#!/usr/bin/env node
/**
 * ===========================================================================
 * A FULLY SCANNED BROCHURE, IMPORTED BY THE LIVE PRODUCT, WITH NOBODY IN THE LOOP.
 * ===========================================================================
 *
 * The question this answers is about a RUNTIME, not a document: when a
 * builder uploads a brochure whose pages are photographs of paper, does the
 * deployed product's text recognition come up on the hosted Supabase Edge
 * Runtime and read them? The acceptance gate cannot fully answer it. It now
 * refuses workers the way this runtime does (`hostedRuntime.ts`), but it runs
 * under the Deno CLI on another machine, and what an isolate may SPEND here —
 * the thing a 546 is about — is a property of this runtime alone.
 *
 * So this imports a SAFE fixture — `heldout-scanned-brochure`, three pages of
 * pixels with no text layer, nothing in it any customer's
 * (`scripts/stock-acceptance/make-scan-proof-fixture.py`) — the way a
 * builder's browser does: `create_upload`, the file PUT to the signed URL,
 * `process_upload`, and then NOTHING. Whatever finishes the import after that
 * call is the product's own dispatch and continuation.
 *
 * ISOLATED. It imports into an organisation of this run's own, named
 * `Smoke Rollout scan-proof <run>`, which is detached from the network in the
 * same transaction that creates it (see `detachFromNetwork`), so nothing it
 * imports can reach a workspace. Every row and object it creates is deleted
 * before it exits, and the smoke run's own sweep recognises the name.
 *
 * TWO MODES.
 *   observe (default)  report what the runtime did — every page recognised,
 *                      refused or never attempted, the engine's own refusal
 *                      from the function log, the property read, every
 *                      invocation's HTTP status. Fails only if the proof
 *                      itself could not run or could not clean up.
 *   read               the same, and REQUIRE: every page recognised exactly
 *                      once, the document's property read field for field,
 *                      no 546, no recovered worker, nothing duplicated,
 *                      nothing stranded, and nothing moving afterwards.
 *
 * Runs from the production-rollout workflow (phase `stock-scan-proof`), which
 * holds SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER. No secret is printed.
 *
 *   SCAN_PROOF_EXPECT=observe|read node scripts/ops/stock-scan-proof.mjs
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const EXPECT = (process.env.SCAN_PROOF_EXPECT || 'observe').trim().toLowerCase();
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'scan-proof';
const STOCK_LIST_BUCKET = 'builder-stock-lists';
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];

/**
 * THE FIXTURE, PINNED. Drawn by `make-scan-proof-fixture.py` from the same
 * fixture function the acceptance gate judges, with reportlab's invariant
 * switch so the bytes are reproducible. A file that does not hash to this is
 * not the document this proof is about, and nothing is sent.
 */
const FIXTURE = {
  path: new URL('./fixtures/scanned-brochure-lot-57.pdf', import.meta.url),
  filename: 'LOT 57 - ASTER 22 - SCANNED BROCHURE.pdf',
  bytes: 150_838,
  sha256: 'c7baf511155de4125b30139659fd55d5b4ed41c0f1620137eeb210f721e22e67',
  pages: 3,
  /** What the document states, in the columns the product writes. */
  property: {
    lot_number: '57', suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    bedrooms: 4, bathrooms: 2, car_spaces: 2,
    land_size_sqm: 392, building_size_sqm: 207, price: 689000,
    street: 'Heathland Avenue', design: 'Aster 22',
  },
};

const IMPORT_DEADLINE_MS = 6 * 60_000;
/** Longer than a recovery grace (60 s) plus a tick (60 s): what would have moved, has. */
const SETTLEMENT_WINDOW_MS = 150_000;

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }
if (!['observe', 'read'].includes(EXPECT)) {
  console.error(`SCAN_PROOF_EXPECT must be observe or read, not ${JSON.stringify(EXPECT)}`);
  process.exit(2);
}

const results = [];
/** In observe mode nothing about the RUNTIME is required; the proof's own mechanics are. */
function record(name, ok, detail = '', { required = true, runtime = false } = {}) {
  const binding = required && (!runtime || EXPECT === 'read');
  results.push({ name, ok, detail, required: binding });
  console.log(`  ${ok ? 'PASS' : binding ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function q(label, sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 400)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}

/**
 * The runtime's own log for a window, through the Management API's log
 * endpoint. Best effort: a log that cannot be read is reported as unread and
 * never as empty, because "no line said the engine failed" and "the lines
 * could not be fetched" are different findings.
 */
async function logLines(table, pattern, fromMs, toMs) {
  const sql = `select timestamp, event_message from ${table} `
    + `where regexp_contains(event_message, ${sqlLit(pattern)}) order by timestamp asc limit 500`;
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: new Date(fromMs).toISOString(),
    iso_timestamp_end: new Date(toMs).toISOString(),
  });
  try {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${params}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    );
    const text = await response.text();
    if (!response.ok) return { ok: false, lines: [], why: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    const body = JSON.parse(text);
    if (body?.error) return { ok: false, lines: [], why: JSON.stringify(body.error).slice(0, 160) };
    return { ok: true, lines: (body?.result ?? []).map((row) => String(row.event_message ?? '')) };
  } catch (error) {
    return { ok: false, lines: [], why: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * Every invocation of one function in the window: its status, the runtime's
 * own execution time and the deployed version that served it.
 */
async function edgeInvocations(fn, fromMs, toMs) {
  const sql = 'select function_edge_logs.timestamp, response.status_code as status, '
    + 'm.execution_time_ms, m.version from function_edge_logs '
    + 'cross join unnest(metadata) as m '
    + 'cross join unnest(m.response) as response '
    + `where regexp_contains(event_message, ${sqlLit(fn)}) `
    + 'order by function_edge_logs.timestamp asc limit 200';
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: new Date(fromMs).toISOString(),
    iso_timestamp_end: new Date(toMs).toISOString(),
  });
  try {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${params}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    );
    const text = await response.text();
    if (!response.ok) return { ok: false, rows: [], why: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    const body = JSON.parse(text);
    if (body?.error) return { ok: false, rows: [], why: JSON.stringify(body.error).slice(0, 160) };
    return {
      ok: true,
      rows: (body?.result ?? []).map((row) => ({
        status: row.status ?? null, execution_time_ms: row.execution_time_ms ?? null,
        version: row.version ?? null,
      })),
    };
  } catch (error) {
    return { ok: false, rows: [], why: String(error?.message ?? error).slice(0, 160) };
  }
}

/** A portal function through the same-origin proxy, as the browser calls it. */
async function call(fn, body, cookie = null) {
  const headers = {
    'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN,
  };
  if (cookie) headers.Cookie = cookie;
  const startedAt = Date.now();
  const response = await fetch(`${ORIGIN}/fn/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return {
    status: response.status, json, ms: Date.now() - startedAt,
    setCookies: response.headers.getSetCookie?.() ?? [], text: text.slice(0, 300),
  };
}

/** The project's URL and service key, from the token this workflow holds. */
async function storageAuth() {
  const keys = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  if (!keys.ok) throw new Error(`api-keys: HTTP ${keys.status}`);
  const body = await keys.json();
  const service = (Array.isArray(body) ? body : []).find(
    (k) => k?.name === 'service_role' || k?.type === 'secret');
  if (!service?.api_key) throw new Error('api-keys: no service_role key in the response');
  return {
    base: `https://${PROJECT_REF}.supabase.co/storage/v1`,
    headers: { Authorization: `Bearer ${service.api_key}`, apikey: service.api_key },
  };
}

/** Every object under a prefix, folders walked, bounded. */
async function listObjects(storage, bucket, prefix, depth = 0) {
  if (depth > 5) return [];
  const response = await fetch(`${storage.base}/object/list/${bucket}`, {
    method: 'POST',
    headers: { ...storage.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  if (!response.ok) return [];
  const entries = await response.json();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = `${prefix}${entry.name}`;
    if (entry.id) out.push(path);
    else out.push(...await listObjects(storage, bucket, `${path}/`, depth + 1));
  }
  return out;
}

/**
 * NEVER CONNECTED TO A REAL WORKSPACE — `stock-import-proof.mjs`' rule, for
 * the reason it records: an active builder organisation is provisioned onto
 * every `whole_network` workspace the moment it is inserted, so the
 * connections, the announcement queued on the workspace's own transport and
 * everything queued on them are removed in the SAME transaction as the insert.
 */
function detachFromNetwork(orgIdsSql) {
  const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql})`;
  return `
    DELETE FROM public.builder_network_outbox
     WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text
                            FROM public.workspace_connections c
                           WHERE c.builder_organisation_id IN (${orgIdsSql}));
    DELETE FROM public.workspace_connection_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connections});
    DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgIdsSql});`;
}

async function cleanup(stage, storage) {
  const orgs = await q(`${stage}: this run's organisations`, `
    SELECT id FROM public.builder_organisations
     WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`);
  if (storage) {
    for (const { id } of orgs) {
      for (const [bucket, prefix] of [
        [STOCK_LIST_BUCKET, `stock-lists/${id}/`], [STOCK_IMAGE_BUCKET, `${id}/`],
      ]) {
        const paths = await listObjects(storage, bucket, prefix);
        if (!paths.length) continue;
        await fetch(`${storage.base}/object/${bucket}`, {
          method: 'DELETE',
          headers: { ...storage.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths }),
        });
      }
    }
  }
  await q(`${stage}: rows`, `
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`)}
    DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};`);
}

async function seedUser() {
  const email = `${MARK}-${TAG}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!scan`;
  const orgName = `Smoke Rollout ${TAG} ${RUN}`;
  const rows = await q('seed user', `
    WITH org AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now())
      RETURNING id
    ), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, 'Scan Proof', 'active', true, now(), false,
              extensions.crypt(${sqlLit(password)}, extensions.gen_salt('bf', 10)))
      RETURNING id
    )
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT person.id, org.id, 'owner', true, 'active' FROM person, org;
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(orgName)}`)}
    SELECT p.id AS user_id, o.id AS org_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id) AS connections
      FROM public.builder_portal_users p, public.builder_organisations o
     WHERE p.email = ${sqlLit(email)} AND o.legal_name = ${sqlLit(orgName)}`);
  const { user_id, org_id, connections } = rows[0] ?? {};
  if (!user_id || !org_id) throw new Error('the proof organisation could not be seeded');
  if (Number(connections) !== 0) {
    throw new Error(`the proof organisation is still connected to ${connections} workspace(s); refusing to import`);
  }
  await q('seed onboarding', `SELECT public.builder_ensure_onboarding_steps(${sqlLit(user_id)}::uuid)`);
  return { email, password, userId: user_id, orgId: org_id };
}

/** A real login where Turnstile allows automation; a pepper-minted session otherwise. */
async function establishSession(user) {
  const login = await call('builder-portal-login', { email: user.email, password: user.password });
  const issued = login.setCookies.map((c) => c.split(';')[0])
    .find((c) => c.startsWith('__Host-builder_session_token='));
  if (login.status === 200 && issued) return issued;
  if (!PEPPER) throw new Error('login issued no cookie and NETWORK_SESSION_PEPPER is not available');
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHmac('sha256', PEPPER).update(token).digest('hex');
  await q('mint session', `
    SELECT public.builder_issue_session(
      ${sqlLit(user.userId)}::uuid, ${sqlLit(tokenHash)},
      now() + interval '2 hours', now() + interval '2 hours', NULL, NULL, 'smoke-rollout')`);
  return `__Host-builder_session_token=${token}`;
}

const uploadOf = (uploadId) => q('upload', `
  SELECT status, parse_strategy, records_detected, records_imported, processing_started_at,
         processing_completed_at, error_code, error_message,
         import_claim_token IS NOT NULL AS claimed, import_recovery_attempts,
         (import_checkpoint->>'continuations')::int AS continuations,
         import_checkpoint->'ocr' AS ocr,
         import_checkpoint IS NOT NULL AS has_checkpoint,
         stage_timings
    FROM public.builder_stock_uploads WHERE id = ${sqlLit(uploadId)}`).then((rows) => rows[0] ?? null);
const itemsOf = (uploadId) => q('items', `
  SELECT id, lot_number, address_line, suburb, state, postcode, bedrooms, bathrooms, car_spaces,
         land_size_sqm, building_size_sqm, price, source_row->>'house_design' AS house_design,
         lifecycle_status, image_work_stage, primary_image_id,
         pending_patch IS NOT NULL AS has_pending_patch, pending_upload_id
    FROM public.builder_stock_items WHERE upload_id = ${sqlLit(uploadId)}
   ORDER BY lot_number, id`);
const imagesOf = (uploadId) => q('images', `
  SELECT id, stock_item_id, source_reference, byte_size, source_detail->>'role' AS role
    FROM public.builder_stock_item_images WHERE upload_id = ${sqlLit(uploadId)}
   ORDER BY source_reference, id`);

/** Where the read property differs from what the document states. */
function propertyDifferences(item) {
  const want = FIXTURE.property;
  const out = [];
  if (!item) return ['no property'];
  const num = (value) => (value === null || value === undefined ? null : Number(value));
  for (const field of ['lot_number', 'suburb', 'state', 'postcode']) {
    if (String(item[field] ?? '') !== String(want[field])) out.push(`${field} ${JSON.stringify(item[field])}`);
  }
  for (const field of ['bedrooms', 'bathrooms', 'car_spaces', 'land_size_sqm', 'building_size_sqm', 'price']) {
    if (num(item[field]) !== want[field]) out.push(`${field} ${JSON.stringify(item[field])}`);
  }
  if (!String(item.address_line ?? '').includes(want.street)) out.push(`address_line ${JSON.stringify(item.address_line)}`);
  if (String(item.house_design ?? '').toLowerCase() !== want.design.toLowerCase()) {
    out.push(`house_design ${JSON.stringify(item.house_design)}`);
  }
  return out;
}

let storage = null;
const summary = { run: RUN, mode: EXPECT, fixture: FIXTURE.filename };
let windowStart = Date.now();
try {
  console.log(`stock scan proof run=${RUN} mode=${EXPECT} origin=${ORIGIN}`);
  storage = await storageAuth();
  await cleanup('start', storage);

  // --- 1. THE FIXTURE, CHECKED BEFORE IT IS SENT -------------------------
  const bytes = new Uint8Array(readFileSync(FIXTURE.path));
  const sha = createHash('sha256').update(bytes).digest('hex');
  record('1: the fixture is the pinned document',
    sha === FIXTURE.sha256 && bytes.length === FIXTURE.bytes,
    `${bytes.length} bytes, sha256 ${sha.slice(0, 16)}…`);
  if (sha !== FIXTURE.sha256) throw new Error('refusing to import a fixture that is not the pinned one');

  // --- 2. THE THREE REQUESTS A BUILDER'S BROWSER MAKES ------------------
  const user = await seedUser();
  const cookie = await establishSession(user);
  const accepted = await call('builder-portal-verify',
    { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
  const onboarded = await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
  record('2: the proof builder is through governance',
    accepted.status === 200 && onboarded.json?.onboarding_complete === true,
    `terms ${accepted.status}, onboarding ${onboarded.status}`);

  const created = await call('builder-portal-stock', {
    operation: 'create_upload', filename: FIXTURE.filename,
    content_type: 'application/pdf', byte_size: bytes.length,
  }, cookie);
  const proofId = created.json?.upload?.id;
  if (created.status !== 200 || !proofId || !created.json?.signed_url) {
    throw new Error(`create_upload answered ${created.status}: ${created.text}`);
  }
  summary.proofUploadId = proofId;
  const put = await fetch(created.json.signed_url, {
    method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: bytes,
  });
  if (!put.ok) throw new Error(`the signed upload answered ${put.status}`);

  windowStart = Date.now() - 5_000;
  const acceptedAt = Date.now();
  const processed = await call('builder-portal-stock',
    { operation: 'process_upload', upload_id: proofId }, cookie);
  summary.processUpload = {
    status: processed.status, ms: processed.ms,
    stillImporting: processed.json?.still_importing === true,
    code: processed.json?.code ?? null,
  };
  record('2: process_upload answered, and not with a CPU kill',
    processed.status === 200 && processed.json?.success !== false,
    `HTTP ${processed.status} in ${processed.ms} ms${processed.status === 546 ? ' — 546 CPU TIME EXCEEDED' : ''}`
    + (processed.json?.still_importing ? ', handed to a successor' : ''),
    { runtime: true });

  // --- 3. IT FINISHES ITSELF -------------------------------------------
  let upload = null;
  const transitions = [];
  while (Date.now() - acceptedAt < IMPORT_DEADLINE_MS) {
    upload = await uploadOf(proofId);
    const pages = upload?.ocr?.pages ? Object.keys(upload.ocr.pages).length : 0;
    const shape = `${upload?.status}/${upload?.continuations ?? 0}/${pages}/${upload?.claimed}`;
    if (transitions.at(-1)?.shape !== shape) transitions.push({ shape, at: Date.now() - acceptedAt });
    if (upload?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(upload.status)) break;
    await sleep(1_500);
  }
  summary.transitions = transitions;
  summary.stageTimings = upload?.stage_timings ?? null;
  record('3: the import finished by itself',
    !!upload?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(upload?.status),
    `status ${upload?.status}, strategy ${upload?.parse_strategy}, `
    + `${transitions.at(-1)?.at ?? '—'} ms after it was accepted`,
    { runtime: true });
  record('3: no worker died and none was recovered, and the claim was handed back',
    Number(upload?.import_recovery_attempts ?? -1) === 0 && upload?.claimed === false,
    `recovery attempts ${upload?.import_recovery_attempts}, continuations ${upload?.continuations ?? 0}`,
    { runtime: true });

  // --- 4. WHAT RECOGNITION DID -----------------------------------------
  const ocr = upload?.ocr ?? null;
  const recognisedPages = ocr?.pages ? Object.keys(ocr.pages).map(Number).sort((a, b) => a - b) : [];
  summary.ocr = {
    unavailable: ocr?.unavailable === true,
    recognised: recognisedPages,
    refused: ocr?.refused ?? [],
    chars: ocr?.pages ? Object.values(ocr.pages).map((text) => String(text).length) : [],
  };
  const timings = upload?.stage_timings ?? {};
  record('4: the recogniser came up on the hosted runtime', ocr ? ocr.unavailable !== true : false,
    ocr?.unavailable === true
      ? 'the checkpoint records the recogniser UNAVAILABLE in this deployment'
      : `recognised pages ${JSON.stringify(recognisedPages)}; last invocation `
        + `ocr ${timings.ocr_ms ?? '—'} ms, ${timings.ocr_pages ?? '—'} page(s), `
        + `${timings.rasterisations ?? '—'} rasterisation(s)`,
    { runtime: true });
  record(`4: every one of the ${FIXTURE.pages} pages was recognised`,
    JSON.stringify(recognisedPages) === JSON.stringify(Array.from({ length: FIXTURE.pages }, (_, i) => i + 1)),
    `recognised ${JSON.stringify(recognisedPages)}, refused ${JSON.stringify(ocr?.refused ?? [])}`,
    { runtime: true });
  /*
   * AND NONE OF THEM TWICE. Each recognition adds one to the import's
   * `ocr_pages` and one page to the checkpoint, and pages are never removed —
   * so the two agree exactly when no page was paid for twice.
   */
  record('4: no page was recognised twice, and none was lost',
    Number(timings.ocr_pages ?? -1) === recognisedPages.length
      && Number(timings.ocr_attempted ?? -1) === recognisedPages.length
      && !(ocr?.lost ?? []).length && !(ocr?.begun ?? []).length,
    `ocr_pages ${timings.ocr_pages ?? '—'}, ocr_attempted ${timings.ocr_attempted ?? '—'}, `
    + `rasterisations ${timings.rasterisations ?? '—'}, located ${timings.ocr_located ?? '—'}, `
    + `lost ${JSON.stringify(ocr?.lost ?? [])}`,
    { runtime: true });

  // --- 5. THE PROPERTY THE DOCUMENT STATES ------------------------------
  const items = await itemsOf(proofId);
  summary.items = items.map((i) => ({
    lot: i.lot_number, address: i.address_line, suburb: i.suburb, state: i.state, postcode: i.postcode,
    design: i.house_design, bed: i.bedrooms, bath: i.bathrooms, car: i.car_spaces,
    land: i.land_size_sqm, build: i.building_size_sqm, price: i.price,
  }));
  record('5: exactly one property, and not a second copy of it', items.length === 1,
    `${items.length} propert${items.length === 1 ? 'y' : 'ies'}`, { runtime: true });
  const differences = propertyDifferences(items[0]);
  record('5: the property the document states, field by field', differences.length === 0,
    differences.length ? differences.join('; ') : 'lot 57, Heathland Avenue, Tarneit VIC 3029, '
      + 'Aster 22, 4/2/2, 392 m² land, 207 m² home, $689,000',
    { runtime: true });
  const images = await imagesOf(proofId);
  record('5: no picture stored twice', new Set(images.map((i) => `${i.source_reference}|${i.byte_size}|${i.role}`)).size === images.length,
    `${images.length} image row(s)`, { runtime: true });

  // --- 6. THE RUNTIME'S OWN ACCOUNT -------------------------------------
  const windowEnd = Date.now() + 5_000;
  const functionLog = await logLines('function_logs', proofId, windowStart, windowEnd);
  const engineLog = await logLines('function_logs', 'ocr engine unavailable', windowStart, windowEnd);
  const edgeLog = await logLines('function_edge_logs', 'builder-portal-stock', windowStart, windowEnd);
  summary.logsRead = { function: functionLog.ok, engine: engineLog.ok, edge: edgeLog.ok };
  if (engineLog.ok) {
    summary.engineRefusals = engineLog.lines.map((line) => line.replace(/\s+/g, ' ').slice(0, 400));
    console.log(`  log  engine refusals in the window: ${engineLog.lines.length}`);
    for (const line of summary.engineRefusals) console.log(`       ${line}`);
  } else {
    console.log(`  note  the engine log could not be read: ${engineLog.why}`);
  }
  if (functionLog.ok) {
    /*
     * RECOGNITION'S OWN HAND-OFFS, and only those: the reader's picture
     * hand-off that follows them is a different crossing, carries no page
     * count, and a figure line's `figures_recognised` would read as one.
     */
    const allHandOffs = functionLog.lines.filter((line) => line.includes('import handed to a successor'));
    const handOffs = allHandOffs.filter((line) => /reason:\s*["']ocr_outstanding["']/.test(line));
    const numberIn = (line, key) => Number((new RegExp(`[^_a-z]${key}:\\s*(\\d+)`).exec(line) ?? [])[1] ?? NaN);
    const recognisedSeq = handOffs.map((line) => numberIn(line, 'recognised'));
    const hereSeq = handOffs.map((line) => numberIn(line, 'recognised_here'));
    const ocrMs = handOffs.map((line) => numberIn(line, 'ocr_ms')).filter(Number.isFinite);
    summary.handOffs = allHandOffs.map((line) => line.replace(/\s+/g, ' ').slice(0, 300));
    summary.recognitionMsPerIsolate = ocrMs;
    console.log(`  log  recognition hand-offs: ${handOffs.length}, recognised after each: `
      + `${JSON.stringify(recognisedSeq)}, recognised in each: ${JSON.stringify(hereSeq)}, `
      + `recognition ms in each: ${JSON.stringify(ocrMs)}`);
    record('6: each crossing recognised a page none before it had',
      recognisedSeq.length > 0
      && recognisedSeq.every((n, i) => Number.isFinite(n) && (i === 0 || n > recognisedSeq[i - 1])),
      JSON.stringify(recognisedSeq), { runtime: true });
    /*
     * THE ISOLATE THAT PARSED THE DOCUMENT RECOGNISED NOTHING, AND EVERY ONE
     * AFTER IT ONE PAGE. The first hand-off is the parse's — it located the
     * pages, so it carries no `recognised_here` — and each after it is a
     * recognition isolate's, which parses nothing (`runImport.ts`).
     */
    record('6: the isolate that parsed the document recognised none of it, and each after it one page',
      handOffs.length === FIXTURE.pages + 1
      && recognisedSeq[0] === 0 && !Number.isFinite(hereSeq[0])
      && hereSeq.slice(1).every((n) => n === 1),
      `${handOffs.length} recognition hand-off(s): recognised ${JSON.stringify(recognisedSeq)}, `
      + `in each ${JSON.stringify(hereSeq)}`,
      { runtime: true });
  } else {
    console.log(`  note  the function log could not be read: ${functionLog.why}`);
  }
  if (edgeLog.ok) {
    const statuses = edgeLog.lines.map((line) => (/\|\s*(\d{3})\s*\|/.exec(line) ?? [])[1]).filter(Boolean);
    summary.edgeStatuses = statuses;
    record('6: no invocation was killed for CPU', !statuses.includes('546'),
      `builder-portal-stock answered ${JSON.stringify(statuses)}`, { runtime: true });
  } else {
    console.log(`  note  the edge log could not be read: ${edgeLog.why}`);
  }
  /*
   * WHAT EACH INVOCATION TOOK, AND WHICH DEPLOYED BUILD SERVED IT — read, not
   * asserted: the runtime's own execution time per call, and the function
   * version, so the proof says which build it proved.
   */
  const invocations = await edgeInvocations('builder-portal-stock', windowStart, windowEnd);
  if (invocations.ok) {
    summary.invocations = invocations.rows;
    console.log(`  log  builder-portal-stock invocations: ${invocations.rows.length}`);
    for (const row of invocations.rows) {
      console.log(`       ${row.status}  ${row.execution_time_ms} ms  version ${row.version}`);
    }
  } else {
    console.log(`  note  the invocation log could not be read: ${invocations.why}`);
  }

  // --- 7. NOTHING STRANDED, AND NOTHING MOVES AFTERWARDS ------------------
  if (EXPECT === 'read') {
    const before = JSON.stringify({
      items: items.map((i) => [i.id, i.lifecycle_status, i.primary_image_id]),
      images: images.map((i) => i.id), status: upload?.status,
    });
    await sleep(SETTLEMENT_WINDOW_MS);
    const later = await uploadOf(proofId);
    const laterItems = await itemsOf(proofId);
    const laterImages = await imagesOf(proofId);
    const after = JSON.stringify({
      items: laterItems.map((i) => [i.id, i.lifecycle_status, i.primary_image_id]),
      images: laterImages.map((i) => i.id), status: later?.status,
    });
    record('7: after a recovery window nothing moved', before === after,
      before === after ? `${SETTLEMENT_WINDOW_MS / 1000} s` : `before ${before.slice(0, 300)} after ${after.slice(0, 300)}`);
    record('7: nothing stranded — no claim held, no worker recovered, no pending patch',
      later?.claimed === false && Number(later?.import_recovery_attempts ?? -1) === 0
      && laterItems.every((i) => !i.has_pending_patch && !i.pending_upload_id),
      `claimed ${later?.claimed}, recovery ${later?.import_recovery_attempts}, status ${later?.status}`);
  }
} catch (error) {
  record('the proof ran to its end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end', storage);
    const [left] = await q('what remains', `
      SELECT (SELECT count(*) FROM public.builder_organisations
               WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS orgs,
             (SELECT count(*) FROM public.builder_portal_users
               WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users`);
    record('cleanup: nothing of this run remains',
      Number(left?.orgs) === 0 && Number(left?.users) === 0, `orgs ${left?.orgs}, users ${left?.users}`);
  } catch (error) {
    record('cleanup: nothing of this run remains', false, String(error?.message ?? error).slice(0, 200));
  }
}

console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
const failed = results.filter((r) => r.required && !r.ok);
console.log(`${results.length - failed.length} of ${results.length} passed (mode ${EXPECT})`);
process.exit(failed.length ? 1 : 0);
