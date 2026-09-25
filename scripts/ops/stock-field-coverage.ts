/**
 * BUILDER STOCK — WHICH FIGURES A LIVE PROPERTY IS MISSING, AND WHAT ITS OWN
 * ROW SAYS ABOUT THEM. Read-only.
 *
 * WHY THIS EXISTS. On 25 September 2026 the owner reported that "many
 * properties do not have car spaces and build size". Whether that is a reader
 * that fails to pick up a column the stock list states, a brochure the reader
 * never consults for those two figures, or a stock list that simply does not
 * say them is a fact about the rows, not about the code — three different
 * defects with three different fixes, and only one of them is ours to make.
 * So this prints, for every live property missing either figure, what its own
 * stored record (`source_row`) carries: the columns the stock list gave it, any
 * value under a header that reads like a car count or a floor area, and the
 * documents it links.
 *
 * WRITES NOTHING. Every statement is a SELECT; `sql()` refuses anything else.
 * It fetches no builder document and no sheet.
 *
 * PRINTS NO LINK. A link is shown as its host and a short digest.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-field-coverage.ts
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

async function sql(label: string, text: string): Promise<Array<Record<string, unknown>>> {
  if (!/^\s*(select|with)\b/i.test(text)) {
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

/** A link as its host and a digest; never the address. */
async function linkLabel(url: string): Promise<string> {
  let host = 'link';
  try { host = new URL(url).host; } catch { /* not a URL */ }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  return `<${host} #${[...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
}

async function redact(value: unknown): Promise<unknown> {
  if (typeof value === 'string') {
    const urls = value.match(/https?:\/\/\S+/g) ?? [];
    let out = value;
    for (const url of urls) out = out.replace(url, await linkLabel(url));
    return safeDetail(out, 300);
  }
  if (Array.isArray(value)) return Promise.all(value.map(redact));
  if (value && typeof value === 'object') {
    // Keys too: a provenance branch is KEYED by the link it read.
    const entries = await Promise.all(Object.entries(value as Record<string, unknown>)
      .map(async ([k, v]) => [String(await redact(k)), await redact(v)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

/** A header that reads like a car count or a floor area. */
const FIGURE_KEY = /car|garage|park|space|size|area|sqm|m2|m²|sq|square|home|house|build|floor|living|total|internal/i;

function figureEntries(row: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(row ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...figureEntries(value as Record<string, unknown>, path));
    } else if (FIGURE_KEY.test(key) && value !== null && value !== '' && value !== undefined) {
      out.push([path, value]);
    }
  }
  return out;
}

const LIVE = `lifecycle_status in ('active','staged')`;

console.log(`stock field coverage — project ${PROJECT_REF}`);

const totals = await sql('totals', `
  select count(*)::int as live,
         count(*) filter (where car_spaces is null)::int as no_car,
         count(*) filter (where building_size_sqm is null)::int as no_home,
         count(*) filter (where car_spaces is null and building_size_sqm is null)::int as no_both,
         count(*) filter (where bedrooms is null)::int as no_beds,
         count(*) filter (where land_size_sqm is null)::int as no_land,
         count(*) filter (where manual_stats is not null)::int as stated,
         count(*) filter (where manual_stats->'values' ? 'car_spaces')::int as stated_car,
         count(*) filter (where manual_stats->'values' ? 'building_size_sqm')::int as stated_home
  from builder_stock_items where ${LIVE}`);
console.log('\nTOTALS (live = active or staged)');
console.log(JSON.stringify(totals[0]));

// What the brochure-figure reader (doc 57) has done: its records by state,
// standing and reason, how many columns it filled, what is still owed, and
// whether its minute tick is scheduled. Read before the per-row detail so a
// run that is still working says so.
const figureReader = await sql('document figures', `
  select coalesce(document_figures->>'state', '(not read)') as state,
         document_figures->>'standing' as standing,
         document_figures->>'reason' as reason,
         document_figures->>'read_by' as read_by,
         count(*)::int as properties,
         sum((select count(*) from jsonb_object_keys(coalesce(document_figures->'values','{}'::jsonb))))::int as values_stated
  from builder_stock_items where ${LIVE}
  group by 1,2,3,4 order by 5 desc`);
console.log('\nBROCHURE FIGURE READER (by state, standing, reason, read_by)');
for (const row of figureReader) console.log(JSON.stringify(row));
const filledBy = await sql('filled columns', `
  select v.key as column_name,
         count(*)::int as brochure_states_it,
         count(*) filter (where (to_jsonb(i) -> v.key) = v.value)::int as row_holds_that_value
  from builder_stock_items i, jsonb_each(coalesce(i.document_figures->'values','{}'::jsonb)) v
  where i.${LIVE} group by 1 order by 1`);
console.log('figures a brochure stated, and rows now holding exactly that value:', JSON.stringify(filledBy));
const readerState = await sql('reader state', `
  select public.builder_stock_document_figures_pending() as owed,
         (select count(*)::int from cron.job where jobname = 'read-builder-stock-document-figures') as tick_scheduled`);
console.log('reader state:', JSON.stringify(readerState[0]));

// What a property's gallery could hold: its stored images by what the source
// said each one IS, and how many properties hold more than one.
const gallery = await sql('gallery census', `
  select m.source_stage, m.verification_status, m.processing_status,
         coalesce(m.source_detail->>'role', '(none)') as role,
         (m.storage_path is not null or m.external_url is not null) as has_bytes,
         coalesce(m.source_detail->'marketplace'->>'state', '(unjudged)') as marketplace,
         count(*)::int as images, count(distinct m.stock_item_id)::int as properties
  from builder_stock_item_images m join builder_stock_items i on i.id = m.stock_item_id
  where i.${LIVE}
  group by 1,2,3,4,5,6 order by 7 desc`);
console.log('\nGALLERY CENSUS (stage, verification, processing, role, bytes, marketplace)');
for (const row of gallery) console.log(JSON.stringify(row));
const perItem = await sql('images per property', `
  select n as builder_images, count(*)::int as properties from (
    select i.id, count(m.id) filter (where m.source_stage = 'uploaded_document'
      and m.processing_status = 'ready'
      and (m.storage_path is not null or m.external_url is not null)) as n
    from builder_stock_items i left join builder_stock_item_images m on m.stock_item_id = i.id
    where i.${LIVE} group by i.id) q group by 1 order by 1`);
console.log('ready builder images per property:', JSON.stringify(perItem));

const byUpload = await sql('by upload', `
  select i.organisation_id::text as org, i.upload_id::text as upload,
         u.source_type, u.detected_content_type, u.parse_strategy,
         u.original_filename, u.created_at::text as uploaded,
         count(*)::int as live,
         count(*) filter (where i.car_spaces is null)::int as no_car,
         count(*) filter (where i.building_size_sqm is null)::int as no_home,
         count(*) filter (where i.bedrooms is null)::int as no_beds,
         count(*) filter (where i.land_size_sqm is null)::int as no_land
  from builder_stock_items i left join builder_stock_uploads u on u.id = i.upload_id
  where i.${LIVE}
  group by 1,2,3,4,5,6,7 order by 7 desc`);
console.log('\nBY STOCK LIST');
for (const row of byUpload) {
  console.log(JSON.stringify(await redact(row)));
}

const missing = await sql('missing rows', `
  select i.id::text, i.upload_id::text as upload, i.lot_number, i.unit_number,
         i.source_row->>'house_design' as design, i.property_type,
         i.bedrooms, i.bathrooms, i.car_spaces, i.building_size_sqm, i.land_size_sqm,
         i.manual_stats, i.source_row, i.pending_patch is not null as has_pending,
         (select jsonb_object_agg(k, v->>'result') from jsonb_each(coalesce(i.source_provenance_result->'branches','{}'::jsonb)) as b(k, v)) as branches
  from builder_stock_items i
  where i.${LIVE} and (i.car_spaces is null or i.building_size_sqm is null)
  order by i.upload_id, i.lot_number`);
console.log(`\nLIVE PROPERTIES MISSING A CAR COUNT OR A FLOOR AREA: ${missing.length}`);

const keyUnion = new Map<string, Map<string, number>>();
for (const row of missing) {
  const src = (row.source_row ?? {}) as Record<string, unknown>;
  const upload = String(row.upload ?? 'none');
  const keys = keyUnion.get(upload) ?? new Map<string, number>();
  for (const k of Object.keys(src)) keys.set(k, (keys.get(k) ?? 0) + 1);
  const unmapped = (src.unmapped ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(unmapped)) keys.set(`unmapped.${k}`, (keys.get(`unmapped.${k}`) ?? 0) + 1);
  keyUnion.set(upload, keys);

  const links = JSON.stringify(src).match(/https?:\/\/[^"\s]+/g) ?? [];
  console.log('\n---', JSON.stringify(await redact({
    id: row.id, upload, lot: row.lot_number, unit: row.unit_number, design: row.design,
    type: row.property_type,
    held: {
      beds: row.bedrooms, baths: row.bathrooms, cars: row.car_spaces,
      home: row.building_size_sqm, land: row.land_size_sqm,
    },
    stated: (row.manual_stats as { values?: unknown } | null)?.values ?? null,
    pending_patch: row.has_pending,
    links: links.length,
    branches: row.branches,
  })));
  console.log('    figure-like values in the record:',
    JSON.stringify(await redact(Object.fromEntries(figureEntries(src)))));
}

console.log('\nCOLUMNS THE MISSING ROWS CARRY, PER STOCK LIST (column: rows carrying it)');
for (const [upload, keys] of keyUnion) {
  console.log(upload, JSON.stringify(Object.fromEntries([...keys].sort())));
}
