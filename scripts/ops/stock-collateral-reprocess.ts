/**
 * BUILDER STOCK — SEND EVERY CARD LED BY A PLAN BACK FOR ITS BROCHURE.
 *
 * WHAT THIS REPAIRS, measured on the live marketplace 19 September 2026: of
 * 46 cards, 13 led with a picture taken from an estate-level column — 8 from
 * `Siting / Masterplan URL`, 4 from `Estate Brochure / Location Map URL`, 1
 * from `Stage Plan / PlanOfSub URL`. Twelve of those came from four files and
 * one file was the lead picture on four properties across two house designs.
 * Every one of those 13 also had a `Brochure URL` branch that had NEVER BEEN
 * OPENED: they settled in one pass on 18 September 09:00-10:00 UTC, before
 * that day's brochure-reading repairs, and `settleItemImages.ts` states the
 * rule that kept them there — "a property at `settled` is never claimed
 * again".
 *
 * `columnDeclaration.pure.ts` now refuses those pictures at the branch and at
 * both display gates. That rule alone leaves the thirteen cards blank for
 * ever, because nothing goes back for a property that is already settled.
 * This is what goes back.
 *
 * WHY THIS IS NOT A MIGRATION, and it was one first. The deploy lane applies
 * migrations BEFORE it ships the functions — deliberately, "schema before
 * code" — so a reprocess migration resets these rows while the OLD code is
 * still live. The old `classifyPrimaryImageStanding` still counts a
 * masterplan as a ready image, so the repair would skip every one of them and
 * the settler would put them straight back to `settled`, silently undoing the
 * whole repair before the rule ever arrived. A one-time data repair that must
 * run AFTER a code deploy does not belong in a migration.
 *
 * AND THERE IS NO SECOND COPY OF THE RULE. The migration carried the
 * vocabulary again in SQL, because SQL cannot import TypeScript. This imports
 * `columnMaySupplyPrimaryImage` — the module the product itself runs — so
 * what this reprocesses and what the marketplace refuses cannot become two
 * standards. Same move `assessPepEvidence` makes.
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE. It resets the image work
 * state and nothing else: no image, no primary, no lifecycle, no publication.
 * The stored picture is KEPT — it is the audit trail of what was shown, the
 * display gate already refuses it, and deleting evidence to change a screen
 * is not a repair. `primary_image_id` is left pointing at it so the
 * publication gate still sees a source-ready photograph and no property
 * leaves the marketplace; the card draws nothing until the corrected pipeline
 * finds its brochure, which is the honest state of a property whose only
 * stored picture is a subdivision plan.
 *
 * SELECTED BY THE RULE, NEVER BY A LIST OF IDS. Twice in this investigation a
 * hand-written identifier was wrong. The affected rows are discovered, shown
 * with the heading that condemned each one, and only then written.
 *
 * DRY RUN UNLESS TOLD OTHERWISE. Nothing is written without `--apply`.
 * Idempotent: a property already at `source` is not selected, so a second run
 * changes nothing.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-collateral-reprocess.ts [--apply]
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';
import {
  columnMaySupplyPrimaryImage, readColumnDeclaration,
} from '../../supabase/functions/_shared/builderStock/columnDeclaration.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read or written.');
  Deno.exit(1);
}
const APPLY = Deno.args.includes('--apply') || (Deno.env.get('APPLY') || '') === 'true';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — collateral-column reprocess on ${PROJECT_REF}\n`);

/*
 * EVERY ACTIVE PROPERTY AND THE HEADING ITS CARD'S PICTURE CAME FROM.
 *
 * The SQL asks no question about the heading — it returns them all and the
 * RULE decides here, in the one implementation. A `where` clause matching
 * headings would be the second copy this exists to avoid.
 */
const leads = await sql('active leads', `
  select i.id::text                              as id,
         coalesce(i.external_reference, '')       as reference,
         coalesce(i.lot_number, '')               as lot,
         i.image_work_stage                       as stage,
         im.source_detail ->> 'source_column'     as source_column
    from public.builder_stock_items as i
    join public.builder_stock_item_images as im on im.id = i.primary_image_id
   where i.lifecycle_status = 'active'
   order by i.created_at, i.id`);

const affected = leads.filter((row) => !columnMaySupplyPrimaryImage(row.source_column));
const working = affected.filter((row) => String(row.stage) !== 'source');

console.log(`${leads.length} active card(s) with a primary image.`);
console.log(`${affected.length} led by a column that declares collateral.`);
console.log(`${working.length} of those are past 'source' and will be sent back.\n`);

const byColumn = new Map<string, number>();
for (const row of affected) {
  const key = String(row.source_column ?? '(no heading)');
  byColumn.set(key, (byColumn.get(key) ?? 0) + 1);
}
for (const [column, count] of [...byColumn].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${safeDetail(column, 44).padEnd(46)} ${
    readColumnDeclaration(column)}`);
}

if (!working.length) {
  console.log('\nNothing to reprocess. Every collateral-led card is already back at source.');
  Deno.exit(0);
}

console.log('\nProperties to reprocess:');
for (const row of working) {
  console.log(`  ${row.id}  ${String(row.reference || row.lot || '—').padEnd(16)} stage=${
    String(row.stage).padEnd(12)} ${safeDetail(String(row.source_column ?? ''), 44)}`);
}

const ids = working.map((row) => String(row.id));
const bad = ids.filter((id) => !UUID.test(id));
if (bad.length) {
  console.error(`\nRefusing to write: ${bad.length} row id(s) are not uuids.`);
  Deno.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to reprocess these.');
  Deno.exit(0);
}

/*
 * THE RESET, AND ONLY THE RESET.
 *
 * The same fields `stock-item-reopen.ts` resets, for the same reason: the
 * normal pipeline has to prove the fix, and a recovery that hands it the
 * answer proves nothing. `lifecycle_status`, `primary_image_id`,
 * `source_provenance_result` and every image row are untouched — the
 * collateral branch's own verdict stays standing because the branch is
 * refused by the column now anyway, and the brochure branch has no verdict to
 * remove: it was never opened.
 */
const updated = await sql('reprocess', `
  update public.builder_stock_items
     set image_work_stage           = 'source',
         image_work_attempts        = 0,
         image_work_next_attempt_at = now(),
         image_work_claim_until     = null,
         image_work_last_result     = null,
         image_work_last_error      = null,
         enrichment_status          = 'pending',
         updated_at                 = now()
   where id in (${ids.map(q).join(',')})
     and lifecycle_status = 'active'
  returning id::text as id, image_work_stage as stage, lifecycle_status as lifecycle,
            (primary_image_id is not null) as kept_primary`);

console.log(`\nReprocessed ${updated.length} of ${working.length} property(ies):`);
for (const row of updated) console.log(`  ${JSON.stringify(row)}`);

/*
 * AND THE THINGS THAT MUST NOT HAVE CHANGED, ASSERTED BY EFFECT.
 *
 * The same rule the retention purge and the verification self-test answer to:
 * read back what happened rather than trusting what was sent.
 */
const after = await sql('verify', `
  select count(*) filter (where lifecycle_status <> 'active')      as not_active,
         count(*) filter (where primary_image_id is null)          as lost_primary,
         count(*) filter (where image_work_stage <> 'source')      as not_reset
    from public.builder_stock_items
   where id in (${ids.map(q).join(',')})`);
const check = after[0] ?? {};
console.log(`\nafter: ${JSON.stringify(check)}`);
if (Number(check.not_active ?? 0) || Number(check.lost_primary ?? 0)
  || Number(check.not_reset ?? 0)) {
  console.error('The reprocess changed something it must not have. Investigate before re-running.');
  Deno.exit(1);
}
console.log('\nReprocessed. The corrected pipeline decides everything from here.');
