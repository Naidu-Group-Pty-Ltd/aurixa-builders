#!/usr/bin/env node
/**
 * ===========================================================================
 * STEP 6 CLOSURE AUDIT — READ-ONLY, BOTH PROJECTS.
 * ===========================================================================
 *
 * Counts, independently and per table, anything the Step 6 private-chat proof
 * and the regression proofs (messaging, project, media, agencies) could have
 * left behind, and re-reads the real agency conversations. Nothing is
 * inferred from another table: every category is its own statement, and a
 * category whose table or column this project does not have is reported as
 * NOT INDEPENDENTLY VERIFIABLE rather than as zero.
 *
 * Two independent instruments per table where the schema allows:
 *   - MARKER: the row's whole text carries a string only a proof writes
 *     (`smoke-rollout-`, `Smoke Rollout `, the proof street names, the
 *     `proof_no_access` role, the resend.dev sinks …);
 *   - ORPHAN: the row points at a parent that no longer exists — which is
 *     what a proof row looks like once its organisation, connection, user or
 *     conversation has been removed and nothing carried a marker.
 * Conversations, participants and messages are also counted against the two
 * agreed real conversations: anything outside them is reported.
 *
 * Every statement is a single SELECT, and `query` refuses anything else
 * before it leaves this process. It prints ids truncated to eight characters,
 * states and counts — never a message body, a name, an email address or any
 * client data — and it writes nothing.
 *
 * Runs from the production-rollout workflow (phase `step6-proof-audit`).
 */
const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const WRITE_WORD = /\b(insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|copy|vacuum|call|do|set|reset|lock|comment|refresh|begin|commit|rollback)\b/i;
function assertReadOnly(sql) {
  const body = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(body)) throw new Error('refused: not a SELECT');
  if (body.includes(';')) throw new Error('refused: more than one statement');
  // Strip string literals before looking for a write keyword, so a marker
  // such as 'Proof only — not for sale' cannot trip or hide one.
  if (WRITE_WORD.test(body.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error('refused: write keyword');
}

async function query(ref, sql) {
  assertReadOnly(sql);
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed?.result ?? []);
}
const DB = { cc: CC_REF, net: NETWORK_REF };
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const short = (v) => (v ? String(v).slice(0, 8) : '—');

// Strings only a proof writes. Case-sensitive on purpose: generic words such
// as "proof" appear in real data ("proof of identity").
const MARKER_RE = [
  'smoke-rollout', 'Smoke Rollout ', 'proof_no_access',
  'Private Chat Proof', 'Messaging Proof', 'Media Proof Street', 'Project Proof', 'Agencies Proof',
  'Proofvale', 'Proof only — not for sale', 'Proof description', 'A signed proof message',
  'Proof Certifi', 'Proof Contact', 'Proof Client', 'Proof Sender', 'proof\\.contact@example\\.com',
  '(private-chat|messaging|media|project|agencies)-proof',
].join('|');

const REAL_CONVERSATIONS = ['0c07fd71', '45e16763'];
const REAL_ACTIVATIONS = ['856a4faa', '7e26e039', '6422d121', 'd7cd9995'];

const schema = {};
async function loadSchema(db) {
  const rows = await query(DB[db], `
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name).add(r.column_name);
  }
  schema[db] = map;
}
const has = (db, table, ...cols) => schema[db].has(table) && cols.every((c) => schema[db].get(table).has(c));

// ---------------------------------------------------------------------------
const results = []; // { category, db, label, n|null, refs, note }

async function count(category, db, label, needs, sql) {
  for (const need of needs) {
    const [table, ...cols] = need.split('.');
    if (!has(db, table, ...cols)) {
      results.push({ category, db, label, n: null, note: `${need} not in this schema` });
      return;
    }
  }
  try {
    const [row] = await query(DB[db], sql);
    results.push({ category, db, label, n: Number(row?.n ?? 0), refs: row?.refs ?? [] });
  } catch (error) {
    results.push({ category, db, label, n: null, note: String(error.message).slice(0, 160) });
  }
}

const refOf = (alias) => `left(coalesce(to_jsonb(${alias})->>'id', to_jsonb(${alias})->>'selection_id',
  to_jsonb(${alias})->>'conversation_id', to_jsonb(${alias})->>'participant_ref', md5(${alias}::text)), 8)`;

/** Rows of `table` whose whole text carries a proof marker. */
const marker = (category, db, table) => count(category, db, `${table}: proof marker`, [table], `
  SELECT count(*)::int AS n, (array_agg(${refOf('x')}))[1:5] AS refs
    FROM public.${table} x WHERE x::text ~ ${sqlLit(MARKER_RE)}`);

/** Rows of `table` whose `col` points at a `parent` row that no longer exists. */
const orphan = (category, db, table, col, parent, parentCol = 'id') =>
  count(category, db, `${table}.${col} → missing ${parent}`, [`${table}.${col}`, `${parent}.${parentCol}`], `
    SELECT count(*)::int AS n, (array_agg(${refOf('x')}))[1:5] AS refs
      FROM public.${table} x
     WHERE x.${col} IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.${parent} p WHERE p.${parentCol} = x.${col})`);

/** Rows of `table` whose `col` is not one of the named real ids (by 8-char prefix). */
const outsideReal = (category, db, table, col, prefixes) =>
  count(category, db, `${table}: outside the agreed real set`, [`${table}.${col}`], `
    SELECT count(*)::int AS n, (array_agg(${refOf('x')}))[1:5] AS refs
      FROM public.${table} x
     WHERE left(x.${col}::text, 8) NOT IN (${prefixes.map(sqlLit).join(', ')})`);

async function audit() {
  // ---- organisations -------------------------------------------------------
  await marker('organisations', 'net', 'builder_organisations');
  await marker('organisations', 'cc', 'builder_network_stock_organisations');
  await marker('organisations', 'cc', 'builder_network_connections');
  await orphan('organisations', 'net', 'builder_organisation_memberships', 'organisation_id', 'builder_organisations');

  // ---- workspaces / transport ----------------------------------------------
  await marker('workspaces', 'net', 'workspace_registry');
  await marker('workspaces', 'net', 'workspace_connections');
  await orphan('workspaces', 'net', 'workspace_connections', 'builder_organisation_id', 'builder_organisations');
  await orphan('workspaces', 'net', 'workspace_connections', 'workspace_id', 'workspace_registry');
  await orphan('workspaces', 'cc', 'builder_network_connections', 'builder_organisation_id', 'builder_network_stock_organisations');

  // ---- users / staff -------------------------------------------------------
  await marker('users / staff', 'net', 'builder_portal_users');
  await orphan('users / staff', 'net', 'builder_organisation_memberships', 'builder_user_id', 'builder_portal_users');
  await marker('users / staff', 'cc', 'custom_users');
  await orphan('users / staff', 'cc', 'user_permissions', 'user_id', 'custom_users');

  // ---- clients -------------------------------------------------------------
  await marker('clients', 'cc', 'clients');

  // ---- properties / stock items --------------------------------------------
  await marker('properties / stock items', 'net', 'builder_stock_items');
  await orphan('properties / stock items', 'net', 'builder_stock_items', 'organisation_id', 'builder_organisations');
  await marker('properties / stock items', 'net', 'builder_projects');
  await orphan('properties / stock items', 'net', 'builder_projects', 'builder_organisation_id', 'builder_organisations');
  await marker('properties / stock items', 'cc', 'builder_network_stock_items');
  await orphan('properties / stock items', 'cc', 'builder_network_stock_items', 'organisation_id', 'builder_network_stock_organisations');

  // ---- activations / selections --------------------------------------------
  await marker('activations / selections', 'cc', 'builder_stock_selections');
  await orphan('activations / selections', 'cc', 'builder_stock_selections', 'organisation_id', 'builder_network_stock_organisations');
  await orphan('activations / selections', 'cc', 'builder_stock_selections', 'stock_item_id', 'builder_network_stock_items');
  await outsideReal('activations / selections', 'cc', 'builder_stock_selections', 'id', REAL_ACTIVATIONS);
  await marker('activations / selections', 'net', 'builder_stock_selection_announcements');
  await orphan('activations / selections', 'net', 'builder_stock_selection_announcements', 'connection_id', 'workspace_connections');
  await orphan('activations / selections', 'net', 'builder_stock_selection_announcements', 'stock_item_id', 'builder_stock_items');

  // ---- conversations -------------------------------------------------------
  await outsideReal('conversations', 'cc', 'builder_network_conversations', 'id', REAL_CONVERSATIONS);
  await marker('conversations', 'cc', 'builder_network_conversations');
  await orphan('conversations', 'cc', 'builder_network_conversations', 'connection_id', 'builder_network_connections');
  await outsideReal('conversations', 'net', 'builder_agency_conversations', 'id', REAL_CONVERSATIONS);
  await marker('conversations', 'net', 'builder_agency_conversations');
  await orphan('conversations', 'net', 'builder_agency_conversations', 'organisation_id', 'builder_organisations');

  // ---- participants --------------------------------------------------------
  await outsideReal('conversation participants', 'cc', 'builder_network_conversation_participants', 'conversation_id', REAL_CONVERSATIONS);
  await orphan('conversation participants', 'cc', 'builder_network_conversation_participants', 'local_user_id', 'custom_users');
  await outsideReal('conversation participants', 'net', 'builder_agency_conversation_participants', 'conversation_id', REAL_CONVERSATIONS);

  // ---- messages ------------------------------------------------------------
  await outsideReal('messages', 'cc', 'builder_network_messages', 'conversation_id', REAL_CONVERSATIONS);
  await marker('messages', 'cc', 'builder_network_messages');
  await outsideReal('messages', 'net', 'builder_agency_messages', 'conversation_id', REAL_CONVERSATIONS);
  await marker('messages', 'net', 'builder_agency_messages');

  // ---- notifications / acknowledgement notices ------------------------------
  await marker('notifications / notices', 'cc', 'notifications');
  await orphan('notifications / notices', 'cc', 'notifications', 'target_user_id', 'custom_users');
  await orphan('notifications / notices', 'cc', 'builder_network_acknowledgement_notices', 'selection_id', 'builder_stock_selections');
  await outsideReal('notifications / notices', 'cc', 'builder_network_acknowledgement_notices', 'selection_id', REAL_ACTIVATIONS);
  await marker('notifications / notices', 'net', 'builder_notifications');
  await orphan('notifications / notices', 'net', 'builder_notifications', 'builder_user_id', 'builder_portal_users');
  await orphan('notifications / notices', 'net', 'builder_notifications', 'organisation_id', 'builder_organisations');

  // ---- email queue / mail delivery -----------------------------------------
  await count('email queue / mail', 'cc', 'integration_outbox: acknowledgement email for a selection that no longer exists',
    ['integration_outbox.idempotency_key', 'builder_stock_selections.id'], `
    SELECT count(*)::int AS n, (array_agg(left(o.id::text, 8)))[1:5] AS refs
      FROM public.integration_outbox o
     WHERE o.idempotency_key LIKE 'builder_activation_acknowledged:%'
       AND NOT EXISTS (SELECT 1 FROM public.builder_stock_selections s
                        WHERE 'builder_activation_acknowledged:' || s.id::text = o.idempotency_key)`);
  await marker('email queue / mail', 'cc', 'integration_outbox');
  await orphan('email queue / mail', 'cc', 'integration_delivery_attempts', 'outbox_id', 'integration_outbox');
  await orphan('email queue / mail', 'cc', 'integration_dead_letters', 'outbox_id', 'integration_outbox');
  await marker('email queue / mail', 'cc', 'notification_deliveries');
  await marker('email queue / mail', 'net', 'integration_outbox');
  await orphan('email queue / mail', 'net', 'builder_email_verification_tokens', 'builder_user_id', 'builder_portal_users');

  // ---- network outbox ------------------------------------------------------
  await orphan('outbox', 'cc', 'builder_network_outbox', 'connection_id', 'builder_network_connections');
  await marker('outbox', 'cc', 'builder_network_outbox');
  await orphan('outbox', 'net', 'builder_network_outbox', 'connection_id', 'workspace_connections');
  await marker('outbox', 'net', 'builder_network_outbox');

  // ---- inbound / network events --------------------------------------------
  await orphan('inbound / network events', 'cc', 'builder_network_inbound_events', 'connection_id', 'builder_network_connections');
  await marker('inbound / network events', 'cc', 'builder_network_inbound_events');
  await orphan('inbound / network events', 'cc', 'builder_network_stamps', 'connection_id', 'builder_network_connections');
  await orphan('inbound / network events', 'net', 'builder_network_inbound_events', 'connection_id', 'workspace_connections');
  await marker('inbound / network events', 'net', 'builder_network_inbound_events');
  await orphan('inbound / network events', 'net', 'builder_network_stamps', 'connection_id', 'workspace_connections');
  await orphan('inbound / network events', 'net', 'workspace_connection_events', 'connection_id', 'workspace_connections');

  // ---- operational events / logs -------------------------------------------
  for (const [db, parent] of [['cc', 'builder_network_connections'], ['net', 'workspace_connections']]) {
    await count('operational events', db, `portal_operational_events: connection_id → missing ${parent}`,
      ['portal_operational_events.metadata', `${parent}.id`], `
      SELECT count(*)::int AS n, (array_agg(left(e.id::text, 8)))[1:5] AS refs
        FROM public.portal_operational_events e
       WHERE e.metadata ? 'connection_id'
         AND NOT EXISTS (SELECT 1 FROM public.${parent} c WHERE c.id::text = e.metadata->>'connection_id')`);
    await marker('operational events', db, 'portal_operational_events');
    await orphan('operational events', db, 'portal_operational_alerts', 'event_id', 'portal_operational_events');
  }

  // ---- sessions / temporary auth -------------------------------------------
  await orphan('sessions / temporary auth', 'cc', 'user_sessions', 'user_id', 'custom_users');
  await marker('sessions / temporary auth', 'cc', 'user_sessions');
  await orphan('sessions / temporary auth', 'net', 'builder_portal_sessions', 'builder_user_id', 'builder_portal_users');
}

// ---------------------------------------------------------------------------
async function realState() {
  console.log('\nREAL PRODUCTION STATE (read-only)');
  const idsLike = (list) => list.map((p) => `x.id::text LIKE ${sqlLit(`${p}%`)}`).join(' OR ');

  const ccConv = await query(CC_REF, `
    SELECT x.id, x.stock_item_id, x.builder_organisation_id,
           (SELECT count(*) FROM public.builder_network_messages m WHERE m.conversation_id = x.id)::int AS messages,
           (SELECT min(m.created_at) FROM public.builder_network_messages m WHERE m.conversation_id = x.id) AS first_at,
           (SELECT max(m.created_at) FROM public.builder_network_messages m WHERE m.conversation_id = x.id) AS last_at
      FROM public.builder_network_conversations x WHERE ${idsLike(REAL_CONVERSATIONS)} ORDER BY x.created_at`);
  const netConv = await query(NETWORK_REF, `
    SELECT x.id, x.connection_id, x.stock_item_id,
           (SELECT count(*) FROM public.builder_agency_messages m WHERE m.conversation_id = x.id)::int AS messages
      FROM public.builder_agency_conversations x WHERE ${idsLike(REAL_CONVERSATIONS)} ORDER BY x.created_at`);
  for (const c of ccConv) {
    console.log(`  CC  ${short(c.id)} messages=${c.messages} first=${c.first_at ?? '—'} last=${c.last_at ?? '—'}`);
  }
  for (const c of netConv) console.log(`  NET ${short(c.id)} messages=${c.messages}`);

  const ccParts = await query(CC_REF, `
    SELECT left(p.conversation_id::text, 8) AS conv, p.side, p.state,
           (p.local_user_id IS NOT NULL) AS local,
           EXISTS (SELECT 1 FROM public.builder_stock_selections s
                    WHERE s.stock_item_id = c.stock_item_id AND s.organisation_id = c.builder_organisation_id
                      AND s.selected_by_user_id = p.local_user_id) AS is_activator
      FROM public.builder_network_conversation_participants p
      JOIN public.builder_network_conversations c ON c.id = p.conversation_id
     ORDER BY 1, 2`);
  const netParts = await query(NETWORK_REF, `
    SELECT left(p.conversation_id::text, 8) AS conv, p.side, p.state,
           (p.builder_user_id IS NOT NULL) AS local,
           EXISTS (SELECT 1 FROM public.builder_stock_selection_announcements a
                    WHERE a.connection_id = c.connection_id AND a.stock_item_id = c.stock_item_id
                      AND a.acknowledged_by_builder_user_id = p.builder_user_id) AS is_acknowledger
      FROM public.builder_agency_conversation_participants p
      JOIN public.builder_agency_conversations c ON c.id = p.conversation_id
     ORDER BY 1, 2`);
  for (const p of ccParts) console.log(`  CC  participant conv=${p.conv} side=${p.side} state=${p.state} local=${p.local} activator=${p.is_activator}`);
  for (const p of netParts) console.log(`  NET participant conv=${p.conv} side=${p.side} state=${p.state} local=${p.local} acknowledger=${p.is_acknowledger}`);

  const selections = await query(CC_REF, `
    SELECT x.id, x.status,
           (SELECT count(*) FROM public.builder_network_conversations c
             WHERE c.stock_item_id = x.stock_item_id AND c.builder_organisation_id = x.organisation_id)::int AS conversations,
           (SELECT count(*) FROM public.builder_network_acknowledgement_notices n WHERE n.selection_id = x.id)::int AS notices,
           (SELECT string_agg(n.outcome || ':email=' || (n.email_sent_at IS NOT NULL), ',')
              FROM public.builder_network_acknowledgement_notices n WHERE n.selection_id = x.id) AS notice_outcomes,
           (SELECT count(*) FROM public.integration_outbox o
             WHERE o.idempotency_key = 'builder_activation_acknowledged:' || x.id::text)::int AS ack_emails,
           (SELECT count(*) FROM public.notifications nn
             WHERE nn::text LIKE '%' || x.id::text || '%')::int AS notifications_naming_it
      FROM public.builder_stock_selections x WHERE ${idsLike(REAL_ACTIVATIONS)} ORDER BY x.selected_at`);
  for (const s of selections) {
    console.log(`  CC  activation ${short(s.id)} status=${s.status} conversations=${s.conversations} notices=${s.notices}` +
      ` (${s.notice_outcomes ?? 'none'}) ack_email_outbox=${s.ack_emails} notifications_naming_it=${s.notifications_naming_it}`);
  }
  return { ccConv, netConv, ccParts, netParts, selections };
}

async function main() {
  console.log('Step 6 closure audit (read-only; every statement a single SELECT)');
  await loadSchema('cc');
  await loadSchema('net');
  await audit();

  console.log('\nPROOF ARTEFACT CHECKS');
  for (const r of results) {
    const where = r.db === 'cc' ? 'CC ' : 'NET';
    const value = r.n === null ? `NOT INDEPENDENTLY VERIFIABLE (${r.note})` : String(r.n);
    const refs = r.n ? ` refs=${(r.refs ?? []).join(',')}` : '';
    console.log(`  [${r.category}] ${where} ${r.label}: ${value}${refs}`);
  }

  console.log('\nSUMMARY  category | CC | network');
  const categories = [...new Set(results.map((r) => r.category))];
  const summarise = (rows) => {
    if (!rows.length) return 'n/a';
    const known = rows.filter((r) => r.n !== null);
    const sum = known.reduce((a, r) => a + r.n, 0);
    const unverifiable = rows.length - known.length;
    return `${sum}${unverifiable ? ` (+${unverifiable} unverifiable)` : ''} over ${known.length} check(s)`;
  };
  for (const c of categories) {
    const rows = results.filter((r) => r.category === c);
    console.log(`  ${c} | ${summarise(rows.filter((r) => r.db === 'cc'))} | ${summarise(rows.filter((r) => r.db === 'net'))}`);
  }

  const state = await realState();
  const nonZero = results.filter((r) => r.n);
  console.log(`\nnon-zero proof checks: ${nonZero.length}; unverifiable checks: ${results.filter((r) => r.n === null).length}`);
  console.log(`real conversations found: CC ${state.ccConv.length}, network ${state.netConv.length}`);
  console.log('nothing was written');
}

main().catch((error) => { console.error(error); process.exit(1); });
