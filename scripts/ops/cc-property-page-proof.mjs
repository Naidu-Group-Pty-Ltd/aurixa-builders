#!/usr/bin/env node
/**
 * ===========================================================================
 * THE COMMAND CENTRE'S PROPERTY PAGE, AS A STAFF MEMBER SEES IT.
 * ===========================================================================
 *
 * The Tier-0 lifecycle proof reads the Command Centre's property page in a
 * real Chromium, and on 1 October 2026 every one of those reads met
 * Cloudflare's bot challenge on the custom domain — and three page checks
 * PASSED on the challenge. This proof does one thing and does it strictly:
 *
 *   P0  every page read must first be the product's own page — not a
 *       challenge, not a 4xx/5xx document, not a sign-in or error or guard
 *       page, still at the path asked for, drawn by the app (heading, its own
 *       function calls). Every other check is reported FAILED, never passed,
 *       on anything else. The custom domain is asked first; where it
 *       challenges, the Command Centre's own first-party Lovable origin (named
 *       in its CORS and CSRF allow-lists) is used and the run says so.
 *   P1  a builder of the run's own uploads a list through the product; it is
 *       imported, published and mirrored, field by field;
 *   P2  the property page, at desktop, tablet and phone widths, states every
 *       figure the builder's own row holds — address, lot, estate, design,
 *       price, bedrooms, bathrooms, car spaces, home and land size, the
 *       builder, availability — and draws the property's OWN photograph (the
 *       bytes the page loads are the builder's stored bytes), fits the width,
 *       raises no script error; its document links answer, its back link
 *       lands on the marketplace, and its activation button is offered;
 *   P3  the builder re-reads a revised list (a property removed, one added,
 *       a price changed); the removed property's page says it is not
 *       available and carries none of its facts, the new one's page is live
 *       with its own, and the revised price is shown.
 *
 * No screenshot and no page text of anything but this run's own seeded
 * property is ever printed: this repository is public. Everything is deleted
 * on both sides at the end and counted.
 *
 * Runs from the production-rollout workflow (phase `cc-property-page-proof`),
 * with Playwright installed for this phase only.
 */
import {
  RUN, record, net, cc, id, sha256, waitFor, fixture, manifest, storageFor, withLinks, seedOrganisation,
  connectTransport, seedStaff, uploadDocument, waitImported, itemsOf, mirrorOf, differences, cleanup,
  leftovers, finish, commandCentre, CC_FIELDS, NETWORK_REF, inspectCommandCentrePage, readCommandCentreProperty,
} from './tier0/common.mjs';

const TAG = 'cc-page';
const VIEWPORTS = [['desktop', 1440, 900], ['tablet', 820, 1180], ['phone', 390, 844]];
const AVAILABILITY = {
  available: 'Available', on_hold: 'On hold', reserved: 'Reserved', contracted: 'Under contract',
  sold: 'Sold', settled: 'Settled', withdrawn: 'Withdrawn', unknown: 'Not stated',
};
const SELECTABLE = new Set(['available', 'on_hold']);

const audPrice = (price) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
  .format(Number(price));
const number = (text) => (text === undefined || text === null ? null : Number(String(text).replace(/[^0-9.]/g, '')));

async function publishedAll(orgId) {
  return waitFor('publication', async () => {
    const now = await itemsOf(orgId, `AND i.lifecycle_status <> 'archived'`);
    return { done: now.length > 0 && now.every((i) => i.lifecycle_status === 'active' && !i.pending), now };
  }, 18 * 60_000, 10_000);
}
async function mirrored(orgId) {
  return waitFor('mirror', async () => {
    const builder = await itemsOf(orgId, `AND i.lifecycle_status = 'active'`);
    const rows = (await mirrorOf(orgId)).filter((r) => r.lifecycle_status === 'active');
    const d = differences(builder, rows, CC_FIELDS, 'id');
    return { done: rows.length === builder.length && d.length === 0, rows, d };
  }, 8 * 60_000, 5_000);
}

/** Every check on one page, each FAILED (never passed) when the page is not the product's. */
async function provePropertyPage(browser, { label, token, item, builderName, viewport, storedSha, expectDocuments }) {
  const seen = await inspectCommandCentrePage(browser, { token, path: `/listings/builder-stock/${item.id}`, viewport, wait: 6_000 });
  const where = `${seen.navigation.origin}${seen.challengedOrigins.length ? ` (custom domain challenged: ${seen.challengedOrigins.join(', ')})` : ''}`;
  const real = record(`P0: ${label} is the Command Centre's own page — not a challenge, error, sign-in or guard page`,
    seen.real, `${seen.real ? 'real' : seen.notReal.join('; ')}; HTTP ${seen.navigation.status}; via ${where}; calls ${seen.calls.join(' ')}`);
  const must = (name, ok, detail) => record(`${name} (${label})`, real && ok, real ? detail : `not the product's page: ${seen.notReal.join('; ')}`);
  const shown = real ? await readCommandCentreProperty(seen.page) : { facts: {}, text: '', header: '', documents: [] };
  const f = shown.facts;

  const wantFacts = {
    Lot: String(item.lot_number), Address: item.address_line, Estate: item.development_name || item.project_name,
    Design: item.house_design,
  };
  const textMiss = Object.entries(wantFacts).filter(([k, v]) => v && f[k] !== v).map(([k, v]) => `${k}: "${f[k] ?? '—'}" ≠ "${v}"`);
  must('P2: address, lot, estate and design are the builder\'s', textMiss.length === 0,
    textMiss.join('; ') || Object.entries(wantFacts).map(([k, v]) => `${k} ${v}`).join(' · '));
  must('P2: the suburb is the builder\'s', !!f.Suburb && f.Suburb.includes(item.suburb), `Suburb "${f.Suburb ?? '—'}"`);
  const figureMiss = [['Bedrooms', item.bedrooms], ['Bathrooms', item.bathrooms], ['Car spaces', item.car_spaces]]
    .filter(([k, v]) => v !== null && number(f[k]) !== Number(v)).map(([k, v]) => `${k}: "${f[k] ?? '—'}" ≠ ${Number(v)}`);
  must('P2: bedrooms, bathrooms and car spaces are the builder\'s', figureMiss.length === 0,
    figureMiss.join('; ') || `${f.Bedrooms} bed · ${f.Bathrooms} bath · ${f['Car spaces']} car`);
  // The page rounds an area to the whole square metre (`homeSizeDisplay`).
  const areaMiss = [['Home size', item.building_size_sqm], ['Land size', item.land_size_sqm]]
    .filter(([k, v]) => v !== null && number(f[k]) !== Math.round(Number(v))).map(([k, v]) => `${k}: "${f[k] ?? '—'}" ≠ ${Math.round(Number(v))} m²`);
  must('P2: home and land size are the builder\'s', areaMiss.length === 0,
    areaMiss.join('; ') || `${f['Home size']} home · ${f['Land size']} land`);
  const price = item.price_display || (item.price !== null ? audPrice(item.price) : null);
  must('P2: the price is the builder\'s', !!price && shown.text.includes(price), `${price} ${shown.text.includes(price) ? 'shown' : 'not shown'}`);
  must('P2: the builder is named', shown.text.includes(`Supplied by ${builderName} through the Builders Network`),
    shown.text.includes(builderName) ? 'named' : 'not named');
  const availability = AVAILABILITY[item.availability_status] ?? 'Not stated';
  must('P2: availability is the builder\'s', shown.header.includes(availability), `"${availability}" ${shown.header.includes(availability) ? 'shown' : 'not shown'}`);

  let photoDetail = 'no photograph drawn';
  let photoOk = false;
  if (shown.lead?.src) {
    const bytes = await fetch(shown.lead.src).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null)).catch(() => null);
    photoOk = !!bytes && !!storedSha && sha256(bytes) === storedSha;
    photoDetail = `${shown.lead.width}px drawn; bytes ${bytes ? (sha256(bytes) === storedSha ? 'equal' : 'differ from') : 'unreadable vs'} the builder's stored photograph`;
  }
  must('P2: the page draws the property\'s own photograph', photoOk, photoDetail);
  must('P2: the page fits the width without sideways scrolling', !seen.overflow,
    seen.overflow ? `${seen.width}px, widest ${JSON.stringify(seen.widest)}` : 'fits');
  must('P2: no script error', seen.errors.length === 0, `${seen.errors.length} uncaught`);

  const selectable = SELECTABLE.has(item.availability_status);
  must('P2: the activation button is offered as the availability allows', !!shown.activate
    && shown.activate.disabled === !selectable, JSON.stringify(shown.activate));
  if (expectDocuments) {
    const answers = [];
    for (const href of shown.documents) answers.push(await fetch(href, { method: 'GET' }).then((r) => r.status).catch(() => 0));
    must('P2: every document link answers', shown.documents.length >= expectDocuments && answers.every((s) => s === 200),
      `${shown.documents.length} links: ${answers.join(', ') || '—'}`);
  }
  if (real && shown.back) {
    await seen.page.click('a[href="/listings?section=builder-stock"]').catch(() => {});
    await seen.page.waitForTimeout(4_000);
    const landed = new URL(seen.page.url());
    const challenged = await seen.page.evaluate(() => document.title === 'Just a moment...').catch(() => false);
    const text = await seen.page.locator('body').innerText().catch(() => '');
    must('P2: the back link lands on the marketplace, signed in', landed.pathname === '/listings' && !challenged
      && !text.includes('Sign in') && !text.includes('Something went wrong'), `${landed.pathname}${landed.search}`);
  } else {
    must('P2: the back link lands on the marketplace, signed in', false, 'no back link drawn');
  }
  await seen.context.close();
}

let storage = null;
let browser = null;
try {
  console.log(`cc property page proof run=${RUN}`);
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();

  const alpha = await seedOrganisation(TAG, 'alpha');
  await connectTransport(TAG, alpha);
  const agent = await seedStaff(TAG, 'agent', ['listings', 'client_management']);
  record('0: a proof builder on a proof transport and a Command Centre staff member', !!alpha.connection && !!agent.token);

  // === P1 ===========================================================================
  const v1 = new TextEncoder().encode(await withLinks(storage, alpha.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
  const sent1 = await uploadDocument(alpha.cookie, 'Kestrel Grove stock list.csv', v1);
  const imported1 = await waitImported(sent1.uploadId);
  record('P1: the list is imported by the product', imported1.done && sent1.processed?.status === 200, imported1.upload?.status);
  const diff1 = differences(manifest().expect['csv-v1'], await itemsOf(alpha.orgId));
  record('P1: every property stored exactly as the list states it', diff1.length === 0, diff1.slice(0, 6).join('; '));
  const pub1 = await publishedAll(alpha.orgId);
  record('P1: the product publishes the list', pub1.done, `${(pub1.now ?? []).filter((i) => i.lifecycle_status === 'active').length} live`);
  const m1 = await mirrored(alpha.orgId);
  record('P1: the Command Centre holds the list, field by field', m1.done, m1.d?.slice(0, 4).join('; ') ?? '');

  const builderName = alpha.orgName;
  const shaOf = async (itemId) => (await net('stored photo', `
    SELECT im.source_detail->>'stored_sha256' AS sha FROM public.builder_stock_items i
      JOIN public.builder_stock_item_images im ON im.id = i.primary_image_id WHERE i.id = ${id(itemId)}`))[0]?.sha ?? null;
  const byLot = (rows, lot) => rows.find((r) => String(r.lot_number) === lot);

  // === P2 ===========================================================================
  const live1 = await itemsOf(alpha.orgId, `AND i.lifecycle_status = 'active'`);
  const lot101 = byLot(live1, '101');
  const sha101 = await shaOf(lot101.id);
  for (const [name, width, height] of VIEWPORTS) {
    await provePropertyPage(browser, { label: `lot 101, ${name}`, token: agent.token, item: lot101, builderName,
      viewport: { width, height }, storedSha: sha101, expectDocuments: name === 'desktop' ? 2 : 0 });
  }

  // === P3 ===========================================================================
  const lot103 = byLot(live1, '103');
  const v2 = new TextEncoder().encode(await withLinks(storage, alpha.orgId, new TextDecoder().decode(fixture('csv-v2.csv'))));
  const sent2 = await uploadDocument(alpha.cookie, 'Kestrel Grove stock list.csv', v2);
  const imported2 = await waitImported(sent2.uploadId);
  record('P3: the revised list is imported', imported2.done, imported2.upload?.status);
  const pub2 = await publishedAll(alpha.orgId);
  record('P3: the revision is published', pub2.done);
  const m2 = await mirrored(alpha.orgId);
  record('P3: the Command Centre converges on the revision', m2.done, m2.d?.slice(0, 4).join('; ') ?? '');
  const live2 = await itemsOf(alpha.orgId, `AND i.lifecycle_status = 'active'`);
  record('P3: the removed property is archived on both sides',
    (await itemsOf(alpha.orgId, `AND i.id = ${id(lot103.id)}`))[0]?.lifecycle_status === 'archived'
      && (await mirrorOf(alpha.orgId)).find((r) => r.id === lot103.id)?.lifecycle_status !== 'active');

  {
    const seen = await inspectCommandCentrePage(browser, { token: agent.token, path: `/listings/builder-stock/${lot103.id}`,
      viewport: { width: 1440, height: 900 }, wait: 6_000 });
    const real = record('P0: lot 103 (removed) is answered by the Command Centre\'s own page', seen.real,
      `${seen.real ? 'real' : seen.notReal.join('; ')}; via ${seen.navigation.origin}`);
    const shown = real ? await readCommandCentreProperty(seen.page) : { text: '', facts: {} };
    record('P3: the removed property\'s page says it is not available and shows none of its facts',
      real && shown.text.includes('This property is not available') && !shown.text.includes(lot103.address_line)
        && Object.keys(shown.facts).length === 0,
      real ? `${shown.text.includes('This property is not available') ? 'not available' : 'drawn'}; ${Object.keys(shown.facts).length} facts` : seen.notReal.join('; '));
    await seen.context.close();
  }
  const lot106 = byLot(live2, '106');
  await provePropertyPage(browser, { label: 'lot 106 (new), phone', token: agent.token, item: lot106, builderName,
    viewport: { width: 390, height: 844 }, storedSha: await shaOf(lot106.id), expectDocuments: 0 });
  const lot101v2 = byLot(live2, '101');
  await provePropertyPage(browser, { label: 'lot 101 (revised), desktop', token: agent.token, item: lot101v2, builderName,
    viewport: { width: 1440, height: 900 }, storedSha: await shaOf(lot101v2.id), expectDocuments: 0 });
} catch (error) {
  record('the proof completed', false, String(error?.message ?? error).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this run made remains on either side',
      Object.values(left.network).every((v) => Number(v) === 0) && Object.values(left.command).every((v) => Number(v) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('cc-property-page-proof', { run: RUN });
}
