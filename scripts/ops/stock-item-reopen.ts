/**
 * BUILDER STOCK — REOPEN A PROPERTY THE TWO PROVEN DEFECTS RETIRED.
 *
 * THE NARROWEST ACT THAT LETS THE CORRECTED PIPELINE SPEAK. It removes two
 * banked branch verdicts and resets the work state. It writes no image, sets
 * no primary, settles nothing, publishes nothing and never touches
 * `lifecycle_status` — the normal pipeline has to prove the fix, and a
 * recovery that hands it the answer proves nothing.
 *
 * WHICH TWO, AND WHY ONLY TWO. Each affected property banked four branch
 * verdicts. Two of them are CORRECT and stay: the estate brochure and the
 * stage plan genuinely are not that property's package cover, and the
 * forensic replay reached the same answer. The two that are wrong are
 * identified from the data rather than by position:
 *
 *   THE FALSE RECOVERY — an entry whose `result` is `image_recovered` and
 *   whose stored image is not marketplace-eligible. That is the shared estate
 *   masterplan taken as one property's own photograph because the exclusivity
 *   count was empty, then refused by the marketplace measure, leaving the row
 *   with an image it can never show and no further branch tried.
 *
 *   THE FALSE VERDICT — the entry for the branch the manifest records under
 *   the `Brochure URL` column. That is the property's own brochure, banked
 *   `no_deterministic_image / inspected` after a decode produced nothing —
 *   permanent, because the entry carries no `runtime_version`, so nothing
 *   short of a `PROVENANCE_VERSION` bump reopens it.
 *
 * IDEMPOTENT BY CONSTRUCTION. `#-` on a key that is already gone is a no-op,
 * and the work-state reset is a fixed assignment rather than an increment. Run
 * it twice and the second run changes nothing.
 *
 * DRY RUN UNLESS TOLD OTHERWISE. Nothing is written without `--apply`; the
 * default prints the exact keys it would remove and the reason for each.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-item-reopen.ts [--apply]
 * Needs:  SUPABASE_ACCESS_TOKEN, STOCK_ITEM_IDS (or the default below).
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read or written.');
  Deno.exit(1);
}

const APPLY = Deno.args.includes('--apply') || (Deno.env.get('APPLY') || '') === 'true';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row only by default: the property whose history is fully reconstructed. */
const DEFAULT_IDS = ['ca077a36-24d2-4a47-8c7c-0bf26ae7099f'];

const ITEM_IDS = (Deno.env.get('STOCK_ITEM_IDS') || DEFAULT_IDS.join(','))
  .split(',').map((id) => id.trim()).filter(Boolean);
const bad = ITEM_IDS.filter((id) => !UUID.test(id));
if (bad.length) {
  console.error(`Not stock item ids: ${bad.map((id) => safeDetail(id, 60)).join(', ')}`);
  Deno.exit(1);
}

/** Single quotes doubled. Every value that reaches SQL goes through this. */
const q = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

async function sql(label: string, text: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`[${label}] query failed ${response.status}: ${safeDetail(body, 400)}`);
  }
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

const inList = ITEM_IDS.map(q).join(',');

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${ITEM_IDS.length} item(s) on ${PROJECT_REF}\n`);

/*
 * WHAT WOULD BE REMOVED, NAMED WITH ITS REASON, BEFORE ANYTHING IS WRITTEN.
 *
 * The two predicates are the two proven defects and nothing else. An entry
 * that matches neither is a verdict this recovery has no opinion about and
 * leaves exactly where it is.
 */
const doomed = await sql('keys to remove', `
  with target as (
    select id, source_provenance_result as spr
      from public.builder_stock_items
     where id in (${inList})
  ),
  branches as (
    select t.id, b.key, b.value
      from target t, lateral jsonb_each(t.spr -> 'branches') b
  )
  select b.id, b.key,
         b.value ->> 'result'     as result,
         b.value ->> 'exhaustion' as exhaustion,
         'false recovery — shared image stored, not marketplace eligible' as reason
    from branches b
    join public.builder_stock_item_images im
      on im.stock_item_id = b.id
     and im.source_reference = b.value ->> 'stored_reference'
   where b.value ->> 'result' = 'image_recovered'
     and coalesce(im.source_detail ->> 'marketplace_display_eligible', '') <> 'true'
  union all
  select b.id, b.key,
         b.value ->> 'result'     as result,
         b.value ->> 'exhaustion' as exhaustion,
         'false verdict — the row''s own brochure, banked after a decode produced nothing' as reason
    from branches b
    join public.builder_stock_source_assets a
      on a.stock_item_id = b.id
     and a.column_header = 'Brochure URL'
     and (b.value ->> 'package_reference' = a.reference or b.key = a.reference)
   where b.value ->> 'result' = 'no_deterministic_image'
   order by 1, 2`);

if (!doomed.length) {
  console.log('Nothing matches either defect signature. Nothing to reopen.');
  Deno.exit(0);
}

const byItem = new Map<string, string[]>();
for (const row of doomed) {
  const id = String(row.id);
  console.log(`${id}`);
  console.log(`  remove  ${String(row.key)}`);
  console.log(`          result=${row.result} exhaustion=${row.exhaustion ?? '—'}`);
  console.log(`          ${row.reason}`);
  if (!byItem.has(id)) byItem.set(id, []);
  byItem.get(id)!.push(String(row.key));
}

/*
 * AND WHAT IS DELIBERATELY LEFT STANDING, printed so the narrowness is visible
 * rather than asserted.
 */
const kept = await sql('verdicts left standing', `
  with target as (
    select id, source_provenance_result as spr
      from public.builder_stock_items where id in (${inList})
  )
  select t.id, b.key, b.value ->> 'result' as result
    from target t, lateral jsonb_each(t.spr -> 'branches') b
   where b.key not in (${doomed.map((r) => q(String(r.key))).join(',') || "''"})
   order by 1, 2`);
console.log('\nleft standing (correct verdicts, untouched):');
for (const row of kept) console.log(`  ${String(row.key)}  -> ${row.result}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to reopen.');
  Deno.exit(0);
}

/*
 * ONE STATEMENT PER ITEM, and every column it sets is named here.
 *
 * `lifecycle_status`, `primary_image_id`, `enriched_at` and every image row are
 * absent on purpose: the pipeline decides those, and a recovery that decides
 * them for it proves nothing about the fix.
 */
for (const [id, keys] of byItem) {
  const deletions = keys.map((key) => `#- ARRAY['branches', ${q(key)}]`).join('\n           ');
  const updated = await sql(`reopen ${id}`, `
    update public.builder_stock_items
       set source_provenance_result = source_provenance_result
           ${deletions},
           image_work_stage           = 'source',
           image_work_attempts        = 0,
           image_work_next_attempt_at = now(),
           image_work_claim_until     = null,
           image_work_last_result     = null,
           image_work_last_error      = null,
           enrichment_status          = 'pending',
           updated_at                 = now()
     where id = ${q(id)}
    returning id, image_work_stage, image_work_attempts, enrichment_status,
              lifecycle_status, primary_image_id,
              (select count(*) from jsonb_object_keys(
                 source_provenance_result -> 'branches')) as branches_left`);
  console.log(`\nreopened ${id}: ${JSON.stringify(updated[0] ?? {})}`);
}

console.log('\nReopened. The normal pipeline decides everything from here.');
