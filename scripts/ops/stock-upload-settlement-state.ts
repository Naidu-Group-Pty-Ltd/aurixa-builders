/**
 * BUILDER STOCK — WHY AN UPLOAD'S IMAGE SETTLEMENT DOES NOT FINISH. Read-only.
 *
 * WHY THIS EXISTS. From 12:39 UTC on 24 September 2026 every settler tick
 * logged the same line for one upload, `7d5b8e99`:
 *
 *   source image settlement incomplete { reason: "budget_or_work_cap_reached",
 *     rows_read: 70, matched: 0, images_stored: 0, package_*: 0 }
 *
 * — seven hundred times, with the same numbers. `settleSourceImages.ts` says
 * of that line: "it is stuck if this line repeats with the same numbers". Its
 * sixty-eight properties were published with photographs; what never finished
 * is the upload-level repair, and it never finishes quietly: the marker stays
 * below the provenance version, so the minute tick keeps paying for it.
 *
 * The logs say THAT it is stuck. Which properties the repair still considers
 * owed, and why, is recorded only in the rows — so this prints the rows,
 * judged by the pipeline's OWN rules (`openBranches`, `servableStoredImage`),
 * imported rather than restated, against the versions the deployed settler
 * asks for.
 *
 * WRITES NOTHING. Every statement is a SELECT; `sql()` refuses anything else.
 * It fetches no builder document and no sheet.
 *
 * PRINTS NO LINK. A link is shown as its host, its kind and a short digest, so
 * two branches can be told apart without printing an address — a Drive file
 * id in a path is as good as a key to anyone holding the log.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-upload-settlement-state.ts [upload_id,...]
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF and UPLOAD_IDS.
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';
import { PROVENANCE_VERSION } from '../../supabase/functions/_shared/builderStock/provenanceVersion.pure.ts';
import { RUNTIME_VERSION } from '../../supabase/functions/_shared/builderStock/runtimeVersion.pure.ts';
import {
  openBranches, readBranchState, rowSourceBranches, unmappedWithRecoveredLinks,
  type RowSourceBranch,
} from '../../supabase/functions/_shared/builderStock/sourceBranches.pure.ts';
import { servableStoredImage } from '../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure.ts';
import type { IdentityConfirmationRef } from '../../supabase/functions/_shared/builderStock/negativeProvenance.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

/** The upload the ticks were stuck on when this was written. A default only. */
const DEFAULT_UPLOAD_IDS = ['7d5b8e99-c3ed-4686-a907-15d9ec2c8997'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checked, never quoted and hoped for: a uuid can hold no quote or operator. */
function checkedIds(raw: string[]): string[] {
  const ids = raw.map((id) => id.trim()).filter(Boolean);
  const bad = ids.filter((id) => !UUID.test(id));
  if (bad.length) {
    console.error(`Not upload ids: ${bad.map((id) => safeDetail(id, 60)).join(', ')}`);
    Deno.exit(1);
  }
  return [...new Set(ids)];
}

// `||`, not `??`: a blank dispatch input arrives as the empty string.
const UPLOAD_IDS = checkedIds(
  (Deno.args[0] || Deno.env.get('UPLOAD_IDS') || DEFAULT_UPLOAD_IDS.join(',')).split(','),
);

/** SELECT only. The label is logged; the statement never is. */
async function sql(label: string, text: string): Promise<Array<Record<string, unknown>>> {
  if (!/^\s*select\b/i.test(text)) {
    throw new Error(`[${label}] refused: this tool runs SELECT statements only.`);
  }
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
    throw new Error(`[${label}] management query failed ${response.status}: ${safeDetail(body, 400)}`);
  }
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

/** A link as this log may show it: host, kind and a digest, never the address. */
async function linkLabel(branch: RowSourceBranch): Promise<string> {
  let host = '?';
  try { host = new URL(branch.url).hostname; } catch { /* not an address */ }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(branch.url)));
  const short = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${host} ${branch.kind} #${short} (${branch.url.length} chars)`;
}

/** What a stored branch answer says, in the fields the terminal test reads. */
function recordSummary(record: unknown): string {
  if (!record || typeof record !== 'object') return 'no record';
  const r = record as Record<string, unknown>;
  const parts = [
    `result=${safeDetail(String(r.result ?? '—'), 40)}`,
    `provenance=${r.provenance_version ?? '—'}`,
  ];
  if (r.runtime_version !== undefined) parts.push(`runtime=${r.runtime_version}`);
  if (r.attempts !== undefined) parts.push(`attempts=${r.attempts}`);
  if (r.identity_confirmation) parts.push('confirmed');
  return parts.join(' ');
}

console.log(`Asked for: provenance ${PROVENANCE_VERSION}, runtime ${RUNTIME_VERSION}.`);

for (const uploadId of UPLOAD_IDS) {
  console.log(`\n══ upload ${uploadId}`);
  const [upload] = await sql('upload', `
    select id, organisation_id, source_type, status, created_at, deleted_at,
           source_images_settled_version, marketplace_eligibility_settled_version,
           image_sanitization_settled_version,
           (select array_agg(k order by k) from jsonb_object_keys(coalesce(image_stage_summary, '{}'::jsonb)) k)
             as stage_summary_keys
      from public.builder_stock_uploads where id = '${uploadId}'`);
  if (!upload) {
    console.log('  no such upload');
    continue;
  }
  const org = String(upload.organisation_id);
  if (!UUID.test(org)) throw new Error('organisation id is not a uuid');
  console.log(`  source ${upload.source_type} · status ${upload.status} · created ${upload.created_at}`
    + (upload.deleted_at ? ` · DELETED ${upload.deleted_at}` : ''));
  console.log(`  markers: source_images ${upload.source_images_settled_version ?? 'NULL'}`
    + ` · eligibility ${upload.marketplace_eligibility_settled_version ?? 'NULL'}`
    + ` · sanitization ${upload.image_sanitization_settled_version ?? 'NULL'}`);
  console.log(`  stage summary keys: ${JSON.stringify(upload.stage_summary_keys ?? [])}`);

  // The size of what the repair reads before its first row: every processed
  // property the ORGANISATION holds, not this upload's.
  const orgStock = await sql('organisation stock', `
    select lifecycle_status, count(*)::int as n
      from public.builder_stock_items where organisation_id = '${org}'
     group by 1 order by 1`);
  console.log(`  organisation stock by lifecycle: ${
    orgStock.map((r) => `${r.lifecycle_status} ${r.n}`).join(' · ')}`);

  const items = await sql('items', `
    select id, lot_number, source_row->>'house_design' as house_design, lifecycle_status,
           image_work_stage, image_work_attempts, primary_image_id is not null as has_primary,
           source_row->'unmapped' as unmapped, source_row as source_row,
           source_row->>'source_anchor' as source_anchor, source_provenance_result
      from public.builder_stock_items
     where upload_id = '${uploadId}' and organisation_id = '${org}'
     order by lot_number nulls last, id`);
  console.log(`  properties carrying this upload: ${items.length}`);
  if (!items.length) continue;

  const idList = items.map((i) => {
    const id = String(i.id);
    if (!UUID.test(id)) throw new Error('item id is not a uuid');
    return `'${id}'`;
  }).join(',');

  const images = await sql('images', `
    select stock_item_id, source_stage, processing_status, storage_path, external_url,
           source_detail
      from public.builder_stock_item_images where stock_item_id in (${idList})`);
  const imagesByItem = new Map<string, Array<Record<string, unknown>>>();
  for (const image of images) {
    const list = imagesByItem.get(String(image.stock_item_id)) ?? [];
    list.push(image);
    imagesByItem.set(String(image.stock_item_id), list);
  }

  const confirmations = await sql('confirmations', `
    select id, stock_item_id, document_reference, confirmed_lot
      from public.builder_stock_identity_confirmations
     where organisation_id = '${org}' and withdrawn_at is null
       and stock_item_id in (${idList})`);
  const confirmationsByItem = new Map<string, Map<string, IdentityConfirmationRef>>();
  for (const row of confirmations) {
    const byBranch = confirmationsByItem.get(String(row.stock_item_id)) ?? new Map();
    byBranch.set(String(row.document_reference), { id: String(row.id), lot: String(row.confirmed_lot) });
    confirmationsByItem.set(String(row.stock_item_id), byBranch);
  }

  let owed = 0;
  let readyNow = 0;
  let readyOlder = 0;
  const lines: string[] = [];
  for (const item of items) {
    const id = String(item.id);
    const uploaded = (imagesByItem.get(id) ?? [])
      .filter((image) => image.source_stage === 'uploaded_document' && image.processing_status === 'ready');
    // The settler's own two readings of "already holds a picture".
    const ready = uploaded.some((image) => servableStoredImage(image as never, PROVENANCE_VERSION));
    const readyAtAnyVersion = uploaded.some((image) => servableStoredImage(image as never, 0));
    if (ready) readyNow += 1;
    else if (readyAtAnyVersion) readyOlder += 1;
    const versions = [...new Set(uploaded.map((image) =>
      Number((image.source_detail as Record<string, unknown> | null)?.provenance_version ?? 0)))]
      .sort((a, b) => a - b);

    const unmapped = unmappedWithRecoveredLinks(
      item.unmapped as Record<string, string> | null,
      item.source_row as Record<string, unknown> | null);
    const branches = rowSourceBranches(unmapped);
    const open = openBranches(item.source_provenance_result, branches, PROVENANCE_VERSION,
      (item.source_anchor as string | null) ?? null, RUNTIME_VERSION,
      confirmationsByItem.get(id) ?? null);
    // What the repair would do with this row: skip it (a picture it counts, or
    // nothing to ask), or owe it a package recovery.
    const repairOwes = !ready && open.length > 0;
    if (repairOwes) owed += 1;

    const state = readBranchState(item.source_provenance_result);
    const openDetail = await Promise.all(open.map(async (branch) =>
      `      open: ${await linkLabel(branch)} — ${recordSummary(state[branch.url])}`));
    lines.push(`  lot ${item.lot_number ?? '—'} · ${safeDetail(String(item.house_design ?? '—'), 40)}`
      + ` · ${item.lifecycle_status}/${item.image_work_stage} · attempts ${item.image_work_attempts ?? 0}`
      + ` · primary ${item.has_primary ? 'yes' : 'no'}`
      + ` · ready@${PROVENANCE_VERSION} ${ready ? 'yes' : 'no'}`
      + ` · builder images ${uploaded.length} at versions ${JSON.stringify(versions)}`
      + ` · branches ${branches.length}, open ${open.length}`
      + (repairOwes ? ' · REPAIR OWES A RECOVERY' : ''));
    lines.push(...openDetail);
  }
  console.log(lines.join('\n'));
  console.log(`\n  SUMMARY: ${items.length} properties · ready at ${PROVENANCE_VERSION}: ${readyNow}`
    + ` · ready only at an older version: ${readyOlder}`
    + ` · owed a package recovery by the upload-level repair: ${owed}`);
}
