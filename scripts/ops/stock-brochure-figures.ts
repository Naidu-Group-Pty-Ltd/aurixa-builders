/**
 * BUILDER STOCK — WHAT EACH LIVE PROPERTY'S OWN BROCHURE STATES ABOUT THE
 * FIGURES ITS STOCK LIST LEFT OUT. Read-only.
 *
 * WHY THIS EXISTS. `stock-field-coverage` measured, 25 September 2026, that
 * the one live stock list (a Google Sheet, 70 properties) has no floor-area
 * column at all — 69 properties hold no building size — and leaves the car
 * count blank on its 20 dual-key rows. Every one of those rows links its own
 * brochure, which the image ladder already opens for a photograph. Whether a
 * brochure can FILL those figures is a question about the brochures, not
 * about the code, so this runs the product's own deterministic PDF reader
 * (`readPdfPageTexts` → `readPdfTextLayout` → `readPdfDeterministicRows`, the
 * sequence `extract.ts` runs for an uploaded PDF) over each property's own
 * brochure and prints what it read — and whether the brochure is the
 * property's (its lot and design against the row's).
 *
 * WRITES NOTHING. Every statement is a SELECT; `sql()` refuses anything else.
 * It fetches each brochure through the product's own `fetchStockSource`.
 *
 * PRINTS NO LINK, and no document text beyond the figures the reader read.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/stock-brochure-figures.ts
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
import { safeDetail } from '../../supabase/functions/_shared/builderStock/importTelemetry.pure.ts';
import { fetchStockSource } from '../../supabase/functions/_shared/builderStock/fetchSource.ts';
import { readPdfPageTexts } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import { readPdfTextLayout } from '../../supabase/functions/_shared/builderStock/pdfTextLayout.ts';
import { readPdfDeterministicRows } from '../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure.ts';

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

/** Any link inside a message, reduced to a word: an error can quote the address it fetched. */
function noLinks(text: string, max: number): string {
  return safeDetail(text.replace(/https?:\/\/\S+/g, '<link>'), max);
}

async function digest(url: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  return [...d.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const FIGURES = [
  'lot_number', 'house_design', 'bedrooms', 'bathrooms', 'car_spaces',
  'building_size_sqm', 'land_size_sqm', 'price',
] as const;

function pick(row: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FIGURES) if (row && row[key] !== undefined && row[key] !== null) out[key] = row[key];
  return out;
}

const rows = await sql('rows', `
  select i.id::text, i.lot_number, i.source_row->>'house_design' as design,
         i.car_spaces, i.building_size_sqm,
         i.source_row->'unmapped'->>'Brochure URL' as brochure_url,
         (select array_agg(k) from jsonb_each(coalesce(i.source_provenance_result->'branches','{}'::jsonb)) as b(k, v)
           where v->>'result' = 'image_recovered') as recovered
  from builder_stock_items i
  where i.lifecycle_status in ('active','staged')
    and (i.car_spaces is null or i.building_size_sqm is null)
  order by i.lot_number`);

console.log(`brochure figures — ${rows.length} live properties missing a car count or a floor area`);

const tally = { read: 0, identityAgrees: 0, home: 0, car: 0, failed: 0 };
for (const row of rows) {
  const recovered = (row.recovered as string[] | null) ?? [];
  const url = recovered[0] ?? (typeof row.brochure_url === 'string' && /^https?:/.test(row.brochure_url) ? row.brochure_url : null);
  const head = `lot ${row.lot_number} · ${row.design} (held: cars ${row.car_spaces ?? '—'}, home ${row.building_size_sqm ?? '—'})`;
  if (!url) { console.log(`${head}: no brochure link`); continue; }
  const which = recovered[0] ? 'the brochure its photograph came from' : 'its Brochure URL column';
  try {
    const fetched = await fetchStockSource(url) as unknown as { bytes?: Uint8Array; contentType?: string };
    const bytes = fetched.bytes;
    if (!bytes || !(bytes[0] === 0x25 && bytes[1] === 0x50)) {
      console.log(`${head}: #${await digest(url)} (${which}) is not a PDF (${noLinks(String(fetched.contentType ?? '?'), 60)})`);
      tally.failed++;
      continue;
    }
    const pageTexts = await readPdfPageTexts(bytes);
    const layout = await readPdfTextLayout(bytes);
    const reading = readPdfDeterministicRows({
      pageTexts,
      positionedPages: layout.ok ? layout.pages : null,
    });
    tally.read++;
    const read = reading.rows.length ? reading.rows : (reading as { provisional?: Array<Record<string, unknown>> }).provisional ?? [];
    const one = read.length === 1 ? read[0] : undefined;
    const lotAgrees = one && String(one.lot_number ?? '').replace(/^lot\s*/i, '') === String(row.lot_number ?? '');
    const designAgrees = one && String(one.house_design ?? '').toLowerCase().replace(/\s+/g, '')
      .includes(String(row.design ?? '').toLowerCase().replace(/\s+/g, '').split('.')[0]);
    if (lotAgrees) tally.identityAgrees++;
    if (one?.building_size_sqm != null) tally.home++;
    if (one?.car_spaces != null) tally.car++;
    console.log(`${head}: #${await digest(url)} (${which}) pages ${pageTexts.length}, `
      + `reading ${reading.status}${reading.rows.length ? '' : ' (provisional)'}, rows ${read.length}, `
      + `lot ${lotAgrees ? 'agrees' : 'DIFFERS'}, design ${designAgrees ? 'agrees' : 'differs'} → `
      + JSON.stringify(read.map(pick))
      + (reading.reason ? ` reason: ${noLinks(String(reading.reason), 160)}` : ''));
  } catch (error) {
    tally.failed++;
    console.log(`${head}: #${await digest(url)} failed — ${noLinks(String((error as Error)?.message ?? error), 160)}`);
  }
}
console.log('\nTALLY', JSON.stringify(tally));
