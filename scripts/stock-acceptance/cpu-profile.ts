/**
 * ===========================================================================
 * WHERE AN IMPORT SPENDS ITS CPU. MEASURED, NOT GUESSED.
 * ===========================================================================
 *
 * The first rule of the 22 September importer incident was "measure before
 * splitting": do not create three new functions and hope one of them is the
 * expensive one. This runs the REAL importer — `runStockImport`, the same
 * module `builder-portal-stock` calls — over the stress corpus and prints the
 * stage ledger it fills, so the stage boundaries can be chosen from numbers.
 *
 * WHAT IT CAN AND CANNOT TELL YOU.
 *
 * It measures on this machine, not on an Edge Function, so the ABSOLUTE
 * milliseconds are not production's. What transfers is the SHAPE: which
 * stages dominate, how they scale with a document's pages, its text runs and
 * its photographs, and which combinations add up. That is what decides where
 * a boundary belongs. The production ceiling itself is measured where it
 * lives — by `beforeunload`, which names the resource on the run that dies.
 *
 * It is deliberately NOT part of `run.sh`. A profiler that gated a merge
 * would make a slow shared runner look like a regression; this is run and
 * read.
 *
 *   usage: deno run --allow-all --node-modules-dir=none \
 *            --import-map scripts/stock-acceptance/import-map.json \
 *            scripts/stock-acceptance/cpu-profile.ts [corpus] [iterations]
 */
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { runStockImport } from '../../supabase/functions/_shared/builderStock/runImport.ts';
import { recordImportCounts } from '../../supabase/functions/_shared/builderStock/recordImportOutcome.ts';
import {
  IMPORT_STAGES, importWorkClassOf, ledgerTotalMs,
  stageMsKey, type ImportStageLedger, type ImportWorkClass,
} from '../../supabase/functions/_shared/builderStock/importStageLedger.pure.ts';

const GATEWAY = Deno.env.get('GATEWAY_URL') ?? 'http://localhost:54997';
const KEY = (await Deno.readTextFile('/var/tmp/service-role.jwt')).trim();
const BUCKET = 'builder-stock-lists';
const corpusDir = Deno.args[0] ?? '/var/tmp/stress-corpus';
const ITERATIONS = Number(Deno.args[1] ?? '3');

const db = createClient(GATEWAY, KEY, { auth: { persistSession: false } });
Deno.env.set('SUPABASE_URL', GATEWAY);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', KEY);

interface Entry {
  name: string; filename: string; path: string; what: string; bytes: number;
  expect: { properties: number; image?: string | null };
}
const manifest: Entry[] = JSON.parse(
  await Deno.readTextFile(`${corpusDir}/manifest.json`));

async function seedOrganisation(label: string) {
  const { data: org, error } = await db.from('builder_organisations')
    .insert({ legal_name: label, org_type: 'builder' }).select('id').single();
  if (error) throw new Error(`org: ${error.message}`);
  const { data: user, error: uErr } = await db.from('builder_portal_users')
    .insert({ email: `${crypto.randomUUID()}@profile.invalid`, name: `${label} Operator` })
    .select('id').single();
  if (uErr) throw new Error(`user: ${uErr.message}`);
  const { error: mErr } = await db.from('builder_organisation_memberships')
    .insert({ organisation_id: org.id, builder_user_id: user.id, membership_role: 'owner' });
  if (mErr) throw new Error(`membership: ${mErr.message}`);
  return { id: org.id, name: label, userId: user.id };
}

/** One import, exactly as the portal runs it, returning the stage ledger. */
async function profile(entry: Entry, iteration: number) {
  const org = await seedOrganisation(
    `Profile ${entry.name} #${iteration} ${crypto.randomUUID().slice(0, 8)}`);
  const bytes = await Deno.readFile(`${corpusDir}/${entry.path}`);
  const storagePath = `${org.id}/profile-${crypto.randomUUID()}.pdf`;
  const up = await db.storage.from(BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`storage: ${up.error.message}`);
  const { data: upload, error } = await db.from('builder_stock_uploads').insert({
    organisation_id: org.id, uploaded_by_builder_user_id: org.userId,
    original_filename: entry.filename, storage_bucket: BUCKET,
    storage_path: storagePath, status: 'uploaded',
  }).select('id, original_filename').single();
  if (error) throw new Error(`upload row: ${error.message}`);

  const startedAt = performance.now();
  const result = await runStockImport({
    supabase: db, organisationId: org.id, organisationName: org.name,
    builderUserId: org.userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes, sourceKind: 'file',
  });
  const wallMs = performance.now() - startedAt;
  if (result.ok) {
    await recordImportCounts(db, {
      uploadId: upload.id, organisationId: org.id, summary: result.summary,
    });
  }

  /*
   * READ THE LEDGER BACK OUT OF THE ROW rather than from the return value.
   * The row is what a production investigation has, and reading anything else
   * would measure a path production does not use — the infidelity this
   * harness keeps finding in itself.
   */
  const { data: row } = await db.from('builder_stock_uploads')
    .select('stage_timings').eq('id', upload.id).maybeSingle();
  const { count: properties } = await db.from('builder_stock_items')
    .select('id', { count: 'exact', head: true }).eq('upload_id', upload.id);
  return {
    ok: result.ok,
    code: result.ok ? null : String((result as { code?: string }).code ?? ''),
    ledger: (row?.stage_timings ?? {}) as ImportStageLedger,
    wallMs, properties: properties ?? 0,
  };
}

const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length);
const ms = (n: number) => `${n.toFixed(0)}`.padStart(7);

console.log(`cpu-profile: ${ITERATIONS} iteration(s) per document, corpus ${corpusDir}\n`);

const classTotals: Record<ImportWorkClass, number[]> = {
  document: [], raster: [], metadata: [],
};

for (const entry of manifest) {
  const runs: Array<Awaited<ReturnType<typeof profile>>> = [];
  for (let n = 0; n < ITERATIONS; n += 1) runs.push(await profile(entry, n));
  const ok = runs.filter((r) => r.ok);
  if (!ok.length) {
    console.log(`${pad(entry.name, 24)} REFUSED  ${runs[0]?.code ?? ''}`);
    continue;
  }
  /** The median run, so one slow scheduling hiccup cannot write the story. */
  const median = [...ok].sort((a, b) => a.wallMs - b.wallMs)[Math.floor(ok.length / 2)];
  const ledger = median.ledger;
  console.log(`${entry.name}  —  ${entry.what}`);
  console.log(`  ${(entry.bytes / 1_000_000).toFixed(2)} MB, `
    + `${median.properties} propert${median.properties === 1 ? 'y' : 'ies'}, `
    + `wall ${(median.wallMs / 1000).toFixed(2)}s, `
    + `ledger total ${(ledgerTotalMs(ledger) / 1000).toFixed(2)}s`);
  const byClass: Record<ImportWorkClass, number> = { document: 0, raster: 0, metadata: 0 };
  for (const stage of IMPORT_STAGES) {
    const value = ledger[stageMsKey(stage)];
    if (typeof value !== 'number' || value <= 0) continue;
    byClass[importWorkClassOf(stage)] += value;
    console.log(`    ${pad(stage, 20)} ${ms(value)} ms   ${importWorkClassOf(stage)}`);
  }
  for (const [name, total] of Object.entries(byClass) as Array<[ImportWorkClass, number]>) {
    classTotals[name].push(total);
  }
  const counters = ['document_parses', 'rasterisations', 'ocr_pages', 'images_extracted']
    .map((key) => `${key}=${ledger[key] ?? 0}`).join('  ');
  console.log(`    ${counters}\n`);
}

console.log('class totals across the corpus (ms, median run each):');
for (const [name, values] of Object.entries(classTotals) as Array<[ImportWorkClass, number[]]>) {
  const sum = values.reduce((a, b) => a + b, 0);
  const worst = values.length ? Math.max(...values) : 0;
  console.log(`  ${pad(name, 10)} total ${ms(sum)}   worst single document ${ms(worst)}`);
}
