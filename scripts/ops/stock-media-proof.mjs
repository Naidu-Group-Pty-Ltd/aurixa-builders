#!/usr/bin/env node
/**
 * ===========================================================================
 * A PROPERTY'S PHOTOGRAPHS AND DOCUMENTS REACH THE COMMAND CENTRE — PROVED ON
 * THE LIVE PRODUCT, OVER THE REAL SIGNED NETWORK PATH.
 * ===========================================================================
 *
 * Both projects are driven with the workflow's one management token (the same
 * reach `network-connection-remap` already relies on):
 *
 *   1. a proof organisation of the run's own, NEVER activated — activation
 *      would provision it onto every whole-network workspace — holding one
 *      property with two stored builder photographs and two document links;
 *   2. a proof-only transport: a network connection on this side and its
 *      mirror on the Command Centre, sharing a secret minted for this run and
 *      addressed at the two LIVE inbound doors. Nothing else is connected;
 *   3. the property travels the real way — the sync trigger, the outbox, the
 *      outbox worker's signature, the Command Centre's door, its main sweep
 *      and its media sweep, each on its own schedule;
 *   4. what arrived is checked against what was sent: the figures, the one
 *      elected photograph (served, as bytes, by the network's own door), the
 *      typed documents, and the Command Centre's own `get_stock_item`;
 *   5. replay makes no duplicate, a replaced photograph converges, a removed
 *      one disappears, a changed document converges;
 *   6. another organisation's signed payload cannot attach media to this
 *      property, and the door will not serve an image the builder did not
 *      publish;
 *   7. a malformed media block, signed and delivered, is refused while the
 *      property still takes the event.
 *
 * Every row, object, workspace and connection it created is deleted on both
 * sides before it exits, and the deletion is checked. No customer row is read
 * for its content or written. No secret and no link is printed.
 *
 * Runs from the production-rollout workflow (phase `stock-media-proof`).
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'media-proof';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 5_000;

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value) => {
  if (!UUID.test(String(value))) throw new Error('not a uuid');
  return `'${value}'::uuid`;
};

async function query(ref, label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 300)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}
const net = (label, sql) => query(NETWORK_REF, `network ${label}`, sql);
const cc = (label, sql) => query(CC_REF, `cc ${label}`, sql);

async function serviceKey(ref) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!response.ok) throw new Error(`api-keys ${ref.slice(0, 4)}…: HTTP ${response.status}`);
  const keys = await response.json();
  const legacy = (Array.isArray(keys) ? keys : []).find((k) => k?.name === 'service_role');
  if (!legacy?.api_key) throw new Error('no service_role key');
  return legacy.api_key;
}

/** A small, real PNG of one colour — enough bytes to be an image and to be told apart. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFor(label, check) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < DEADLINE_MS) {
    last = await check();
    if (last?.done) return { ...last, ms: Date.now() - startedAt };
    await sleep(POLL_MS);
  }
  return { ...(last ?? {}), done: false, ms: Date.now() - startedAt, timedOut: label };
}

// --- Cleanup: everything this proof ever created, on both sides -------------
async function cleanup(stage, networkKey) {
  const orgs = await net(`${stage}: proof organisations`, `
    SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)}`);
  const orgIds = orgs.map((row) => row.id).filter((value) => UUID.test(value));
  const ccConnections = await cc(`${stage}: proof connections`, `
    SELECT id, builder_organisation_id FROM public.builder_network_connections
     WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)}`);
  const ccOrgIds = [...new Set([...orgIds,
    ...ccConnections.map((row) => row.builder_organisation_id).filter((v) => UUID.test(String(v)))])];

  if (networkKey && orgIds.length) {
    const base = `https://${NETWORK_REF}.supabase.co/storage/v1`;
    const headers = { Authorization: `Bearer ${networkKey}`, apikey: networkKey };
    for (const orgId of orgIds) {
      const list = await fetch(`${base}/object/list/${STOCK_IMAGE_BUCKET}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${orgId}/${TAG}/`, limit: 100, offset: 0 }),
      });
      const entries = list.ok ? await list.json() : [];
      const paths = (Array.isArray(entries) ? entries : []).filter((e) => e.id)
        .map((e) => `${orgId}/${TAG}/${e.name}`);
      if (paths.length) {
        await fetch(`${base}/object/${STOCK_IMAGE_BUCKET}`, {
          method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths }),
        });
      }
    }
  }

  if (orgIds.length) {
    const orgList = orgIds.map(id).join(', ');
    // The property first, while its connection still stands: releasing the
    // primary queues one more event (harmless — removed just below), where
    // the same write after the connection was gone would raise a false
    // "no route" alarm.
    await net(`${stage}: property`, `
      UPDATE public.builder_stock_items SET primary_image_id = NULL WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_item_images WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_stock_items WHERE organisation_id IN (${orgList});`);
    await net(`${stage}: rows`, `
      DELETE FROM public.builder_network_outbox WHERE connection_id IN
        (SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.builder_network_inbound_events WHERE connection_id IN
        (SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.builder_network_stamps WHERE connection_id IN
        (SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.workspace_connection_events WHERE connection_id IN
        (SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgList}));
      DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgList});
      DELETE FROM public.builder_organisations WHERE id IN (${orgList});`);
  }
  await net(`${stage}: proof workspaces`, `
    DELETE FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)}`);

  // The Command Centre last: a delivery already in flight from this side lands
  // before its rows are removed, or is refused by a door that no longer knows
  // the connection.
  if (ccOrgIds.length || ccConnections.length) {
    const orgList = ccOrgIds.length ? ccOrgIds.map(id).join(', ') : 'NULL::uuid';
    const connList = ccConnections.length ? ccConnections.map((row) => id(row.id)).join(', ') : 'NULL::uuid';
    await cc(`${stage}: rows`, `
      DELETE FROM public.builder_network_stock_items WHERE organisation_id IN (${orgList});
      DELETE FROM public.builder_network_stock_organisations WHERE id IN (${orgList});
      DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connList});
      DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connList});
      DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connList});
      DELETE FROM public.portal_operational_alerts WHERE event_id IN (
        SELECT e.id FROM public.portal_operational_events e WHERE e.metadata->>'connection_id' IN
          (SELECT c.id::text FROM public.builder_network_connections c WHERE c.id IN (${connList})));
      DELETE FROM public.portal_operational_events WHERE metadata->>'connection_id' IN
        (SELECT c.id::text FROM public.builder_network_connections c WHERE c.id IN (${connList}));
      DELETE FROM public.builder_network_connections WHERE id IN (${connList});`);
  }

}

// --- The proof ---------------------------------------------------------------
let networkKey = null;
try {
  console.log(`stock media proof run=${RUN}`);

  // 0. Reach, and the deploy this proves.
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  networkKey = await serviceKey(NETWORK_REF);
  const ccKey = await serviceKey(CC_REF);
  await cleanup('start', networkKey);

  const shipped = await cc('shipped', `
    SELECT to_regclass('public.builder_network_stock_item_photos') IS NOT NULL AS tables,
           to_regprocedure('public.builder_network_apply_stock_media(integer)') IS NOT NULL AS sweep,
           EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-media-apply-1min' AND active) AS cron`);
  const composer = await net('composer', `
    SELECT position('''media''' IN pg_get_functiondef('public.builder_network_compose_stock_item_payload(uuid)'::regprocedure)) > 0 AS media`);
  if (!record('0: the Command Centre converger and the network composer are deployed',
    shipped[0]?.tables && shipped[0]?.sweep && shipped[0]?.cron && composer[0]?.media,
    JSON.stringify({ ...shipped[0], composer: composer[0]?.media }))) throw new Error('not deployed');

  // The two live doors, read from connections that already use them.
  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)}
     LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');
  const imageDoor = networkDoor.replace(/\/builder-network-inbound$/, '/builder-network-stock-image?id=');

  // 1. A proof organisation, never activated, and its property.
  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const otherName = `${ORG_PREFIX} other ${RUN} Pty Ltd`;
  const orgRows = await net('orgs', `
    INSERT INTO public.builder_organisations(legal_name, org_type)
    VALUES (${sqlLit(orgName)}, 'builder'), (${sqlLit(otherName)}, 'builder')
    RETURNING id, legal_name, status`);
  const org = orgRows.find((r) => r.legal_name === orgName);
  const other = orgRows.find((r) => r.legal_name === otherName);
  record('1: the proof organisations are not activated (no workspace is provisioned)',
    orgRows.every((r) => r.status !== 'active'), orgRows.map((r) => r.status).join(', '));

  const doc = (name) => `https://example.com/${TAG}/${RUN}/${name}.pdf`;
  const sourceRow = { unmapped: { 'Brochure URL': doc('brochure'), 'Floor Plan': doc('floor-plan'), 'Build Price': '$1' } };
  const item = (await net('item', `
    INSERT INTO public.builder_stock_items(
      organisation_id, lifecycle_status, availability_status, image_work_stage, enrichment_status,
      address_line, suburb, state, postcode, lot_number, bedrooms, bathrooms, car_spaces,
      building_size_sqm, land_size_sqm, price, price_display, description, source_row)
    VALUES (${id(org.id)}, 'staged', 'on_hold', 'settled', 'complete',
      '1 Media Proof Street', 'Proofvale', 'VIC', '3999', '9${RUN.slice(-3)}', 4, 2, 2,
      211.5, 400, 500000, 'Proof only — not for sale',
      'An invented property used to prove the network sync. Not for sale.',
      ${sqlLit(JSON.stringify(sourceRow))}::jsonb)
    RETURNING id`))[0].id;

  const storageBase = `https://${NETWORK_REF}.supabase.co/storage/v1`;
  const storageHeaders = { Authorization: `Bearer ${networkKey}`, apikey: networkKey };
  const photos = {};
  for (const [name, colour] of [['one', [40, 90, 160]], ['two', [160, 110, 60]]]) {
    const bytes = png(96, 64, colour);
    const path = `${org.id}/${TAG}/${name}-${RUN}.png`;
    const put = await fetch(`${storageBase}/object/${STOCK_IMAGE_BUCKET}/${path}`, {
      method: 'POST', headers: { ...storageHeaders, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: bytes,
    });
    if (!put.ok) throw new Error(`storing photograph ${name}: HTTP ${put.status}`);
    const detail = { role: 'primary_property', marketplace_eligibility_state: 'eligible', stored_sha256: sha(bytes) };
    const row = (await net(`image ${name}`, `
      INSERT INTO public.builder_stock_item_images(
        stock_item_id, organisation_id, source_stage, verification_status, processing_status,
        storage_bucket, storage_path, content_type, byte_size, source_detail, position)
      VALUES (${id(item)}, ${id(org.id)}, 'uploaded_document', 'source_supplied', 'ready',
        ${sqlLit(STOCK_IMAGE_BUCKET)}, ${sqlLit(path)}, 'image/png', ${bytes.length},
        ${sqlLit(JSON.stringify(detail))}::jsonb, ${name === 'one' ? 0 : 1})
      RETURNING id`))[0];
    photos[name] = { id: row.id, sha: sha(bytes) };
  }
  await net('primary', `UPDATE public.builder_stock_items SET primary_image_id = ${id(photos.one.id)} WHERE id = ${id(item)}`);

  // 2. The proof-only transport.
  const secret = randomBytes(32).toString('hex');
  const connection = randomUUID();
  const otherConnection = randomUUID();
  const otherSecret = randomBytes(32).toString('hex');
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(org.id)}),
           (${id(otherConnection)}, ${sqlLit(otherName)}, 'active', ARRAY['stock:publish'], ${sqlLit(otherSecret)}, ${sqlLit(networkDoor)}, now(), ${id(other.id)})`);
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Media proof (temporary)')
    RETURNING id`))[0].id;
  await net('connection', `
    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(org.id)}, 'active', 'workspace',
      ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);
  const connections = await net('connections', `
    SELECT count(*)::int AS n FROM public.workspace_connections WHERE builder_organisation_id IN (${id(org.id)}, ${id(other.id)})`);
  record('2: the proof organisation reaches exactly one workspace: the proof transport',
    Number(connections[0]?.n) === 1, `${connections[0]?.n} connection(s)`);

  // 3. The property travels the real way: the trigger queues it on activation.
  await net('activate item', `UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id = ${id(item)}`);

  const ccMirror = () => cc('mirror', `
    SELECT i.address_line, i.suburb, i.state, i.postcode, i.lot_number, i.bedrooms::int AS bedrooms,
           i.bathrooms::int AS bathrooms, i.car_spaces::int AS car_spaces, i.building_size_sqm::text AS building,
           i.land_size_sqm::text AS land, i.price_display, i.availability_status, i.description,
           i.organisation_id, i.primary_image_id, i.lifecycle_status,
           (SELECT coalesce(json_agg(p.upstream_image_id || '|' || p.position || '|' || p.external_url ORDER BY p.position), '[]')
              FROM public.builder_network_stock_item_photos p WHERE p.stock_item_id = i.id) AS photos,
           (SELECT coalesce(json_agg(d.kind || '|' || d.label || '|' || d.url ORDER BY d.position), '[]')
              FROM public.builder_network_stock_item_documents d WHERE d.stock_item_id = i.id) AS documents,
           (SELECT m.media_version FROM public.builder_network_stock_item_media m WHERE m.stock_item_id = i.id) AS media_version,
           -- Only property events carry media. A catalogue reconciliation is
           -- consumed by the main sweep and never stamped by the media sweep,
           -- so counting it here would wait for ever.
           (SELECT count(*) FROM public.builder_network_inbound_events e
             WHERE e.connection_id = c.id
               AND (e.processed_at IS NULL
                    OR (e.event_type = 'stock.item.upserted' AND e.media_applied_at IS NULL))) AS waiting
      FROM public.builder_network_stock_items i
      JOIN public.builder_network_connections c ON c.network_connection_id = ${id(connection)}
     WHERE i.id = ${id(item)}`);
  const settled = async (predicate) => waitFor('mirror', async () => {
    const row = (await ccMirror())[0];
    const outstanding = await net('outbox', `
      SELECT count(*)::int AS n FROM public.builder_network_outbox
       WHERE connection_id = ${id(connection)} AND status <> 'delivered'`);
    return { row, done: !!row && Number(row.waiting) === 0 && Number(outstanding[0]?.n) === 0 && predicate(row) };
  });
  const asList = (value) => (typeof value === 'string' ? JSON.parse(value) : value) ?? [];
  const photoIds = (row) => asList(row?.photos).map((entry) => entry.split('|')[0]);

  const arrived = await settled((row) => photoIds(row).length === 1);
  const row = arrived.row ?? {};
  record('3: the property arrives on the Command Centre', arrived.done,
    `${Math.round(arrived.ms / 1000)} s${arrived.timedOut ? ' (timed out)' : ''}`);
  const source = (await net('source', `
    SELECT address_line, suburb, state, postcode, lot_number, bedrooms::int AS bedrooms,
           bathrooms::int AS bathrooms, car_spaces::int AS car_spaces, building_size_sqm::text AS building,
           land_size_sqm::text AS land, price_display, availability_status, description, organisation_id
      FROM public.builder_stock_items WHERE id = ${id(item)}`))[0];
  const fields = Object.keys(source);
  const differing = fields.filter((key) => String(source[key]) !== String(row[key]));
  record('3: every value matches the Builder Portal\'s', differing.length === 0,
    differing.length ? `differ: ${differing.join(', ')}` : `${fields.length} fields`);

  // 4. The photograph, the gallery, the documents.
  record('4: exactly one photograph — the one the portal elected — and it is served by the network door',
    JSON.stringify(asList(row.photos)) === JSON.stringify([`${photos.one.id}|0|${imageDoor}${photos.one.id}`]),
    `${asList(row.photos).length} photo(s)`);
  record('4: the card\'s primary is the same photograph (the gallery cannot draw it twice)',
    row.primary_image_id === photos.one.id);
  record('4: the documents arrive typed and labelled', JSON.stringify(asList(row.documents)) === JSON.stringify([
    `brochure|Brochure|${doc('brochure')}`, `floor_plan|Floor Plan|${doc('floor-plan')}`,
  ]), `${asList(row.documents).length} document(s)`);

  const served = async (imageId) => {
    const response = await fetch(`${imageDoor}${imageId}`, { redirect: 'follow' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, sha: response.ok ? sha(bytes) : null };
  };
  const one = await served(photos.one.id);
  record('4: the photograph shows: the door serves the very bytes stored', one.status === 200 && one.sha === photos.one.sha,
    `HTTP ${one.status}`);
  const unelected = await served(photos.two.id);
  record('6: the door will not serve an image the builder did not publish', unelected.status === 404,
    `HTTP ${unelected.status}`);

  // The Command Centre's own read, over HTTP, as a system caller.
  const ccRead = async (stockItemId) => {
    const response = await fetch(`https://${CC_REF}.supabase.co/functions/v1/builder-stock-marketplace`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ccKey}`, apikey: ccKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'get_stock_item', stock_item_id: stockItemId }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const page = await ccRead(item);
  record('4: the page\'s read answers: the record, one photograph, two documents, no activation',
    page.status === 200 && page.json?.record?.id === item && page.json?.photos?.length === 1
      && page.json?.photos?.[0]?.id === photos.one.id && page.json?.documents?.length === 2
      && Array.isArray(page.json?.activations) && page.json.activations.length === 0,
    `HTTP ${page.status}`);
  const missing = await ccRead(randomUUID());
  record('4: a property that is not there answers as absent', missing.status === 404, `HTTP ${missing.status}`);

  // Activation, read-only, on the live record: what the page says equals the table.
  const activated = (await cc('an activated property', `
    SELECT s.stock_item_id, count(*)::int AS n,
           string_agg(s.status, ',' ORDER BY s.selected_at DESC) AS statuses
      FROM public.builder_stock_selections s
      JOIN public.builder_network_stock_items i ON i.id = s.stock_item_id AND i.lifecycle_status = 'active'
     GROUP BY s.stock_item_id ORDER BY max(s.selected_at) DESC LIMIT 1`))[0];
  if (activated) {
    const read = await ccRead(activated.stock_item_id);
    const statuses = (read.json?.activations ?? []).map((a) => a.status).join(',');
    record('4: an activated property\'s page states its activation record exactly (read-only)',
      read.status === 200 && statuses === activated.statuses
        && (read.json?.activations ?? []).every((a) => a.selected_at && !('internal_notes' in a)),
      `${activated.n} activation(s)`);
  } else {
    record('4: an activated property\'s page states its activation record (none to read)', true, 'no activation exists');
  }

  // 5. Replay, replacement, removal, a changed document.
  const versionBefore = Number(row.media_version);
  await net('replay', `SELECT public.builder_network_enqueue_stock_item(${id(item)}); SELECT public.builder_network_enqueue_stock_item(${id(item)});`);
  const replayed = await settled((r) => Number(r.media_version) > versionBefore);
  const rowCounts = (await cc('row counts', `
    SELECT (SELECT count(*) FROM public.builder_network_stock_item_photos WHERE stock_item_id = ${id(item)})::int AS photos,
           (SELECT count(*) FROM public.builder_network_stock_item_documents WHERE stock_item_id = ${id(item)})::int AS documents`))[0];
  record('5: replay makes no duplicate', replayed.done && rowCounts.photos === 1 && rowCounts.documents === 2,
    `${rowCounts.photos} photo row(s), ${rowCounts.documents} document row(s)`);

  await net('replace', `UPDATE public.builder_stock_items SET primary_image_id = ${id(photos.two.id)} WHERE id = ${id(item)}`);
  const replaced = await settled((r) => JSON.stringify(photoIds(r)) === JSON.stringify([photos.two.id]));
  const two = await served(photos.two.id);
  const oneAfter = await served(photos.one.id);
  record('5: a replaced photograph converges, and the door follows it',
    replaced.done && two.status === 200 && two.sha === photos.two.sha && oneAfter.status === 404,
    `new ${two.status}, old ${oneAfter.status}`);

  await net('document', `
    UPDATE public.builder_stock_items
       SET source_row = jsonb_set(source_row, '{unmapped,Brochure URL}', ${sqlLit(JSON.stringify(doc('brochure-v2')))}::jsonb)
     WHERE id = ${id(item)}`);
  const redoc = await settled((r) => asList(r.documents).includes(`brochure|Brochure|${doc('brochure-v2')}`));
  record('5: a changed document converges, the photograph untouched',
    redoc.done && asList(redoc.row?.documents).length === 2
      && JSON.stringify(photoIds(redoc.row)) === JSON.stringify([photos.two.id]));

  await net('remove', `UPDATE public.builder_stock_item_images SET processing_status = 'pending' WHERE id = ${id(photos.two.id)}`);
  const removed = await settled((r) => photoIds(r).length === 0);
  record('5: a removed photograph disappears, the documents stay',
    removed.done && asList(removed.row?.documents).length === 2);

  await net('restore', `UPDATE public.builder_stock_item_images SET processing_status = 'ready' WHERE id = ${id(photos.two.id)}`);
  const restored = await settled((r) => JSON.stringify(photoIds(r)) === JSON.stringify([photos.two.id]));
  record('5: a photograph made ready again returns', restored.done);

  // 6 & 7. Signed deliveries of our own, through the same live door.
  const deliver = async (connectionId, connectionSecret, payload, sourceVersion) => {
    const rawBody = JSON.stringify({
      event_type: 'stock.item.upserted', dedupe_key: `${TAG}:${RUN}:${randomUUID()}`,
      payload, source_version: sourceVersion,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(ccDoor, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-aurixa-connection': connectionId,
        'x-aurixa-timestamp': timestamp,
        'x-aurixa-signature': createHmac('sha256', connectionSecret).update(`${timestamp}.${rawBody}`).digest('hex'),
      },
      body: rawBody,
    });
    return response.status;
  };
  const composed = (await net('composed', `SELECT public.builder_network_compose_stock_item_payload(${id(item)}) AS p`))[0].p;
  const payload = typeof composed === 'string' ? JSON.parse(composed) : composed;

  const intruder = await deliver(otherConnection, otherSecret, {
    ...payload, organisation_id: other.id,
    organisation: { id: other.id, legal_name: otherName },
    media: { schema_version: 1, photos: [{ id: photos.one.id, position: 0 }], documents: [] },
  }, 1);
  await cc('sweep', 'SELECT * FROM public.builder_network_apply_inbound_events(50); SELECT * FROM public.builder_network_apply_stock_media(50);');
  const afterIntruder = (await ccMirror())[0];
  const refusal = (await cc('refusal', `
    SELECT e.media_apply_error, e.processed_at IS NOT NULL AS processed FROM public.builder_network_inbound_events e
      JOIN public.builder_network_connections c ON c.id = e.connection_id
     WHERE c.network_connection_id = ${id(otherConnection)} ORDER BY e.received_at DESC LIMIT 1`))[0];
  record('6: another organisation\'s signed payload cannot attach media to this property',
    intruder === 200 && afterIntruder?.organisation_id === org.id
      && JSON.stringify(photoIds(afterIntruder)) === JSON.stringify([photos.two.id])
      && String(refusal?.media_apply_error ?? '').startsWith('refused:'),
    `door ${intruder}, ${refusal?.media_apply_error ?? 'no refusal recorded'}`);

  const topVersion = Number((await cc('top version', `
    SELECT coalesce(max(e.source_version), 0) AS v FROM public.builder_network_inbound_events e
      JOIN public.builder_network_connections c ON c.id = e.connection_id
     WHERE c.network_connection_id = ${id(connection)}`))[0]?.v ?? 0);
  const broken = await deliver(connection, secret, {
    ...payload, description: `Media failure proof ${RUN}`,
    media: { schema_version: 1, photos: 'not-a-list', documents: [] },
  }, topVersion + 1);
  await cc('sweep', 'SELECT * FROM public.builder_network_apply_inbound_events(50); SELECT * FROM public.builder_network_apply_stock_media(50);');
  const afterBroken = (await ccMirror())[0];
  const afterPage = await ccRead(item);
  record('7: a malformed media block is refused; the property takes the event and still opens',
    broken === 200 && afterBroken?.description === `Media failure proof ${RUN}`
      && afterBroken?.lifecycle_status === 'active'
      && JSON.stringify(photoIds(afterBroken)) === JSON.stringify([photos.two.id])
      && afterPage.status === 200 && afterPage.json?.photos?.length === 1,
    `door ${broken}, page ${afterPage.status}`);
} catch (error) {
  record('the proof ran to the end', false, String(error?.message ?? error).slice(0, 300));
} finally {
  try {
    await cleanup('end', networkKey);
    const leftNetwork = (await net('left', `
      SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS orgs,
             (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE ${sqlLit(`${MARK}-${TAG}-%`)})::int AS workspaces`))[0];
    const leftCc = (await cc('left', `
      SELECT (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`${ORG_PREFIX} %`)})::int AS connections,
             (SELECT count(*) FROM public.builder_network_stock_items WHERE address_line = '1 Media Proof Street')::int AS items`))[0];
    record('cleanup: nothing this run created is left on either side',
      leftNetwork.orgs === 0 && leftNetwork.workspaces === 0 && leftCc.connections === 0 && leftCc.items === 0,
      JSON.stringify({ ...leftNetwork, ...leftCc }));
  } catch (error) {
    record('cleanup ran', false, String(error?.message ?? error).slice(0, 300));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
