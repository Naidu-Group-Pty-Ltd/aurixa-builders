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

let publicationLineage: string[] = [];

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
    select distinct unnest(replaces_upload_ids)::text as id
      from public.builder_stock_uploads
     where id in (${uploadIds.map((id) => `'${id}'`).join(',')})
       and replaces_upload_ids is not null`);
  const lineage = checkedIds([
    ...uploadIds, ...firstPass.map((r) => String(r.id ?? '')),
  ].filter(Boolean));
  /*
   * A SHEET URL'S QUERY IS THE ANSWER, NOT A SECRET.
   *
   * `safeUrl` drops every query because a signed storage URL is a bearer
   * credential — right for a document address, and wrong for the one field
   * that decides which WORKSHEET an import read. `gid` lives in the query, so
   * printing these through the redactor hides exactly what is being asked.
   * The parameter is named explicitly and every other parameter is reported by
   * NAME only, so nothing a credential could hide in is echoed.
   */
  const describeSheetUrl = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw) return '—';
    let url: URL;
    try { url = new URL(raw); } catch { return safeDetail(raw, 160); }
    const gid = url.searchParams.get('gid');
    const hash = /(?:^|[#&])gid=([0-9]+)/.exec(url.hash ?? '')?.[1] ?? null;
    const others = [...url.searchParams.keys()].filter((k) => k !== 'gid');
    return `${url.origin}${url.pathname}`
      + `  gid=${gid ?? hash ?? 'ABSENT'}${gid === null && hash ? ' (in fragment)' : ''}`
      + (others.length ? `  other params: ${others.join(', ')}` : '');
  };

  publicationLineage = lineage;
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
    const { source_url: src, final_url: fin, ...rest } = row;
    printRow(rest);
    console.log(`  source_url (gid-aware)  : ${describeSheetUrl(src)}`);
    console.log(`  final_url  (gid-aware)  : ${describeSheetUrl(fin)}`);
  }

  /*
   * AND THE BYTES THE IMPORT ACTUALLY BANKED.
   *
   * `repairSourceImages` re-fetches the sheet live and falls back to this
   * stored copy when the fetch fails, so which of the two it worked from is
   * the difference between reading the builder's stock list and reading
   * whatever a gid-less read serves. The size is enough to tell them apart:
   * the hidden tab is ~1.4 KB and the stock list with its merged link columns
   * is ~25 KB.
   */
  const stored = await sql('stored source bytes', `
    select id, storage_bucket, storage_path, byte_size, file_sha256
      from public.builder_stock_uploads
     where id in (${lineage.map((id) => `'${id}'`).join(',')})
     order by created_at`);
  heading('STORED SOURCE COPY — what a fallback read would see');
  for (const row of stored) console.log(`  ${JSON.stringify(row)}`);

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
  /*
   * THE BANKED VERDICTS, WHOLE.
   *
   * `readItemSuppliedEvidence` does not read the manifest at all — it reads
   * `source_row` and THIS column. So whatever is in here is what the settler
   * believes about every branch, and `negativeProvenanceStillStands` keeps an
   * entry standing until the provenance version moves. It is the artefact that
   * decides an `exhausted`, and it is printed in full for that reason.
   */
  const banked = item.source_provenance_result;
  console.log(`  banked     ${banked ? show(banked, 0) : '(none)'}`);
}


/*
 * WHY IS IT NOT PUBLISHED — ASKED OF THE FUNCTION, NOT INFERRED.
 *
 * `publication_blocked_reason` is a SENTENCE about the photograph counts.
 * It is not the whole predicate: `ready` also requires that no source asset
 * is still pending and that enumeration did not fail, and neither appears in
 * that sentence — so an upload can read "1 of 47 without a photo" while a
 * second, unmentioned gate is holding it too, and repairing the one named
 * would change nothing.
 *
 * Three times in one session this state was reasoned about from branch rows
 * and timestamps rather than measured, and one of those readings was wrong.
 * `builder_stock_publication_readiness` is the authority and it is one call,
 * so it is called here, per upload in the lineage, with the two gates it
 * does not return printed beside its answer.
 */
const gateRows = await sql('publication gates', `
  select u.id::text as upload_id,
         r.staged, r.source_outstanding, r.missing_primary, r.failed_items,
         r.ready, r.ready_items, r.first_publication, r.partial_ready,
         (select count(*) from public.builder_stock_source_assets a
           where a.upload_id = u.id and a.state = 'pending') as assets_pending,
         (u.source_manifest_state = 'failed') as manifest_failed,
         (select count(*) from public.builder_stock_items i
           where i.lifecycle_status = 'active'
             and i.upload_id = any(coalesce(u.replaces_upload_ids, '{}'))
             and i.upload_id <> u.id) as superseded_live
    from public.builder_stock_uploads u
    cross join lateral public.builder_stock_publication_readiness(u.id) r
   where u.id in (${publicationLineage.map((id) => `'${id}'`).join(',')})
   order by u.created_at`);
heading('PUBLICATION GATES — the readiness function\'s own answer, per upload');
for (const row of gateRows) {
  console.log('');
  printRow(row);
  /*
   * And the one line an operator actually needs: of everything `ready` and
   * `partial_ready` require, which conditions are currently false. Derived
   * from the columns above rather than restated, so it cannot drift from
   * them.
   */
  const blocking: string[] = [];
  if (Number(row.staged ?? 0) === 0) blocking.push('no properties in scope');
  if (Number(row.missing_primary ?? 0) > 0) blocking.push(`${row.missing_primary} without a ready builder-source photo`);
  if (Number(row.failed_items ?? 0) > 0) blocking.push(`${row.failed_items} failed`);
  if (Number(row.source_outstanding ?? 0) > 0) blocking.push(`${row.source_outstanding} still reading their source`);
  if (Number(row.assets_pending ?? 0) > 0) blocking.push(`${row.assets_pending} source asset(s) still pending`);
  if (String(row.manifest_failed) === 'true') blocking.push('enumeration failed');
  if (Number(row.superseded_live ?? 0) > 0) blocking.push(`replaces a LIVE list (${row.superseded_live} active row(s)) — all-or-nothing`);
  console.log(`  holding it back         : ${blocking.length ? blocking.join('; ') : 'nothing — it should publish on the next tick'}`);
}


/*
 * AND WHETHER THOSE PENDING ROWS ARE ALREADY ANSWERED SOMEWHERE ELSE.
 *
 * THE HYPOTHESIS THIS SETTLES. The manifest is keyed
 * (upload_id, stock_item_id, kind, reference). A REPLACEMENT upload
 * re-enumerates every branch as `pending` under its OWN upload id — but the
 * branch verdicts are banked per-URL in `source_provenance_result` at a
 * provenance version, so the repair does not revisit a branch it has already
 * answered. The new upload's manifest rows would then never resolve, and
 * `assets_settled` could never be true for it: a re-imported list would be
 * permanently unpublishable however good its photographs are.
 *
 * That was inferred from timestamps, which is how two readings went wrong in
 * this investigation already. So it is counted: of this upload's pending
 * rows, how many name a branch that a DIFFERENT upload in the lineage has
 * already resolved? If that is most of them, the story holds; if it is zero,
 * the pending rows are genuinely unanswered work and the story is wrong.
 */
const carryForward = await sql('pending rows already answered elsewhere', `
  select p.upload_id::text as upload_id,
         count(*) as pending_rows,
         count(*) filter (where exists (
           select 1 from public.builder_stock_source_assets q
            where q.stock_item_id = p.stock_item_id
              and q.kind = p.kind
              and q.reference = p.reference
              and q.upload_id <> p.upload_id
              and q.state <> 'pending')) as answered_on_another_upload,
         count(*) filter (where exists (
           select 1 from public.builder_stock_source_assets q
            where q.stock_item_id = p.stock_item_id
              and q.kind = p.kind
              and q.reference = p.reference
              and q.upload_id = p.upload_id
              and q.state <> 'pending')) as answered_on_this_upload
    from public.builder_stock_source_assets p
   where p.state = 'pending'
     and p.upload_id in (${publicationLineage.map((id) => `'${id}'`).join(',')})
   group by p.upload_id`);
heading('PENDING MANIFEST ROWS — is the work already done under another upload?');
for (const row of carryForward) {
  console.log('');
  printRow(row);
  const pending = Number(row.pending_rows ?? 0);
  const elsewhere = Number(row.answered_on_another_upload ?? 0);
  const here = Number(row.answered_on_this_upload ?? 0);
  console.log(`  reading                 : ${
    pending === 0
      ? 'nothing pending'
      : elsewhere + here === 0
        ? 'genuinely unanswered work — these branches have no verdict anywhere'
        : `${elsewhere} of ${pending} already answered on ANOTHER upload`
          + (here ? `, ${here} answered on this one` : '')
          + ' — a re-enumeration wrote pending over work already done'}`);
}


/*
 * AND WHAT THE OTHER PENDING ROWS ARE.
 *
 * The carry-forward count above explains 61% of them. The rest have no
 * verdict on any upload, and there are only two things they can be:
 *
 *   NEVER VISITED — the property was satisfied by an earlier branch and the
 *   repair stopped, so this branch was never opened. Its manifest row is not
 *   outstanding work; it only looks like it.
 *
 *   VISITED BUT KEYED DIFFERENTLY — the branch WAS answered and the verdict
 *   was banked under a different spelling of the same URL, so the manifest
 *   row was never matched. `source_provenance_result` keys carry the raw
 *   link (`…/view?usp=drive_link`) while the manifest stores `reference`, and
 *   if those disagree the resolution can never find its own row.
 *
 * The two want different repairs, so they are counted apart: exact key match,
 * match ignoring the query string, and the state of the property that owns
 * the row. No URL is printed — only counts.
 */
const pendingShape = await sql('what the pending rows are', `
  select p.upload_id::text as upload_id,
         count(*) as pending_rows,
         count(*) filter (where i.image_work_stage = 'settled') as owner_settled,
         count(*) filter (where i.image_work_stage = 'failed') as owner_failed,
         count(*) filter (where i.image_work_stage not in ('settled','failed')) as owner_working,
         count(*) filter (where i.primary_image_id is not null) as owner_has_primary,
         count(*) filter (where position('?' in p.reference) > 0) as reference_carries_query,
         count(*) filter (where coalesce(i.source_provenance_result -> 'branches', '{}'::jsonb) ? p.reference)
           as banked_exact_key,
         count(*) filter (where exists (
           select 1 from jsonb_object_keys(
             coalesce(i.source_provenance_result -> 'branches', '{}'::jsonb)) k
            where split_part(k, '?', 1) = split_part(p.reference, '?', 1)))
           as banked_ignoring_query
    from public.builder_stock_source_assets p
    join public.builder_stock_items i on i.id = p.stock_item_id
   where p.state = 'pending'
     and p.upload_id in (${publicationLineage.map((id) => `'${id}'`).join(',')})
   group by p.upload_id`);
heading('PENDING MANIFEST ROWS — never visited, or answered under another key?');
for (const row of pendingShape) {
  console.log('');
  printRow(row);
  const pending = Number(row.pending_rows ?? 0);
  const exact = Number(row.banked_exact_key ?? 0);
  const loose = Number(row.banked_ignoring_query ?? 0);
  const settled = Number(row.owner_settled ?? 0);
  console.log(`  reading                 : ${
    pending === 0 ? 'nothing pending'
      : loose > exact
        ? `${loose - exact} answered under a DIFFERENT SPELLING of the same URL `
          + '— the manifest reference and the banked key disagree'
        : loose === 0
          ? `none answered anywhere; ${settled} of ${pending} belong to a property that has SETTLED `
            + '— branches never opened because an earlier one answered'
          : `${loose} answered and matched by key`}`);
}


/*
 * WHICH OF THE BUILDER'S DOCUMENTS EACH LIVE CARD'S PHOTOGRAPH CAME OUT OF.
 *
 * THE QUESTION THIS ANSWERS. "Why is the marketplace pulling estate photos —
 * before this there were only property photos?" That has two candidate
 * answers with different remedies, and timestamps alone cannot separate them,
 * which is how two readings in this investigation already went wrong:
 *
 *   A SELECTION CHANGED — a document that used to be ignored is now read, so
 *   pictures that never existed are being stored and shown.
 *
 *   A VISIBILITY CHANGED — the same pictures were being stored all along and
 *   nothing was on the marketplace to show them, so they are newly VISIBLE
 *   rather than newly OCCURRING.
 *
 * Both are measurable from the rows and neither is inferred here. `first_seen`
 * is the earliest this column ever yielded a stored picture for this builder;
 * if that predates the marketplace going live, the pictures are older than the
 * page that shows them and the second answer holds. `properties` is how many
 * live cards that column is currently leading.
 *
 * NOTHING HERE READS A COLUMN NAME TO DECIDE ANYTHING — the pipeline
 * deliberately does not (`sourceBranches.pure.ts`), and neither does this. The
 * heading is provenance, printed so a person can recognise the document; every
 * verdict beside it was reached by the bytes.
 */
if (publicationLineage.length) {
  const lineageList = publicationLineage.map((id) => `'${id}'`).join(',');
  const orgScope = `i.organisation_id in (select organisation_id
      from public.builder_stock_uploads where id in (${lineageList}))`;

  const leadByColumn = await sql('what leads each live card', `
    select coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
             as source_column,
           coalesce(im.source_detail->>'origin', '-') as origin,
           count(*) as properties,
           count(*) filter (where im.source_detail->>'marketplace_display_eligible' = 'true')
             as eligible,
           min(im.created_at)::date as first_stored,
           max(im.created_at)::date as last_stored
      from public.builder_stock_items i
      join public.builder_stock_item_images im on im.id = i.primary_image_id
     where i.lifecycle_status = 'active'
       and ${orgScope}
     group by 1, 2
     order by properties desc, source_column`);
  /*
   * AND THE ACTIVE PROPERTIES THAT CARRY NO PRIMARY IMAGE AT ALL.
   *
   * EVERY OTHER SECTION HERE JOINS ON `primary_image_id`, so a property whose
   * pointer was CLEARED vanishes from all of them — and the counts shrink
   * with no line saying why. `chooseAndStorePrimaryImage` clears rather than
   * leaves a stale pointer, deliberately, so this is the ordinary outcome of
   * a repair that found nothing and it must be visible rather than inferred
   * from a total that no longer adds up.
   */
  const noPrimary = await sql('active cards with no primary image', `
    select count(*) as active_cards,
           count(*) filter (where i.primary_image_id is null) as no_primary_image,
           count(*) filter (where i.image_work_stage = 'settled') as settled,
           count(*) filter (where i.image_work_stage = 'source') as back_at_source,
           count(*) filter (where i.image_work_stage = 'failed') as failed,
           count(*) filter (where i.image_work_stage not in ('settled','source','failed'))
             as mid_ladder
      from public.builder_stock_items as i
     where i.lifecycle_status = 'active'
       and ${orgScope}`);
  heading('LIVE CARDS — the whole active set, including any with no picture');
  for (const row of noPrimary) printRow(row);

  heading('LIVE CARDS — which document each one\'s photograph came out of');
  if (!leadByColumn.length) console.log('  (no active property carries a primary image)');
  for (const row of leadByColumn) {
    console.log(`  ${String(row.properties).padStart(3)} propert${
      Number(row.properties) === 1 ? 'y ' : 'ies'}  ${
      safeDetail(String(row.source_column), 44).padEnd(46)} origin=${
      String(row.origin).padEnd(24)} stored ${row.first_stored} .. ${row.last_stored}`);
  }

  /*
   * AND WHETHER ONE PICTURE IS LEADING SEVERAL CARDS.
   *
   * THE SIGNATURE OF ESTATE COLLATERAL, and the only one that is decisive. A
   * shared DOCUMENT is not a finding — an estate brochure with a page for
   * each house is exactly how a builder files them, and two rows drawing
   * different pages of one PDF are two photographs. A shared PICTURE is the
   * finding: byte-identical imagery on more than one card is one masterplan
   * standing in for several houses, which is what `sharedBranchLinks` refuses
   * and what `countBranchLinkRows` had never once counted before 18 Sep.
   *
   * So both are measured and reported apart.
   */
  const sharedLeads = await sql('is one picture leading several cards', `
    with leads as (
      select i.id,
             coalesce(im.source_detail->>'stored_sha256',
                      im.source_detail->>'source_sha256',
                      im.source_detail->>'marketplace_measured_sha256',
                      im.storage_path, im.external_url) as picture,
             nullif(im.source_detail->>'document', '') as document
        from public.builder_stock_items i
        join public.builder_stock_item_images im on im.id = i.primary_image_id
       where i.lifecycle_status = 'active'
         and ${orgScope})
    select (select count(*) from leads) as live_cards,
           (select count(*) from leads where picture is null) as picture_unidentifiable,
           (select count(*) from leads l
             where l.picture is not null
               and exists (select 1 from leads o
                            where o.picture = l.picture and o.id <> l.id))
             as leading_a_picture_another_card_also_leads,
           (select count(*) from leads l
             where l.document is not null
               and exists (select 1 from leads o
                            where o.document = l.document and o.id <> l.id))
             as drawn_from_a_document_another_card_also_used,
           (select count(distinct document) from leads where document is not null)
             as distinct_documents`);
  heading('LIVE CARDS — is one picture standing in for several houses?');
  for (const row of sharedLeads) {
    printRow(row);
    const shared = Number(row.leading_a_picture_another_card_also_leads ?? 0);
    const sharedDoc = Number(row.drawn_from_a_document_another_card_also_used ?? 0);
    console.log(`  reading                 : ${
      shared === 0
        ? 'no live card leads with a picture any other card leads with'
          + (sharedDoc ? ` — ${sharedDoc} share a DOCUMENT, which is one brochure with a page each` : '')
        : `${shared} card(s) lead with byte-identical imagery — the next section says whether that is one design or one estate plate`}`);
  }

  /*
   * AND WHAT THE SHARING ACTUALLY IS.
   *
   * "32 of 46 cards lead with byte-identical imagery" HAS A LEGITIMATE
   * READING and reporting it as a fault without separating the two would be
   * the same error this investigation has already made twice. A builder sells
   * HOUSE DESIGNS: Lot A and Lot B are both a Sandpiper 24, the brochure
   * carries one facade render of the Sandpiper 24, and both cards showing it
   * is correct — the picture is of the product each lot is selling.
   *
   * One estate masterplan on thirty-two cards is the fault. The two are told
   * apart by what the sharing cards have in common:
   *
   *   SAME DESIGN   every card in the group sells the same house design, so
   *                 the render is of the thing being sold
   *   MIXED         cards selling DIFFERENT designs share one picture, which
   *                 no design render can explain
   *
   * `house_design` lives in `source_row` and is the builder's own word for
   * it, so this asks the source rather than inferring from the picture.
   *
   * The group's size is printed too, because a pair is a design and a group
   * of twenty is an estate plate however the designs read.
   */
  const sharingShape = await sql('what the sharing is', `
    with leads as (
      select i.id,
             nullif(i.source_row->>'house_design', '') as design,
             coalesce(im.source_detail->>'stored_sha256',
                      im.source_detail->>'source_sha256',
                      im.source_detail->>'marketplace_measured_sha256',
                      im.storage_path, im.external_url) as picture,
             coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
               as source_column,
             im.source_detail->>'marketplace_display_eligible' = 'true' as eligible
        from public.builder_stock_items i
        join public.builder_stock_item_images im on im.id = i.primary_image_id
       where i.lifecycle_status = 'active'
         and ${orgScope})
    select picture,
           count(*) as cards,
           count(distinct design) as distinct_designs,
           count(*) filter (where design is null) as cards_with_no_design,
           min(source_column) as source_column,
           bool_and(eligible) as all_eligible
      from leads
     group by picture
    having count(*) > 1
     order by cards desc, source_column
     limit 20`);
  heading('LIVE CARDS — one picture on several cards: same design, or an estate plate?');
  if (!sharingShape.length) console.log('  (no picture leads more than one card)');
  for (const row of sharingShape) {
    const cards = Number(row.cards ?? 0);
    const designs = Number(row.distinct_designs ?? 0);
    const noDesign = Number(row.cards_with_no_design ?? 0);
    const verdict = designs === 1 && noDesign === 0
      ? 'ONE DESIGN — the render is of the product each lot sells'
      : designs === 0
        ? 'NO DESIGN RECORDED on any of them — nothing explains the sharing'
        : `${designs} DIFFERENT DESIGNS${noDesign ? ` (+${noDesign} with none)` : ''}`
          + ' — no design render explains this';
    console.log(`  ${String(cards).padStart(3)} cards  ${
      safeDetail(String(row.source_column), 40).padEnd(42)} eligible=${
      String(row.all_eligible).padEnd(5)}  ${verdict}`);
  }


  /*
   * AND WHICH FILE EACH LEAD CAME OUT OF — BY ITS ADDRESS, NOT ITS NAME.
   *
   * THE BYTE FINGERPRINT NEARLY MISSED HALF OF THEM. A picture recovered from
   * a DOCUMENT carries `stored_sha256` in its detail, so two cards showing the
   * same bytes match on it. A picture taken from a row's own image link
   * (`filed_as_is`) carries neither that nor `source_sha256`, and the fallback
   * the fingerprint would then reach — `storage_path` — is built as
   * `<org>/items/<stock_item_id>/source/…`, so it embeds the property and can
   * NEVER equal another property's: those rows were structurally incapable of
   * matching, which reads exactly like "no two cards share a picture".
   * `marketplace_measured_sha256` is now in the fingerprint ahead of it — the
   * eligibility measure hashes whatever bytes it judged, on every image and
   * every path — so both halves are compared on bytes. This section stays,
   * because the FILE is a different fact from the bytes and it is the one
   * `linkIsExclusiveToRow` is written in terms of.
   *
   * The link is the fact that covers both. Two properties whose photograph
   * came out of the SAME FILE is what `linkIsExclusiveToRow` exists to
   * refuse, so this is also the measure of whether that guard is working —
   * asked of the addresses actually stored on the leading images rather than
   * of the counting function.
   *
   * Grouped by design too, for the same reason as the section above: several
   * cards off one brochure is how a brochure works, and several cards off one
   * IMAGE FILE is one picture on several houses.
   */
  const byFile = await sql('which file each lead came out of', `
    with leads as (
      select i.id,
             nullif(i.source_row->>'house_design', '') as design,
             coalesce(nullif(im.source_detail->>'document_url', ''),
                      im.source_page_url, im.source_reference) as file_address,
             coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
               as source_column,
             coalesce(im.source_detail->>'origin', '-') as origin
        from public.builder_stock_items i
        join public.builder_stock_item_images im on im.id = i.primary_image_id
       where i.lifecycle_status = 'active'
         and ${orgScope})
    select source_column, origin,
           count(distinct file_address) as distinct_files,
           count(*) as cards,
           max(per_file.cards_on_this_file) as most_cards_on_one_file,
           max(per_file.designs_on_this_file) as most_designs_on_one_file
      from leads
      join lateral (
        select count(*) as cards_on_this_file,
               count(distinct l2.design) as designs_on_this_file
          from leads l2 where l2.file_address = leads.file_address) as per_file on true
     group by source_column, origin
     order by cards desc`);
  heading('LIVE CARDS — how many distinct FILES the 46 photographs came out of');
  for (const row of byFile) {
    console.log(`  ${safeDetail(String(row.source_column), 40).padEnd(42)} ${
      String(row.cards).padStart(3)} card(s) from ${
      String(row.distinct_files).padStart(3)} file(s)   busiest file: ${
      String(row.most_cards_on_one_file).padStart(2)} card(s) across ${
      String(row.most_designs_on_one_file).padStart(2)} design(s)   origin=${row.origin}`);
  }
  /*
   * AND HOW MANY OF THE 46 ACTUALLY DRAW A PICTURE.
   *
   * A DIFFERENT QUESTION FROM `primary_image_id IS NOT NULL`, and the gap
   * between them is a blank card. Publication tests the photograph's
   * PROVENANCE (`builder_stock_photo_is_source_ready`: the builder's own
   * document, source-supplied, ready); the marketplace measure decides
   * separately whether that picture may be DRAWN. A property can therefore
   * publish with a primary image the card refuses to show, and every surface
   * reports it as a property with a photograph.
   */
  const drawable = await sql('how many live cards draw a picture', `
    select coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
             as source_column,
           count(*) as live_cards,
           count(*) filter (where im.source_detail->>'marketplace_display_eligible' = 'true')
             as draws_a_picture,
           count(*) filter (where im.source_detail->>'marketplace_rejection_reason' is not null)
             as blank_because_refused,
           min(im.source_detail->>'marketplace_rejection_reason') as a_reason
      from public.builder_stock_items i
      join public.builder_stock_item_images im on im.id = i.primary_image_id
     where i.lifecycle_status = 'active'
       and ${orgScope}
     group by 1
     order by live_cards desc`);
  heading('LIVE CARDS — how many actually draw a picture');
  let totalCards = 0; let totalDrawn = 0;
  for (const row of drawable) {
    totalCards += Number(row.live_cards ?? 0);
    totalDrawn += Number(row.draws_a_picture ?? 0);
    console.log(`  ${safeDetail(String(row.source_column), 44).padEnd(46)} ${
      String(row.live_cards).padStart(3)} card(s)  draws=${
      String(row.draws_a_picture).padStart(3)}  blank=${
      String(row.blank_because_refused).padStart(3)}${
      Number(row.blank_because_refused) ? `  (${row.a_reason})` : ''}`);
  }
  console.log(`  ${'-'.repeat(46)} ${String(totalCards).padStart(3)} card(s)  draws=${
    String(totalDrawn).padStart(3)}  blank=${String(totalCards - totalDrawn).padStart(3)}`);


  /*
   * AND WHAT THE ESTATE-LED PROPERTIES' OWN BROCHURE SAID.
   *
   * THE REMEDY TURNS ON THIS AND NOTHING ELSE. If a property leading with a
   * siting plan or an estate map ALSO holds a photograph out of its own
   * brochure, then the ordering picked the wrong one of two and the fix is
   * free. If its brochure yielded nothing, the estate picture is the only
   * image that property has, and refusing it is a decision to show a blank
   * card — which is a commercial question and not a technical one.
   *
   * Arithmetic already implies the second (33 brochure images, 33 of them
   * leading, so no other live property holds one), but an implication is not
   * a measurement and this investigation has already paid for the difference
   * twice. So it is asked directly, with the brochure branch's own verdict
   * beside it — the branch record's `state` and `state_detail`, which is the
   * pipeline's sentence about that document and never this script's.
   */
  const estateLed = await sql('what the estate-led properties own brochure said', `
    with led as (
      select i.id,
             coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
               as lead_column
        from public.builder_stock_items i
        join public.builder_stock_item_images im on im.id = i.primary_image_id
       where i.lifecycle_status = 'active'
         and ${orgScope})
    select led.lead_column,
           count(*) as properties,
           count(*) filter (where exists (
             select 1 from public.builder_stock_item_images b
              where b.stock_item_id = led.id
                and b.source_detail->>'source_column' ilike '%brochure%'
                and b.source_detail->>'source_column' not ilike '%estate%')) as also_hold_a_brochure_image,
           count(*) filter (where exists (
             select 1 from public.builder_stock_source_assets a
              where a.stock_item_id = led.id
                and a.column_header ilike '%brochure%'
                and a.column_header not ilike '%estate%'
                and a.state = 'no_image')) as brochure_branch_answered_no_image,
           count(*) filter (where exists (
             select 1 from public.builder_stock_source_assets a
              where a.stock_item_id = led.id
                and a.column_header ilike '%brochure%'
                and a.column_header not ilike '%estate%'
                and a.state in ('unreadable','unsupported','failed'))) as brochure_branch_could_not_be_read,
           count(*) filter (where not exists (
             select 1 from public.builder_stock_source_assets a
              where a.stock_item_id = led.id
                and a.column_header ilike '%brochure%'
                and a.column_header not ilike '%estate%')) as no_brochure_branch_at_all
      from led
     group by led.lead_column
     order by properties desc`);
  heading('ESTATE-LED CARDS — did the property have a brochure photograph to show instead?');
  for (const row of estateLed) {
    console.log(`  ${safeDetail(String(row.lead_column), 40).padEnd(42)} ${
      String(row.properties).padStart(3)} propert${Number(row.properties) === 1 ? 'y ' : 'ies'
      }  also hold a brochure image=${String(row.also_hold_a_brochure_image).padStart(2)
      }  brochure said no image=${String(row.brochure_branch_answered_no_image).padStart(2)
      }  unreadable=${String(row.brochure_branch_could_not_be_read).padStart(2)
      }  no brochure link=${String(row.no_brochure_branch_at_all).padStart(2)}`);
  }


  /*
   * AND WHAT STATE THEIR BROCHURE BRANCH IS ACTUALLY IN.
   *
   * The section above asked three specific things of it — did it answer
   * `no_image`, was it unreadable, was there a brochure link at all — and the
   * answer to all three was zero for all thirteen estate-led properties. That
   * rules out every reading in which the brochure was tried and had nothing
   * to give, and leaves the one this asks for by name: the state the branch is
   * in. A brochure that was never opened is a different fact from a brochure
   * that was opened and named no image, and only one of them is about the
   * builder's document.
   *
   * Printed as the raw state and the branch's own sentence, both the
   * pipeline's words, so no reading here is this script's.
   */
  const brochureBranchState = await sql('the estate-led properties brochure branch', `
    with led as (
      select i.id,
             coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
               as lead_column
        from public.builder_stock_items i
        join public.builder_stock_item_images im on im.id = i.primary_image_id
       where i.lifecycle_status = 'active'
         and ${orgScope})
    select led.lead_column, a.state,
           count(*) as branches,
           count(distinct led.id) as properties,
           min(a.attempts) as fewest_attempts, max(a.attempts) as most_attempts,
           min(a.state_detail) as a_sentence
      from led
      join public.builder_stock_source_assets a on a.stock_item_id = led.id
     where a.column_header ilike '%brochure%'
       and a.column_header not ilike '%estate%'
     group by led.lead_column, a.state
     order by led.lead_column, branches desc`);
  heading('ESTATE-LED CARDS — the state of their own brochure branch');
  for (const row of brochureBranchState) {
    console.log(`  ${safeDetail(String(row.lead_column), 38).padEnd(40)} ${
      String(row.state).padEnd(14)} ${String(row.branches).padStart(3)} branch(es) / ${
      String(row.properties).padStart(3)} propert${Number(row.properties) === 1 ? 'y' : 'ies'
      }  attempts ${row.fewest_attempts}..${row.most_attempts}`);
    if (row.a_sentence) {
      console.log(`     WHY: ${safeDetail(String(row.a_sentence), 200)}`);
    }
  }
  /*
   * AND WHEN, TO THE HOUR.
   *
   * "Why is this happening NOW" is a question about a clock, and a date is
   * too coarse to answer it — every one of these images was stored on
   * 18 September. The hour separates "the estate pictures arrived in the same
   * pass as the brochure ones" from "the easy properties settled first and
   * the hard ones fell back later", which are different stories about the
   * same day.
   */
  const timeline = await sql('when each lead was stored, by hour', `
    select to_char(date_trunc('hour', im.created_at at time zone 'UTC'), 'MM-DD HH24:00') as hour_utc,
           count(*) filter (where im.source_detail->>'source_column' ilike 'brochure%') as brochure,
           count(*) filter (where im.source_detail->>'source_column' not ilike 'brochure%') as other_document,
           count(*) as leads_stored
      from public.builder_stock_items i
      join public.builder_stock_item_images im on im.id = i.primary_image_id
     where i.lifecycle_status = 'active'
       and ${orgScope}
     group by 1
     order by 1`);
  heading('LIVE CARDS — the hour each leading photograph was stored (UTC)');
  for (const row of timeline) {
    console.log(`  ${row.hour_utc}   brochure=${String(row.brochure).padStart(3)}  other document=${
      String(row.other_document).padStart(3)}  total=${String(row.leads_stored).padStart(3)}`);
  }
  /*
   * AND WHEN EACH COLUMN FIRST YIELDED ANYTHING AT ALL.
   *
   * Every stored image for this builder, not only the ones leading a card,
   * because the question is when the pipeline STARTED taking pictures out of
   * a document — not when one reached a page. A column whose first picture
   * predates the marketplace going live was being read all along.
   */
  const everStored = await sql('every stored image by column', `
    select coalesce(nullif(im.source_detail->>'source_column', ''), '(the row''s own cell)')
             as source_column,
           count(*) as images,
           count(*) filter (where im.id = i.primary_image_id) as leading_a_card,
           count(*) filter (where im.source_detail->>'marketplace_display_eligible' = 'true')
             as eligible,
           count(*) filter (where im.source_detail->>'marketplace_rejection_reason' is not null)
             as refused,
           min(im.created_at)::date as first_seen,
           max(im.created_at)::date as last_seen
      from public.builder_stock_item_images im
      join public.builder_stock_items i on i.id = im.stock_item_id
     where ${orgScope}
     group by 1
     order by first_seen, images desc`);
  heading('EVERY STORED IMAGE — when each document first yielded one');
  for (const row of everStored) {
    console.log(`  ${safeDetail(String(row.source_column), 44).padEnd(46)} ${
      String(row.images).padStart(3)} image(s)  leading=${
      String(row.leading_a_card).padStart(2)}  eligible=${
      String(row.eligible).padStart(2)}  refused=${
      String(row.refused).padStart(2)}  first=${row.first_seen}  last=${row.last_seen}`);
  }

  /*
   * AND WHAT THE TWO GUARDS HAVE ACTUALLY REFUSED.
   *
   * `state_detail` is the branch's own sentence, so the refusals are counted
   * by matching it rather than by re-deriving the rule here — this script
   * must never restate a decision the pipeline made, which is how a
   * diagnostic comes to disagree with production.
   */
  const refusals = await sql('what the guards refused', `
    select case
             when a.state_detail ilike '%estate collateral%' then 'shared link: estate collateral'
             when a.state_detail ilike '%declares it to be collateral%' then 'file name declares it collateral'
             else 'other' end as guard,
           count(*) as branches,
           count(distinct a.stock_item_id) as properties,
           min(a.updated_at)::date as first, max(a.updated_at)::date as last
      from public.builder_stock_source_assets a
      join public.builder_stock_items i on i.id = a.stock_item_id
     where ${orgScope}
       and (a.state_detail ilike '%estate collateral%'
            or a.state_detail ilike '%declares it to be collateral%')
     group by 1
     order by branches desc`);
  heading('THE ESTATE GUARDS — what they have refused, and since when');
  if (!refusals.length) console.log('  (nothing has been refused as collateral)');
  for (const row of refusals) {
    console.log(`  ${String(row.guard).padEnd(40)} ${String(row.branches).padStart(3)} branch(es) across ${
      String(row.properties).padStart(3)} propert${Number(row.properties) === 1 ? 'y' : 'ies'
      }  ${row.first} .. ${row.last}`);
  }
}
console.log('\nRead-only run complete. Nothing was written.');
