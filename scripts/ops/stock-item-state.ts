/**
 * BUILDER STOCK — THE EXACT STATE OF NAMED STOCK ITEMS. Read-only.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `stock-source-forensics.ts`. That script
 * answers "what do the builder's documents contain, and would the pipeline
 * recover them?" — it fetches, elects and censuses. This one answers the
 * question that comes BEFORE it: what does the database actually SAY happened
 * to these rows? On 18 September 2026 five properties were retired as
 * `exhausted` — "every source was read and none names an image" — while their
 * brochures each carry a clean facade on page 1 that the deployed worker
 * elects in about 1.3 seconds. The verdict is false. Which transition first
 * departed from the intended one is not knowable from the documents, only
 * from the rows.
 *
 * THE FIRST ATTEMPT AT THAT ANSWER WAS WRONG, WHICH IS WHY THIS IS A TOOL AND
 * NOT A THEORY. The failures were attributed to an unconfigured PDF worker
 * falling back to an in-process election that the Edge CPU limit killed. The
 * worker was in fact deployed at 02:55:28Z and the runtime pointed at it at
 * 02:55:56Z, both before the failing import. A diagnosis built on what the
 * code could do rather than on what the rows record is how that happened; so
 * this prints rows.
 *
 * WRITES NOTHING. Every statement is a SELECT, and there is no code path here
 * that can emit anything else — `sql()` refuses a statement that does not
 * begin with `select` or `with`, which is a property of this file rather than
 * a promise about how it is called.
 *
 * NOTHING SENSITIVE IS PRINTED. The access token is read from the environment
 * and never echoed. Every value goes through the pipeline's own redactors
 * (`importTelemetry.pure.ts`), so a signed URL loses its query and a bearer
 * token in a stored detail string is stripped — these logs are readable by
 * everyone with repository access.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-item-state.ts [id,id,...]
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF and STOCK_ITEM_IDS.
 */
import {
  safeDetail, safeUrl,
} from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

/**
 * The five properties the 18 September import retired, as reported.
 *
 * A DEFAULT, NEVER AN ASSERTION. Which lot each id belongs to is exactly what
 * this script is for; nothing here assumes the reported lot mapping is right.
 */
const DEFAULT_IDS = [
  'ad67b1ef-0c2c-4429-9244-ae4e6386168e',
  'ca077a36-24d2-4a47-8c7c-0bf26ae7099f',
  '69cf9452-c525-4e87-8529-2908170937ed',
  'ad64c3c4-fcd0-44ef-bc96-58ba1a09f713',
  '4683b34c-5a4d-44e9-a8c7-b50e04609c74',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids are CHECKED, never quoted and hoped for.
 *
 * The same rule the Airtable broker answers to: a caller may name rows and may
 * not ask questions. Thirty-six characters of hex and hyphen can hold no
 * quote, comma or operator, so the composed `in (...)` cannot become a second
 * statement however the value arrived.
 */
function checkedIds(raw: string[]): string[] {
  const ids = raw.map((id) => id.trim()).filter(Boolean);
  const bad = ids.filter((id) => !UUID.test(id));
  if (bad.length) {
    console.error(`Not stock item ids: ${bad.map((id) => safeDetail(id, 60)).join(', ')}`);
    Deno.exit(1);
  }
  return [...new Set(ids)];
}

/*
 * `||`, NOT `??`. A dispatch input left blank arrives as the EMPTY STRING,
 * which is not nullish — so `??` would hand `checkedIds` an empty list and the
 * run would read nothing while reporting success.
 */
const ITEM_IDS = checkedIds(
  (Deno.args[0] || Deno.env.get('STOCK_ITEM_IDS') || DEFAULT_IDS.join(',')).split(','),
);

/*
 * COMPACT BY DEFAULT.
 *
 * The full dump is every column of every related row, which is the right thing
 * to have and the wrong thing to read: the first run printed ~2,000 lines and
 * the four fields that decide the question were somewhere in the middle. The
 * trace below is those fields; `VERBOSE=1` adds the dump back underneath it.
 */
const VERBOSE = (Deno.env.get('VERBOSE') || '') !== '';
const inList = ITEM_IDS.map((id) => `'${id}'`).join(',');

/** SELECT only. The label is logged; the statement never is. */
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

/**
 * One stored value, printed so a reader can act on it.
 *
 * Objects are printed whole rather than summarised — a provenance blob IS the
 * evidence — but every string inside one goes through the redactors, because
 * `source_row` carries the builder's own document URLs and a stored detail can
 * quote a provider's refusal back at us verbatim.
 */
function show(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return safeUrl(value, 200) ?? '—';
    return safeDetail(value, depth === 0 ? 600 : 300);
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => `      ${show(v, depth + 1)}`).join(',\n')}\n    ]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `      ${k}: ${show(v, depth + 1)}`).join('\n')}\n    }`;
  }
  return safeDetail(String(value), 300);
}

function printRow(row: Record<string, unknown>, indent = '  '): void {
  const width = Math.max(...Object.keys(row).map((k) => k.length));
  for (const [key, value] of Object.entries(row)) {
    console.log(`${indent}${key.padEnd(width)} : ${show(value)}`);
  }
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(96)}\n${text}\n${'='.repeat(96)}`);
}

// ---------------------------------------------------------------------------
// 1. The schema, so nothing below is guessed.
//
// A mistyped column name is invisible against PostgREST and merely noisy
// against this endpoint, but either way it wastes a run. These tables are read
// from the catalogue and the SELECTs below are `*`, so what prints is whatever
// production actually has.
// ---------------------------------------------------------------------------
heading(`STOCK ITEM STATE — ${ITEM_IDS.length} item(s) on ${PROJECT_REF}`);
console.log(`ids: ${ITEM_IDS.join(', ')}`);

const columns = VERBOSE ? await sql('schema', `
  select table_name, column_name, data_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name like 'builder_stock%'
   order by table_name, ordinal_position`) : [];

if (VERBOSE) {
  const byTable = new Map<string, string[]>();
  for (const row of columns) {
    const table = String(row.table_name);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push(`${row.column_name}:${row.data_type}`);
  }
  heading('SCHEMA (public.builder_stock*)');
  for (const [table, cols] of byTable) console.log(`\n${table}\n  ${cols.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// 2. The items themselves, whole.
// ---------------------------------------------------------------------------
const items = await sql('items', `select * from public.builder_stock_items where id in (${inList})`);
heading(`ITEMS — ${items.length} of ${ITEM_IDS.length} found`);
const missing = ITEM_IDS.filter((id) => !items.some((row) => String(row.id) === id));
if (missing.length) console.log(`NOT FOUND: ${missing.join(', ')}`);

/*
 * THE FIELDS THAT DECIDE THE QUESTION, on one line each.
 *
 * `image_work_last_result` is what the settler said when it gave the row back,
 * and `source_provenance_result` is what was BANKED about the document — the
 * two that separate "we looked and there is nothing" from "we stopped".
 */
const TRACE_FIELDS = [
  'external_reference', 'lot_number', 'house_design', 'development_name',
  'lifecycle_status', 'image_work_stage', 'image_work_attempts', 'image_work_failures',
  'image_work_last_result', 'primary_image_id', 'enrichment_status',
  'upload_id', 'pending_upload_id', 'image_runtime_version', 'source_provenance_result',
  'created_at', 'updated_at', 'enriched_at',
];
for (const item of items) {
  console.log(`\n${'-'.repeat(96)}\nitem ${item.id}\n${'-'.repeat(96)}`);
  const present: Record<string, unknown> = {};
  for (const field of TRACE_FIELDS) if (field in item) present[field] = item[field];
  printRow(present);
  if (VERBOSE) {
    console.log('  --- every other column ---');
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (!(k in present)) rest[k] = v;
    printRow(rest, '  ');
  }
}

if (!items.length) {
  console.log('\nNo rows. Nothing further can be read.');
  Deno.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Everything keyed on them.
//
// `builder_stock_source_assets` is the branch-by-branch record — what was
// found on the row, what was attempted against it and how it ended — and it is
// the table that decides whether `exhausted` was a statement about a document
// or about us. `builder_stock_item_images` is what, if anything, was stored.
// ---------------------------------------------------------------------------
for (const [label, statement] of [
  ['SOURCE ASSETS (branch records — what was attempted against each link)',
    VERBOSE
      ? `select * from public.builder_stock_source_assets
          where stock_item_id in (${inList})
          order by stock_item_id, kind, reference`
      : `select stock_item_id, kind, branch_kind, column_header, reference,
                state, state_detail, attempts, image_id, content_sha256, byte_size,
                enumerated_at, updated_at
           from public.builder_stock_source_assets
          where stock_item_id in (${inList})
          order by stock_item_id, kind, reference`],
  ['STORED IMAGES — what was actually recovered and filed',
    VERBOSE
      ? `select * from public.builder_stock_item_images
          where stock_item_id in (${inList})
          order by stock_item_id, created_at`
      : `select id, stock_item_id, source_stage, source_reference, source_provider,
                source_page_url, content_type, byte_size, verification_status,
                processing_status, position, created_at,
                source_detail->>'role'                          as role,
                source_detail->>'origin'                        as origin,
                source_detail->>'source_column'                 as source_column,
                source_detail->>'role_evidence'                 as role_evidence,
                source_detail->>'role_evidence_level'           as role_evidence_level,
                source_detail->>'extraction_method'             as extraction_method,
                source_detail->>'provenance_version'            as provenance_version,
                source_detail->>'original_sha256'               as sha256,
                source_detail->>'marketplace_display_eligible'  as display_eligible,
                source_detail->>'marketplace_rejection_reason'  as rejection_reason,
                source_detail->>'marketplace_eligibility_state' as eligibility_state
           from public.builder_stock_item_images
          where stock_item_id in (${inList})
          order by stock_item_id, created_at`],
] as Array<[string, string]>) {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await sql(label, statement);
  } catch (error) {
    // A table this deployment does not have is a fact worth printing, not a
    // reason to abandon the run.
    heading(`${label} — UNREADABLE`);
    console.log(safeDetail(error, 300));
    continue;
  }
  heading(`${label} — ${rows.length} row(s)`);
  for (const row of rows) {
    console.log('');
    printRow(row);
  }
}

// ---------------------------------------------------------------------------
// 4. The uploads either side of the cutover.
//
// A matched row's `upload_id` is still the OLD one until publication, so the
// upload actually waiting on these properties is `pending_upload_id`. Reading
// only one of the two is how a trace comes to describe the wrong dataset.
// ---------------------------------------------------------------------------
const uploadIds = checkedIds([
  ...items.map((item) => String(item.upload_id ?? '')),
  ...items.map((item) => String(item.pending_upload_id ?? '')),
].filter(Boolean));

if (uploadIds.length) {
  /*
   * AND THE UPLOADS THIS ONE REPLACED.
   *
   * A branch verdict is written under the upload that was current when the
   * work ran, and a replacement upload re-enumerates the same branches as new
   * rows. Reading only the current upload therefore shows a manifest whose
   * verdicts were reached against a DIFFERENT parse of the builder's list —
   * which is exactly the confusion these five rows turned on.
   */
  const firstPass = await sql('replaced uploads', `
    select distinct jsonb_array_elements_text(replaces_upload_ids) as id
      from public.builder_stock_uploads
     where id in (${uploadIds.map((id) => `'${id}'`).join(',')})
       and replaces_upload_ids is not null`);
  const lineage = checkedIds([
    ...uploadIds, ...firstPass.map((r) => String(r.id ?? '')),
  ].filter(Boolean));
  const uploads = await sql('uploads', `
    select id, created_at, source_type, source_url, final_url, parse_strategy,
           records_detected, records_imported, records_updated, records_failed,
           status, error_code, source_manifest_state, image_failure_state,
           published_at, replaces_upload_ids, publication_blocked_reason
      from public.builder_stock_uploads
     where id in (${lineage.map((id) => `'${id}'`).join(',')})
     order by created_at`);
  heading(`UPLOADS — ${uploads.length} row(s)`);
  for (const row of uploads) {
    console.log('');
    printRow(row);
  }

  // How the rest of each upload fared, which is what says whether these five
  // are the exception or the rule.
  const cohort = await sql('upload cohort', `
    select upload_id, pending_upload_id, lifecycle_status, image_work_stage,
           count(*) as items,
           count(primary_image_id) as with_primary
      from public.builder_stock_items
     where upload_id in (${uploadIds.map((id) => `'${id}'`).join(',')})
        or pending_upload_id in (${uploadIds.map((id) => `'${id}'`).join(',')})
     group by 1, 2, 3, 4
     order by 1, 2, 3, 4`);
  heading(`UPLOAD COHORT — how every row of those uploads ended`);
  for (const row of cohort) console.log(`  ${JSON.stringify(row)}`);
}

// ---------------------------------------------------------------------------
// 5. One line per property.
//
// THE WHOLE TRACE ON ONE ROW, because this is the view that is read again
// after every recovery tick and a full dump cannot be compared tick to tick.
// Branches are printed as `column=state`, in the order they were enumerated,
// because WHICH COLUMN a stored image came from is the question these five
// turned on: a facade and a siting diagram are different pictures and the
// column header is the only thing on the row that says which is which.
// ---------------------------------------------------------------------------
const assets = await sql('branch summary', `
  select stock_item_id, column_header, state, reference, state_detail,
         attempts, updated_at
    from public.builder_stock_source_assets
   where stock_item_id in (${inList})
   order by stock_item_id, column_header, state`);

/*
 * THE DESIGN IS NOT A COLUMN ON `builder_stock_items`.
 *
 * It lives in `source_row`, and reading it as a column printed `—` on every
 * row — a statement about this script rather than about the data, and exactly
 * the class of mistake `check-edge-column-names.mjs` exists to catch. It
 * matters here because the design is half of the identity an election matches
 * a brochure against.
 */
const identity = await sql('row identity', `
  select id,
         source_row->>'house_design'     as house_design,
         source_row->>'lot_number'       as row_lot,
         source_row->>'development_name' as row_development,
         source_row->>'address_line'     as row_address
    from public.builder_stock_items
   where id in (${inList})`);
const images = await sql('image summary', `
  select stock_item_id,
         source_detail->>'source_column' as source_column,
         source_detail->>'role'          as role,
         source_detail->>'marketplace_display_eligible' as eligible,
         source_detail->>'marketplace_rejection_reason' as rejection,
         processing_status, byte_size
    from public.builder_stock_item_images
   where stock_item_id in (${inList})
   order by stock_item_id, created_at`);

heading('TRACE — one line per property');
for (const item of items) {
  const id = String(item.id);
  const branches = assets.filter((a) => String(a.stock_item_id) === id);
  const row = identity.find((r) => String(r.id) === id) ?? {};
  const stored = images.filter((i) => String(i.stock_item_id) === id)
    .map((i) => `${safeDetail(String(i.source_column ?? '?'), 40)} -> role=${i.role} ${
      i.eligible === 'true' ? 'ELIGIBLE' : `INELIGIBLE(${i.rejection ?? '?'})`}`);
  console.log(`\n${item.external_reference ?? id.slice(0, 8)}  lot=${
    item.lot_number ?? '—'}  design=${row.house_design ?? '—'}  ${
    item.development_name ?? '—'}`);
  console.log(`  id         ${id}`);
  console.log(`  state      lifecycle=${item.lifecycle_status} stage=${
    item.image_work_stage} attempts=${item.image_work_attempts} primary=${
    item.primary_image_id ? 'set' : 'NONE'}`);
  console.log(`  last       ${safeDetail(String(item.image_work_last_result ?? '—'), 200)}`);
  if (!branches.length) console.log('  branches   (none enumerated)');
  for (const branch of branches) {
    console.log(`  branch     ${safeDetail(String(branch.column_header ?? 'embedded'), 44)
      .padEnd(36)} ${String(branch.state).padEnd(10)} attempts=${branch.attempts
      }  enumerated=${branch.enumerated_at} updated=${branch.updated_at}`);
    console.log(`             ${safeUrl(String(branch.reference ?? ''), 110) ?? '—'}`);
    if (branch.state_detail) {
      console.log(`             WHY: ${safeDetail(String(branch.state_detail), 240)}`);
    }
  }
  for (const line of stored) console.log(`  stored     ${line}`);
  if (!stored.length) console.log('  stored     (nothing)');
}

console.log('\nRead-only run complete. Nothing was written.');
