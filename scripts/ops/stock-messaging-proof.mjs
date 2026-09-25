#!/usr/bin/env node
/**
 * ===========================================================================
 * AN AGENCY AND A BUILDER TALK OVER THE NETWORK — PROVED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * Step 5's messages travel the real way: the writing side's outbox, its
 * worker's signature, the other side's LIVE door, that side's message lane,
 * and a receipt back the same way. Driven with the workflow's one management
 * token (the reach `stock-media-proof` already relies on), this proves:
 *
 *   0. both halves are deployed (functions, lanes, schedules, bundles);
 *   1. two builder organisations of the run's own, detached from every real
 *      workspace, and a proof-only transport between the two live doors;
 *   2. the property reaches the Command Centre, and a Command Centre
 *      activation (a proof selection by a proof staff member, for a proof
 *      client that no trigger is allowed to react to) reaches the builder;
 *   3. the activator writes: the builder receives it under the activator's
 *      name, and the Command Centre copy becomes Delivered only on the
 *      builder's receipt; both sides hold the SAME derived conversation id;
 *   4. a colleague writes into the same conversation as themselves, and the
 *      conversation stays the activator's;
 *   5. the builder writes through the portal's own request (a session of a
 *      proof builder), a builder colleague writes too, both arrive with their
 *      writers' names and both become Delivered;
 *   6. the same send repeated is the same message, on both sides;
 *   7. both sides order the thread identically;
 *   8. a message the builder's side refuses fails visibly with its reason,
 *      and "send again" by its writer (a new generation) delivers it once —
 *      a colleague may not retry it;
 *   9. a replayed signed envelope makes no duplicate;
 *  10. another builder's signed message naming this property, a message
 *      naming the wrong conversation, and a malformed one are refused and
 *      stored nowhere — and a valid message behind them is applied (a poison
 *      message never blocks the next);
 *  11. every refusal is written to the operational event log;
 *  12. nothing but the contract crosses: exact payload keys, no user id, no
 *      client, and the portal's read carries no user id either;
 *  13. the portal's polling read — the same request, repeated — does not
 *      hold a message before it is written and does hold it after, in order;
 *  14. withdrawing the activation closes the conversation on both sides and
 *      keeps its history readable.
 *
 * Every row, workspace and connection it created is deleted on both sides
 * before it exits, and the deletion is checked. No customer row is read for
 * its content or written. No secret and no link is printed.
 *
 * Runs from the production-rollout workflow (phase `stock-messaging-proof`).
 */
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'messaging-proof';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const CC_USER_PREFIX = `${MARK}-${TAG}-`;
const CLIENT_SURNAME = `Messaging Proof ${TAG}`;
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 4_000;
const POSTED_KEYS = ['body', 'conversation_id', 'generation', 'message_id', 'schema_version',
  'sender_display_name', 'sent_at', 'stock_item_id'];
const RECEIPT_KEYS = ['conversation_id', 'generation', 'message_id', 'outcome', 'reason', 'schema_version'];

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
const conversationIdFor = (connectionId, stockItemId) => {
  const hex = createHash('md5').update(`agency.conversation:${connectionId}:${stockItemId}`).digest('hex');
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
/** A statement expected to be refused: the refusal's text, or null when it succeeded. */
const refusalOf = async (run) => {
  try { await run(); return null; } catch (error) { return String(error?.message ?? error); }
};

/** A portal function through the same-origin proxy, as the browser calls it. */
async function call(fn, body, cookie = null) {
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
    SELECT id, network_connection_id, builder_organisation_id FROM public.builder_network_connections
     WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)}`);
  const ccOrgIds = [...new Set([...orgIds,
    ...ccConnections.map((row) => row.builder_organisation_id).filter((v) => UUID.test(String(v)))])];

  if (orgIds.length) {
    const orgList = orgIds.map(id).join(', ');
    const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList})`;
    // The property first, while its connection still stands; then the
    // activation-opened project (it RESTRICTS the organisation delete, and its
    // history is append-only by trigger — this run's own rows, one statement).
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

  // The Command Centre last: a delivery already in flight lands before its rows
  // are removed, or is refused by a door that no longer knows the connection.
  const connList = ccConnections.length ? ccConnections.map((row) => id(row.id)).join(', ') : 'NULL::uuid';
  const orgList = ccOrgIds.length ? ccOrgIds.map(id).join(', ') : 'NULL::uuid';
  await cc(`${stage}: rows`, `
    SET LOCAL lock_timeout = '5s';
    DELETE FROM public.builder_network_conversations WHERE connection_id IN (${connList});
    DELETE FROM public.builder_stock_selections WHERE organisation_id IN (${orgList});
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    DELETE FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)};
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    DELETE FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)};
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
async function seedBuilder(label, { orgName, existingOrgId = null }) {
  const email = `${MARK}-${TAG}-${label}-${RUN}@example.com`;
  const password = `Pr00f!${RUN}!messaging`;
  const name = label === 'main' ? `Avery Builder ${RUN}` : `Bailey Builder ${RUN}`;
  const orgSql = existingOrgId
    ? `SELECT ${id(existingOrgId)} AS id`
    : `INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
       VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now()) RETURNING id`;
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
    SELECT person.id, org.id, 'owner', true, 'active' FROM person, org;
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
  const login = await call('builder-portal-login', { email: user.email, password: user.password });
  const issued = login.setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-builder_session_token='));
  if (login.status === 200 && issued) return issued;
  if (!PEPPER) throw new Error('login issued no cookie and NETWORK_SESSION_PEPPER is not available');
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHmac('sha256', PEPPER).update(token).digest('hex');
  await net('mint session', `
    SELECT public.builder_issue_session(${id(user.userId)}, ${sqlLit(tokenHash)},
      now() + interval '2 hours', now() + interval '2 hours', NULL, NULL, 'smoke-rollout')`);
  return `__Host-builder_session_token=${token}`;
}

// --- The proof ---------------------------------------------------------------
try {
  console.log(`stock messaging proof run=${RUN}`);

  // 0. Reach, and the deploy this proves.
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  await cleanup('start');

  const networkShipped = (await net('shipped', `
    SELECT to_regprocedure('public.builder_agency_post_message(uuid,uuid,uuid,uuid,uuid,text)') IS NOT NULL AS post,
           to_regprocedure('public.builder_agency_apply_message_events(integer)') IS NOT NULL AS sweep,
           EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-agency-messages-apply-1min' AND active) AS cron`))[0] ?? {};
  const ccShipped = (await cc('shipped', `
    SELECT to_regprocedure('public.builder_network_post_message(uuid,uuid,uuid,text)') IS NOT NULL AS post,
           to_regprocedure('public.builder_network_apply_message_events(integer)') IS NOT NULL AS sweep,
           EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-messages-apply-1min' AND active) AS cron,
           (SELECT value = 'true'::jsonb FROM public.feature_flags WHERE key = 'builder_network_enabled') AS network_on`))[0] ?? {};
  if (!record('0: both halves are deployed (writer, lane, schedule; the network flag on)',
    networkShipped.post && networkShipped.sweep && networkShipped.cron
      && ccShipped.post && ccShipped.sweep && ccShipped.cron && ccShipped.network_on,
    JSON.stringify({ network: networkShipped, cc: ccShipped }))) throw new Error('not deployed');

  const bundle = async (ref, fn) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/${fn}/body`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    return response.ok ? Buffer.from(await response.arrayBuffer()).toString('latin1') : '';
  };
  const bundles = {
    portal: await bundle(NETWORK_REF, 'builder-portal-stock'),
    networkDoor: await bundle(NETWORK_REF, 'builder-network-inbound'),
    marketplace: await bundle(CC_REF, 'builder-stock-marketplace'),
    ccDoor: await bundle(CC_REF, 'builder-network-inbound'),
  };
  record('0: the deployed functions carry the conversation (both reads, both writers, both doors\' lanes)',
    bundles.portal.includes('send_agency_message') && bundles.portal.includes('get_agency_conversation')
      && bundles.networkDoor.includes('builder_agency_apply_message_events')
      && bundles.marketplace.includes('send_builder_message') && bundles.marketplace.includes('get_builder_conversation')
      && bundles.ccDoor.includes('builder_network_apply_message_events'),
    Object.entries(bundles).map(([k, v]) => `${k} ${v.length ? 'read' : 'unreadable'}`).join(', '));

  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)}
     LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');

  // 1. Two organisations of the run's own, two builders in the first, detached.
  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const otherName = `${ORG_PREFIX} other ${RUN} Pty Ltd`;
  const builder = await seedBuilder('main', { orgName });
  const colleagueBuilder = await seedBuilder('colleague', { orgName, existingOrgId: builder.orgId });
  const other = (await net('other org', `
    INSERT INTO public.builder_organisations(legal_name, org_type)
    VALUES (${sqlLit(otherName)}, 'builder') RETURNING id, status`))[0];
  const otherItem = (await net('other item', `
    INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, availability_status, image_work_stage,
      enrichment_status, address_line, suburb, state, postcode, lot_number, price_display, description)
    VALUES (${id(other.id)}, 'staged', 'on_hold', 'settled', 'complete', '2 Messaging Proof Street', 'Proofvale',
      'VIC', '3999', '8${RUN.slice(-3)}', 'Proof only — not for sale', 'An invented property. Not for sale.')
    RETURNING id`))[0].id;
  const item = (await net('item', `
    INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, availability_status, image_work_stage,
      enrichment_status, address_line, suburb, state, postcode, lot_number, bedrooms, bathrooms, car_spaces,
      price, price_display, description)
    VALUES (${id(builder.orgId)}, 'staged', 'on_hold', 'settled', 'complete', '1 Messaging Proof Street', 'Proofvale',
      'VIC', '3999', '9${RUN.slice(-3)}', 4, 2, 2, 500000, 'Proof only — not for sale',
      'An invented property used to prove the network conversation. Not for sale.')
    RETURNING id`))[0].id;

  // The proof-only transport: one connection per organisation, both sides.
  const connection = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const otherConnection = randomUUID();
  const otherSecret = randomBytes(32).toString('hex');
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(builder.orgId)}),
           (${id(otherConnection)}, ${sqlLit(otherName)}, 'active', ARRAY['stock:publish'], ${sqlLit(otherSecret)}, ${sqlLit(networkDoor)}, now(), ${id(other.id)})`);
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Messaging proof (temporary)')
    RETURNING id`))[0].id;
  await net('connections', `
    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(builder.orgId)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now()),
           (${id(otherConnection)}, ${id(workspace)}, ${id(other.id)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(otherSecret)}, now(), now())`);
  const reachCount = (await net('reach count', `
    SELECT count(*)::int AS n FROM public.workspace_connections
     WHERE builder_organisation_id IN (${id(builder.orgId)}, ${id(other.id)})`))[0]?.n;
  record('1: the proof organisations reach only the proof transport (one connection each)',
    Number(reachCount) === 2 && other.status !== 'active', `${reachCount} connection(s)`);

  // 2. The property travels; the Command Centre activates it.
  await net('activate items', `
    UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id IN (${id(item)}, ${id(otherItem)})`);
  const mirrored = await waitFor('mirror', async () => {
    const rows = await cc('mirror', `
      SELECT count(*)::int AS n FROM public.builder_network_stock_items WHERE id IN (${id(item)}, ${id(otherItem)})`);
    return { done: Number(rows[0]?.n) === 2 };
  });
  if (!record('2: the property reaches the Command Centre over the proof transport', mirrored.done, secs(mirrored))) {
    throw new Error('the property never arrived');
  }

  const staff = await cc('staff', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    INSERT INTO public.custom_users(username, email, password_hash, role, first_name, last_name, is_active)
    VALUES (${sqlLit(`${CC_USER_PREFIX}owner-${RUN}`)}, ${sqlLit(`${CC_USER_PREFIX}owner-${RUN}@example.com`)},
            ${sqlLit(`not-a-password-${randomBytes(16).toString('hex')}`)}, 'proof_no_access', 'Olive', ${sqlLit(`Owner ${RUN}`)}, true),
           (${sqlLit(`${CC_USER_PREFIX}colleague-${RUN}`)}, ${sqlLit(`${CC_USER_PREFIX}colleague-${RUN}@example.com`)},
            ${sqlLit(`not-a-password-${randomBytes(16).toString('hex')}`)}, 'proof_no_access', 'Casey', ${sqlLit(`Colleague ${RUN}`)}, true);
    ALTER TABLE public.custom_users ENABLE TRIGGER USER;
    SELECT id, first_name FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%-${RUN}`)}`);
  const owner = staff.find((row) => row.first_name === 'Olive');
  const ccColleague = staff.find((row) => row.first_name === 'Casey');
  const clientLabel = `Proof Client ${RUN}`;
  // An invented client that NOTHING may react to: every user trigger on the
  // table is off for this one insert, inside this one transaction.
  const client = (await cc('client', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    INSERT INTO public.clients(primary_first_name, primary_surname)
    VALUES ('Proof', ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)});
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    SELECT id FROM public.clients WHERE primary_surname = ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)}`))[0];
  const selection = (await cc('selection', `
    INSERT INTO public.builder_stock_selections(stock_item_id, organisation_id, client_id, selected_by_user_id, status, internal_notes)
    VALUES (${id(item)}, ${id(builder.orgId)}, ${id(client.id)}, ${id(owner.id)}, 'selected', ${sqlLit(`private note ${clientLabel}`)})
    RETURNING id`))[0];
  const announced = await waitFor('announcement', async () => {
    const rows = await net('announcement', `
      SELECT status FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
    return { done: rows.length === 1 && rows[0].status !== 'withdrawn', status: rows[0]?.status };
  });
  if (!record('2: the Command Centre activation reaches the builder', announced.done,
    `${announced.status ?? 'none'} after ${secs(announced)}`)) throw new Error('the activation never arrived');

  const cookie = await establishSession(builder);
  for (const action of [{ action: 'accept_current_terms', acknowledgements: ALL_ACKS }, { action: 'complete_onboarding' }]) {
    await call('builder-portal-verify', action, cookie);
  }
  const conversationId = conversationIdFor(connection, item);

  // Views of the two sides.
  const ccMessage = async (messageId) => (await cc('cc message', `
    SELECT id, side, sender_user_id, sender_display_name, body, delivery_state, delivery_generation,
           failure_reason, conversation_id FROM public.builder_network_messages WHERE id = ${id(messageId)}`))[0] ?? null;
  const netMessage = async (messageId) => (await net('network message', `
    SELECT id, side, sender_builder_user_id, sender_display_name, body, delivery_state, delivery_generation,
           failure_reason, conversation_id FROM public.builder_agency_messages WHERE id = ${id(messageId)}`))[0] ?? null;
  const ccCount = async (messageId) => Number((await cc('cc count', `
    SELECT count(*)::int AS n FROM public.builder_network_messages WHERE id = ${id(messageId)}`))[0]?.n);
  const netCountIn = async (conversation) => Number((await net('thread count', `
    SELECT count(*)::int AS n FROM public.builder_agency_messages WHERE conversation_id = ${id(conversation)}`))[0]?.n);
  const netCount = async (messageId) => Number((await net('network count', `
    SELECT count(*)::int AS n FROM public.builder_agency_messages WHERE id = ${id(messageId)}`))[0]?.n);
  const ccPost = async (userId, clientMessageId, body) => (await cc('post', `
    SELECT id FROM public.builder_network_post_message(${id(item)}, ${id(userId)}, ${id(clientMessageId)}, ${sqlLit(body)})`))[0]?.id;
  const netPost = async (userId, clientMessageId, body) => (await net('post', `
    SELECT id FROM public.builder_agency_post_message(${id(builder.orgId)}, ${id(connection)}, ${id(item)},
      ${id(userId)}, ${id(clientMessageId)}, ${sqlLit(body)})`))[0]?.id;
  const deliveredOnCc = (messageId) => waitFor(`delivered ${messageId}`, async () => {
    const here = await ccMessage(messageId);
    const there = await netMessage(messageId);
    return { here, there, done: here?.delivery_state === 'delivered' && !!there };
  });
  const deliveredOnNetwork = (messageId) => waitFor(`delivered ${messageId}`, async () => {
    const here = await netMessage(messageId);
    const there = await ccMessage(messageId);
    return { here, there, done: here?.delivery_state === 'delivered' && !!there };
  });

  // 3. The activator writes.
  const k1 = randomUUID();
  const m1 = await ccPost(owner.id, k1, `Is lot ${RUN} still available?`);
  const m1Again = await ccPost(owner.id, k1, `Is lot ${RUN} still available?`);
  const firstQueued = await ccMessage(m1);
  const d1 = await deliveredOnCc(m1);
  record('3: the activator\'s message is queued until the builder accepts it, then Delivered',
    firstQueued?.delivery_state !== 'failed' && d1.done, `${firstQueued?.delivery_state} → ${d1.here?.delivery_state} in ${secs(d1)}`);
  record('3: the builder receives it under the activator\'s own name',
    d1.there?.side === 'command_centre' && d1.there?.sender_display_name === `Olive Owner ${RUN}`
      && d1.there?.body === `Is lot ${RUN} still available?`, d1.there?.sender_display_name ?? 'not received');
  const ccConversation = (await cc('conversation', `
    SELECT id, owner_user_id, started_by_user_id FROM public.builder_network_conversations
     WHERE connection_id = (SELECT id FROM public.builder_network_connections WHERE network_connection_id = ${id(connection)})
       AND stock_item_id = ${id(item)}`))[0] ?? {};
  const netConversation = (await net('conversation', `
    SELECT id FROM public.builder_agency_conversations WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`))[0] ?? {};
  record('3: both sides hold the same conversation, and it is the shared derivation',
    ccConversation.id === conversationId && netConversation.id === conversationId);
  record('3: the conversation belongs to the Command Centre user whose activation opened it',
    ccConversation.owner_user_id === owner.id && ccConversation.started_by_user_id === owner.id);

  // 4. A colleague writes as themselves.
  const m2 = await ccPost(ccColleague.id, randomUUID(), 'Adding the build timeline question here too.');
  const d2 = await deliveredOnCc(m2);
  const ownerAfter = (await cc('owner after', `
    SELECT owner_user_id FROM public.builder_network_conversations WHERE id = ${id(conversationId)}`))[0];
  record('4: a colleague writes into the same conversation, under their own name, and it is delivered',
    d2.done && d2.there?.sender_display_name === `Casey Colleague ${RUN}` && d2.there?.conversation_id === conversationId,
    `${d2.there?.sender_display_name ?? 'not received'} in ${secs(d2)}`);
  record('4: the conversation is still the activator\'s', ownerAfter?.owner_user_id === owner.id);

  // 5. The builder replies through the portal's own request; a builder colleague too.
  const k3 = randomUUID();
  const sendBody = { operation: 'send_agency_message', connection_id: connection, stock_item_id: item,
    client_message_id: k3, body: 'Yes — titles are due in the second quarter.' };
  const sent = await call('builder-portal-stock', sendBody, cookie);
  const sentAgain = await call('builder-portal-stock', sendBody, cookie);
  const m3 = sent.json?.message?.id;
  record('5: the builder writes through the portal', sent.status === 200 && UUID.test(String(m3))
    && sent.json?.message?.delivery_state === 'queued' && sent.json?.message?.mine === true,
    `HTTP ${sent.status} ${sent.json?.code ?? ''}`);
  const d3 = UUID.test(String(m3)) ? await deliveredOnNetwork(m3) : { done: false };
  record('5: the Command Centre receives it under the builder\'s name and the builder sees Delivered',
    d3.done && d3.there?.side === 'builder' && d3.there?.sender_display_name === builder.name
      && d3.there?.sender_user_id === null && d3.there?.delivery_state === null,
    `${d3.there?.sender_display_name ?? 'not received'} in ${secs(d3)}`);
  const m4 = await netPost(colleagueBuilder.userId, randomUUID(), 'And the display home is open on Saturday.');
  const d4 = await deliveredOnNetwork(m4);
  record('5: a builder colleague writes as themselves, and it is delivered',
    d4.done && d4.there?.sender_display_name === colleagueBuilder.name, `${secs(d4)}`);

  // 6. The same send repeated is the same message.
  record('6: the same send repeated is the same message, on both sides',
    m1Again === m1 && sentAgain.json?.message?.id === m3
      && await ccCount(m1) === 1 && await netCount(m1) === 1 && await ccCount(m3) === 1 && await netCount(m3) === 1,
    `cc ${m1Again === m1 ? 'same' : 'DIFFERENT'}, portal ${sentAgain.json?.message?.id === m3 ? 'same' : 'DIFFERENT'}`);

  // 7. One order, both sides.
  const ccOrder = (await cc('order', `
    SELECT id FROM public.builder_network_messages WHERE conversation_id = ${id(conversationId)} ORDER BY sent_at, id`)).map((r) => r.id);
  const netOrder = (await net('order', `
    SELECT id FROM public.builder_agency_messages WHERE conversation_id = ${id(conversationId)} ORDER BY sent_at, id`)).map((r) => r.id);
  const read = await call('builder-portal-stock', { operation: 'get_agency_conversation', connection_id: connection, stock_item_id: item }, cookie);
  const portalOrder = (read.json?.messages ?? []).map((m) => m.id);
  record('7: both sides, and the portal\'s read, order the thread identically',
    ccOrder.length === 4 && JSON.stringify(ccOrder) === JSON.stringify(netOrder)
      && JSON.stringify(portalOrder) === JSON.stringify(netOrder)
      && JSON.stringify(netOrder) === JSON.stringify([m1, m2, m3, m4]),
    `${ccOrder.length} / ${netOrder.length} / ${portalOrder.length}`);

  // 8. A refusal fails visibly; its writer sends it again under a new generation.
  await net('diverge', `
    UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn'
     WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
  const m5 = await ccPost(owner.id, randomUUID(), 'Could you send the updated brochure?');
  const failed = await waitFor('refused', async () => {
    const here = await ccMessage(m5);
    return { here, done: here?.delivery_state === 'failed' };
  });
  record('8: a message the builder\'s side refuses fails visibly, with the reason',
    failed.done && failed.here?.failure_reason === 'refused:conversation_not_open' && await netCount(m5) === 0,
    `${failed.here?.delivery_state}: ${failed.here?.failure_reason ?? '-'} in ${secs(failed)}`);
  const colleagueRetry = await refusalOf(() => cc('colleague retry', `
    SELECT * FROM public.builder_network_retry_message(${id(m5)}, ${id(ccColleague.id)})`));
  record('8: only its writer may send it again', /AGENCY_MESSAGE_NOT_RETRYABLE/.test(colleagueRetry ?? ''),
    colleagueRetry ? 'refused' : 'ACCEPTED');
  await net('restore', `
    UPDATE public.builder_stock_selection_announcements SET status = 'selected'
     WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
  await cc('retry', `SELECT * FROM public.builder_network_retry_message(${id(m5)}, ${id(owner.id)})`);
  const d5 = await deliveredOnCc(m5);
  record('8: sent again, it is delivered once, under generation 2',
    d5.done && Number(d5.here?.delivery_generation) === 2 && d5.here?.failure_reason === null && await netCount(m5) === 1,
    `${d5.here?.delivery_state} gen ${d5.here?.delivery_generation} in ${secs(d5)}`);

  // Signed deliveries of the proof's own, through the same live doors.
  const deliver = async (door, connectionId, connectionSecret, eventType, payload) => {
    const rawBody = JSON.stringify({ event_type: eventType, dedupe_key: `${TAG}:${RUN}:${randomUUID()}`, payload, source_version: 1 });
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
  const posted = (overrides) => ({
    schema_version: 1, conversation_id: conversationId, message_id: randomUUID(), stock_item_id: item,
    body: 'A signed proof message.', sender_display_name: 'Proof Sender', sent_at: new Date().toISOString(),
    generation: 1, ...overrides,
  });
  const netSweep = () => net('sweep', 'SELECT * FROM public.builder_agency_apply_message_events(50)');
  const ccSweep = () => cc('sweep', 'SELECT * FROM public.builder_network_apply_message_events(50)');
  const netOutcome = async (messageId) => (await net('outcome', `
    SELECT e.message_apply_error AS error, e.message_applied_at IS NOT NULL AS applied
      FROM public.builder_network_inbound_events e
     WHERE e.payload->>'message_id' = ${sqlLit(messageId)} AND e.event_type = 'agency.message.posted'
     ORDER BY e.received_at DESC LIMIT 1`))[0] ?? null;

  // 9. A replayed envelope makes no duplicate.
  const replayPayload = (await cc('m1 payload', `SELECT public.builder_network_message_payload(${id(m1)}) AS p`))[0]?.p;
  const replay = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    typeof replayPayload === 'string' ? JSON.parse(replayPayload) : replayPayload);
  await netSweep();
  record('9: a replayed signed envelope makes no duplicate, and the message stays Delivered',
    replay === 200 && await netCount(m1) === 1 && (await ccMessage(m1))?.delivery_state === 'delivered',
    `door ${replay}`);

  // 10. Wrong builder, wrong conversation, malformed — then a valid one behind them.
  const intruderId = randomUUID();
  const intruder = await deliver(networkDoor, otherConnection, otherSecret, 'agency.message.posted',
    posted({ message_id: intruderId, conversation_id: conversationIdFor(otherConnection, item) }));
  // The right property, over this connection, naming the conversation another
  // workspace connection would hold: the wrong workspace.
  const mismatchId = randomUUID();
  const mismatch = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    posted({ message_id: mismatchId, conversation_id: conversationIdFor(otherConnection, item) }));
  // Another builder's property, over this connection: the wrong property.
  const wrongPropertyId = randomUUID();
  const wrongProperty = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    posted({ message_id: wrongPropertyId, stock_item_id: otherItem, conversation_id: conversationIdFor(connection, otherItem) }));
  const threadBefore = await netCountIn(conversationId);
  const malformedId = randomUUID();
  const malformed = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    posted({ message_id: malformedId, body: '   ', sent_at: 'not a time' }));
  // A field outside the contract is refused at the door itself, before
  // anything is stored: the allow-list behind the privacy deny-list.
  const offContractId = randomUUID();
  const extraField = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    { ...posted({ message_id: offContractId }), customer_details: 'proof' });
  const behindId = randomUUID();
  const behind = await deliver(networkDoor, connection, secret, 'agency.message.posted',
    posted({ message_id: behindId, body: 'A valid message behind the refused ones.' }));
  await netSweep();
  const outcomes = {
    intruder: await netOutcome(intruderId), mismatch: await netOutcome(mismatchId),
    malformed: await netOutcome(malformedId), behind: await netOutcome(behindId),
    wrongProperty: await netOutcome(wrongPropertyId),
  };
  record('10: another builder\'s signed message naming this property is refused and stored nowhere',
    intruder === 200 && outcomes.intruder?.error === 'refused:stock_item_not_ours' && await netCount(intruderId) === 0,
    `door ${intruder}, ${outcomes.intruder?.error ?? 'no outcome'}`);
  record('10: a message naming another workspace\'s conversation is refused and stored nowhere',
    mismatch === 200 && outcomes.mismatch?.error === 'refused:conversation_mismatch' && await netCount(mismatchId) === 0,
    `door ${mismatch}, ${outcomes.mismatch?.error ?? 'no outcome'}`);
  record('10: a message naming another builder\'s property is refused and stored nowhere',
    wrongProperty === 200 && outcomes.wrongProperty?.error === 'refused:stock_item_not_ours' && await netCount(wrongPropertyId) === 0,
    `door ${wrongProperty}, ${outcomes.wrongProperty?.error ?? 'no outcome'}`);
  record('10: a malformed message is refused and stored nowhere',
    malformed === 200 && outcomes.malformed?.error === 'refused:invalid_message' && await netCount(malformedId) === 0,
    `door ${malformed}, ${outcomes.malformed?.error ?? 'no outcome'}`);
  record('10: a message carrying a field outside the contract is refused at the door and never stored',
    extraField === 422 && (await netOutcome(offContractId)) === null && await netCount(offContractId) === 0,
    `door ${extraField}`);
  record('10: a valid message behind them is applied (a refused message never blocks the next)',
    behind === 200 && outcomes.behind?.applied === true && outcomes.behind?.error === null && await netCount(behindId) === 1,
    `door ${behind}`);
  record('11: the refusals did not harm the conversation (every earlier message kept, only the valid one added)',
    await netCountIn(conversationId) === threadBefore + 1);
  const ccIntruderId = randomUUID();
  const ccIntruder = await deliver(ccDoor, otherConnection, otherSecret, 'agency.message.posted',
    posted({ message_id: ccIntruderId, conversation_id: conversationIdFor(otherConnection, item) }));
  await ccSweep();
  const ccIntruderOutcome = (await cc('outcome', `
    SELECT e.message_apply_error AS error FROM public.builder_network_inbound_events e
     WHERE e.payload->>'message_id' = ${sqlLit(ccIntruderId)}`))[0];
  record('10: the Command Centre refuses another builder\'s message about this property too',
    ccIntruder === 200 && ccIntruderOutcome?.error === 'refused:stock_item_not_ours' && await ccCount(ccIntruderId) === 0,
    `door ${ccIntruder}, ${ccIntruderOutcome?.error ?? 'no outcome'}`);

  // 11. Every refusal is on the operational log.
  const netLogged = Number((await net('logged', `
    SELECT count(*)::int AS n FROM public.portal_operational_events
     WHERE event_name = 'builder_agency_message_refused'
       AND metadata->>'connection_id' IN (${sqlLit(connection)}, ${sqlLit(otherConnection)})`))[0]?.n);
  const ccLogged = Number((await cc('logged', `
    SELECT count(*)::int AS n FROM public.portal_operational_events
     WHERE event_name = 'builder_network_message_refused' AND metadata->>'connection_id' IN
       (SELECT id::text FROM public.builder_network_connections WHERE network_connection_id = ${id(otherConnection)})`))[0]?.n);
  record('11: every refusal is written to the operational event log, on both sides',
    netLogged >= 4 && ccLogged >= 1, `network ${netLogged}, command centre ${ccLogged}`);

  // 12. Nothing but the contract crosses.
  const payloads = [
    ...(await cc('cc payloads', `
      SELECT o.event_type, o.payload FROM public.builder_network_outbox o
        JOIN public.builder_network_connections c ON c.id = o.connection_id
       WHERE c.network_connection_id = ${id(connection)} AND o.event_type LIKE 'agency.%'`)),
    ...(await net('network payloads', `
      SELECT event_type, payload FROM public.builder_network_outbox
       WHERE connection_id = ${id(connection)} AND event_type LIKE 'agency.%'`)),
  ].map((row) => ({ type: row.event_type, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }));
  const offContract = payloads.filter(({ type, payload }) => {
    const keys = Object.keys(payload ?? {}).sort();
    return type === 'agency.message.posted'
      ? JSON.stringify(keys) !== JSON.stringify(POSTED_KEYS)
      : !keys.every((key) => RECEIPT_KEYS.includes(key));
  });
  const secretsOfThisSide = [owner.id, ccColleague.id, client.id, selection.id, clientLabel, builder.userId,
    colleagueBuilder.userId, 'example.com'];
  const wire = JSON.stringify(payloads.map((p) => p.payload));
  record('12: every payload carries exactly the contract\'s keys',
    payloads.length >= 8 && offContract.length === 0, `${payloads.length} payload(s), ${offContract.length} off contract`);
  record('12: no user id, client, selection, note or email crosses the wire',
    !secretsOfThisSide.some((value) => wire.includes(value)));
  const readText = read.text + JSON.stringify(read.json ?? {});
  record('12: the portal\'s read carries no user id and no client',
    read.status === 200 && ![builder.userId, colleagueBuilder.userId, owner.id, ccColleague.id, clientLabel]
      .some((value) => readText.includes(value)) && !/sender_builder_user_id|sender_user_id|client/i.test(Object.keys(read.json?.messages?.[0] ?? {}).join(',')),
    `HTTP ${read.status}`);

  // 13. The polling read sees a NEW message. The same request the page repeats
  // every 10 seconds: nothing is reopened, recreated or reloaded between reads.
  const readThread = () => call('builder-portal-stock',
    { operation: 'get_agency_conversation', connection_id: connection, stock_item_id: item }, cookie);
  const before = await readThread();
  const beforeIds = (before.json?.messages ?? []).map((m) => m.id);
  const pollText = `A new question for polling ${RUN}`;
  const m6 = await ccPost(ccColleague.id, randomUUID(), pollText);
  record('13: the first polling read does not contain the new message',
    before.status === 200 && !beforeIds.includes(m6), `HTTP ${before.status}, ${beforeIds.length} message(s)`);
  let polls = 0;
  const seen = await waitFor('poll sees it', async () => {
    polls += 1;
    const read = await readThread();
    const found = (read.json?.messages ?? []).find((m) => m.id === m6);
    return { read, found, done: read.status === 200 && !!found };
  });
  record('13: a later polling read contains it, with its writer\'s name, delivered over the signed path',
    seen.done && seen.found?.body === pollText && seen.found?.sender_display_name === `Casey Colleague ${RUN}`
      && seen.found?.side === 'command_centre',
    `after ${polls} read(s), ${secs(seen)}`);
  const polledIds = (seen.read?.json?.messages ?? []).map((m) => m.id);
  record('13: the polled thread keeps the deterministic order, the new message last',
    JSON.stringify(polledIds) === JSON.stringify((await net('order', `
      SELECT id FROM public.builder_agency_messages WHERE conversation_id = ${id(conversationId)} ORDER BY sent_at, id`)).map((r) => r.id))
      && polledIds.at(-1) === m6);
  const mineFlags = (seen.read?.json?.messages ?? []).filter((m) => m.mine).map((m) => m.id);
  record('13: the read marks only the reader\'s own messages as theirs, each with its delivery',
    JSON.stringify(mineFlags) === JSON.stringify([m3])
      && (seen.read?.json?.messages ?? []).every((m) => (m.side === 'builder') === (m.delivery_state !== null)));

  // 14. Withdrawal closes the conversation and keeps its history.
  await cc('withdraw', `
    UPDATE public.builder_stock_selections SET status = 'withdrawn', withdrawn_at = now() WHERE id = ${id(selection.id)}`);
  const withdrawn = await waitFor('withdrawal', async () => {
    const rows = await net('announcement', `
      SELECT status FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(item)}`);
    return { done: rows[0]?.status === 'withdrawn' };
  });
  const closedSend = await call('builder-portal-stock', { ...sendBody, client_message_id: randomUUID(), body: 'Still there?' }, cookie);
  const closedCc = await refusalOf(() => ccPost(owner.id, randomUUID(), 'Still there?'));
  const history = await call('builder-portal-stock', { operation: 'get_agency_conversation', connection_id: connection, stock_item_id: item }, cookie);
  record('14: a withdrawn activation closes the conversation on both sides',
    withdrawn.done && closedSend.status === 409 && closedSend.json?.code === 'conversation_not_open'
      && /AGENCY_CONVERSATION_NOT_OPEN/.test(closedCc ?? ''),
    `withdrawn in ${secs(withdrawn)}, portal ${closedSend.status}, cc ${closedCc ? 'refused' : 'ACCEPTED'}`);
  record('14: its history stays readable, and the composer is gone',
    history.status === 200 && history.json?.open === false && history.json?.can_send === false
      && (history.json?.messages ?? []).length >= 7, `${(history.json?.messages ?? []).length} message(s)`);
} catch (error) {
  record('the proof ran to the end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end');
    const leftNetwork = (await net('left', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS orgs,
             (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)})::int AS workspaces,
             (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)})::int AS users`))[0];
    const leftCc = (await cc('left', `
      SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS connections,
             (SELECT count(*) FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)})::int AS staff,
             (SELECT count(*) FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)})::int AS clients,
             (SELECT count(*) FROM public.builder_network_stock_items WHERE address_line LIKE '% Messaging Proof Street')::int AS items`))[0];
    record('cleanup: nothing this run created is left on either side',
      leftNetwork.orgs === 0 && leftNetwork.workspaces === 0 && leftNetwork.users === 0
        && leftCc.connections === 0 && leftCc.staff === 0 && leftCc.clients === 0 && leftCc.items === 0,
      JSON.stringify({ ...leftNetwork, ...leftCc }));
  } catch (error) {
    record('cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length} of ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
