#!/usr/bin/env node
/**
 * ===========================================================================
 * A PROJECT SHOWS ITS PROPERTY — PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * An activation opens a project, and the project page must show the property
 * the way the Stock List does: its photograph, its figures, the documents its
 * row links to. This proves it through the requests a builder's browser makes:
 *
 *   1. two organisations of the run's own, detached from every workspace;
 *   2. a stock list whose one property reads its brochure and holds a photo;
 *   3. an activation delivered through the LIVE network door, signed over a
 *      proof-only workspace connection, opening a project (the fan-out);
 *   4. `get_project` and `list_projects` carry the property: its photograph,
 *      every figure equal to the Stock List's own read, the brochure link;
 *   5. `image_url` serves the photograph's bytes to the project, refuses an
 *      image that is not this property's, and another organisation can
 *      reach neither the project nor its photograph;
 *   6. a party is added, edited and removed, and project access is unchanged.
 *
 * THE DOCUMENT IS THE GATE'S OWN (`SALTBUSH RISE`, pinned by digest). Every
 * row, object, workspace and connection it creates is deleted before it exits.
 *
 * Runs from the production-rollout workflow (phase `stock-project-proof`).
 * No secret and no link is printed.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'project-proof';
const STOCK_LIST_BUCKET = 'builder-stock-lists';
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const BUILDER_NAME = 'Project Proof';

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
  /*
   * The activation-opened project RESTRICTS the organisation delete, so it goes
   * first (its grants, parties and history cascade). The history is
   * append-only BY TRIGGER; these rows are this run's own synthetic fixtures,
   * so the trigger steps aside for this one statement inside this one
   * transaction — `production-smoke.mjs`' rule, verbatim.
   */
  await q(`${stage}: rows`, `
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}`)}
    DELETE FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)};
    ALTER TABLE public.builder_project_status_history
      DISABLE TRIGGER trg_builder_project_status_history_append_only;
    DELETE FROM public.builder_projects WHERE builder_organisation_id IN
      (SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN});
    ALTER TABLE public.builder_project_status_history
      ENABLE TRIGGER trg_builder_project_status_history_append_only;
    DELETE FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};`);
}

async function seedUser(label) {
  const email = `${MARK}-${TAG}-${label}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!project`;
  const orgName = `Smoke Rollout ${TAG} ${label} ${RUN}`;
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

const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const hmacHex = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');

const itemsOf = (orgId) => q('items', `
  SELECT id, lot_number, lifecycle_status, image_work_stage, primary_image_id
    FROM public.builder_stock_items
   WHERE organisation_id = ${sqlLit(orgId)}
   ORDER BY lot_number, id`);

const TERMINAL = ['settled', 'failed'];

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

/** The first bytes say what an image is; nothing here trusts a header alone. */
function imageKind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  return null;
}

const FIGURES = ['bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm', 'price_display'];

let storage = null;
const summary = { run: RUN };
try {
  console.log(`stock project proof run=${RUN} origin=${ORIGIN}`);
  storage = await storageAuth();
  await cleanup('start', storage);

  // --- 1. TWO ORGANISATIONS OF ITS OWN, THROUGH GOVERNANCE -----------------
  const user = await seedUser('main');
  const outsider = await seedUser('other');
  const cookie = await establishSession(user);
  const outsiderCookie = await establishSession(outsider);
  for (const [who, c] of [['main', cookie], ['other', outsiderCookie]]) {
    const accepted = await call('builder-portal-verify',
      { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, c);
    const onboarded = await call('builder-portal-verify', { action: 'complete_onboarding' }, c);
    record(`1: the ${who} proof builder is through governance, detached from every workspace`,
      accepted.status === 200 && onboarded.json?.onboarding_complete === true,
      `terms ${accepted.status}, onboarding ${onboarded.status}`);
  }

  // --- 2. A STOCK LIST, AS A BUILDER SENDS IT ------------------------------
  const brochureUrl = await publishFixture(storage, user.orgId, FIXTURES.sibling);
  const csv = [
    'Lot,Design,Bed,Bath,Car,Land Size,Build Size,Price,Suburb,State,Postcode,Description,Brochure URL',
    `3185,Halo 24,4,2,2,375,224,"$655,000",Wattlebank,VIC,3977,"Proof description: single-storey family home.",${brochureUrl}`,
  ].join('\n') + '\n';
  const csvBytes = new TextEncoder().encode(csv);
  const created = await call('builder-portal-stock', {
    operation: 'create_upload', filename: 'SALTBUSH RISE - PROJECT PROOF.csv',
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
    `HTTP ${processed.status}`);

  const settled = await waitFor('settlement', async () => {
    const items = await itemsOf(user.orgId);
    return { items, done: items.length === 1 && TERMINAL.includes(items[0].image_work_stage) };
  });
  const item = settled.items?.[0] ?? null;
  record('2: the property read its brochure and holds a photograph',
    settled.done === true && !!item?.primary_image_id,
    `${item?.image_work_stage ?? 'none'} after ${Math.round(settled.ms / 1000)} s, primary ${item?.primary_image_id ? 'yes' : 'no'}`);
  if (!item?.primary_image_id) throw new Error('no photograph to prove a project page against');

  // --- 3. AN ACTIVATION, THROUGH THE LIVE NETWORK DOOR ---------------------
  // A proof-only workspace and connection (production-smoke's precedent);
  // nothing it queues can reach a real workspace, and cleanup removes it.
  const connection = (await q('proof connection', `
    WITH workspace AS (
      INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
      VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Project Proof Workspace')
      RETURNING id
    )
    INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
    SELECT workspace.id, ${sqlLit(user.orgId)}::uuid, 'active', 'workspace', now(),
           encode(extensions.gen_random_bytes(32), 'hex')
    FROM workspace
    RETURNING id, outbound_hmac_secret`))[0];
  const envelope = JSON.stringify({
    event_type: 'stock.selection.announced',
    dedupe_key: `${MARK}:${TAG}:${RUN}:announce`,
    payload: {
      remote_selection_ref: crypto.randomUUID(),
      stock_item_id: item.id,
      status: 'selected',
      agency: {
        name: 'Project Proof Agency', contact_name: 'Proof Contact',
        contact_email: 'proof.contact@example.com', contact_phone: '03 9000 0000',
      },
    },
    source_version: 1,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const delivered = await fetch(`${FUNCTIONS_BASE}/builder-network-inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-aurixa-connection': connection.id,
      'x-aurixa-timestamp': ts,
      'x-aurixa-signature': hmacHex(connection.outbound_hmac_secret, `${ts}.${envelope}`),
    },
    body: envelope,
  });
  await q('apply sweep', 'SELECT * FROM public.builder_network_apply_inbound_events(50)');
  const opened = (await q('activation project', `
    SELECT a.activation_project_id AS project_id
      FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = ${sqlLit(connection.id)}::uuid`))[0] ?? {};
  const projectId = opened.project_id ?? null;
  record('3: the activation opened a project', delivered.status === 200 && !!projectId,
    `door ${delivered.status}, project ${projectId ? 'opened' : 'MISSING'}`);
  if (!projectId) throw new Error('no project to prove against');

  // --- 4. THE PROJECT SHOWS THE PROPERTY AS THE STOCK LIST DOES ------------
  const stockRead = (await call('builder-portal-stock',
    { operation: 'get_stock_item', stock_item_id: item.id }, cookie)).json?.record ?? null;
  const detail = await call('builder-portal-projects', { operation: 'get_project', project_id: projectId }, cookie);
  const property = detail.json?.stock_item ?? null;
  record('4: the project page carries the property with its photograph',
    detail.status === 200 && property?.id === item.id
      && property?.primary_image_id === item.primary_image_id
      && (property?.images ?? []).some((image) => image.id === item.primary_image_id),
    `HTTP ${detail.status}, images ${(property?.images ?? []).length}`);
  const differing = FIGURES.filter((field) => String(property?.[field] ?? '') !== String(stockRead?.[field] ?? ''));
  record('4: every figure is the Stock List\'s own', !!stockRead && differing.length === 0,
    differing.length ? `differs: ${differing.join(', ')}` : FIGURES.map((f) => `${f}=${property?.[f]}`).join(' '));
  const documents = detail.json?.property_documents ?? [];
  record('4: the brochure link is offered, named by its column',
    documents.length === 1 && documents[0].kind === 'brochure' && documents[0].label === 'Brochure'
      && documents[0].url === brochureUrl,
    documents.map((d) => `${d.label}/${d.kind}`).join(', ') || 'none');
  record('4: the description travels', String(property?.description ?? '').includes('Proof description'),
    String(property?.description ?? '').slice(0, 60));

  const list = await call('builder-portal-projects', { operation: 'list_projects' }, cookie);
  const row = (list.json?.records ?? []).find((r) => r.id === projectId);
  record('4: the project list row carries the property and its photograph',
    list.status === 200 && row?.property?.primary_image_id === item.primary_image_id
      && (row?.property?.images ?? []).length > 0,
    `HTTP ${list.status}, row ${row ? 'present' : 'MISSING'}`);

  // --- 5. THE PHOTOGRAPH IS SERVED TO THE PROJECT, AND ONLY TO IT ---------
  const signed = await call('builder-portal-projects',
    { operation: 'image_url', project_id: projectId, image_id: item.primary_image_id }, cookie);
  let kind = null;
  let bytesLength = 0;
  if (signed.json?.url) {
    const fetched = await fetch(signed.json.url);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    bytesLength = bytes.length;
    kind = fetched.ok ? imageKind(bytes) : null;
  }
  record('5: the project serves its photograph, and the bytes are an image',
    signed.status === 200 && !!kind && bytesLength > 1000,
    `HTTP ${signed.status}, ${kind ?? 'not an image'} ${bytesLength} bytes`);
  const stockSigned = await call('builder-portal-stock',
    { operation: 'image_url', image_id: item.primary_image_id }, cookie);
  record('5: the Stock List serves the same photograph', stockSigned.status === 200 && !!stockSigned.json?.url,
    `HTTP ${stockSigned.status}`);
  const stranger = await call('builder-portal-projects',
    { operation: 'image_url', project_id: projectId, image_id: crypto.randomUUID() }, cookie);
  record('5: an image that is not this property\'s answers as absent', stranger.status === 404,
    `HTTP ${stranger.status}`);
  const outsiderDetail = await call('builder-portal-projects',
    { operation: 'get_project', project_id: projectId }, outsiderCookie);
  const outsiderImage = await call('builder-portal-projects',
    { operation: 'image_url', project_id: projectId, image_id: item.primary_image_id }, outsiderCookie);
  record('5: another organisation can neither see the project nor its photograph',
    outsiderDetail.status === 404 && outsiderImage.status === 404,
    `project ${outsiderDetail.status}, image ${outsiderImage.status}`);

  // --- 6. A PARTY IS A CONTACT, NEVER A KEY --------------------------------
  const grantsBefore = (await q('grants before', `
    SELECT count(*)::int AS n FROM public.builder_project_access WHERE project_id = ${sqlLit(projectId)}::uuid`))[0]?.n;
  const added = await call('builder-portal-projects', {
    operation: 'upsert_party', project_id: projectId, role: 'certifier', name: 'Proof Certifier',
    organisation: 'Proof Certification', email: 'proof.certifier@example.com', phone: '0400 000 000',
  }, cookie);
  const partyId = added.json?.record?.id ?? null;
  const edited = partyId ? await call('builder-portal-projects', {
    operation: 'upsert_party', project_id: projectId, party_id: partyId, role: 'certifier',
    name: 'Proof Certifier (edited)', is_primary_contact: true,
  }, cookie) : { status: 0 };
  const parties = (await call('builder-portal-projects',
    { operation: 'list_parties', project_id: projectId }, cookie)).json?.records ?? [];
  const grantsAfter = (await q('grants after', `
    SELECT count(*)::int AS n FROM public.builder_project_access WHERE project_id = ${sqlLit(projectId)}::uuid`))[0]?.n;
  record('6: a party is added and edited', added.status === 200 && edited.status === 200
    && parties.some((p) => p.id === partyId && p.name === 'Proof Certifier (edited)' && p.is_primary_contact),
    `add ${added.status}, edit ${edited.status}, listed ${parties.length}`);
  record('6: adding and editing a party changed no project access', grantsBefore === grantsAfter,
    `grants ${grantsBefore} → ${grantsAfter}`);
  const removed = partyId ? await call('builder-portal-projects',
    { operation: 'delete_party', project_id: projectId, party_id: partyId }, cookie) : { status: 0 };
  const remaining = (await call('builder-portal-projects',
    { operation: 'list_parties', project_id: projectId }, cookie)).json?.records ?? [];
  record('6: a party is removed', removed.status === 200 && !remaining.some((p) => p.id === partyId),
    `HTTP ${removed.status}`);
  const outsiderParty = await call('builder-portal-projects', {
    operation: 'upsert_party', project_id: projectId, name: 'Should Not Land',
  }, outsiderCookie);
  record('6: another organisation cannot add a party', outsiderParty.status === 404, `HTTP ${outsiderParty.status}`);
} catch (error) {
  record('the proof ran to the end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end', storage);
    const left = await q('left behind', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}) AS orgs,
             (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)}) AS workspaces,
             (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users`);
    const l = left[0] ?? {};
    record('cleanup: nothing this run created is left',
      Number(l.orgs) === 0 && Number(l.workspaces) === 0 && Number(l.users) === 0,
      `orgs ${l.orgs}, workspaces ${l.workspaces}, users ${l.users}`);
  } catch (error) {
    record('cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
