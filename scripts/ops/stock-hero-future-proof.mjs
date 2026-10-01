#!/usr/bin/env node
/**
 * ===========================================================================
 * MARKETPLACE HERO v3 — A FUTURE UPLOAD IS FRAMED BY THE NORMAL PRODUCTION
 * PATH, WITH NOBODY CALLING THE PLANNER.
 * ===========================================================================
 *
 * A proof organisation of the run's own (never activated) holds six invented
 * properties, each with ONE synthetic photograph (`fixtures/hero/*.png`,
 * generated from `src/lib/__tests__/fixtures/heroProofCases.ts`; a spec holds
 * the files to that source):
 *
 *   A  a house in a wide brochure page with type in its margins   → crop
 *   B  a panorama: trees, a pole and a fence round a centred house → crop
 *   C  a marketing strip with text beneath the photograph         → crop
 *   D  a house wider than any 16:9 frame                          → fit, building_too_wide
 *   E  an already-good 16:9 photograph                            → original
 *   F  a picture that is planned, then REPLACED by different bytes of other
 *      dimensions: the old plan stops drawing at once, and the new one is
 *      planned and reaches the Command Centre.
 *
 * The photographs are stored and their rows written in the state ingestion
 * leaves a settled, eligible picture in; the properties are activated, so the
 * sync trigger queues them for the Command Centre over a proof-only signed
 * transport (as `stock-media-proof`). From there NOTHING is called: the hero
 * planner's own scheduled job finds them, plans them through the worker and
 * stores the plans; the payload composer carries them; the Command Centre's
 * sweep applies them. The proof only watches, and compares each stored frame
 * with the house it was drawn around (ground truth from the generator).
 *
 * Every row, object, workspace and connection it created is deleted on both
 * sides before it exits, and the deletion is checked. No customer row is read
 * for its content or written. No secret and no link is printed.
 *
 * Runs from the production-rollout workflow (phase `stock-hero-future-proof`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const MARK = 'smoke-rollout';
const TAG = 'hero-proof';
const ORG_PREFIX = `Smoke Rollout ${TAG}`;
const STOCK_IMAGE_BUCKET = 'builder-stock-images';
// The scheduler wakes every ten minutes and plans a few pictures a tick.
const DEADLINE_MS = 35 * 60_000;
const POLL_MS = 20_000;
const HERE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hero');
const TRUTH = JSON.parse(readFileSync(join(HERE, 'truth.json'), 'utf8'));
const ADDRESS = '1 Hero Proof Street';

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

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (a, b, slack = 2) => a.x >= b.x - slack && a.y >= b.y - slack
  && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
const visible = (house, photo) => {
  const x = Math.max(house.x, photo.x), y = Math.max(house.y, photo.y);
  return { x, y, w: Math.min(house.x + house.w, photo.x + photo.w) - x, h: Math.min(house.y + house.h, photo.y + photo.h) - y };
};
const heroDigest = `md5(jsonb_strip_nulls(jsonb_build_object(
    'hero', source_detail->'marketplace_hero',
    'stored', source_detail->'stored_sha256'))::text)`;

// --- The proof ---------------------------------------------------------------
let networkKey = null;
try {
  console.log(`stock hero future-upload proof run=${RUN}`);
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  networkKey = await serviceKey(NETWORK_REF);
  await cleanup('start', networkKey);

  const job = (await net('scheduler', `
    SELECT active FROM cron.job WHERE jobname = 'builder-stock-hero-planner-10min'`))[0];
  if (!record('0: the hero planner\'s own schedule is active (the proof never calls the planner)', job?.active === true,
    `active=${job?.active}`)) throw new Error('scheduler not active');

  const ccDoor = (await net('cc door', `
    SELECT inbound_url FROM public.workspace_connections
     WHERE state = 'active' AND inbound_url LIKE ${sqlLit(`https://${CC_REF}.%/builder-network-inbound`)}
     LIMIT 1`))[0]?.inbound_url;
  const networkDoor = (await cc('network door', `
    SELECT network_inbound_url FROM public.builder_network_connections
     WHERE state = 'active' AND network_inbound_url LIKE '%/builder-network-inbound' LIMIT 1`))[0]?.network_inbound_url;
  if (!record('0: both live inbound doors are known', !!ccDoor && !!networkDoor)) throw new Error('no door');

  // 1. The proof organisation, never activated, and its six properties.
  const orgName = `${ORG_PREFIX} ${RUN} Pty Ltd`;
  const org = (await net('org', `
    INSERT INTO public.builder_organisations(legal_name, org_type)
    VALUES (${sqlLit(orgName)}, 'builder') RETURNING id, status`))[0];
  record('1: the proof organisation is not activated (no workspace is provisioned)', org.status !== 'active', org.status);

  const storageBase = `https://${NETWORK_REF}.supabase.co/storage/v1`;
  const storageHeaders = { Authorization: `Bearer ${networkKey}`, apikey: networkKey };
  async function store(name) {
    const bytes = readFileSync(join(HERE, `${name}.png`));
    if (sha(bytes) !== TRUTH[name].sha256) throw new Error(`fixture ${name} is not the generated picture`);
    const path = `${org.id}/${TAG}/${name}-${RUN}.png`;
    const put = await fetch(`${storageBase}/object/${STOCK_IMAGE_BUCKET}/${path}`, {
      method: 'POST', headers: { ...storageHeaders, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: bytes,
    });
    if (!put.ok) throw new Error(`storing ${name}: HTTP ${put.status}`);
    return { path, bytes, sha: sha(bytes) };
  }
  const cases = ['A', 'B', 'C', 'D', 'E', 'F1'];
  const rows = {};
  for (const [n, name] of cases.entries()) {
    const item = (await net(`item ${name}`, `
      INSERT INTO public.builder_stock_items(
        organisation_id, lifecycle_status, availability_status, image_work_stage, enrichment_status,
        address_line, suburb, state, postcode, lot_number, bedrooms, bathrooms, car_spaces, price_display, description)
      VALUES (${id(org.id)}, 'staged', 'on_hold', 'settled', 'complete',
        ${sqlLit(ADDRESS)}, 'Proofvale', 'VIC', '3999', ${sqlLit(`H${n}${RUN.slice(-3)}`)}, 4, 2, 2,
        'Proof only — not for sale', 'An invented property used to prove hero framing. Not for sale.')
      RETURNING id`))[0].id;
    const stored = await store(name);
    const detail = { role: 'primary_property', marketplace_eligibility_state: 'eligible', stored_sha256: stored.sha };
    const image = (await net(`image ${name}`, `
      INSERT INTO public.builder_stock_item_images(
        stock_item_id, organisation_id, source_stage, verification_status, processing_status,
        storage_bucket, storage_path, content_type, byte_size, source_detail, position)
      VALUES (${id(item)}, ${id(org.id)}, 'uploaded_document', 'source_supplied', 'ready',
        ${sqlLit(STOCK_IMAGE_BUCKET)}, ${sqlLit(stored.path)}, 'image/png', ${stored.bytes.length},
        ${sqlLit(JSON.stringify(detail))}::jsonb, 0)
      RETURNING id`))[0].id;
    await net('primary', `UPDATE public.builder_stock_items SET primary_image_id = ${id(image)} WHERE id = ${id(item)}`);
    rows[name] = { item, image, sha: stored.sha };
  }

  // 2. The proof-only transport to the Command Centre.
  const secret = randomBytes(32).toString('hex');
  const connection = randomUUID();
  await cc('transport', `
    INSERT INTO public.builder_network_connections(
      network_connection_id, builder_org_label, state, scopes, outbound_hmac_secret, network_inbound_url,
      accepted_at, builder_organisation_id)
    VALUES (${id(connection)}, ${sqlLit(orgName)}, 'active', ARRAY['stock:publish'], ${sqlLit(secret)}, ${sqlLit(networkDoor)}, now(), ${id(org.id)})`);
  const workspace = (await net('workspace', `
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), ${sqlLit(`${MARK}-${TAG}-${RUN}`)}, 'Hero proof (temporary)')
    RETURNING id`))[0].id;
  await net('connection', `
    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by, inbound_url,
      outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (${id(connection)}, ${id(workspace)}, ${id(org.id)}, 'active', 'workspace',
      ${sqlLit(ccDoor)}, ${sqlLit(secret)}, now(), now())`);

  // 3. Activated: the sync trigger queues each property for the Command Centre.
  const itemList = Object.values(rows).map((r) => id(r.item)).join(', ');
  await net('activate', `UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE id IN (${itemList})`);
  const startedAt = Date.now();

  // 4. Nothing is called. The scheduler plans; the composer and the Command
  //    Centre's sweep carry the plan across.
  const planOf = async (imageId) => (await net('plan', `
    SELECT source_detail->'marketplace_hero' AS hero, source_detail->>'stored_sha256' AS stored, ${heroDigest} AS digest
      FROM public.builder_stock_item_images WHERE id = ${id(imageId)}`))[0];
  const mirrorDigest = async (imageId) => (await cc('mirror plan', `
    SELECT ${heroDigest} AS digest FROM public.builder_network_stock_item_images WHERE id = ${id(imageId)}`))[0]?.digest ?? null;
  const planned = await waitFor('scheduled planning', async () => {
    const state = {};
    for (const [name, r] of Object.entries(rows)) state[name] = await planOf(r.image);
    const done = Object.entries(rows).every(([name, r]) => state[name]?.hero?.plan?.version >= 3 && state[name]?.hero?.sha256 === r.sha);
    return { done, state };
  });
  record('4: the scheduler planned every new picture, with no planner call by the proof',
    planned.done, `${Math.round((Date.now() - startedAt) / 60000)} min`);
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F1']) {
    const truth = TRUTH[name];
    const plan = planned.state?.[name]?.hero?.plan;
    if (!plan) { record(`4${name}: ${truth.label}`, false, 'no plan'); continue; }
    const subject = visible(truth.subject, truth.photo);
    const ok = plan.mode === truth.expect.mode
      && (!truth.expect.fitReason || plan.fitReason === truth.expect.fitReason)
      && (plan.mode === 'fit' || inside(subject, plan.crop))
      && (!truth.expect.insidePhoto || inside(plan.crop, truth.photo));
    record(`4${name}: ${truth.label} → ${truth.expect.mode}${truth.expect.fitReason ? ` (${truth.expect.fitReason})` : ''}`, ok,
      `${plan.mode}${plan.fitReason ? ` ${plan.fitReason}` : ''}, house whole: ${plan.mode === 'fit' || inside(subject, plan.crop)}`);
  }

  // 5. The Command Centre holds the same plan for every picture.
  const converged = await waitFor('mirror', async () => {
    const pending = [];
    for (const [name, r] of Object.entries(rows)) {
      const here = await planOf(r.image);
      if (!here?.digest || (await mirrorDigest(r.image)) !== here.digest) pending.push(name);
    }
    return { done: pending.length === 0, pending };
  });
  record('5: the Command Centre holds the identical plan for every picture (both portals draw one frame)',
    converged.done, converged.pending?.length ? `waiting: ${converged.pending.join(', ')}` : 'all identical');

  // 6. F — the picture is replaced: different bytes, different dimensions.
  const replacement = await store('F2');
  await net('replace', `
    UPDATE public.builder_stock_item_images
       SET storage_path = ${sqlLit(replacement.path)}, byte_size = ${replacement.bytes.length},
           source_detail = source_detail || ${sqlLit(JSON.stringify({ stored_sha256: replacement.sha }))}::jsonb
     WHERE id = ${id(rows.F1.image)}`);
  const orphan = await planOf(rows.F1.image);
  record('6F: the moment the source changes, the old plan names other bytes and is no longer drawn',
    orphan?.hero?.sha256 === rows.F1.sha && orphan?.stored === replacement.sha);
  const replanned = await waitFor('replacement re-plan', async () => {
    const now = await planOf(rows.F1.image);
    return { done: now?.hero?.sha256 === replacement.sha && now?.hero?.plan?.version >= 3, now };
  });
  const newPlan = replanned.now?.hero?.plan;
  record('6F: the scheduler re-planned the replacement for ITS bytes and dimensions',
    replanned.done && newPlan?.source?.width === TRUTH.F2.width && newPlan?.source?.height === TRUTH.F2.height
      && newPlan?.mode === TRUTH.F2.expect.mode && inside(visible(TRUTH.F2.subject, TRUTH.F2.photo), newPlan.crop),
    replanned.done ? `${newPlan.source.width}x${newPlan.source.height} ${newPlan.mode}` : 'not re-planned');
  const fConverged = await waitFor('replacement mirror', async () => {
    const here = await planOf(rows.F1.image);
    return { done: !!here?.digest && (await mirrorDigest(rows.F1.image)) === here.digest };
  });
  record('6F: both portals converge on the replacement\'s plan', fConverged.done);
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
             (SELECT count(*) FROM public.builder_network_stock_items WHERE address_line = ${sqlLit(ADDRESS)})::int AS items`))[0];
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
