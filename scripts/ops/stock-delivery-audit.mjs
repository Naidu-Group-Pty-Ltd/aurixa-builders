#!/usr/bin/env node
/**
 * ===========================================================================
 * EACH PROPERTY REACHES THE COMMAND CENTRE ONCE, IN ITS LATEST STATE — WHAT
 * ONE BUILDER'S DELIVERIES ACTUALLY DID, READ FROM BOTH DATABASES. READ-ONLY.
 * ===========================================================================
 *
 * Doc 70 (`20261001150000` and the wave worker) changed how a property event
 * leaves the network: an older WAITING copy of the same property is marked
 * `superseded`, and different properties are sent eight at a time. This reads
 * what happened to one builder organisation's property events since that
 * change went live, on the network AND on the Command Centre, because neither
 * database can see the other — and because the platform logs cannot settle
 * it: on the first measured run the Command Centre's function log held 36
 * arrivals, its gateway log 41 inserts, and the outbox 44 deliveries.
 *
 *   1. every `stock.item.upserted` event since SINCE, grouped by the
 *      transaction that queued it (one `created_at`): queued, superseded,
 *      delivered, retried, and how long the first and last arrival took;
 *   2. per property: the newest event is the one that went, every older copy
 *      that waited was superseded, and nothing superseded was ever sent;
 *   3. on the Command Centre: one receipt per delivered event and none for a
 *      superseded one, the waves they arrived in, and whether a retried
 *      event's first attempt had in fact landed;
 *   4. the mirror holds every live property at the version that was sent
 *      last, and nothing live for this organisation that the network does
 *      not hold live;
 *   5. no other event type was ever superseded, nothing waits or is claimed
 *      now, nothing went dead, the deliveries wrote no property row, and no
 *      other organisation was touched;
 *   6. the live database's own definitions: every SQL function that names a
 *      property event or writes the outbox, and the triggers that call them —
 *      the deployed truth beside the repository's static guard.
 *
 * WRITES NOTHING: every statement is a SELECT, and anything else is refused
 * below rather than trusted to the call sites. PRINTS NO VALUE: a property is
 * the first eight characters of its id; prices, addresses and payloads are
 * never read (this repository and its Actions logs are public).
 *
 * Runs from the production-rollout workflow (phase `stock-delivery-audit`)
 * with `organisation_id` set to the builder organisation. SINCE defaults to
 * the start of the deploy that carried `20261001150000` (run 36905251583,
 * 1 October 2026 18:13:39 UTC); AUDIT_SINCE overrides it.
 */
import { record, finish, net, cc, id, sqlLit, UUID } from './tier0/common.mjs';

const ORG = String(process.env.TARGET_ORGANISATION_ID || '').trim();
if (!UUID.test(ORG)) {
  console.error('organisation_id must name the builder organisation to audit (a uuid)');
  process.exit(2);
}
const SINCE = String(process.env.AUDIT_SINCE || '2026-10-01T18:13:39Z').trim();
if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(SINCE)) {
  console.error('AUDIT_SINCE must be an ISO instant in UTC, e.g. 2026-10-01T18:13:39Z');
  process.exit(2);
}
const SINCE_SQL = `${sqlLit(SINCE)}::timestamptz`;
/** A gap this long between two arrivals starts a new wave (a wave's sends leave together). */
const WAVE_GAP_MS = 900;
/** A retried event whose receipt is this much older than its delivery had landed the first time. */
const LANDED_EARLY_MS = 10_000;

const selectOnly = (run) => (label, text) => {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error(`[${label}] refused: this phase runs SELECT statements only`);
  return run(label, text);
};
const readNetwork = selectOnly(net);
const readMirror = selectOnly(cc);

const short = (value) => String(value ?? '').slice(0, 8);
const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const iso = (msValue) => (Number.isFinite(msValue) ? new Date(msValue).toISOString() : '—');
const sec = (msValue) => (Number.isFinite(msValue) ? `${(msValue / 1000).toFixed(1)} s` : '—');
const list = (rows, limit = 12) => (rows.length > limit
  ? `${rows.slice(0, limit).join(', ')} … and ${rows.length - limit} more`
  : rows.join(', '));
const inList = (values) => values.map((value) => sqlLit(value)).join(', ');
const histogram = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}×${v}`).join(', ');
};

try {
  console.log(`Property delivery audit — organisation ${short(ORG)}… — since ${SINCE} — ${new Date().toISOString()}`);
  console.log('READ-ONLY. Nothing below enqueues, delivers, applies or changes anything.');

  // -------------------------------------------------------------------------
  // The organisation, its connections and its properties, now.
  // -------------------------------------------------------------------------
  const connections = await readNetwork('connections', `
    SELECT c.id::text AS id, c.state FROM public.workspace_connections c
     WHERE c.builder_organisation_id = ${id(ORG)} ORDER BY c.created_at`);
  const items = await readNetwork('items', `
    SELECT i.id::text AS id, i.lifecycle_status,
           (extract(epoch FROM i.updated_at) * 1000)::bigint AS updated_ms
      FROM public.builder_stock_items i WHERE i.organisation_id = ${id(ORG)}`);
  const live = items.filter((row) => row.lifecycle_status === 'active');
  const liveIds = new Set(live.map((row) => row.id));
  const byLifecycle = histogramOf(items.map((row) => row.lifecycle_status));
  console.log(`\nnetwork: ${items.length} properties (${byLifecycle}); `
    + `connections serving it: ${connections.map((c) => `${short(c.id)} ${c.state}`).join(', ') || 'none'}`);
  record('the organisation has live properties and a connection to deliver them on',
    live.length > 0 && connections.some((c) => c.state === 'active'),
    `${live.length} live, ${connections.filter((c) => c.state === 'active').length} active connection(s)`);
  const connectionIds = connections.map((c) => c.id);
  if (!connectionIds.length) throw new Error('no connection serves this organisation: nothing was delivered for it');
  const connectionSql = connectionIds.map((value) => id(value)).join(', ');

  // -------------------------------------------------------------------------
  // 1. Every property event since SINCE on those connections.
  // -------------------------------------------------------------------------
  const events = (await readNetwork('outbox window', `
    SELECT o.connection_id::text AS connection_id, o.event_type, o.dedupe_key,
           o.payload->>'id' AS item_id, o.source_version::bigint AS version, o.status, o.attempts,
           (extract(epoch FROM o.created_at) * 1000)::bigint AS created_ms,
           (extract(epoch FROM o.created_at) * 1000000)::bigint AS created_us,
           (extract(epoch FROM o.delivered_at) * 1000)::bigint AS delivered_ms,
           (extract(epoch FROM o.available_at) * 1000)::bigint AS available_ms,
           o.locked_by IS NOT NULL AS locked,
           left(coalesce(o.last_error, ''), 60) AS last_error
      FROM public.builder_network_outbox o
     WHERE o.connection_id IN (${connectionSql}) AND o.created_at >= ${SINCE_SQL}
     ORDER BY o.created_at, o.source_version`))
    .map((row) => ({
      ...row,
      version: num(row.version), attempts: num(row.attempts), created_ms: num(row.created_ms),
      delivered_ms: num(row.delivered_ms), available_ms: num(row.available_ms),
    }));
  const propertyEvents = events.filter((row) => row.event_type === 'stock.item.upserted');
  const otherEvents = events.filter((row) => row.event_type !== 'stock.item.upserted');
  console.log(`\noutbox since ${SINCE}: ${events.length} event(s) on this organisation's connection(s) — `
    + `${propertyEvents.length} property, ${otherEvents.length} other `
    + `(${histogramOf(otherEvents.map((row) => row.event_type)) || 'none'})`);

  // Batches: the events one transaction queued share its `created_at` exactly.
  const batches = new Map();
  for (const row of propertyEvents) {
    const key = String(row.created_us);
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(row);
  }

  // -------------------------------------------------------------------------
  // 3 (read first). The Command Centre's receipt of every one of them.
  // -------------------------------------------------------------------------
  const receipts = new Map();
  for (let start = 0; start < propertyEvents.length; start += 200) {
    const keys = propertyEvents.slice(start, start + 200).map((row) => row.dedupe_key);
    const rows = await readMirror('receipts', `
      SELECT e.dedupe_key, e.source_version::bigint AS version,
             (extract(epoch FROM e.received_at) * 1000)::bigint AS received_ms,
             (extract(epoch FROM e.processed_at) * 1000)::bigint AS processed_ms
        FROM public.builder_network_inbound_events e
       WHERE e.dedupe_key IN (${inList(keys)})`);
    for (const row of rows) {
      receipts.set(row.dedupe_key, {
        version: num(row.version), received_ms: num(row.received_ms), processed_ms: num(row.processed_ms),
      });
    }
  }

  console.log('\n--- batches: one row per transaction that queued property events ---');
  const batchTable = [];
  for (const [, rows] of [...batches.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const createdMs = rows[0].created_ms;
    const delivered = rows.filter((row) => row.status === 'delivered');
    const got = delivered.map((row) => receipts.get(row.dedupe_key)).filter(Boolean);
    const received = got.map((row) => row.received_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const applied = got.map((row) => row.processed_ms).filter(Number.isFinite);
    const deliveredAt = delivered.map((row) => row.delivered_ms).filter(Number.isFinite).sort((a, b) => a - b);
    batchTable.push({
      queued_at: iso(createdMs),
      events: rows.length,
      properties: new Set(rows.map((row) => row.item_id)).size,
      superseded: rows.filter((row) => row.status === 'superseded').length,
      delivered: delivered.length,
      pending: rows.filter((row) => row.status === 'pending').length,
      dead: rows.filter((row) => row.status === 'dead').length,
      attempts: histogram(delivered.map((row) => row.attempts)),
      first_arrival: received.length ? sec(received[0] - createdMs) : '—',
      last_arrival: received.length ? sec(received[received.length - 1] - createdMs) : '—',
      last_applied: applied.length ? sec(Math.max(...applied) - createdMs) : '—',
      last_marked_delivered: deliveredAt.length ? sec(deliveredAt[deliveredAt.length - 1] - createdMs) : '—',
    });
  }
  if (batchTable.length) console.table(batchTable); else console.log('  (no property events since SINCE)');

  // -------------------------------------------------------------------------
  // 2. Per property: the newest went, older waiting copies were superseded.
  // -------------------------------------------------------------------------
  const byItem = new Map();
  for (const row of propertyEvents) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
    byItem.get(row.item_id).push(row);
  }
  const newestNotDelivered = [];
  const olderStillWaiting = [];
  const supersededSent = [];
  for (const [item, rows] of byItem) {
    rows.sort((a, b) => a.version - b.version);
    const newest = rows[rows.length - 1];
    if (newest.status !== 'delivered') newestNotDelivered.push(`${short(item)} v${newest.version} ${newest.status}`);
    for (const older of rows.slice(0, -1)) {
      if (!['superseded', 'delivered'].includes(older.status)) olderStillWaiting.push(`${short(item)} v${older.version} ${older.status}`);
    }
    for (const row of rows.filter((r) => r.status === 'superseded')) {
      if (row.delivered_ms || row.attempts > 0 || receipts.has(row.dedupe_key)) supersededSent.push(`${short(item)} v${row.version}`);
    }
  }
  const superseded = propertyEvents.filter((row) => row.status === 'superseded');
  const supersededByNewer = superseded.filter((row) =>
    (byItem.get(row.item_id) ?? []).some((other) => other.version > row.version && other.connection_id === row.connection_id));
  record('every superseded event has a newer event for the same property on the same connection',
    supersededByNewer.length === superseded.length, `${supersededByNewer.length} of ${superseded.length}`);
  record('for every property, its newest event is the one delivered', newestNotDelivered.length === 0,
    newestNotDelivered.length ? list(newestNotDelivered) : `${byItem.size} properties`);
  record('no older copy is still waiting, claimed or dead', olderStillWaiting.length === 0,
    olderStillWaiting.length ? list(olderStillWaiting) : 'none');
  record('nothing superseded was ever claimed, sent or received', supersededSent.length === 0,
    supersededSent.length ? list(supersededSent) : `${superseded.length} superseded, 0 attempts, 0 receipts`);

  // -------------------------------------------------------------------------
  // 3. The Command Centre's receipts, waves and retries.
  // -------------------------------------------------------------------------
  const delivered = propertyEvents.filter((row) => row.status === 'delivered');
  const missingReceipt = delivered.filter((row) => !receipts.has(row.dedupe_key));
  record('the Command Centre holds one receipt for every delivered event', missingReceipt.length === 0,
    missingReceipt.length ? `no receipt: ${list(missingReceipt.map((row) => `${short(row.item_id)} v${row.version}`))}`
      : `${delivered.length} of ${delivered.length}`);
  const unapplied = delivered.filter((row) => receipts.has(row.dedupe_key) && !Number.isFinite(receipts.get(row.dedupe_key).processed_ms));
  record('every receipt has been applied', unapplied.length === 0,
    unapplied.length ? list(unapplied.map((row) => short(row.item_id))) : `${delivered.length - missingReceipt.length} applied`);

  for (const [, rows] of [...batches.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const createdMs = rows[0].created_ms;
    const arrivals = rows.filter((row) => row.status === 'delivered')
      .map((row) => ({ row, receipt: receipts.get(row.dedupe_key) }))
      .filter((entry) => entry.receipt && Number.isFinite(entry.receipt.received_ms))
      .sort((a, b) => a.receipt.received_ms - b.receipt.received_ms);
    if (!arrivals.length) continue;
    const waves = [];
    for (const entry of arrivals) {
      const last = waves[waves.length - 1];
      if (!last || entry.receipt.received_ms - last.lastMs > WAVE_GAP_MS) {
        waves.push({ startMs: entry.receipt.received_ms, lastMs: entry.receipt.received_ms, size: 1 });
      } else {
        last.lastMs = entry.receipt.received_ms;
        last.size += 1;
      }
    }
    console.log(`\n--- arrivals of the batch queued ${iso(createdMs)}: ${arrivals.length} receipt(s) in ${waves.length} wave(s) ---`);
    console.table(waves.map((wave, index) => ({
      wave: index + 1,
      receipts: wave.size,
      from: sec(wave.startMs - createdMs),
      to: sec(wave.lastMs - createdMs),
    })));
    // A serial sender spaces two receipts by a whole request (1.6 s at the
    // fastest, measured), so receipts closer than WAVE_GAP_MS left together.
    const widest = Math.max(...waves.map((wave) => wave.size));
    if (arrivals.length > 1) {
      record(`batch ${iso(createdMs)}: different properties arrived concurrently, never more than 8 at once`,
        widest > 1 && widest <= 8, `largest wave ${widest}, waves ${waves.map((wave) => wave.size).join('+')}`);
    }

    const retried = arrivals.filter((entry) => entry.row.attempts > 1);
    if (retried.length) {
      const landedEarly = retried.filter((entry) =>
        Number.isFinite(entry.row.delivered_ms) && entry.row.delivered_ms - entry.receipt.received_ms > LANDED_EARLY_MS);
      console.log(`  retried: ${retried.length} event(s) took more than one attempt — `
        + `${landedEarly.length} had already LANDED on the first attempt (the door answered the retry as a duplicate), `
        + `${retried.length - landedEarly.length} landed only on a retry`);
      console.table(retried.map((entry) => ({
        property: short(entry.row.item_id),
        version: entry.row.version,
        attempts: entry.row.attempts,
        received: sec(entry.receipt.received_ms - createdMs),
        marked_delivered: sec(entry.row.delivered_ms - createdMs),
        first_attempt_landed: entry.row.delivered_ms - entry.receipt.received_ms > LANDED_EARLY_MS,
      })));
    }
  }

  // -------------------------------------------------------------------------
  // 4. The mirror holds every live property at the version sent last.
  // -------------------------------------------------------------------------
  const newestDelivered = await readNetwork('newest delivered', `
    SELECT o.payload->>'id' AS item_id, max(o.source_version)::bigint AS version
      FROM public.builder_network_outbox o
     WHERE o.connection_id IN (${connectionSql}) AND o.event_type = 'stock.item.upserted'
       AND o.status = 'delivered'
     GROUP BY 1`);
  const newestByItem = new Map(newestDelivered.map((row) => [row.item_id, num(row.version)]));
  const mirror = (await readMirror('mirror', `
    SELECT i.id::text AS id, i.lifecycle_status, i.source_version::bigint AS version,
           (extract(epoch FROM i.updated_at) * 1000)::bigint AS updated_ms
      FROM public.builder_network_stock_items i WHERE i.organisation_id = ${id(ORG)}`))
    .map((row) => ({ ...row, version: num(row.version) }));
  const mirrorById = new Map(mirror.map((row) => [row.id, row]));
  const mirrorLive = mirror.filter((row) => row.lifecycle_status === 'active');
  console.log(`\nCommand Centre mirror: ${mirror.length} rows for this organisation `
    + `(${histogramOf(mirror.map((row) => row.lifecycle_status))})`);
  const notLive = live.filter((row) => mirrorById.get(row.id)?.lifecycle_status !== 'active');
  record('every live property is live in the Command Centre', notLive.length === 0,
    notLive.length ? list(notLive.map((row) => short(row.id))) : `${live.length} of ${live.length}`);
  const extraLive = mirrorLive.filter((row) => !liveIds.has(row.id));
  record('nothing is live in the Command Centre for this organisation that the network does not hold live',
    extraLive.length === 0, extraLive.length ? list(extraLive.map((row) => short(row.id))) : `${mirrorLive.length} live there`);
  const behind = [];
  const ahead = [];
  for (const row of live) {
    const want = newestByItem.get(row.id);
    const have = mirrorById.get(row.id)?.version ?? null;
    if (want === undefined) { behind.push(`${short(row.id)} never delivered`); continue; }
    if (have === null || have < want) behind.push(`${short(row.id)} holds v${have} of v${want}`);
    else if (have > want) ahead.push(`${short(row.id)} holds v${have}, newest delivered v${want}`);
  }
  record('every live property is held at the newest version delivered for it (latest source_version won)',
    behind.length === 0 && ahead.length === 0,
    behind.length || ahead.length ? list([...behind, ...ahead]) : `${live.length} of ${live.length}`);

  // -------------------------------------------------------------------------
  // 5. Invariants across the whole outbox, and integrity.
  // -------------------------------------------------------------------------
  const [invariants] = await readNetwork('invariants', `
    SELECT count(*) FILTER (WHERE status = 'superseded')                                   AS superseded_total,
           count(*) FILTER (WHERE status = 'superseded' AND event_type <> 'stock.item.upserted') AS superseded_other_types,
           count(*) FILTER (WHERE status = 'superseded' AND delivered_at IS NOT NULL)          AS superseded_delivered,
           count(*) FILTER (WHERE status = 'superseded' AND locked_by IS NOT NULL)             AS superseded_holding_a_claim,
           count(*) FILTER (WHERE status = 'pending')                                          AS pending_now,
           count(*) FILTER (WHERE status = 'pending' AND locked_by IS NOT NULL)                AS claimed_now,
           count(*) FILTER (WHERE status = 'dead' AND created_at >= ${SINCE_SQL})                AS dead_since
      FROM public.builder_network_outbox`);
  console.log('\nwhole outbox, every connection:');
  console.table([invariants]);
  record('no event other than stock.item.upserted has ever been superseded',
    Number(invariants.superseded_other_types) === 0, `${invariants.superseded_other_types}`);
  record('no superseded event was ever delivered or superseded while claimed',
    Number(invariants.superseded_delivered) === 0 && Number(invariants.superseded_holding_a_claim) === 0,
    `${invariants.superseded_delivered} delivered, ${invariants.superseded_holding_a_claim} holding a claim`);
  record('nothing is waiting or claimed now, and nothing went dead', Number(invariants.pending_now) === 0
    && Number(invariants.claimed_now) === 0 && Number(invariants.dead_since) === 0,
    `${invariants.pending_now} pending, ${invariants.claimed_now} claimed, ${invariants.dead_since} dead since ${SINCE}`);

  const writtenSince = live.filter((row) => Number(row.updated_ms) >= Date.parse(SINCE));
  record('no live property row was written since SINCE (a delivery writes no property)', writtenSince.length === 0,
    writtenSince.length ? list(writtenSince.map((row) => short(row.id))) : `${live.length} live, newest write ${iso(Math.max(...live.map((row) => Number(row.updated_ms))))}`);

  const [elsewhere] = await readNetwork('other connections', `
    SELECT count(*) AS events FROM public.builder_network_outbox
     WHERE created_at >= ${SINCE_SQL} AND connection_id NOT IN (${connectionSql})`);
  const [otherMirror] = await readMirror('other organisations', `
    SELECT count(*) AS rows, count(*) FILTER (WHERE updated_at >= ${SINCE_SQL}) AS written_since
      FROM public.builder_network_stock_items WHERE organisation_id <> ${id(ORG)}`);
  console.log(`\nother connections: ${elsewhere.events} event(s) since SINCE; other organisations in the mirror: `
    + `${otherMirror.rows} row(s), ${otherMirror.written_since} written since SINCE`);
  if (Number(elsewhere.events) === 0) {
    record('no other organisation\'s mirror rows were written since SINCE', Number(otherMirror.written_since) === 0,
      `${otherMirror.written_since} of ${otherMirror.rows}`);
  }
  const [backlog] = await readMirror('inbound backlog', `
    SELECT count(*) FILTER (WHERE processed_at IS NULL) AS unapplied,
           count(*) FILTER (WHERE received_at >= ${SINCE_SQL}) AS received_since
      FROM public.builder_network_inbound_events`);
  record('the Command Centre has no unapplied receipt waiting', Number(backlog.unapplied) === 0,
    `${backlog.unapplied} unapplied; ${backlog.received_since} received since SINCE`);

  // The worker's own answers, where pg_net still retains them.
  const answers = await readNetwork('worker answers', `
    SELECT r.status_code, r.created, left(coalesce(r.content, ''), 120) AS content
      FROM net._http_response r
     WHERE r.created >= ${SINCE_SQL} AND r.content LIKE '%"claimed"%' AND r.content NOT LIKE '%"claimed":0,%'
     ORDER BY r.created LIMIT 60`).catch((error) => {
    console.log(`  worker answers could not be read: ${String(error?.message ?? error).slice(0, 160)}`);
    return [];
  });
  console.log(`\nworker invocations that claimed work, as pg_net retained them: ${answers.length}`);
  if (answers.length) console.table(answers);

  // -------------------------------------------------------------------------
  // 6. The deployed definitions: who writes a property event, and how.
  // -------------------------------------------------------------------------
  const routes = await readNetwork('routes', `
    WITH defs AS (
      SELECT p.proname, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
    )
    SELECT proname AS function_name,
           position('''stock.item.upserted''' in def) > 0                         AS names_property_event,
           def ~* 'insert\\s+into\\s+(public\\.)?builder_network_outbox'           AS writes_outbox,
           proname <> 'builder_network_enqueue_stock_item'
             AND def ~ 'builder_network_enqueue_stock_item\\s*\\('                 AS calls_enqueue,
           position('SET status = ''superseded''' in def) > 0                      AS supersedes,
           position('o.locked_at IS NULL OR o.locked_at < now() - interval ''10 minutes''' in def) > 0
                                                                                  AS spares_a_claim,
           position('o.event_type = ''stock.item.upserted''' in def) > 0           AS only_property_events
      FROM defs
     WHERE def ~ 'builder_network_enqueue_stock_item' OR def ~* 'builder_network_outbox'
     ORDER BY 1`);
  console.log('\n--- deployed SQL functions that write the outbox or call the property enqueue ---');
  console.table(routes);
  const writers = routes.filter((row) => row.names_property_event && row.writes_outbox);
  record('exactly one deployed function writes a property event into the outbox: the enqueue',
    writers.length === 1 && writers[0].function_name === 'builder_network_enqueue_stock_item',
    writers.map((row) => row.function_name).join(', ') || 'none');
  const enqueue = routes.find((row) => row.function_name === 'builder_network_enqueue_stock_item');
  record('the deployed enqueue supersedes only waiting property events and spares a claimed one',
    !!enqueue?.supersedes && !!enqueue?.spares_a_claim && !!enqueue?.only_property_events,
    enqueue ? `supersedes ${enqueue.supersedes}, spares a claim ${enqueue.spares_a_claim}, only property events ${enqueue.only_property_events}` : 'not found');
  const callers = routes.filter((row) => row.calls_enqueue).map((row) => row.function_name);
  const triggers = callers.length ? await readNetwork('triggers', `
    SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled, p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.proname IN (${inList(callers)})
     ORDER BY 1, 2`) : [];
  console.log(`\nfunctions that queue a property through the enqueue: ${callers.join(', ') || 'none'}`);
  if (triggers.length) console.table(triggers);
  const cron = await readNetwork('cron', `
    SELECT jobname, schedule, active FROM cron.job
     WHERE command ~ 'builder_network|builder-network' ORDER BY jobname`).catch(() => []);
  if (cron.length) { console.log('\ncron jobs on the network path:'); console.table(cron); }
} catch (error) {
  record('the audit completed', false, String(error?.message ?? error).slice(0, 300));
}

function histogramOf(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
}

finish('stock-delivery-audit');
