/**
 * WHY ONE UPLOAD WOULD NOT IMPORT — read from production, nothing changed.
 *
 * A builder uploaded a 4 MB PDF on 2 October 2026, the row settled at
 * `UPLOADED` with no properties, and the browser reported "Failed to fetch".
 * That string is the BROWSER's: it means the response never arrived, so the
 * fault is not in anything the function wrote down — it is in whether the
 * function answered at all. So this asks two different questions and never
 * confuses them:
 *
 *   • what the UPLOAD ROW says (a refusal the server recorded), and
 *   • what the RUNTIME says (a status, an execution time, a version, and a
 *     worker that was killed, which records nothing anywhere else).
 *
 * SELECT only against the database, and read-only against the log endpoint.
 * It prints ids, statuses, sizes and timings — never a customer's document.
 *
 *   deno run -A scripts/ops/stock-upload-failure-state.ts
 */
const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

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

async function section(title: string, text: string) {
  console.log(`\n${'='.repeat(92)}\n${title}\n${'='.repeat(92)}`);
  try {
    const rows = await sql(title, text);
    if (!rows.length) console.log('  (no rows)');
    else console.table(rows);
  } catch (error) {
    console.log(`  COULD NOT BE READ: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The runtime's own account of one function, which no table records. */
async function logs(title: string, query: string, minutes: number) {
  console.log(`\n${'='.repeat(92)}\n${title}\n${'='.repeat(92)}`);
  const params = new URLSearchParams({
    sql: query,
    iso_timestamp_start: new Date(Date.now() - minutes * 60_000).toISOString(),
    iso_timestamp_end: new Date(Date.now() + 60_000).toISOString(),
  });
  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${params}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    const text = await res.text();
    if (!res.ok) { console.log(`  HTTP ${res.status}: ${text.slice(0, 300)}`); return; }
    const body = JSON.parse(text);
    if (body?.error) { console.log(`  ${JSON.stringify(body.error).slice(0, 300)}`); return; }
    const rows = body?.result ?? [];
    if (!rows.length) console.log('  (no rows)');
    else for (const row of rows) console.log(`  ${JSON.stringify(row).slice(0, 460)}`);
  } catch (error) {
    console.log(`  COULD NOT BE READ: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`Stock upload failure state — ${PROJECT_REF} — ${new Date().toISOString()}`);
console.log('READ-ONLY.');

await section('1. the newest uploads, and what each settled at', `
  select id, organisation_id, source_type, status, manifest_state, failure_state,
         blocked_reason, left(coalesce(error_detail,''), 300) as error_detail,
         byte_size, properties_imported, created_at, updated_at
  from public.builder_stock_uploads
  order by created_at desc limit 12
`);

await section('2. image progress for those uploads', `
  select upload_id, total, photos_ready, failed, working, pending_assets,
         manifest_state, failure_state, published
  from public.builder_stock_image_progress
  order by upload_id desc limit 12
`);

await section('3. what the newest upload produced, if anything', `
  select u.id as upload_id, count(i.id) as items,
         count(i.id) filter (where i.lifecycle_status = 'staged') as staged,
         count(i.id) filter (where i.lifecycle_status = 'active') as active
  from public.builder_stock_uploads u
  left join public.builder_stock_items i on i.source_upload_id = u.id
  group by u.id order by max(u.created_at) desc limit 8
`);

await logs('4. EVERY builder-portal-stock invocation in the last 90 minutes',
  'select function_edge_logs.timestamp, response.status_code as status, '
  + 'm.execution_time_ms, m.version from function_edge_logs '
  + "cross join unnest(metadata) as m cross join unnest(m.response) as response "
  + "where regexp_contains(event_message, 'builder-portal-stock') "
  + 'order by function_edge_logs.timestamp desc limit 60', 90);

await logs('5. what the function itself said (its own console output)',
  'select function_logs.timestamp, event_message from function_logs '
  + 'order by function_logs.timestamp desc limit 80', 90);

console.log('\nRead-only state complete. Nothing was changed.');
