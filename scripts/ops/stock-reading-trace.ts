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

/**
 * ===========================================================================
 * WHAT A PAGE SHOWS THAT ITS TEXT LAYER DOES NOT CARRY.
 * ===========================================================================
 *
 * MEASURED 23 SEPTEMBER 2026 on `Lot 101 - PICO - BROCHURE v002.pdf`: its
 * text layer, across all six pages, states no street, no suburb, no lot size
 * and no build size, while the builder reports that the page shows them — and
 * page 1's positioned runs are empty exactly where the same builder's other
 * template prints `Lot Size` and the house's schedule. A page can show text
 * that `getTextContent` never returns in three ways, and each needs a
 * different reader, so this names which one a document uses before anything
 * is built for it:
 *
 *   annotations      every annotation pdf.js reports, whatever its subtype —
 *                    the product reads only visible form-field WIDGETS, and a
 *                    brochure filled with a typewriter or Fill & Sign tool
 *                    carries FreeText annotations instead;
 *   operators        a census of what the page's content stream draws: text,
 *                    paths and pictures — text converted to outlines is paths;
 *   rendered + OCR   the page as a viewer draws it (poppler, annotations
 *                    included), recognised by the Tesseract CLI, line by line
 *                    with its position — what a person looking at the page
 *                    reads, whatever form the document stores it in.
 *
 * READ-ONLY, like everything here. The bytes reach the two command-line tools
 * through pipes and are never written to disk. A runner without them says so
 * and the rest of the trace is unaffected.
 */
async function traceWhatTheTextLayerCannotSee(
  bytes: Uint8Array,
  pages: ReadonlySet<number>,
): Promise<void> {
  let reader: Record<string, unknown>;
  try {
    reader = await import('https://esm.sh/unpdf@0.12.1') as Record<string, unknown>;
  } catch (error) {
    console.log(`\n  --- beyond the text layer: pdf reader unavailable (${String(error).slice(0, 120)})`);
    return;
  }
  // deno-lint-ignore no-explicit-any
  const unpdf = reader as any;
  // deno-lint-ignore no-explicit-any
  let pdfjs: any = null;
  try { pdfjs = await unpdf.getResolvedPDFJS(); } catch { /* the census names its ops by number */ }
  const opName = new Map<number, string>();
  for (const [name, code] of Object.entries(pdfjs?.OPS ?? {})) opName.set(Number(code), name);
  // deno-lint-ignore no-explicit-any
  let pdf: any;
  try {
    pdf = await unpdf.getDocumentProxy(bytes.slice());
  } catch (error) {
    console.log(`\n  --- beyond the text layer: document unreadable (${String(error).slice(0, 120)})`);
    return;
  }
  for (const pageNumber of [...pages].sort((a, b) => a - b)) {
    if (pageNumber > (pdf.numPages ?? 0)) continue;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport?.({ scale: 1 });
    console.log(`\n  --- page ${pageNumber} · beyond the text layer`
      + (viewport ? ` · page ${n1(viewport.width).trim()} x ${n1(viewport.height).trim()} pt` : ''));

    // Annotations, every subtype.
    try {
      const annotations = await page.getAnnotations();
      console.log(`    annotations: ${Array.isArray(annotations) ? annotations.length : 0}`);
      for (const annotation of Array.isArray(annotations) ? annotations : []) {
        const rect = Array.isArray(annotation?.rect)
          ? annotation.rect.map((v: number) => Number(v).toFixed(1)).join(',') : '?';
        const text = Array.isArray(annotation?.textContent)
          ? annotation.textContent.join(' / ') : '';
        console.log(`      ${String(annotation?.subtype ?? '?')}`
          + `${annotation?.it ? ` it=${annotation.it}` : ''}`
          + `${annotation?.fieldType ? ` field=${annotation.fieldType}` : ''}`
          + `${annotation?.fieldName ? ` name=${quote(String(annotation.fieldName))}` : ''}`
          + `${annotation?.hidden ? ' HIDDEN' : ''}${annotation?.noView ? ' NOVIEW' : ''}`
          + ` rect=[${rect}]`
          + `${annotation?.fieldValue !== undefined ? ` value=${quote(String(annotation.fieldValue))}` : ''}`
          + `${annotation?.contentsObj?.str ? ` contents=${quote(String(annotation.contentsObj.str))}` : ''}`
          + `${text ? ` shows=${quote(text)}` : ''}`);
      }
    } catch (error) {
      console.log(`    annotations: unreadable (${String(error).slice(0, 120)})`);
    }

    // Operator census.
    try {
      const list = await page.getOperatorList();
      const counts = new Map<string, number>();
      for (const fn of list.fnArray as number[]) {
        const name = opName.get(fn) ?? `op${fn}`;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const interesting = ['showText', 'showSpacedText', 'nextLineShowText',
        'nextLineSetSpacingShowText', 'setFont', 'constructPath', 'fill', 'eoFill',
        'fillStroke', 'eoFillStroke', 'stroke', 'paintImageXObject', 'paintInlineImageXObject',
        'paintImageMaskXObject', 'paintFormXObjectBegin', 'beginMarkedContent',
        'beginMarkedContentProps', 'setTextRenderingMode'];
      console.log(`    operators: ${list.fnArray.length} · `
        + interesting.filter((name) => counts.has(name))
          .map((name) => `${name} ${counts.get(name)}`).join(' · '));
    } catch (error) {
      console.log(`    operators: unreadable (${String(error).slice(0, 120)})`);
    }

    // Rendered, and read the way a person reads it.
    const png = await pipeThrough('pdftoppm',
      ['-r', '150', '-f', String(pageNumber), '-l', String(pageNumber), '-png', '-', '-'], bytes);
    if (!png) {
      console.log('    rendered + OCR: pdftoppm unavailable or failed on this page');
      continue;
    }
    const tsv = await pipeThrough('tesseract', ['stdin', 'stdout', '--psm', '3', 'tsv'], png);
    if (!tsv) {
      console.log('    rendered + OCR: tesseract unavailable or failed on this page');
      continue;
    }
    const lines = new Map<string, { top: number; left: number; words: string[]; conf: number[] }>();
    for (const row of new TextDecoder().decode(tsv).split('\n').slice(1)) {
      const cells = row.split('\t');
      if (cells.length < 12 || cells[0] !== '5') continue;
      const word = cells[11].trim();
      const conf = Number(cells[10]);
      if (!word) continue;
      const key = `${cells[2]}.${cells[3]}.${cells[4]}`;
      const line = lines.get(key)
        ?? { top: Number(cells[7]), left: Number(cells[6]), words: [], conf: [] };
      line.top = Math.min(line.top, Number(cells[7]));
      line.left = Math.min(line.left, Number(cells[6]));
      line.words.push(word);
      line.conf.push(conf);
      lines.set(key, line);
    }
    // 150 dpi: a point is 150/72 pixels. Printed in points from the TOP, so a
    // line reads against the positioned runs above by subtracting from the height.
    const toPt = (px: number) => px * 72 / 150;
    console.log(`    rendered + OCR (150 dpi, positions in points from the top-left):`);
    [...lines.values()].sort((a, b) => a.top - b.top || a.left - b.left).forEach((line) => {
      const mean = line.conf.reduce((sum, value) => sum + value, 0) / line.conf.length;
      console.log(`      top${n1(toPt(line.top))} left${n1(toPt(line.left))} conf${n1(mean)}  ${quote(line.words.join(' '))}`);
    });
  }
}

/** Run a command with `input` on its stdin; its stdout, or null. Nothing touches disk. */
async function pipeThrough(command: string, args: string[], input: Uint8Array): Promise<Uint8Array | null> {
  try {
    const child = new Deno.Command(command, {
      args, stdin: 'piped', stdout: 'piped', stderr: 'null',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
    const { code, stdout } = await child.output();
    return code === 0 && stdout.byteLength ? stdout : null;
  } catch {
    return null;
  }
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
