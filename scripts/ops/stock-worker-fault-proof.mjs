#!/usr/bin/env node
/**
 * ===========================================================================
 * A WORKER FAILURE NEVER BECOMES A VERDICT ABOUT A PHOTOGRAPH — PROVED LIVE.
 * ===========================================================================
 *
 * Controlled failure injection against the production pipeline, on synthetic
 * organisations of the run's own, deleted at the end on both sides.
 *
 * SETUP, through the product: a builder ("alpha", on a proof transport so the
 * Command Centre mirrors it) uploads a five-property list with linked
 * photographs; the deployed pipeline imports, publishes and mirrors it. A
 * second builder ("bystander") does the same and is only ever observed.
 *
 * THE CASE: alpha's lot 102 is live with its own photograph. A repair region —
 * ordinary image metadata, the same record a person writes against a badge the
 * detector cannot see — is recorded against those exact bytes, so the
 * property owes a deterministic clean-up on the worker. Its next scheduled
 * attempt is parked so the deployed settler leaves it to this run.
 *
 * F1..F8: for each way a worker fails (HTTP 500, 503, reset, no answer — the
 * real 60 s client timeout — an answer after that timeout, a malformed answer,
 * a "success" with no picture, an HTML error page), the driver takes the
 * property's lease exactly as the claim does and `stock-worker-fault-harness.ts`
 * runs the deployed settler's own two calls with the worker replaced by that
 * fault. After every one, from the database: the worker WAS asked; nothing was
 * written about the picture (no refusal, no derivative, no clearance); the
 * property is still in clean-up, its failure is counted once, the error is
 * recorded and the next attempt is backed off within the ceiling; it, and every
 * other property of the list, is still live with the same photograph; the list
 * is still published; the Command Centre still has it live; no image row or
 * stored file was added.
 *
 * F9  a duplicate completion counts, changes nothing else and adds nothing.
 * F10 two attempts at once ask the worker ONCE (the attempt stamp is a
 *     compare-and-set), and while an attempt is in flight the claim the
 *     deployed settler uses cannot take the property.
 *
 * RECOVERY, by production itself: the property's attempt is released to the
 * deployed settler and the real worker, under the ordinary cooldown. The run
 * waits for the cleaned picture to be recorded against the original's bytes,
 * the property to settle, its failures to reset; the Builder Portal page —
 * opened BEFORE recovery and never reloaded — to draw the cleaned picture; and
 * the Command Centre to serve the cleaned bytes.
 *
 * The bystander organisation's rows are compared before and after.
 *
 * Runs from the production-rollout workflow (phase `stock-worker-fault-proof`).
 */
import { spawn } from 'node:child_process';
import {
  RUN, record, net, id, sha256, sqlLit, waitFor, fixture, storageFor, withLinks, seedOrganisation,
  connectTransport, seedStaff, uploadDocument, waitImported, itemsOf, mirrorOf, cleanup, leftovers, finish,
  commandCentre, serviceKey, NETWORK_REF, ORIGIN,
} from './tier0/common.mjs';

const TAG = 'fault';
const MODES = ['http500', 'http503', 'reset', 'hang', 'late', 'malformed', 'empty', 'html'];
const REGION = { left: 0.45, top: 0.40, right: 0.57, bottom: 0.50 };
const BACKOFF_CEILING_S = 6 * 60;

const one = async (label, sql) => (await net(label, sql))[0] ?? null;

async function publishedAll(orgId) {
  return waitFor('publication', async () => {
    const now = await itemsOf(orgId, `AND i.lifecycle_status <> 'archived'`);
    return { done: now.length > 0 && now.every((i) => i.lifecycle_status === 'active' && !i.pending), now };
  }, 18 * 60_000, 10_000);
}

/** The property, its photograph and its list, as the database holds them. */
async function stateOf(itemId, imageId, uploadId) {
  return one('state', `
    SELECT i.lifecycle_status, i.image_work_stage AS stage, i.image_work_failures AS failures,
           i.image_work_last_error AS last_error, i.primary_image_id,
           extract(epoch FROM (i.image_work_next_attempt_at - now()))::int AS next_in_s,
           public.builder_stock_photo_is_source_ready(i.primary_image_id) AS photo_ready,
           (SELECT count(*) FROM public.builder_stock_item_images x WHERE x.stock_item_id = i.id)::int AS image_rows,
           im.source_detail ? 'sanitization_failure' AS refused,
           im.source_detail ? 'sanitized_derivative' AS derived,
           im.source_detail ? 'sanitization_clearance' AS cleared,
           im.source_detail -> 'sanitization_attempt' ->> 'operational' AS attempt_operational,
           im.source_detail -> 'sanitized_derivative' ->> 'derivative_sha256' AS derivative_sha,
           im.source_detail -> 'sanitized_derivative' ->> 'storage_path' AS derivative_path,
           (SELECT u.published_at IS NOT NULL FROM public.builder_stock_uploads u WHERE u.id = ${id(uploadId)}) AS list_published,
           (SELECT count(*) FROM public.builder_stock_items o
             WHERE o.upload_id = ${id(uploadId)} AND o.lifecycle_status = 'active')::int AS list_live
      FROM public.builder_stock_items i JOIN public.builder_stock_item_images im ON im.id = ${id(imageId)}
     WHERE i.id = ${id(itemId)}`);
}

/** The lease the claim function takes, keyed on this one property. */
const lease = (itemId) => one('lease', `
  UPDATE public.builder_stock_items AS i
     SET image_work_claim_until = now() + interval '5 minutes',
         image_work_attempts = i.image_work_attempts + 1,
         image_work_updated_at = now()
   WHERE i.id = ${id(itemId)} AND (i.image_work_claim_until IS NULL OR i.image_work_claim_until < now())
  RETURNING to_jsonb(i) AS row`);
const park = (itemId) => net('park', `
  UPDATE public.builder_stock_items SET image_work_next_attempt_at = now() + interval '1 day'
   WHERE id = ${id(itemId)}`);
/** The cooldown a previous injected attempt left, moved back so the next fault is reached. */
const pastCooldown = (imageId) => net('cooldown', `
  UPDATE public.builder_stock_item_images
     SET source_detail = jsonb_set(source_detail, '{sanitization_attempt,at}',
       to_jsonb(to_char((now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   WHERE id = ${id(imageId)} AND source_detail ? 'sanitization_attempt'`);

function harness(env) {
  return new Promise((resolve) => {
    const child = spawn('deno', ['run', '-A', '--config', 'supabase/functions/deno.json',
      'scripts/ops/stock-worker-fault-harness.ts'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('FAULT_RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice('FAULT_RESULT '.length)) : null; } catch { /* reported below */ }
      resolve({ code, result });
    });
  });
}

let storage = null;
let browser = null;
try {
  console.log(`worker fault proof run=${RUN}`);
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);
  const key = await serviceKey(NETWORK_REF);
  const sb = { FAULT_SB_URL: `https://${NETWORK_REF}.supabase.co`, FAULT_SB_KEY: key };

  // --- Setup, through the product -------------------------------------------------
  const alpha = await seedOrganisation(TAG, 'alpha');
  await connectTransport(TAG, alpha);
  const bystander = await seedOrganisation(TAG, 'bystander');
  const agent = await seedStaff(TAG, 'agent', ['listings', 'client_management']);
  for (const org of [alpha, bystander]) {
    const csv = new TextEncoder().encode(await withLinks(storage, org.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
    const sent = await uploadDocument(org.cookie, 'Kestrel Grove stock list.csv', csv);
    org.uploadId = sent.uploadId;
    const imported = await waitImported(sent.uploadId);
    const pub = await publishedAll(org.orgId);
    record(`0: the ${org.label} list is imported and published by the product`, imported.done && pub.done,
      `${imported.upload?.status}; ${(pub.now ?? []).filter((i) => i.lifecycle_status === 'active').length} live`);
  }
  const items = await itemsOf(alpha.orgId, `AND i.lifecycle_status = 'active'`);
  const p2 = items.find((i) => String(i.lot_number) === '102');
  const image = await one('primary', `
    SELECT id, storage_path, source_detail->>'stored_sha256' AS sha, source_detail ? 'sanitization_clearance' AS cleared
      FROM public.builder_stock_item_images WHERE id = ${id(p2.primary_image_id)}`);
  const mirrored = await waitFor('mirror', async () => {
    const rows = (await mirrorOf(alpha.orgId)).filter((r) => r.lifecycle_status === 'active');
    return { done: rows.length === items.length, rows };
  }, 8 * 60_000, 5_000);
  record('0: the Command Centre mirrors alpha\'s list', mirrored.done, `${mirrored.rows?.length ?? 0} live there`);
  const bystanderBefore = await net('bystander before', `
    SELECT id, lifecycle_status, image_work_stage, primary_image_id, image_work_failures
      FROM public.builder_stock_items WHERE organisation_id = ${id(bystander.orgId)} ORDER BY id`);

  // The badge clean-up this property now owes: a region against these exact bytes.
  await net('region', `
    UPDATE public.builder_stock_item_images
       SET source_detail = source_detail || jsonb_build_object('repair_region', jsonb_build_object(
         'original_sha256', ${sqlLit(image.sha)}, 'boxes', ${sqlLit(JSON.stringify([REGION]))}::jsonb,
         'recorded_at', now(), 'recorded_by', 'worker-fault-proof'),
         -- What the detector writes on a photograph carrying a marketing badge: the
         -- original may not be drawn as it is, so the cleaned derivative is what serves.
         'marketplace_eligibility_state', 'ineligible',
         'marketplace_rejection_reason', 'annotated_marketing_tile',
         'marketplace_measured_sha256', ${sqlLit(image.sha)})
     WHERE id = ${id(image.id)};
    UPDATE public.builder_stock_items
       SET image_work_stage = 'sanitization', image_work_failures = 0, image_work_attempts = 0,
           image_work_next_attempt_at = now() + interval '1 day', image_work_claim_until = NULL
     WHERE id = ${id(p2.id)};`);
  const before = await stateOf(p2.id, image.id, alpha.uploadId);
  record('0: lot 102 is live with its own photograph and now owes a badge clean-up',
    before.lifecycle_status === 'active' && before.photo_ready && before.stage === 'sanitization' && !before.derived,
    JSON.stringify({ live: before.lifecycle_status, stage: before.stage, photo_ready: before.photo_ready }));

  // --- F1..F8 ----------------------------------------------------------------------
  let failures = before.failures;
  const matrix = [];
  for (const mode of MODES) {
    await pastCooldown(image.id);
    const claimed = await lease(p2.id);
    const run = await harness({ ...sb, FAULT_MODE: mode, FAULT_CLAIMED_ITEM: JSON.stringify(claimed?.row ?? null) });
    const after = await stateOf(p2.id, image.id, alpha.uploadId);
    const ccRow = (await mirrorOf(alpha.orgId)).find((r) => r.id === p2.id);
    await park(p2.id);
    const s = run.result?.settlements?.[0] ?? {};
    const checks = {
      asked: (run.result?.hits ?? 0) >= 1,
      no_verdict: !after.refused && !after.derived && after.cleared === before.cleared,
      retryable: after.stage === 'sanitization' && s.failed === true && s.nextStage === 'sanitization',
      counted_once: after.failures === failures + 1,
      reason_recorded: !!after.last_error,
      backoff_bounded: after.next_in_s !== null,
      still_live: after.lifecycle_status === 'active' && after.primary_image_id === before.primary_image_id && after.photo_ready,
      list_intact: after.list_published && after.list_live === items.length,
      command_centre_live: ccRow?.lifecycle_status === 'active',
      nothing_added: after.image_rows === before.image_rows,
    };
    failures = after.failures;
    matrix.push({ mode, ms: run.result?.ms, hits: run.result?.hits, ...checks });
    const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    record(`F: worker ${mode} — operational, retryable, counted, nothing said about the picture, list still live`,
      bad.length === 0, bad.length ? `failed: ${bad.join(', ')}; ${JSON.stringify({ s, after })}`.slice(0, 600)
        : `worker asked ${run.result.hits}×, ${run.result.ms} ms; failures ${after.failures}; "${String(after.last_error).slice(0, 90)}"`);
  }
  console.log(`MATRIX ${JSON.stringify(matrix)}`);

  // The backoff each failure buys, as the completion function sets it (before the driver parks the row).
  {
    await pastCooldown(image.id);
    const claimed = await lease(p2.id);
    await harness({ ...sb, FAULT_MODE: 'http500', FAULT_CLAIMED_ITEM: JSON.stringify(claimed?.row ?? null) });
    const after = await stateOf(p2.id, image.id, alpha.uploadId);
    record('F: the backoff after a failure is bounded (the completion\'s ceiling)',
      after.next_in_s > 0 && after.next_in_s <= BACKOFF_CEILING_S, `next attempt in ${after.next_in_s} s after ${after.failures} failures`);
    failures = after.failures;
    await park(p2.id);
  }

  // --- F9: a duplicate completion --------------------------------------------------
  {
    await pastCooldown(image.id);
    const claimed = await lease(p2.id);
    const run = await harness({ ...sb, FAULT_MODE: 'http503', FAULT_COMPLETE_TWICE: '1', FAULT_CLAIMED_ITEM: JSON.stringify(claimed?.row ?? null) });
    const after = await stateOf(p2.id, image.id, alpha.uploadId);
    await park(p2.id);
    record('F9: a duplicate completion adds no media and changes no state but its own counter',
      run.result?.completions?.length === 2 && after.stage === 'sanitization' && after.image_rows === before.image_rows
        && !after.refused && !after.derived && after.lifecycle_status === 'active',
      `failures ${failures} → ${after.failures} (each completion is counted); image rows ${after.image_rows}`);
    failures = after.failures;
  }

  // --- F10: two attempts at once, and the claim while one is in flight ---------------
  {
    await pastCooldown(image.id);
    const claimed = await lease(p2.id);
    const inFlight = harness({ ...sb, FAULT_MODE: 'hang', FAULT_CONCURRENT: '2', FAULT_CLAIMED_ITEM: JSON.stringify(claimed?.row ?? null) });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const stolen = await net('claim while leased', `
      SELECT id FROM public.claim_builder_stock_image_work(50, 1, ${id(alpha.orgId)})`);
    const run = await inFlight;
    const after = await stateOf(p2.id, image.id, alpha.uploadId);
    await park(p2.id);
    record('F10: two attempts at once ask the worker once; the other stands down',
      run.result?.hits === 1 && run.result?.settlements?.length === 2 && !after.derived && !after.refused,
      `worker asked ${run.result?.hits}×; ${JSON.stringify(run.result?.settlements?.map((s) => s.result))}`.slice(0, 400));
    record('F10: while an attempt holds the lease, the deployed settler\'s claim cannot take the property',
      !stolen.some((r) => r.id === p2.id), `claim returned ${stolen.length} row(s), lot 102 ${stolen.some((r) => r.id === p2.id) ? 'INCLUDED' : 'not among them'}`);
  }

  // --- Recovery, by production itself ------------------------------------------------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: '__Host-builder_session_token', value: alpha.cookie.split('=')[1], url: ORIGIN,
    secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/builder/stock`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  const drawnBefore = await page.evaluate((imageId) => [...document.images]
    .map((img) => img.currentSrc || img.src).filter((src) => src.includes('/sanitized/v') && src.includes(imageId)).length, image.id);
  record('R: the Builder Portal page, opened before recovery, still draws lot 102 (its original photograph)',
    drawnBefore === 0 && (await page.locator('body').innerText().catch(() => '')).includes('14 Proofline Way'),
    `cleaned picture drawn: ${drawnBefore}`);

  await net('release', `UPDATE public.builder_stock_items SET image_work_next_attempt_at = now() WHERE id = ${id(p2.id)}`);
  const releasedAt = Date.now();
  const recovered = await waitFor('recovery', async () => {
    const s = await stateOf(p2.id, image.id, alpha.uploadId);
    return { done: !!s.derived && s.stage !== 'sanitization', s };
  }, 30 * 60_000, 20_000);
  const r = recovered.s ?? {};
  record('R: the deployed settler and the real worker clean the photograph after the outage',
    recovered.done && !r.refused && r.lifecycle_status === 'active',
    `${Math.round((Date.now() - releasedAt) / 1000)} s after release; stage ${r.stage}; failures ${r.failures}; refused ${r.refused}`);
  record('R: the property stayed live throughout and the list never emptied',
    r.lifecycle_status === 'active' && r.list_published && r.list_live === items.length, `${r.list_live}/${items.length} live`);
  record('R: the property\'s failure count resets once the work moves on', r.failures === 0, `failures ${r.failures}`);
  record('R: no duplicate media — one image row more than none, the cleaned picture is a derivative of the same row',
    r.image_rows === before.image_rows && !!r.derivative_path, `${r.image_rows} image rows; derivative ${r.derivative_path ? 'recorded' : 'missing'}`);

  const portal = await waitFor('portal shows the cleaned picture', async () => {
    const n = await page.evaluate((imageId) => [...document.images]
      .filter((img) => img.complete && img.naturalWidth > 0)
      .map((img) => img.currentSrc || img.src).filter((src) => src.includes('/sanitized/v') && src.includes(imageId)).length, image.id);
    return { done: n > 0, n };
  }, 6 * 60_000, 10_000);
  record('R: the Builder Portal page draws the cleaned picture without being reloaded', portal.done,
    `${portal.n ?? 0} drawn, ${Math.round((portal.ms ?? 0) / 1000)} s after recovery`);
  await context.close();

  const cc = await waitFor('command centre serves the cleaned picture', async () => {
    const detail = await commandCentre('get_stock_item', { stock_item_id: p2.id }, agent.token);
    const imageId = detail.json?.record?.primary_image_id;
    const url = imageId ? (await commandCentre('image_url', { image_id: imageId }, agent.token)).json?.url : null;
    const bytes = url ? await fetch(url).then(async (x) => (x.ok ? new Uint8Array(await x.arrayBuffer()) : null)).catch(() => null) : null;
    const sha = bytes ? sha256(bytes) : null;
    return { done: !!sha && sha === r.derivative_sha, sha, live: detail.json?.record?.lifecycle_status };
  }, 10 * 60_000, 15_000);
  record('R: the Command Centre serves the same cleaned picture', cc.done,
    `bytes ${cc.sha ? (cc.sha === r.derivative_sha ? 'equal to' : 'differ from') : 'unreadable vs'} the recorded derivative`);

  const bystanderAfter = await net('bystander after', `
    SELECT id, lifecycle_status, image_work_stage, primary_image_id, image_work_failures
      FROM public.builder_stock_items WHERE organisation_id = ${id(bystander.orgId)} ORDER BY id`);
  record('M: the other organisation is untouched by all of it',
    JSON.stringify(bystanderAfter) === JSON.stringify(bystanderBefore), `${bystanderAfter.length} properties compared`);
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
  finish('stock-worker-fault-proof', { run: RUN });
}
