/**
 * PUT BACK A STOCK LIST THE BUILDER DELETED TO RE-IMPORT IT.
 *
 * WHAT IT IS FOR. Deleting a stock list source archives every property that
 * source is currently supplying — correctly, and the confirmation says so.
 * What made that destructive here is that deleting was the ONLY way to
 * re-import a LINKED sheet: "Read again" re-ran the parsers over the snapshot
 * taken on the day, so a builder who had edited their sheet was told
 * "47 updated" having imported none of it. Measured on Mairandi Developers,
 * from `builder_portal_activity_log`:
 *
 *   18 Sep 09:41:29  builder_stock_source_deleted    {"archived": 47}
 *   18 Sep 09:41:46  builder_stock_url_source_added  docs.google.com
 *   19 Sep 08:39:36  builder_stock_source_deleted    {"archived": 47}
 *   19 Sep 08:40:01  builder_stock_url_source_added  docs.google.com
 *   19 Sep 09:23:44  builder_stock_source_deleted    {"archived": 47}
 *
 * The first two deletes were re-imports and completed in seconds. The third
 * was not followed by an add, and left 47 live properties archived and the
 * marketplace empty. `linkedSource.ts` closes the cause; this is the one-off
 * repair for the catalogue it already took down.
 *
 * IT IS THE EXACT INVERSE OF ONE LOGGED ACT, and nothing more. It restores
 * the rows `shouldArchiveOnSourceDelete` would have selected — `upload_id`
 * equals this upload, archived — and un-stamps the upload. It imports
 * nothing, fetches nothing, and creates no upload row.
 *
 * ## The rules it holds
 *
 * **THE PHOTOGRAPH RULE IS NOT RELAXED TO RESTORE A ROW.** A property goes
 * back to `active` only where it holds a ready builder-source photograph, by
 * `builder_stock_photo_is_source_ready` — the ONE statement of that rule,
 * called rather than restated. Everything else goes back to `staged`, which
 * is where publication would have left it. A restore that put a photoless
 * property on the marketplace would be weakening marketplace eligibility to
 * repair a mistake, which is never the trade.
 *
 * **IT IS ASSERTED AGAINST WHAT THE DELETE RECORDED.** The activity log says
 * how many rows that delete archived. If a different number is about to be
 * restored, something else has touched this catalogue since and a blind
 * restore would be writing over it — so it refuses and says both numbers.
 * Asserted by effect, never by configuration.
 *
 * **A NEWER LIVE GENERATION IS NEVER JOINED.** If a later, undeleted upload
 * is supplying active stock, reviving this one puts two generations of the
 * same catalogue on one marketplace — precisely what the atomic cutover
 * exists to prevent. Refused.
 *
 * **THE UPLOAD IS UN-STAMPED FIRST.** A moment where 47 properties are listed
 * under no stock list at all is the contradiction this whole incident was
 * reported as; a moment where the source is back and its properties are still
 * arriving is the ordinary state of an import.
 *
 * DRY RUN UNLESS `APPLY=true`. Idempotent: a second run finds nothing to do
 * and says so. Reversible by the delete the builder already has.
 *
 * Usage:  RESTORE_UPLOAD_ID=<uuid> [APPLY=true] deno run -A \
 *           --config supabase/functions/deno.json scripts/ops/stock-source-restore.ts
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
const APPLY = (Deno.env.get('APPLY') || '').toLowerCase() === 'true';
const UPLOAD_ID = (Deno.env.get('RESTORE_UPLOAD_ID') || '').trim();

if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read or written.');
  Deno.exit(1);
}
/*
 * VALIDATED BEFORE IT REACHES A STATEMENT. This value is typed by a person
 * into a workflow input; a uuid can hold no quote, parenthesis, comma or
 * operator, which is the difference between naming a row and asking a
 * question.
 */
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(UPLOAD_ID)) {
  console.error('RESTORE_UPLOAD_ID must be a uuid. Refusing.');
  Deno.exit(1);
}

async function sql(label: string, text: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}: ${body.slice(0, 400)}`);
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
}

/** SELECT only, for everything the decision is made from. */
async function read(label: string, text: string): Promise<Record<string, unknown>[]> {
  if (!/^\s*(select|with)\b/i.test(text)) {
    throw new Error(`[${label}] refused: a read must be a SELECT.`);
  }
  return await sql(label, text);
}

function refuse(reason: string): never {
  console.error(`\nREFUSED: ${reason}`);
  console.error('Nothing was written.');
  Deno.exit(2);
}

console.log(`Stock source restore — project ${PROJECT_REF} — ${new Date().toISOString()}`);
console.log(`upload ${UPLOAD_ID}`);
console.log(APPLY ? 'APPLY: writes are enabled.' : 'DRY RUN: nothing will be written.');

// ---------------------------------------------------------------------------
// 1. The upload, and whether it is the kind of row this may restore.
// ---------------------------------------------------------------------------
const [upload] = await read('upload', `
  select u.id, u.organisation_id,
         coalesce(o.trading_name, o.legal_name, '(unnamed)') as builder,
         u.status, u.source_type, u.published_at, u.created_at,
         u.deleted_at, u.deleted_by_builder_user_id,
         coalesce(u.original_filename, u.source_url, '(none)') as source
  from public.builder_stock_uploads u
  left join public.builder_organisations o on o.id = u.organisation_id
  where u.id = '${UPLOAD_ID}'::uuid
`);
if (!upload) refuse('no such stock list.');
console.log('\nThe stock list:');
console.table([upload]);

if (!upload.deleted_at) {
  refuse('that stock list is not deleted, so there is nothing to restore.');
}

// ---------------------------------------------------------------------------
// 2. A newer live generation is never joined.
// ---------------------------------------------------------------------------
const newer = await read('newer generations', `
  select u.id, u.created_at, u.status,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = u.id and i.lifecycle_status = 'active') as active_items
  from public.builder_stock_uploads u
  where u.organisation_id = '${upload.organisation_id}'::uuid
    and u.deleted_at is null
    and u.created_at > '${upload.created_at}'::timestamptz
  order by u.created_at
`);
if (newer.length) console.table(newer);
const supplantedBy = newer.filter((row) => Number(row.active_items ?? 0) > 0);
if (supplantedBy.length) {
  refuse(`a newer stock list is already supplying ${supplantedBy
    .map((r) => `${r.active_items} active propert${Number(r.active_items) === 1 ? 'y' : 'ies'}`)
    .join(', ')}. Restoring this one would put two generations of the same `
    + 'catalogue on one marketplace, which is what the atomic cutover prevents.');
}

// ---------------------------------------------------------------------------
// 3. What would be restored, and to WHICH lifecycle. The photograph rule
//    decides, through the one function that states it.
// ---------------------------------------------------------------------------
const plan = await read('restore plan', `
  select case when public.builder_stock_photo_is_source_ready(i.primary_image_id)
              then 'active' else 'staged' end as restore_to,
         count(*) as items
  from public.builder_stock_items i
  where i.upload_id = '${UPLOAD_ID}'::uuid
    and i.lifecycle_status = 'archived'
  group by 1
  order by 1
`);
console.log('\nWhat would be restored, and to what:');
if (!plan.length) console.log('  (nothing — no archived row is supplied by this stock list)');
else console.table(plan);

const total = plan.reduce((sum, row) => sum + Number(row.items ?? 0), 0);
if (total === 0) {
  console.log('\nNothing to restore. This is what a second run looks like.');
  Deno.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Asserted against what the delete itself recorded.
// ---------------------------------------------------------------------------
const [deletion] = await read('the delete this undoes', `
  select l.created_at,
         (l.metadata ->> 'archived')::int as archived_then
  from public.builder_portal_activity_log l
  where l.action = 'builder_stock_source_deleted'
    and l.entity_id = '${UPLOAD_ID}'::uuid
  order by l.created_at desc
  limit 1
`);
if (!deletion) {
  refuse('no `builder_stock_source_deleted` row names this stock list, so there is no '
    + 'recorded act for this to be the inverse of.');
}
console.log('\nThe act this undoes:');
console.table([deletion]);
const archivedThen = Number(deletion.archived_then ?? -1);
if (archivedThen !== total) {
  refuse(`the delete recorded ${archivedThen} archived and ${total} would be restored. `
    + 'Something else has touched this catalogue since, and a restore that cannot '
    + 'account for the difference would be writing over it.');
}

if (!APPLY) {
  console.log(`\nDRY RUN. ${total} propert${total === 1 ? 'y' : 'ies'} would be restored `
    + `(${plan.map((r) => `${r.items} → ${r.restore_to}`).join(', ')}) and the stock list `
    + 'would be un-deleted. Re-run with APPLY=true.');
  Deno.exit(0);
}

// ---------------------------------------------------------------------------
// 5. The writes. Upload first — see the header.
// ---------------------------------------------------------------------------
console.log('\nApplying…');

const [restoredUpload] = await sql('un-delete the upload', `
  update public.builder_stock_uploads
     set deleted_at = null, deleted_by_builder_user_id = null, updated_at = now()
   where id = '${UPLOAD_ID}'::uuid
     and deleted_at is not null
  returning id, deleted_at
`);
if (!restoredUpload) refuse('the stock list was not un-deleted — it changed underneath this run.');
console.log('  stock list un-deleted.');

const promoted = await sql('restore the rows', `
  update public.builder_stock_items i
     set lifecycle_status = case
           when public.builder_stock_photo_is_source_ready(i.primary_image_id)
           then 'active' else 'staged' end,
         updated_at = now()
   where i.upload_id = '${UPLOAD_ID}'::uuid
     and i.lifecycle_status = 'archived'
  returning i.id, i.lifecycle_status
`);
const active = promoted.filter((r) => r.lifecycle_status === 'active').length;
const staged = promoted.filter((r) => r.lifecycle_status === 'staged').length;
console.log(`  ${promoted.length} propert${promoted.length === 1 ? 'y' : 'ies'} restored `
  + `— ${active} active, ${staged} staged.`);

await sql('record the act', `
  insert into public.builder_portal_activity_log (
    actor_type, action, entity_type, entity_id, organisation_id, metadata)
  values ('service_role', 'builder_stock_source_restored', 'stock_upload',
          '${UPLOAD_ID}'::uuid, '${upload.organisation_id}'::uuid,
          jsonb_build_object('restored_active', ${active}, 'restored_staged', ${staged},
                             'inverse_of_delete_at', '${deletion.created_at}'))
  returning id
`);

// ---------------------------------------------------------------------------
// 6. ASSERTED BY RE-READING, never by the fact that the writes returned.
// ---------------------------------------------------------------------------
const after = await read('after', `
  select u.deleted_at is null as source_listed,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = u.id and i.lifecycle_status = 'active')   as active,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = u.id and i.lifecycle_status = 'staged')   as staged,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = u.id and i.lifecycle_status = 'archived') as still_archived
  from public.builder_stock_uploads u
  where u.id = '${UPLOAD_ID}'::uuid
`);
console.log('\nRe-read from the database:');
console.table(after);

const outbox = await read('what the clone was told', `
  select status, count(*) as events, max(created_at) as last_queued
  from public.builder_network_outbox
  where created_at > now() - interval '3 minutes'
  group by 1
`);
console.log('\nEvents queued for the clone by this restore:');
if (!outbox.length) console.log('  (none yet — the producer runs on the row write, so re-check shortly)');
else console.table(outbox);

console.log('\nDone. The clone converges on its own one-minute sweep.');
