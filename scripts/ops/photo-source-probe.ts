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
  lotAndDesignFrom, normaliseDriveName, parseDriveFolderListing, carriesDesignation,
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
import { coverIdentityRefusal } from '../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure.ts';
import { indexPdfObjects, readPdfPage } from '../../supabase/functions/_shared/builderStock/pdfPageImages.pure.ts';
import { pictureFromStream, selectPdfPropertyPrimary } from '../../supabase/functions/_shared/builderStock/pdfSourcePhoto.ts';
import { readPdfPageTextResult } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import { decodeAscii85, imageStreamFlags } from '../../supabase/functions/_shared/builderStock/pdfAscii85.pure.ts';
import { sniffImageContentType } from '../../supabase/functions/_shared/builderStock/sourceAssets.pure.ts';

/*
 * The pipeline's own diagnostics name documents; this log is public. Anything
 * the pipeline writes to the console while the probe runs is dropped.
 */
const quiet = () => {};
console.info = quiet;
console.warn = quiet;
console.error = quiet;
const say = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[builderStock]')) return;
  say(...args);
};

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

/** How a document's first pages encode their pictures, and what the election makes of it. */
async function analysePdf(entry: DriveEntry, who: Identity[], row: Record<string, unknown>) {
  let bytes: Uint8Array;
  try {
    bytes = (await productionFetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(entry.id)}`)).bytes;
  } catch (error) {
    say(`    PDF ${mask(entry.name, who)}: download failed (${String((error as Error)?.message ?? error).slice(0, 80)})`);
    return;
  }
  say(`    PDF ${mask(entry.name, who)}: ${(bytes.length / 1048576).toFixed(2)} MB, starts ${new TextDecoder('latin1').decode(bytes.slice(0, 8)).replace(/[^ -~]/g, '?')}`);
  let objects: Map<number, { header: string }>;
  try { objects = indexPdfObjects(bytes) as unknown as Map<number, { header: string }>; } catch (error) {
    say(`      index failed: ${String((error as Error)?.message ?? error).slice(0, 100)}`);
    return;
  }
  say(`      objects ${objects.size}`);
  for (let page = 0; page < 3; page++) {
    const read = readPdfPage(bytes, page);
    if (!read) { say(`      page ${page + 1}: not readable`); continue; }
    say(`      page ${page + 1}: ${Math.round(read.width)}x${Math.round(read.height)}pt, ${read.images.length} image(s), ${read.forms.length} form(s)`);
    const images = [...read.images, ...read.forms.flatMap((form) => (form as unknown as { images?: typeof read.images }).images ?? [])];
    for (const image of images.slice(0, 8)) {
      const header = objects.get(image.objectNumber)?.header ?? '';
      const cs = /\/ColorSpace\s*(\/\w+|\[[^\]]{0,40}\]|\d+\s+\d+\s+R)/.exec(header)?.[1] ?? '—';
      const parms = /\/DecodeParms\s*(<<[^>]{0,80}>>|\d+\s+\d+\s+R)/.exec(header)?.[1]?.replace(/\s+/g, ' ') ?? '—';
      let decoded = 'no';
      try {
        const flags = imageStreamFlags(image.filters);
        const raw = bytes.slice(image.start, image.end);
        const un = flags.ascii85 ? decodeAscii85(raw) : raw;
        say(`          ascii85 layer: ${flags.ascii85 ? (un ? `ok, ${un.length} bytes, head ${[...un.slice(0, 4)].map((b) => b.toString(16)).join(' ')}` : `FAILED; tail ${JSON.stringify(new TextDecoder('latin1').decode(raw.slice(-12)))}`) : 'none'}`);
        const picture = await pictureFromStream(bytes, {
          start: image.start, end: image.end, ...flags,
          width: image.width, height: image.height,
        });
        decoded = picture ? `yes ${picture.contentType} ${(picture.bytes.length / 1024).toFixed(0)} KB` : 'no';
      } catch (error) { decoded = `threw ${String((error as Error)?.message ?? error).slice(0, 60)}`; }
      const raw = bytes.slice(image.start, Math.min(image.end, image.start + 16));
      say(`        img obj ${image.objectNumber}: ${image.width}x${image.height} filters=[${image.filters.join(',')}] comps=${image.components ?? '?'} bpc=${image.bitsPerComponent} cs=${cs} parms=${parms} smask=${/\/SMask\b/.test(header) ? 'yes' : 'no'} stream=${((image.end - image.start) / 1024).toFixed(0)} KB rawSniff=${sniffImageContentType(raw.length >= 12 ? bytes.slice(image.start, image.start + 64) : raw) ?? '—'} → decoded ${decoded}`);
    }
  }
  try {
    const record = (row.source_row ?? {}) as Record<string, unknown>;
    const texts = await readPdfPageTextResult(bytes);
    say(`      text: ${texts.ok ? `${texts.pages.length} page(s), page-1 chars ${texts.pages[0]?.length ?? 0}` : `failed ${texts.reason}`}`);
    if (texts.ok) {
      const label = stockRecordLabel(record as never);
      say(`      page-1 words (masked): ${mask(texts.pages[0] ?? '', who).slice(0, 400)}`);
      say(`      label (masked): ${mask(label, who)}`);
      say(`      cover identity refusal on page 1: ${coverIdentityRefusal(texts.pages[0] ?? '', label, stockIdentityHints(record as never)) ?? 'none — the page states this property'}`);
    }
    const selection = await selectPdfPropertyPrimary(bytes, {
      label: stockRecordLabel(record as never),
      pageTexts: texts.ok ? texts.pages : [],
      design: designOfRecordOrRow(record),
      identityHints: stockIdentityHints(record as never),
    });
    say(`      in-process election: coverPages=[${selection.coverPages.join(',')}] assets=${selection.assets.length} primary=${selection.primary ? 'YES' : 'no'} pageOrder=${selection.pageOrderAuthoritative} streamsUnread=${selection.objectStreamsUnread}`);
  } catch (error) {
    say(`      in-process election threw: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  }
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
      const unitNumbers = listing.flatMap((e) => [...normaliseDriveName(e.name).matchAll(/\bunit (\d+[a-z]?)\b/g)].map((m) => m[1]));
      if (unitNumbers.length) console.log(`  ${'  '.repeat(depth)}  unit numbers named in this folder: ${[...new Set(unitNumbers)].sort((a, b) => Number(a) - Number(b)).join(', ')}`);
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

    // Every PDF in the linked folder (depth 1) that names a probed row's lot or unit: how its pictures are encoded.
    const pdfs: DriveEntry[] = [];
    const gather = async (id: string, depth: number) => {
      const { bytes } = await productionFetch(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`);
      for (const entry of parseDriveFolderListing(new TextDecoder().decode(bytes))) {
        if (entry.mimeType === DRIVE_FOLDER_MIME && depth < 1) await gather(entry.id, depth + 1);
        if (entry.mimeType === 'application/pdf') pdfs.push(entry);
      }
    };
    try { await gather(folderId, 0); } catch { /* reported above */ }
    const named = pdfs.filter((entry) => {
      const clean = ` ${normaliseDriveName(entry.name)} `;
      return who.some((id) => (id.lot && carriesDesignation(clean.trim(), 'lot', id.lot)) || (id.unit && carriesDesignation(clean.trim(), 'unit', id.unit)));
    }).slice(0, 3);
    for (const entry of named) await analysePdf(entry, who, linked[0]);
  } else if (host.endsWith('dropbox.com')) {
    const file = sharedLinkFileUrl(url);
    const got = await plainGet(file);
    const pk = got.bytes[0] === 0x50 && got.bytes[1] === 0x4b;
    console.log(`  dl=1 answers HTTP ${got.status}, ${got.type}, ${(got.bytes.length / 1048576).toFixed(1)} MB in ${got.ms} ms from ${got.host}${pk ? ' — a ZIP' : ''}`);
    if (pk) {
      // Does the host serve a byte range of the zip? (A range would let one file be taken from 237 MB.)
      for (const range of ['bytes=0-1023', 'bytes=-1024']) {
        try {
          const r = await fetch(file, { redirect: 'follow', headers: { Range: range } });
          const body = new Uint8Array(await r.arrayBuffer());
          say(`  Range ${range}: HTTP ${r.status}, ${body.length} bytes, content-range ${r.headers.get('content-range') ?? '—'}, accept-ranges ${r.headers.get('accept-ranges') ?? '—'}, content-length ${r.headers.get('content-length') ?? '—'}`);
        } catch (error) { say(`  Range ${range}: ${String((error as Error)?.message ?? error).slice(0, 100)}`); }
      }
      // Local headers: can a zip this size be streamed entry by entry?
      const view = new DataView(got.bytes.buffer);
      const methods = new Map<string, number>();
      let at = 0;
      for (let n = 0; n < 12 && view.getUint32(at, true) === 0x04034b50; n++) {
        const flags = view.getUint16(at + 6, true);
        const method = view.getUint16(at + 8, true);
        const csize = view.getUint32(at + 18, true);
        const nl = view.getUint16(at + 26, true);
        const xl = view.getUint16(at + 28, true);
        const key = `method ${method}, descriptor ${(flags & 8) ? 'yes' : 'no'}, size-in-header ${csize > 0 ? 'yes' : 'no'}`;
        methods.set(key, (methods.get(key) ?? 0) + 1);
        if (flags & 8) break;
        at += 30 + nl + xl + csize;
      }
      say(`  first local headers: ${[...methods].map(([k, v]) => `${v}× ${k}`).join('; ')}`);
      // The folder page itself: does it carry the listing?
      const page = await plainGet(url.replace(/([?&])dl=1/, '$1dl=0'), 8 * 1024 * 1024);
      const html = new TextDecoder().decode(page.bytes);
      const names = zipEntries(got.bytes).map((e) => e.name.split('/').filter(Boolean).pop() ?? '').filter(Boolean);
      const seen = names.filter((n) => html.includes(n)).length;
      say(`  folder page (dl=0): HTTP ${page.status}, ${(page.bytes.length / 1024).toFixed(0)} KB, names of zip entries visible in it: ${seen} of ${names.length}`);
      // A file inside the shared folder, addressed by path under the link.
      const image = zipEntries(got.bytes).find((e) => /\.(jpe?g|png)$/i.test(e.name));
      if (image) {
        const base = new URL(url);
        const pathUrl = new URL(base.toString());
        pathUrl.pathname = `${base.pathname.replace(/\/$/, '')}/${image.name.split('/').map(encodeURIComponent).join('/')}`;
        pathUrl.searchParams.set('dl', '1');
        const one = await plainGet(pathUrl.toString(), 30 * 1024 * 1024);
        say(`  one image by path under the link: HTTP ${one.status}, ${one.type}, ${(one.bytes.length / 1024).toFixed(0)} KB, sniffed ${sniffImageContentType(one.bytes) ?? 'not an image'}`);
        const bare = image.name.split('/').filter(Boolean);
        const pathUrl2 = new URL(base.toString());
        pathUrl2.pathname = `${base.pathname.replace(/\/$/, '')}/${bare.slice(1).map(encodeURIComponent).join('/')}`;
        pathUrl2.searchParams.set('dl', '1');
        const two = await plainGet(pathUrl2.toString(), 30 * 1024 * 1024);
        say(`  same, without the zip's top folder: HTTP ${two.status}, ${two.type}, ${(two.bytes.length / 1024).toFixed(0)} KB, sniffed ${sniffImageContentType(two.bytes) ?? 'not an image'}`);
      }
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
      const won = outcome.status === 'recovered_photograph'
        ? ` — ${outcome.photograph.contentType}, ${(outcome.photograph.bytes.length / 1024).toFixed(0)} KB, sniffed ${sniffImageContentType(outcome.photograph.bytes) ?? 'NOT AN IMAGE'}, from a folder ${outcome.photograph.folderPath.length} deep`
        : outcome.status === 'recovered'
          ? ` — ${outcome.image.contentType}, ${(outcome.image.bytes.length / 1024).toFixed(0)} KB`
          : '';
      verdict = `${outcome.status}${won}${'detail' in outcome && outcome.detail ? ` — ${String(outcome.detail).slice(0, 140)}` : ''}`;
    } catch (error) {
      verdict = `threw — ${String((error as Error)?.message ?? error).slice(0, 140)}`;
    }
    console.log(`  production for ${String(row.id).slice(0, 8)}: ${verdict} (${Date.now() - started} ms)`);
  }
}
