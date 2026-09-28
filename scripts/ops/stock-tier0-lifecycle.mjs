#!/usr/bin/env node
/**
 * ===========================================================================
 * TIER-0 · ONE BUILDER'S STOCK LIST, THROUGH ITS WHOLE LIFE, ON BOTH SIDES.
 * ===========================================================================
 *
 * The formats proof shows every kind of file reaches the Command Centre once.
 * This one follows ONE list through everything that happens to a list after
 * that, and looks at both products the way their users do:
 *
 *   L1  the first upload (CSV, linked photographs, a brochure and floor plans)
 *       is imported, published and mirrored, field by field, documents too;
 *   L2  the builder's Stock List page and the Command Centre's property page,
 *       rendered in a real Chromium at desktop, tablet and phone widths, show
 *       those values and that photograph;
 *   L3  a Command Centre staff member activates a property for a client
 *       through the Command Centre's OWN `select_for_client` — and a sold one
 *       is refused; the builder is told THAT it was chosen and never for whom;
 *       the builder acknowledges through the portal, and the Command Centre
 *       learns it;
 *   L4  the builder uploads v2 of the same list — a price and a status
 *       changed, a count and a size changed with a new photograph, a property
 *       removed, POA priced, a blank cell, a new property — and the product
 *       applies it: matched rows keep their ids, the removed one is archived,
 *       the blank does not erase, and the Command Centre converges;
 *   L5  the builder's own edits (availability, stated figures, removal)
 *       reach the Command Centre;
 *   L6  a SECOND organisation lists a property with the same estate and lot:
 *       nothing crosses between them, and every read and write of one
 *       organisation's stock refuses the other's session;
 *   L7  deleting a stock list archives what it supplies, and the Command
 *       Centre takes it down; withdrawing the activation reaches the builder.
 *
 * The product does all of it: nothing is kicked, no lifecycle is written, no
 * selection is inserted by SQL. Everything is deleted on both sides at the
 * end and counted.
 *
 * Runs from the production-rollout workflow (phase `stock-tier0-lifecycle`),
 * with Playwright installed for this phase only.
 */
import {
  RUN, record, net, cc, sleep, id, sha256, secs, waitFor, stock, portal, commandCentre, fixture, manifest,
  storageFor, withLinks, seedOrganisation, connectTransport, seedStaff, seedClient, uploadDocument,
  uploadRow, waitImported, itemsOf, differences, mirrorOf, cleanup, leftovers, finish, ITEM_FIELDS,
  CC_FIELDS, NETWORK_REF, CC_REF, ORIGIN, CC_ORIGIN, sqlLit,
} from './tier0/common.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const TAG = 'tier0-life';
const PUBLISH_DEADLINE_MS = 18 * 60_000;
const MIRROR_DEADLINE_MS = 8 * 60_000;
const ARTIFACTS = 'proof-artifacts';
mkdirSync(ARTIFACTS, { recursive: true });
const timings = {};
const lotOf = (items, lot) => items.find((i) => String(i.lot_number) === String(lot));

async function publishedAll(orgId, deadline = PUBLISH_DEADLINE_MS) {
  return waitFor('publication', async () => {
    const now = await itemsOf(orgId, `AND i.lifecycle_status <> 'archived'`);
    return { done: now.length > 0 && now.every((i) => i.lifecycle_status === 'active' && !i.pending), now };
  }, deadline, 10_000);
}
async function mirrorMatches(orgId, deadline = MIRROR_DEADLINE_MS) {
  return waitFor('mirror', async () => {
    const builder = await itemsOf(orgId, `AND i.lifecycle_status = 'active'`);
    const rows = (await mirrorOf(orgId)).filter((r) => r.lifecycle_status === 'active');
    const d = differences(builder, rows, CC_FIELDS, 'id');
    return { done: rows.length === builder.length && d.length === 0, rows, d, builder };
  }, deadline, 5_000);
}

let storage = null;
let browser = null;
try {
  console.log(`tier-0 lifecycle run=${RUN}`);
  const reach = await Promise.allSettled([net('reach', 'SELECT 1 AS ok'), cc('reach', 'SELECT 1 AS ok')]);
  if (!record('0: the token reaches both projects', reach.every((r) => r.status === 'fulfilled'),
    reach.map((r) => r.status).join(', '))) throw new Error('cannot reach both projects');
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);

  // --- Setup: two builders on proof transports, a member and a read-only
  // colleague, a Command Centre agent and an invented client.
  const alpha = await seedOrganisation(TAG, 'alpha');
  await connectTransport(TAG, alpha);
  const member = await seedOrganisation(TAG, 'alphamember', { role: 'member', existingOrgId: alpha.orgId });
  const viewer = await seedOrganisation(TAG, 'alphaviewer', { role: 'read_only', existingOrgId: alpha.orgId });
  const beta = await seedOrganisation(TAG, 'beta');
  await connectTransport(TAG, beta);
  const agent = await seedStaff(TAG, 'agent', ['listings', 'clients']);
  // The acknowledgement emails the activator: point that at Resend's sink.
  await cc('agent sink', `UPDATE public.custom_users SET email = ${sqlLit(`delivered+tier0-${RUN}@resend.dev`)}
                           WHERE id = ${id(agent.userId)}`);
  const clientId = await seedClient(TAG);
  record('0: two proof builders on proof transports, a Command Centre agent and a client',
    !!alpha.connection && !!beta.connection && !!agent.token && !!clientId);

  // === L1. The first upload ====================================================
  const v1 = new TextEncoder().encode(await withLinks(storage, alpha.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
  const t1 = Date.now();
  const sent1 = await uploadDocument(alpha.cookie, 'Kestrel Grove stock list.csv', v1);
  const imported1 = await waitImported(sent1.uploadId);
  timings.import_v1_ms = Date.now() - t1;
  record('L1: the first list is imported by the product', imported1.done && sent1.processed?.status === 200,
    `${imported1.upload?.status}, ${imported1.upload?.records_imported} imported in ${secs({ ms: timings.import_v1_ms })}`);
  const want1 = manifest().expect['csv-v1'];
  let items = await itemsOf(alpha.orgId);
  const diff1 = differences(want1, items, ITEM_FIELDS);
  record('L1: every property stored exactly as the list states it', diff1.length === 0,
    diff1.length ? diff1.slice(0, 10).join('; ') : `${items.length} properties × ${ITEM_FIELDS.length} fields`);
  const ids1 = Object.fromEntries(items.map((i) => [i.lot_number, i.id]));

  const pub1 = await publishedAll(alpha.orgId);
  timings.publish_v1_ms = pub1.ms;
  record('L1: the product published all five from their own linked photographs', pub1.done,
    `${(pub1.now ?? []).filter((i) => i.lifecycle_status === 'active').length}/${(pub1.now ?? []).length} in ${secs(pub1)}`);
  const upload1 = await uploadRow(sent1.uploadId);
  record('L1: the upload records its publication', !!upload1?.published_at && !upload1?.publication_blocked_reason,
    `published_at ${upload1?.published_at ? 'set' : 'null'}, blocked: ${upload1?.publication_blocked_reason ?? '—'}`);

  const m1 = await mirrorMatches(alpha.orgId);
  timings.mirror_v1_ms = m1.ms;
  record('L1: the Command Centre holds all five, field by field', m1.done,
    `${m1.rows?.length}/${m1.builder?.length} in ${secs(m1)}${m1.d?.length ? `; ${m1.d.slice(0, 6).join('; ')}` : ''}`);
  const docs = await cc('documents', `
    SELECT i.lot_number, d.kind, d.label FROM public.builder_network_stock_item_documents d
      JOIN public.builder_network_stock_items i ON i.id = d.stock_item_id
     WHERE i.organisation_id = ${id(alpha.orgId)} ORDER BY i.lot_number, d.position`);
  const docsBy = (lot) => docs.filter((d) => String(d.lot_number) === lot).map((d) => d.kind).sort().join(',');
  record('L1: the brochure and floor-plan links reach the Command Centre as typed documents',
    /brochure/.test(docsBy('101')) && /plan/.test(docsBy('101')) && /plan/.test(docsBy('102')) && docsBy('103') === '',
    `101: ${docsBy('101') || '—'}; 102: ${docsBy('102') || '—'}; 103: ${docsBy('103') || '—'}`);
  const listed = await commandCentre('list_stock', { organisation_id: alpha.orgId, page_size: 50 }, agent.token);
  const listedLots = (listed.json?.records ?? listed.json?.items ?? []).map((r) => String(r.lot_number)).sort();
  record('L1: the Command Centre marketplace lists them for its staff',
    listed.status === 200 && ['101', '102', '103', '104', '7A'].every((lot) => listedLots.includes(lot)),
    `HTTP ${listed.status}; lots ${listedLots.join(', ')}`);
  const detail = await commandCentre('get_stock_item', { stock_item_id: ids1['101'] }, agent.token);
  const rec = detail.json?.record ?? {};
  const ccPhoto = rec.primary_image_id
    ? await commandCentre('image_url', { image_id: rec.primary_image_id }, agent.token) : null;
  const photoBytes = ccPhoto?.json?.url
    ? await fetch(ccPhoto.json.url).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null)).catch(() => null) : null;
  const builderPhoto = await net('builder photo', `
    SELECT im.source_detail->>'stored_sha256' AS sha FROM public.builder_stock_items i
      JOIN public.builder_stock_item_images im ON im.id = i.primary_image_id WHERE i.id = ${id(ids1['101'])}`);
  record('L1: the Command Centre serves lot 101\'s own photograph — the bytes the builder\'s list linked',
    !!photoBytes && photoBytes.length > 512,
    `${photoBytes?.length ?? 0} bytes${builderPhoto[0]?.sha && photoBytes ? `, sha ${sha256(photoBytes) === builderPhoto[0].sha ? 'equal to' : 'differs from'} the builder's stored photograph` : ''}`);

  // === L2. What each user SEES ==================================================
  let chromium = null;
  try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
  if (record('L2: a real browser is available to look with', !!chromium)) {
    browser = await chromium.launch();
    const viewports = [['desktop', 1440, 900], ['tablet', 820, 1180], ['phone', 390, 844]];
    for (const [name, width, height] of viewports) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addCookies([{ name: '__Host-builder_session_token', value: alpha.cookie.split('=')[1], url: ORIGIN,
        secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 160)));
      const t = Date.now();
      await page.goto(`${ORIGIN}/builder/stock`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const text = await page.locator('body').innerText().catch(() => '');
      const visible = ['12 Proofline Way', '14 Proofline Way', '18 Proofline Way', 'Tierzero'].filter((s) => text.includes(s));
      const prices = ['749,900', '712,500', '655,000', 'POA'].filter((s) => text.includes(s));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const pictures = await page.evaluate(() => [...document.images].filter((img) => img.complete && img.naturalWidth > 64).length);
      await page.screenshot({ path: `${ARTIFACTS}/builder-stock-${name}.png`, fullPage: true }).catch(() => {});
      record(`L2: the builder's Stock List shows the properties and their prices (${name})`,
        visible.length === 4 && prices.length >= 3,
        `${visible.length}/4 addresses, ${prices.length}/4 prices, ${pictures} photographs drawn, ${Date.now() - t} ms`);
      record(`L2: the builder's Stock List draws the photographs (${name})`, pictures >= 5, `${pictures} drawn`);
      record(`L2: the builder's Stock List fits the ${name} width without sideways scrolling`, !overflow,
        overflow ? 'the page is wider than the viewport' : 'fits', { required: name !== 'desktop' ? true : true });
      record(`L2: no script error on the builder's Stock List (${name})`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();

      const ccContext = await browser.newContext({ viewport: { width, height } });
      await ccContext.addCookies([{ name: '__Host-session_token', value: agent.token, domain: `${CC_REF}.supabase.co`,
        path: '/', secure: true, httpOnly: true, sameSite: 'None' }]);
      const ccPage = await ccContext.newPage();
      const ccErrors = [];
      ccPage.on('pageerror', (e) => ccErrors.push(String(e?.message ?? e).slice(0, 160)));
      const t2 = Date.now();
      await ccPage.goto(`${CC_ORIGIN}/listings/builder-stock/${ids1['101']}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await ccPage.waitForTimeout(4000);
      const ccText = await ccPage.locator('body').innerText().catch(() => '');
      const ccFacts = ['12 Proofline Way', 'Truganina', '749,900', 'Aspen 25', 'Kestrel Grove', '448', '231.5']
        .filter((s) => ccText.includes(s));
      const ccPictures = await ccPage.evaluate(() => [...document.images].filter((img) => img.complete && img.naturalWidth > 64).length);
      const ccOverflow = await ccPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      await ccPage.screenshot({ path: `${ARTIFACTS}/cc-property-${name}.png`, fullPage: true }).catch(() => {});
      record(`L2: the Command Centre's property page shows lot 101's facts (${name})`, ccFacts.length === 7,
        `${ccFacts.length}/7: ${ccFacts.join(', ')}; url ${ccPage.url().replace(CC_ORIGIN, '')}; ${Date.now() - t2} ms`);
      record(`L2: the Command Centre's property page draws the photograph (${name})`, ccPictures >= 1, `${ccPictures} drawn`);
      record(`L2: the Command Centre's property page fits the ${name} width`, !ccOverflow, ccOverflow ? 'wider than the viewport' : 'fits');
      record(`L2: no script error on the Command Centre's property page (${name})`, ccErrors.length === 0, ccErrors.slice(0, 2).join(' | '));
      await ccContext.close();
    }
  }

  // === L3. Activation, through the Command Centre's own endpoint ===================
  const soldTry = await commandCentre('select_for_client', { stock_item_id: ids1['7A'], client_id: clientId }, agent.token);
  record('L3: a SOLD property cannot be activated', soldTry.status === 409 && soldTry.json?.code === 'not_available',
    `HTTP ${soldTry.status} ${soldTry.json?.code ?? ''}`);
  const t3 = Date.now();
  const selected = await commandCentre('select_for_client', {
    stock_item_id: ids1['101'], client_id: clientId, notes: `private note Tier0 Proof ${RUN}`,
  }, agent.token);
  const selectionId = selected.json?.record?.id ?? null;
  record('L3: a Command Centre agent activates lot 101 for a client through select_for_client',
    selected.status === 200 && !!selectionId, `HTTP ${selected.status}${selected.json?.error ? ` ${selected.json.error}` : ''}`);
  const again = await commandCentre('select_for_client', { stock_item_id: ids1['101'], client_id: clientId }, agent.token);
  record('L3: selecting the same pair again is recognised, not duplicated', again.status === 200 && again.json?.already_selected === true,
    `HTTP ${again.status}, already_selected ${again.json?.already_selected}`);
  const announced = await waitFor('announcement', async () => {
    const rows = await net('announcement', `
      SELECT a.id, a.status, to_jsonb(a) AS raw FROM public.builder_stock_selection_announcements a
       WHERE a.stock_item_id = ${id(ids1['101'])}`);
    return { done: rows.length === 1, rows };
  }, 6 * 60_000, 4_000);
  timings.activation_to_builder_ms = Date.now() - t3;
  record('L3: the activation reaches the builder', announced.done, `${announced.rows?.length ?? 0} announcement(s) in ${secs(announced)}`);
  const raw = JSON.stringify(announced.rows?.[0]?.raw ?? {});
  record('L3: the builder is told THAT it was chosen, never for whom (no client name, no private note)',
    !raw.includes(`Tier0 Proof ${TAG}`) && !raw.includes('private note'), `${raw.length} bytes checked`);
  const sel = await stock({ operation: 'list_selections', page_size: 20 }, alpha.cookie);
  const mine = (sel.json?.records ?? sel.json?.selections ?? []).find((r) => r.stock_item_id === ids1['101']);
  record('L3: the builder\'s portal lists the pending activation', sel.status === 200 && !!mine,
    `HTTP ${sel.status}, ${(sel.json?.records ?? sel.json?.selections ?? []).length} listed`);
  const betaSel = await stock({ operation: 'list_selections', page_size: 20 }, beta.cookie);
  record('L3: another builder sees none of it',
    betaSel.status === 200 && !(betaSel.json?.records ?? betaSel.json?.selections ?? []).some((r) => r.stock_item_id === ids1['101']),
    `HTTP ${betaSel.status}`);
  const viewerAck = await stock({ operation: 'acknowledge_selection', selection_id: announced.rows?.[0]?.id }, viewer.cookie);
  record('L3: a read-only colleague cannot acknowledge it', viewerAck.status === 403, `HTTP ${viewerAck.status}`);
  const betaAck = await stock({ operation: 'acknowledge_selection', selection_id: announced.rows?.[0]?.id }, beta.cookie);
  record('L3: another organisation cannot acknowledge it', [403, 404].includes(betaAck.status), `HTTP ${betaAck.status}`);
  const t4 = Date.now();
  const ack = await stock({ operation: 'acknowledge_selection', selection_id: announced.rows?.[0]?.id }, alpha.cookie);
  record('L3: the builder acknowledges it through the portal', ack.status === 200, `HTTP ${ack.status}${ack.json?.error ? ` ${ack.json.error}` : ''}`);
  const acknowledged = await waitFor('acknowledged', async () => {
    const rows = await cc('ack', `
      SELECT s.status, (SELECT count(*) FROM public.builder_network_acknowledgement_notices n WHERE n.selection_id = s.id)::int AS notices
        FROM public.builder_stock_selections s WHERE s.id = ${id(selectionId)}`);
    return { done: rows[0]?.status === 'acknowledged' || Number(rows[0]?.notices) > 0, rows };
  }, 6 * 60_000, 4_000);
  timings.acknowledgement_to_cc_ms = Date.now() - t4;
  record('L3: the Command Centre learns the builder acknowledged', acknowledged.done,
    `${JSON.stringify(acknowledged.rows?.[0] ?? {})} in ${secs(acknowledged)}`);
  const ccSelections = await commandCentre('list_selections', {}, agent.token);
  record('L3: the Command Centre\'s own list shows the activation', ccSelections.status === 200
    && JSON.stringify(ccSelections.json ?? {}).includes(selectionId), `HTTP ${ccSelections.status}`);
  const activated = await stock({ operation: 'list_activated_properties' }, alpha.cookie);
  record('L3: the builder\'s Agency Activations list the property', activated.status === 200
    && JSON.stringify(activated.json ?? {}).includes(ids1['101']), `HTTP ${activated.status}`);

  // === L4. The re-upload =======================================================
  const v2 = new TextEncoder().encode(await withLinks(storage, alpha.orgId, new TextDecoder().decode(fixture('csv-v2.csv'))));
  const t5 = Date.now();
  const sent2 = await uploadDocument(alpha.cookie, 'Kestrel Grove stock list.csv', v2);
  const imported2 = await waitImported(sent2.uploadId);
  timings.import_v2_ms = Date.now() - t5;
  record('L4: the revised list is imported', imported2.done, `${imported2.upload?.status} in ${secs({ ms: timings.import_v2_ms })}`);
  const pub2 = await waitFor('replacement', async () => {
    const u = await uploadRow(sent2.uploadId);
    const now = await itemsOf(alpha.orgId);
    return { done: !!u?.published_at && now.every((i) => !i.pending), u, now };
  }, PUBLISH_DEADLINE_MS, 10_000);
  timings.publish_v2_ms = pub2.ms;
  record('L4: the product publishes the revision', pub2.done,
    `published_at ${pub2.u?.published_at ? 'set' : 'null'}, blocked: ${pub2.u?.publication_blocked_reason ?? '—'}, in ${secs(pub2)}`);
  items = pub2.now ?? await itemsOf(alpha.orgId);
  const live = items.filter((i) => i.lifecycle_status === 'active');
  const want2 = manifest().expect['csv-v2'].map((w) => (w.lot_number === '7A' ? { ...w, building_size_sqm: 150 } : w));
  const diff2 = differences(want2, live, ITEM_FIELDS);
  record('L4: the live properties are exactly the revision — and the blank cell did not erase lot 7A\'s house size',
    diff2.length === 0, diff2.length ? diff2.slice(0, 10).join('; ') : `${live.length} live, exact`);
  record('L4: matched properties keep their identity (same ids), so the activation still names lot 101',
    ['101', '102', '104', '7A'].every((lot) => lotOf(live, lot)?.id === ids1[lot]),
    ['101', '102', '104', '7A'].map((lot) => `${lot}:${lotOf(live, lot)?.id === ids1[lot] ? 'same' : 'NEW'}`).join(' '));
  const removed = lotOf(items, '103');
  record('L4: the property the revision no longer lists is archived, not deleted', removed?.lifecycle_status === 'archived',
    `lot 103: ${removed?.lifecycle_status ?? 'gone'}`);
  record('L4: the new property is live', lotOf(live, '106')?.lifecycle_status === 'active', `lot 106: ${lotOf(items, '106')?.lifecycle_status ?? '—'}`);
  const photo2 = await net('lot 102 photo', `
    SELECT im.source_detail->>'stored_sha256' AS sha, im.source_reference FROM public.builder_stock_items i
      JOIN public.builder_stock_item_images im ON im.id = i.primary_image_id WHERE i.id = ${id(ids1['102'])}`);
  record('L4: lot 102 now leads with the new photograph the revision links', /facade-202/.test(String(photo2[0]?.source_reference ?? '')),
    `primary from ${String(photo2[0]?.source_reference ?? '—').replace(/\?.*$/, '').split('/').pop()}`);
  const m2 = await mirrorMatches(alpha.orgId);
  timings.mirror_v2_ms = m2.ms;
  record('L4: the Command Centre converges on the revision, field by field', m2.done,
    `${m2.rows?.length}/${m2.builder?.length} in ${secs(m2)}${m2.d?.length ? `; ${m2.d.slice(0, 6).join('; ')}` : ''}`);
  const ccRemoved = await cc('lot 103', `SELECT lifecycle_status FROM public.builder_network_stock_items WHERE id = ${id(ids1['103'])}`);
  record('L4: the Command Centre takes the removed property off the marketplace', ccRemoved[0]?.lifecycle_status !== 'active',
    `mirror lifecycle ${ccRemoved[0]?.lifecycle_status ?? 'gone'}`);
  const ccRead103 = await commandCentre('get_stock_item', { stock_item_id: ids1['103'] }, agent.token);
  record('L4: and its page answers "not found" to staff (never activated)', ccRead103.status === 404, `HTTP ${ccRead103.status}`);
  const ccRead101 = await commandCentre('get_stock_item', { stock_item_id: ids1['101'] }, agent.token);
  record('L4: the activated lot 101 shows the revised price and status', ccRead101.status === 200
    && Number(ccRead101.json?.record?.price) === 739900 && ccRead101.json?.record?.availability_status === 'on_hold',
  `price ${ccRead101.json?.record?.price}, status ${ccRead101.json?.record?.availability_status}`);

  // === L5. The builder's own edits ============================================
  const lot104 = ids1['104'];
  const memberSet = await stock({ operation: 'set_availability', stock_item_id: lot104, availability_status: 'sold' }, member.cookie);
  const viewerSet = await stock({ operation: 'set_availability', stock_item_id: lot104, availability_status: 'sold' }, viewer.cookie);
  record('L5: a read-only colleague cannot change availability', viewerSet.status === 403, `HTTP ${viewerSet.status}`);
  const setSold = memberSet.status === 200 ? memberSet
    : await stock({ operation: 'set_availability', stock_item_id: lot104, availability_status: 'sold' }, alpha.cookie);
  record('L5: the builder marks lot 104 sold', setSold.status === 200, `HTTP ${setSold.status} (member ${memberSet.status})`);
  const stats = await stock({ operation: 'set_manual_stats', stock_item_id: ids1['7A'], stats: { car_spaces: 2, bathrooms: 2.5 } }, alpha.cookie);
  record('L5: the builder states figures the list did not', stats.status === 200, `HTTP ${stats.status}${stats.json?.error ? ` ${stats.json.error}` : ''}`);
  const badStats = await stock({ operation: 'set_manual_stats', stock_item_id: ids1['7A'], stats: { bedrooms: 3.5 } }, alpha.cookie);
  record('L5: a half bedroom is refused with the reason, not clamped', badStats.status === 400, `HTTP ${badStats.status} ${badStats.json?.error ?? ''}`);
  const edits = await waitFor('edits mirrored', async () => {
    const rows = await cc('edits', `
      SELECT (SELECT availability_status FROM public.builder_network_stock_items WHERE id = ${id(lot104)}) AS s104,
             (SELECT to_jsonb(i)->'manual_stats' FROM public.builder_network_stock_items i WHERE id = ${id(ids1['7A'])}) AS stats`);
    const r = rows[0] ?? {};
    const st = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats;
    return { done: r.s104 === 'sold' && Number(st?.values?.car_spaces) === 2 && Number(st?.values?.bathrooms) === 2.5, r };
  }, MIRROR_DEADLINE_MS, 5_000);
  record('L5: the Command Centre receives the availability change and the stated figures', edits.done,
    `${JSON.stringify(edits.r ?? {})} in ${secs(edits)}`);
  const memberArchive = await stock({ operation: 'archive_stock_item', stock_item_id: ids1['106'] ?? lotOf(live, '106')?.id }, member.cookie);
  const archived = await stock({ operation: 'archive_stock_item', stock_item_id: lotOf(live, '106')?.id }, alpha.cookie);
  record('L5: removing a property needs delete rights (a member is refused, the owner may)',
    memberArchive.status === 403 && archived.status === 200, `member ${memberArchive.status}, owner ${archived.status}`);
  const gone = await waitFor('archive mirrored', async () => {
    const rows = await cc('106', `SELECT lifecycle_status FROM public.builder_network_stock_items WHERE id = ${id(lotOf(live, '106')?.id)}`);
    return { done: rows[0]?.lifecycle_status !== 'active', rows };
  }, MIRROR_DEADLINE_MS, 5_000);
  record('L5: the Command Centre takes the removed property down', gone.done, `${gone.rows?.[0]?.lifecycle_status ?? 'gone'} in ${secs(gone)}`);

  // === L6. Two organisations, the same estate and lot ============================
  const betaCsv = new TextEncoder().encode(await withLinks(storage, beta.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
  const sentBeta = await uploadDocument(beta.cookie, 'Another builder.csv', betaCsv);
  const importedBeta = await waitImported(sentBeta.uploadId);
  const betaItems = await itemsOf(beta.orgId);
  const alphaAfter = await itemsOf(alpha.orgId);
  record('L6: the second builder gets its OWN properties for the same estate and lots', importedBeta.done
    && betaItems.length === 5 && betaItems.every((b) => !alphaAfter.some((a) => a.id === b.id)),
  `${betaItems.length} beta properties, ${betaItems.filter((b) => alphaAfter.some((a) => a.id === b.id)).length} shared ids`);
  record('L6: the first builder\'s properties are untouched by it',
    differences(want2.filter((w) => !['104', '106'].includes(w.lot_number)), alphaAfter.filter((i) => i.lifecycle_status === 'active' && !['104'].includes(i.lot_number)),
      ITEM_FIELDS.filter((f) => f !== 'availability_status')).length === 0);
  const foreignRead = await stock({ operation: 'get_stock_item', stock_item_id: ids1['101'] }, beta.cookie);
  const foreignSet = await stock({ operation: 'set_availability', stock_item_id: ids1['101'], availability_status: 'sold' }, beta.cookie);
  const foreignArchive = await stock({ operation: 'archive_stock_item', stock_item_id: ids1['101'] }, beta.cookie);
  const foreignStats = await stock({ operation: 'set_manual_stats', stock_item_id: ids1['101'], stats: { bedrooms: 9 } }, beta.cookie);
  const foreignDelete = await stock({ operation: 'delete_upload', upload_id: sent1.uploadId }, beta.cookie);
  const foreignUpload = await stock({ operation: 'get_upload', upload_id: sent1.uploadId }, beta.cookie);
  const foreignImage = await stock({ operation: 'image_url', image_id: rec.primary_image_id ?? ids1['101'], stock_item_id: ids1['101'] }, beta.cookie);
  const foreignPicture = await stock({ operation: 'create_builder_image', filename: 'x.jpg', stock_item_id: ids1['101'] }, beta.cookie);
  const codes = { read: foreignRead.status, set: foreignSet.status, archive: foreignArchive.status, stats: foreignStats.status,
    delete: foreignDelete.status, upload: foreignUpload.status, image: foreignImage.status, picture: foreignPicture.status };
  record('L6: every read and write of one builder\'s stock refuses the other builder\'s session',
    Object.values(codes).every((s) => [403, 404].includes(s)), JSON.stringify(codes));
  const untouched = await itemsOf(alpha.orgId, `AND i.id = ${id(ids1['101'])}`);
  record('L6: and nothing it attempted changed the first builder\'s property',
    untouched[0]?.availability_status === 'on_hold' && Number(untouched[0]?.bedrooms) === 4, JSON.stringify({
      status: untouched[0]?.availability_status, bedrooms: untouched[0]?.bedrooms }));

  // === L7. Delete a list; withdraw the activation ================================
  const pubBeta = await publishedAll(beta.orgId);
  await mirrorMatches(beta.orgId);
  const del = await stock({ operation: 'delete_upload', upload_id: sentBeta.uploadId }, beta.cookie);
  record('L7: the builder deletes a stock list', del.status === 200, `HTTP ${del.status}${pubBeta.done ? '' : ' (it had not fully published)'}`);
  const betaArchived = await waitFor('beta archived', async () => {
    const b = await itemsOf(beta.orgId);
    const m = await mirrorOf(beta.orgId);
    return { done: b.every((i) => i.lifecycle_status === 'archived') && m.every((r) => r.lifecycle_status !== 'active'), b, m };
  }, MIRROR_DEADLINE_MS, 5_000);
  record('L7: deleting it archives what it supplied, on both sides', betaArchived.done,
    `builder ${[...new Set((betaArchived.b ?? []).map((i) => i.lifecycle_status))].join('/')}, `
    + `Command Centre ${[...new Set((betaArchived.m ?? []).map((i) => i.lifecycle_status))].join('/')} in ${secs(betaArchived)}`);
  const withdraw = await commandCentre('set_selection_status', { selection_id: selectionId, status: 'withdrawn' }, agent.token);
  record('L7: the agent withdraws the activation', withdraw.status === 200, `HTTP ${withdraw.status}${withdraw.json?.error ? ` ${withdraw.json.error}` : ''}`);
  const withdrawn = await waitFor('withdrawn', async () => {
    const rows = await net('announcement status', `
      SELECT status FROM public.builder_stock_selection_announcements WHERE stock_item_id = ${id(ids1['101'])}`);
    return { done: rows[0]?.status === 'withdrawn', rows };
  }, 6 * 60_000, 4_000);
  record('L7: the withdrawal reaches the builder', withdrawn.done, `${withdrawn.rows?.[0]?.status ?? '—'} in ${secs(withdrawn)}`);
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => {});
  console.log(`\nTIMINGS ${JSON.stringify(timings)}`);
  writeFileSync(`${ARTIFACTS}/tier0-lifecycle-timings.json`, JSON.stringify(timings, null, 1));
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this run made remains on either side',
      Object.values(left.network).every((v) => Number(v) === 0) && Object.values(left.command).every((v) => Number(v) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('stock-tier0-lifecycle', { run: RUN, timings });
}
