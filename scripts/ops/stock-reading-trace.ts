/**
 * BUILDER STOCK — READING TRACE. Read-only, evidence-producing.
 *
 * Answers ONE question for a named stored document: what did the
 * deterministic PDF reader SEE, and what did it make of it?
 *
 * The import log records the reader's CONCLUSIONS — `fields_read`,
 * `visual_only`, `read_by`, and the lines it set aside — and those are enough
 * to say that a document was read badly, never enough to say why. The why is
 * in the page's own geometry: which runs share a baseline, which sit above
 * which, what size each was set at, and how the reader grouped them into the
 * lines and cells every rule downstream consumes. None of that is persisted,
 * so a defect report about a real brochure could until now only be answered
 * by reconstructing the brochure, which is a statement about the
 * reconstruction.
 *
 * So this runs the pipeline's OWN readers over the stored bytes — the same
 * modules, the same inputs the import hands them — and prints each layer:
 *
 *   the flattened page text     `readPdfPageTexts`, what `pageTexts` holds
 *   the positioned runs         `readPdfTextLayout`, every run with its
 *                               x, y, advance and drawn height
 *   the reader's lines          `layoutLines`, the rows and cells the brochure
 *                               reader actually reasons over
 *   the reading                 `readPdfDeterministicRows`, its rows, status,
 *                               diagnostics and the lines it set aside
 *
 * WRITES NOTHING. The database is read by SELECT through the Management API;
 * the stored object is read with a GET. No row, no object, no log line and no
 * cache is written anywhere, and the document's bytes never leave this
 * process — only what the readers made of them is printed.
 *
 * The access token is read from the environment and never printed; the SQL
 * text is never logged.
 *
 *   TRACE_UPLOAD_IDS   comma-separated upload ids (validated as uuids)
 *   TRACE_PAGES        pages whose text, runs and lines are printed in full
 *                      (default `1`); every other page is summarised by its
 *                      line count, because a seven-page brochure is five pages
 *                      of specification copy and the reading below says which
 *                      of its lines mattered
 */
import { readPdfPageTexts } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import { readPdfTextLayout } from '../../supabase/functions/_shared/builderStock/pdfTextLayout.ts';
import {
  layoutLines, readPdfDeterministicRows,
} from '../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts';
import { STOCK_LIST_BUCKET } from '../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';
import { DETERMINISTIC_READER_VERSION } from '../../supabase/functions/_shared/builderStock/readerVersion.pure.ts';
import { traceWhatTheTextLayerCannotSee } from './stockPageBeyondText.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uploadIds = (Deno.env.get('TRACE_UPLOAD_IDS') || '')
  .split(',').map((id) => id.trim().toLowerCase()).filter(Boolean);
if (!uploadIds.length || uploadIds.some((id) => !UUID.test(id))) {
  console.error('TRACE_UPLOAD_IDS must be one or more upload ids (uuids), comma-separated.');
  Deno.exit(1);
}
const fullPages = new Set((Deno.env.get('TRACE_PAGES') || '1')
  .split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0));

/** A document the reader is asked to trace is bounded like a stock list is. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Flattened lines printed per page; the rest are counted, not dropped silently. */
const MAX_TEXT_LINES = 160;

/** Run SQL on the live project. Logs the LABEL only — never the SQL. */
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
    throw new Error(`[${label}] management query failed ${response.status}: ${body.slice(0, 400)}`);
  }
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

/** The project's storage endpoint and service key, from the token this run holds. */
async function storageAuth(): Promise<{ base: string; headers: Record<string, string> }> {
  const keys = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  if (!keys.ok) throw new Error(`api-keys: HTTP ${keys.status}`);
  const body = await keys.json() as Array<{ name?: string; type?: string; api_key?: string }>;
  const service = (Array.isArray(body) ? body : []).find(
    (k) => k?.name === 'service_role' || k?.type === 'secret');
  if (!service?.api_key) throw new Error('api-keys: no service_role key in the response');
  return {
    base: `https://${PROJECT_REF}.supabase.co/storage/v1`,
    headers: { Authorization: `Bearer ${service.api_key}`, apikey: service.api_key },
  };
}

const n1 = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : '?').padStart(6);
const quote = (text: string) => JSON.stringify(text);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const rows = await sql('uploads', `
  SELECT u.id, u.organisation_id, u.original_filename, u.storage_path, u.source_type,
         u.status, u.parse_strategy, u.reader_settled_version, u.deleted_at,
         o.trading_name, o.legal_name
    FROM public.builder_stock_uploads u
    LEFT JOIN public.builder_organisations o ON o.id = u.organisation_id
   WHERE u.id IN (${uploadIds.map(literal).join(', ')})`);

console.log(`reading trace · reader version ${DETERMINISTIC_READER_VERSION} · ${uploadIds.length} upload(s)`);
const storage = await storageAuth();
let failures = 0;

for (const id of uploadIds) {
  const upload = rows.find((row) => String(row.id) === id);
  console.log(`\n${'='.repeat(100)}\nupload ${id}`);
  if (!upload) {
    console.log('  not found');
    failures++;
    continue;
  }
  const filename = String(upload.original_filename ?? '');
  const organisationName = (upload.trading_name ?? upload.legal_name ?? null) as string | null;
  console.log(`  file ${quote(filename)} · source ${upload.source_type} · status ${upload.status}`
    + ` · strategy ${upload.parse_strategy} · settled at reader ${upload.reader_settled_version}`
    + `${upload.deleted_at ? ' · DELETED' : ''}`);
  console.log(`  organisation ${upload.organisation_id} (${quote(String(organisationName ?? ''))})`);
  if (upload.source_type !== 'file' || !upload.storage_path) {
    console.log('  not a stored file; a linked source is fetched, not stored, and is not traced here');
    continue;
  }

  const response = await fetch(
    `${storage.base}/object/${STOCK_LIST_BUCKET}/${String(upload.storage_path)}`,
    { headers: storage.headers },
  );
  if (!response.ok) {
    console.log(`  stored object unreadable: HTTP ${response.status}`);
    failures++;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    console.log(`  stored object is ${bytes.byteLength} bytes, past the trace ceiling`);
    failures++;
    continue;
  }
  console.log(`  source ${bytes.byteLength} bytes · sha256 ${await sha256(bytes)}`);

  // The SAME inputs the import hands the reader: see `extract.ts`.
  const pageTexts = await readPdfPageTexts(bytes);
  const layout = await readPdfTextLayout(bytes);
  const positionedPages = layout.ok ? layout.pages : null;
  console.log(`  pages ${pageTexts.length} · text chars ${pageTexts.map((t) => t.length).join('/')}`
    + ` · layout ${layout.ok ? `${layout.pages.length} page(s)` : `unavailable: ${layout.reason}`}`);

  pageTexts.forEach((text, index) => {
    const lines = text.split('\n');
    if (!fullPages.has(index + 1)) {
      console.log(`\n  --- page ${index + 1} · flattened text: ${lines.length} lines (not in TRACE_PAGES)`);
      return;
    }
    console.log(`\n  --- page ${index + 1} · flattened text (${lines.length} lines)`);
    lines.slice(0, MAX_TEXT_LINES).forEach((line, at) => console.log(`    L${String(at).padStart(3)} | ${line}`));
    if (lines.length > MAX_TEXT_LINES) console.log(`    … ${lines.length - MAX_TEXT_LINES} more lines`);
  });

  for (const page of positionedPages ?? []) {
    if (!fullPages.has(page.page)) continue;
    console.log(`\n  --- page ${page.page} · positioned runs (${page.items.length}), top of page first`);
    const drawn = page.items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
    for (const item of drawn) {
      if (!String(item.text ?? '').trim()) continue;
      console.log(`    y${n1(item.y)} x${n1(item.x)} w${n1(item.width)} h${n1(item.height ?? 0)}  ${quote(item.text)}`);
    }
    console.log(`\n  --- page ${page.page} · the reader's lines (layoutLines)`);
    layoutLines(page.items).forEach((line, at) => {
      const cells = line.cells.map((cell) => `x${Math.round(cell.x)} ${quote(cell.text)}`).join(' | ');
      console.log(`    r${String(at).padStart(3)} y${n1(line.y)}  ${cells}`);
    });
  }

  await traceWhatTheTextLayerCannotSee(bytes, fullPages);

  const reading = readPdfDeterministicRows({
    pageTexts,
    positionedPages,
    recognisedPages: null,
    organisationName,
    filename,
  });
  console.log('\n  --- reading');
  console.log(`    status ${reading.status} · reason ${reading.reason} · strategy ${reading.strategy}`);
  console.log(`    rows ${JSON.stringify(reading.rows, null, 2).split('\n').join('\n    ')}`);
  console.log(`    diagnostics ${JSON.stringify(reading.diagnostics, null, 2).split('\n').join('\n    ')}`);
  console.log(`    provisional ${JSON.stringify(reading.provisional ?? [])}`);
  console.log(`    unaccounted ${JSON.stringify(reading.unaccounted ?? [])}`);
  const ignored = reading.ignored ?? [];
  console.log(`    ignored ${ignored.length} line(s); the first 60 with their placement:`);
  ignored.slice(0, 60).forEach((line, at) => {
    console.log(`      ${String(reading.placement?.[at] ?? '').padEnd(14)} ${quote(line)}`);
  });
}

if (failures) {
  console.error(`\n${failures} upload(s) could not be traced`);
  Deno.exit(1);
}
