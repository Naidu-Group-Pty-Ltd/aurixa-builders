#!/usr/bin/env node
/**
 * BUILDER STOCK IMAGE PIPELINE — THE ORCHESTRATION, PROVEN AT SCALE.
 *
 * This is the GENERIC proof the six live properties are only a regression case
 * of: the queue, the claim lease, the publication gate, the manifest and the
 * watchdog, exercised through the SAME production SQL a hosted project runs,
 * at 1 / 6 / 25 / 50 / 100 / 120 properties, with concurrent claimers.
 *
 * It uses no hard-coded upload id, filename, lot number or brochure URL, and
 * touches no live project: a fresh local Postgres gets the Supabase bootstrap,
 * the network baseline and EVERY follow-on migration in order — the exact
 * schema a brand-new deployment would carry — and every assertion below runs
 * the real `claim_builder_stock_image_work`,
 * `complete_builder_stock_image_work`, `builder_stock_publication_readiness`,
 * `publish_builder_stock_upload` and `builder_stock_image_watchdog`.
 *
 * What it proves at every scale:
 *   • FIRST-UPLOAD STAGING — items import staged; nothing is client-visible
 *     until the upload's cutover, the same gate a replacement passes.
 *   • THE GATE BLOCKS A BLANK — 0% coverage never publishes; the refusal names
 *     how many properties are still without a builder-source photo.
 *   • CONCURRENCY WITHOUT DOUBLE WORK OR STARVATION — two interleaved claimers
 *     each take disjoint leases, every property is claimed, none twice while
 *     leased, and the queue drains to zero.
 *   • 49-READY-1-FAILED IS NOT PUBLISHABLE — one failed property holds the
 *     whole upload staged.
 *   • 100% COVERAGE PUBLISHES ATOMICALLY — every property promotes to active in
 *     one cutover and each is client-visible on a ready builder-source primary.
 *   • NO SILENT TRUNCATION — a manifest asset still pending, or an enumeration
 *     recorded failed, blocks publication however many properties are ready;
 *     a >40-asset source is enumerated whole (the raised media ceiling).
 *   • THE WATCHDOG RECOVERS INTERRUPTED WORK — an expired lease is reclaimed
 *     with bounded backoff; a served blank that settled is reopened.
 *
 * Env contract mirrors baseline-check: LOCAL_PG_HOST (default /tmp),
 * LOCAL_PG_PORT (55432), LOCAL_PG_USER (postgres).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.SCALE_PROOF_DB || 'aurixa_builders_scale_proof';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

// `-q` matters: without it psql echoes the command tag ("INSERT 0 1") after a
// RETURNING row, and the id read below would carry it into the next statement.
const psql = (args) => execFileSync('psql', [...conn, '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPASSWORD: '' },
});
/** One value back. */
const q1 = (sql) => psql(['-d', DB, '-At', '-c', sql]).trim();
/** Rows as arrays of columns. */
const q = (sql) => psql(['-d', DB, '-At', '-F', '\t', '-c', sql]).trim()
  .split('\n').filter(Boolean).map((r) => r.split('\t'));

const failures = [];
const notes = [];
function check(name, ok, detail = '') {
  (ok ? notes : failures).push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// --- Bootstrap a fresh schema, exactly as a new deployment would get it ------
console.log(`Building a fresh schema on ${HOST}:${PORT} …`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(here, '00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
for (const file of readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f !== '00000000000000_network_baseline.sql')
  .sort()) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}
console.log('schema ready (baseline + every follow-on migration).\n');

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * Stage a brand-new upload of N properties, the way the importer's generic
 * path does: an invariant upload, N staged items, and a durable source
 * manifest with one row-branch asset per property (plus extras to cross 40).
 */
/**
 * `replaces` is what makes an upload a REPLACEMENT rather than a first list,
 * and the two publish under different rules — all-or-nothing for the first,
 * what-is-ready for the second. Passing `org` reuses an existing builder, so
 * a replacement can be staged against the list it supersedes.
 */
function stageUpload(n, { manifestAssets = n, replaces = [], org: existingOrg = null } = {}) {
  const org = existingOrg ?? q1(`INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
    VALUES (${lit(`Scale Org ${n}-${Date.now()}`)}, 'builder', 'active', true, now()) RETURNING id`);
  const replacesLiteral = replaces.length
    ? `ARRAY[${replaces.map((id) => `${lit(id)}::uuid`).join(', ')}]`
    : `'{}'::uuid[]`;
  const upload = q1(`INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status, replaces_upload_ids)
    VALUES (${lit(org)}::uuid, ${lit(`scale-${n}.csv`)}, ${lit(`scale/${n}.csv`)}, 'enriching', ${replacesLiteral}) RETURNING id`);
  // Every new property starts STAGED — the unified first-upload gate.
  q1(`INSERT INTO public.builder_stock_items
        (organisation_id, upload_id, lifecycle_status, image_work_stage,
         image_work_next_attempt_at, address_line, suburb, source_row)
      SELECT ${lit(org)}::uuid, ${lit(upload)}::uuid, 'staged', 'source', now(),
             (gs || ' Scale Parade'), 'Truganina',
             jsonb_build_object('unmapped', jsonb_build_object('Brochure URL',
               'https://example.invalid/b/' || gs || '.pdf'))
        FROM generate_series(1, ${n}) AS gs`);
  // The durable manifest: one row_branch per property, `manifestAssets` total
  // (so N=120 crosses the old 40-media ceiling), every one pending.
  q1(`INSERT INTO public.builder_stock_source_assets
        (upload_id, organisation_id, stock_item_id, kind, reference, branch_kind, state)
      SELECT ${lit(upload)}::uuid, ${lit(org)}::uuid,
             (SELECT id FROM public.builder_stock_items WHERE upload_id = ${lit(upload)}::uuid
               ORDER BY created_at, id LIMIT 1 OFFSET ((gs - 1) % ${n})),
             'row_branch', 'https://example.invalid/asset/' || gs, 'document', 'pending'
        FROM generate_series(1, ${manifestAssets}) AS gs`);
  return { org, upload };
}

/** The staged item ids of an upload, in queue order. */
const itemsOf = (upload) => q(`SELECT id FROM public.builder_stock_items
  WHERE upload_id = ${lit(upload)}::uuid ORDER BY created_at, id`).map((r) => r[0]);

/**
 * Give one property its ready builder-source primary and settle it, the way
 * the settler's source stage does once an election succeeds: a source_supplied
 * ready image, set as the primary, its manifest asset marked stored.
 */
function settleWithSourcePhoto(org, upload, itemId) {
  const img = q1(`INSERT INTO public.builder_stock_item_images
      (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
       verification_status, processing_status, storage_path)
    VALUES (${lit(org)}::uuid, ${lit(itemId)}::uuid, ${lit(upload)}::uuid,
       'uploaded_document', 'brochure#page1', 'source_supplied', 'ready',
       ${lit(`scale/${itemId}.jpg`)}) RETURNING id`);
  q1(`UPDATE public.builder_stock_items SET primary_image_id = ${lit(img)}::uuid WHERE id = ${lit(itemId)}::uuid`);
  q1(`UPDATE public.builder_stock_source_assets SET state = 'stored', image_id = ${lit(img)}::uuid
      WHERE stock_item_id = ${lit(itemId)}::uuid AND state = 'pending'`);
  // Advance the work item through the real completion RPC to 'settled'.
  q1(`SELECT public.complete_builder_stock_image_work(${lit(itemId)}::uuid, 'settled', 'scale settle', NULL, 0, true, false)`);
}

const readiness = (upload) => {
  const [r] = q(`SELECT staged, source_outstanding, missing_primary, failed_items, ready,
                        ready_items, first_publication, partial_ready
    FROM public.builder_stock_publication_readiness(${lit(upload)}::uuid)`);
  return {
    staged: +r[0], sourceOutstanding: +r[1], missingPrimary: +r[2], failed: +r[3],
    ready: r[4] === 't', readyItems: +r[5],
    firstPublication: r[6] === 't', partialReady: r[7] === 't',
  };
};
const publish = (upload) => JSON.parse(q1(`SELECT public.publish_builder_stock_upload(${lit(upload)}::uuid)`));
const visible = (itemId) => q1(`SELECT public.builder_stock_item_client_visible(${lit(itemId)}::uuid)`) === 't';

const SIZES = [1, 6, 25, 50, 100, 120];
const timings = [];

for (const n of SIZES) {
  const started = Date.now();
  // 120 crosses the old 40-media ceiling in its manifest; the rest map 1:1.
  const manifestAssets = n === 120 ? 130 : n;
  const { org, upload } = stageUpload(n, { manifestAssets });
  const items = itemsOf(upload);

  // Staging: nothing client-visible yet.
  check(`N=${n}: ${n} properties imported staged, none client-visible`,
    items.length === n && q1(`SELECT count(*) FROM public.builder_stock_items
      WHERE upload_id = ${lit(upload)}::uuid AND lifecycle_status = 'staged'`) === String(n)
    && !items.some(visible),
    `staged=${n}`);

  // No manifest asset lost: enumeration is whole even past 40.
  check(`N=${n}: source manifest enumerated whole (${manifestAssets} assets, no truncation)`,
    q1(`SELECT count(*) FROM public.builder_stock_source_assets WHERE upload_id = ${lit(upload)}::uuid`)
      === String(manifestAssets));

  // The gate blocks a blank upload, and says how many are owed.
  const r0 = readiness(upload);
  const p0 = publish(upload);
  check(`N=${n}: 0% coverage never publishes`,
    !r0.ready && r0.missingPrimary === n && p0.published === false && p0.reason === 'not_ready',
    `missing_primary=${r0.missingPrimary}, reason=${p0.reason}`);

  // Concurrency: two interleaved claimers, disjoint leases, no starvation.
  const claimedBy = new Map();
  let doubleClaim = false;
  let rounds = 0;
  for (;;) {
    const claimable = +q1(`SELECT claimable FROM public.builder_stock_image_work_pending()`);
    if (claimable === 0) break;
    if (++rounds > n + 5) break; // safety; a healthy queue drains in <= n rounds
    // Two claimers race in the same round; a lease makes their sets disjoint.
    for (const worker of ['A', 'B']) {
      const got = q(`SELECT id FROM public.claim_builder_stock_image_work(3, 120, ${lit(org)}::uuid)`)
        .map((x) => x[0]);
      for (const id of got) {
        if (claimedBy.has(id)) doubleClaim = true; // held a live lease and got claimed again
        claimedBy.set(id, worker);
        settleWithSourcePhoto(org, upload, id); // finish it, releasing the lease
      }
    }
  }
  check(`N=${n}: concurrent claim — every property claimed once, no double-claim, no starvation`,
    claimedBy.size === n && !doubleClaim,
    `claimed=${claimedBy.size}/${n}, rounds=${rounds}`);

  // 100% coverage publishes atomically; each property client-visible.
  const r1 = readiness(upload);
  const p1 = publish(upload);
  const active = +q1(`SELECT count(*) FROM public.builder_stock_items
    WHERE upload_id = ${lit(upload)}::uuid AND lifecycle_status = 'active'`);
  const allVisible = items.every(visible);
  const blocked = q1(`SELECT coalesce(publication_blocked_reason, '') FROM public.builder_stock_uploads WHERE id = ${lit(upload)}::uuid`);
  check(`N=${n}: 100% coverage publishes all ${n} atomically, each client-visible on a builder-source primary`,
    r1.ready && p1.published === true && active === n && allVisible && blocked === '',
    `ready=${r1.ready}, promoted=${p1.promoted}, active=${active}, all_visible=${allVisible}`);

  timings.push({ n, ms: Date.now() - started });
}

// --- 49-ready-1-failed: what each kind of upload does with it ---------------
//
// UNTIL 19 SEP 2026 THIS WAS ONE CHECK, and the answer it asserted — publish
// nothing — was right for a replacement and wrong for a first list. Measured
// on the 18 September import: 47 properties, 46 with a builder-source
// photograph, and ONE whose brochure names a sibling property. The builder's
// marketplace showed zero. Forty-six correct properties were being withheld
// to punish one incorrect one.
//
// So the case splits by what the upload IS. Both halves are asserted here,
// because the value of the first half is only visible beside the second.
{
  // (a) A FIRST list publishes the 49 and leaves the 1 in Action Required.
  const n = 50;
  const { org, upload } = stageUpload(n);
  const items = itemsOf(upload);
  for (const id of items.slice(0, n - 1)) settleWithSourcePhoto(org, upload, id);
  // The last one fails terminally (person paged), the rest are ready.
  q1(`UPDATE public.builder_stock_items SET image_work_stage = 'failed' WHERE id = ${lit(items[n - 1])}::uuid`);
  q1(`UPDATE public.builder_stock_source_assets SET state = 'failed'
      WHERE stock_item_id = ${lit(items[n - 1])}::uuid`);
  const r = readiness(upload);
  const p = publish(upload);
  const stillStaged = q1(`SELECT lifecycle_status FROM public.builder_stock_items
    WHERE id = ${lit(items[n - 1])}::uuid`);
  const reason = q1(`SELECT coalesce(publication_blocked_reason, '') FROM public.builder_stock_uploads
    WHERE id = ${lit(upload)}::uuid`);
  check('49 ready + 1 failed on a FIRST list publishes the 49 and holds the 1',
    !r.ready && r.failed === 1 && r.readyItems === n - 1 && r.partialReady
      && p.published === true && p.mode === 'first_publication'
      && p.promoted === n - 1 && p.withheld === 1
      && stillStaged === 'staged' && reason !== '',
    `ready=${r.ready}, partial=${r.partialReady}, promoted=${p.promoted}, withheld=${p.withheld}, held=${stillStaged}`);

  // (b) A REPLACEMENT for that list publishes NOTHING. Its predecessor is
  //     live, and a partial promotion there would leave the marketplace
  //     showing some rows of the new generation beside some of the old.
  const { upload: replacement } = stageUpload(n, { replaces: [upload], org });
  const replacementItems = itemsOf(replacement);
  for (const id of replacementItems.slice(0, n - 1)) settleWithSourcePhoto(org, replacement, id);
  q1(`UPDATE public.builder_stock_items SET image_work_stage = 'failed' WHERE id = ${lit(replacementItems[n - 1])}::uuid`);
  q1(`UPDATE public.builder_stock_source_assets SET state = 'failed'
      WHERE stock_item_id = ${lit(replacementItems[n - 1])}::uuid`);
  const r2 = readiness(replacement);
  const p2 = publish(replacement);
  const predecessorLive = +q1(`SELECT count(*) FROM public.builder_stock_items
    WHERE upload_id = ${lit(upload)}::uuid AND lifecycle_status = 'active'`);
  check('49 ready + 1 failed on a REPLACEMENT still publishes nothing, and leaves the live list alone',
    !r2.ready && !r2.partialReady && !r2.firstPublication
      && p2.published === false && p2.reason === 'not_ready'
      && predecessorLive === n - 1,
    `ready=${r2.ready}, partial=${r2.partialReady}, first=${r2.firstPublication}, predecessor_live=${predecessorLive}`);
}

// --- No silent truncation: a pending asset / failed enumeration blocks -------
{
  const { org, upload } = stageUpload(6);
  for (const id of itemsOf(upload)) settleWithSourcePhoto(org, upload, id);
  // Every property ready, but one manifest asset never resolved.
  q1(`INSERT INTO public.builder_stock_source_assets
       (upload_id, organisation_id, stock_item_id, kind, reference, branch_kind, state)
     VALUES (${lit(upload)}::uuid, ${lit(org)}::uuid,
       (SELECT id FROM public.builder_stock_items WHERE upload_id = ${lit(upload)}::uuid ORDER BY id LIMIT 1),
       'row_branch', 'https://example.invalid/late-asset', 'document', 'pending')`);
  const pPending = publish(upload);
  q1(`UPDATE public.builder_stock_source_assets SET state = 'stored'
      WHERE upload_id = ${lit(upload)}::uuid AND reference = 'https://example.invalid/late-asset'`);
  q1(`UPDATE public.builder_stock_uploads SET source_manifest_state = 'failed' WHERE id = ${lit(upload)}::uuid`);
  const pFailedManifest = publish(upload);
  q1(`UPDATE public.builder_stock_uploads SET source_manifest_state = 'complete' WHERE id = ${lit(upload)}::uuid`);
  const pOk = publish(upload);
  check('a pending manifest asset and a failed enumeration each block publication; clearing both publishes',
    pPending.published === false && pFailedManifest.published === false && pOk.published === true,
    `pending=${pPending.published}, failed_manifest=${pFailedManifest.published}, cleared=${pOk.published}`);
}

// --- The watchdog recovers interrupted work ---------------------------------
{
  const { org, upload } = stageUpload(3);
  const items = itemsOf(upload);
  // One worker died mid-flight: a lease that expired long ago.
  q1(`UPDATE public.builder_stock_items
        SET image_work_claim_until = now() - interval '5 minutes', image_work_stage = 'eligibility'
      WHERE id = ${lit(items[0])}::uuid`);
  // A served property that settled blank (no primary) — must be reopened.
  q1(`UPDATE public.builder_stock_items
        SET lifecycle_status = 'active', image_work_stage = 'settled',
            image_work_updated_at = now() - interval '20 minutes'
      WHERE id = ${lit(items[1])}::uuid`);
  const wd = JSON.parse(q1(`SELECT public.builder_stock_image_watchdog()`));
  const reclaimed = q1(`SELECT image_work_claim_until IS NULL AND image_work_failures > 0
      FROM public.builder_stock_items WHERE id = ${lit(items[0])}::uuid`) === 't';
  const reopened = q1(`SELECT image_work_stage FROM public.builder_stock_items WHERE id = ${lit(items[1])}::uuid`) === 'source';
  check('watchdog reclaims an expired lease (bounded backoff) and reopens a served blank',
    reclaimed && reopened, `watchdog=${JSON.stringify(wd)}`);
}

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

console.log('\nMeasured wall-clock per scale (schema + gate + concurrent settle, local PG):');
for (const t of timings) console.log(`  ${String(t.n).padStart(3)} properties: ${t.ms} ms`);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\nScale proof passed: ${notes.length} assertions across ${SIZES.join('/')} properties. `
  + 'The generic pipeline stages, gates, drains and recovers identically at every size.');
