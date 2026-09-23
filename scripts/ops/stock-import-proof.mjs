#!/usr/bin/env node
/**
 * ===========================================================================
 * A REAL STORED DOCUMENT, IMPORTED BY THE LIVE PRODUCT, WITH NOBODY IN THE LOOP.
 * ===========================================================================
 *
 * The acceptance gate proves the importer on a real PostgreSQL, a real
 * PostgREST and real Deno — and still on this repository's own machine. What
 * killed a worker on 22 September was PRODUCTION's CPU allowance, measured
 * against a real customer brochure. So the proof that it no longer does is
 * that brochure, imported by the deployed product, the way a builder imports
 * it: `create_upload`, the file PUT to the signed URL, `process_upload` —
 * exactly the three requests `uploadBuilderStockFile` makes — and then
 * NOTHING. No re-read while it runs, no nudge, no SQL pushing a stage:
 * whatever finishes the import after that call is the product's own dispatch,
 * continuation, settler and tick, which is the claim under test. (The re-read
 * in 6 is a second path under test, begun only after the first has finished.)
 *
 * THE SOURCE IS READ, NEVER WRITTEN. It is fetched with GET and its bytes must
 * hash to the `file_sha256` its upload recorded, so what is imported is
 * provably the stored document and not a copy that drifted. It is imported
 * into an organisation of this run's own, named `Smoke Rollout import-proof
 * <run>` so the smoke run's own sweep recognises anything this one leaves,
 * and every row and object it creates is deleted before it exits.
 *
 * WHAT IT ASSERTS, each by reading the rows the product wrote:
 *   1. the stored bytes are the recorded bytes;
 *   2. `process_upload` answered — not 546, not a hang — and said what it did;
 *   3. the import FINISHED ITSELF: completed, stamped, counted, with no worker
 *      recovered (`import_recovery_attempts` 0) and the claim handed back;
 *   4. it read the lot the document states. The source PROPERTY is reported
 *      field by field but not held to equality: a property can predate the
 *      document that last updated it (LOT 550's was created from a linked
 *      stock list two days before the brochure updated it), so its fields
 *      are a merge the brochure alone need not reproduce;
 *   5. the settler finished the pictures: the same pictures by reference,
 *      size and role as the source UPLOAD's own, none twice, and a
 *      photograph on the card;
 *   6. a re-read of the proof's own upload — begun only once the first read
 *      had finished and settled, so it rescues nothing — corrects its own
 *      rows rather than forking them: the same property ids, the same
 *      reading, the same pictures, no pending patch;
 *   7. and after a recovery window nothing moved — no second worker, no new
 *      row, no status change.
 *
 * Runs from the production-rollout workflow (phase `stock-import-proof`),
 * which holds SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER. No secret is
 * printed.
 *
 *   PROOF_UPLOAD_ID=<uuid of the stored source> node scripts/ops/stock-import-proof.mjs
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const SOURCE_UPLOAD_ID = String(process.env.PROOF_UPLOAD_ID || '').trim();
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'import-proof';
const STOCK_LIST_BUCKET = 'builder-stock-lists';
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
/** The fields a property is compared on: what the document states. */
const COMPARED = [
  'lot_number', 'unit_number', 'address_line', 'suburb', 'state', 'postcode',
  'development_name', 'project_name', 'property_type', 'bedrooms', 'bathrooms',
  'car_spaces', 'land_size_sqm', 'building_size_sqm', 'price', 'price_display',
];
const IMPORT_DEADLINE_MS = 5 * 60_000;
const IMAGERY_DEADLINE_MS = 12 * 60_000;
/** Longer than a recovery grace (60 s) plus a tick (60 s): what would have moved, has. */
const SETTLEMENT_WINDOW_MS = 150_000;

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }
if (!/^[0-9a-f-]{36}$/i.test(SOURCE_UPLOAD_ID)) {
  console.error('PROOF_UPLOAD_ID must be the uuid of the stored source to import');
  process.exit(2);
}

const results = [];
function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, detail, required });
  console.log(`  ${ok ? 'PASS' : required ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
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
  // A connection's audit events hold it with NO ACTION, so they go first; the
  // rest cascade from the organisation: uploads, items, images, memberships.
  await q(`${stage}: rows`, `
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`)}
    DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};`);
}

/**
 * NEVER CONNECTED TO A REAL WORKSPACE.
 *
 * MEASURED 23 September 2026, on this script's first production run: an
 * ACTIVE builder organisation is provisioned onto every `whole_network`
 * workspace by `builder_organisation_activated` the moment it is inserted, so
 * the proof's organisation was connected to the NPC prime's Command Centre
 * and eight stock events — the proof's own test property among them — were
 * delivered into a real workspace's mirror. They were retracted by hand from
 * both sides the same morning. This removes, in the SAME transaction as the
 * insert that provisioned them, every connection the organisation was given
 * and everything queued on it, so nothing is ever committed that the outbox
 * worker could send.
 */
function detachFromNetwork(orgIdsSql) {
  const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql})`;
  /*
   * AND THE ANNOUNCEMENT, WHICH IS NOT ON THE ORGANISATION'S OWN CONNECTION.
   * `builder_network_provision_connections` queues `connection.authorised` on
   * the WORKSPACE's existing transport — another builder's live connection —
   * keyed `connection.authorised:<new connection id>`. On the first run it was
   * delivered nine seconds after the insert and the workspace installed a
   * connection for the proof organisation from it. It is deleted by that key,
   * before the connections whose ids the key is made of.
   */
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

async function seedUser() {
  const email = `${MARK}-${TAG}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!import`;
  const orgName = `Smoke Rollout ${TAG} ${RUN}`;
  /*
   * ONE SIMPLE QUERY IS ONE TRANSACTION, and that is what makes the detach
   * safe: the connections the insert's trigger provisions, and the catalogue
   * reconciliation it queues on them, are deleted before anything commits —
   * so the outbox worker can never see them. The last statement's rows are
   * the answer.
   */
  const rows = await q('seed user', `
    WITH org AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now())
      RETURNING id
    ), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, 'Import Proof', 'active', true, now(), false,
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

const itemsOf = (uploadId) => q('items', `
  SELECT id, ${COMPARED.join(', ')}, source_row->>'house_design' AS house_design,
         lifecycle_status, image_work_stage, image_work_failures, primary_image_id,
         pending_patch IS NOT NULL AS has_pending_patch, pending_upload_id
    FROM public.builder_stock_items WHERE upload_id = ${sqlLit(uploadId)}
   ORDER BY lot_number, id`);
const imagesOf = (uploadId) => q('images', `
  SELECT id, stock_item_id, source_reference, byte_size, processing_status, source_stage,
         source_detail->>'role' AS role,
         source_detail->>'marketplace_eligibility_state' AS eligibility
    FROM public.builder_stock_item_images WHERE upload_id = ${sqlLit(uploadId)}
   ORDER BY source_reference, id`);
const uploadOf = (uploadId) => q('upload', `
  SELECT status, records_detected, records_imported, processing_started_at,
         processing_completed_at, published_at, error_code,
         import_claim_token IS NOT NULL AS claimed, import_recovery_attempts,
         (import_checkpoint->>'continuations')::int AS continuations,
         (import_checkpoint->'pictures'->>'crossings')::int AS picture_crossings,
         stage_timings
    FROM public.builder_stock_uploads WHERE id = ${sqlLit(uploadId)}`).then((rows) => rows[0] ?? null);
const pictureKey = (row) => `${row.source_reference}|${row.byte_size}|${row.role ?? ''}`;
/** Where two readings of the same lots disagree, field by field. */
function fieldDifferences(wantRows, haveRows) {
  const out = [];
  const byLot = new Map(haveRows.map((row) => [String(row.lot_number), row]));
  for (const want of wantRows) {
    const have = byLot.get(String(want.lot_number));
    if (!have) { out.push(`lot ${want.lot_number}: missing`); continue; }
    for (const field of [...COMPARED, 'house_design']) {
      const a = want[field] === null || want[field] === undefined ? null : String(want[field]);
      const b = have[field] === null || have[field] === undefined ? null : String(have[field]);
      if (a !== b) out.push(`${want.lot_number}.${field}: ${JSON.stringify(b)} (was ${JSON.stringify(a)})`);
    }
  }
  return out;
}

let storage = null;
const summary = { run: RUN, source: SOURCE_UPLOAD_ID };
try {
  console.log(`stock import proof run=${RUN} source=${SOURCE_UPLOAD_ID} origin=${ORIGIN}`);
  storage = await storageAuth();
  await cleanup('start', storage);

  // --- 1. THE SOURCE, READ AND NEVER WRITTEN ----------------------------
  const [source] = await q('source', `
    SELECT id, original_filename, storage_bucket, storage_path, byte_size, file_sha256,
           declared_content_type, source_type, records_detected
      FROM public.builder_stock_uploads
     WHERE id = ${sqlLit(SOURCE_UPLOAD_ID)} AND deleted_at IS NULL`);
  if (!source) throw new Error('the source upload does not exist or is deleted');
  const got = await fetch(
    `${storage.base}/object/${source.storage_bucket}/${source.storage_path}`, { headers: storage.headers });
  if (!got.ok) throw new Error(`the stored source could not be read: HTTP ${got.status}`);
  const bytes = new Uint8Array(await got.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  summary.bytes = bytes.length;
  record('1: the stored bytes are the recorded bytes',
    sha === source.file_sha256 && bytes.length === Number(source.byte_size),
    `${bytes.length} bytes, sha256 ${sha.slice(0, 16)}…`);
  const sourceItems = await itemsOf(source.id);
  const sourceImages = await imagesOf(source.id);

  // --- 2. THE THREE REQUESTS A BUILDER'S BROWSER MAKES ------------------
  const user = await seedUser();
  const cookie = await establishSession(user);
  const accepted = await call('builder-portal-verify',
    { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
  const onboarded = await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
  record('2: the proof builder is through governance',
    accepted.status === 200 && onboarded.json?.onboarding_complete === true,
    `terms ${accepted.status}, onboarding ${onboarded.status}`);

  const contentType = source.declared_content_type || 'application/pdf';
  const created = await call('builder-portal-stock', {
    operation: 'create_upload', filename: source.original_filename,
    content_type: contentType, byte_size: bytes.length,
  }, cookie);
  const proofId = created.json?.upload?.id;
  if (created.status !== 200 || !proofId || !created.json?.signed_url) {
    throw new Error(`create_upload answered ${created.status}: ${created.text}`);
  }
  summary.proofUploadId = proofId;
  const put = await fetch(created.json.signed_url, {
    method: 'PUT', headers: { 'content-type': contentType }, body: bytes,
  });
  if (!put.ok) throw new Error(`the signed upload answered ${put.status}`);

  const acceptedAt = Date.now();
  const processed = await call('builder-portal-stock',
    { operation: 'process_upload', upload_id: proofId }, cookie);
  summary.processUpload = {
    status: processed.status, ms: processed.ms,
    stillImporting: processed.json?.still_importing === true,
    detected: processed.json?.summary?.detected ?? null,
    code: processed.json?.code ?? null,
  };
  record('2: process_upload answered, and not with a CPU kill',
    processed.status === 200 && processed.json?.success !== false,
    `HTTP ${processed.status} in ${processed.ms} ms${processed.status === 546 ? ' — 546 CPU TIME EXCEEDED' : ''}`
    + (processed.json?.still_importing ? ', handed to a successor' : ''));

  // --- 3. IT FINISHES ITSELF -------------------------------------------
  let upload = null;
  const transitions = [];
  while (Date.now() - acceptedAt < IMPORT_DEADLINE_MS) {
    upload = await uploadOf(proofId);
    const shape = `${upload?.status}/${upload?.continuations ?? 0}/${upload?.picture_crossings ?? 0}/${upload?.claimed}`;
    if (transitions.at(-1)?.shape !== shape) transitions.push({ shape, at: Date.now() - acceptedAt });
    if (upload?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(upload.status)) break;
    await sleep(2_000);
  }
  summary.importTransitions = transitions;
  summary.importFinishedMs = upload?.processing_completed_at ? transitions.at(-1)?.at ?? null : null;
  summary.stageTimings = upload?.stage_timings ?? null;
  record('3: the import finished by itself',
    !!upload?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(upload?.status),
    `status ${upload?.status}, ${summary.importFinishedMs ?? '—'} ms after it was accepted`);
  record('3: with the count the source records',
    Number(upload?.records_detected ?? -1) === Number(source.records_detected ?? -2),
    `records_detected ${upload?.records_detected} (source ${source.records_detected})`);
  record('3: no worker died and none was recovered, and the claim was handed back',
    Number(upload?.import_recovery_attempts ?? -1) === 0 && upload?.claimed === false,
    `recovery attempts ${upload?.import_recovery_attempts}, continuations ${upload?.continuations ?? 0}, `
    + `picture crossings ${upload?.picture_crossings ?? 0}`);

  // --- 4. THE LOT THE DOCUMENT STATES ---------------------------------
  let items = await itemsOf(proofId);
  record('4: it read the properties the source records, by lot',
    JSON.stringify(items.map((i) => i.lot_number).sort())
      === JSON.stringify(sourceItems.map((i) => i.lot_number).sort()),
    `lots ${items.map((i) => i.lot_number).join(', ')} (source ${sourceItems.map((i) => i.lot_number).join(', ')})`);
  const differences = fieldDifferences(sourceItems, items);
  record('4: against the source property, field by field', differences.length === 0,
    differences.length ? differences.slice(0, 8).join('; ') : 'identical', { required: false });

  // --- 5. THE SETTLER FINISHES THE PICTURES ------------------------------
  while (Date.now() - acceptedAt < IMAGERY_DEADLINE_MS) {
    items = await itemsOf(proofId);
    if (items.length && items.every((i) => ['settled', 'failed'].includes(i.image_work_stage))) break;
    await sleep(3_000);
  }
  summary.imagerySettledMs = Date.now() - acceptedAt;
  const images = await imagesOf(proofId);
  const want = sourceImages.map(pictureKey).sort();
  const have = images.map(pictureKey).sort();
  const withPhotograph = items.filter((i) => i.primary_image_id).length;
  record('5: the settler finished every property\'s pictures',
    items.length > 0 && items.every((i) => i.image_work_stage === 'settled'),
    items.map((i) => `${i.lot_number}:${i.image_work_stage}`).join(', '));
  /*
   * WHAT THE PICTURES MUST BE, stated as structure rather than as equality
   * with the source upload. The source was read by the code of its own day —
   * LOT 550's was imported on 22 September — so its rows describe that
   * reading, and holding this run to them would fail a correct import for
   * being newer. What must hold of ANY correct reading of this document:
   * nothing twice, nothing attached to a property of any other upload, and on
   * every card that should carry one a photograph taken from the builder's
   * own document, ready to draw.
   */
  const itemIds = new Set(items.map((i) => i.id));
  const attributed = images.filter((i) => i.stock_item_id);
  const primaries = items.map((i) => images.find((image) => image.id === i.primary_image_id))
    .filter(Boolean);
  record('5: no picture twice, and none on a property of another upload',
    new Set(have).size === have.length && attributed.every((i) => itemIds.has(i.stock_item_id)),
    `${images.length} image rows, ${attributed.length} attributed`);
  record('5: a photograph on every card the source has one on',
    withPhotograph === sourceItems.filter((i) => i.primary_image_id).length,
    `${withPhotograph} of ${items.length}`);
  record('5: each card\'s photograph came out of the builder\'s own document, ready to draw',
    primaries.length === withPhotograph
    && primaries.every((image) => image.source_stage === 'uploaded_document'
      && image.processing_status === 'ready' && image.role === 'primary_property'),
    primaries.map((image) => `${image.source_reference} ${image.role} ${image.eligibility ?? '—'}`).join('; ')
      || 'none');
  record('5: the same pictures as the source upload, by reference, size and role',
    JSON.stringify(want) === JSON.stringify(have),
    `${images.length} image rows (source ${sourceImages.length})`, { required: false });

  // --- 6. A RE-READ CORRECTS ITS OWN ROWS --------------------------------
  const firstReading = items.map((i) => ({ ...i }));
  const firstPictures = images.map(pictureKey).sort();
  const reread = await call('builder-portal-stock',
    { operation: 'reprocess_upload', upload_id: proofId }, cookie);
  summary.reread = { status: reread.status, ms: reread.ms, stillImporting: reread.json?.still_importing === true };
  record('6: the re-read answered, and not with a CPU kill',
    reread.status === 200 && reread.json?.success !== false,
    `HTTP ${reread.status} in ${reread.ms} ms${reread.status === 546 ? ' — 546 CPU TIME EXCEEDED' : ''}`);
  const rereadAt = Date.now();
  while (Date.now() - rereadAt < IMPORT_DEADLINE_MS) {
    upload = await uploadOf(proofId);
    items = await itemsOf(proofId);
    if (upload?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(upload.status)
      && items.every((i) => ['settled', 'failed'].includes(i.image_work_stage))) break;
    await sleep(3_000);
  }
  const rereadImages = await imagesOf(proofId);
  record('6: the re-read corrected its own rows rather than forking them',
    JSON.stringify(items.map((i) => i.id).sort()) === JSON.stringify(firstReading.map((i) => i.id).sort()),
    `${items.length} propert${items.length === 1 ? 'y' : 'ies'}, same ids: `
    + String(JSON.stringify(items.map((i) => i.id).sort()) === JSON.stringify(firstReading.map((i) => i.id).sort())));
  const rereadDifferences = fieldDifferences(firstReading, items);
  record('6: the re-read read the same document', rereadDifferences.length === 0,
    rereadDifferences.length ? rereadDifferences.slice(0, 6).join('; ') : 'field for field');
  record('6: the same pictures after the re-read, none twice',
    JSON.stringify(rereadImages.map(pictureKey).sort()) === JSON.stringify(firstPictures)
    && new Set(rereadImages.map(pictureKey)).size === rereadImages.length,
    `${rereadImages.length} image rows`);

  // --- 7. AND NOTHING MOVES AFTERWARDS -----------------------------------
  const before = JSON.stringify({
    items: items.map((i) => [i.id, i.primary_image_id, i.lifecycle_status, i.image_work_stage]),
    images: rereadImages.map((i) => i.id), status: upload?.status,
  });
  await sleep(SETTLEMENT_WINDOW_MS);
  const laterUpload = await uploadOf(proofId);
  const laterItems = await itemsOf(proofId);
  const laterImages = await imagesOf(proofId);
  const after = JSON.stringify({
    items: laterItems.map((i) => [i.id, i.primary_image_id, i.lifecycle_status, i.image_work_stage]),
    images: laterImages.map((i) => i.id), status: laterUpload?.status,
  });
  record('7: after a recovery window nothing moved', before === after,
    before === after ? `${SETTLEMENT_WINDOW_MS / 1000} s` : 'rows changed after the import had finished');
  record('7: no second worker, no pending patch',
    Number(laterUpload?.import_recovery_attempts ?? -1) === 0 && laterUpload?.claimed === false
    && laterItems.every((i) => !i.has_pending_patch && !i.pending_upload_id),
    `recovery ${laterUpload?.import_recovery_attempts}, pending ${laterItems.filter((i) => i.has_pending_patch).length}`);
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
console.log(`${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
