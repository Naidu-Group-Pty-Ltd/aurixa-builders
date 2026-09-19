/**
 * POINT A LIVE CONNECTION AT THE BUILDER WHOSE STOCK IT IS SUPPOSED TO CARRY.
 *
 * WHAT WENT WRONG, MEASURED 19 Sep 2026 BY `network-sync-state`. The whole
 * transport was healthy — 91 of 91 events delivered on the first attempt,
 * nothing pending, nothing dead, all three producer triggers enabled, the
 * composer current, the HMAC secret present and the clone's inbound URL
 * correct — and the clone's marketplace still drew no cards, because the ONE
 * `workspace_connections` row serves organisation `00f9e45f` (Bob The
 * Builder, 0 active items) while all 46 live properties belong to `dfdbff19`
 * (Mairandi Developers, created 2026-09-18 08:53:46, stock 09:26:06-09:26:19).
 *
 * `builder_network_enqueue_stock_item` reaches a connection only through
 *   JOIN workspace_connections c ON i.organisation_id = c.builder_organisation_id
 * so for every one of those items the join is empty: the trigger fires, the
 * payload composes, and nothing is inserted. Zero events, zero errors, zero
 * operational rows — an event that is never composed is indistinguishable
 * from a builder who changed nothing, which is why this ran for a day with
 * nothing anywhere reporting it.
 *
 * WHY RE-POINT RATHER THAN ADD. `workspace_connections_live_key` is unique on
 * (workspace_id, builder_organisation_id) WHERE state <> 'revoked', so a
 * workspace may legitimately hold one live connection per builder, and a
 * second builder WILL need a second connection. That act needs a secret:
 * acceptance mints it, `provision_transport` hands it back exactly once, and
 * Mission Control is meant to install it clone-side — a catcher this platform
 * has never written. Minting and hand-carrying an HMAC secret between two
 * databases through an operator's console and a CI log is a worse thing to do
 * than re-pointing a mapping, so this changes one column and moves no
 * credential. It is reversible by its own inverse.
 *
 * THE ORDER IS LOAD-BEARING AND IS ENFORCED HERE, NOT REMEMBERED. The clone's
 * `builder_network_apply_inbound_events` refuses a payload whose
 * organisation_id does not equal ITS connection's, as `organisation_mismatch`
 * at severity critical — and a refusal CONSUMES the event (processed_at set),
 * so it is never retried. Re-pointing this side first would therefore burn
 * the entire backfill against a clone that still disagrees. So the clone is
 * read first and this refuses unless it ALREADY names the target
 * organisation; a clone that cannot be read is a refusal too, because a check
 * that could not be made is not a check that passed.
 *
 * DRY RUN unless `--apply`. Idempotent: a connection already pointing at the
 * target is reported and left alone, and the backfill's own inserts are
 * ON CONFLICT (dedupe_key) DO NOTHING.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/network-connection-remap.ts [--apply]
 * Needs:  SUPABASE_ACCESS_TOKEN, TARGET_ORGANISATION_ID.
 *         Optionally CONNECTION_ID, PROJECT_REF, CLONE_PROJECT_REF.
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const CLONE_REF = Deno.env.get('CLONE_PROJECT_REF') || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read or written.');
  Deno.exit(1);
}
const APPLY = Deno.args.includes('--apply') || (Deno.env.get('APPLY') || '') === 'true';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids are CHECKED, never quoted and hoped for — the same rule the Airtable
 * broker answers to. Thirty-six characters of hex and hyphen can hold no
 * quote, comma or operator, so a composed predicate cannot become a second
 * statement however the value arrived (and these arrive from a dispatch box a
 * person types into).
 */
function checkedId(label: string, raw: string | undefined): string {
  const value = (raw || '').trim();
  if (!UUID.test(value)) {
    console.error(`${label} must be a uuid; got ${safeDetail(value || '(empty)', 60)}`);
    Deno.exit(1);
  }
  return value.toLowerCase();
}

const TARGET_ORG = checkedId('TARGET_ORGANISATION_ID', Deno.env.get('TARGET_ORGANISATION_ID'));
const NAMED_CONNECTION = (Deno.env.get('CONNECTION_ID') || '').trim();
const CONNECTION = NAMED_CONNECTION ? checkedId('CONNECTION_ID', NAMED_CONNECTION) : '';

async function query(ref: string, label: string, text: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${ref} ${response.status}: ${safeDetail(body, 400)}`);
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}
const sql = (label: string, text: string) => query(PROJECT_REF, label, text);
const refuse = (why: string): never => {
  console.error(`\nREFUSED: ${why}`);
  Deno.exit(1);
};

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — connection re-point on ${PROJECT_REF}`);
console.log(`target organisation ${TARGET_ORG}; clone read from ${CLONE_REF}\n`);

// --------------------------------------------------------------------------
// 1. THE CONNECTION. Named, or the only live one — never "the first of
//    several", because picking one of two silently is how the wrong link
//    gets moved.
// --------------------------------------------------------------------------
const connections = await sql('connections', `
  select id::text as id, state,
         builder_organisation_id::text as organisation_id,
         workspace_id::text            as workspace_id,
         (outbound_hmac_secret is not null) as has_secret,
         (inbound_url like '%/builder-network-inbound') as url_shape_ok
    from public.workspace_connections
   where state <> 'revoked'
     ${CONNECTION ? `and id = '${CONNECTION}'::uuid` : ''}
   order by created_at`);
if (!connections.length) refuse('no live connection to re-point.');
if (connections.length > 1) {
  console.log(connections);
  refuse(`${connections.length} live connections; name one with CONNECTION_ID.`);
}
const connection = connections[0];
console.log(`connection ${connection.id}`);
console.log(`  state=${connection.state} organisation=${connection.organisation_id}`);
console.log(`  secret=${connection.has_secret} inbound_url_shape_ok=${connection.url_shape_ok}`);
if (connection.state !== 'active') refuse(`connection is ${connection.state}, not active.`);
if (!connection.has_secret || !connection.url_shape_ok) {
  refuse('connection has no usable transport; re-pointing it would deliver nothing.');
}

// --------------------------------------------------------------------------
// 2. THE TARGET. It must exist, and it must have live stock — re-pointing at
//    an organisation with nothing active sends the clone a reconcile naming
//    an empty catalogue, which is how you empty a marketplace by hand.
// --------------------------------------------------------------------------
const target = await sql('target', `
  select o.id::text as id,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 60) as builder,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = o.id and i.lifecycle_status = 'active') as active_items
    from public.builder_organisations o
   where o.id = '${TARGET_ORG}'::uuid`);
if (!target.length) refuse('the target organisation does not exist on this network.');
const activeItems = Number(target[0].active_items ?? 0);
console.log(`\ntarget ${target[0].id} — ${target[0].builder} — ${activeItems} active item(s)`);
if (activeItems < 1) refuse('the target organisation holds no active stock.');

if (connection.organisation_id === TARGET_ORG) {
  console.log('\nAlready pointing there. Nothing to re-point; the backfill below still applies.');
}

// The live-key uniqueness, asked rather than assumed.
const clash = await sql('clash', `
  select id::text as id, state from public.workspace_connections
   where workspace_id = '${connection.workspace_id}'::uuid
     and builder_organisation_id = '${TARGET_ORG}'::uuid
     and state <> 'revoked' and id <> '${connection.id}'::uuid`);
if (clash.length) {
  console.log(clash);
  refuse('another live connection already serves that organisation for this workspace.');
}

// --------------------------------------------------------------------------
// 3. THE CLONE MUST ALREADY AGREE. See the header: a mismatch is consumed,
//    not retried, so going first here burns the whole backfill.
// --------------------------------------------------------------------------
let cloneRows: Array<Record<string, unknown>>;
try {
  cloneRows = await query(CLONE_REF, 'clone', `
    select id::text as id, state,
           network_connection_id::text   as network_connection_id,
           builder_organisation_id::text as organisation_id
      from public.builder_network_connections
     where network_connection_id = '${connection.id}'::uuid`);
} catch (error) {
  refuse(`the clone could not be read (${error instanceof Error ? error.message : String(error)}). `
    + 'A check that could not be made is not a check that passed.');
}
if (!cloneRows!.length) refuse(`the clone holds no connection row for ${connection.id}.`);
const cloneRow = cloneRows![0];
console.log(`\nclone connection ${cloneRow.id} state=${cloneRow.state} organisation=${cloneRow.organisation_id}`);
if (cloneRow.state !== 'active') refuse(`the clone's connection is ${cloneRow.state}, not active.`);
if (String(cloneRow.organisation_id) !== TARGET_ORG) {
  refuse('the clone still names a different organisation. Re-point the CLONE first — '
    + 'every event this side composes would be refused as organisation_mismatch and consumed.');
}
console.log('The clone already names the target. Safe to proceed.');

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to re-point and backfill.');
  Deno.exit(0);
}

// --------------------------------------------------------------------------
// 4. THE RE-POINT — one column, guarded by the value it is replacing, so a
//    row somebody else moved in the meantime is not overwritten.
// --------------------------------------------------------------------------
if (connection.organisation_id !== TARGET_ORG) {
  const moved = await sql('remap', `
    update public.workspace_connections
       set builder_organisation_id = '${TARGET_ORG}'::uuid,
           updated_at = now()
     where id = '${connection.id}'::uuid
       and state = 'active'
       and builder_organisation_id = '${connection.organisation_id}'::uuid
    returning id::text as id, builder_organisation_id::text as organisation_id`);
  if (!moved.length) refuse('the connection was not re-pointed — it changed underneath this run.');
  console.log(`\nre-pointed: ${JSON.stringify(moved[0])}`);

  // The act, recorded where acts on a connection are recorded. `event_type`
  // is free text here; `actor_side` is not, and 'platform' is what an
  // operator act through this door is.
  await sql('event', `
    insert into public.workspace_connection_events(connection_id, event_type, actor_side, detail)
    values ('${connection.id}'::uuid, 'organisation_remapped', 'platform',
            jsonb_build_object(
              'from', '${connection.organisation_id}',
              'to',   '${TARGET_ORG}',
              'reason', 'the connection served an organisation with no live stock while the live catalogue had no route',
              'applied_by', 'scripts/ops/network-connection-remap.ts'))
    returning id::text as id`);
}

// --------------------------------------------------------------------------
// 5. THE BACKFILL. Items first, then the catalogue reconcile — the function's
//    own order, so the reconcile's id set is the one the upserts just sent.
// --------------------------------------------------------------------------
const before = await sql('outbox-before', `
  select count(*) as events from public.builder_network_outbox
   where connection_id = '${connection.id}'::uuid`);
const backfilled = await sql('backfill', `
  select public.builder_network_backfill_stock_sync('${connection.id}'::uuid) as enqueued`);
console.log(`\nbackfill enqueued ${backfilled[0]?.enqueued ?? 0} event(s).`);

// --------------------------------------------------------------------------
// 6. ASSERTED BY EFFECT, never by what was sent. The same rule the retention
//    purge and the verification self-test answer to.
// --------------------------------------------------------------------------
const after = await sql('verify', `
  select (select builder_organisation_id::text from public.workspace_connections
           where id = '${connection.id}'::uuid)                                   as now_serving,
         (select count(*) from public.builder_network_outbox
           where connection_id = '${connection.id}'::uuid)                        as outbox_rows,
         (select count(*) from public.builder_network_outbox
           where connection_id = '${connection.id}'::uuid and status = 'pending') as pending,
         (select count(*) from public.builder_network_outbox
           where connection_id = '${connection.id}'::uuid and status = 'dead')    as dead,
         (select count(*) from public.builder_stock_items
           where organisation_id = '${TARGET_ORG}'::uuid
             and lifecycle_status = 'active')                                     as active_items`);
const state = after[0] ?? {};
console.log(`\nafter: ${JSON.stringify(state)}`);
console.log(`(outbox rows for this connection: ${before[0]?.events ?? 0} before, ${state.outbox_rows} after)`);

if (String(state.now_serving) !== TARGET_ORG) {
  console.error('\nThe connection is not serving the target organisation. Investigate before re-running.');
  Deno.exit(1);
}
if (Number(state.dead ?? 0) > 0) {
  console.error('\nThere are dead events on this connection. Read them before concluding anything.');
  Deno.exit(1);
}
console.log('\nRe-pointed and backfilled. The outbox worker delivers on its own minute;'
  + ' measure the clone with builder-stock-mirror-state rather than assuming.');
