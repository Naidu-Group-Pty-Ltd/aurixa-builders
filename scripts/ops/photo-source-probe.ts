/**
 * BUILDER STOCK — WHAT IS ACTUALLY INSIDE A ROW'S PHOTO FOLDER. Read-only.
 *
 * A builder links a Google Drive or Dropbox FOLDER beside a property, and the
 * property comes out with no photograph. This probe answers, for the stock
 * items named in STOCK_ITEM_IDS:
 *
 *   1. what the folder holds — every file and sub-folder to depth 3, its type,
 *      its size where the host states one, and whether its name mentions the
 *      row's lot, unit, street, suburb, development or design;
 *   2. whether the listing production reads is the whole folder (Drive embeds
 *      only a first page in the folder view, so it is compared with the
 *      embedded folder view, which lists everything);
 *   3. exactly what production concludes, by running `recoverPackageImage`
 *      with the production fetcher and the inputs the settler builds.
 *
 * PRINTS NO CUSTOMER TEXT. This repository and its Actions logs are public, so
 * a file or folder name is printed MASKED: words from a fixed vocabulary of
 * document and picture words are kept, a word that equals one of the row's own
 * identity tokens is printed as its role (<LOT>, <UNIT>, <SUBURB>, <DEV>,
 * <DESIGN>), digits become `#`, and every other word becomes `·`. No URL, id,
 * address or price is printed; a row is named by the first eight characters of
 * its id.
 *
 * WRITES NOTHING: one SELECT through the Management API, then plain GETs.
 */
import {
  DRIVE_FOLDER_MIME, type DriveEntry, driveFolderId, isNonFacadeImageName, isPackageImage,
  lotAndDesignFrom, normaliseDriveName, parseDriveFolderListing,
} from '../../supabase/functions/_shared/builderStock/drivePackage.pure.ts';
import {
  classifyBranch, rowSourceBranchCandidates, sharedLinkFileUrl,
} from '../../supabase/functions/_shared/builderStock/sourceBranches.pure.ts';
import {
  DriveListingCache, type PackageFetcher, recoverPackageImage,
} from '../../supabase/functions/_shared/builderStock/packageImages.ts';
import { fetchStockSource } from '../../supabase/functions/_shared/builderStock/fetchSource.ts';
import {
  stockIdentityHints, stockRecordLabel,
} from '../../supabase/functions/_shared/builderStock/normalise.pure.ts';
import { designOfRecordOrRow } from '../../supabase/functions/_shared/builderStock/builderSuppliedImage.pure.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = String(Deno.env.get('STOCK_ITEM_IDS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is not set.'); Deno.exit(1); }
if (!ids.length || ids.some((id) => !UUID.test(id))) {
  console.error('items must be comma-separated stock item uuids.');
  Deno.exit(2);
}

async function sql(text: string): Promise<Array<Record<string, unknown>>> {
  if (!/^\s*select\b/i.test(text)) throw new Error('SELECT only');
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`query failed ${response.status}`);
  return JSON.parse(body) as Array<Record<string, unknown>>;
}

const VOCABULARY = new Set((
  'render renders rendering facade facades front rear elevation elevations photo photos photograph '
  + 'photographs image images img pic pics picture pictures gallery exterior interior internal external '
  + 'kitchen living bedroom bathroom ensuite lounge dining alfresco garage street view hero main cover '
  + 'plan plans floor floorplan floorplans site siting aerial map masterplan master stage lot lots unit units '
  + 'brochure brochures package packages pack flyer contract contracts appraisal rental inclusions spec '
  + 'specification specifications schedule price list pricing investment report area profile marketing '
  + 'dsc dscn jpg jpeg png webp heic pdf zip final hr hires high res low web copy new house home land '
  + 'townhouse duplex dual occ key industrial warehouse office design designs option options display '
  + 'and the of for with to a'
).split(/\s+/));

interface Identity { lot: string | null; unit: string | null; suburb: string[]; dev: string[]; design: string[] }

function mask(name: string, who: Identity[]): string {
  const words = normaliseDriveName(name.replace(/\.[a-z0-9]{2,5}$/i, (ext) => ` ${ext.slice(1)}`)).split(' ');
  return words.filter(Boolean).map((word) => {
    for (const id of who) {
      if (id.lot && word === id.lot) return '<LOT>';
      if (id.unit && word === id.unit) return '<UNIT>';
      if (id.suburb.includes(word)) return '<SUBURB>';
      if (id.design.includes(word)) return '<DESIGN>';
      if (id.dev.includes(word)) return '<DEV>';
    }
    if (/^\d+$/.test(word)) return '#'.repeat(Math.min(word.length, 4));
    if (VOCABULARY.has(word)) return word;
    return '·';
  }).join(' ');
}

const words = (value: unknown) => normaliseDriveName(String(value ?? ''))
  .split(' ').filter((w) => w.length >= 3 && !VOCABULARY.has(w) && !/^\d+$/.test(w));

const productionFetch: PackageFetcher = async (url: string) => {
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

async function plainGet(url: string, cap = 400 * 1024 * 1024) {
  const started = Date.now();
  const response = await fetch(url, { redirect: 'follow', headers: { Accept: '*/*' } });
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > cap) { try { await reader.cancel(); } catch { /* */ } break; }
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return {
    status: response.status, type: response.headers.get('content-type') ?? '', bytes,
    ms: Date.now() - started, host: new URL(response.url).hostname,
  };
}

/** Entry names out of a zip's central directory. */
function zipEntries(bytes: Uint8Array): Array<{ name: string; size: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    out.push({ name, size });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Every entry the Drive embedded folder view lists (it is not paged). */
async function embeddedView(folderId: string): Promise<Array<{ id: string; name: string; folder: boolean }>> {
  const got = await plainGet(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`, 8 * 1024 * 1024);
  const html = new TextDecoder().decode(got.bytes);
  const out: Array<{ id: string; name: string; folder: boolean }> = [];
  const entry = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  for (const m of html.matchAll(entry)) {
    const block = m[0];
    out.push({ id: m[1], name: m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'"), folder: /\/drive\/folders\//.test(block) || /folder/i.test(block.slice(0, 400)) });
  }
  return out;
}

const rows = await sql(`
  SELECT id::text, upload_id::text, lot_number, unit_number, suburb, development_name, address_line,
         building_size_sqm, image_work_stage, image_work_last_result, source_row
    FROM public.builder_stock_items WHERE id IN (${ids.map((id) => `'${id}'`).join(',')})`);
console.log(`rows: ${rows.length}`);

const byUrl = new Map<string, Array<Record<string, unknown>>>();
const identities = new Map<string, Identity>();
for (const row of rows) {
  const record = (row.source_row ?? {}) as Record<string, unknown>;
  const label = stockRecordLabel(record as never);
  identities.set(String(row.id), {
    lot: lotAndDesignFrom(label).lot ?? (row.lot_number ? normaliseDriveName(String(row.lot_number)) : null),
    unit: row.unit_number ? normaliseDriveName(String(row.unit_number))
      : (/\bunit\s*(\d+[a-z]?)/i.exec(String(row.address_line ?? ''))?.[1]?.toLowerCase() ?? null),
    suburb: words(row.suburb),
    dev: words(row.development_name),
    design: words(designOfRecordOrRow(record)),
  });
  for (const branch of rowSourceBranchCandidates((record.unmapped ?? null) as Record<string, string> | null)) {
    byUrl.set(branch.url, [...(byUrl.get(branch.url) ?? []), row]);
  }
}

let linkNo = 0;
for (const [url, linked] of byUrl) {
  linkNo += 1;
  const who = linked.map((row) => identities.get(String(row.id))!);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const kind = classifyBranch(url);
  console.log('\n' + '='.repeat(90));
  console.log(`LINK ${linkNo}: host ${host}, kind ${kind}, path ${new URL(url).pathname.split('/').slice(0, 3).join('/')}/…`);
  console.log(`  linked by ${linked.length} of the probed rows: ${linked.map((r) => String(r.id).slice(0, 8)).join(', ')}`);
  console.log(`  rows' suburbs distinct: ${new Set(linked.map((r) => normaliseDriveName(String(r.suburb ?? '')))).size}, developments distinct: ${new Set(linked.map((r) => normaliseDriveName(String(r.development_name ?? '')))).size}`);
  for (const id of who.slice(0, 3)) {
    console.log(`  identity sample: lot=${id.lot ?? '—'} unit=${id.unit ?? '—'} design words=${id.design.length}`);
  }

  const folderId = driveFolderId(url);
  if (folderId) {
    // What production reads: the folder page's embedded first listing, walked to depth 3.
    const walk = async (id: string, depth: number, path: string) => {
      let listing: DriveEntry[] = [];
      let err = '';
      try {
        const { bytes } = await productionFetch(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`);
        listing = parseDriveFolderListing(new TextDecoder().decode(bytes));
      } catch (error) { err = String((error as Error)?.message ?? error).slice(0, 120); }
      let full: Awaited<ReturnType<typeof embeddedView>> = [];
      try { full = await embeddedView(id); } catch { /* */ }
      console.log(`  ${'  '.repeat(depth)}[folder ${path || 'root'}] production listing ${listing.length}${err ? ` (ERROR ${err})` : ''}; embedded view lists ${full.length}`);
      for (const entry of listing) {
        const isFolder = entry.mimeType === DRIVE_FOLDER_MIME;
        const flags = [
          isFolder ? 'FOLDER' : entry.mimeType.replace(/^application\//, '').replace(/^image\//, 'image/'),
          !isFolder && isPackageImage(entry) ? 'usable-image' : '',
          isNonFacadeImageName(entry.name) ? 'declared-non-facade' : '',
        ].filter(Boolean).join(',');
        console.log(`  ${'  '.repeat(depth + 1)}- ${mask(entry.name, who)}  {${flags}}`);
        if (isFolder && depth < 2) await walk(entry.id, depth + 1, `${path}/${mask(entry.name, who)}`);
      }
      const missing = full.filter((f) => !listing.some((e) => e.id === f.id));
      if (missing.length) {
        console.log(`  ${'  '.repeat(depth + 1)}!! ${missing.length} entr(ies) the production listing does NOT see, e.g.: ${missing.slice(0, 5).map((f) => mask(f.name, who)).join(' | ')}`);
      }
    };
    await walk(folderId, 0, '');
  } else if (host.endsWith('dropbox.com')) {
    const file = sharedLinkFileUrl(url);
    const got = await plainGet(file);
    const pk = got.bytes[0] === 0x50 && got.bytes[1] === 0x4b;
    console.log(`  dl=1 answers HTTP ${got.status}, ${got.type}, ${(got.bytes.length / 1048576).toFixed(1)} MB in ${got.ms} ms from ${got.host}${pk ? ' — a ZIP' : ''}`);
    if (pk) {
      const entries = zipEntries(got.bytes);
      console.log(`  zip holds ${entries.length} entr(ies):`);
      for (const entry of entries) {
        const segments = entry.name.split('/').filter(Boolean);
        console.log(`    - ${segments.map((s) => mask(s, who)).join(' / ')}  (${(entry.size / 1048576).toFixed(2)} MB)`);
      }
    }
  }

  // What production concludes for each row that links it.
  for (const row of linked) {
    const record = (row.source_row ?? {}) as Record<string, unknown>;
    const label = stockRecordLabel(record as never);
    const started = Date.now();
    let verdict: string;
    try {
      const outcome = await recoverPackageImage({
        packageUrl: url,
        label,
        identityHints: stockIdentityHints(record as never),
        buildingSqm: Number(row.building_size_sqm) || null,
        design: designOfRecordOrRow(record),
        linkSharedWithOtherRows: linked.length > 1,
      }, { fetchPackage: productionFetch, cache: new DriveListingCache(productionFetch) });
      verdict = `${outcome.status}${'detail' in outcome && outcome.detail ? ` — ${String(outcome.detail).slice(0, 140)}` : ''}`;
    } catch (error) {
      verdict = `threw — ${String((error as Error)?.message ?? error).slice(0, 140)}`;
    }
    console.log(`  production for ${String(row.id).slice(0, 8)}: ${verdict} (${Date.now() - started} ms)`);
  }
}
