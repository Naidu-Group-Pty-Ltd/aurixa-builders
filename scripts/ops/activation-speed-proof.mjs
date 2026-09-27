#!/usr/bin/env node
/**
 * ===========================================================================
 * AN ACTIVATION REACHES THE BUILDER AT ONCE — MEASURED ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * A Command Centre activation travels: the selection's trigger writes the
 * Command Centre outbox, the outbox worker signs and sends it to the
 * network's live door, the door applies it, and the builder's portal lists
 * it. It used to wait for the one-minute worker cron; the trigger now kicks
 * the worker once the row commits, and the cron stays as the recovery path.
 * This proof, on disposable rows of the run's own (the transport and
 * cleanup are `stock-messaging-proof`'s, verbatim):
 *
 *   1. makes SAMPLES activations, one at a time, and for each records the
 *      selection, outbox, delivery, door receipt, announcement and the
 *      moment the portal's own list request (a proof builder's session)
 *      first holds it — send-to-visible, worker latency, remote apply;
 *   2. asserts every sample visible within ACT_MAX_S and the median within
 *      ACT_MAX_MEDIAN_S (the fix is not proved if the kick is not firing);
 *   3. replays one delivered envelope (the row put back to pending, NOT
 *      kicked): the cron alone delivers it again, the door answers it as a
 *      duplicate, and nothing is stored twice on either side;
 *   4. each activation is one announcement, one outbox row, one inbound
 *      event, and the portal lists each once.
 *
 * Everything it created is deleted on both sides and the deletion checked.
 * Runs from the production-rollout workflow (phase `activation-speed-proof`).
 */
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'activation-speed';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const CC_USER_PREFIX = `${MARK}-${TAG}-`;
const CLIENT_SURNAME = `Activation Speed ${TAG}`;
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 4_000;
const VISIBLE_POLL_MS = 500;
const SAMPLES = Math.max(3, Number(process.env.ACT_SAMPLES || 6));
const MAX_VISIBLE_S = Number(process.env.ACT_MAX_S || 15);
const MAX_MEDIAN_S = Number(process.env.ACT_MAX_MEDIAN_S || 10);
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
/**
 * Step 5's per-property derivation — since one activation, one private
 * conversation (docs/builder-portal/52, 62) it names no conversation a new
 * activation opens, which is what the refusals below use it for.
 */
const conversationIdFor = (connectionId, stockItemId) => {
  const hex = createHash('md5').update(`agency.conversation:${connectionId}:${stockItemId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The shared derivation of an activation's conversation. */
const activationConversationIdFor = (connectionId, selectionRef) => {
  const hex = createHash('md5').update(`agency.activation:${connectionId}:${selectionRef}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const PARTICIPANT_KEYS = ['conversation_id', 'display_name', 'participant_ref', 'schema_version', 'side', 'state',
  'stock_item_id', 'version'];

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
  const proofUsers = `SELECT u.id FROM public.custom_users u WHERE u.username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)}`;
  const proofSelections = `SELECT s.id FROM public.builder_stock_selections s WHERE s.organisation_id IN (${orgList})`;
  await cc(`${stage}: rows`, `
    SET LOCAL lock_timeout = '5s';
    DELETE FROM public.integration_delivery_attempts WHERE outbox_id IN (
      SELECT o.id FROM public.integration_outbox o
       WHERE o.idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${proofSelections}) s));
    DELETE FROM public.integration_dead_letters WHERE outbox_id IN (
      SELECT o.id FROM public.integration_outbox o
       WHERE o.idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${proofSelections}) s));
    DELETE FROM public.integration_outbox
     WHERE idempotency_key IN (SELECT 'builder_activation_acknowledged:' || s.id::text FROM (${proofSelections}) s);
    DELETE FROM public.builder_network_acknowledgement_notices WHERE selection_id IN (${proofSelections});
    DELETE FROM public.notifications WHERE target_user_id IN (${proofUsers});
    DELETE FROM public.user_permissions WHERE user_id IN (${proofUsers});
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
  const password = `Pr00f!${RUN}!activation`;
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

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stats = (xs) => xs.length ? `${Math.min(...xs).toFixed(1)} / ${median(xs).toFixed(1)} / ${Math.max(...xs).toFixed(1)} s` : 'n/a';
const secondsBetween = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);

try {
  console.log(`activation speed proof run=${RUN} samples=${SAMPLES}`);
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'))) {
    throw new Error('cannot reach both projects');
  }
  await cleanup('start');

  const shipped = (await cc('shipped', `
    SELECT position('builder_network_kick_outbox' IN pg_get_functiondef(
             'public.builder_network_announce_stock_selection()'::regprocedure)) > 0 AS kicks,
           EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cross-portal-outbox-worker-1min' AND active) AS cron,
           (SELECT value = 'true'::jsonb FROM public.feature_flags WHERE key = 'builder_network_enabled') AS network_on`))[0] ?? {};
  record('0: the activation trigger kicks the worker; the one-minute cron is still scheduled', shipped.kicks && shipped.cron && shipped.network_on,
    JSON.stringify(shipped));

  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)}
     LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');

  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const builder = await seedBuilder('main', { orgName });
  const items = [];
  for (let n = 0; n < SAMPLES; n += 1) {
    items.push((await net(`item ${n}`, `
      INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, availability_status, image_work_stage,
        enrichment_status, address_line, suburb, state, postcode, lot_number, price_display, description)
      VALUES (${id(builder.orgId)}, 'staged', 'on_hold', 'settled', 'complete', '${n + 1} Activation Proof Street', 'Proofvale',
        'VIC', '3999', '${n + 1}${RUN.slice(-3)}', 'Proof only — not for sale', 'An invented property. Not for sale.')
      RETURNING id`))[0].id);
  }
  const connection = randomUUID();
  const secret = randomBytes(32).toString('hex');
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(builder.orgId)})`);
  // The Command Centre keys its outbox by ITS OWN connection row, not the network's id.
  const ccConnection = (await cc('cc connection', `
    SELECT id FROM public.builder_network_connections WHERE network_connection_id = ${id(connection)}`))[0]?.id;
  if (!ccConnection) throw new Error('the proof transport was not written');
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Activation speed proof (temporary)')
    RETURNING id`))[0].id;
  await net('connection', `
    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(builder.orgId)}, 'active', 'workspace',
            ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);

  const itemList = items.map(id).join(', ');
  await net('activate items', `UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id IN (${itemList})`);
  const mirrored = await waitFor('mirror', async () => {
    const rows = await cc('mirror', `SELECT count(*)::int AS n FROM public.builder_network_stock_items WHERE id IN (${itemList})`);
    return { done: Number(rows[0]?.n) === items.length };
  });
  if (!record('1: the proof properties reach the Command Centre', mirrored.done, secs(mirrored))) throw new Error('no mirror');

  const staff = (await cc('staff', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.custom_users DISABLE TRIGGER USER;
    INSERT INTO public.custom_users(username, email, password_hash, role, first_name, last_name, is_active)
    VALUES (${sqlLit(`${CC_USER_PREFIX}owner-${RUN}`)}, ${sqlLit(`${CC_USER_PREFIX}owner-${RUN}@example.com`)},
            ${sqlLit(`not-a-password-${randomBytes(16).toString('hex')}`)}, 'proof_no_access', 'Olive', ${sqlLit(`Owner ${RUN}`)}, true);
    ALTER TABLE public.custom_users ENABLE TRIGGER USER;
    SELECT id FROM public.custom_users WHERE username = ${sqlLit(`${CC_USER_PREFIX}owner-${RUN}`)}`))[0];
  const client = (await cc('client', `
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.clients DISABLE TRIGGER USER;
    INSERT INTO public.clients(primary_first_name, primary_surname)
    VALUES ('Proof', ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)});
    ALTER TABLE public.clients ENABLE TRIGGER USER;
    SELECT id FROM public.clients WHERE primary_surname = ${sqlLit(`${CLIENT_SURNAME} ${RUN}`)}`))[0];

  const cookie = await establishSession(builder);
  for (const action of [{ action: 'accept_current_terms', acknowledgements: ALL_ACKS }, { action: 'complete_onboarding' }]) {
    await call('builder-portal-verify', action, cookie);
  }
  const portalHolds = async (stockItemId) => {
    const read = await call('builder-portal-stock', { operation: 'list_activated_properties', page: 1, page_size: 100 }, cookie);
    const records = read.json?.records ?? [];
    return { status: read.status, count: records.filter((r) => r.stock_item_id === stockItemId).length };
  };

  // 1. The samples, one at a time.
  const samples = [];
  for (let n = 0; n < items.length; n += 1) {
    const before = await portalHolds(items[n]);
    const sentAt = Date.now();
    const selection = (await cc(`selection ${n}`, `
      INSERT INTO public.builder_stock_selections(stock_item_id, organisation_id, client_id, selected_by_user_id, status)
      VALUES (${id(items[n])}, ${id(builder.orgId)}, ${id(client.id)}, ${id(staff.id)}, 'selected')
      RETURNING id, created_at`))[0];
    let visibleMs = null;
    let lastStatus = null;
    while (Date.now() - sentAt < 150_000) {
      const holds = await portalHolds(items[n]);
      lastStatus = holds.status;
      if (holds.count >= 1) { visibleMs = Date.now() - sentAt; break; }
      await sleep(VISIBLE_POLL_MS);
    }
    const outbox = (await cc(`outbox ${n}`, `
      SELECT created_at, delivered_at, attempts, status FROM public.builder_network_outbox
       WHERE connection_id = ${id(ccConnection)} AND dedupe_key LIKE ${sqlLit(`stock.selection:${selection.id}:%`)}
       ORDER BY created_at`));
    const inbound = (await net(`inbound ${n}`, `
      SELECT received_at, processed_at FROM public.builder_network_inbound_events
       WHERE connection_id = ${id(connection)} AND dedupe_key LIKE ${sqlLit(`stock.selection:${selection.id}:%`)}
       ORDER BY received_at`));
    const announcement = (await net(`announcement ${n}`, `
      SELECT created_at FROM public.builder_stock_selection_announcements
       WHERE connection_id = ${id(connection)} AND stock_item_id = ${id(items[n])}`));
    const o = outbox[0] ?? {};
    const i = inbound[0] ?? {};
    const sample = {
      n: n + 1,
      absentBefore: before.count === 0,
      visible_s: visibleMs === null ? null : visibleMs / 1000,
      outbox_after_selection_s: secondsBetween(selection.created_at, o.created_at),
      worker_s: secondsBetween(o.created_at, o.delivered_at),
      door_after_send_s: secondsBetween(o.created_at, i.received_at),
      remote_apply_s: secondsBetween(i.received_at, announcement[0]?.created_at),
      attempts: o.attempts, outboxRows: outbox.length, inboundRows: inbound.length, announcements: announcement.length,
      portalStatus: lastStatus,
    };
    samples.push(sample);
    console.log(`  sample ${sample.n}: visible ${sample.visible_s ?? 'never'} s · worker ${sample.worker_s?.toFixed(2)} s`
      + ` · door ${sample.door_after_send_s?.toFixed(2)} s after enqueue · remote apply ${sample.remote_apply_s?.toFixed(2)} s`
      + ` · attempts ${sample.attempts}`);
    await sleep(2_000);
  }

  const visible = samples.map((s) => s.visible_s).filter((v) => v !== null);
  const worker = samples.map((s) => s.worker_s).filter((v) => v !== null);
  const remote = samples.map((s) => s.remote_apply_s).filter((v) => v !== null);
  console.log(`  send→visible  min/median/max ${stats(visible)}`);
  console.log(`  worker        min/median/max ${stats(worker)}`);
  console.log(`  remote apply  min/median/max ${stats(remote)}`);
  record('1: every activation was absent from the portal before it was made', samples.every((s) => s.absentBefore));
  record(`1: every activation is visible in the builder's portal within ${MAX_VISIBLE_S} s`,
    visible.length === samples.length && Math.max(...visible) <= MAX_VISIBLE_S, stats(visible));
  record(`1: the median activation is visible within ${MAX_MEDIAN_S} s (the immediate path fires)`,
    visible.length === samples.length && median(visible) <= MAX_MEDIAN_S, `median ${median(visible).toFixed(1)} s`);
  record('4: each activation is one outbox row, one inbound event and one announcement',
    samples.every((s) => s.outboxRows === 1 && s.inboundRows === 1 && s.announcements === 1),
    samples.map((s) => `${s.outboxRows}/${s.inboundRows}/${s.announcements}`).join(' '));

  // 3. The recovery path and replay safety: one delivered row put back, NOT kicked.
  const first = (await cc('replay row', `
    UPDATE public.builder_network_outbox SET status = 'pending', delivered_at = NULL, available_at = now(),
           locked_at = NULL, locked_by = NULL
     WHERE connection_id = ${id(ccConnection)} AND dedupe_key LIKE 'stock.selection:%'
       AND id = (SELECT id FROM public.builder_network_outbox WHERE connection_id = ${id(ccConnection)}
                  AND dedupe_key LIKE 'stock.selection:%' ORDER BY created_at LIMIT 1)
    RETURNING id, dedupe_key`))[0];
  const redelivered = await waitFor('cron redelivery', async () => {
    const rows = await cc('redelivered', `SELECT status, attempts FROM public.builder_network_outbox WHERE id = ${id(first.id)}`);
    return { done: rows[0]?.status === 'delivered', status: rows[0]?.status };
  }, 150_000);
  record('3: a queued delivery with no kick is delivered by the cron alone', redelivered.done,
    `${redelivered.status} after ${secs(redelivered)}`);
  const afterReplay = (await net('after replay', `
    SELECT (SELECT count(*)::int FROM public.builder_network_inbound_events
             WHERE connection_id = ${id(connection)} AND dedupe_key = ${sqlLit(first.dedupe_key)}) AS inbound,
           (SELECT count(*)::int FROM public.builder_stock_selection_announcements
             WHERE connection_id = ${id(connection)}) AS announcements`))[0] ?? {};
  const listed = await call('builder-portal-stock', { operation: 'list_activated_properties', page: 1, page_size: 100 }, cookie);
  const listedIds = (listed.json?.records ?? []).map((r) => r.stock_item_id).filter((v) => items.includes(v));
  record('3: the replayed envelope is a duplicate — nothing is stored twice on either side',
    Number(afterReplay.inbound) === 1 && Number(afterReplay.announcements) === items.length,
    `inbound ${afterReplay.inbound}, announcements ${afterReplay.announcements} of ${items.length}`);
  record('4: the portal lists each activation exactly once',
    listed.status === 200 && listedIds.length === items.length && new Set(listedIds).size === items.length,
    `HTTP ${listed.status}, ${listedIds.length} listed`);
} catch (error) {
  record('the proof ran to its end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end');
    const left = (await net('left', `
      SELECT count(*)::int AS n FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)}`))[0]?.n;
    const ccLeft = (await cc('left', `
      SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)})
           + (SELECT count(*) FROM public.custom_users WHERE username LIKE ${sqlLit(`${CC_USER_PREFIX}%`)})
           + (SELECT count(*) FROM public.clients WHERE primary_surname LIKE ${sqlLit(`${CLIENT_SURNAME} %`)}) AS n`))[0]?.n;
    record('cleanup: nothing this run created is left on either side', Number(left) === 0 && Number(ccLeft) === 0,
      `network ${left}, command centre ${ccLeft}`);
  } catch (error) {
    record('cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed (run ${RUN})`);
console.log(failed.length ? 'ACTIVATION SPEED PROOF FAILED' : 'ACTIVATION SPEED PROOF PASSED');
process.exit(failed.length ? 1 : 0);
