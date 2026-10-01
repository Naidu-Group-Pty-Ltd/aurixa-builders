#!/usr/bin/env node
/**
 * ===========================================================================
 * ONE BUILDER'S STOCK, SIDE BY SIDE: THE PORTAL'S ROWS AND THE COMMAND
 * CENTRE'S MIRROR, PROPERTY BY PROPERTY. READ-ONLY.
 * ===========================================================================
 *
 * The Tier-0 proofs compare the two sides for stock a proof created. After a
 * real builder's list is read again, the question is the same one about THEIR
 * stock, and neither database can answer it alone:
 *
 *   1. every property live in the portal is live in the Command Centre, and
 *      nothing is live there that the portal does not hold live;
 *   2. field by field, the Command Centre holds what the portal holds, and it
 *      names the same photograph;
 *   3. a property the builder removed is live on neither side — not revived,
 *      and not inserted again under a new id for the same source row;
 *   4. no source row is held twice among live properties, no suburb carries a
 *      list's design or tags, and a postcode the estate states beside the
 *      suburb is the one carried.
 *
 * WRITES NOTHING: every statement is a SELECT, and anything else is refused
 * below rather than trusted to the call sites.
 *
 * PRINTS NO VALUE. This repository and its Actions logs are public, so a
 * property is named by its lot and the first eight characters of its id, and
 * a difference by the FIELD that differs — never by what either side holds.
 *
 * Runs from the production-rollout workflow (phase `stock-mirror-parity`) with
 * `organisation_id` set to the builder organisation.
 */
import { record, finish, net, cc, id, UUID, same, CC_FIELDS } from './tier0/common.mjs';

const ORG = String(process.env.TARGET_ORGANISATION_ID || '').trim();
if (!UUID.test(ORG)) {
  console.error('organisation_id must name the builder organisation to compare (a uuid)');
  process.exit(2);
}

const SEPARATOR = /\s[·•]\s/;
const STATES = 'NSW|VIC|QLD|WA|SA|TAS|ACT|NT';
/** The values compared. `lifecycle_status` is compared on its own, below. */
const FIELDS = CC_FIELDS.filter((field) => field !== 'lifecycle_status');

const selectOnly = (run) => (label, text) => {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error(`[${label}] refused: this phase runs SELECT statements only`);
  return run(label, text);
};
const readNetwork = selectOnly(net);
const readMirror = selectOnly(cc);

const short = (value) => String(value ?? '').slice(0, 8);
const lotOf = (row) => (row.lot_number ? `Lot ${row.lot_number}` : null)
  ?? (row.unit_number ? `Unit ${row.unit_number}` : null)
  ?? (/^\s*(lot|unit)\s*\.?\s*([0-9]+[a-z]?)/i.exec(row.address_line ?? '')?.slice(1, 3).join(' ') ?? 'no lot');
const name = (row) => `${lotOf(row)} [${short(row.id)}]`;
const list = (rows, limit = 12) => (rows.length > limit
  ? `${rows.slice(0, limit).join(', ')} … and ${rows.length - limit} more`
  : rows.join(', '));

try {
  const network = await readNetwork('items', `
    SELECT i.id, i.upload_id, ${FIELDS.map((field) => `i.${field}`).join(', ')},
           i.lifecycle_status, i.primary_image_id, i.image_work_stage, i.last_seen_at, i.updated_at,
           i.pending_patch IS NOT NULL AS pending,
           i.source_row->>'source_anchor' AS anchor
      FROM public.builder_stock_items i
     WHERE i.organisation_id = ${id(ORG)}`);
  const mirror = (await readMirror('mirror', `
    SELECT to_jsonb(i) AS row FROM public.builder_network_stock_items i
     WHERE i.organisation_id = ${id(ORG)}`))
    .map((r) => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row));
  const photos = await readMirror('photos', `
    SELECT stock_item_id, upstream_image_id FROM public.builder_network_stock_item_photos
     WHERE organisation_id = ${id(ORG)}`);
  const removals = await readNetwork('removals', `
    SELECT entity_id::text AS id, max(created_at) AS removed_at
      FROM public.builder_portal_activity_log
     WHERE organisation_id = ${id(ORG)} AND action = 'builder_stock_item_archived' AND entity_type = 'stock_item'
     GROUP BY entity_id`);

  const live = network.filter((row) => row.lifecycle_status === 'active');
  const mirrorById = new Map(mirror.map((row) => [String(row.id), row]));
  const mirrorLive = mirror.filter((row) => row.lifecycle_status === 'active');
  const liveIds = new Set(live.map((row) => String(row.id)));
  const photoIds = new Map();
  for (const photo of photos) {
    const key = String(photo.stock_item_id);
    photoIds.set(key, [...(photoIds.get(key) ?? []), String(photo.upstream_image_id)]);
  }

  console.log(`portal: ${network.length} properties (${live.length} live); `
    + `Command Centre mirror: ${mirror.length} (${mirrorLive.length} live); builder removals logged: ${removals.length}`);
  record('the organisation holds stock on both sides', network.length > 0 && mirror.length > 0,
    `${network.length} in the portal, ${mirror.length} mirrored`);

  // 1. Live on both sides, and nothing extra.
  const notMirrored = live.filter((row) => mirrorById.get(String(row.id))?.lifecycle_status !== 'active');
  record('every live property is live in the Command Centre', notMirrored.length === 0,
    notMirrored.length ? `not live there: ${list(notMirrored.map(name))}` : `${live.length} of ${live.length}`);
  const extra = mirrorLive.filter((row) => !liveIds.has(String(row.id)));
  record('nothing is live in the Command Centre that the portal does not hold live', extra.length === 0,
    extra.length ? `live there only: ${list(extra.map(name))}` : `${mirrorLive.length} live there, all live in the portal`);

  // 2. The same values, and the same photograph.
  const differing = [];
  const photoMismatch = [];
  for (const row of live) {
    const held = mirrorById.get(String(row.id));
    if (!held) continue;
    const fields = FIELDS.filter((field) => !same(row[field], held[field]));
    if (fields.length) differing.push(`${name(row)}: ${fields.join(', ')}`);
    const samePrimary = String(row.primary_image_id ?? '') === String(held.primary_image_id ?? '');
    const carried = !row.primary_image_id || (photoIds.get(String(row.id)) ?? []).includes(String(row.primary_image_id));
    if (!samePrimary || !carried) photoMismatch.push(`${name(row)}: ${!samePrimary ? 'a different photograph' : 'photograph not carried'}`);
  }
  record('field by field, the Command Centre holds what the portal holds', differing.length === 0,
    differing.length ? list(differing, 20) : `${live.length} properties × ${FIELDS.length} fields`);
  record('the Command Centre names the same photograph for every live property', photoMismatch.length === 0,
    photoMismatch.length ? list(photoMismatch) : `${live.filter((row) => row.primary_image_id).length} photographs, the same on both sides`);

  // 2b. The Marketplace Hero plan, and the fingerprints it is keyed on, are the
  // same on both sides — so the two portals draw the same frame. Compared as
  // digests of jsonb text (which Postgres renders canonically); no plan or
  // picture is printed.
  // jsonb_strip_nulls on both sides: the composer sends the plan with its
  // null keys removed, and the readers treat a missing key as null.
  const heroDigest = `md5(jsonb_strip_nulls(jsonb_build_object(
      'hero', source_detail->'marketplace_hero',
      'stored', source_detail->'stored_sha256',
      'measured', source_detail->'marketplace_measured_sha256',
      'derivative', source_detail->'sanitized_derivative'->'derivative_sha256'))::text)`;
  const primaryIds = live.map((row) => row.primary_image_id).filter(Boolean).map(String);
  if (primaryIds.length) {
    const inList = primaryIds.map((value) => id(value)).join(', ');
    const networkHero = await readNetwork('hero', `
      SELECT id::text AS id, ${heroDigest} AS digest, source_detail ? 'marketplace_hero' AS planned,
             source_detail->'marketplace_hero'->'plan'->>'mode' AS mode
        FROM public.builder_stock_item_images WHERE id IN (${inList})`);
    const mirrorHero = await readMirror('hero', `
      SELECT id::text AS id, ${heroDigest} AS digest, source_detail ? 'marketplace_hero' AS planned
        FROM public.builder_network_stock_item_images WHERE id IN (${inList})`);
    const mirrorDigest = new Map(mirrorHero.map((row) => [String(row.id), row]));
    const heroMismatch = networkHero.filter((row) => mirrorDigest.get(String(row.id))?.digest !== row.digest);
    const modes = networkHero.reduce((acc, row) => ({ ...acc, [row.mode ?? 'none']: (acc[row.mode ?? 'none'] ?? 0) + 1 }), {});
    record('the Command Centre holds the same hero plan as the portal for every live card', heroMismatch.length === 0,
      heroMismatch.length
        ? `${heroMismatch.length} differ: ${list(heroMismatch.map((row) => short(row.id)))}`
        : `${networkHero.length} cards, ${networkHero.filter((row) => row.planned).length} planned (${JSON.stringify(modes)}), identical on both sides`);
  }

  // 3. What the builder removed stays removed, on both sides and by source row.
  const removedIds = new Set(removals.map((row) => String(row.id)));
  const removedRows = network.filter((row) => removedIds.has(String(row.id)));
  const revived = removedRows.filter((row) => row.lifecycle_status === 'active');
  record('a property the builder removed is not live in the portal', revived.length === 0,
    revived.length ? `live again: ${list(revived.map(name))}` : `${removedRows.length} removed, all still archived`);
  const revivedThere = removedRows.filter((row) => mirrorById.get(String(row.id))?.lifecycle_status === 'active');
  record('a property the builder removed is not live in the Command Centre', revivedThere.length === 0,
    revivedThere.length ? `live there: ${list(revivedThere.map(name))}` : `${removedRows.length} removed, none live there`);
  const removedAnchors = new Set(removedRows
    .filter((row) => row.lifecycle_status !== 'active' && row.anchor)
    .map((row) => String(row.anchor)));
  const reinserted = live.filter((row) => row.anchor && removedAnchors.has(String(row.anchor)));
  record('no removed property came back under a new id for the same source row', reinserted.length === 0,
    reinserted.length ? `same source row, new property: ${list(reinserted.map(name))}` : `${removedAnchors.size} removed source rows checked`);

  // 4. One property per source row; places read, not copied from the list's tail.
  const anchors = live.map((row) => row.anchor).filter(Boolean);
  const repeated = [...new Set(anchors.filter((anchor, index) => anchors.indexOf(anchor) !== index))];
  record('no source row is held twice among live properties', repeated.length === 0,
    repeated.length ? `${repeated.length} source row(s) held more than once` : `${anchors.length} live properties name ${new Set(anchors).size} source rows`);
  const tail = live.filter((row) => SEPARATOR.test(String(row.suburb ?? ''))
    || SEPARATOR.test(String(mirrorById.get(String(row.id))?.suburb ?? '')));
  record('no suburb carries the list\'s design or tags, on either side', tail.length === 0,
    tail.length ? list(tail.map(name)) : `${live.length} live properties`);
  const stated = [];
  const dropped = [];
  for (const row of live) {
    const suburb = String(row.suburb ?? '').trim();
    const estate = String(row.development_name ?? '');
    if (!suburb || !row.state) continue;
    const numbers = new Set(Array.from(estate.matchAll(/(?<!\d)\d{4}(?!\d)/g), (m) => m[0]));
    if (numbers.size !== 1) continue;
    const escaped = suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const beside = new RegExp(`\\b${escaped}\\s*,?\\s+(?:${STATES})\\s+(\\d{4})\\b`, 'i').exec(estate);
    if (!beside) continue;
    stated.push(row);
    if (String(row.postcode ?? '') !== beside[1]) dropped.push(name(row));
  }
  record('a postcode the estate states beside the suburb is the one carried', dropped.length === 0,
    dropped.length ? `not carried: ${list(dropped)}` : `${stated.length} live propert${stated.length === 1 ? 'y states' : 'ies state'} one`);

  // Where the work stands, for the reader; nothing here fails the phase.
  const moving = live.filter((row) => !['settled', 'failed'].includes(String(row.image_work_stage ?? '')));
  record('every live property\'s pictures are settled', moving.length === 0,
    moving.length ? `still moving: ${list(moving.map(name))}` : `${live.length} settled`, { required: false });
  const pending = live.filter((row) => row.pending);
  record('no live property is waiting on a patch', pending.length === 0,
    pending.length ? list(pending.map(name)) : 'none waiting', { required: false });
} catch (error) {
  record('the comparison completed', false, String(error?.message ?? error).slice(0, 300));
}
finish('stock-mirror-parity');
