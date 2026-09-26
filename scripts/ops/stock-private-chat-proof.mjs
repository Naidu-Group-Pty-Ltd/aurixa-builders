#!/usr/bin/env node
/**
 * ===========================================================================
 * ONE ACTIVATION, ONE PRIVATE CONVERSATION — PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * docs/builder-portal/52 (Command Centre) and 62 (network). Everything travels
 * the real way: both live doors, both workers' signatures, both message lanes,
 * both edge functions called as a person — the Builder Portal through its own
 * origin with a proof builder's session, the Command Centre through its own
 * function with a proof staff member's session. Proves, in the order given:
 *
 *    1  a Command Centre user activates a proof property;
 *    2  the builder acknowledges it through the portal;
 *    3  the activation's private conversation is established on both sides;
 *    4  the activator is notified, once;
 *    5  the acknowledgement email is queued, once, through the existing
 *       transactional outbox, and sent to a safe sink (Resend's
 *       delivered@resend.dev), never to a real person;
 *  6–8  the Activated Properties row carries the builder company's contact
 *       details, the activator and the acknowledger;
 *  9–10 the activator and the acknowledging builder can each read it;
 * 11–14 a Command Centre colleague, a builder colleague, another builder and
 *       another workspace are each refused;
 * 15–18 a same-side colleague is invited on each side, sees the whole history
 *       at once, a duplicate invite changes nothing, and two people with one
 *       name stay two people;
 * 19–20 a participant writes, and the invited colleague replies as themselves;
 * 21–24 nobody can remove anybody, the last participant of a live
 *       conversation cannot leave, can once a colleague has joined, and then
 *       loses access at once;
 *    25 participant events converge on the other side's display;
 *    26 a replayed acknowledgement adds no alert and no email;
 *    27 withdrawal closes writing and keeps the history for its participants;
 *    28 nothing about the client, no user id and no personal email crossed;
 *    29 no model was called;
 *    30 the cleanup leaves nothing this run created.
 *
 * Every row, workspace, connection, session and user it creates is deleted
 * on both sides before it exits, and the deletion is checked. No customer row
 * is read for its content or written. No secret and no link is printed.
 *
 * Runs from the production-rollout workflow (phase `stock-private-chat-proof`).
 */
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const CC_ORIGIN = process.env.COMMAND_CENTRE_ORIGIN || 'https://command-centre.npcservices.com.au';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'private-chat-proof';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const CC_USER_PREFIX = `${MARK}-${TAG}-`;
const CLIENT_SURNAME = `Private Chat Proof ${TAG}`;
/** Resend's own test recipient: accepted, never delivered to a person. */
const SAFE_SINK = (label) => `delivered+${TAG}-${label}-${RUN}@resend.dev`;
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 4_000;
const PARTICIPANT_KEYS = ['conversation_id', 'display_name', 'participant_ref', 'schema_version', 'side', 'state',
  'stock_item_id', 'version'];

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value) => {
  if (!UUID.test(String(value))) throw new Error('not a uuid');
  return `'${value}'::uuid`;
};
/** The shared derivation, recomputed here so neither side vouches for itself. */
const activationConversationId = (connectionId, selectionRef) => {
  const hex = createHash('md5').update(`agency.activation:${connectionId}:${selectionRef}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function query(ref, label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 300)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}
const net = (label, sql) => query(NETWORK_REF, `network ${label}`, sql);
const cc = (label, sql) => query(CC_REF, `cc ${label}`, sql);

/** A Builder Portal function through the same-origin proxy, as the browser calls it. */
async function portal(body, cookie) {
  const response = await fetch(`${ORIGIN}/fn/builder-portal-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, text: text.slice(0, 300), setCookies: response.headers.getSetCookie?.() ?? [] };
}
async function portalCall(fn, body, cookie = null) {
  const headers = { 'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${ORIGIN}/fn/${fn}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, setCookies: response.headers.getSetCookie?.() ?? [] };
}
/** The Command Centre's own function, as its page calls it, with a staff session. */
async function commandCentre(operation, body, sessionToken) {
  const response = await fetch(`https://${CC_REF}.supabase.co/functions/v1/builder-stock-marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: CC_ORIGIN, Cookie: `__Host-session_token=${sessionToken}` },
    body: JSON.stringify({ operation, ...(body ?? {}) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, text: text.slice(0, 300) };
}

async function waitFor(label, check, deadlineMs = DEADLINE_MS) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < deadlineMs) {
    last = await check();
    if (last?.done) return { ...last, ms: Date.now() - startedAt };
    await sleep(POLL_MS);
  }
  return { ...(last ?? {}), done: false, ms: Date.now() - startedAt, timedOut: label };
}
const secs = (w) => `${Math.round((w?.ms ?? 0) / 1000)} s${w?.timedOut ? ' (timed out)' : ''}`;

// --- Cleanup: everything this proof ever created, on both sides -------------
async function cleanup(stage) {
  const orgRows = await net(`${stage}: proof organisations`, `
    SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)}`);
  const orgIds = orgRows.map((row) => row.id).filter((value) => UUID.test(value));
  const ccConnections = await cc(`${stage}: proof connections`, `
    SELECT id, builder_organisation_id FROM public.builder_network_connections
     WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)}`);
  const ccOrgIds = [...new Set([...orgIds,
    ...ccConnections.map((row) => row.builder_organisation_id).filter((v) => UUID.test(String(v)))])];

  if (orgIds.length) {
    const orgList = orgIds.map(id).join(', ');
    const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList})`;
    await net(`${stage}: rows`, `
      DELETE FROM public.portal_operational_events WHERE metadata->>'connection_id' IN
        (SELECT c.id::text FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.builder_agency_conversations WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${connections});
      ALTER TABLE public.builder_project_status_history
        DISABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN (${orgList});
      ALTER TABLE public.builder_project_status_history
        ENABLE TRIGGER trg_builder_project_status_history_append_only;
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
    DELETE FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)};
    DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};`);

  const connList = ccConnections.length ? ccConnections.map((row) => id(row.id)).join(', ') : 'NULL::uuid';
  const orgList = ccOrgIds.length ? ccOrgIds.map(id).join(', ') : 'NULL::uuid';
  const users = `SELECT u.id FROM public.custom_users u WHERE u.username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)}`;
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
    DELETE FROM public.notifications WHERE target_user_id IN (${users});
    DELETE FROM public.user_sessions WHERE user_id IN (${users});
    DELETE FROM public.user_permissions WHERE user_id IN (${users});
    DELETE FROM public.builder_network_conversations WHERE connection_id IN (${connList});
    DELETE FROM public.builder_stock_selections WHERE organisation_id IN (${orgList});
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    DELETE FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)};
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    DELETE FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)};
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

/** A proof builder in an organisation of the run's own, detached in the SAME transaction. */
async function seedBuilder(label, name, { orgName, existingOrgId = null, contact = null, role = null }) {
  const email = `${MARK}-${TAG}-${label}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!private`;
  const orgSql = existingOrgId
    ? `SELECT ${id(existingOrgId)} AS id`
    : `INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at,
         contact_email, contact_phone, website)
       VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now(),
               ${contact ? sqlLit(contact.email) : 'NULL'}, ${contact ? sqlLit(contact.phone) : 'NULL'},
               ${contact ? sqlLit(contact.website) : 'NULL'}) RETURNING id`;
  const orgFilter = `SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(orgName)}`;
  const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgFilter})`;
  const rows = await net(`seed ${label}`, `
    WITH org AS (${orgSql}), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(name)}, 'active', true, now(), false,
              extensions.crypt(${sqlLit(password)}, extensions.gen_salt('bf', 10)))
      RETURNING id)
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT person.id, org.id, ${sqlLit(role ?? (existingOrgId ? 'member' : 'owner'))}, ${existingOrgId ? 'false' : 'true'}, 'active' FROM person, org;
    DELETE FROM public.builder_network_outbox
     WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text FROM public.workspace_connections c
                           WHERE c.builder_organisation_id IN (${orgFilter}));
    DELETE FROM public.workspace_connection_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connections});
    DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgFilter});
    SELECT p.id AS user_id, o.id AS org_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id)::int AS connections
      FROM public.builder_portal_users p, public.builder_organisations o
     WHERE p.email = ${sqlLit(email)} AND o.legal_name = ${sqlLit(orgName)}`);
  const row = rows[0] ?? {};
  if (!row.user_id || !row.org_id) throw new Error(`the ${label} proof builder could not be seeded`);
  if (Number(row.connections) !== 0) throw new Error(`the ${label} proof organisation is still connected; refusing`);
  await net('onboarding', `SELECT public.builder_ensure_onboarding_steps(${id(row.user_id)})`);
  return { email, password, name, userId: row.user_id, orgId: row.org_id };
}

async function establishSession(user) {
  const login = await portalCall('builder-portal-login', { email: user.email, password: user.password });
  const issued = login.setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-builder_session_token='));
  let cookie = issued;
  if (!(login.status === 200 && issued)) {
    if (!PEPPER) throw new Error('login issued no cookie and NETWORK_SESSION_PEPPER is not available');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHmac('sha256', PEPPER).update(token).digest('hex');
    await net('mint session', `
      SELECT public.builder_issue_session(${id(user.userId)}, ${sqlLit(tokenHash)},
        now() + interval '2 hours', now() + interval '2 hours', NULL, NULL, 'smoke-rollout')`);
    cookie = `__Host-builder_session_token=${token}`;
  }
  for (const action of [{ action: 'accept_current_terms', acknowledgements: ALL_ACKS }, { action: 'complete_onboarding' }]) {
    await portalCall('builder-portal-verify', action, cookie);
  }
  return cookie;
}

/** A proof staff member with Listings view and edit, and a session of their own. */
async function seedStaff(label, first, last, email) {
  await cc(`staff ${label}`, `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    INSERT INTO public.custom_users(username, email, password_hash, role, first_name, last_name, is_active)
    VALUES (${sqlLit(`${CC_USER_PREFIX}${label}-${RUN}`)}, ${sqlLit(email)},
            ${sqlLit(`not-a-password-${randomBytes(16).toString('hex')}`)}, 'proof_no_access', ${sqlLit(first)}, ${sqlLit(last)}, true);
    ALTER TABLE public.custom_users ENABLE TRIGGER USER;`);
  const userId = (await cc(`staff ${label} id`, `
    SELECT id FROM public.custom_users WHERE username = ${sqlLit(`${CC_USER_PREFIX}${label}-${RUN}`)}`))[0]?.id;
  if (!UUID.test(String(userId))) throw new Error(`the ${label} proof staff member could not be seeded`);
  await cc(`staff ${label} listings`, `
    INSERT INTO public.user_permissions(user_id, module_id, can_view, can_edit, can_delete)
    SELECT ${id(userId)}, m.id, true, true, false FROM public.dashboard_modules m WHERE m.module_key = 'listings'`);
  const token = randomBytes(32).toString('hex');
  await cc(`staff ${label} session`, `
    INSERT INTO public.user_sessions(user_id, session_token, expires_at, idle_expires_at, portal_scope)
    VALUES (${id(userId)}, ${sqlLit(token)}, now() + interval '2 hours', now() + interval '2 hours', 'staff')`);
  return { userId, token, name: `${first} ${last}` };
}

// --- The proof ---------------------------------------------------------------
const runStartedAt = new Date().toISOString();
try {
  console.log(`private chat proof run=${RUN}`);

  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  await cleanup('start');

  const shipped = {
    network: (await net('shipped', `
      SELECT to_regclass('public.builder_agency_conversation_participants') IS NOT NULL AS participants,
             to_regprocedure('public.builder_agency_invite_participant(uuid,uuid,uuid,uuid)') IS NOT NULL AS invite`))[0] ?? {},
    cc: (await cc('shipped', `
      SELECT to_regclass('public.builder_network_conversation_participants') IS NOT NULL AS participants,
             to_regprocedure('public.builder_network_invite_participant(uuid,uuid,uuid)') IS NOT NULL AS invite,
             (SELECT value = 'true'::jsonb FROM public.feature_flags WHERE key = 'builder_network_enabled') AS network_on`))[0] ?? {},
  };
  if (!record('0: both halves are migrated (participants, invitations) and the network is on',
    shipped.network.participants && shipped.network.invite && shipped.cc.participants && shipped.cc.invite && shipped.cc.network_on,
    JSON.stringify(shipped))) throw new Error('not deployed');

  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)} LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');

  // Proof organisations, builders and staff. The company's contact details are
  // the organisation's own; no person's.
  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const contact = { email: `sales-${RUN}@example.com`, phone: '03 9000 0000', website: `https://example.com/${TAG}-${RUN}` };
  const acknowledger = await seedBuilder('ack', `Avery Builder ${RUN}`, { orgName, contact });
  // The invited colleague WRITES (checks 20 and 27), and writing needs
  // `inventory` edit: a plain member holds view only and is rightly refused.
  const invitee = await seedBuilder('invitee', `Bailey Builder ${RUN}`,
    { orgName, existingOrgId: acknowledger.orgId, role: 'manager' });
  const outsiderBuilder = await seedBuilder('outsider', `Blake Builder ${RUN}`, { orgName, existingOrgId: acknowledger.orgId });
  const otherBuilder = await seedBuilder('other', `Otto Other ${RUN}`, { orgName: `${ORG_PREFIX} other ${RUN} Pty Ltd` });
  const item = (await net('item', `
    INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, availability_status, image_work_stage,
      enrichment_status, address_line, suburb, state, postcode, lot_number, price_display, description)
    VALUES (${id(acknowledger.orgId)}, 'staged', 'on_hold', 'settled', 'complete', '1 Private Chat Proof Street', 'Proofvale',
      'VIC', '3999', '7${RUN.slice(-3)}', 'Proof only — not for sale', 'An invented property. Not for sale.')
    RETURNING id`))[0].id;

  // The proof-only transport: our workspace's connection, and another
  // workspace's connection to the same builder (it never reaches the CC).
  const connection = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const foreignConnection = randomUUID();
  const foreignSecret = randomBytes(32).toString('hex');
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(acknowledger.orgId)})`);
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Private chat proof (temporary)') RETURNING id`))[0].id;
  await net('connection', `
    INSERT INTO public.workspace_connections(id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(acknowledger.orgId)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);
  await net('activate item', `UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id = ${id(item)}`);
  const mirrored = await waitFor('mirror', async () => {
    const rows = await cc('mirror', `
      SELECT (SELECT count(*) FROM public.builder_network_stock_items WHERE id = ${id(item)})::int AS n,
             (SELECT contact_email FROM public.builder_network_stock_organisations WHERE id = ${id(acknowledger.orgId)}) AS email`);
    return { done: Number(rows[0]?.n) === 1 && rows[0]?.email === contact.email };
  });
  if (!record('0: the property and its company contact reach the Command Centre', mirrored.done, secs(mirrored))) {
    throw new Error('the property never arrived');
  }
  const foreignWorkspace = (await net('foreign workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}-other`)}, 'Another workspace (temporary)') RETURNING id`))[0].id;
  await net('foreign connection', `
    INSERT INTO public.workspace_connections(id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(foreignConnection)}, ${id(foreignWorkspace)}, ${id(acknowledger.orgId)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(foreignSecret)}, now(), now())`);

  const owner = await seedStaff('owner', 'Olive', `Owner ${RUN}`, SAFE_SINK('owner'));
  const ccColleague = await seedStaff('colleague', 'Casey', `Colleague ${RUN}`, `${CC_USER_PREFIX}colleague-${RUN}@example.com`);
  const ccTwin = await seedStaff('twin', 'Olive', `Owner ${RUN}`, `${CC_USER_PREFIX}twin-${RUN}@example.com`);
  const ccOutsider = await seedStaff('outsider', 'Oscar', `Outsider ${RUN}`, `${CC_USER_PREFIX}outsider-${RUN}@example.com`);
  const client = (await cc('client', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    INSERT INTO public.clients(primary_first_name, primary_surname) VALUES ('Proof', ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)});
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    SELECT id FROM public.clients WHERE primary_surname = ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)}`))[0];

  // 1. Activate.
  const selection = (await cc('selection', `
    INSERT INTO public.builder_stock_selections(stock_item_id, organisation_id, client_id, selected_by_user_id, status, internal_notes)
    VALUES (${id(item)}, ${id(acknowledger.orgId)}, ${id(client.id)}, ${id(owner.userId)}, 'selected', ${sqlLit(`private note ${RUN}`)})
    RETURNING id`))[0];
  const announced = await waitFor('announcement', async () => {
    const rows = await net('announcement', `
      SELECT id, status FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
    return { done: rows.length === 1 && rows[0].status === 'selected', row: rows[0] };
  });
  if (!record('1: a Command Centre user activates the property, and the builder is told', announced.done, secs(announced))) {
    throw new Error('the activation never arrived');
  }
  const conversationId = activationConversationId(connection, selection.id);

  // 2. The builder acknowledges through the portal.
  const ackCookie = await establishSession(acknowledger);
  const ack = await portal({ operation: 'acknowledge_selection', selection_id: announced.row.id }, ackCookie);
  record('2: the builder acknowledges through the portal', ack.status === 200 && ack.json?.record?.status === 'builder_acknowledged',
    `HTTP ${ack.status}`);

  // 3. The private conversation, on both sides, under the shared derivation.
  const established = await waitFor('established', async () => {
    const here = (await cc('cc conversation', `
      SELECT (SELECT selection_ref FROM public.builder_network_conversations WHERE id = ${id(conversationId)}) AS bound,
             (SELECT string_agg(side || ':' || display_name, ',' ORDER BY side, display_name)
                FROM public.builder_network_conversation_participants
               WHERE conversation_id = ${id(conversationId)} AND state = 'joined') AS people,
             (SELECT acknowledged_by_display_name FROM public.builder_stock_selections WHERE id = ${id(selection.id)}) AS ack_name`))[0] ?? {};
    const there = (await net('network conversation', `
      SELECT (SELECT selection_ref FROM public.builder_agency_conversations WHERE id = ${id(conversationId)}) AS bound,
             (SELECT string_agg(side || ':' || display_name, ',' ORDER BY side, display_name)
                FROM public.builder_agency_conversation_participants
               WHERE conversation_id = ${id(conversationId)} AND state = 'joined') AS people`))[0] ?? {};
    return {
      here, there,
      done: here.bound === selection.id && there.bound === selection.id
        && here.people === `builder:${acknowledger.name},command_centre:${owner.name}`
        && there.people === `builder:${acknowledger.name},command_centre:${owner.name}`,
    };
  });
  record('3: the private conversation is established on both sides, with the activator and the acknowledger',
    established.done, `${established.here?.people ?? '-'} | ${established.there?.people ?? '-'} in ${secs(established)}`);

  // 4–5. Notified once; emailed once, through the existing outbox, to a sink.
  const notices = await cc('notifications', `
    SELECT title, message, link FROM public.notifications
     WHERE target_user_id = ${id(owner.userId)} AND type = 'builder_activation_acknowledged'`);
  const noticeText = notices.map((n) => `${n.title} ${n.message}`).join(' ');
  record('4: the activator is notified once, naming the company, the property and the acknowledger',
    notices.length === 1 && noticeText.includes(orgName) && noticeText.includes('1 Private Chat Proof Street')
      && noticeText.includes(acknowledger.name) && notices[0].link === '/admin/builder-portal/activated',
    `${notices.length} notification(s)`);
  const emailed = await waitFor('email', async () => {
    const row = (await cc('email', `
      SELECT (SELECT count(*) FROM public.integration_outbox
               WHERE idempotency_key = 'builder_activation_acknowledged:' || ${sqlLit(selection.id)})::int AS queued,
             (SELECT email_sent_at IS NOT NULL FROM public.builder_network_acknowledgement_notices
               WHERE selection_id = ${id(selection.id)}) AS sent,
             (SELECT payload::text FROM public.integration_outbox
               WHERE idempotency_key = 'builder_activation_acknowledged:' || ${sqlLit(selection.id)}) AS payload`))[0] ?? {};
    return { row, done: Number(row.queued) === 1 && row.sent === true };
  });
  record('5: the acknowledgement email is queued once on the existing outbox, carrying only which activation',
    Number(emailed.row?.queued) === 1 && JSON.stringify(Object.keys(JSON.parse(emailed.row?.payload ?? '{}'))) === '["selection_id"]',
    `${emailed.row?.queued ?? 0} queued`);
  record('5: …and the worker sent it (to Resend\'s test sink) and stamped it sent', emailed.done, secs(emailed));

  // 6–8. The Activated Properties row.
  const rows = await commandCentre('list_builder_portal_activations', {}, owner.token);
  const row = (rows.json?.activations ?? []).find((r) => r.stock_item_id === item);
  record('6: the row carries the builder company\'s public email, phone and website',
    rows.status === 200 && row?.builder_email === contact.email && row?.builder_phone === contact.phone
      && row?.builder_website === contact.website, `HTTP ${rows.status}`);
  record('7: the row names the activating Command Centre user', row?.activated_by === owner.name);
  record('8: the row names the acknowledging builder staff member, and links the viewer\'s conversation',
    row?.acknowledged_by === acknowledger.name && row?.status === 'acknowledged' && row?.conversation_id === conversationId);

  // 9–10. Both of them read it.
  const ownerRead = await commandCentre('get_builder_conversation', { conversation_id: conversationId }, owner.token);
  const ackRead = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, ackCookie);
  record('9: the activating user reads the conversation', ownerRead.status === 200 && ownerRead.json?.open === true,
    `HTTP ${ownerRead.status}`);
  record('10: the acknowledging builder reads it', ackRead.status === 200 && ackRead.json?.open === true, `HTTP ${ackRead.status}`);
  // 10a. The builder's Messages list names the agency — the activation's own
  // name, else the workspace's — never the placeholder "Agency".
  const ackList = await portal({ operation: 'list_my_agency_conversations' }, ackCookie);
  const listed = (ackList.json?.conversations ?? []).find((c) => c.conversation_id === conversationId);
  record('10a: the builder\'s Messages list names the agency the conversation is with',
    ackList.status === 200 && !!listed && typeof listed.agency_name === 'string'
      && listed.agency_name.trim().length > 0 && listed.agency_name !== 'Agency',
    `agency_name=${listed?.agency_name ?? 'none'}`);

  // 19 (first part): a participant writes, so there is history to prove with.
  const firstBody = `Is lot ${RUN} still available?`;
  const first = await commandCentre('send_builder_message',
    { conversation_id: conversationId, client_message_id: randomUUID(), body: firstBody }, owner.token);
  const firstId = first.json?.message?.id;
  const firstArrived = await waitFor('first message', async () => {
    const there = (await net('message', `
      SELECT sender_display_name, body FROM public.builder_agency_messages WHERE id = ${id(firstId ?? randomUUID())}`))[0];
    const here = (await cc('message', `
      SELECT delivery_state FROM public.builder_network_messages WHERE id = ${id(firstId ?? randomUUID())}`))[0];
    return { there, here, done: !!there && here?.delivery_state === 'delivered' };
  });
  record('19: a participant writes; it arrives under their name and becomes Delivered',
    first.status === 200 && firstArrived.done && firstArrived.there?.sender_display_name === owner.name,
    `HTTP ${first.status}, ${secs(firstArrived)}`);

  // 11–14. Everyone else is refused.
  const outsiderRead = await commandCentre('get_builder_conversation', { conversation_id: conversationId }, ccOutsider.token);
  const outsiderSend = await commandCentre('send_builder_message',
    { conversation_id: conversationId, client_message_id: randomUUID(), body: 'Let me in.' }, ccOutsider.token);
  record('11: a Command Centre colleague who is not in it is refused, and given no message',
    outsiderRead.status === 403 && outsiderRead.json?.code === 'not_a_participant' && !outsiderRead.text.includes(firstBody)
      && outsiderSend.status === 403, `read ${outsiderRead.status}, send ${outsiderSend.status}`);
  const outsiderBuilderCookie = await establishSession(outsiderBuilder);
  const builderOutsiderRead = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, outsiderBuilderCookie);
  record('12: a builder colleague who is not in it is refused, and given no message',
    builderOutsiderRead.status === 403 && builderOutsiderRead.json?.code === 'not_a_participant'
      && !builderOutsiderRead.text.includes(firstBody), `HTTP ${builderOutsiderRead.status}`);
  const otherCookie = await establishSession(otherBuilder);
  const otherRead = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, otherCookie);
  record('13: another builder reaches nothing', otherRead.status === 404 && !otherRead.text.includes(firstBody),
    `HTTP ${otherRead.status}`);
  const deliver = async (door, connectionId, connectionSecret, eventType, payload, dedupeKey) => {
    const rawBody = JSON.stringify({ event_type: eventType, dedupe_key: dedupeKey, payload, source_version: 1 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(door, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-aurixa-connection': connectionId, 'x-aurixa-timestamp': timestamp,
        'x-aurixa-signature': createHmac('sha256', connectionSecret).update(`${timestamp}.${rawBody}`).digest('hex'),
      },
      body: rawBody,
    });
    return response.status;
  };
  const foreignMessageId = randomUUID();
  const foreignRef = randomUUID();
  const foreignMessage = await deliver(networkDoor, foreignConnection, foreignSecret, 'agency.message.posted', {
    schema_version: 1, conversation_id: conversationId, message_id: foreignMessageId, stock_item_id: item,
    body: 'From another workspace.', sender_display_name: 'Another Workspace', sent_at: new Date().toISOString(), generation: 1,
  }, `agency.message:${foreignMessageId}:1`);
  const foreignJoin = await deliver(networkDoor, foreignConnection, foreignSecret, 'agency.message.participant', {
    schema_version: 1, conversation_id: conversationId, stock_item_id: item, participant_ref: foreignRef,
    display_name: 'Another Workspace', side: 'command_centre', state: 'joined', version: 1,
  }, `agency.participant:${conversationId}:${foreignRef}:1`);
  await net('sweep', 'SELECT * FROM public.builder_agency_apply_message_events(50)');
  const foreignOutcome = (await net('foreign outcome', `
    SELECT (SELECT count(*) FROM public.builder_agency_messages WHERE id = ${id(foreignMessageId)})::int AS stored,
           (SELECT count(*) FROM public.builder_agency_conversation_participants WHERE participant_ref = ${id(foreignRef)})::int AS joined,
           (SELECT string_agg(message_apply_error, ',' ORDER BY received_at) FROM public.builder_network_inbound_events
             WHERE connection_id = ${id(foreignConnection)} AND event_type LIKE 'agency.%') AS errors`))[0] ?? {};
  record('14: another workspace\'s signed message and participant naming this conversation are refused and stored nowhere',
    foreignMessage === 200 && foreignJoin === 200 && Number(foreignOutcome.stored) === 0 && Number(foreignOutcome.joined) === 0
      && /conversation_mismatch/.test(String(foreignOutcome.errors ?? '')), `${foreignOutcome.errors ?? 'no outcome'}`);

  // 22. The last participant on this side of a live conversation cannot leave.
  const lastLeave = await commandCentre('leave_builder_conversation', { conversation_id: conversationId }, owner.token);
  const lastLeaveBuilder = await portal({ operation: 'leave_agency_conversation', conversation_id: conversationId }, ackCookie);
  record('22: the last participant on a side of a live conversation cannot leave (either side)',
    lastLeave.status === 409 && lastLeave.json?.code === 'last_participant'
      && lastLeaveBuilder.status === 409 && lastLeaveBuilder.json?.code === 'last_participant',
    `cc ${lastLeave.status}, portal ${lastLeaveBuilder.status}`);

  // 15–18. Invitations.
  const invited = await commandCentre('invite_builder_conversation_participant',
    { conversation_id: conversationId, invitee_user_id: ccColleague.userId }, owner.token);
  const invitedBuilder = await portal({ operation: 'invite_agency_conversation_participant',
    conversation_id: conversationId, invitee_user_id: invitee.userId }, ackCookie);
  record('15: a participant invites a same-side colleague, on each side',
    invited.status === 200 && invited.json?.result === 'joined' && invitedBuilder.status === 200 && invitedBuilder.json?.result === 'joined',
    `cc ${invited.status}, portal ${invitedBuilder.status}`);
  const colleagueRead = await commandCentre('get_builder_conversation', { conversation_id: conversationId }, ccColleague.token);
  const inviteeCookie = await establishSession(invitee);
  const inviteeRead = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, inviteeCookie);
  record('16: the invitee immediately sees the whole history',
    colleagueRead.status === 200 && (colleagueRead.json?.messages ?? []).some((m) => m.body === firstBody)
      && inviteeRead.status === 200 && (inviteeRead.json?.messages ?? []).some((m) => m.body === firstBody),
    `cc ${colleagueRead.status}, portal ${inviteeRead.status}`);
  const eventsBefore = Number((await cc('participant events', `
    SELECT count(*)::int AS n FROM public.builder_network_outbox
     WHERE event_type = 'agency.message.participant' AND payload->>'conversation_id' = ${sqlLit(conversationId)}`))[0]?.n);
  const again = await commandCentre('invite_builder_conversation_participant',
    { conversation_id: conversationId, invitee_user_id: ccColleague.userId }, owner.token);
  const eventsAfter = Number((await cc('participant events', `
    SELECT count(*)::int AS n FROM public.builder_network_outbox
     WHERE event_type = 'agency.message.participant' AND payload->>'conversation_id' = ${sqlLit(conversationId)}`))[0]?.n);
  const colleagueRows = Number((await cc('colleague rows', `
    SELECT count(*)::int AS n FROM public.builder_network_conversation_participants
     WHERE conversation_id = ${id(conversationId)} AND local_user_id = ${id(ccColleague.userId)}`))[0]?.n);
  record('17: a duplicate invite creates nothing extra', again.status === 200 && again.json?.result === 'already_participant'
    && eventsAfter === eventsBefore && colleagueRows === 1, `${again.json?.result ?? again.status}`);
  const twinInvited = await commandCentre('invite_builder_conversation_participant',
    { conversation_id: conversationId, invitee_user_id: ccTwin.userId }, owner.token);
  const twins = await waitFor('twins', async () => {
    const rows = await net('twins', `
      SELECT participant_ref FROM public.builder_agency_conversation_participants
       WHERE conversation_id = ${id(conversationId)} AND side = 'command_centre' AND display_name = ${sqlLit(owner.name)}
         AND state = 'joined'`);
    return { rows, done: rows.length === 2 && rows[0].participant_ref !== rows[1].participant_ref };
  });
  record('18: two people with one name are two participants on the other side, told apart by reference',
    twinInvited.json?.result === 'joined' && twins.done, `${twins.rows?.length ?? 0} in ${secs(twins)}`);

  // 20. The invited colleagues reply as themselves. Before they do, each
  // Command Centre reader takes the new-message popup's cursor, exactly as the
  // mounted popup does on its first read.
  const popupCursor = {};
  for (const [who, reader] of [['participant', ccColleague], ['outsider', ccOutsider]]) {
    const first = await commandCentre('list_new_builder_messages', {}, reader.token);
    popupCursor[who] = first.json?.cursor ?? null;
  }
  const builderSentAt = Date.now();
  const reply = await commandCentre('send_builder_message',
    { conversation_id: conversationId, client_message_id: randomUUID(), body: 'Adding: settlement in June.' }, ccColleague.token);
  const builderReply = await portal({ operation: 'send_agency_message', conversation_id: conversationId,
    client_message_id: randomUUID(), body: 'Yes — titles are due in the second quarter.' }, inviteeCookie);
  const replies = await waitFor('replies', async () => {
    const there = (await net('reply', `
      SELECT sender_display_name FROM public.builder_agency_messages WHERE id = ${id(reply.json?.message?.id ?? randomUUID())}`))[0];
    const here = (await cc('reply', `
      SELECT sender_display_name FROM public.builder_network_messages WHERE id = ${id(builderReply.json?.message?.id ?? randomUUID())}`))[0];
    return { there, here, done: there?.sender_display_name === ccColleague.name && here?.sender_display_name === invitee.name };
  });
  record('20: the invited colleagues reply as themselves, and each reply crosses', replies.done, secs(replies));

  // 20a/20b. The Command Centre popup: a participant is told the builder wrote,
  // by the builder company's name, without the message body; an outsider is
  // told nothing. Measured from the builder's send, the way the popup polls.
  const popup = await waitFor('popup', async () => {
    const read = await commandCentre('list_new_builder_messages', { since: popupCursor.participant }, ccColleague.token);
    const hit = (read.json?.messages ?? []).find((m) => m.message_id === builderReply.json?.message?.id);
    return { read, hit, done: !!hit };
  });
  const popupAfterSendMs = Date.now() - builderSentAt;
  record('20a: the Command Centre popup names the builder company to a participant, without the message',
    popup.done && popup.hit?.builder_name === orgName && popup.hit?.sender_display_name === invitee.name
      && !('body' in (popup.hit ?? {})) && !JSON.stringify(popup.read?.json ?? {}).includes('titles are due'),
    `builder_name=${popup.hit?.builder_name === orgName ? 'the company' : popup.hit?.builder_name} `
      + `builder send→popup ${popupAfterSendMs}ms (polled)`);
  const outsiderPopup = await commandCentre('list_new_builder_messages', { since: popupCursor.outsider }, ccOutsider.token);
  const ownSide = (popup.read?.json?.messages ?? []).some((m) => m.message_id === reply.json?.message?.id);
  record('20b: a Command Centre user outside the conversation is told nothing, and nobody is alerted to their own side',
    outsiderPopup.status === 200 && (outsiderPopup.json?.messages ?? []).length === 0 && !ownSide,
    `outsider=${(outsiderPopup.json?.messages ?? []).length} own-side-listed=${ownSide}`);

  // 21. Nobody can remove anybody.
  const removeCc = await commandCentre('remove_builder_conversation_participant',
    { conversation_id: conversationId, user_id: ccColleague.userId }, owner.token);
  const removePortal = await portal({ operation: 'remove_agency_conversation_participant',
    conversation_id: conversationId, user_id: invitee.userId }, ackCookie);
  const removers = [
    ...(await cc('removers', `SELECT count(*)::int AS n FROM pg_proc WHERE proname ~ '^builder_network_.*(remove|evict)_?(participant|user|member)'`)),
    ...(await net('removers', `SELECT count(*)::int AS n FROM pg_proc WHERE proname ~ '^builder_agency_.*(remove|evict)_?(participant|user|member)'`)),
  ];
  const stillThere = Number((await cc('still there', `
    SELECT count(*)::int AS n FROM public.builder_network_conversation_participants
     WHERE conversation_id = ${id(conversationId)} AND local_user_id = ${id(ccColleague.userId)} AND state = 'joined'`))[0]?.n);
  record('21: a participant cannot remove somebody else (no operation exists, on either side)',
    removeCc.status >= 400 && removePortal.status >= 400 && removers.every((r) => Number(r.n) === 0) && stillThere === 1,
    `cc ${removeCc.status}, portal ${removePortal.status}`);

  // 23–24. Once a colleague has joined, the original participant can leave, and loses access at once.
  const left = await commandCentre('leave_builder_conversation', { conversation_id: conversationId }, owner.token);
  record('23: after a colleague has joined, the participant can leave', left.status === 200 && left.json?.result === 'left',
    `HTTP ${left.status}`);
  const afterRead = await commandCentre('get_builder_conversation', { conversation_id: conversationId }, owner.token);
  const afterSend = await commandCentre('send_builder_message',
    { conversation_id: conversationId, client_message_id: randomUUID(), body: 'Am I still here?' }, owner.token);
  const afterList = await commandCentre('list_builder_portal_activations', {}, owner.token);
  record('24: the departed user loses access at once (read, send, and the conversation link)',
    afterRead.status === 403 && afterRead.json?.code === 'not_a_participant' && !afterRead.text.includes(firstBody)
      && afterSend.status === 403
      && (afterList.json?.activations ?? []).find((r) => r.stock_item_id === item)?.conversation_id === null,
    `read ${afterRead.status}, send ${afterSend.status}`);

  // 25. Participant events converge on the other side's display.
  const converged = await waitFor('converged', async () => {
    const there = (await net('display', `
      SELECT string_agg(side || ':' || display_name || ':' || state, ',' ORDER BY side, display_name, state) AS people
        FROM public.builder_agency_conversation_participants WHERE conversation_id = ${id(conversationId)}`))[0]?.people;
    const here = (await cc('display', `
      SELECT string_agg(side || ':' || display_name || ':' || state, ',' ORDER BY side, display_name, state) AS people
        FROM public.builder_network_conversation_participants WHERE conversation_id = ${id(conversationId)}`))[0]?.people;
    const expected = [
      `builder:${acknowledger.name}:joined`, `builder:${invitee.name}:joined`,
      `command_centre:${ccColleague.name}:joined`, `command_centre:${owner.name}:joined`, `command_centre:${owner.name}:left`,
    ].sort().join(',');
    return { here, there, done: here === expected && there === expected };
  });
  record('25: participant events converge on both displays (joins, the twin, the leave)', converged.done,
    `${secs(converged)}`);

  // 26. A replayed acknowledgement adds no alert and no email.
  const replayAck = await deliver(ccDoor, connection, secret, 'stock.selection.acknowledged', {
    remote_selection_ref: selection.id, stock_item_id: item, status: 'builder_acknowledged',
    acknowledged_at: new Date().toISOString(), acknowledged_by_display_name: 'Someone Else',
  }, `stock.selection.acknowledged:${connection}:${selection.id}:replay-${RUN}`);
  await cc('sweeps', `SELECT * FROM public.builder_network_apply_inbound_events(50);
                      SELECT public.builder_network_process_acknowledgements(50)`);
  const afterReplay = (await cc('after replay', `
    SELECT (SELECT count(*) FROM public.notifications WHERE target_user_id = ${id(owner.userId)}
             AND type = 'builder_activation_acknowledged')::int AS notifications,
           (SELECT count(*) FROM public.integration_outbox
             WHERE idempotency_key = 'builder_activation_acknowledged:' || ${sqlLit(selection.id)})::int AS emails,
           (SELECT acknowledged_by_display_name FROM public.builder_stock_selections WHERE id = ${id(selection.id)}) AS name`))[0] ?? {};
  record('26: a replayed acknowledgement creates no second alert or email, and renames nobody',
    replayAck === 200 && afterReplay.notifications === 1 && afterReplay.emails === 1 && afterReplay.name === acknowledger.name,
    JSON.stringify({ door: replayAck, ...afterReplay }));

  // 27. Withdrawal closes writing; the history stays for its participants.
  await cc('withdraw', `
    UPDATE public.builder_stock_selections SET status = 'withdrawn', withdrawn_at = now() WHERE id = ${id(selection.id)}`);
  const withdrawn = await waitFor('withdrawal', async () => {
    const rows = await net('announcement', `
      SELECT status FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
    return { done: rows[0]?.status === 'withdrawn' };
  });
  const closedCc = await commandCentre('send_builder_message',
    { conversation_id: conversationId, client_message_id: randomUUID(), body: 'Still there?' }, ccColleague.token);
  const closedPortal = await portal({ operation: 'send_agency_message', conversation_id: conversationId,
    client_message_id: randomUUID(), body: 'Still there?' }, inviteeCookie);
  const closedInvite = await commandCentre('invite_builder_conversation_participant',
    { conversation_id: conversationId, invitee_user_id: ccOutsider.userId }, ccColleague.token);
  const historyCc = await commandCentre('get_builder_conversation', { conversation_id: conversationId }, ccColleague.token);
  const historyPortal = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, inviteeCookie);
  record('27: withdrawal closes writing and inviting on both sides, and keeps the history for its participants',
    withdrawn.done && closedCc.status === 409 && closedPortal.status === 409 && closedInvite.status === 409
      && historyCc.status === 200 && historyCc.json?.open === false && (historyCc.json?.messages ?? []).length >= 3
      && historyPortal.status === 200 && historyPortal.json?.open === false,
    `cc ${closedCc.status}/${historyCc.status}, portal ${closedPortal.status}/${historyPortal.status}`);

  // 28. Nothing private crossed.
  const crossed = [
    ...(await cc('cc wire', `
      SELECT o.event_type, o.payload FROM public.builder_network_outbox o
        JOIN public.builder_network_connections c ON c.id = o.connection_id
       WHERE c.network_connection_id = ${id(connection)}`)),
    ...(await net('network wire', `
      SELECT event_type, payload FROM public.builder_network_outbox WHERE connection_id = ${id(connection)}`)),
  ].map((r) => ({ type: r.event_type, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
  const wire = JSON.stringify(crossed.map((r) => r.payload));
  const newWire = JSON.stringify(crossed.filter((r) => r.type.startsWith('agency.')).map((r) => r.payload));
  const participantOff = crossed.filter((r) => r.type === 'agency.message.participant'
    && JSON.stringify(Object.keys(r.payload ?? {}).sort()) !== JSON.stringify(PARTICIPANT_KEYS));
  // Labelled, so a failure names WHAT crossed (never the value) and in which event type.
  const privateValues = [
    ['client id', client.id], ['client name', `${CLIENT_SURNAME} ${RUN}`], ['client note', `private note ${RUN}`],
    ['activator user id', owner.userId], ['cc colleague user id', ccColleague.userId], ['cc twin user id', ccTwin.userId],
    ['acknowledger user id', acknowledger.userId], ['invitee user id', invitee.userId],
    ['activator email', SAFE_SINK('owner')], ['acknowledger email', acknowledger.email], ['invitee email', invitee.email],
    ['cc colleague email', `${CC_USER_PREFIX}colleague-${RUN}@example.com`],
  ];
  // The activation reference is the OLD protocol's (stock.selection.*), which
  // carries it by design; the question is whether a NEW event carries it.
  // The activation announcement's `agency` block is the workspace's AUTHORISED
  // self-disclosure — the acting adviser's outward contact (name, email, phone),
  // decided by the product owner in Phase 7 wave 5 (CC migration
  // 20261201090000) and unchanged by this step. It is the one place a person's
  // email may ride; everything else in every event is still held to the list.
  const withoutAuthorisedAgency = (r) => {
    if (!r.type.startsWith('stock.selection.') || !r.payload || typeof r.payload !== 'object') return r.payload;
    const { agency: _agency, ...rest } = r.payload;
    return rest;
  };
  const leaked = privateValues.flatMap(([label, value]) => crossed
    .filter((r) => JSON.stringify(withoutAuthorisedAgency(r)).includes(value)).map((r) => `${label} in ${r.type}`));
  const leakedValues = leaked.length;
  const refInNewEvents = newWire.includes(selection.id);
  record('28: no client, note, user id or personal email crossed; participant events carry exactly their keys',
    crossed.length > 0 && leakedValues === 0 && participantOff.length === 0 && !refInNewEvents,
    `${crossed.length} payload(s), ${participantOff.length} off contract, ${leakedValues} private value(s), `
      + `activation ref in new events: ${refInNewEvents}${leaked.length ? ` [${[...new Set(leaked)].join('; ')}]` : ''}`);

  // 29. No model was called.
  const ccModelCalls = Number((await cc('model calls', `
    SELECT count(*)::int AS n FROM public.api_usage_log
     WHERE created_at >= ${sqlLit(runStartedAt)}::timestamptz
       AND user_id IN (${[owner.userId, ccColleague.userId, ccTwin.userId, ccOutsider.userId].map(id).join(', ')})`))[0]?.n);
  const netModelCalls = Number((await net('model calls', `
    SELECT count(*)::int AS n FROM public.ai_spend_reservations WHERE created_at >= ${sqlLit(runStartedAt)}::timestamptz`))[0]?.n);
  record('29: no model was called by the Command Centre for this run, and none on the network during it',
    ccModelCalls === 0 && netModelCalls === 0, `command centre ${ccModelCalls}, network ${netModelCalls}`);
} catch (error) {
  record('the proof ran to the end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end');
    const leftNetwork = (await net('left', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS orgs,
             (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)})::int AS workspaces,
             (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)})::int AS users,
             (SELECT count(*) FROM public.builder_stock_items WHERE address_line = '1 Private Chat Proof Street')::int AS items`))[0];
    const leftCc = (await cc('left', `
      SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS connections,
             (SELECT count(*) FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)})::int AS staff,
             (SELECT count(*) FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)})::int AS clients,
             (SELECT count(*) FROM public.builder_network_stock_items WHERE address_line = '1 Private Chat Proof Street')::int AS items,
             (SELECT count(*) FROM public.notifications n WHERE n.type = 'builder_activation_acknowledged'
               AND n.message LIKE ${sqlLit(`%${ORG_PREFIX}%`)})::int AS notifications,
             (SELECT count(*) FROM public.user_sessions s WHERE NOT EXISTS (SELECT 1 FROM public.custom_users u WHERE u.id = s.user_id))::int AS orphan_sessions`))[0];
    record('30: cleanup leaves zero proof artefacts on either side',
      leftNetwork.orgs === 0 && leftNetwork.workspaces === 0 && leftNetwork.users === 0 && leftNetwork.items === 0
        && leftCc.connections === 0 && leftCc.staff === 0 && leftCc.clients === 0 && leftCc.items === 0
        && leftCc.notifications === 0 && leftCc.orphan_sessions === 0,
      JSON.stringify({ ...leftNetwork, ...leftCc }));
  } catch (error) {
    record('30: cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length} of ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
