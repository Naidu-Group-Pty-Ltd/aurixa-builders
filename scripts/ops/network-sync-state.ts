/**
 * WHY THE CLONE'S MIRROR STOPPED MOVING — THE NETWORK'S HALF. Read-only.
 *
 * WHAT IT IS FOR. `npc-property-dashbord`'s Builder Stock mirror holds 1,019
 * rows, every one `archived`, none touched since 18 Sep 2026 01:31, so its
 * marketplace draws nothing. A stopped mirror can be caused at either end and
 * neither database can see the other, so this prints THIS end of the chain in
 * the order an event travels it — trigger, composer, outbox, claim, HMAC,
 * delivery — beside `.github/scripts/builder-network-sync-state.mjs` on the
 * clone, which prints the other.
 *
 * WHAT MAKES EACH STEP WORTH ASKING ABOUT, rather than assumed:
 *
 *  * a DISABLED trigger still exists and composes nothing, and the enqueue is
 *    the only thing that ever writes the outbox;
 *  * `builder_network_enqueue_stock_item` enqueues onto connections that are
 *    `active` AND whose `builder_organisation_id` matches the item's — so a
 *    re-imported catalogue under a second organisation produces no events at
 *    all, silently;
 *  * the worker authenticates on the signed internal envelope, and this
 *    platform has already had one outage (17,174 refused invocations) caused
 *    by that secret diverging, which reports as a queue that simply stops;
 *  * pg_cron reports on the SQL that QUEUED the HTTP call, never on the call,
 *    so `net._http_response` is asked for separately and is the honest signal;
 *  * a connection with no `inbound_url` is RELEASED with backoff rather than
 *    dead, by design — which looks identical to a healthy idle queue.
 *
 * WRITES NOTHING, AND CANNOT. `sql()` refuses any statement that does not
 * begin with `select` or `with`, a property of this file rather than a promise
 * about how it is called. It does not enqueue, backfill, reconcile or deliver:
 * the broken step is established before anything changes, because a repair
 * applied first destroys the evidence that would have named it.
 *
 * NOTHING SENSITIVE IS PRINTED. An HMAC secret is reported as present or
 * absent and never echoed; a URL is reported as its origin and path.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/network-sync-state.ts
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

/** SELECT only. The label is logged; the statement never is. */
async function sql(label: string, text: string): Promise<Record<string, unknown>[]> {
  if (!/^\s*(select|with)\b/i.test(text)) {
    throw new Error(`[${label}] refused: this script runs SELECT statements only.`);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
}

/**
 * A SECTION THAT CANNOT BE READ SAYS SO AND THE TRACE CONTINUES. A missing
 * table or renamed column is itself a finding — this platform's own history
 * records a class of defect where a column that does not exist reads exactly
 * like a row that is absent — so one failing question must never cost the
 * other dozen answers.
 */
const unanswered: string[] = [];
async function section(title: string, text: string): Promise<Record<string, unknown>[] | null> {
  console.log(`\n${'='.repeat(92)}\n${title}\n${'='.repeat(92)}`);
  try {
    const rows = await sql(title, text);
    if (!rows.length) console.log('  (no rows)');
    else console.table(rows);
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  COULD NOT BE READ: ${message}`);
    unanswered.push(`${title}: ${message}`);
    return null;
  }
}

console.log(`Builder Network outbound trace — project ${PROJECT_REF} — ${new Date().toISOString()}`);
console.log('READ-ONLY. Nothing below enqueues, backfills, reconciles or delivers.');

// ---------------------------------------------------------------------------
// 1. WHAT THIS NETWORK HOLDS TODAY — the catalogue the clone should mirror.
// ---------------------------------------------------------------------------
await section('1. builder_stock_items — what the network holds', `
  select i.organisation_id,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 40) as builder,
         i.lifecycle_status,
         count(*)                as items,
         count(i.primary_image_id) as with_primary,
         min(i.created_at)       as first_created,
         max(i.created_at)       as last_created,
         max(i.updated_at)       as last_updated
  from public.builder_stock_items i
  left join public.builder_organisations o on o.id = i.organisation_id
  group by 1, 2, 3
  order by 4 desc
`);

// ---------------------------------------------------------------------------
// 2. THE CONNECTION THE EVENTS ARE ADDRESSED TO. `builder_organisation_id` is
//    the JOIN the enqueue makes: a connection mapped to a different
//    organisation than the live stock produces no events whatsoever.
// ---------------------------------------------------------------------------
const conn = await section('2. workspace_connections (every column but the secret)', `
  select jsonb_pretty(
           (to_jsonb(c) - 'outbound_hmac_secret' - 'inbound_hmac_secret')
           || jsonb_build_object(
                'has_outbound_hmac_secret',
                (c.outbound_hmac_secret is not null and length(c.outbound_hmac_secret) > 0),
                'inbound_url_origin',
                coalesce(substring(c.inbound_url from '^https?://[^/]+'), '(none)'),
                'inbound_url_path',
                coalesce(substring(c.inbound_url from '/functions/v1/[a-z0-9-]+$'), '(no path)'),
                'inbound_url_shape_ok',
                (c.inbound_url like '%/builder-network-inbound'))
         ) as connection
  from public.workspace_connections c
  order by c.created_at
`);
if (conn) for (const row of conn) console.log(row.connection);

// ---------------------------------------------------------------------------
// 3. DOES THE ENQUEUE EVEN REACH A CONNECTION? The enqueue's own join, asked
//    directly: for each live item, how many active connections would take it.
// ---------------------------------------------------------------------------
await section('3. the enqueue join — live items against active connections', `
  select c.id as connection_id, c.state, c.builder_organisation_id,
         count(i.id) filter (where i.lifecycle_status = 'active') as active_items_it_would_enqueue,
         count(i.id)                                              as all_items_in_that_org
  from public.workspace_connections c
  left join public.builder_stock_items i
         on i.organisation_id = c.builder_organisation_id
  group by 1, 2, 3
  order by 4 desc
`);

// ---------------------------------------------------------------------------
// 4. THE TRIGGERS. A disabled trigger is still a trigger; `tgenabled = 'D'`
//    is the one state in which nothing composes and nothing reports it.
// ---------------------------------------------------------------------------
await section('4. the three producer triggers, and whether they fire', `
  select c.relname   as table_name,
         t.tgname    as trigger_name,
         t.tgenabled as enabled_flag,
         case t.tgenabled
              when 'O' then 'fires (origin)'
              when 'D' then 'DISABLED — composes nothing'
              when 'R' then 'replica only'
              when 'A' then 'always'
              else t.tgenabled::text end as reading
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal
    and t.tgname like 'trg_builder_network%'
  order by 1, 2
`);

await section('4b. the composer — has the source_column change reached this database?', `
  select p.proname as function_name,
         position('source_column' in pg_get_functiondef(p.oid)) > 0 as composes_source_column,
         length(pg_get_functiondef(p.oid))                          as definition_bytes
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('builder_network_compose_stock_item_payload',
                      'builder_network_enqueue_stock_item',
                      'builder_network_enqueue_stock_reconcile',
                      'builder_network_backfill_stock_sync',
                      'builder_network_claim_outbox',
                      'cron_invoke_signed_function')
  order by 1
`);

// ---------------------------------------------------------------------------
// 5. THE OUTBOX. Whether anything is being composed, and what happened to it.
// ---------------------------------------------------------------------------
await section('5. builder_network_outbox — by type and status', `
  select event_type, status,
         count(*)            as events,
         max(attempts)       as max_attempts,
         min(created_at)     as first_created,
         max(created_at)     as last_created,
         max(delivered_at)   as last_delivered,
         max(available_at)   as furthest_available_at
  from public.builder_network_outbox
  group by 1, 2
  order by 3 desc
`);

await section('5b. the twenty most recent outbox rows', `
  select event_type, status, attempts, source_version,
         created_at, available_at, delivered_at,
         left(coalesce(last_error, '(none)'), 90) as last_error,
         (locked_by is not null) as locked
  from public.builder_network_outbox
  order by created_at desc
  limit 20
`);

await section('5c. what is pending RIGHT NOW, and why it has not gone', `
  select count(*)                                        as pending,
         count(*) filter (where available_at <= now())    as claimable_now,
         count(*) filter (where available_at >  now())    as backing_off,
         min(created_at)                                  as oldest_pending,
         max(attempts)                                    as max_attempts,
         left(coalesce(max(last_error), '(none)'), 120)   as a_recent_error
  from public.builder_network_outbox
  where status = 'pending'
`);

// ---------------------------------------------------------------------------
// 6. THE WORKER'S DRIVER, AND WHETHER THE HTTP CALL IT QUEUES LANDS. A green
//    cron run is the SQL succeeding, not the delivery — `net._http_response`
//    is the honest signal.
// ---------------------------------------------------------------------------
await section('6. cron.job — the outbox worker and the inbound sweep', `
  select jobid, jobname, schedule, active, database, username
  from cron.job
  where jobname ilike '%builder%' or command ilike '%builder_network%'
  order by jobname
`);

await section('6b. cron.job_run_details — the last 15 runs', `
  select j.jobname, d.status, d.start_time, d.end_time,
         left(coalesce(d.return_message, ''), 160) as return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname ilike '%builder%'
  order by d.start_time desc
  limit 15
`);

await section('6c. net._http_response — what the worker invocation actually answered', `
  select status_code,
         count(*)      as calls,
         min(created)  as first_seen,
         max(created)  as last_seen,
         left(coalesce(max(error_msg), '(none)'), 120)   as an_error,
         left(coalesce(max(content), ''), 160)           as a_body
  from net._http_response
  where created > now() - interval '7 days'
  group by 1
  order by 4 desc
  limit 20
`);

await section('6d. net._http_response — the ten most recent, whatever they were', `
  select id, status_code, created,
         left(coalesce(error_msg, '(none)'), 100) as error_msg,
         left(coalesce(content, ''), 200)         as content
  from net._http_response
  order by created desc
  limit 10
`);

// ---------------------------------------------------------------------------
// 7. THE OUTBOUND STAMP AND THE OPERATIONAL RECORD.
// ---------------------------------------------------------------------------
await section('7. builder_network_stamps', `
  select connection_id, side, source_version, updated_at, stamp
  from public.builder_network_stamps
  order by side
`);

await section('7b. portal_operational_events — builder_network_*, last 14 days', `
  select event_name, severity, success, count(*) as events,
         min(occurred_at) as first_seen, max(occurred_at) as last_seen,
         left(max(metadata::text), 220) as sample_metadata
  from public.portal_operational_events
  where event_name ilike 'builder_network%'
    and occurred_at > now() - interval '14 days'
  group by 1, 2, 3
  order by 6 desc
  limit 30
`);

// ---------------------------------------------------------------------------
// 8. THE SECRET THE WORKER AUTHENTICATES ON. Present or absent, never its
//    value — and its presence here is not proof the deployed function agrees
//    with it, which is exactly the divergence that has bitten before.
// ---------------------------------------------------------------------------
await section('8. the vault names this path depends on (presence only)', `
  select name, (decrypted_secret is not null and length(decrypted_secret) > 0) as present,
         updated_at
  from vault.decrypted_secrets
  where name in ('supabase_url', 'internal_edge_secret')
  order by name
`);

// ---------------------------------------------------------------------------
// 9. WHICH BUILDERS EXIST, AND WHICH OF THEM A CONNECTION ACTUALLY SERVES.
//    The enqueue reaches an organisation only through a connection mapped to
//    it, so an organisation absent from this list has no route to any clone
//    however live its stock is — and nothing anywhere reports that.
// ---------------------------------------------------------------------------
await section('9. builder_organisations against the connections that serve them', `
  select o.id,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 40) as builder,
         o.created_at,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = o.id and i.lifecycle_status = 'active') as active_items,
         (select count(*) from public.workspace_connections c
           where c.builder_organisation_id = o.id and c.state = 'active')    as active_connections,
         (select string_agg(c.id::text, ', ') from public.workspace_connections c
           where c.builder_organisation_id = o.id)                          as connections_any_state
  from public.builder_organisations o
  order by 4 desc, 3
`);

if (unanswered.length) {
  console.log(`\n${'='.repeat(92)}\nQUESTIONS THIS DATABASE COULD NOT ANSWER\n${'='.repeat(92)}`);
  for (const f of unanswered) console.log(`  - ${f}`);
}
console.log('\nRead-only trace complete. Nothing was changed.');
