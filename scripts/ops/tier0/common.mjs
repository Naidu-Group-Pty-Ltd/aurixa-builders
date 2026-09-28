/**
 * ===========================================================================
 * TIER-0: A BUILDER'S STOCK LIST, FROM THE FILE TO THE COMMAND CENTRE'S PAGE.
 * ===========================================================================
 *
 * The shared half of the three `stock-tier0-*` proofs. Everything here is a
 * pattern an existing proof already established on production, gathered so
 * the Tier-0 phases do not restate it:
 *
 *   - SQL through the Management API on both projects (`net`, `cc`);
 *   - a builder organisation of the run's own, DETACHED from every workspace
 *     in the transaction that creates it (stock-import-proof's measured
 *     reason: an active organisation is provisioned onto every whole-network
 *     workspace the moment it is inserted);
 *   - a PROOF-ONLY TRANSPORT to the live Command Centre door, so published
 *     stock travels the real signed path and reaches no real workspace
 *     through any other (stock-media-proof);
 *   - a pepper-minted portal session where Turnstile blocks automation, and a
 *     Command Centre staff session for a proof staff member (stock-private-
 *     chat-proof);
 *   - the three requests a builder's browser makes to import a file:
 *     `create_upload`, the PUT to the signed URL, `process_upload`.
 *
 * WHAT IS NEVER DONE HERE: no image work is kicked, no stage is pushed, no
 * lifecycle is written. What finishes an import, settles its photographs,
 * publishes it and carries it to the Command Centre is the product's own
 * dispatch, continuation, settler, tick, trigger, outbox worker and door.
 * The waits are generous for exactly that reason, and every wait records how
 * long the product took.
 *
 * Nothing it creates is any customer's: every organisation is `Smoke Rollout
 * <tag> …`, every user `smoke-rollout-<tag>-…@example.com`, every staff
 * member `smoke-rollout-<tag>-…`, every client `… Tier0 Proof …`, and every
 * row and object is deleted on both sides before the run ends, with the
 * deletion checked.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
export const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
export const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
export const CC_ORIGIN = process.env.COMMAND_CENTRE_ORIGIN || 'https://command-centre.npcservices.com.au';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
export const MARK = 'smoke-rollout';
export const STOCK_LIST_BUCKET = 'builder-stock-lists';
export const STOCK_IMAGE_BUCKET = 'builder-stock-images';
export const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tier0');

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

// --- Recording ---------------------------------------------------------------
export const results = [];
export function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok: !!ok, detail, required });
  console.log(`  ${ok ? 'PASS' : required ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
export const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const id = (value) => {
  if (!UUID.test(String(value))) throw new Error(`not a uuid: ${String(value).slice(0, 12)}`);
  return `'${value}'::uuid`;
};
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const secs = (w) => `${Math.round((w?.ms ?? 0) / 1000)} s${w?.timedOut ? ' (timed out)' : ''}`;

// --- SQL on both projects ------------------------------------------------------
async function query(ref, label, sql) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    const text = await response.text();
    // The Management API rate-limits bursts; a 429 is its answer, not ours.
    if (response.status === 429 || response.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 400)}`);
    try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
    catch { return []; }
  }
  throw new Error(`[${label}] the Management API kept refusing`);
}
export const net = (label, sql) => query(NETWORK_REF, `network ${label}`, sql);
export const cc = (label, sql) => query(CC_REF, `cc ${label}`, sql);

export async function serviceKey(ref) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!response.ok) throw new Error(`api-keys ${ref.slice(0, 4)}…: HTTP ${response.status}`);
  const keys = await response.json();
  const key = (Array.isArray(keys) ? keys : []).find((k) => k?.name === 'service_role');
  if (!key?.api_key) throw new Error('no service_role key');
  return key.api_key;
}
export async function storageFor(ref) {
  const key = await serviceKey(ref);
  return { base: `https://${ref}.supabase.co/storage/v1`, headers: { Authorization: `Bearer ${key}`, apikey: key } };
}

// --- The portal, as the browser calls it ---------------------------------------
export async function portal(fn, body, cookie = null, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN, ...extraHeaders,
  };
  if (cookie) headers.Cookie = cookie;
  const startedAt = Date.now();
  const response = await fetch(`${ORIGIN}/fn/${fn}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return {
    status: response.status, json, ms: Date.now() - startedAt, text: text.slice(0, 400),
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}
export const stock = (body, cookie) => portal('builder-portal-stock', body, cookie);

/** The Command Centre's own function, as its page calls it, with a staff session. */
export async function commandCentre(operation, body, sessionToken) {
  const startedAt = Date.now();
  const response = await fetch(`https://${CC_REF}.supabase.co/functions/v1/builder-stock-marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: CC_ORIGIN, Cookie: `__Host-session_token=${sessionToken}` },
    body: JSON.stringify({ operation, ...(body ?? {}) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, text: text.slice(0, 400), ms: Date.now() - startedAt };
}

export async function waitFor(label, check, deadlineMs, every = 5_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < deadlineMs) {
    try { last = await check(); } catch (error) { last = { error: String(error?.message ?? error).slice(0, 200) }; }
    if (last?.done) return { ...last, ms: Date.now() - startedAt };
    await sleep(every);
  }
  return { ...(last ?? {}), done: false, ms: Date.now() - startedAt, timedOut: label };
}

// --- Fixtures --------------------------------------------------------------------
let manifestCache = null;
export function manifest() {
  manifestCache ??= JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
  return manifestCache;
}
/** A committed fixture, refused unless its bytes are the pinned bytes. */
export function fixture(relative) {
  const pinned = manifest().files[relative];
  if (!pinned) throw new Error(`no pinned fixture ${relative}`);
  const bytes = readFileSync(join(FIXTURES, relative));
  if (bytes.length !== pinned.bytes || sha256(bytes) !== pinned.sha256) {
    throw new Error(`refusing a fixture that is not the pinned one: ${relative}`);
  }
  return new Uint8Array(bytes);
}

export const CONTENT_TYPES = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', html: 'text/html', json: 'application/json', xml: 'application/xml',
  tiff: 'image/tiff', zip: 'application/zip',
};
export const contentTypeOf = (name) => CONTENT_TYPES[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// --- Storage -------------------------------------------------------------------
export async function listObjects(storage, bucket, prefix, depth = 0) {
  if (depth > 6) return [];
  const response = await fetch(`${storage.base}/object/list/${bucket}`, {
    method: 'POST', headers: { ...storage.headers, 'Content-Type': 'application/json' },
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
export async function deletePrefix(storage, bucket, prefix) {
  const paths = await listObjects(storage, bucket, prefix);
  for (let i = 0; i < paths.length; i += 100) {
    await fetch(`${storage.base}/object/${bucket}`, {
      method: 'DELETE', headers: { ...storage.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }),
    });
  }
  return paths.length;
}
/** A fixture object in the organisation's OWN folder, and a signed link to it. */
export async function stageLinked(storage, orgId, name, bytes) {
  const path = `stock-lists/${orgId}/tier0-linked/${name}`;
  const put = await fetch(`${storage.base}/object/${STOCK_LIST_BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...storage.headers, 'Content-Type': contentTypeOf(name), 'x-upsert': 'true' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`storing ${name} answered ${put.status}`);
  const signed = await fetch(`${storage.base}/object/sign/${STOCK_LIST_BUCKET}/${path}`, {
    method: 'POST', headers: { ...storage.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 6 * 60 * 60 }),
  });
  const body = await signed.json().catch(() => ({}));
  const relative = body?.signedURL ?? body?.signedUrl;
  if (!signed.ok || !relative) throw new Error(`signing ${name} answered ${signed.status}`);
  return `${storage.base}${relative.startsWith('/') ? '' : '/'}${relative}`;
}
/**
 * A text fixture with its link placeholders replaced by signed links to the
 * pinned media, each stored in the organisation's own folder.
 */
export async function withLinks(storage, orgId, text) {
  const cache = new Map();
  const link = async (name) => {
    if (!cache.has(name)) cache.set(name, await stageLinked(storage, orgId, name, fixture(`media/${name}`)));
    return cache.get(name);
  };
  let out = text;
  for (const [whole, kind, key] of [...text.matchAll(/\{\{(PHOTO|BROCHURE|PLAN):([A-Za-z0-9-]+)\}\}/g)]) {
    const name = kind === 'PHOTO' ? `facade-${key}.jpg` : kind === 'BROCHURE' ? `brochure-${key}.pdf` : 'floorplan.jpg';
    // A plan is one drawing per property, each at its own address.
    const url = kind === 'PLAN'
      ? await stageLinked(storage, orgId, `floorplan-${key}.jpg`, fixture('media/floorplan.jpg'))
      : await link(name);
    out = out.split(whole).join(url);
  }
  return out;
}

// --- Organisations, people, sessions ---------------------------------------------
/**
 * Removes, in the SAME transaction as the insert that provisioned them, every
 * connection an organisation was given and everything queued on it — the
 * measured reason is in stock-import-proof.mjs.
 */
export function detachFromNetwork(orgIdsSql) {
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

export function names(tag) {
  return {
    orgPrefix: `Smoke Rollout ${tag}`,
    emailPrefix: `${MARK}-${tag}-`,
    ccUserPrefix: `${MARK}-${tag}-`,
    clientSurname: `Tier0 Proof ${tag}`,
    workspacePrefix: `${MARK}-${tag}-`,
  };
}

/** Every organisation this run created, so what is left of it can be counted by id. */
export const seededOrganisations = new Set();

/** An organisation of the run's own with its owner, detached, through governance. */
export async function seedOrganisation(tag, label, { role = 'owner', existingOrgId = null, contact = true } = {}) {
  const n = names(tag);
  const orgName = `${n.orgPrefix} ${label} ${RUN}`;
  const email = `${n.emailPrefix}${label}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!${label}`;
  const orgSql = existingOrgId
    ? `SELECT ${id(existingOrgId)} AS id`
    : `INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at,
         contact_email, contact_phone, website)
       VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now(),
         ${contact ? sqlLit(`${n.emailPrefix}contact-${RUN}@example.com`) : 'NULL'},
         ${contact ? sqlLit('0300 000 000') : 'NULL'}, ${contact ? sqlLit('https://example.com/proof') : 'NULL'})
       RETURNING id`;
  const orgFilter = existingOrgId ? `SELECT ${id(existingOrgId)}` : `SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(orgName)}`;
  const rows = await net(`seed ${label}`, `
    WITH org AS (${orgSql}), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(`Tier0 ${label}`)}, 'active', true, now(), false,
              extensions.crypt(${sqlLit(password)}, extensions.gen_salt('bf', 10)))
      RETURNING id)
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT person.id, org.id, ${sqlLit(role)}, ${existingOrgId ? 'false' : 'true'}, 'active' FROM person, org;
    ${existingOrgId ? '' : detachFromNetwork(orgFilter)}
    SELECT p.id AS user_id, o.id AS org_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id)::int AS connections
      FROM public.builder_portal_users p, public.builder_organisations o
     WHERE p.email = ${sqlLit(email)} AND o.id IN (${orgFilter})`);
  const row = rows[0] ?? {};
  if (!row.user_id || !row.org_id) throw new Error(`the ${label} proof organisation could not be seeded`);
  seededOrganisations.add(row.org_id);
  if (!existingOrgId && Number(row.connections) !== 0) {
    throw new Error(`the ${label} proof organisation is still connected to ${row.connections} workspace(s); refusing`);
  }
  await net(`onboarding ${label}`, `SELECT public.builder_ensure_onboarding_steps(${id(row.user_id)})`);
  const user = { label, email, password, userId: row.user_id, orgId: row.org_id, orgName };
  user.cookie = await establishSession(user);
  return user;
}

/** A real login where Turnstile allows it; a pepper-minted session otherwise. */
export async function establishSession(user) {
  const login = await portal('builder-portal-login', { email: user.email, password: user.password });
  let cookie = login.setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-builder_session_token='));
  if (!(login.status === 200 && cookie)) {
    if (!PEPPER) throw new Error('login issued no cookie and NETWORK_SESSION_PEPPER is not available');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHmac('sha256', PEPPER).update(token).digest('hex');
    await net('mint session', `
      SELECT public.builder_issue_session(${id(user.userId)}, ${sqlLit(tokenHash)},
        now() + interval '4 hours', now() + interval '4 hours', NULL, NULL, 'smoke-rollout')`);
    cookie = `__Host-builder_session_token=${token}`;
  }
  for (const action of [{ action: 'accept_current_terms', acknowledgements: ALL_ACKS }, { action: 'complete_onboarding' }]) {
    await portal('builder-portal-verify', action, cookie);
  }
  return cookie;
}

/**
 * The proof-only transport: a Command Centre connection for this organisation
 * and its mirror here, sharing a secret minted for this run, addressed at the
 * two LIVE inbound doors (stock-media-proof). Nothing else is connected.
 */
export async function connectTransport(tag, org) {
  const n = names(tag);
  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)} LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!ccDoor || !networkDoor) throw new Error('the live inbound doors could not be read');
  const secret = randomBytes(32).toString('hex');
  const connection = randomUUID();
  await cc(`transport ${org.label}`, `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(org.orgName)}, 'active',
      ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(org.orgId)})`);
  const workspace = (await net(`workspace ${org.label}`, `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${n.workspacePrefix}${org.label}-${RUN}`)}, 'Tier-0 proof (temporary)')
    RETURNING id`))[0].id;
  await net(`connection ${org.label}`, `
    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(org.orgId)}, 'active', 'workspace',
      ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);
  org.connection = connection;
  return connection;
}

/** A proof staff member with the modules the marketplace asks for, and a session. */
export async function seedStaff(tag, label, modules = ['listings', 'clients']) {
  const n = names(tag);
  await cc(`staff ${label}`, `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    INSERT INTO public.custom_users(username, email, password_hash, role, first_name, last_name, is_active)
    VALUES (${sqlLit(`${n.ccUserPrefix}${label}-${RUN}`)}, ${sqlLit(`${n.ccUserPrefix}${label}-${RUN}@example.com`)},
            ${sqlLit(`not-a-password-${randomBytes(16).toString('hex')}`)}, 'proof_no_access', 'Tier0', ${sqlLit(`Staff ${label}`)}, true);
    ALTER TABLE public.custom_users ENABLE TRIGGER USER;`);
  const userId = (await cc(`staff ${label} id`, `
    SELECT id FROM public.custom_users WHERE username = ${sqlLit(`${n.ccUserPrefix}${label}-${RUN}`)}`))[0]?.id;
  if (!UUID.test(String(userId))) throw new Error(`the ${label} proof staff member could not be seeded`);
  await cc(`staff ${label} modules`, `
    INSERT INTO public.user_permissions(user_id, module_id, can_view, can_edit, can_delete)
    SELECT ${id(userId)}, m.id, true, true, false FROM public.dashboard_modules m
     WHERE m.module_key IN (${modules.map(sqlLit).join(', ')})`);
  const token = randomBytes(32).toString('hex');
  await cc(`staff ${label} session`, `
    INSERT INTO public.user_sessions(user_id, session_token, expires_at, idle_expires_at, portal_scope)
    VALUES (${id(userId)}, ${sqlLit(token)}, now() + interval '4 hours', now() + interval '4 hours', 'staff')`);
  return { userId, token };
}

/** An invented client NOTHING may react to: every user trigger is off for this one insert. */
export async function seedClient(tag) {
  const n = names(tag);
  const surname = `${n.clientSurname} ${RUN}`;
  const rows = await cc('client', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    INSERT INTO public.clients(primary_first_name, primary_surname) VALUES ('Proof', ${sqlLit(surname)});
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    SELECT id FROM public.clients WHERE primary_surname = ${sqlLit(surname)}`);
  return rows[0]?.id;
}

// --- Importing a file, the way the browser does ------------------------------------
export async function uploadDocument(cookie, filename, bytes, contentType = contentTypeOf(filename)) {
  const startedAt = Date.now();
  const created = await stock({
    operation: 'create_upload', filename, content_type: contentType, byte_size: bytes.length,
  }, cookie);
  const uploadId = created.json?.upload?.id ?? null;
  if (created.status !== 200 || !uploadId || !created.json?.signed_url) {
    return { created, uploadId: null, refusedAt: 'create_upload', ms: Date.now() - startedAt };
  }
  const put = await fetch(created.json.signed_url, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
  if (!put.ok) return { created, uploadId, put: put.status, refusedAt: 'put', ms: Date.now() - startedAt };
  const processed = await stock({ operation: 'process_upload', upload_id: uploadId }, cookie);
  return { created, uploadId, put: put.status, processed, ms: Date.now() - startedAt };
}

export const uploadRow = (uploadId) => net('upload', `
  SELECT id, status, records_detected, records_imported, processing_started_at, processing_completed_at,
         published_at, error_code, error_message, publication_blocked_reason, image_failure_state,
         import_claim_token IS NOT NULL AS claimed, import_recovery_attempts, source_type,
         replaces_upload_ids, deleted_at, parse_strategy, records_updated, records_failed, storage_path
    FROM public.builder_stock_uploads WHERE id = ${id(uploadId)}`).then((rows) => rows[0] ?? null);

/** The import has finished when the product says so, and not before. */
export async function waitImported(uploadId, deadlineMs = 8 * 60_000) {
  return waitFor('import', async () => {
    const u = await uploadRow(uploadId);
    return { done: !!u?.processing_completed_at && !['parsing', 'uploaded', 'imported'].includes(u?.status), upload: u };
  }, deadlineMs, 3_000);
}

export const ITEM_FIELDS = [
  'external_reference', 'development_name', 'project_name', 'lot_number', 'unit_number', 'address_line',
  'suburb', 'state', 'postcode', 'house_design', 'property_type', 'bedrooms', 'bathrooms', 'car_spaces',
  'land_size_sqm', 'building_size_sqm', 'price', 'price_display', 'availability_status',
  'expected_completion', 'description',
];
export const itemsOf = (orgId, extra = '') => net('items', `
  SELECT i.id, i.upload_id, i.external_reference, i.development_name, i.project_name, i.lot_number, i.unit_number,
         i.address_line, i.suburb, i.state, i.postcode, i.source_row->>'house_design' AS house_design,
         i.property_type, i.bedrooms, i.bathrooms, i.car_spaces, i.land_size_sqm, i.building_size_sqm,
         i.price, i.price_display, i.availability_status, i.expected_completion, i.description,
         i.lifecycle_status, i.image_work_stage, i.primary_image_id, i.enrichment_status,
         i.pending_patch IS NOT NULL AS pending, i.created_at, i.updated_at
    FROM public.builder_stock_items i WHERE i.organisation_id = ${id(orgId)} ${extra}
   ORDER BY i.lot_number, i.created_at`);

/** Two values that mean the same figure or the same words. */
export function same(want, have) {
  if (want === null || want === undefined || want === '') return have === null || have === undefined || have === '';
  if (have === null || have === undefined) return false;
  // A figure is a figure whichever way a reader spelled it: `numeric(12,2)`
  // arrives as "749900.00" through one API and 749900 through another.
  const figure = /^-?\d+(?:\.\d+)?$/;
  if (figure.test(String(want).trim()) && figure.test(String(have).trim())) {
    return Math.abs(Number(have) - Number(want)) < 1e-6;
  }
  return String(have) === String(want);
}
/** Field-by-field differences between what the document states and what was stored. */
export function differences(wantRows, haveRows, fields = ITEM_FIELDS, key = 'lot_number') {
  const out = [];
  for (const want of wantRows) {
    const matches = haveRows.filter((row) => String(row[key]) === String(want[key]));
    if (matches.length === 0) { out.push(`${want[key]}: MISSING`); continue; }
    if (matches.length > 1) out.push(`${want[key]}: ${matches.length} ROWS`);
    const have = matches[0];
    for (const field of fields) {
      if (!(field in want)) continue;
      if (!same(want[field], have[field])) out.push(`${want[key]}.${field}: ${JSON.stringify(have[field] ?? null)} ≠ ${JSON.stringify(want[field])}`);
    }
  }
  const wanted = new Set(wantRows.map((row) => String(row[key])));
  for (const have of haveRows) if (!wanted.has(String(have[key]))) out.push(`${have[key]}: UNEXPECTED`);
  return out;
}

// --- The Command Centre's copy ---------------------------------------------------------
export const CC_FIELDS = [
  'external_reference', 'development_name', 'project_name', 'lot_number', 'unit_number', 'address_line',
  'suburb', 'state', 'postcode', 'property_type', 'bedrooms', 'bathrooms', 'car_spaces', 'land_size_sqm',
  'building_size_sqm', 'price', 'price_display', 'availability_status', 'expected_completion', 'description',
  'lifecycle_status',
];
export const mirrorOf = (orgId) => cc('mirror', `
  SELECT to_jsonb(i) AS row,
         (SELECT count(*) FROM public.builder_network_stock_item_photos p WHERE p.stock_item_id = i.id)::int AS photos,
         (SELECT count(*) FROM public.builder_network_stock_item_documents d WHERE d.stock_item_id = i.id)::int AS documents
    FROM public.builder_network_stock_items i WHERE i.organisation_id = ${id(orgId)}`).then((rows) =>
  rows.map((r) => ({ ...(typeof r.row === 'string' ? JSON.parse(r.row) : r.row), __photos: r.photos, __documents: r.documents })));

// --- Cleanup: everything a tag ever created, on both sides ------------------------------
export async function cleanup(tag, stage, storage) {
  const n = names(tag);
  const orgRows = await net(`${stage}: proof organisations`, `
    SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${n.orgPrefix} %`)}`);
  const orgIds = orgRows.map((row) => row.id).filter((value) => UUID.test(value));
  const ccConnections = await cc(`${stage}: proof connections`, `
    SELECT id, builder_organisation_id FROM public.builder_network_connections
     WHERE builder_org_label LIKE ${sqlLit(`${n.orgPrefix} %`)}`);
  const ccOrgIds = [...new Set([...orgIds,
    ...ccConnections.map((row) => row.builder_organisation_id).filter((v) => UUID.test(String(v)))])];
  const staffUsers = `SELECT u.id FROM public.custom_users u WHERE u.username LIKE ${sqlLit(`${n.ccUserPrefix}%`)}`;

  /*
   * A SELECTION NOBODY IN THIS RUN MADE IS NOT OURS TO DELETE. Proof stock is
   * visible on the live marketplace while a run lasts, so a real staff member
   * could select it; that row would be genuine and is left, loudly, with the
   * property it names.
   */
  if (ccOrgIds.length) {
    const foreign = await cc(`${stage}: foreign selections`, `
      SELECT count(*)::int AS n FROM public.builder_stock_selections s
       WHERE s.organisation_id IN (${ccOrgIds.map(id).join(', ')})
         AND s.selected_by_user_id NOT IN (${staffUsers})`);
    if (Number(foreign[0]?.n) > 0) {
      throw new Error(`${foreign[0].n} selection(s) on proof stock were made by someone outside this run; refusing to delete them`);
    }
  }

  if (storage && orgIds.length) {
    for (const orgId of orgIds) {
      await deletePrefix(storage, STOCK_LIST_BUCKET, `stock-lists/${orgId}/`);
      await deletePrefix(storage, STOCK_IMAGE_BUCKET, `${orgId}/`);
    }
  }

  if (orgIds.length) {
    const orgList = orgIds.map(id).join(', ');
    const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList})`;
    await net(`${stage}: rows`, `
      DELETE FROM public.portal_operational_events WHERE metadata->>'connection_id' IN
        (SELECT c.id::text FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.builder_agency_conversations WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${connections});
      ALTER TABLE public.builder_project_status_history DISABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN (${orgList});
      ALTER TABLE public.builder_project_status_history ENABLE TRIGGER trg_builder_project_status_history_append_only;
      UPDATE public.builder_stock_items SET primary_image_id = NULL WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_item_images WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_items WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connections});
      DELETE FROM public.builder_network_outbox
       WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text FROM public.workspace_connections c
                             WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connections});
      DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connections});
      DELETE FROM public.workspace_connection_events WHERE connection_id IN (${connections});
      DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgList});
      DELETE FROM public.builder_organisations WHERE id IN (${orgList});`);
  }
  await net(`${stage}: proof workspaces and users`, `
    DELETE FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${n.workspacePrefix}%`)};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${n.emailPrefix}%@example.com`)};`);

  const connList = ccConnections.length ? ccConnections.map((row) => id(row.id)).join(', ') : 'NULL::uuid';
  const orgList = ccOrgIds.length ? ccOrgIds.map(id).join(', ') : 'NULL::uuid';
  const selections = `SELECT s.id FROM public.builder_stock_selections s WHERE s.organisation_id IN (${orgList})`;
  await cc(`${stage}: rows`, `
    SET LOCAL lock_timeout = '5s';
    DELETE FROM public.integration_delivery_attempts WHERE outbox_id IN (
      SELECT o.id FROM public.integration_outbox o
       WHERE o.idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${selections}) s));
    DELETE FROM public.integration_dead_letters WHERE outbox_id IN (
      SELECT o.id FROM public.integration_outbox o
       WHERE o.idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${selections}) s));
    DELETE FROM public.integration_outbox
     WHERE idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${selections}) s);
    DELETE FROM public.builder_network_acknowledgement_notices WHERE selection_id IN (${selections});
    DELETE FROM public.notifications WHERE target_user_id IN (${staffUsers});
    DELETE FROM public.user_sessions WHERE user_id IN (${staffUsers});
    DELETE FROM public.user_permissions WHERE user_id IN (${staffUsers});
    DELETE FROM public.builder_network_conversations WHERE connection_id IN (${connList});
    DELETE FROM public.builder_stock_selections WHERE organisation_id IN (${orgList});
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    DELETE FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${n.clientSurname} %`)};
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    DELETE FROM public.custom_users WHERE username LIKE ${sqlLit(`${n.ccUserPrefix}%`)};
    ALTER TABLE public.custom_users ENABLE TRIGGER USER;
    DELETE FROM public.builder_network_stock_items WHERE organisation_id IN (${orgList});
    DELETE FROM public.builder_network_stock_organisations WHERE id IN (${orgList});
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connList});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connList});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connList});
    DELETE FROM public.portal_operational_alerts WHERE event_id IN (
      SELECT e.id FROM public.portal_operational_events e WHERE e.metadata->>'connection_id' IN
        (SELECT c.id::text FROM public.builder_network_connections c WHERE c.id IN (${connList})));
    DELETE FROM public.portal_operational_events WHERE metadata->>'connection_id' IN
      (SELECT c.id::text FROM public.builder_network_connections c WHERE c.id IN (${connList}));
    DELETE FROM public.builder_network_connections WHERE id IN (${connList});`);
}

/** What the cleanup left, counted on both sides. Every count must be zero. */
export async function leftovers(tag) {
  const n = names(tag);
  const [network] = await net('leftovers', `
    SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${n.orgPrefix} %`)})::int AS orgs,
           (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${n.emailPrefix}%`)})::int AS users,
           (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${n.workspacePrefix}%`)})::int AS workspaces,
           (SELECT count(*) FROM public.builder_stock_items i WHERE NOT EXISTS
              (SELECT 1 FROM public.builder_organisations o WHERE o.id = i.organisation_id))::int AS orphan_items,
           (SELECT count(*) FROM public.builder_stock_uploads u WHERE NOT EXISTS
              (SELECT 1 FROM public.builder_organisations o WHERE o.id = u.organisation_id))::int AS orphan_uploads`);
  // THIS run's organisations, by id: the mirror holds genuine stock of
  // organisations with no connection row, so "unconnected" is not a leftover.
  const ours = [...seededOrganisations].map(id).join(', ') || 'NULL::uuid';
  const [command] = await cc('leftovers', `
    SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${n.orgPrefix} %`)})::int AS connections,
           (SELECT count(*) FROM public.custom_users WHERE username LIKE ${sqlLit(`${n.ccUserPrefix}%`)})::int AS staff,
           (SELECT count(*) FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${n.clientSurname} %`)})::int AS clients,
           (SELECT count(*) FROM public.builder_network_stock_items WHERE organisation_id IN (${ours}))::int AS items,
           (SELECT count(*) FROM public.builder_network_stock_organisations WHERE id IN (${ours}))::int AS organisations,
           (SELECT count(*) FROM public.builder_stock_selections WHERE organisation_id IN (${ours}))::int AS selections`);
  return { network, command };
}

/** The last word of every run: counts, then an exit code that means what it says. */
export function finish(label, extra = {}) {
  const required = results.filter((r) => r.required);
  const failed = required.filter((r) => !r.ok);
  const notes = results.filter((r) => !r.required && !r.ok);
  console.log(`\n${label}: ${required.length - failed.length}/${required.length} required checks passed`
    + (notes.length ? `, ${notes.length} note(s)` : ''));
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log(`VERDICT ${label} ${failed.length ? 'FAIL' : 'PASS'} ${JSON.stringify(extra)}`);
  process.exitCode = failed.length ? 1 : 0;
}
