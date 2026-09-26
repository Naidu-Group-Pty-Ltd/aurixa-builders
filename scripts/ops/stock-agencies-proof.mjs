#!/usr/bin/env node
/**
 * ===========================================================================
 * THE AGENCIES AREA — PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * Step 4 gives a builder one place for the agencies (connected Command Centre
 * workspaces) that activate their stock: Activated Properties and a Messages
 * shell, both read through `list_activated_properties`. This proves, through
 * the requests a builder's browser makes:
 *
 *   1. two organisations of the run's own, detached from every workspace;
 *   2. a stock list whose one property reads its brochure and holds a photo;
 *   3. an activation delivered through the LIVE network door, signed over a
 *      proof-only workspace connection — carrying a client label, which the
 *      area must never show — and a payload naming a client refused at the
 *      door;
 *   4. the organisation's own builder reads the activation with its property,
 *      design, photograph, agency, contact and project link, and the
 *      photograph's bytes are served;
 *   5. another organisation reads nothing — nor after being listed as a party
 *      on the project — and cannot reach the photograph;
 *   6. the deployed portal serves the area's route (/builder/activations, with
 *      the old /builder/agencies routes kept as redirects) and the bundle carries it;
 *   7. read-only, across production: no real announcement holds a client label.
 *
 * THE DOCUMENT IS THE GATE'S OWN (`SALTBUSH RISE`, pinned by digest). Every
 * row, object, workspace and connection it creates is deleted before it exits.
 *
 * Runs from the production-rollout workflow (phase `stock-agencies-proof`).
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
const TAG = 'agencies-proof';
const STOCK_LIST_BUCKET = 'builder-stock-lists';
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const BUILDER_NAME = 'Agencies Proof';

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

let storage = null;
try {
  console.log(`stock agencies proof run=${RUN} origin=${ORIGIN}`);
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
    operation: 'create_upload', filename: 'SALTBUSH RISE - AGENCIES PROOF.csv',
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
  if (!item?.primary_image_id) throw new Error('no photograph to prove the area against');

  // --- 3. AN ACTIVATION, THROUGH THE LIVE NETWORK DOOR ---------------------
  const connection = (await q('proof connection', `
    WITH workspace AS (
      INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
      VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Agencies Proof Workspace')
      RETURNING id
    )
    INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
    SELECT workspace.id, ${sqlLit(user.orgId)}::uuid, 'active', 'workspace', now(),
           encode(extensions.gen_random_bytes(32), 'hex')
    FROM workspace
    RETURNING id, outbound_hmac_secret`))[0];
  const deliver = async (dedupe, payload, version) => {
    const envelope = JSON.stringify({ event_type: 'stock.selection.announced', dedupe_key: dedupe, payload, source_version: version });
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(`${FUNCTIONS_BASE}/builder-network-inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aurixa-connection': connection.id,
        'x-aurixa-timestamp': ts,
        'x-aurixa-signature': hmacHex(connection.outbound_hmac_secret, `${ts}.${envelope}`),
      },
      body: envelope,
    });
  };
  const selectionRef = crypto.randomUUID();
  const clientLabel = `Proof Client Label ${RUN}`;
  const delivered = await deliver(`${MARK}:${TAG}:${RUN}:announce`, {
    remote_selection_ref: selectionRef,
    stock_item_id: item.id,
    status: 'selected',
    // A label the Command Centre has never sent. If one ever arrives, the
    // area must still not show it.
    remote_client_label: clientLabel,
    agency: {
      name: 'Agencies Proof Agency', contact_name: 'Proof Contact',
      contact_email: 'proof.contact@example.com', contact_phone: '03 9000 0000',
    },
  }, 1);
  const refusedAtDoor = await deliver(`${MARK}:${TAG}:${RUN}:client`, {
    remote_selection_ref: crypto.randomUUID(), stock_item_id: item.id, status: 'selected',
    client_name: 'A client who must never cross',
  }, 2);
  await q('apply sweep', 'SELECT * FROM public.builder_network_apply_inbound_events(50)');
  const landed = await q('announcements', `
    SELECT a.id, a.activation_project_id AS project_id
      FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = ${sqlLit(connection.id)}::uuid`);
  const announcement = landed[0] ?? {};
  const projectId = announcement.project_id ?? null;
  record('3: the signed activation landed once and opened a project',
    delivered.status === 200 && landed.length === 1 && !!projectId,
    `door ${delivered.status}, announcements ${landed.length}, project ${projectId ? 'opened' : 'MISSING'}`);
  record('3: a payload naming a client is refused at the door and stores nothing',
    refusedAtDoor.status === 422 && landed.length === 1, `door ${refusedAtDoor.status}`);
  if (!projectId) throw new Error('no activation to prove against');

  // --- 4. THE BUILDER'S OWN READ -------------------------------------------
  const mine = await call('builder-portal-stock', { operation: 'list_activated_properties' }, cookie);
  const records = mine.json?.records ?? [];
  const record0 = records[0] ?? null;
  record('4: the deployed operation answers the organisation\'s own builder',
    mine.status === 200 && mine.json?.success === true, `HTTP ${mine.status}`);
  record('4: exactly this organisation\'s one activation, with its property',
    records.length === 1 && record0?.id === announcement.id && record0?.stock_item_id === item.id
      && record0?.property?.lot_number === '3185' && record0?.property?.house_design === 'Halo 24',
    `records ${records.length}, lot ${record0?.property?.lot_number ?? '-'}, design ${record0?.property?.house_design ?? '-'}`);
  record('4: the agency, its workspace and its contact',
    record0?.agency?.name === 'Agencies Proof Agency'
      && record0?.agency?.workspace_label === 'Agencies Proof Workspace'
      && record0?.agency?.contact_name === 'Proof Contact'
      && record0?.status === 'selected' && !!record0?.activated_at,
    `${record0?.agency?.name ?? '-'} / ${record0?.agency?.workspace_label ?? '-'} / ${record0?.status ?? '-'}`);
  record('4: the project link, open to this builder',
    record0?.project?.id === projectId && record0?.project?.accessible === true,
    JSON.stringify(record0?.project ?? null));
  record('4: the property\'s elected photograph',
    record0?.primary_image?.id === item.primary_image_id, record0?.primary_image?.id ? 'present' : 'missing');
  const text = JSON.stringify(mine.json ?? {});
  record('4: no client label, selection ref or user id crossed into the page',
    !text.includes(clientLabel) && !text.includes(selectionRef)
      && !/remote_client_label|remote_selection_ref|client_reference|acknowledged_by_builder_user_id/.test(text),
    'withheld');
  const signed = await call('builder-portal-stock',
    { operation: 'image_url', image_id: item.primary_image_id }, cookie);
  let kind = null;
  let bytesLength = 0;
  if (signed.json?.url) {
    const fetched = await fetch(signed.json.url);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    bytesLength = bytes.length;
    kind = fetched.ok ? imageKind(bytes) : null;
  }
  record('4: the photograph is served, and the bytes are an image',
    signed.status === 200 && !!kind && bytesLength > 1000,
    `HTTP ${signed.status}, ${kind ?? 'not an image'} ${bytesLength} bytes`);

  // --- 5. ANOTHER ORGANISATION ---------------------------------------------
  const theirs = await call('builder-portal-stock', { operation: 'list_activated_properties' }, outsiderCookie);
  record('5: another organisation reads no activation (and so no conversation)',
    theirs.status === 200 && (theirs.json?.records ?? []).length === 0
      && !JSON.stringify(theirs.json ?? {}).includes(item.id),
    `HTTP ${theirs.status}, records ${(theirs.json?.records ?? []).length}`);
  const theirImage = await call('builder-portal-stock',
    { operation: 'image_url', image_id: item.primary_image_id }, outsiderCookie);
  record('5: another organisation cannot reach the photograph', theirImage.status === 404,
    `HTTP ${theirImage.status}`);
  const party = await call('builder-portal-projects', {
    operation: 'upsert_party', project_id: projectId, role: 'other', name: BUILDER_NAME,
    organisation: 'Proof Outsider', email: outsider.email,
  }, cookie);
  const afterParty = await call('builder-portal-stock', { operation: 'list_activated_properties' }, outsiderCookie);
  const afterPartyProject = await call('builder-portal-projects',
    { operation: 'get_project', project_id: projectId }, outsiderCookie);
  record('5: being listed as a party on the project opens nothing',
    party.status === 200 && (afterParty.json?.records ?? []).length === 0 && afterPartyProject.status === 404,
    `party ${party.status}, activations ${(afterParty.json?.records ?? []).length}, project ${afterPartyProject.status}`);

  // --- 6. THE DEPLOYED PORTAL SERVES THE AREA ------------------------------
  // Since #124 the area is Agency Activations at /builder/activations (its
  // conversations moved to Messages), and the old /builder/agencies routes
  // are kept as redirects so bookmarks still land.
  const page = await fetch(`${ORIGIN}/builder/activations`);
  const html = await page.text();
  const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let bundleNamesRoute = false;
  let chunk = null;
  for (const src of scripts) {
    const js = await (await fetch(`${ORIGIN}${src}`)).text();
    if (js.includes('activations') && js.includes('agencies/:tab')) bundleNamesRoute = true;
    chunk = chunk ?? js.match(/assets\/BuilderAgencyActivations-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
  }
  let chunkIsArea = false;
  if (chunk) {
    const js = await (await fetch(`${ORIGIN}/${chunk}`)).text();
    chunkIsArea = js.includes('Agency Activations') && js.includes('Your conversations with them are in Messages');
  }
  record('6: the portal serves the route and its bundle carries the area',
    page.status === 200 && bundleNamesRoute && chunkIsArea,
    `HTTP ${page.status}, route ${bundleNamesRoute ? 'yes' : 'no'}, chunk ${chunkIsArea ? 'yes' : 'no'}`);

  // --- 7. READ-ONLY, ACROSS PRODUCTION --------------------------------------
  const labelled = (await q('real client labels', `
    SELECT count(*)::int AS n FROM public.builder_stock_selection_announcements a
     WHERE a.remote_client_label IS NOT NULL
       AND a.connection_id NOT IN (SELECT id FROM public.workspace_connections
                                    WHERE builder_organisation_id IN
                                      (SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${ORG_PATTERN}))`))[0]?.n;
  record('7: no real activation carries a client label (read-only count)', Number(labelled) === 0,
    `${labelled} labelled`);
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
