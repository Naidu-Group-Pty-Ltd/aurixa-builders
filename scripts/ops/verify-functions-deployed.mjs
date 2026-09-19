#!/usr/bin/env node
/**
 * DID THE DEPLOY ACTUALLY SHIP?
 *
 * The deploy workflow loops over every function, calls `supabase functions
 * deploy`, and trusts the exit code. On 16 Sep 2026 that trust broke: the CLI
 * printed "Deployed Functions on project …" for all 26 functions and exited 0,
 * but only the FIRST function in the loop gained a new version. Twenty-five
 * functions — including a security fix that closed a public registration door —
 * silently stayed on the previous build, and the job was green.
 *
 * This script closes that gap by asking the Management API what is actually
 * deployed, rather than believing the deploy tool's own report.
 *
 * The invariant it enforces is deliberately narrow, so it fails on real
 * problems and stays quiet otherwise:
 *
 *   * ALL functions refreshed in this run  → the deploy worked. Pass.
 *   * NONE refreshed                       → nothing shipped at all (a pure
 *                                            no-op, or a platform that skipped
 *                                            every unchanged bundle). Reported,
 *                                            but not a failure on its own.
 *   * SOME refreshed and some not          → a PARTIAL deploy. This is the
 *                                            dangerous state — the code in
 *                                            production is now a mixture of two
 *                                            commits, and nobody was told. FAIL.
 *
 * Usage: node scripts/ops/verify-functions-deployed.mjs <started-at-epoch-ms>
 * Requires SUPABASE_ACCESS_TOKEN and PROJECT_REF in the environment.
 */
const startedAt = Number(process.argv[2]);
const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.PROJECT_REF;

if (!Number.isFinite(startedAt) || startedAt <= 0) {
  console.error('::error::verify-functions-deployed: a numeric start timestamp (epoch ms) is required');
  process.exit(1);
}
if (!token || !projectRef) {
  console.error('::error::verify-functions-deployed: SUPABASE_ACCESS_TOKEN and PROJECT_REF are required');
  process.exit(1);
}

async function listFunctions() {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/functions`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    console.error(`::error::verify-functions-deployed: the Management API answered ${response.status} — cannot confirm what shipped`);
    process.exit(1);
  }
  const body = await response.json();
  if (!Array.isArray(body) || body.length === 0) {
    console.error('::error::verify-functions-deployed: the project reports no functions at all');
    process.exit(1);
  }
  // Only the functions this repository owns. A function deployed by another
  // tool is not this workflow's to judge.
  return body.filter((fn) => String(fn.slug || '').startsWith('builder-'));
}

/**
 * AND THE LISTING IS ASKED AGAIN BEFORE A PARTIAL DEPLOY IS DECLARED.
 *
 * 19 SEPTEMBER 2026, RUN 35424012572. `builder-portal-workspace` and
 * `builder-ranking-recompute` each printed "Deployed Functions on project …"
 * at 05:29:03 and 05:29:06; this script read the listing at 05:29:14 and
 * still saw version 194 and 84, stamped 04:09. Both were in fact deployed.
 * The Management API's function listing is eventually consistent and this
 * check had no tolerance for it at all, so a correct deploy was reported as
 * the one state the check exists to catch.
 *
 * THAT IS WORSE THAN NOT CHECKING. A verifier that cries wolf on a good
 * deploy is one an operator learns to re-run without reading, which is
 * exactly how the real partial deploy of 16 September would pass unnoticed
 * the next time. So a stale reading is RE-ASKED rather than believed, on a
 * bounded schedule, and the failure below now means "still stale after we
 * gave it time" instead of "stale in the first eight seconds".
 *
 * BOUNDED, AND IT NEVER TURNS A FAILURE INTO A PASS BY WAITING. The loop
 * stops the moment nothing is stale; it cannot invent freshness, because
 * `updated_at >= startedAt` is the same comparison on every pass and the
 * timestamps it reads come from the platform. A genuine partial deploy stays
 * partial for all six passes and fails ~50 seconds later than it used to.
 */
const SETTLE_PASSES = 6;
const SETTLE_MS = 10_000;
let ours = await listFunctions();
let fresh = ours.filter((fn) => Number(fn.updated_at) >= startedAt);
let stale = ours.filter((fn) => Number(fn.updated_at) < startedAt);

for (let pass = 1; pass <= SETTLE_PASSES && fresh.length > 0 && stale.length > 0; pass += 1) {
  console.log(`  ${stale.length} function(s) still read as stale; re-asking the listing `
    + `(pass ${pass} of ${SETTLE_PASSES}) — the API's listing is eventually consistent`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  ours = await listFunctions();
  fresh = ours.filter((fn) => Number(fn.updated_at) >= startedAt);
  stale = ours.filter((fn) => Number(fn.updated_at) < startedAt);
}

const stamp = (ms) => new Date(Number(ms)).toISOString();
console.log(`checked ${ours.length} builder function(s) against a deploy that began ${stamp(startedAt)}`);
console.log(`  refreshed in this run: ${fresh.length}`);
console.log(`  unchanged since before it: ${stale.length}`);

if (fresh.length > 0 && stale.length > 0) {
  console.error('::error::PARTIAL DEPLOY — the deploy reported success but only some functions were shipped. '
    + 'Production is now running a mixture of builds. Re-run this workflow, then confirm every function is listed as refreshed.');
  for (const fn of stale) {
    console.error(`::error::not shipped: ${fn.slug} (still version ${fn.version}, last updated ${stamp(fn.updated_at)})`);
  }
  process.exit(1);
}

if (fresh.length === 0) {
  // Not a failure by itself: a re-run with no changes can legitimately look
  // like this. It IS worth saying out loud, so a "successful" deploy that
  // shipped nothing is never mistaken for one that shipped something.
  console.log('::warning::no function was refreshed by this run — nothing new reached production.');
} else {
  console.log(`every builder function was refreshed by this run (${fresh.length}/${ours.length}).`);
}
