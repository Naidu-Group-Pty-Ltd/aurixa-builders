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
 * The result separates four things and never merges them:
 *   - MUTABLE proof artefacts, which must be zero;
 *   - RETAINED security log evidence: an operational event that is exactly a
 *     declared deliberate refusal a proof provokes (`DELIBERATE_REFUSALS`),
 *     verified by provenance and semantics, never by row id — reported
 *     separately and never counted as residue;
 *   - REAL Command Centre connections, validated against the network's
 *     `workspace_connections` (not against the stock mirror, which a builder
 *     with no stock copied yet is legitimately absent from);
 *   - UNVERIFIABLE checks, named, never guessed.
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
  // A Command Centre connection is judged by the cross-network relationship,
  // never by the stock mirror: a real builder with no stock copied yet has no
  // `builder_network_stock_organisations` row, and that is not residue.
  await classifyCcConnections();

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
    await classifyOperationalEvents(db, parent);
    await orphan('operational events', db, 'portal_operational_alerts', 'event_id', 'portal_operational_events');
  }

  // ---- sessions / temporary auth -------------------------------------------
  await orphan('sessions / temporary auth', 'cc', 'user_sessions', 'user_id', 'custom_users');
  await marker('sessions / temporary auth', 'cc', 'user_sessions');
  await orphan('sessions / temporary auth', 'net', 'builder_portal_sessions', 'builder_user_id', 'builder_portal_users');
}

// ---------------------------------------------------------------------------
// COMMAND CENTRE CONNECTIONS — legitimacy from the authoritative relationship.
//
// Real (excluded from residue) only when ALL hold: its `network_connection_id`
// resolves to a network `workspace_connections` row; both sides are active and
// unrevoked; the network builder organisation exists; the workspace exists and
// is not a proof workspace; and no side carries a proof marker. A marker on any
// side is proof residue. Anything else is reported as not validated, never
// guessed either way.
async function classifyCcConnections() {
  const category = 'workspaces / connections';
  const needs = [['cc', 'builder_network_connections', 'network_connection_id', 'state', 'revoked_at'],
    ['net', 'workspace_connections', 'workspace_id', 'builder_organisation_id', 'state', 'revoked_at']];
  for (const [db, table, ...cols] of needs) {
    if (!has(db, table, ...cols)) {
      results.push({ category, db: 'cc', label: 'connection legitimacy', n: null, note: `${table} columns missing on ${db}` });
      return;
    }
  }
  let ccRows; let netRows;
  try {
    ccRows = await query(CC_REF, `
      SELECT x.id::text AS id, x.state, x.revoked_at, x.network_connection_id::text AS network_connection_id,
             x::text ~ ${sqlLit(MARKER_RE)} AS marker
        FROM public.builder_network_connections x ORDER BY x.created_at`);
    const ids = ccRows.map((r) => r.network_connection_id).filter((v) => /^[0-9a-f-]{36}$/i.test(String(v)));
    netRows = ids.length ? await query(NETWORK_REF, `
      SELECT x.id::text AS id, x.state, x.revoked_at,
             x::text ~ ${sqlLit(MARKER_RE)} AS marker,
             o.id IS NOT NULL AS org_exists, coalesce(o::text ~ ${sqlLit(MARKER_RE)}, false) AS org_marker,
             r.id IS NOT NULL AS workspace_exists, coalesce(r::text ~ ${sqlLit(MARKER_RE)}, false) AS workspace_marker
        FROM public.workspace_connections x
        LEFT JOIN public.builder_organisations o ON o.id = x.builder_organisation_id
        LEFT JOIN public.workspace_registry r ON r.id = x.workspace_id
       WHERE x.id::text IN (${ids.map(sqlLit).join(', ')})`) : [];
  } catch (error) {
    results.push({ category, db: 'cc', label: 'connection legitimacy', n: null, note: String(error.message).slice(0, 160) });
    return;
  }
  const byId = new Map(netRows.map((r) => [r.id, r]));
  const proof = []; const real = []; const unvalidated = [];
  for (const c of ccRows) {
    const w = byId.get(c.network_connection_id);
    const reasons = [];
    if (c.state !== 'active') reasons.push(`cc state ${c.state}`);
    if (c.revoked_at) reasons.push('cc revoked');
    if (!w) reasons.push('network connection not found');
    else {
      if (w.state !== 'active') reasons.push(`network state ${w.state}`);
      if (w.revoked_at) reasons.push('network revoked');
      if (!w.org_exists) reasons.push('network organisation missing');
      if (!w.workspace_exists) reasons.push('workspace missing');
    }
    const marked = c.marker || (w && (w.marker || w.org_marker || w.workspace_marker));
    const line = `${short(c.id)}→${short(c.network_connection_id)}`;
    if (marked) proof.push(line);
    else if (!reasons.length) real.push(line);
    else unvalidated.push(`${line} (${reasons.join('; ')})`);
  }
  results.push({ category, db: 'cc', label: 'connections carrying a proof marker (either side)', n: proof.length, refs: proof });
  results.push({ category, db: 'cc', kind: 'real', label: 'real connections, validated against the network', n: real.length, refs: real });
  if (unvalidated.length) {
    results.push({ category, db: 'cc', label: 'connections not validated (no proof marker)', n: null,
      note: unvalidated.join(', ') });
  }
}

// ---------------------------------------------------------------------------
// OPERATIONAL EVENTS — proof residue vs retained security evidence.
//
// A proof-related event is one whose text carries a proof marker, or whose
// `connection_id` no longer resolves. It is RETAINED EVIDENCE only when it is
// exactly one of the declared deliberate refusal cases below, verified field by
// field: the event name and event type; a request id carrying the proof's own
// dedupe key, whose run tag decodes to a time within the window of the event;
// a connection that no longer exists; a metadata shape of path NAMES only (the
// refusal never stores a value); and no actor, case, matter, firm or
// correlation. Anything else proof-related is unexpected residue.
const DELIBERATE_REFUSALS = [
  {
    proof: 'stock-agencies-proof (check 3: a payload naming a client is refused at the door)',
    eventName: 'builder_network_inbound_privacy_violation',
    eventType: 'stock.selection.announced',
    requestId: /^smoke-rollout:agencies-proof:([0-9a-z]+):client$/,
    metadataKeys: ['connection_id', 'event_type', 'forbidden_path_count', 'forbidden_paths'],
    forbiddenPaths: ['client_name'],
  },
];
const RUN_WINDOW_MS = 30 * 60 * 1000;
/** A proof RUN is `Date.now().toString(36)` followed by six hex characters. */
const runStartedAt = (run) => (run.length > 6 ? parseInt(run.slice(0, -6), 36) : NaN);

function deliberateRefusal(e) {
  for (const d of DELIBERATE_REFUSALS) {
    const m = e.metadata ?? {};
    const keys = Object.keys(m).sort();
    const tag = String(e.request_id ?? '').match(d.requestId);
    const started = tag ? runStartedAt(tag[1]) : NaN;
    const occurred = Date.parse(e.occurred_at);
    const paths = Array.isArray(m.forbidden_paths) ? m.forbidden_paths : null;
    const checks = {
      event_name: e.event_name === d.eventName,
      event_type: m.event_type === d.eventType,
      proof_dedupe_key: !!tag && e.marker,
      within_run_window: Number.isFinite(started) && occurred >= started && occurred - started <= RUN_WINDOW_MS,
      connection_gone: e.has_connection && !e.connection_exists,
      metadata_shape: JSON.stringify(keys) === JSON.stringify([...d.metadataKeys].sort()),
      path_names_only: !!paths && JSON.stringify(paths) === JSON.stringify(d.forbiddenPaths)
        && Number(m.forbidden_path_count) === paths.length,
      no_actor_or_case: [e.actor_id, e.case_id, e.matter_id, e.firm_id, e.correlation_id].every((v) => v === null || v === undefined),
    };
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (!failed.length) return { proof: d.proof, run: tag[1], started: new Date(started).toISOString() };
    // Only a row that is recognisably this case (its name and type) says which
    // test it failed; anything else is plainly residue.
    if (checks.event_name && checks.event_type) return { failed };
  }
  return null;
}

async function classifyOperationalEvents(db, parent) {
  const category = 'operational events';
  const needed = ['portal_operational_events.metadata', 'portal_operational_events.request_id',
    'portal_operational_events.event_name', `${parent}.id`];
  for (const need of needed) {
    const [table, ...cols] = need.split('.');
    if (!has(db, table, ...cols)) {
      results.push({ category, db, label: 'portal_operational_events provenance', n: null, note: `${need} not in this schema` });
      return;
    }
  }
  const optional = ['actor_id', 'case_id', 'matter_id', 'firm_id', 'correlation_id']
    .map((c) => (has(db, 'portal_operational_events', c) ? `x.${c}` : `NULL AS ${c}`)).join(', ');
  let rows;
  try {
    rows = await query(DB[db], `
      SELECT x.id::text AS id, x.event_name, x.request_id, x.metadata, x.occurred_at, ${optional},
             x::text ~ ${sqlLit(MARKER_RE)} AS marker,
             (x.metadata ? 'connection_id') AS has_connection,
             EXISTS (SELECT 1 FROM public.${parent} c WHERE c.id::text = x.metadata->>'connection_id') AS connection_exists
        FROM public.portal_operational_events x
       WHERE x::text ~ ${sqlLit(MARKER_RE)}
          OR ((x.metadata ? 'connection_id')
              AND NOT EXISTS (SELECT 1 FROM public.${parent} c WHERE c.id::text = x.metadata->>'connection_id'))
       ORDER BY x.occurred_at`);
  } catch (error) {
    results.push({ category, db, label: 'portal_operational_events provenance', n: null, note: String(error.message).slice(0, 160) });
    return;
  }
  const retained = []; const residue = [];
  for (const e of rows) {
    const verdict = deliberateRefusal(e);
    if (verdict?.failed) {
      residue.push(`${short(e.id)} (resembles a deliberate refusal but failed: ${verdict.failed.join(', ')})`);
    } else if (verdict) {
      retained.push(`${short(e.id)} ${e.event_name} at ${e.occurred_at} from ${verdict.proof} run ${verdict.run} (started ${verdict.started})`);
    } else {
      residue.push(short(e.id));
    }
  }
  results.push({ category, db, label: 'portal_operational_events: unexpected proof residue', n: residue.length, refs: residue });
  results.push({ category, db, kind: 'retained', label: 'portal_operational_events: retained security evidence (deliberate refusal)',
    n: retained.length, refs: retained });
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

// ---------------------------------------------------------------------------
/** Describes, without printing a name, email or body, each row a check flagged. */
async function describeFlagged() {
  const flagged = results.filter((r) => r.n && !r.kind);
  if (!flagged.length) return;
  console.log('\nFLAGGED ROWS (read-only description; nothing is changed)');
  const connRefs = flagged.filter((r) => r.db === 'cc' && r.category === 'workspaces / connections')
    .flatMap((r) => r.refs.map((ref) => String(ref).slice(0, 8)));
  for (const ref of connRefs) {
    const [c] = await query(CC_REF, `
      SELECT x.id, x.state, x.created_at, x.accepted_at, x.revoked_at, x.network_connection_id,
             x::text ~ ${sqlLit(MARKER_RE)} AS proof_marker,
             (SELECT count(*) FROM public.builder_network_stock_items i WHERE i.organisation_id = x.builder_organisation_id)::int AS items,
             (SELECT count(*) FROM public.builder_stock_selections s WHERE s.organisation_id = x.builder_organisation_id)::int AS selections,
             (SELECT count(*) FROM public.builder_network_conversations v WHERE v.connection_id = x.id)::int AS conversations,
             (SELECT count(*) FROM public.builder_network_inbound_events e WHERE e.connection_id = x.id)::int AS inbound,
             (SELECT count(*) FROM public.builder_network_outbox o WHERE o.connection_id = x.id)::int AS outbox
        FROM public.builder_network_connections x WHERE x.id::text LIKE ${sqlLit(`${ref}%`)}`);
    if (!c) { console.log(`  CC connection ${ref}: not found on re-read`); continue; }
    let network = 'no network_connection_id';
    if (c.network_connection_id) {
      const [w] = await query(NETWORK_REF, `
        SELECT x.state, x.created_at, x.revoked_at,
               x::text ~ ${sqlLit(MARKER_RE)} AS proof_marker,
               EXISTS (SELECT 1 FROM public.builder_organisations o WHERE o.id = x.builder_organisation_id) AS org_exists,
               (SELECT r.slug ~ ${sqlLit(MARKER_RE)} FROM public.workspace_registry r WHERE r.id = x.workspace_id) AS workspace_is_proof
          FROM public.workspace_connections x WHERE x.id = ${sqlLit(c.network_connection_id)}::uuid`);
      network = w ? `network connection state=${w.state} created=${w.created_at} revoked=${w.revoked_at ?? '—'} proof_marker=${w.proof_marker} org_exists=${w.org_exists} workspace_is_proof=${w.workspace_is_proof}`
        : 'network connection not found';
    }
    console.log(`  CC connection ${short(c.id)} state=${c.state} created=${c.created_at} accepted=${c.accepted_at ?? '—'} revoked=${c.revoked_at ?? '—'} proof_marker=${c.proof_marker}` +
      ` items=${c.items} selections=${c.selections} conversations=${c.conversations} inbound=${c.inbound} outbox=${c.outbox}; ${network}`);
  }
  const eventRefs = [...new Set(flagged.filter((r) => r.db === 'net' && r.label.startsWith('portal_operational_events'))
    .flatMap((r) => r.refs.map((ref) => String(ref).slice(0, 8))))];
  for (const ref of eventRefs) {
    const [e] = await query(NETWORK_REF, `
      SELECT x.id, x.event_name, x.severity, x.portal, x.occurred_at, x.success,
             substring(x::text from ${sqlLit(`(${MARKER_RE})`)}) AS proof_tag,
             x.metadata->'forbidden_paths' AS forbidden_paths,
             x.metadata->>'event_type' AS event_type,
             (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(x.metadata) k) AS metadata_keys
        FROM public.portal_operational_events x WHERE x.id::text LIKE ${sqlLit(`${ref}%`)}`);
    console.log(e ? `  NET operational event ${short(e.id)} ${e.event_name} severity=${e.severity} portal=${e.portal} occurred=${e.occurred_at} success=${e.success} marker=${e.proof_tag ?? '—'} event_type=${e.event_type ?? '—'} forbidden_paths=${JSON.stringify(e.forbidden_paths)} keys=${e.metadata_keys}`
      : `  NET operational event ${ref}: not found on re-read`);
  }
}

async function main() {
  console.log('Step 6 closure audit (read-only; every statement a single SELECT)');
  await loadSchema('cc');
  await loadSchema('net');
  await audit();

  const kindOf = (r) => r.kind ?? 'mutable';
  console.log('\nPROOF ARTEFACT CHECKS');
  for (const r of results) {
    const where = r.db === 'cc' ? 'CC ' : 'NET';
    const value = r.n === null ? `NOT INDEPENDENTLY VERIFIABLE (${r.note})` : String(r.n);
    const refs = r.n ? ` refs=${(r.refs ?? []).join(' | ')}` : '';
    console.log(`  [${r.category}] (${kindOf(r)}) ${where} ${r.label}: ${value}${refs}`);
  }

  const mutable = results.filter((r) => kindOf(r) === 'mutable');
  console.log('\nMUTABLE PROOF ARTEFACTS  category | CC | network');
  const summarise = (rows) => {
    if (!rows.length) return 'n/a';
    const known = rows.filter((r) => r.n !== null);
    const sum = known.reduce((a, r) => a + r.n, 0);
    const unverifiable = rows.length - known.length;
    return `${sum}${unverifiable ? ` (+${unverifiable} NOT INDEPENDENTLY VERIFIABLE)` : ''} over ${known.length} check(s)`;
  };
  for (const c of [...new Set(mutable.map((r) => r.category))]) {
    const rows = mutable.filter((r) => r.category === c);
    console.log(`  ${c} | ${summarise(rows.filter((r) => r.db === 'cc'))} | ${summarise(rows.filter((r) => r.db === 'net'))}`);
  }
  const retained = results.filter((r) => kindOf(r) === 'retained');
  const real = results.filter((r) => kindOf(r) === 'real');
  const unverifiable = results.filter((r) => r.n === null);
  const retainedCount = retained.reduce((a, r) => a + (r.n ?? 0), 0);
  console.log(`\nRETAINED SECURITY LOG EVIDENCE: ${retainedCount}`);
  for (const r of retained) for (const ref of r.refs ?? []) console.log(`  ${r.db === 'cc' ? 'CC ' : 'NET'} ${ref}`);
  console.log(`\nREAL CONNECTIONS EXCLUDED AFTER VALIDATION: ${real.reduce((a, r) => a + (r.n ?? 0), 0)}`);
  for (const r of real) for (const ref of r.refs ?? []) console.log(`  CC  ${ref}`);
  console.log(`\nUNVERIFIABLE: ${unverifiable.length}`);
  for (const r of unverifiable) console.log(`  ${r.db === 'cc' ? 'CC ' : 'NET'} ${r.label}: ${r.note}`);

  await describeFlagged();
  const state = await realState();

  const mutableTotal = mutable.reduce((a, r) => a + (r.n ?? 0), 0);
  const byPrefix = (rows, p) => rows.find((r) => String(r.id).startsWith(p));
  const conv0 = byPrefix(state.ccConv, '0c07fd71'); const conv1 = byPrefix(state.ccConv, '45e16763');
  const net0 = byPrefix(state.netConv, '0c07fd71'); const net1 = byPrefix(state.netConv, '45e16763');
  const partsOk = ['0c07fd71', '45e16763'].every((c) => {
    const cp = state.ccParts.filter((p) => p.conv === c); const np = state.netParts.filter((p) => p.conv === c);
    return cp.length === 2 && np.length === 2
      && cp.every((p) => p.state === 'joined') && np.every((p) => p.state === 'joined')
      && cp.some((p) => p.side === 'command_centre' && p.is_activator) && cp.some((p) => p.side === 'builder')
      && np.some((p) => p.side === 'builder' && p.is_acknowledger) && np.some((p) => p.side === 'command_centre');
  });
  const unmatchedOk = ['6422d121', 'd7cd9995'].every((p) => byPrefix(state.selections, p)?.conversations === 0);
  const noBackfillMail = state.selections.every((s) => s.ack_emails === 0 && s.notifications_naming_it === 0);
  const realOk = state.ccConv.length === 2 && state.netConv.length === 2
    && conv0?.messages === 3 && net0?.messages === 3 && conv1?.messages === 0 && net1?.messages === 0
    && partsOk && unmatchedOk && noBackfillMail;
  console.log(`\nmutable proof artefacts: ${mutableTotal}; retained security evidence: ${retainedCount}; unverifiable: ${unverifiable.length}`);
  console.log(`real state as agreed: ${realOk} (conversations, messages, participants, unmatched activations, no backfill mail)`);
  const verdict = mutableTotal === 0 && unverifiable.length === 0 && realOk
    ? (retainedCount ? 'AUDIT CLEAN — WITH EXPECTED RETAINED SECURITY LOG EVIDENCE' : 'AUDIT CLEAN')
    : 'AUDIT NOT CLEAN';
  console.log(`VERDICT: ${verdict}`);
  console.log('nothing was written');
}

main().catch((error) => { console.error(error); process.exit(1); });
