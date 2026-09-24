/**
 * BUILDER STOCK — SOURCE FORENSICS. Read-only, evidence-producing.
 *
 * Answers ONE question, exhaustively: for every served or staged property that
 * still has no ready builder-source photograph, what image assets does the
 * builder's ORIGINAL uploaded source actually contain — and would the pipeline
 * recover them?
 *
 * It runs the pipeline's OWN parsers and rules — `rowSourceBranchCandidates`,
 * `recoverPackageImage`, `electFromPdfBytes`, the PDF page readers — never a
 * reimplementation, so what it prints is what the pipeline sees. Three passes
 * per source branch:
 *
 *   as-production   the exact live path: `fetchStockSource` (25 MB cap, no
 *                   Drive interstitial handling) and the live election route
 *                   (no worker secrets here, so >6 MB refuses by name — the
 *                   same refusal production banks).
 *   full-read       a forensic fetcher that resolves Google Drive's
 *                   "can't scan for viruses" interstitial and reads to 100 MB,
 *                   with the election forced in-process, so the DOCUMENT's own
 *                   contents are proven even where production's budget refuses.
 *   as-licensed     the same bytes elected under `folder_structure` evidence —
 *                   what a row-EXCLUSIVE document link would license — so the
 *                   extraction fix this audit informs is measured, not argued.
 *
 * Every PDF also gets a page-level census (pipeline page readers: page count,
 * rasters/forms/widgets per page, `extractPdfPagePhoto` per page, and whether
 * each page's text states the row's lot / design / estate).
 *
 * WRITES NOTHING. The only database access is SELECT via the Management API.
 * The access token is read from the environment and never printed.
 */
import {
  DRIVE_FOLDER_MIME, type DriveEntry, driveDownloadUrl, driveFileId, driveFolderUrl,
  isGoogleDriveHost, isNonFacadeImageName, lotAndDesignFrom, namesThisProperty,
  normaliseDriveName, parseDriveFolderListing, streetAddressFrom,
} from '../../supabase/functions/_shared/builderStock/drivePackage.pure.ts';
import {
  classifyBranch, rowSourceBranchCandidates, sharedLinkFileUrl,
} from '../../supabase/functions/_shared/builderStock/sourceBranches.pure.ts';
import {
  DriveListingCache, type PackageFetcher, type PackageOutcome, recoverPackageImage,
} from '../../supabase/functions/_shared/builderStock/packageImages.ts';
import { electFromPdfBytes } from '../../supabase/functions/_shared/builderStock/pdfElection.ts';
import { readPdfPageTextResult } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import {
  countPdfPages, pageOrderIsAuthoritative, readPdfPage,
} from '../../supabase/functions/_shared/builderStock/pdfPageImages.pure.ts';
import {
  extractPdfPagePhoto, recoverCompressedObjects, selectPdfPropertyPrimary,
} from '../../supabase/functions/_shared/builderStock/pdfSourcePhoto.ts';
import {
  coverIdentityRefusal, packageFactsOn,
} from '../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure.ts';
import { sniffImageContentType } from '../../supabase/functions/_shared/builderStock/sourceAssets.pure.ts';
import {
  decodeFullRaster, decodeThumbnailResult, imageHeaderPixels,
} from '../../supabase/functions/_shared/builderStock/sourceImageRaster.ts';
import {
  measureFlatColourRegions, overlayTextBoxes, readMarketingOverlay,
} from '../../supabase/functions/_shared/builderStock/marketingOverlay.pure.ts';
import { encodePng } from '../../supabase/functions/_shared/builderStock/rasterPng.ts';
import { fetchStockSource } from '../../supabase/functions/_shared/builderStock/fetchSource.ts';
import {
  stockIdentityHints, stockRecordLabel,
} from '../../supabase/functions/_shared/builderStock/normalise.pure.ts';
import { designOfRecordOrRow } from '../../supabase/functions/_shared/builderStock/builderSuppliedImage.pure.ts';

type RowSourceBranch = ReturnType<typeof rowSourceBranchCandidates>[number];

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

/** Forensic read ceiling. Far above every pipeline cap ON PURPOSE: the point
 * is to know what exists, including what production refuses by size. */
const FORENSIC_MAX_BYTES = 100 * 1024 * 1024;
/** Census depth per document; reading stops here, the page COUNT is exact. */
const CENSUS_MAX_PAGES = 24;

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

/** Run SQL on the live project. Logs the LABEL only — never the SQL. */
async function sql(label: string, text: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
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

// ---------------------------------------------------------------------------
// Fetching. Two fetchers, deliberately different:
//   productionFetch — `fetchStockSource` itself: the live path, its caps, its
//                     refusal wording. What production DOES.
//   forensicFetch   — direct fetch, redirects followed, the Drive virus-scan
//                     interstitial resolved, 100 MB ceiling. What EXISTS.
// ---------------------------------------------------------------------------

interface FetchedAsset {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  declaredLength: number | null;
  bytes: Uint8Array;
  truncated: boolean;
  interstitial: boolean;
  error?: string;
}

async function rawGet(url: string): Promise<Omit<FetchedAsset, 'interstitial'>> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'NPC-BuilderStock-Forensics/1.0', Accept: '*/*' },
  });
  const declaredRaw = Number(response.headers.get('content-length') ?? '');
  const declaredLength = Number.isFinite(declaredRaw) ? declaredRaw : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > FORENSIC_MAX_BYTES) {
        truncated = true;
        try { await reader.cancel(); } catch { /* done */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return {
    url,
    finalUrl: response.url || url,
    status: response.status,
    contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
    declaredLength,
    bytes,
    truncated,
  };
}

/**
 * The continuation URL inside Google Drive's "can't scan this file for
 * viruses" page, when the HTML is that page. The form posts to
 * drive.usercontent.google.com/download with hidden id/export/confirm/uuid
 * inputs; only a Drive host is ever followed.
 */
function driveInterstitialUrl(html: string): string | null {
  if (!/virus|download-form|downloadForm/i.test(html)) return null;
  const form = /<form[^>]*action="([^"]+)"[^>]*>/.exec(html);
  if (!form) return null;
  let action: URL;
  try {
    action = new URL(form[1].replace(/&amp;/g, '&'), 'https://drive.google.com');
  } catch {
    return null;
  }
  if (!isGoogleDriveHost(action.hostname)) return null;
  for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
    const t = tag[0];
    if (!/type="hidden"/.test(t)) continue;
    const name = /name="([^"]*)"/.exec(t)?.[1];
    if (!name) continue;
    const value = (/value="([^"]*)"/.exec(t)?.[1] ?? '').replace(/&amp;/g, '&');
    action.searchParams.set(name, value);
  }
  if (!action.searchParams.has('confirm')) action.searchParams.set('confirm', 't');
  return action.toString();
}

const forensicCache = new Map<string, FetchedAsset>();

async function forensicFetch(url: string): Promise<FetchedAsset> {
  const key = sharedLinkFileUrl(url);
  const cached = forensicCache.get(key);
  if (cached) return cached;
  let asset: FetchedAsset;
  try {
    const first = await rawGet(key);
    const looksHtml = first.contentType.includes('html')
      || /^\s*<(!doctype|html)/i.test(new TextDecoder().decode(first.bytes.slice(0, 256)));
    let out: FetchedAsset = { ...first, interstitial: false };
    if (looksHtml) {
      const html = new TextDecoder('utf-8', { fatal: false })
        .decode(first.bytes.slice(0, 512 * 1024));
      const next = driveInterstitialUrl(html);
      if (next) {
        const second = await rawGet(next);
        out = { ...second, url: key, interstitial: true };
      }
    }
    asset = out;
  } catch (error) {
    asset = {
      url: key, finalUrl: key, status: 0, contentType: '', declaredLength: null,
      bytes: new Uint8Array(0), truncated: false, interstitial: false,
      error: String((error as { message?: string })?.message ?? error).slice(0, 200),
    };
  }
  forensicCache.set(key, asset);
  return asset;
}

/** `PackageFetcher` over the forensic fetcher, for the full-read pass. */
const forensicPackageFetch: PackageFetcher = async (url: string) => {
  const asset = await forensicFetch(url);
  if (asset.error) throw new Error(asset.error);
  return { bytes: asset.bytes, finalUrl: asset.finalUrl };
};

/** `PackageFetcher` over the LIVE path, for the as-production pass. */
const productionPackageFetch: PackageFetcher = async (url: string) => {
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

// ---------------------------------------------------------------------------
// Asset analysis
// ---------------------------------------------------------------------------

function assetKind(asset: FetchedAsset): string {
  if (asset.error) return `unfetchable (${asset.error})`;
  const image = sniffImageContentType(asset.bytes);
  if (image) return image;
  const head = new TextDecoder('latin1').decode(asset.bytes.slice(0, 8));
  if (head.startsWith('%PDF-')) return 'application/pdf';
  if (/^\s*</.test(new TextDecoder().decode(asset.bytes.slice(0, 128)))) return 'text/html';
  return asset.contentType || 'unknown';
}

interface RowIdentity {
  label: string;
  lot: string | null;
  design: string | null;
  /** The design exactly as the pipeline hands it to the election. */
  rowDesign: string | null;
  hints: string[];
  street: { number: string; street: string } | null;
}

/**
 * A page's text as a log line, with the contact details a flyer prints taken
 * out. The census exists to show what the READER saw about the property; an
 * agent's mobile number or email address is not part of that, and a CI log is
 * no place for it.
 */
function redactContacts(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b1[38]00[\s-]?\d{3}[\s-]?\d{3}\b/g, '[phone]')
    .replace(/(?:\+?61[\s-]?|\b0)[2-478](?:[\s-]?\d){8}\b/g, '[phone]');
}

/**
 * Every lot or unit designation a page types, as it typed it — a list and all.
 * `LOT 28, 29, 30` is one match, which is the point: the cover rule reads each
 * of these, and whether it reads a list as ONE lot or as several is exactly
 * the question this line answers.
 */
function lotDesignationsAsTyped(text: string): string[] {
  const found = Array.from(
    text.matchAll(/(?:lots?|units?)\s*\.?\s*\d{1,5}(?:\s*(?:,|&|\band\b)\s*\d{1,5})*/gi),
    (match) => match[0].replace(/\s+/g, ' ').trim(),
  );
  return found.slice(0, 12);
}

function textNames(text: string, identity: RowIdentity): string[] {
  const clean = ` ${normaliseDriveName(text)} `;
  const found: string[] = [];
  if (identity.lot && clean.includes(` lot ${normaliseDriveName(identity.lot)} `)) {
    found.push(`lot ${identity.lot}`);
  }
  if (identity.design && clean.includes(` ${identity.design} `)) found.push(`design "${identity.design}"`);
  for (const hint of identity.hints) {
    const h = normaliseDriveName(hint);
    if (h && clean.includes(` ${h} `)) found.push(`estate "${hint}"`);
  }
  if (identity.street && clean.includes(` ${identity.street.number} ${identity.street.street} `)) {
    found.push(`address ${identity.street.number} ${identity.street.street}`);
  }
  return found;
}

async function pdfCensus(asset: FetchedAsset, identity: RowIdentity): Promise<void> {
  const bytes = asset.bytes;
  // The page readers take the recovered OBJECTS; the stream count beside them
  // is the election's business. Handing them the whole result read every
  // compressed object as absent.
  const recovered = (await recoverCompressedObjects(bytes)).objects;
  const pageCount = countPdfPages(bytes, recovered);
  const authoritative = pageOrderIsAuthoritative(bytes, recovered);
  console.log(`      pdf census: ${pageCount} page(s), page order ${authoritative ? 'authoritative' : 'NOT authoritative'}`);

  const textResult = await readPdfPageTextResult(bytes);
  if (!textResult.ok) console.log(`      text read FAILED: ${textResult.reason}`);

  const limit = Math.min(pageCount, CENSUS_MAX_PAGES);
  for (let index = 0; index < limit; index++) {
    const page = readPdfPage(bytes, index, recovered);
    let photo: Awaited<ReturnType<typeof extractPdfPagePhoto>> = null;
    try {
      photo = await extractPdfPagePhoto(bytes, index, recovered);
    } catch { photo = null; }
    const text = textResult.ok ? (textResult.pages[index] ?? '') : '';
    const names = textNames(text, identity);
    const parts = [
      `page ${index + 1}:`,
      `${page?.images.length ?? 0} raster(s)`,
      `${page?.forms.length ?? 0} form(s)`,
      `${page?.widgets.length ?? 0} widget(s)`,
      `text ${text.length} chars`,
    ];
    if (photo) {
      parts.push(`PHOTO ${photo.provenance.sourceWidth}x${photo.provenance.sourceHeight} `
        + `${photo.contentType} via ${photo.provenance.method} (${mb(photo.bytes.length)})`);
    }
    if (names.length) parts.push(`states: ${names.join(', ')}`);
    console.log(`        ${parts.join(' | ')}`);
    if (index === 0 || names.length) {
      const snippet = redactContacts(text.replace(/\s+/g, ' ').trim()).slice(0, 180);
      if (snippet) console.log(`          text: "${snippet}"`);
    }
    if (textResult.ok) {
      // The cover rule's OWN verdict on this page, with the test that refused.
      const refusal = coverIdentityRefusal(text, identity.label, identity.hints);
      const facts = packageFactsOn(text);
      console.log(`          cover rule: ${refusal ?? 'states this property'}`
        + ` | package facts ${facts.length}${facts.length ? ` (${facts.join(', ')})` : ''}`
        + ` | designations typed: [${lotDesignationsAsTyped(text).join(' ; ')}]`);
      // Where a page falls short of a package's facts, what it printed that
      // looks like money — so a price the rule did not recognise is visible.
      if (facts.length < 2) {
        const money = Array.from(
          text.matchAll(/(?:\$|aud)\s*\d[\d,. ]{0,14}(?:k|m)?|\b\d{3}[, ]\d{3}\b|\bprice\b[^\n]{0,40}/gi),
          (match) => match[0].replace(/\s+/g, ' ').trim(),
        ).slice(0, 8);
        console.log(`          money-like: [${money.map((m) => redactContacts(m)).join(' ; ')}]`);
      }
    }
  }
  if (pageCount > limit) console.log(`        … census capped at ${limit} of ${pageCount} pages (count above is exact)`);

  // What the election itself made of the pictures: which pages it searched,
  // every raster it materialised, and the role and reason each was given.
  if (textResult.ok) {
    try {
      const selection = await selectPdfPropertyPrimary(bytes, {
        label: identity.label,
        pageTexts: textResult.pages,
        design: identity.rowDesign,
        identityHints: identity.hints,
      });
      console.log(`      election: cover pages [${selection.coverPages.join(', ')}]`
        + ` | primary ${selection.primary ? `p${selection.primary.page} ${selection.primary.key}` : 'none'}`
        + ` | ${selection.assets.length} raster(s) decoded`);
      for (const decoded of selection.assets) {
        const share = decoded.placement?.pageAreaShare;
        console.log(`        p${decoded.page} ${decoded.key}`
          + ` ${decoded.provenance.sourceWidth}x${decoded.provenance.sourceHeight}`
          + ` area ${typeof share === 'number' ? `${Math.round(share * 1000) / 10}%` : '?'}`
          + ` → ${decoded.role.role} (level ${decoded.role.evidenceLevel}): ${decoded.role.reason.slice(0, 200)}`);
      }
    } catch (error) {
      console.log(`      election threw: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}`);
    }
  }
}

/**
 * What the display gate will see in a recovered picture: the overlay verdict,
 * where each line of type and each flat block sits, and what Tesseract reads
 * in each line of type at full size. Nothing here decides anything; it names
 * what the marketplace eligibility rule will be judging.
 */
async function overlayReport(bytes: Uint8Array): Promise<void> {
  const decoded = await decodeThumbnailResult(bytes);
  if (!decoded.ok) {
    console.log(`      overlay: could not decode (${decoded.reason})`);
    return;
  }
  const view = decoded.thumbnail;
  const verdict = readMarketingOverlay(view);
  console.log(`      overlay: annotated=${verdict.annotated} uncertain=${verdict.uncertain}`
    + ` lines=${verdict.textLineCount} lineHeight=${verdict.textHeightShare}`
    + ` blocks=${verdict.regionCount} largestBlock=${verdict.largestShare}`
    + ` faintLines=${verdict.faintTextLineCount} (thumbnail ${view.width}x${view.height})`);
  const pct = (value: number, of: number) => `${Math.round((value / of) * 1000) / 10}%`;
  const blocks = measureFlatColourRegions(view).regions;
  for (const region of blocks) {
    const b = region.box;
    console.log(`        block x ${pct(b.left, view.width)}–${pct(b.right, view.width)}`
      + ` y ${pct(b.top, view.height)}–${pct(b.bottom, view.height)}`);
  }
  const lines = overlayTextBoxes(view);
  const full = lines.length ? await decodeFullRaster(bytes) : null;
  let index = 0;
  for (const line of lines.slice(0, 6)) {
    index += 1;
    let read = '';
    if (full) {
      const sx = full.width / view.width;
      const sy = full.height / view.height;
      const pad = 4;
      const left = Math.max(0, Math.floor(line.left * sx) - pad);
      const top = Math.max(0, Math.floor(line.top * sy) - pad);
      const right = Math.min(full.width, Math.ceil((line.right + 1) * sx) + pad);
      const bottom = Math.min(full.height, Math.ceil((line.bottom + 1) * sy) + pad);
      const width = right - left;
      const height = bottom - top;
      if (width > 0 && height > 0) {
        const crop = new Uint8Array(width * height * 3);
        for (let y = 0; y < height; y++) {
          const from = ((top + y) * full.width + left) * 3;
          crop.set(full.pixels.subarray(from, from + width * 3), y * width * 3);
        }
        const png = await encodePng(crop, { width, height, components: 3 });
        if (png) {
          const path = await Deno.makeTempFile({ suffix: '.png' });
          await Deno.writeFile(path, png);
          try {
            const out = await new Deno.Command('tesseract', {
              args: [path, 'stdout', '--psm', '7'], stdout: 'piped', stderr: 'null',
            }).output();
            read = new TextDecoder().decode(out.stdout).replace(/\s+/g, ' ').trim();
          } catch {
            read = '(tesseract unavailable)';
          }
        }
      }
    }
    console.log(`        type ${index}: x ${pct(line.left, view.width)}–${pct(line.right, view.width)}`
      + ` y ${pct(line.top, view.height)}–${pct(line.bottom, view.height)}`
      + (read ? ` reads "${redactContacts(read).slice(0, 80)}"` : ''));
  }
}

function describeOutcome(outcome: PackageOutcome): string {
  const o = outcome as {
    status: string; detail?: string;
    image?: { reference?: string; contentType?: string; bytes?: Uint8Array };
  };
  if (o.status === 'recovered' && o.image) {
    const size = o.image.bytes ? ` ${mb(o.image.bytes.length)}` : '';
    return `RECOVERED ${o.image.contentType ?? ''}${size} — ${o.image.reference ?? ''}`;
  }
  return `${o.status}: ${String(o.detail ?? '').slice(0, 260)}`;
}

// ---------------------------------------------------------------------------
// Drive folder walk (bounded): what a linked folder actually holds.
// ---------------------------------------------------------------------------

async function walkFolder(
  id: string, identity: RowIdentity, depth: number, path: string[], budget: { entries: number },
): Promise<void> {
  if (depth > 3 || budget.entries <= 0) return;
  const page = await forensicFetch(driveFolderUrl(id));
  const listing = parseDriveFolderListing(
    new TextDecoder('utf-8', { fatal: false }).decode(page.bytes));
  if (!listing.length) {
    console.log(`      ${'  '.repeat(depth)}(folder ${id}: no public listing)`);
    return;
  }
  for (const entry of listing) {
    if (budget.entries-- <= 0) { console.log('      … folder walk budget reached'); return; }
    const flags: string[] = [];
    if (entry.mimeType !== DRIVE_FOLDER_MIME) {
      if (isNonFacadeImageName(entry.name)) flags.push('non-facade name');
      if (namesThisProperty(entry.name, { lot: identity.lot, street: identity.street })) {
        flags.push('NAMES THIS PROPERTY');
      }
    }
    console.log(`      ${'  '.repeat(depth)}- ${entry.name} [${entry.mimeType}]`
      + (flags.length ? ` (${flags.join('; ')})` : ''));
    if (entry.mimeType === DRIVE_FOLDER_MIME) {
      await walkFolder(entry.id, identity, depth + 1, [...path, entry.name], budget);
    }
  }
}

// ---------------------------------------------------------------------------
// URL walk over the WHOLE stored row: anything the branch enumeration misses
// is itself a finding.
// ---------------------------------------------------------------------------

function walkUrls(value: unknown, path: string, out: Array<{ path: string; url: string }>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      out.push({ path, url: match[0].replace(/[),.]+$/, '') });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkUrls(entry, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      walkUrls(entry, path ? `${path}.${key}` : key, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const itemFilter = (Deno.env.get('FORENSICS_ITEM_IDS') ?? '').trim();
const sourcePrimary = `EXISTS (
  SELECT 1 FROM public.builder_stock_item_images im
   WHERE im.id = i.primary_image_id
     AND im.source_stage = 'uploaded_document'
     AND im.verification_status = 'source_supplied'
     AND im.processing_status = 'ready')`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const filterIds = itemFilter ? itemFilter.split(',').map((id) => id.trim()).filter(Boolean) : [];
// A dispatch input reaches a statement here, so it is a list of uuids or
// nothing runs at all.
if (filterIds.some((id) => !UUID.test(id))) {
  console.error('FORENSICS_ITEM_IDS must be comma-separated stock item uuids.');
  Deno.exit(1);
}
const where = filterIds.length
  ? `i.id IN (${filterIds.map((id) => `'${id}'`).join(',')})`
  : `i.lifecycle_status IN ('active','staged') AND NOT ${sourcePrimary}`;

const items = await sql('affected items', `
  SELECT i.id, i.upload_id, i.organisation_id, i.lifecycle_status, i.image_work_stage,
         i.image_work_failures, i.primary_image_id, i.external_reference, i.source_row,
         u.original_filename, u.image_invariant, u.source_manifest_state
    FROM public.builder_stock_items i
    JOIN public.builder_stock_uploads u ON u.id = i.upload_id
   WHERE ${where}
   ORDER BY i.external_reference, i.id`);

console.log(`SOURCE FORENSICS — ${items.length} propert${items.length === 1 ? 'y' : 'ies'} without a ready builder-source photograph\n`);
if (!items.length) {
  console.log('Nothing to audit: every served/staged property carries its builder-source photograph.');
  Deno.exit(0);
}

// Cross-row link sharing must be judged over the WHOLE upload, as the
// pipeline judges it — not over the affected rows alone.
const uploadIds = [...new Set(items.map((item) => String(item.upload_id)))];
const uploadRows = await sql('upload rows for shared-link counts', `
  SELECT i.id, i.source_row FROM public.builder_stock_items i
   WHERE i.upload_id IN (${uploadIds.map((id) => `'${id}'`).join(',')})`);
const urlRowCounts = new Map<string, number>();
for (const row of uploadRows) {
  const record = (row.source_row ?? {}) as Record<string, unknown>;
  const branches = rowSourceBranchCandidates(
    (record.unmapped ?? null) as Record<string, string> | null);
  for (const branch of new Set(branches.map((b) => b.url))) {
    urlRowCounts.set(branch, (urlRowCounts.get(branch) ?? 0) + 1);
  }
}
console.log(`shared-link counts computed over ${uploadRows.length} row(s) of ${uploadIds.length} upload(s)\n`);

const manifest = await sql('manifest rows', `
  SELECT stock_item_id, kind, reference, state, state_detail
    FROM public.builder_stock_source_assets
   WHERE stock_item_id IN (${items.map((item) => `'${item.id}'`).join(',')})
   ORDER BY stock_item_id, kind, reference`);

interface Verdict { item: string; label: string; recoverable: string[]; blocked: string[] }
const verdicts: Verdict[] = [];

let ordinal = 0;
for (const item of items) {
  ordinal += 1;
  const record = (item.source_row ?? {}) as Record<string, unknown>;
  const label = stockRecordLabel(record as unknown as Parameters<typeof stockRecordLabel>[0]);
  const labelParts = lotAndDesignFrom(label);
  const design = labelParts.design
    ?? (designOfRecordOrRow(record) ? normaliseDriveName(String(designOfRecordOrRow(record))) : null);
  const identity: RowIdentity = {
    label,
    lot: labelParts.lot ?? (record.lot_number ? String(record.lot_number).toLowerCase() : null),
    design,
    rowDesign: designOfRecordOrRow(record) ?? null,
    hints: stockIdentityHints(record as unknown as Parameters<typeof stockIdentityHints>[0]),
    street: streetAddressFrom(label),
  };

  console.log('='.repeat(100));
  console.log(`PROPERTY ${ordinal}/${items.length} — ${label}`);
  console.log(`  item ${item.id} | ref ${item.external_reference ?? '—'} | ${item.lifecycle_status} | stage ${item.image_work_stage} (${item.image_work_failures} failure(s))`);
  console.log(`  upload ${item.upload_id} (${item.original_filename}, invariant=${item.image_invariant}, manifest=${item.source_manifest_state ?? '—'})`);
  console.log(`  identity: lot=${identity.lot ?? '—'} design=${identity.design ?? '—'} street=${identity.street ? `${identity.street.number} ${identity.street.street}` : '—'} hints=[${identity.hints.join(', ')}]`);

  const branches = rowSourceBranchCandidates(
    (record.unmapped ?? null) as Record<string, string> | null);

  // Exhaustiveness check: every URL anywhere in the stored row, against the
  // branch enumeration the pipeline works from.
  const everywhere: Array<{ path: string; url: string }> = [];
  walkUrls(record, '', everywhere);
  const enumerated = new Set(branches.map((branch) => branch.url));
  const missed = everywhere.filter((found) =>
    !enumerated.has(found.url) && !found.path.startsWith('unmapped'));
  if (missed.length) {
    console.log(`  !! URLs in the stored row OUTSIDE the branch enumeration (potential extraction gap):`);
    for (const gap of missed) console.log(`     ${gap.path}: ${gap.url}`);
  }

  const verdict: Verdict = { item: String(item.id), label, recoverable: [], blocked: [] };
  verdicts.push(verdict);

  for (const branch of branches) {
    const shared = (urlRowCounts.get(branch.url) ?? 1) > 1;
    console.log(`\n  BRANCH [${branch.column}] ${branch.kind}${shared ? ' (SHARED across rows)' : ' (exclusive to this row)'}`);
    console.log(`    ${branch.url}`);

    // ---- inventory: what the target actually is ----
    // A `/file/d/<id>/view` link answers the VIEWER page; the asset behind it
    // is at the download address, exactly as the pipeline fetches it.
    const inventoryFileId = driveFileId(branch.url);
    const asset = await forensicFetch(
      inventoryFileId ? driveDownloadUrl(inventoryFileId) : branch.url);
    const kind = assetKind(asset);
    const declared = asset.declaredLength !== null ? ` declared ${mb(asset.declaredLength)}` : '';
    console.log(`    fetched: HTTP ${asset.status}, ${mb(asset.bytes.length)}${declared}, sniffed ${kind}`
      + `${asset.interstitial ? ' — via Drive virus-scan interstitial' : ''}`
      + `${asset.truncated ? ` — TRUNCATED at ${mb(FORENSIC_MAX_BYTES)}` : ''}`);

    if (branch.kind === 'drive_folder') {
      const folderId = /folders\/([A-Za-z0-9_-]{10,})/.exec(branch.url)?.[1];
      if (folderId) await walkFolder(folderId, identity, 0, [], { entries: 120 });
    }

    if (kind.startsWith('image/')) {
      const pixels = imageHeaderPixels(asset.bytes);
      console.log(`    image: ${kind}, ${pixels ?? '?'} pixel(s), non-facade name: ${isNonFacadeImageName(branch.url) ? 'yes' : 'no'}`);
    }

    if (kind === 'application/pdf') {
      await pdfCensus(asset, identity);
    }

    // ---- pass 1: exactly what production does ----
    const input = {
      packageUrl: branch.url,
      label,
      identityHints: identity.hints,
      buildingSqm: Number((record as { building_size_sqm?: unknown })?.building_size_sqm) || null,
      design: designOfRecordOrRow(record),
      linkSharedWithOtherRows: shared,
    };
    let asProduction: string;
    try {
      const outcome = await recoverPackageImage(input, {
        fetchPackage: productionPackageFetch,
        cache: new DriveListingCache(productionPackageFetch),
      });
      asProduction = describeOutcome(outcome);
    } catch (error) {
      asProduction = `threw (banked unreachable): ${String((error as { safeMessage?: string })?.safeMessage
        ?? (error as { message?: string })?.message ?? error).slice(0, 200)}`;
    }
    console.log(`    as-production : ${asProduction}`);

    // ---- pass 2: full read (interstitial resolved, election in-process) ----
    let fullRead: string;
    try {
      const outcome = await recoverPackageImage(input, {
        fetchPackage: forensicPackageFetch,
        cache: new DriveListingCache(forensicPackageFetch),
        readPageTexts: async (bytes: Uint8Array) => {
          const result = await readPdfPageTextResult(bytes);
          if (!result.ok) throw new Error(`text read failed: ${result.reason}`);
          return result.pages;
        },
      });
      fullRead = describeOutcome(outcome);
    } catch (error) {
      fullRead = `threw: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}`;
    }
    console.log(`    full-read     : ${fullRead}`);

    // ---- pass 3: the exclusive-link license counterfactual, PDFs only ----
    if (kind === 'application/pdf' && !asset.truncated) {
      let licensed: string;
      try {
        const outcome = await electFromPdfBytes(asset.bytes, readPdfPageTextResult, {
          label,
          identifiedBy: 'folder_structure',
          design: designOfRecordOrRow(record),
          identityHints: identity.hints,
          documentName: `${branch.column} (row-linked document)`,
          url: branch.url,
        });
        licensed = describeOutcome(outcome);
        const recovered = outcome as { status?: string; image?: { bytes?: Uint8Array } };
        if (recovered.status === 'recovered' && recovered.image?.bytes) {
          await overlayReport(recovered.image.bytes);
        }
      } catch (error) {
        licensed = `threw: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}`;
      }
      console.log(`    as-licensed   : ${licensed}${shared ? '  [NOT eligible: link is shared]' : ''}`);
      if (!shared && licensed.startsWith('RECOVERED')) {
        verdict.recoverable.push(`${branch.column}: ${licensed}`);
      }
    }

    if (fullRead.startsWith('RECOVERED')) {
      verdict.recoverable.push(`${branch.column} (full read): ${fullRead}`);
    } else if (!asProduction.startsWith('RECOVERED')) {
      verdict.blocked.push(`${branch.column}: ${asProduction}`);
    }
  }

  const rows = manifest.filter((row) => String(row.stock_item_id) === String(item.id));
  if (rows.length) {
    console.log('\n  manifest (builder_stock_source_assets):');
    for (const row of rows) {
      console.log(`    ${row.kind} ${row.state}: ${String(row.reference).slice(0, 90)}`
        + (row.state_detail ? ` — ${String(row.state_detail).slice(0, 120)}` : ''));
    }
  }
}

console.log(`\n${'='.repeat(100)}\nVERDICTS\n`);
for (const verdict of verdicts) {
  console.log(`- ${verdict.label} (${verdict.item})`);
  if (verdict.recoverable.length) {
    console.log('    FACADE EVIDENCE EXISTS IN SOURCE — recoverable via:');
    for (const way of [...new Set(verdict.recoverable)]) console.log(`      • ${way}`);
  } else {
    console.log('    no electable facade found by any pass — blocked branches:');
    for (const block of [...new Set(verdict.blocked)]) console.log(`      • ${block}`);
  }
}
console.log('\nforensics complete (read-only; nothing was written).');
