/**
 * ===========================================================================
 * HOW LONG AN IMPORT TAKES, AND WHICH HALF OF IT IS WORK.
 * ===========================================================================
 *
 * The acceptance harness beside this file proves the pipeline is CORRECT. It
 * cannot prove it is fast, and it would be dishonest to let it try: it drives
 * the ladder in a tight loop with no scheduler between the stages, so it
 * measures compute and nothing else.
 *
 * That is exactly half of what a customer waits for, and it is the half this
 * repository can measure repeatably. So this reports it as what it is:
 *
 *   COMPUTE        every millisecond of CPU and IO the pipeline spends
 *                  between a file being accepted and a property being
 *                  published with a decodable photograph on it, over the same
 *                  modules, the same Postgres, the same PostgREST and the same
 *                  object store the gate uses.
 *   HOPS           how many times the work crosses an isolate boundary, which
 *                  is what the production orchestration adds on top.
 *
 * The production end-to-end is COMPUTE + HOPS × dispatch latency, and the
 * dispatch latency is measured in production rather than guessed here — see
 * `docs/builder-portal/53-why-an-import-took-seven-minutes.md`.
 *
 * WHY HOPS ARE COUNTED HERE AND NOT INFERRED. An isolate commits to one class
 * of expensive work (`workAllowance.pure.ts`), so how many isolates a document
 * needs is a property of the DOCUMENT — a scan that decodes twice needs a
 * different number from a native brochure — and counting it on the fixture is
 * the only way the number is about the document rather than about an average.
 *
 * FIVE CLASSES, because they exercise different work:
 *   native      a native single-property PDF with a photograph
 *   scanned     the same thing as a scan, so recognition runs
 *   mixed       native and scanned pages in one document
 *   two         one page carrying two properties and two photographs
 *   sheet       a larger multi-property schedule
 *
 *   usage: deno run --allow-all --node-modules-dir=none \
 *            --import-map scripts/stock-acceptance/import-map.json \
 *            scripts/stock-acceptance/latency.ts [corpus] [iterations]
 */
// FIRST: no worker, as on the hosted runtime. See `hostedRuntime.ts`.
import './hostedRuntime.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { runStockImport } from '../../supabase/functions/_shared/builderStock/runImport.ts';
import { isImportContinuation } from '../../supabase/functions/_shared/builderStock/importContinuation.pure.ts';
import { continueStockImport } from '../../supabase/functions/_shared/builderStock/continueImport.ts';
import { claimImport, releaseThenContinue } from '../../supabase/functions/_shared/builderStock/importClaim.ts';
import {
  MAX_IMPORT_CONTINUATIONS, MAX_PICTURE_CROSSINGS,
} from '../../supabase/functions/_shared/builderStock/importCheckpoint.pure.ts';
import { STOCK_LIST_STORAGE_PREFIX, safeObjectName } from '../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';
import { serveStockImage } from '../../supabase/functions/_shared/builderStock/serveStockImage.ts';
import { recordImportCounts } from '../../supabase/functions/_shared/builderStock/recordImportOutcome.ts';
import {
  claimOneImageWorkItem, completeItemWork, publishUploadIfReady,
} from '../../supabase/functions/_shared/builderStock/itemWorkClaim.ts';
import { settleClaimedItem } from '../../supabase/functions/_shared/builderStock/settleItemImages.ts';
import {
  readOutstandingUploads, runSettlementTick, settleUploadSourceImages,
} from '../../supabase/functions/_shared/builderStock/settleSourceImages.ts';
import { enforceStrictPrimaryImages } from '../../supabase/functions/_shared/builderStock/primaryImage.ts';
import {
  mayTakeStage, newAllowance, spendStage,
} from '../../supabase/functions/_shared/builderStock/workAllowance.pure.ts';

const GATEWAY = Deno.env.get('GATEWAY_URL') ?? 'http://localhost:54997';
const KEY = (await Deno.readTextFile('/var/tmp/service-role.jwt')).trim();
const BUCKET = 'builder-stock-lists';
const corpusDir = Deno.args[0] ?? '/var/tmp/corpus';
const ITERATIONS = Number(Deno.args[1] ?? '5');

const db = createClient(GATEWAY, KEY, { auth: { persistSession: false } });
Deno.env.set('SUPABASE_URL', GATEWAY);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', KEY);

/** The same decode the gate applies: a card is blank unless this answers. */
function decodable(b: Uint8Array): boolean {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return true;            // png
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // gif
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) return true;            // webp
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return true;             // jpeg
  return false;
}

interface Entry {
  name: string; filename: string; path: string; bytes: number;
  expect: { properties: number; image?: string | null };
}

/**
 * WHAT "FINISHED" MEANS FOR A FIXTURE, AND WHY IT IS NOT ALWAYS "PUBLISHED".
 *
 * The image invariant is that a property with no builder photograph does not
 * reach the marketplace, and two fixtures in this corpus carry no photograph
 * ON PURPOSE — a page that is a photograph of paper has no facade in it, and a
 * three-across release sheet's pictures are under the product's own 6% floor.
 * For those, the correct terminal state is an upload that is NOT published.
 *
 * The first version of this benchmark scored every class on `published`, and
 * reported those two as failures — a benchmark asserting the opposite of the
 * product's rule, which is worse than no benchmark. So each fixture is judged
 * against what IT says it holds.
 */
const wantsPhotograph = (entry: Entry) => Boolean(entry.expect.image)
  && entry.expect.image !== 'blocked_promotional';
const manifest: Entry[] = JSON.parse(
  await Deno.readTextFile(`${corpusDir}/manifest.json`));
/*
 * AND THE ONE CLASS THE CORPUS CANNOT SUPPLY: a scan long enough to cross
 * isolates. Every scan in the acceptance corpus needs one recognised page, so
 * none of them can show what the hand-off costs; the stress corpus's five-page
 * scan does. Absent that corpus, the class is reported UNMEASURED.
 */
const stressDir = Deno.env.get('STRESS_CORPUS') ?? '/var/tmp/stress-corpus';
const stressManifest: Entry[] = await Deno.readTextFile(`${stressDir}/manifest.json`)
  .then((text) => JSON.parse(text) as Entry[]).catch(() => []);

/**
 * WHICH FIXTURE STANDS FOR EACH CLASS.
 *
 * Chosen by NAME rather than by measuring the corpus, and the names are the
 * corpus's own, so a fixture that is renamed fails loudly here rather than
 * quietly standing for a class it is not in. A class with no fixture is
 * REPORTED as unmeasured; it is never silently dropped, because a benchmark
 * that reports four classes when it was asked for five is the shape this
 * repository has already shipped once.
 */
const CLASSES: Array<{ key: string; fixture: string; what: string; stress?: boolean }> = [
  { key: 'native', fixture: 'package-brochure',
    what: 'a native single-property package with a facade render' },
  { key: 'scanned', fixture: 'scanned-no-text-layer',
    what: 'the same shape as a scan, so recognition runs' },
  { key: 'mixed', fixture: 'mixed-scan-and-text',
    what: 'native and scanned pages in one document' },
  { key: 'two', fixture: 'heldout-two-cards',
    what: 'one page carrying two properties and two photographs' },
  { key: 'sheet', fixture: 'heldout-pages-of-cards-with-photos',
    what: 'four properties over two pages, each with its own facade' },
  { key: 'scan-long', fixture: 'stress-scanned-pages', stress: true,
    what: 'a five-page scan, recognised one page per isolate' },
];

async function seedOrganisation(label: string) {
  const { data: org, error } = await db.from('builder_organisations')
    .insert({ legal_name: label, org_type: 'builder' }).select('id').single();
  if (error) throw new Error(`org: ${error.message}`);
  const { data: user, error: uErr } = await db.from('builder_portal_users')
    .insert({ email: `${crypto.randomUUID()}@latency.invalid`, name: `${label} Operator` })
    .select('id').single();
  if (uErr) throw new Error(`user: ${uErr.message}`);
  const { error: mErr } = await db.from('builder_organisation_memberships')
    .insert({ organisation_id: org.id, builder_user_id: user.id, membership_role: 'owner' });
  if (mErr) throw new Error(`membership: ${mErr.message}`);
  return { id: org.id, name: label, userId: user.id };
}

/**
 * Drive the ladder EXACTLY as the settler does, counting isolate boundaries.
 *
 * The allowance is consulted with the same module the settler consults, and a
 * refusal is a HOP: in production the invocation would end there and dispatch
 * its successor. Here the allowance is simply reset and the work goes on, so
 * the compute is complete and the hop count is honest.
 */
async function settleWithHops(organisationId: string, uploadId: string) {
  let hops = 0;
  let allowance = newAllowance();
  let claims = 0;
  let previousShape = '';
  for (let round = 0; round < 24; round += 1) {
    let workedThisRound = 0;
    for (let i = 0; i < 400; i += 1) {
      const claim = await claimOneImageWorkItem(db, { leaseSeconds: 120, organisationId });
      if (!claim.available || !claim.item) break;
      const item = claim.item;
      if (!mayTakeStage(item.image_work_stage, allowance)) {
        // A fresh isolate, which is what the settler's re-arm buys.
        hops += 1;
        allowance = newAllowance();
      }
      spendStage(item.image_work_stage, allowance);
      claims += 1;
      if (claims > 400) {
        await completeItemWork(db, item.id, {
          result: 'latency harness: claim ceiling', progressed: false,
          retryAfterSeconds: 3600,
        });
        continue;
      }
      const settlement = await settleClaimedItem(db, item, { deadlineAt: Date.now() + 20_000 });
      await completeItemWork(db, item.id, {
        nextStage: settlement.nextStage, result: settlement.result,
        progressed: settlement.progressed,
      });
      workedThisRound += 1;
    }
    const outstanding = await readOutstandingUploads(db, { limit: 50 });
    const mine = (outstanding.rows ?? []).filter((c: { id: string }) => c.id === uploadId);
    if (mine.length) {
      await runSettlementTick(mine, { maxSettled: 6, deadlineAt: Date.now() + 40_000 },
        (candidate) => settleUploadSourceImages(db, {
          organisationId: candidate.organisation_id,
          uploadId: candidate.id,
          deadlineAt: Date.now() + 30_000,
          needsProvenance: candidate.needsProvenance,
          needsEligibility: candidate.needsEligibility,
          needsSanitization: candidate.needsSanitization,
        }));
    }
    await enforceStrictPrimaryImages(db, organisationId);
    try { await publishUploadIfReady(db, uploadId); } catch { /* read from state */ }
    const { data } = await db.from('builder_stock_uploads')
      .select('published_at').eq('id', uploadId).maybeSingle();
    if (data?.published_at) return { hops, published: true };
    /*
     * QUIESCENT IS A PROPERTY OF EVERYTHING THE PIPELINE WRITES, which is the
     * acceptance harness's rule and it is here for the reason it learned it:
     * an earlier version of this loop stopped when no ITEM had been claimed in
     * a round, and sanitization and the overlay clearance write to
     * `builder_stock_item_images` — so it walked away from two fixture classes
     * that were still converging and reported them as never publishing.
     */
    const { data: imgRows } = await db.from('builder_stock_item_images')
      .select('id, processing_status, source_detail').eq('upload_id', uploadId);
    const { data: itemRows } = await db.from('builder_stock_items')
      .select('id, image_work_stage, primary_image_id, lifecycle_status')
      .eq('upload_id', uploadId);
    const shape = JSON.stringify([
      (itemRows ?? []).map((r: Record<string, unknown>) =>
        [r.id, r.image_work_stage, r.primary_image_id, r.lifecycle_status]).sort(),
      (imgRows ?? []).map((r: Record<string, unknown>) => [
        r.id, r.processing_status,
        (r.source_detail as Record<string, unknown> | null)
          ?.marketplace_eligibility_state ?? null,
        (r.source_detail as Record<string, unknown> | null)
          ?.sanitization_clearance ? 'cleared' : null,
      ]).sort(),
      workedThisRound > 0,
    ]);
    if (shape === previousShape) return { hops, published: false };
    previousShape = shape;
  }
  return { hops, published: false };
}

/** One whole customer journey: accepted -> published -> a picture that decodes. */
async function once(entry: Entry, iteration: number, dir: string) {
  const org = await seedOrganisation(
    `Latency ${entry.name} #${iteration} ${crypto.randomUUID().slice(0, 8)}`);
  const bytes = await Deno.readFile(`${dir}/${entry.path}`);
  // Where the portal stores it: a successor refuses any path outside the prefix.
  const storagePath = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${crypto.randomUUID()}/${safeObjectName(entry.filename)}`;
  const up = await db.storage.from(BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`storage: ${up.error.message}`);
  const { data: upload, error } = await db.from('builder_stock_uploads').insert({
    organisation_id: org.id, uploaded_by_builder_user_id: org.userId,
    original_filename: entry.filename, storage_bucket: BUCKET,
    storage_path: storagePath, status: 'uploaded',
  }).select('id, original_filename').single();
  if (error) throw new Error(`upload row: ${error.message}`);

  /*
   * THE CLOCK STARTS WHERE THE CUSTOMER'S DOES — at an accepted upload, not
   * at the import call — so the download the portal performs is inside the
   * measurement, as it is in production.
   */
  const t0 = performance.now();
  // `process_upload`: claim, then mark the row as being read.
  const portal = await claimImport(db, upload.id);
  await db.from('builder_stock_uploads').update({ status: 'parsing' }).eq('id', upload.id);
  const dl = await db.storage.from(BUCKET).download(storagePath);
  if (dl.error || !dl.data) throw new Error(`download: ${dl.error?.message}`);
  const downloaded = new Uint8Array(await dl.data.arrayBuffer());

  /*
   * THE IMPORT A CUSTOMER'S UPLOAD PERFORMS, which is resumable: a stored file
   * is its own bytes, so a successor reading them again reproduces this run.
   * The first version of this benchmark called the importer the way a LINKED
   * source is called, which never hands off — harmless while every fixture
   * fitted one isolate, and a measurement of the wrong import the moment one
   * did not.
   */
  const result = await runStockImport({
    supabase: db, organisationId: org.id, organisationName: org.name,
    builderUserId: org.userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes: downloaded, sourceKind: 'file',
    resumableFromStoredBytes: true,
  });
  const claim = portal.ok ? portal.claim : null;
  let importIsolates = 1;
  if (isImportContinuation(result)) {
    // Release, then dispatch — and then this benchmark IS the dispatcher.
    await releaseThenContinue(db, claim, upload.id);
    let state = 'continued';
    while (state === 'continued'
      && importIsolates <= MAX_IMPORT_CONTINUATIONS + MAX_PICTURE_CROSSINGS + 1) {
      state = (await continueStockImport(db, upload.id)).state;
      importIsolates += 1;
    }
    if (state !== 'completed') return { ok: false as const, reason: `continuation ${state}` };
  } else {
    await claim?.release();
    if (!result.ok) return { ok: false as const, reason: String((result as { code?: string }).code) };
    await recordImportCounts(db, {
      uploadId: upload.id, organisationId: org.id, summary: result.summary,
    });
  }
  const importMs = performance.now() - t0;

  const { hops, published } = await settleWithHops(org.id, upload.id);

  /*
   * AND THE PICTURE IS FETCHED THROUGH THE PORTAL'S OWN SERVING STEP AND
   * DECODED. A published property whose card draws nothing is not a finished
   * import, and timing to `published_at` alone would call it one.
   */
  const { data: items } = await db.from('builder_stock_items')
    .select('id, primary_image_id').eq('upload_id', upload.id);
  let served = 0;
  for (const item of items ?? []) {
    if (!item.primary_image_id) continue;
    const out = await serveStockImage(db, {
      organisationId: org.id, imageId: item.primary_image_id,
    });
    if (!out || out.ok === false || !out.url) continue;
    const url = out.url.startsWith('http') ? out.url : `${GATEWAY}${out.url}`;
    const got = await fetch(url);
    if (!got.ok) continue;
    if (decodable(new Uint8Array(await got.arrayBuffer()))) served += 1;
  }
  const totalMs = performance.now() - t0;
  const { data: stages } = await db.from('builder_stock_items')
    .select('image_work_stage').eq('upload_id', upload.id);
  const terminal = (stages ?? []).length > 0 && (stages ?? []).every(
    (row: { image_work_stage: string }) =>
      row.image_work_stage === 'settled' || row.image_work_stage === 'failed');
  return {
    ok: true as const, importMs, totalMs, hops, importIsolates, published, terminal,
    properties: (items ?? []).length, served,
  };
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : NaN;
const ms = (n: number) => `${(n / 1000).toFixed(2)}s`;

console.log(`latency: ${ITERATIONS} iteration(s) per class, corpus ${corpusDir}\n`);
let failures = 0;
for (const cls of CLASSES) {
  const entry = (cls.stress ? stressManifest : manifest).find((e) => e.name === cls.fixture);
  const dir = cls.stress ? stressDir : corpusDir;
  if (!entry) {
    console.log(`${cls.key.padEnd(9)} UNMEASURED — this corpus has no \`${cls.fixture}\``);
    failures += 1;
    continue;
  }
  const totals: number[] = [];
  const imports: number[] = [];
  const wants = wantsPhotograph(entry);
  let hops = 0; let ok = 0; let published = 0; let servedAll = 0; let properties = 0;
  let importIsolates = 0;
  for (let n = 0; n < ITERATIONS; n += 1) {
    const run = await once(entry, n, dir);
    if (!run.ok) { console.log(`${cls.key.padEnd(9)} REFUSED ${run.reason}`); failures += 1; break; }
    totals.push(run.totalMs); imports.push(run.importMs);
    hops = run.hops; properties = run.properties; importIsolates = run.importIsolates;
    if (run.published) published += 1;
    if (run.served >= 1) servedAll += 1;
    /*
     * A run is correct when it reached the state its fixture describes: a
     * document carrying a photograph publishes with one on the card; a
     * document carrying none settles and is correctly withheld.
     */
    if (wants ? (run.published && run.served === run.properties)
              : (run.terminal && !run.published)) ok += 1;
  }
  if (!totals.length) continue;
  const sorted = [...totals].sort((a, b) => a - b);
  const impSorted = [...imports].sort((a, b) => a - b);
  console.log(
    `${cls.key.padEnd(9)} ${entry.name} — ${cls.what}\n`
    + `          compute  median ${ms(pct(sorted, 0.5))}  p90 ${ms(pct(sorted, 0.9))}`
    + `  p95 ${ms(pct(sorted, 0.95))}  max ${ms(sorted[sorted.length - 1])}\n`
    + `          import   median ${ms(pct(impSorted, 0.5))}  max ${ms(impSorted[impSorted.length - 1])}\n`
    + `          import isolates ${importIsolates}   settler hops ${hops}   properties ${properties}`
    + `   published ${published}/${totals.length}   image served ${servedAll}/${totals.length}`
    + `   correct ${ok}/${totals.length}`
    + (wants ? '' : '   (this document carries no photograph; withholding it IS the pass)'));
  if (ok !== totals.length) failures += 1;
}
if (failures) {
  console.error(`\nlatency: ${failures} class(es) did not reach the state their fixture describes`);
  Deno.exit(1);
}
console.log('\nlatency: every class reached the state its fixture describes');
