#!/usr/bin/env node
/**
 * ===========================================================================
 * "USE BROCHURE IMAGE", PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * The question this answers is whether the deployed product does what the
 * acceptance gate says it does, end to end, through the same requests a
 * builder's browser makes and the same settler, worker and database the
 * builder's properties go through:
 *
 *   1. A row whose OWN brochure mistypes its lot on the cover is refused as
 *      "Brochure details don't match this property", and the builder is
 *      offered "Use brochure image".
 *   2. A row linking a SIBLING's brochure — one another listing already uses
 *      the photograph of — is not offered the choice, is told which listing
 *      the brochure belongs to, and a confirmation sent anyway is refused
 *      with nothing recorded.
 *   3. Confirming the builder's own brochure puts THAT brochure's photograph
 *      on the card, stamped with the confirmation, with the display checks
 *      applied as for any picture.
 *   4. Undoing it takes the photograph down at once and the settler brings
 *      the mismatch notice back.
 *
 * THE DOCUMENTS ARE THE GATE'S OWN. `SALTBUSH RISE`, drawn with reportlab's
 * invariant switch (`make-confirmation-proof-fixtures.py`), pinned by digest,
 * nothing in them any customer's. They are served from this project's own
 * storage under a signed link that ends `.pdf`, which is how a builder's
 * shared link to one document reaches the settler.
 *
 * ISOLATED. Everything happens in an organisation of this run's own, named
 * `Smoke Rollout brochure-confirm <run>` and detached from the network in the
 * transaction that creates it (see `detachFromNetwork`), so nothing it holds
 * can reach a workspace. Every row and object it creates is deleted before it
 * exits. It writes nothing anywhere else.
 *
 * Runs from the production-rollout workflow (phase `stock-confirmation-proof`),
 * which holds SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER. No secret is
 * printed.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'brochure-confirm';
const STOCK_LIST_BUCKET = 'builder-stock-lists';
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const BUILDER_NAME = 'Confirmation Proof';

/** THE FIXTURES, PINNED. A file that does not hash to this is not sent. */
const FIXTURES = {
  own: {
    path: new URL('./fixtures/saltbush-lot-2046-own-brochure.pdf', import.meta.url),
    object: 'lot-2046-orion-22-brochure.pdf',
    bytes: 85_381,
    sha256: '9784159485b4a232b2971fc905ae4f624ee2c9f9ee1519e83326401b289b2db9',
  },
  sibling: {
    path: new URL('./fixtures/saltbush-lot-3185-brochure.pdf', import.meta.url),
    object: 'lot-3185-halo-24-brochure.pdf',
    bytes: 81_605,
    sha256: '8123d54b6ad48d6bcd8f0d40e3b72ac2205191e6d40a9b5a27a5bab054ce6259',
  },
};
/** The photographs drawn into each, told apart by their size. */
const OWN_PHOTO = '1320x820';
const SIBLING_PHOTO = '1200x760';

/** A property's picture work, from the minute tick. Generous: this is a proof, not a race. */
const SETTLE_DEADLINE_MS = 12 * 60_000;
const POLL_MS = 5_000;

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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

/** The project's storage, with the service key the workflow's token can reveal. */
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
 * NEVER CONNECTED TO A REAL WORKSPACE — `stock-import-proof.mjs`' rule: an
 * active builder organisation is provisioned onto every `whole_network`
 * workspace the moment it is inserted, so the connections and everything
 * queued on them are removed in the SAME transaction as the insert.
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

const ORG_PATTERN = sqlLit(`Smoke Rollout ${TAG} %`);

async function cleanup(stage, storage) {
  const orgs = await q(`${stage}: this proof's organisations`, `
    SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}`);
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
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}`)}
    DELETE FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};`);
}

async function seedUser() {
  const email = `${MARK}-${TAG}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!confirm`;
  const orgName = `Smoke Rollout ${TAG} ${RUN}`;
  const rows = await q('seed user', `
    WITH org AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now())
      RETURNING id
    ), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(BUILDER_NAME)}, 'active', true, now(), false,
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

/** Put a fixture in this organisation's own folder and hand back a link to it. */
async function publishFixture(storage, orgId, fixture) {
  const bytes = new Uint8Array(readFileSync(fixture.path));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== fixture.sha256 || bytes.length !== fixture.bytes) {
    throw new Error(`refusing a fixture that is not the pinned one: ${fixture.object}`);
  }
  const path = `stock-lists/${orgId}/brochures/${fixture.object}`;
  const put = await fetch(`${storage.base}/object/${STOCK_LIST_BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...storage.headers, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`storing ${fixture.object} answered ${put.status}`);
  const signed = await fetch(`${storage.base}/object/sign/${STOCK_LIST_BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...storage.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3 * 60 * 60 }),
  });
  const body = await signed.json().catch(() => ({}));
  const relative = body?.signedURL ?? body?.signedUrl;
  if (!signed.ok || !relative) throw new Error(`signing ${fixture.object} answered ${signed.status}`);
  const url = `${storage.base}${relative.startsWith('/') ? '' : '/'}${relative}`;
  if (!new URL(url).pathname.endsWith('.pdf')) throw new Error(`the signed link does not end .pdf: ${fixture.object}`);
  return url;
}

const itemsOf = (orgId) => q('items', `
  SELECT id, lot_number, lifecycle_status, image_work_stage, primary_image_id
    FROM public.builder_stock_items
   WHERE organisation_id = ${sqlLit(orgId)}
   ORDER BY lot_number, id`);
const imageOf = (imageId) => q('image', `
  SELECT id, processing_status,
         (source_detail->>'source_width') || 'x' || (source_detail->>'source_height') AS size,
         source_detail->>'role' AS role,
         source_detail->>'marketplace_eligibility_state' AS eligibility,
         source_detail->'identity_confirmation'->>'id' AS confirmation
    FROM public.builder_stock_item_images WHERE id = ${sqlLit(imageId)}`).then((rows) => rows[0] ?? null);
const confirmationsOf = (itemId) => q('confirmations', `
  SELECT id, confirmed_lot, confirmed_by_name, withdrawn_at IS NOT NULL AS withdrawn
    FROM public.builder_stock_identity_confirmations
   WHERE stock_item_id = ${sqlLit(itemId)} ORDER BY confirmed_at`);
const stampedImagesOf = (itemId, confirmationId) => q('stamped images', `
  SELECT id, processing_status FROM public.builder_stock_item_images
   WHERE stock_item_id = ${sqlLit(itemId)}
     AND source_detail->'identity_confirmation'->>'id' = ${sqlLit(confirmationId)}`);

const TERMINAL = ['settled', 'failed'];

/*
 * WHAT THE ROWS SAID WHEN A WAIT RAN OUT, PRINTED BEFORE CLEANUP DELETES THEM.
 *
 * Run 36013693485 waited twelve minutes, printed `lot 2046 source` three times
 * and then deleted the only evidence of why. The rows would have said it in
 * the first minute: the brochure link the import stored was 300 characters of
 * the 488 sent, and every branch was being refused as a fault on our side.
 * So a wait that ends undone prints each property's work state, each branch's
 * stored answer (by host, never by link), and the minute job's recent runs.
 */
async function explainStall(orgId, label) {
  console.log(`\n  -- why "${label}" did not finish: what the rows say --`);
  try {
    const rows = await q('stalled items', `
      SELECT lot_number, lifecycle_status, image_work_stage, image_work_attempts,
             image_work_failures, image_work_next_attempt_at, image_work_claim_until,
             left(coalesce(image_work_last_result::text, ''), 300) AS last_result,
             left(coalesce(image_work_last_error::text, ''), 300) AS last_error,
             primary_image_id IS NOT NULL AS has_primary,
             source_provenance_result->'branches' AS branches
        FROM public.builder_stock_items
       WHERE organisation_id = ${sqlLit(orgId)} ORDER BY lot_number`);
    for (const row of rows) {
      console.log(`  lot ${row.lot_number}: ${row.lifecycle_status}/${row.image_work_stage}`
        + ` attempts ${row.image_work_attempts} failures ${row.image_work_failures}`
        + ` next ${row.image_work_next_attempt_at} claim ${row.image_work_claim_until}`
        + ` primary ${row.has_primary ? 'yes' : 'no'}`);
      if (row.last_result) console.log(`    last result: ${row.last_result}`);
      if (row.last_error) console.log(`    last error: ${row.last_error}`);
      for (const [link, answer] of Object.entries(row.branches ?? {})) {
        let host = '?';
        try { host = new URL(link).hostname; } catch { /* not an address */ }
        const a = answer ?? {};
        console.log(`    branch ${host} (${link.length} chars): result ${a.result ?? '—'}`
          + ` provenance ${a.provenance_version ?? '—'} attempts ${a.attempts ?? '—'}`);
      }
    }
    const ticks = await q('recent ticks', `
      SELECT j.jobname, d.status, left(coalesce(d.return_message, ''), 160) AS message, d.start_time
        FROM cron.job_run_details d JOIN cron.job j USING (jobid)
       WHERE j.jobname IN ('settle-builder-stock-source-images',
                           'settle-builder-stock-marketplace-eligibility')
       ORDER BY d.start_time DESC LIMIT 6`);
    for (const tick of ticks) {
      console.log(`  tick ${tick.jobname} ${tick.status} at ${tick.start_time}: ${tick.message}`);
    }
  } catch (error) {
    console.log(`  (the rows could not be read: ${String(error?.message ?? error).slice(0, 200)})`);
  }
}

async function waitFor(label, check, deadlineMs = SETTLE_DEADLINE_MS) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < deadlineMs) {
    last = await check();
    if (last?.done) return { ...last, ms: Date.now() - startedAt };
    await sleep(POLL_MS);
  }
  return { ...(last ?? {}), done: false, ms: Date.now() - startedAt, timedOut: label };
}

let storage = null;
const summary = { run: RUN };
try {
  console.log(`stock confirmation proof run=${RUN} origin=${ORIGIN}`);
  storage = await storageAuth();
  await cleanup('start', storage);

  // --- 1. AN ORGANISATION OF ITS OWN, THROUGH GOVERNANCE ------------------
  const user = await seedUser();
  const cookie = await establishSession(user);
  const accepted = await call('builder-portal-verify',
    { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
  const onboarded = await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
  record('1: the proof builder is through governance, detached from every workspace',
    accepted.status === 200 && onboarded.json?.onboarding_complete === true,
    `terms ${accepted.status}, onboarding ${onboarded.status}`);

  // --- 2. THE STOCK LIST, AS A BUILDER SENDS IT ----------------------------
  const ownUrl = await publishFixture(storage, user.orgId, FIXTURES.own);
  const siblingUrl = await publishFixture(storage, user.orgId, FIXTURES.sibling);
  const csv = [
    'Lot,Design,Bed,Bath,Car,Land Size,Build Size,Price,Suburb,State,Postcode,Brochure URL',
    `2046,Orion 22,4,2,2,350,198,"$612,500",Wattlebank,VIC,3977,${ownUrl}`,
    `3158,Lumen 18,3,2,1,300,171,"$574,000",Wattlebank,VIC,3977,${siblingUrl}`,
    `3185,Halo 24,4,2,2,375,224,"$655,000",Wattlebank,VIC,3977,${siblingUrl}`,
  ].join('\n') + '\n';
  const csvBytes = new TextEncoder().encode(csv);
  const created = await call('builder-portal-stock', {
    operation: 'create_upload', filename: 'SALTBUSH RISE - STOCK LIST.csv',
    content_type: 'text/csv', byte_size: csvBytes.length,
  }, cookie);
  const uploadId = created.json?.upload?.id;
  if (created.status !== 200 || !uploadId || !created.json?.signed_url) {
    throw new Error(`create_upload answered ${created.status}: ${created.text}`);
  }
  const put = await fetch(created.json.signed_url, {
    method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csvBytes,
  });
  if (!put.ok) throw new Error(`the signed upload answered ${put.status}`);
  const processed = await call('builder-portal-stock',
    { operation: 'process_upload', upload_id: uploadId }, cookie);
  record('2: the stock list imported', processed.status === 200 && processed.json?.success !== false,
    `HTTP ${processed.status}, ${JSON.stringify(processed.json?.summary ?? {})}`);
  summary.uploadId = uploadId;

  /*
   * AND EVERY LINK ARRIVED WHOLE. A signed link is its own credential, so a
   * stored link that is a character short is a link nothing will answer — run
   * 36013693485 stored 300 of 488 and waited twelve minutes to find out.
   */
  const storedLinks = await q('stored links', `
    SELECT lot_number, source_row->'unmapped'->>'Brochure URL' AS link
      FROM public.builder_stock_items
     WHERE organisation_id = ${sqlLit(user.orgId)} ORDER BY lot_number`);
  const sentByLot = { 2046: ownUrl, 3158: siblingUrl, 3185: siblingUrl };
  record('2: every brochure link reached the database whole',
    storedLinks.length === 3 && storedLinks.every((row) => row.link === sentByLot[row.lot_number]),
    storedLinks.map((row) => `lot ${row.lot_number} ${String(row.link ?? '').length}`
      + ` of ${String(sentByLot[row.lot_number] ?? '').length} chars`).join(', '));

  // --- 3. THE SETTLER READS ALL THREE BROCHURES ----------------------------
  const settled = await waitFor('first settlement', async () => {
    const items = await itemsOf(user.orgId);
    return {
      items,
      done: items.length === 3 && items.every((i) => TERMINAL.includes(i.image_work_stage)),
    };
  });
  const lot = (n) => (settled.items ?? []).find((i) => String(i.lot_number) === n);
  summary.firstSettlementMs = settled.ms;
  record('3: three properties, each read to a conclusion', settled.done === true,
    (settled.items ?? []).map((i) => `lot ${i.lot_number} ${i.image_work_stage}`).join(', ')
    + ` after ${Math.round(settled.ms / 1000)} s`);
  if (!settled.done) {
    await explainStall(user.orgId, 'first settlement');
    throw new Error('the properties did not settle; nothing further can be proved');
  }
  const own = lot('2046');
  const sibling = lot('3158');
  const owner = lot('3185');
  const ownerImage = owner?.primary_image_id ? await imageOf(owner.primary_image_id) : null;
  record('3: Lot 3185 shows its own brochure\'s photograph',
    ownerImage?.size === SIBLING_PHOTO && ownerImage?.processing_status === 'ready',
    `primary ${ownerImage?.size ?? 'none'} (${ownerImage?.processing_status ?? '—'})`);

  // --- 4. WHAT THE BUILDER'S SCREEN IS TOLD ---------------------------------
  const read = async (itemId) => (await call('builder-portal-stock',
    { operation: 'get_stock_item', stock_item_id: itemId }, cookie)).json?.record ?? null;
  const mismatchOf = (record_) => (record_?.source_document_notes ?? [])
    .find((note) => note.finding === 'identity_mismatch') ?? null;
  const ownNote = mismatchOf(await read(own.id));
  record('4: Lot 2046 is told its brochure states Lot 2064, and is offered "Use brochure image"',
    ownNote?.states === 'Lot 2064' && ownNote?.confirmable === true && !ownNote?.in_use_by,
    JSON.stringify({ states: ownNote?.states, confirmable: ownNote?.confirmable }));
  const siblingNote = mismatchOf(await read(sibling.id));
  record('4: Lot 3158 is told its brochure is Lot 3185 · Halo 24\'s, and offered nothing',
    siblingNote?.states === 'Lot 3185' && siblingNote?.confirmable === false
      && siblingNote?.in_use_by?.identity === 'Lot 3185 · Halo 24',
    JSON.stringify({ states: siblingNote?.states, confirmable: siblingNote?.confirmable,
      in_use_by: siblingNote?.in_use_by?.identity }));

  // --- 5. A SIBLING'S BROCHURE IS REFUSED AT THE ACT -------------------------
  const refused = await call('builder-portal-stock', {
    operation: 'confirm_brochure_image', stock_item_id: sibling.id,
    document_key: siblingNote?.document_key ?? siblingUrl, states: 'Lot 3185',
  }, cookie);
  const siblingAfter = (await itemsOf(user.orgId)).find((i) => i.id === sibling.id);
  const siblingConfirmations = await confirmationsOf(sibling.id);
  record('5: confirming the sibling\'s brochure is refused, naming the listing that uses it',
    refused.status === 409 && refused.json?.code === 'brochure_in_use'
      && refused.json?.in_use_by?.identity === 'Lot 3185 · Halo 24',
    `HTTP ${refused.status} ${refused.json?.code ?? ''} ${refused.json?.in_use_by?.identity ?? ''}`);
  record('5: and nothing was recorded or moved',
    siblingConfirmations.length === 0 && siblingAfter?.image_work_stage === sibling.image_work_stage
      && !siblingAfter?.primary_image_id,
    `${siblingConfirmations.length} confirmation(s), stage ${siblingAfter?.image_work_stage}`);

  // --- 6. THE BUILDER CONFIRMS THEIR OWN BROCHURE ---------------------------
  const confirmed = await call('builder-portal-stock', {
    operation: 'confirm_brochure_image', stock_item_id: own.id,
    document_key: ownNote?.document_key, states: ownNote?.states,
  }, cookie);
  const confirmationId = confirmed.json?.confirmation_id;
  record('6: the builder\'s confirmation is recorded',
    confirmed.status === 200 && !!confirmationId, `HTTP ${confirmed.status} ${confirmed.text.slice(0, 120)}`);
  if (!confirmationId) throw new Error('the confirmation was not recorded; nothing further can be proved');
  const applied = await waitFor('the confirmed brochure', async () => {
    const item = (await itemsOf(user.orgId)).find((i) => i.id === own.id);
    const image = item?.primary_image_id ? await imageOf(item.primary_image_id) : null;
    return { item, image, done: !!image && TERMINAL.includes(item?.image_work_stage) };
  });
  if (!applied.done) await explainStall(user.orgId, 'the confirmed brochure');
  summary.appliedMs = applied.ms;
  record('6: the card shows the brochure\'s own photograph, stamped with the confirmation',
    applied.done === true && applied.image?.size === OWN_PHOTO
      && applied.image?.confirmation === confirmationId && applied.image?.processing_status === 'ready',
    `${applied.image?.size ?? 'no picture'}, stamp ${applied.image?.confirmation === confirmationId ? 'matches' : 'MISSING'}, `
    + `eligibility ${applied.image?.eligibility ?? '—'}, after ${Math.round(applied.ms / 1000)} s`);
  const shown = await read(own.id);
  const view = (shown?.brochure_confirmations ?? [])[0];
  record('6: the screen says who confirmed it, that it was applied, and offers the undo',
    view?.id === confirmationId && view?.state === 'applied' && view?.confirmed_by === BUILDER_NAME
      && !mismatchOf(shown),
    JSON.stringify({ state: view?.state, confirmed_by: view?.confirmed_by, notice: !!mismatchOf(shown) }));

  // --- 7. AND UNDOES IT ----------------------------------------------------
  const undone = await call('builder-portal-stock', {
    operation: 'undo_brochure_image', stock_item_id: own.id, confirmation_id: confirmationId,
  }, cookie);
  const afterUndo = (await itemsOf(user.orgId)).find((i) => i.id === own.id);
  const stampedAfter = await stampedImagesOf(own.id, confirmationId);
  const [withdrawn] = await confirmationsOf(own.id);
  record('7: undo takes the photograph off the card in the same act',
    undone.status === 200 && !afterUndo?.primary_image_id
      && stampedAfter.length > 0 && stampedAfter.every((i) => i.processing_status === 'unavailable'),
    `HTTP ${undone.status}, primary ${afterUndo?.primary_image_id ?? 'none'}, `
    + `stamped images ${stampedAfter.map((i) => i.processing_status).join(', ')}`);
  record('7: the confirmation is kept, withdrawn', withdrawn?.withdrawn === true,
    JSON.stringify(withdrawn ?? null));
  const reread = await waitFor('the undone brochure', async () => {
    const item = (await itemsOf(user.orgId)).find((i) => i.id === own.id);
    const note = TERMINAL.includes(item?.image_work_stage) ? mismatchOf(await read(own.id)) : null;
    return { item, note, done: !!note };
  });
  if (!reread.done) await explainStall(user.orgId, 'the undone brochure');
  record('7: the settler reads it again and the notice comes back, with the choice',
    reread.done === true && reread.note?.confirmable === true && !reread.item?.primary_image_id,
    `stage ${reread.item?.image_work_stage}, notice ${reread.note ? reread.note.states : 'none'}, `
    + `after ${Math.round(reread.ms / 1000)} s`);
} catch (error) {
  record('the proof ran to its end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end', storage);
    const [left] = await q('what remains', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}) AS orgs,
             (SELECT count(*) FROM public.builder_portal_users
               WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users`);
    record('cleanup: nothing of this run remains',
      Number(left?.orgs) === 0 && Number(left?.users) === 0, `orgs ${left?.orgs}, users ${left?.users}`);
  } catch (error) {
    record('cleanup: nothing of this run remains', false, String(error?.message ?? error).slice(0, 200));
  }
}

console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
