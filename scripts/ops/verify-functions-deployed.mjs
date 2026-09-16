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

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/functions`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!response.ok) {
  console.error(`::error::verify-functions-deployed: the Management API answered ${response.status} — cannot confirm what shipped`);
  process.exit(1);
}

const functions = await response.json();
if (!Array.isArray(functions) || functions.length === 0) {
  console.error('::error::verify-functions-deployed: the project reports no functions at all');
  process.exit(1);
}

// Only the functions this repository owns. A function deployed by another
// tool is not this workflow's to judge.
const ours = functions.filter((fn) => String(fn.slug || '').startsWith('builder-'));
const fresh = ours.filter((fn) => Number(fn.updated_at) >= startedAt);
const stale = ours.filter((fn) => Number(fn.updated_at) < startedAt);

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
