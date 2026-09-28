#!/usr/bin/env node
/**
 * ===========================================================================
 * THE FILES PROOFS LEFT BEHIND, REMOVED — AND NOTHING THAT IS NOT A PROOF'S.
 * ===========================================================================
 *
 * MEASURED IN PRODUCTION, 28 SEPTEMBER 2026, by the final Builder Portal
 * audit: 112 files in the Builder's stock buckets under organisations that no
 * longer exist. Every one was a proof's. `production-smoke.mjs` never removed
 * its files and the Tier-0 proofs missed `builder-supplied/<org>/`. Both
 * cleanups are fixed (`proofStorage.mjs`). This removes what they had already
 * left.
 *
 * A file is removed only when all four hold:
 *   1. it is in a stock bucket (`builder-stock-lists`, `builder-stock-images`);
 *   2. the organisation its path names does not exist;
 *   3. no row in `builder_stock_uploads` or `builder_stock_item_images` names
 *      it;
 *   4. its path is one a proof writes (`proofResidue.pure.mjs`). A real
 *      builder deleted by an operator passes 1 to 3, and their files are kept
 *      and counted.
 *
 * DRY RUN BY DEFAULT. It prints what it would remove, by kind and by count,
 * and nothing else: no file name, because this repository's Actions logs are
 * public. To remove, dispatch again with `apply` true and `items` set to the
 * count the dry run printed. If the count has moved in between, it refuses.
 *
 * Runs from the production-rollout workflow (phase `storage-residue-sweep`).
 */
import { objectOrganisationSql, removeObjects, storageClient, STOCK_BUCKETS } from './proofStorage.mjs';
import { planResidueSweep } from './proofResidue.pure.mjs';

const REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const APPLY = String(process.env.APPLY || '').toLowerCase() === 'true';
const EXPECT = String(process.env.SWEEP_EXPECT || '').trim();

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

async function sql(statement) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: statement }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed?.result ?? []);
}

/** Files the database has disowned: tests 1–3 above. */
async function disowned() {
  const owner = objectOrganisationSql('f.name');
  return sql(`
    SELECT f.bucket_id AS bucket, f.name
      FROM storage.objects f
     WHERE f.bucket_id IN (${STOCK_BUCKETS.map((b) => `'${b}'`).join(', ')})
       AND ${owner} ~ '^[0-9a-f-]{36}$'
       AND NOT EXISTS (SELECT 1 FROM public.builder_organisations o WHERE o.id::text = ${owner})
       AND NOT EXISTS (SELECT 1 FROM public.builder_stock_uploads u WHERE u.storage_path = f.name)
       AND NOT EXISTS (SELECT 1 FROM public.builder_stock_item_images i WHERE i.storage_path = f.name)`);
}

const summarise = (label, plan) => {
  console.log(`${label}: ${plan.remove.length} recognisably a proof's, ${plan.keep.length} kept`);
  for (const [kind, n] of Object.entries(plan.byKind)) console.log(`  ${String(n).padStart(4)}  ${kind}`);
  if (plan.keep.length) console.log(`  ${String(plan.keep.length).padStart(4)}  kept — not recognisably a proof artefact`);
};

let verdict = 'FAIL';
try {
  const before = planResidueSweep(await disowned());
  summarise('disowned files in the stock buckets', before);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing removed. To remove these ${before.remove.length}, dispatch again with apply=true and items=${before.remove.length}.`);
    verdict = 'PASS';
  } else if (EXPECT !== String(before.remove.length)) {
    console.log(`\nREFUSED — items=${EXPECT || '(blank)'} but ${before.remove.length} would be removed now. Dry-run first and pass that count.`);
  } else {
    const storage = await storageClient(REF, ACCESS_TOKEN);
    let removed = 0;
    for (const bucket of STOCK_BUCKETS) {
      const names = before.remove.filter((f) => f.bucket === bucket).map((f) => f.name);
      if (names.length) removed += await removeObjects(storage, bucket, names);
    }
    const after = planResidueSweep(await disowned());
    console.log(`\nremoved ${removed} of ${before.remove.length}`);
    summarise('disowned files now', after);
    verdict = removed === before.remove.length && after.remove.length === 0 ? 'PASS' : 'FAIL';
  }
} catch (error) {
  console.log(`the sweep stopped: ${String(error?.message ?? error).slice(0, 300)}`);
}
console.log(`VERDICT storage-residue-sweep ${verdict} ${JSON.stringify({ apply: APPLY })}`);
process.exitCode = verdict === 'PASS' ? 0 : 1;
