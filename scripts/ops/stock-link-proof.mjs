#!/usr/bin/env node
/**
 * ===========================================================================
 * A LINKED STOCK LIST — NOTION OR GOOGLE SHEETS — THROUGH THE LIVE PRODUCT.
 * ===========================================================================
 *
 * Tier-0 proves every FILE format a builder can upload. A LINKED source is a
 * different path: the product fetches the builder's own public page itself —
 * a Notion database is read as its rows and their attachments, a Google
 * Sheets link is exported from the tab its `#gid=` names — and nothing in
 * tier-0 does that, because a fixture cannot be a builder's live page.
 *
 * So this imports named REAL public sources, by the upload that first linked
 * them, into an organisation of the run's own, detached from every workspace
 * in the transaction that creates it — so NOTHING it reads reaches any
 * Command Centre — through `import_url`, exactly the request the portal's
 * "Add a link" makes, and then does nothing: the product's own dispatch,
 * continuation and image settler finish it. The builder's own rows are never
 * matched, never written and never read for writing; the proof organisation
 * holds its own copies and they are deleted at the end.
 *
 * It is also the dry run of a builder's "Read again": the same fetch and the
 * same reading the re-read would apply to their list, with none of their rows
 * at stake.
 *
 * THIS REPOSITORY IS PUBLIC, so the log carries no link, no address, no price
 * and no name. A source is named by its kind and a digest of its link, a
 * property by its lot or unit, and a failure by the field and rule it broke.
 *
 * WHAT IT ASSERTS, per source, each by reading the rows the product wrote:
 *   1. the link was accepted and the import finished itself;
 *   2. it read properties;
 *   3. no two properties share a source row (`source_anchor`), so nothing was
 *      inserted twice and no row claimed another's;
 *   4. every property has a place: a suburb that carries none of a list's
 *      design or tags (`·`, `•`), and for a line that states its place, that
 *      place;
 *   5. a postcode is only ever one the source states — in the line, in its
 *      own column, or beside the same suburb in the row's estate — never a
 *      longer suburb's;
 *   6. two packages on one lot stay two properties, each with its own design;
 *   7. the image settler finished every property: a photograph ready on the
 *      card, or an honest account of why not — none left in progress.
 *
 * Runs from the production-rollout workflow (phase `stock-link-proof`), which
 * holds SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER. No secret is
 * printed. `upload_id`: the source uploads to follow (uuids, comma-separated).
 */
import { createHash } from 'node:crypto';
import {
  RUN, UUID, record, net, id, waitFor, stock, seedOrganisation, waitImported,
  cleanup, leftovers, finish, storageFor, NETWORK_REF,
} from './tier0/common.mjs';

const TAG = 'link-proof';
const SOURCES = String(process.env.PROOF_UPLOAD_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const IMPORT_DEADLINE_MS = 12 * 60_000;
const IMAGES_DEADLINE_MS = 25 * 60_000;
/** The two stages the product itself treats as finished (`image_work_stage NOT IN ('settled', 'failed')` is its test for work outstanding). */
const FINISHED = ['settled', 'failed'];

if (!SOURCES.length || SOURCES.some((value) => !UUID.test(value))) {
  console.error('PROOF_UPLOAD_ID must name one or more source uploads (uuids, comma-separated)');
  process.exit(2);
}

const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
/** A list separator: a middle dot or bullet with space either side. */
const SEPARATOR = /\s[·•]\s/;
const STATES = 'NSW|VIC|QLD|WA|SA|TAS|ACT|NT';
const lotOf = (row) => (row.lot_number ? `Lot ${row.lot_number}` : null)
  ?? (row.unit_number ? `Unit ${row.unit_number}` : null)
  ?? (/^\s*(lot|unit)\s*\.?\s*([0-9]+[a-z]?)/i.exec(row.address_line ?? '')?.slice(1, 3).join(' ') ?? 'a property');

/** The place a list's line states, read the way a person reads it: the address field, after the lot, before the state. */
function placeTheLineStates(line) {
  const field = String(line ?? '').split(/\s+[·•]\s+/)[0] ?? '';
  const withoutLot = field.replace(/^\s*(lot|unit)\s*\.?\s*[0-9]+[a-z]?\b\s*[-,]?\s*/i, '');
  const match = /^(.*?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/.exec(withoutLot);
  const place = (match ? match[1] : withoutLot).split(',').pop()?.trim() ?? '';
  // Only a bare place is a claim this proof can check; a street line is the parser's to split.
  return /\d/.test(place) || /\b(street|st|road|rd|avenue|ave|crescent|cres|drive|dr|way|court|ct|place|pl|lane|boulevard|parade|close)\b/i.test(place)
    ? null
    : place || null;
}

const itemsOfUpload = (orgId) => net('items', `
  SELECT i.id, i.lot_number, i.unit_number, i.address_line, i.suburb, i.state, i.postcode,
         i.development_name, i.source_row->>'postcode' AS stated_postcode,
         i.source_row->>'source_anchor' AS anchor, i.source_row->>'house_design' AS design,
         i.lifecycle_status, i.image_work_stage, i.primary_image_id,
         public.builder_stock_photo_is_source_ready(i.primary_image_id) AS photo_ready
    FROM public.builder_stock_items i
   WHERE i.organisation_id = ${id(orgId)}
   ORDER BY i.lot_number, i.address_line`);

let storage = null;
try {
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);

  const sources = await net('sources', `
    SELECT id, source_url, records_imported
      FROM public.builder_stock_uploads
     WHERE id IN (${SOURCES.map(id).join(', ')}) AND source_type = 'url' AND source_url IS NOT NULL`);
  record('every named source is a linked stock list', sources.length === SOURCES.length,
    `${sources.length} of ${SOURCES.length}`);

  for (const source of sources) {
    const url = String(source.source_url);
    const kind = /notion\.(site|so)/i.test(url) ? 'notion'
      : /docs\.google\.com\/spreadsheets/i.test(url) ? 'google-sheets' : 'link';
    const label = `${kind} ${digest(url)}`;
    console.log(`\n${label}${/[#?&]gid=/.test(url) ? ' (names a tab)' : ''} — its builder's last reading: ${source.records_imported ?? '?'} properties`);

    const org = await seedOrganisation(TAG, `${kind}-${digest(url).slice(0, 6)}`);
    const added = await stock({ operation: 'import_url', url }, org.cookie);
    const uploadId = added.json?.upload?.id ?? added.json?.upload_id ?? null;
    record(`${label}: the product accepted the link`, added.status === 200 && Boolean(uploadId),
      `HTTP ${added.status}${added.json?.code ? ` (${added.json.code})` : ''}`);
    if (!uploadId) continue;

    const imported = await waitImported(uploadId, IMPORT_DEADLINE_MS);
    const upload = imported.upload ?? {};
    record(`${label}: the import finished by itself`, Boolean(imported.done) && !upload.error_code,
      `${upload.status ?? '?'} after ${Math.round((imported.ms ?? 0) / 1000)} s`
        + `${upload.error_code ? `, ${upload.error_code}` : ''}, recovered ${upload.import_recovery_attempts ?? 0} time(s)`);

    let rows = await itemsOfUpload(org.orgId);
    record(`${label}: it read properties`, rows.length > 0,
      `${rows.length} read (detected ${upload.records_detected ?? '?'}, imported ${upload.records_imported ?? '?'})`);

    // 3. One property per source row.
    const anchors = rows.map((row) => row.anchor).filter(Boolean);
    const repeated = anchors.filter((anchor, index) => anchors.indexOf(anchor) !== index);
    record(`${label}: no source row is held twice, and every property names its row`,
      repeated.length === 0 && anchors.length === rows.length,
      `${rows.length} properties, ${new Set(anchors).size} distinct rows${repeated.length ? `, ${repeated.length} repeated` : ''}`);

    // 4. A place, and the place the line states.
    const noPlace = rows.filter((row) => !String(row.suburb ?? '').trim());
    const listTail = rows.filter((row) => SEPARATOR.test(String(row.suburb ?? '')));
    const wrongPlace = rows.filter((row) => {
      const stated = SEPARATOR.test(String(row.address_line ?? '')) ? placeTheLineStates(row.address_line) : null;
      return stated && String(row.suburb ?? '').trim().toLowerCase() !== stated.toLowerCase();
    });
    record(`${label}: every property has a suburb`, noPlace.length === 0,
      noPlace.length ? `none on ${noPlace.map(lotOf).join(', ')}` : `${rows.length} of ${rows.length}`);
    record(`${label}: no suburb carries the list's design or tags`, listTail.length === 0,
      listTail.length ? `${listTail.length}: ${listTail.map(lotOf).join(', ')}` : 'none');
    record(`${label}: a dot-separated line's suburb is the place it states`, wrongPlace.length === 0,
      wrongPlace.length ? `${wrongPlace.map(lotOf).join(', ')}` : `${rows.filter((r) => SEPARATOR.test(String(r.address_line ?? ''))).length} lines checked`);

    // 5. A postcode the source states, and no other.
    const unstated = rows.filter((row) => {
      if (!row.postcode) return false;
      const code = String(row.postcode);
      if (String(row.stated_postcode ?? '') === code) return false;
      if (new RegExp(`\\b${code}\\b`).test(String(row.address_line ?? ''))) return false;
      const estate = String(row.development_name ?? '');
      const suburb = String(row.suburb ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const beside = new RegExp(`\\b${suburb}\\s*,?\\s+(?:${STATES})\\s+${code}\\b|\\b${suburb}\\s*,?\\s+${code}\\s+(?:${STATES})\\b`);
      return !beside.test(estate);
    });
    const postcodes = rows.filter((row) => row.postcode).length;
    record(`${label}: every postcode is one the source states`, unstated.length === 0,
      unstated.length ? `unstated on ${unstated.map(lotOf).join(', ')}` : `${postcodes} postcode(s), all stated`);

    // 6. Two packages on one lot stay two.
    const byLot = new Map();
    for (const row of rows) {
      const lot = row.lot_number ?? /^\s*lot\s*\.?\s*([0-9]+[a-z]?)/i.exec(row.address_line ?? '')?.[1];
      if (!lot) continue;
      byLot.set(lot, [...(byLot.get(lot) ?? []), row]);
    }
    const shared = [...byLot.entries()].filter(([, list]) => list.length > 1);
    const collapsed = shared.filter(([, list]) => new Set(list.map((row) => String(row.address_line ?? ''))).size < list.length);
    record(`${label}: packages sharing a lot stay separate properties`, collapsed.length === 0,
      shared.length
        ? `${shared.length} lot(s) carry ${shared.reduce((n, [, list]) => n + list.length, 0)} packages${collapsed.length ? `; collapsed: ${collapsed.map(([lot]) => `Lot ${lot}`).join(', ')}` : ''}`
        : 'no lot carries two packages in this list');

    // 7. The pictures, settled.
    const images = await waitFor('images', async () => {
      rows = await itemsOfUpload(org.orgId);
      const moving = rows.filter((row) => !FINISHED.includes(String(row.image_work_stage ?? '')));
      return { done: rows.length > 0 && moving.length === 0, moving: moving.length };
    }, IMAGES_DEADLINE_MS, 15_000);
    const withPhoto = rows.filter((row) => row.primary_image_id && row.photo_ready);
    const stages = rows.reduce((acc, row) => ({ ...acc, [row.image_work_stage ?? 'none']: (acc[row.image_work_stage ?? 'none'] ?? 0) + 1 }), {});
    record(`${label}: the image settler finished every property`, Boolean(images.done),
      `${Math.round((images.ms ?? 0) / 1000)} s; stages ${JSON.stringify(stages)}`);
    record(`${label}: properties with their photograph on the card`, withPhoto.length > 0,
      `${withPhoto.length} of ${rows.length}`, { required: false });
    const live = rows.filter((row) => row.lifecycle_status === 'active').length;
    console.log(`  note  ${label}: ${live} of ${rows.length} would be live (published) in this detached organisation`);
  }
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 500));
} finally {
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this run made remains',
      Object.values(left.network).every((value) => Number(value) === 0)
        && Object.values(left.command).every((value) => Number(value) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('stock-link-proof', { run: RUN, sources: SOURCES.length });
}
