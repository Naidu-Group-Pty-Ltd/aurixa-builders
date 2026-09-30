#!/usr/bin/env node
/**
 * ===========================================================================
 * MESSAGES ARRIVE FASTER, AND A BUILDER IS TOLD WHEN AN AGENCY WRITES —
 * MEASURED AND PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * docs/builder-portal/64. Everything travels the real way: both live doors,
 * both workers, both message lanes, the Builder Portal through its own origin
 * with a proof builder's session, the Command Centre through its own function
 * with a proof staff member's session, and a real Chromium on the deployed
 * portal. On disposable rows of the run's own (the transport, seeding and
 * cleanup are `stock-private-chat-proof`'s):
 *
 *   0  both projects reachable, both halves of the private chat deployed;
 *   1  an activation of a proof property, acknowledged, and its private
 *      conversation established on both sides;
 *   2  portal requests through the live proxy, SAMPLES of each of four reads:
 *      min / median / max as a caller sees them;
 *   3  Builder → Command Centre, SAMPLES messages sent through the portal:
 *      the send, the database-to-database delivery, and the first read on
 *      the other side that names it;
 *   4  Command Centre → Builder, the same the other way;
 *   5  the portal's new-message read (`list_new_agency_messages`): a first read
 *      takes the cursor only; a Command Centre message is named with the
 *      agency, the sender, the lot and the address, and carries no body, user
 *      id or client; the builder's own message is never named; a colleague not
 *      in the conversation and another organisation's builder are told
 *      nothing; reading writes nothing;
 *   6  in a real Chromium signed in as the builder: a Command Centre message
 *      raises "New message from <agency>" on another page, Open lands on that
 *      conversation showing it, and with the conversation open the next one
 *      appears in the thread without a reload and raises no popup;
 *   7  cleanup: nothing of this run remains on either side.
 *
 * BASELINE (`MESSAGE_PROOF_BASELINE=true`, the workflow's `baseline` input):
 * measures 2–4 on whatever is deployed and skips 5–6, so a change can be
 * measured before and after by the same instrument. A baseline run prints
 * BASELINE MEASURED and is never a pass for the change.
 *
 * Timings from a GitHub runner include the runner's own distance from the
 * services; the server-side execution time and region are read from the
 * gateway's logs separately. Every row, workspace, connection, session and
 * user it creates is deleted on both sides before it exits, and the deletion
 * is checked. No customer row is read for its content or written. No secret,
 * token, link, email address or message body is printed.
 *
 * Runs from the production-rollout workflow (phase `message-speed-proof`).
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { conversationRowsSql, proofDataFindings } from './realConversationAudit.pure.mjs';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const CC_ORIGIN = process.env.COMMAND_CENTRE_ORIGIN || 'https://command-centre.npcservices.com.au';
const BASELINE = String(process.env.MESSAGE_PROOF_BASELINE || '').toLowerCase() === 'true';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'message-speed';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const CC_USER_PREFIX = `${MARK}-${TAG}-`;
const CLIENT_SURNAME = `Message Speed Proof ${TAG}`;
const STREET = '1 Message Speed Proof Street';
/** Resend's own test recipient: accepted, never delivered to a person. */
const SAFE_SINK = (label) => `delivered+${TAG}-${label}-${RUN}@resend.dev`;
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 4_000;
const FAST_POLL_MS = 400;
const SAMPLES = Math.max(3, Number(process.env.MESSAGE_SAMPLES || 5));
/** A portal read, as a caller on a GitHub runner sees it, after the change. */
const PORTAL_MAX_MEDIAN_MS = Number(process.env.PORTAL_MAX_MEDIAN_MS || 1_500);
/** Database-to-database delivery, each way. */
const DELIVERY_MAX_S = Number(process.env.DELIVERY_MAX_S || 15);
const DELIVERY_MAX_MEDIAN_S = Number(process.env.DELIVERY_MAX_MEDIAN_S || 6);
/** From the message's own write to the popup on a real screen: delivery plus one 5 s check. */
const POPUP_MAX_S = Number(process.env.POPUP_MAX_S || 20);
const OUT = 'proof-artifacts';

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const measured = [];
function measure(name, detail) {
  measured.push({ name, detail });
  console.log(`  MEAS  ${name} — ${detail}`);
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
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const spread = (values, unit = 'ms', digits = 0) => {
  if (!values.length) return 'no samples';
  const fmt = (v) => `${v.toFixed(digits)}${unit}`;
  return `min ${fmt(Math.min(...values))} · median ${fmt(median(values))} · max ${fmt(Math.max(...values))} (n=${values.length})`;
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
async function portalCall(fn, body, cookie = null) {
  const headers = { 'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  const startedAt = Date.now();
  const response = await fetch(`${ORIGIN}/fn/${fn}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return {
    status: response.status, json, text: text.slice(0, 300), ms: Date.now() - startedAt,
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}
const portal = (body, cookie) => portalCall('builder-portal-stock', body, cookie);
/** The Command Centre's own function, as its page calls it, with a staff session. */
async function commandCentre(operation, body, sessionToken) {
  const startedAt = Date.now();
  const response = await fetch(`https://${CC_REF}.supabase.co/functions/v1/builder-stock-marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: CC_ORIGIN, Cookie: `__Host-session_token=${sessionToken}` },
    body: JSON.stringify({ operation, ...(body ?? {}) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, text: text.slice(0, 300), ms: Date.now() - startedAt };
}

async function waitFor(label, check, deadlineMs = DEADLINE_MS, every = POLL_MS) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < deadlineMs) {
    last = await check();
    if (last?.done) return { ...last, ms: Date.now() - startedAt };
    await sleep(every);
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
  const password = `Pr00f!${RUN}!speed`;
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

/** A session through the real login, or minted with the pepper where Turnstile stands in the way. */
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
console.log(`message speed proof run=${RUN}${BASELINE ? ' (BASELINE: measures only)' : ''}`);
let browser = null;
try {
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  await cleanup('start');

  const shipped = {
    network: (await net('shipped', `
      SELECT to_regclass('public.builder_agency_conversation_participants') IS NOT NULL AS participants`))[0] ?? {},
    cc: (await cc('shipped', `
      SELECT to_regclass('public.builder_network_conversation_participants') IS NOT NULL AS participants,
             (SELECT value = 'true'::jsonb FROM public.feature_flags WHERE key = 'builder_network_enabled') AS network_on`))[0] ?? {},
  };
  if (!record('0: both halves of the private chat are deployed and the network is on',
    shipped.network.participants && shipped.cc.participants && shipped.cc.network_on,
    JSON.stringify(shipped))) throw new Error('not deployed');

  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)} LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');

  // 1. The scenario: a proof organisation, its builder, a colleague who is not
  // in the conversation, another organisation's builder, and a Command Centre
  // activator whose acknowledgement email goes to Resend's sink.
  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const contact = { email: `sales-${RUN}@example.com`, phone: '03 9000 0000', website: `https://example.com/${TAG}-${RUN}` };
  const builder = await seedBuilder('ack', `Avery Builder ${RUN}`, { orgName, contact });
  const colleague = await seedBuilder('colleague', `Blake Builder ${RUN}`, { orgName, existingOrgId: builder.orgId });
  const otherBuilder = await seedBuilder('other', `Otto Other ${RUN}`, { orgName: `${ORG_PREFIX} other ${RUN} Pty Ltd` });
  const lot = `8${RUN.slice(-3)}`;
  const item = (await net('item', `
    INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, availability_status, image_work_stage,
      enrichment_status, address_line, suburb, state, postcode, lot_number, price_display, description)
    VALUES (${id(builder.orgId)}, 'staged', 'on_hold', 'settled', 'complete', ${sqlLit(STREET)}, 'Proofvale',
      'VIC', '3999', ${sqlLit(lot)}, 'Proof only — not for sale', 'An invented property. Not for sale.')
    RETURNING id`))[0].id;

  const connection = randomUUID();
  const secret = randomBytes(32).toString('hex');
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(builder.orgId)})`);
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Message speed proof (temporary)') RETURNING id`))[0].id;
  await net('connection', `
    INSERT INTO public.workspace_connections(id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(builder.orgId)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);
  await net('activate item', `UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id = ${id(item)}`);
  const mirrored = await waitFor('mirror', async () => {
    const rows = await cc('mirror', `SELECT count(*)::int AS n FROM public.builder_network_stock_items WHERE id = ${id(item)}`);
    return { done: Number(rows[0]?.n) === 1 };
  });
  if (!record('1: the proof property reaches the Command Centre', mirrored.done, secs(mirrored))) {
    throw new Error('the property never arrived');
  }

  const owner = await seedStaff('owner', 'Olive', `Owner ${RUN}`, SAFE_SINK('owner'));
  const client = (await cc('client', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    INSERT INTO public.clients(primary_first_name, primary_surname) VALUES ('Proof', ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)});
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    SELECT id FROM public.clients WHERE primary_surname = ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)}`))[0];
  const selection = (await cc('selection', `
    INSERT INTO public.builder_stock_selections(stock_item_id, organisation_id, client_id, selected_by_user_id, status, internal_notes)
    VALUES (${id(item)}, ${id(builder.orgId)}, ${id(client.id)}, ${id(owner.userId)}, 'selected', ${sqlLit(`private note ${RUN}`)})
    RETURNING id`))[0];
  const announced = await waitFor('announcement', async () => {
    const rows = await net('announcement', `
      SELECT id, status FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
    return { done: rows.length === 1 && rows[0].status === 'selected', row: rows[0] };
  });
  if (!record('1: the Command Centre activates it and the builder is told', announced.done, secs(announced))) {
    throw new Error('the activation never arrived');
  }
  const conversationId = activationConversationId(connection, selection.id);
  const builderCookie = await establishSession(builder);
  const ack = await portal({ operation: 'acknowledge_selection', selection_id: announced.row.id }, builderCookie);
  const established = await waitFor('established', async () => {
    const here = (await cc('cc conversation', `
      SELECT count(*)::int AS n FROM public.builder_network_conversation_participants
       WHERE conversation_id = ${id(conversationId)} AND state = 'joined'`))[0]?.n;
    const there = (await net('network conversation', `
      SELECT count(*)::int AS n FROM public.builder_agency_conversation_participants
       WHERE conversation_id = ${id(conversationId)} AND state = 'joined'`))[0]?.n;
    return { done: Number(here) === 2 && Number(there) === 2 };
  });
  if (!record('1: the builder acknowledges, and the private conversation is established on both sides',
    ack.status === 200 && established.done, `HTTP ${ack.status}, ${secs(established)}`)) {
    throw new Error('no conversation');
  }

  // Is the change deployed? A baseline run measures whatever is live; a proof
  // run requires the new read and refuses to call its absence a pass.
  const popupProbe = await portal({ operation: 'list_new_agency_messages' }, builderCookie);
  const popupDeployed = popupProbe.status === 200 && typeof popupProbe.json?.cursor === 'string';
  if (BASELINE) {
    measure('the portal\'s new-message read is deployed', String(popupDeployed));
  } else if (!record('0: the portal\'s new-message read is deployed', popupDeployed, `HTTP ${popupProbe.status}`)) {
    throw new Error('the change is not deployed; run with baseline to measure what is live');
  }

  // 2. Portal requests as a caller sees them.
  const reads = {
    // The portal-performance proof's "normal request", so the two compare.
    'workspace_summary': () => portalCall('builder-portal-workspace', { operation: 'workspace_summary' }, builderCookie),
    'list_my_agency_conversations': () => portal({ operation: 'list_my_agency_conversations' }, builderCookie),
    'get_agency_conversation': () => portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, builderCookie),
    ...(popupDeployed ? { 'list_new_agency_messages': () => portal({ operation: 'list_new_agency_messages' }, builderCookie) } : {}),
  };
  const portalMedians = [];
  for (const [name, read] of Object.entries(reads)) {
    const timings = [];
    let failures = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const answer = await read();
      if (answer.status !== 200) failures += 1;
      timings.push(answer.ms);
    }
    portalMedians.push(median(timings));
    measure(`2: ${name} through the live proxy`, `${spread(timings)}${failures ? `, ${failures} not 200` : ''}`);
  }
  if (!BASELINE) {
    record(`2: a portal read's median is at most ${PORTAL_MAX_MEDIAN_MS} ms as a runner sees it`,
      portalMedians.every((m) => m <= PORTAL_MAX_MEDIAN_MS), portalMedians.map((m) => `${Math.round(m)}ms`).join(', '));
  }

  // 3. Builder → Command Centre.
  const ownerCursor = (await commandCentre('list_new_builder_messages', {}, owner.token)).json?.cursor ?? null;
  let ccCursor = ownerCursor;
  const toCc = { send: [], delivery: [], named: [] };
  for (let i = 0; i < SAMPLES; i += 1) {
    const startedAt = Date.now();
    const sent = await portal({ operation: 'send_agency_message', conversation_id: conversationId,
      client_message_id: randomUUID(), body: `smoke-rollout message-speed ${RUN} builder ${i + 1}` }, builderCookie);
    toCc.send.push(Date.now() - startedAt);
    const messageId = sent.json?.message?.id;
    if (sent.status !== 200 || !UUID.test(String(messageId))) { toCc.delivery.push(Infinity); continue; }
    const landed = await waitFor('landed', async () => {
      const row = (await cc('landed', `
        SELECT extract(epoch from created_at) * 1000 AS arrived FROM public.builder_network_messages WHERE id = ${id(messageId)}`))[0];
      return { row, done: !!row };
    }, 60_000, FAST_POLL_MS);
    const sentRow = (await net('sent', `
      SELECT extract(epoch from sent_at) * 1000 AS sent FROM public.builder_agency_messages WHERE id = ${id(messageId)}`))[0];
    toCc.delivery.push(landed.done ? (Number(landed.row.arrived) - Number(sentRow?.sent)) / 1000 : Infinity);
    const named = await waitFor('named', async () => {
      const read = await commandCentre('list_new_builder_messages', ccCursor ? { since: ccCursor } : {}, owner.token);
      const hit = (read.json?.messages ?? []).find((m) => m.message_id === messageId);
      return { read, hit, done: !!hit };
    }, 60_000, FAST_POLL_MS);
    if (named.done) {
      ccCursor = named.read.json?.cursor ?? ccCursor;
      toCc.named.push((Date.now() - Number(sentRow?.sent)) / 1000);
    } else {
      toCc.named.push(Infinity);
    }
    await sleep(1_000);
  }
  measure('3: Builder → Command Centre: the portal send, as a runner sees it', spread(toCc.send));
  measure('3: Builder → Command Centre: written on the network → landed in the Command Centre', spread(toCc.delivery, ' s', 2));
  measure('3: Builder → Command Centre: written → first named by the Command Centre\'s popup read', spread(toCc.named, ' s', 2));
  record(`3: every builder message crossed within ${DELIVERY_MAX_S} s, median within ${DELIVERY_MAX_MEDIAN_S} s`,
    toCc.delivery.every((s) => s <= DELIVERY_MAX_S) && median(toCc.delivery) <= DELIVERY_MAX_MEDIAN_S,
    spread(toCc.delivery, ' s', 2));

  // 4. Command Centre → Builder.
  let builderCursor = popupDeployed ? popupProbe.json.cursor : null;
  const toBuilder = { delivery: [], named: [] };
  for (let i = 0; i < SAMPLES; i += 1) {
    const sent = await commandCentre('send_builder_message', { conversation_id: conversationId,
      client_message_id: randomUUID(), body: `smoke-rollout message-speed ${RUN} agency ${i + 1}` }, owner.token);
    const messageId = sent.json?.message?.id;
    if (sent.status !== 200 || !UUID.test(String(messageId))) { toBuilder.delivery.push(Infinity); continue; }
    const sentRow = (await cc('sent', `
      SELECT extract(epoch from sent_at) * 1000 AS sent FROM public.builder_network_messages WHERE id = ${id(messageId)}`))[0];
    const landed = await waitFor('landed', async () => {
      const row = (await net('landed', `
        SELECT extract(epoch from created_at) * 1000 AS arrived FROM public.builder_agency_messages WHERE id = ${id(messageId)}`))[0];
      return { row, done: !!row };
    }, 60_000, FAST_POLL_MS);
    toBuilder.delivery.push(landed.done ? (Number(landed.row.arrived) - Number(sentRow?.sent)) / 1000 : Infinity);
    // What an open screen would read: the new-message read where it exists,
    // else (a baseline) the conversation itself.
    const named = await waitFor('named', async () => {
      if (popupDeployed) {
        const read = await portal({ operation: 'list_new_agency_messages', ...(builderCursor ? { since: builderCursor } : {}) }, builderCookie);
        const hit = (read.json?.messages ?? []).find((m) => m.message_id === messageId);
        return { read, hit, done: !!hit };
      }
      const read = await portal({ operation: 'get_agency_conversation', conversation_id: conversationId }, builderCookie);
      return { read, done: (read.json?.messages ?? []).some((m) => m.id === messageId) };
    }, 60_000, FAST_POLL_MS);
    if (named.done) {
      if (popupDeployed) builderCursor = named.read.json?.cursor ?? builderCursor;
      toBuilder.named.push((Date.now() - Number(sentRow?.sent)) / 1000);
    } else {
      toBuilder.named.push(Infinity);
    }
    await sleep(1_000);
  }
  measure('4: Command Centre → Builder: written in the Command Centre → landed on the network', spread(toBuilder.delivery, ' s', 2));
  measure(`4: Command Centre → Builder: written → first read by the portal (${popupDeployed ? 'new-message read' : 'conversation read'})`,
    spread(toBuilder.named, ' s', 2));
  record(`4: every agency message crossed within ${DELIVERY_MAX_S} s, median within ${DELIVERY_MAX_MEDIAN_S} s`,
    toBuilder.delivery.every((s) => s <= DELIVERY_MAX_S) && median(toBuilder.delivery) <= DELIVERY_MAX_MEDIAN_S,
    spread(toBuilder.delivery, ' s', 2));

  if (!BASELINE) {
    // 5. The portal's new-message read.
    const agencyName = ((await portal({ operation: 'list_my_agency_conversations' }, builderCookie)).json?.conversations ?? [])
      .find((c) => c.conversation_id === conversationId)?.agency_name ?? null;
    const colleagueCookie = await establishSession(colleague);
    const otherCookie = await establishSession(otherBuilder);
    const firsts = {};
    for (const [who, cookie] of [['builder', builderCookie], ['colleague', colleagueCookie], ['other', otherCookie]]) {
      firsts[who] = await portal({ operation: 'list_new_agency_messages' }, cookie);
    }
    record('5: a first read answers only the cursor, so opening the portal replays nothing',
      Object.values(firsts).every((r) => r.status === 200 && typeof r.json?.cursor === 'string'
        && Array.isArray(r.json?.messages) && r.json.messages.length === 0),
      Object.entries(firsts).map(([who, r]) => `${who} ${r.status}/${r.json?.messages?.length ?? '-'}`).join(', '));

    const ownId = (await portal({ operation: 'send_agency_message', conversation_id: conversationId,
      client_message_id: randomUUID(), body: `smoke-rollout message-speed ${RUN} own side` }, builderCookie)).json?.message?.id;
    const agencyBody = `smoke-rollout message-speed ${RUN} private agency body`;
    const agencyId = (await commandCentre('send_builder_message', { conversation_id: conversationId,
      client_message_id: randomUUID(), body: agencyBody }, owner.token)).json?.message?.id;
    const named = await waitFor('named', async () => {
      const read = await portal({ operation: 'list_new_agency_messages', since: firsts.builder.json.cursor }, builderCookie);
      const hit = (read.json?.messages ?? []).find((m) => m.message_id === agencyId);
      return { read, hit, done: !!hit };
    }, 60_000, FAST_POLL_MS);
    const hit = named.hit ?? {};
    record('5: the agency\'s message is named to the builder with the agency, the sender, the lot and the address',
      named.done && hit.conversation_id === conversationId && hit.agency_name === agencyName && !!agencyName
        && hit.sender_display_name === owner.name && hit.lot_number === lot && hit.address === STREET,
      `${secs(named)}; agency ${hit.agency_name === agencyName ? 'as the Messages list names it' : 'MISMATCH'}`);
    const wire = JSON.stringify(named.read?.json ?? {});
    const privateValues = [agencyBody, client.id, `${CLIENT_SURNAME} ${RUN}`, `private note ${RUN}`, owner.userId,
      builder.userId, SAFE_SINK('owner'), builder.email];
    record('5: it carries no body, no user id, no email and nothing about the client',
      !('body' in hit) && privateValues.every((v) => !wire.includes(v)),
      `${privateValues.filter((v) => wire.includes(v)).length} private value(s) present`);
    record('5: the builder\'s own message is never named to them',
      !(named.read?.json?.messages ?? []).some((m) => m.message_id === ownId) && UUID.test(String(ownId)));
    const colleagueRead = await portal({ operation: 'list_new_agency_messages', since: firsts.colleague.json.cursor }, colleagueCookie);
    const otherRead = await portal({ operation: 'list_new_agency_messages', since: firsts.other.json.cursor }, otherCookie);
    record('5: a colleague who is not in the conversation, and another organisation\'s builder, are told nothing',
      colleagueRead.status === 200 && (colleagueRead.json?.messages ?? []).length === 0
        && otherRead.status === 200 && (otherRead.json?.messages ?? []).length === 0,
      `colleague ${colleagueRead.status}/${colleagueRead.json?.messages?.length ?? '-'}, other ${otherRead.status}/${otherRead.json?.messages?.length ?? '-'}`);
    const counts = async () => JSON.stringify((await net('counts', `
      SELECT (SELECT count(*) FROM public.builder_agency_messages WHERE conversation_id = ${id(conversationId)})::int AS messages,
             (SELECT count(*) FROM public.builder_agency_conversation_participants WHERE conversation_id = ${id(conversationId)})::int AS people,
             (SELECT count(*) FROM public.builder_network_outbox WHERE connection_id = ${id(connection)})::int AS outbox,
             (SELECT last_message_at FROM public.builder_agency_conversations WHERE id = ${id(conversationId)}) AS touched`))[0]);
    const before = await counts();
    for (let i = 0; i < 3; i += 1) await portal({ operation: 'list_new_agency_messages', since: firsts.builder.json.cursor }, builderCookie);
    record('5: reading it writes nothing', (await counts()) === before);

    // The cleanup audit's real-conversation check, run against THIS proof's
    // disposable conversation, which holds nothing but proof data. Every
    // message and participant in it must be flagged on the side that records
    // who it is (ids are the same on both sides), and every row with a local
    // author must be known as a proof identity's by that author, not only by
    // what the message says. The real conversations are never touched.
    const auditRows = [
      ...await cc('audit check', conversationRowsSql('cc', [conversationId])),
      ...await net('audit check', conversationRowsSql('net', [conversationId])),
    ];
    const flagged = new Set(proofDataFindings(auditRows).map((f) => `${f.kind}:${f.ref}`));
    const items = new Set(auditRows.map((r) => `${r.kind}:${r.ref}`));
    const readOn = (db, kind) => auditRows.filter((r) => r.db === db && r.kind === kind).length;
    const authored = auditRows.filter((r) => r.local === 'present');
    record('5: the cleanup audit\'s real-conversation check flags every message and participant of this proof\'s conversation',
      ['cc', 'net'].every((db) => readOn(db, 'message') > 0 && readOn(db, 'participant') > 0)
        && [...items].every((item) => flagged.has(item)),
      `${[...items].filter((item) => flagged.has(item)).length} of ${items.size} flagged; CC ${readOn('cc', 'message')} messages, ` +
        `${readOn('cc', 'participant')} people; network ${readOn('net', 'message')} messages, ${readOn('net', 'participant')} people`);
    record('5: it knows a proof author by who wrote the message, not only by what it says',
      authored.length > 0 && authored.every((r) => r.local_marker === true),
      `${authored.filter((r) => r.local_marker === true).length} of ${authored.length} rows with a local author`);

    // 6. The popup on a real screen.
    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
    if (!record('6: a real browser is available to look with', !!chromium)) throw new Error('playwright is not installed');
    mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.addCookies([{
      name: '__Host-builder_session_token', value: builderCookie.split('=')[1], url: ORIGIN,
      secure: true, httpOnly: true, sameSite: 'Lax',
    }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 160)));
    const navigations = [];
    await page.goto(`${ORIGIN}/builder/dashboard`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    // The popup's first read takes the cursor; give it one check to have done so.
    await page.waitForTimeout(6_000);
    const title = `New message from ${agencyName}`;
    const popupBody = `smoke-rollout message-speed ${RUN} popup`;
    const popupSend = await commandCentre('send_builder_message', { conversation_id: conversationId,
      client_message_id: randomUUID(), body: popupBody }, owner.token);
    const popupSentAt = Number((await cc('popup sent', `
      SELECT extract(epoch from sent_at) * 1000 AS sent FROM public.builder_network_messages
       WHERE id = ${id(popupSend.json?.message?.id ?? randomUUID())}`))[0]?.sent);
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: title });
    const toastShown = await toast.first().waitFor({ timeout: POPUP_MAX_S * 1000 }).then(() => true).catch(() => false);
    const toastAfterS = (Date.now() - popupSentAt) / 1000;
    const toastText = toastShown ? ((await toast.first().textContent()) ?? '') : '';
    await page.screenshot({ path: `${OUT}/message-popup.png` });
    record(`6: on another page, "${'New message from <agency>'}" appears with who wrote it and the lot, without the message`,
      toastShown && toastText.includes(owner.name) && toastText.includes(`Lot ${lot}`) && !toastText.includes(popupBody),
      `${toastShown ? `${toastAfterS.toFixed(1)} s after it was written` : 'never appeared'}`);
    measure('6: written in the Command Centre → popup on the builder\'s screen', `${toastAfterS.toFixed(1)} s`);

    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    if (toastShown) await toast.first().getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(/\/builder\/messages\?/, { timeout: 15_000 }).catch(() => {});
    const opened = new URL(page.url());
    const threadShows = await page.getByText(popupBody).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    await page.screenshot({ path: `${OUT}/message-popup-opened.png`, fullPage: true });
    record('6: Open lands on that conversation, showing the message',
      opened.pathname === '/builder/messages' && opened.searchParams.get('thread') === conversationId && threadShows,
      `at=${opened.pathname}?view=${opened.searchParams.get('view')}`);

    // With the conversation open: the next message appears in the thread without
    // a reload, and no popup is raised over it.
    await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
    const navigationsBefore = navigations.length;
    const liveBody = `smoke-rollout message-speed ${RUN} open thread`;
    const liveSend = await commandCentre('send_builder_message', { conversation_id: conversationId,
      client_message_id: randomUUID(), body: liveBody }, owner.token);
    const liveSentAt = Number((await cc('live sent', `
      SELECT extract(epoch from sent_at) * 1000 AS sent FROM public.builder_network_messages
       WHERE id = ${id(liveSend.json?.message?.id ?? randomUUID())}`))[0]?.sent);
    const liveShown = await page.getByText(liveBody).first().waitFor({ timeout: POPUP_MAX_S * 1000 }).then(() => true).catch(() => false);
    const liveAfterS = (Date.now() - liveSentAt) / 1000;
    await page.waitForTimeout(1_500);
    const toastsOverThread = await page.locator('[data-sonner-toast]').filter({ hasText: 'New message from' }).count();
    await page.screenshot({ path: `${OUT}/message-open-thread.png`, fullPage: true });
    record('6: with the conversation open, the next message appears in it without a reload, and no popup is raised over it',
      liveShown && navigations.length === navigationsBefore && toastsOverThread === 0,
      `${liveShown ? `${liveAfterS.toFixed(1)} s after it was written` : 'never appeared'}, reloads=${navigations.length - navigationsBefore}, popups=${toastsOverThread}`);
    measure('6: written in the Command Centre → shown in the open thread', `${liveAfterS.toFixed(1)} s`);
    record('6: no uncaught error on the page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    await context.close();

    // 6b. The builder is somewhere else: two portal tabs, both hidden.
    // Permission is granted as a person granting it would (the browser's own
    // prompt is not what is under test), and the Notification constructor is
    // wrapped so the proof can COUNT what the page raised and press it.
    await runAwayFromTheTab({
      label: '6b portal', origin: ORIGIN, path: '/builder/dashboard',
      cookie: { name: '__Host-builder_session_token', value: builderCookie.split('=')[1], url: ORIGIN,
        secure: true, httpOnly: true, sameSite: 'Lax' },
      title: `New message from ${agencyName}`,
      send: async (body) => commandCentre('send_builder_message', { conversation_id: conversationId,
        client_message_id: randomUUID(), body }, owner.token),
      expectPath: (url) => url.pathname === '/builder/messages' && url.searchParams.get('thread') === conversationId,
    });

    // 6c. The same for a Command Centre staff member reading builder messages:
    // the page in view (the pop-up), then two hidden tabs.
    await runAwayFromTheTab({
      label: '6c Command Centre', origin: CC_ORIGIN, path: '/dashboard', foreground: true,
      cookie: { name: '__Host-session_token', value: owner.token, domain: `${CC_REF}.supabase.co`,
        path: '/', secure: true, httpOnly: true, sameSite: 'None' },
      // The Command Centre names the builder as its connection does; the proof asks only that it is a builder message.
      title: /new messages? from/i,
      send: async (body) => portal({ operation: 'send_agency_message', conversation_id: conversationId,
        client_message_id: randomUUID(), body }, builderCookie),
      expectPath: (url) => url.pathname.includes(conversationId) || url.search.includes(conversationId),
    });
  }
} catch (error) {
  record('the proof ran to the end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    await cleanup('end');
    const leftNetwork = (await net('left', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS orgs,
             (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)})::int AS workspaces,
             (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)})::int AS users,
             (SELECT count(*) FROM public.builder_stock_items WHERE address_line = ${sqlLit(STREET)})::int AS items,
             (SELECT count(*) FROM public.builder_agency_messages WHERE body LIKE ${sqlLit(`smoke-rollout message-speed ${RUN}%`)})::int AS messages`))[0];
    const leftCc = (await cc('left', `
      SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS connections,
             (SELECT count(*) FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)})::int AS staff,
             (SELECT count(*) FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)})::int AS clients,
             (SELECT count(*) FROM public.builder_network_stock_items WHERE address_line = ${sqlLit(STREET)})::int AS items,
             (SELECT count(*) FROM public.builder_network_messages WHERE body LIKE ${sqlLit(`smoke-rollout message-speed ${RUN}%`)})::int AS messages,
             (SELECT count(*) FROM public.notifications n WHERE n.type = 'builder_activation_acknowledged'
               AND n.message LIKE ${sqlLit(`%${ORG_PREFIX}%`)})::int AS notifications,
             (SELECT count(*) FROM public.user_sessions s WHERE NOT EXISTS (SELECT 1 FROM public.custom_users u WHERE u.id = s.user_id))::int AS orphan_sessions`))[0];
    record('7: cleanup leaves zero proof artefacts on either side',
      Object.values({ ...leftNetwork, ...leftCc }).every((n) => Number(n) === 0),
      JSON.stringify({ ...leftNetwork, ...leftCc }));
  } catch (error) {
    record('7: cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}

/**
 * Two tabs of one person, away from both, and a message arrives: one desktop
 * notification (not one per tab), a count on each tab's title, no pop-up while
 * nobody is looking, the pop-up in the FIRST tab they come back to and not the
 * second, the notification opening the conversation, and nothing raised again.
 * With `foreground`, first the page in view: the pop-up and no notification.
 */
async function runAwayFromTheTab({ label, origin, path, cookie, title, send, expectPath, foreground = false }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.grantPermissions(['notifications'], { origin });
  await context.addCookies([cookie]);
  await context.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    Document.prototype.hasFocus = function hasFocus() { return !hidden; };
    window.__setHidden = (next) => {
      hidden = next;
      document.dispatchEvent(new Event('visibilitychange'));
      if (!next) window.dispatchEvent(new Event('focus'));
    };
    window.__notes = [];
    const Real = window.Notification;
    class CountedNotification {
      constructor(heading, options = {}) {
        this.title = heading; this.onclick = null; this.onclose = null;
        window.__notes.push({ heading, tag: options.tag ?? null, url: options.data?.url ?? null });
        window.__lastNote = this;
      }
      close() {}
      static get permission() { return Real ? Real.permission : 'denied'; }
      static requestPermission(...args) { return Real.requestPermission(...args); }
    }
    window.Notification = CountedNotification;
    if (window.ServiceWorkerRegistration) {
      ServiceWorkerRegistration.prototype.showNotification = async function showNotification(heading, options = {}) {
        window.__notes.push({ heading, tag: options.tag ?? null, url: options.data?.url ?? null, worker: true });
      };
    }
  });
  const tabs = [await context.newPage(), await context.newPage()];
  const errors = [];
  for (const tab of tabs) tab.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 120)));
  try {
    for (const tab of tabs) await tab.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    const challenged = await tabs[0].evaluate(() => document.title === 'Just a moment...').catch(() => false);
    if (!record(`${label}: both tabs open signed in`, !challenged && tabs.every((t) => new URL(t.url()).pathname !== '/login'),
      challenged ? 'the origin answered a bot challenge' : tabs.map((t) => new URL(t.url()).pathname).join(', '))) return;
    await tabs[0].waitForTimeout(8_000); // the first read takes the cursor
    const notes = async () => (await Promise.all(tabs.map((t) => t.evaluate(() => window.__notes.length).catch(() => 0))))
      .reduce((a, b) => a + b, 0);
    const toasts = (tab) => tab.locator('[data-sonner-toast]').filter({ hasText: title }).count();

    if (foreground) {
      // Case E: the page in view — the pop-up, and no desktop notification.
      await tabs[1].evaluate(() => window.__setHidden(true));
      const body = `smoke-rollout message-speed ${RUN} ${label} in view`;
      await send(body);
      const shown = await tabs[0].locator('[data-sonner-toast]').filter({ hasText: title }).first()
        .waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
      await tabs[0].screenshot({ path: `${OUT}/${label.replace(/\W+/g, '-')}-in-view.png` });
      record(`${label}: in view, "${'New message from <builder>'}" pops up`, shown);
      record(`${label}: in view, no desktop notification is raised over it`, (await tabs[0].evaluate(() => window.__notes.length)) === 0);
      const close = tabs[0].locator('[data-sonner-toast] button[aria-label="Close toast"]').first();
      if (await close.count()) {
        await close.click().catch(() => {});
        const gone = await tabs[0].locator('[data-sonner-toast]').filter({ hasText: title }).first()
          .waitFor({ state: 'detached', timeout: 10_000 }).then(() => true).catch(() => false);
        record(`${label}: the close button puts the pop-up away`, gone);
      } else {
        record(`${label}: the pop-up has a close button`, false, 'no close button found');
      }
      await tabs[0].waitForTimeout(35_000); // let the hidden tab's slower check pass this message too
      await tabs[1].evaluate(() => window.__setHidden(false));
      await tabs[1].waitForTimeout(6_000);
      await tabs[1].evaluate(() => window.__setHidden(true));
      for (const tab of tabs) await tab.evaluate(() => { window.__notes.length = 0; });
    }

    // Cases B/C/D (F/G): both tabs hidden.
    for (const tab of tabs) await tab.evaluate(() => window.__setHidden(true));
    const baseTitles = await Promise.all(tabs.map((t) => t.title()));
    const body = `smoke-rollout message-speed ${RUN} ${label} away`;
    const sentAt = Date.now();
    await send(body);
    const raised = await waitFor(`${label} notification`, async () => ({ done: (await notes()) >= 1 }), 90_000, 2_000);
    record(`${label}: with both tabs hidden, the check keeps running and a desktop notification is raised`, raised.done,
      raised.done ? `${((Date.now() - sentAt) / 1000).toFixed(0)} s after it was written` : 'none within 90 s');
    await tabs[0].waitForTimeout(40_000); // a full background cycle for the second tab
    const total = await notes();
    record(`${label}: ONE desktop notification for the message, not one per tab`, total === 1, `${total} raised across 2 tabs`);
    const titles = await Promise.all(tabs.map((t) => t.title()));
    record(`${label}: the tab title carries the unread count`, titles.some((t) => /^\(\d+\)/.test(t)),
      titles.map((t) => t.slice(0, 4)).join(' / '));
    record(`${label}: no pop-up is drawn while nobody is looking`,
      (await Promise.all(tabs.map(toasts))).every((n) => n === 0));

    // Coming back: the first tab shows what was missed, the second does not repeat it.
    await tabs[0].bringToFront();
    await tabs[0].evaluate(() => window.__setHidden(false));
    const back = await tabs[0].locator('[data-sonner-toast]').filter({ hasText: title }).first()
      .waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    await tabs[0].screenshot({ path: `${OUT}/${label.replace(/\W+/g, '-')}-returned.png` });
    record(`${label}: returning to a tab shows the missed pop-up`, back);
    await tabs[0].evaluate(() => window.__setHidden(true));
    await tabs[1].bringToFront();
    await tabs[1].evaluate(() => window.__setHidden(false));
    await tabs[1].waitForTimeout(6_000);
    record(`${label}: the second tab does not show it again`, (await toasts(tabs[1])) === 0);
    const cleared = await tabs[1].title();
    record(`${label}: the count leaves the title once the tab is in view`, !/^\(\d+\)/.test(cleared) || baseTitles.includes(cleared),
      cleared.slice(0, 4));

    // The notification opens the conversation.
    const owner = await Promise.all(tabs.map((t) => t.evaluate(() => window.__notes.length)));
    const ownerTab = tabs[owner.findIndex((n) => n > 0)] ?? tabs[0];
    const target = await ownerTab.evaluate(() => {
      const note = window.__notes[window.__notes.length - 1];
      if (note?.url) return note.url;
      window.__lastNote?.onclick?.();
      return null;
    });
    if (target) await ownerTab.evaluate((url) => { window.location.assign(url); }, target);
    await ownerTab.waitForTimeout(6_000);
    record(`${label}: the notification opens that conversation`, expectPath(new URL(ownerTab.url())), new URL(ownerTab.url()).pathname);

    // Nothing is raised again for what was already announced.
    for (const tab of tabs) await tab.evaluate(() => window.__setHidden(true));
    await tabs[0].waitForTimeout(40_000);
    record(`${label}: nothing is raised again for a message already announced`, (await notes()) === total, `${await notes()} total`);
    record(`${label}: no uncaught error in either tab`, errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await context.close().catch(() => {});
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; ${measured.length} measurement(s)`);
if (BASELINE) {
  console.log(failed.length ? 'BASELINE FAILED TO MEASURE' : 'BASELINE MEASURED (not a pass for the change)');
} else {
  console.log(failed.length ? 'MESSAGE SPEED PROOF FAILED' : 'MESSAGE SPEED PROOF PASSED');
}
process.exit(failed.length ? 1 : 0);
