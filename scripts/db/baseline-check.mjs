#!/usr/bin/env node
/**
 * Prove the consolidated baseline stands alone.
 *
 * build-baseline.mjs derives the baseline from the prime's corpus and writes
 * the catalog fingerprint of the database it built. THIS script needs no
 * prime at all: a fresh database gets the Supabase-compatible bootstrap and
 * then the baseline file, alone — and must land on the very same
 * fingerprint. That equality is the extraction plan's acceptance for the
 * squash ("applying it against Part 1 alone must succeed"), made stricter:
 * the baseline carries Part 1 itself, so it applies against NOTHING but the
 * platform bootstrap, and not just "succeeds" but reproduces the corpus
 * end-state to the constraint definition and the function body.
 *
 * It then re-asserts the reshape's guarantees against the rebuilt database,
 * because a fingerprint match proves equality with what was built, and the
 * assertions prove what was built is what the plan requires — two different
 * claims, both worth holding:
 *
 *   - no clone object under any name, in relations OR function sources;
 *   - every foreign key lands inside the network;
 *   - RLS enabled on every public table;
 *   - the corpus seeds arrived (a permission catalogue of zero rows denies
 *     everything while looking healthy);
 *   - the scope vocabulary holds exactly the seven planned keys.
 *
 * Runs in CI on every push. Same env contract as the prime's harness:
 * LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432), LOCAL_PG_USER
 * (postgres).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogFingerprint } from './catalog-fingerprint.mjs';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');

const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.BASELINE_CHECK_DB || 'aurixa_builders_baseline_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPASSWORD: '' },
});
const query = (sql) => psql(['-d', DB, '-At', '-c', sql]).trim();

const failures = [];

console.log(`Rebuilding from the baseline alone on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(here, '00-supabase-bootstrap.sql')]);
// public belongs to the migrations, exactly as on a hosted project. The
// bootstrap's public-schema stand-ins exist only so the PRIME's harness can
// replay a raw corpus; the baseline carries everything the network's public
// schema holds, so the check hands it a public schema with nothing in it —
// and a baseline that needed anything else would fail right here.
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
console.log('baseline applied against the bootstrap alone.');

// --- 1. The fingerprint ------------------------------------------------------
const recorded = readFileSync(
  join(repoRoot, 'supabase/migrations/.baseline-fingerprint'), 'utf8',
).trim().split(/\s+/)[0];
const rebuilt = catalogFingerprint([...conn, '-d', DB]);
if (rebuilt.hash !== recorded) {
  failures.push(
    `catalog fingerprint diverged: baseline rebuild ${rebuilt.hash.slice(0, 16)}… `
    + `vs recorded ${recorded.slice(0, 16)}… — the baseline file and the build `
    + 'that produced it no longer describe one schema. Rebuild with '
    + 'build-baseline.mjs rather than editing either by hand.',
  );
} else {
  console.log(`fingerprint matches the build: ${rebuilt.hash.slice(0, 16)}… (${rebuilt.lines} catalog lines)`);
}

// --- 1b. Follow-on migrations ------------------------------------------------
// The repository may carry migrations AFTER the baseline (the baseline is the
// squash of the prime's corpus; network-native changes land as ordinary
// files). The fingerprint above is asserted BEFORE they apply — it pins the
// squash — and every later assertion runs AFTER, so the boundary, RLS and
// seed proofs hold over the schema a fresh deployment would actually get.
const followOn = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f !== '00000000000000_network_baseline.sql')
  .sort();
for (const file of followOn) {
  psql(['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(repoRoot, 'supabase/migrations', file)]);
  console.log(`follow-on migration applied: ${file}`);
}

// --- 2. The reshape's guarantees, re-proven on the rebuilt database ----------
const badRelations = query(`
  SELECT coalesce(string_agg(relname, ', '), '')
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v')
    AND (c.relname IN (
      'clients','client_deals','legal_matters','purchase_files',
      'transaction_cases','transaction_case_links','transaction_case_link_history',
      'dashboard_modules','custom_users','user_permissions',
      'document_records','document_versions',
      'portal_terms_versions','portal_terms_acceptances',
      'builder_stock_selections')
      OR c.relname LIKE 'cross\\_portal\\_%')`);
if (badRelations) failures.push(`clone relations present: ${badRelations}`);

const badFunctions = query(`
  SELECT coalesce(string_agg(p.proname, ', '), '')
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosrc ~* '\\m(clients|client_deals|legal_matters|purchase_files|transaction_cases|transaction_case_links|transaction_case_link_history|dashboard_modules|custom_users|user_permissions|document_records|document_versions|portal_terms_versions|portal_terms_acceptances|builder_stock_selections|cross_portal_[a-z_]+)\\M'`);
if (badFunctions) failures.push(`functions naming clone objects: ${badFunctions}`);

const escapedFks = query(`
  SELECT coalesce(string_agg(DISTINCT c.confrelid::regclass::text, ', '), '')
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
  WHERE c.contype = 'f' AND ns.nspname = 'public'
    AND c.confrelid::regclass::text !~ '^(public\\.)?(builder_|workspace_|connection_|feature_flags|portal_operational_|integration_|document_processing_jobs)'
    AND c.confrelid <> 'storage.buckets'::regclass`);
if (escapedFks) failures.push(`foreign keys leaving the network: ${escapedFks}`);

const noRls = query(`
  SELECT coalesce(string_agg(relname, ', '), '')
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
if (noRls) failures.push(`tables without RLS: ${noRls}`);

// --- 3. Seeds and vocabulary --------------------------------------------------
const seedChecks = [
  ['builder_permission_keys', 1],
  ['builder_role_default_permissions', 1],
  ['builder_transaction_pipeline_stages', 1],
  ['connection_scope_keys', 7],
];
for (const [table, atLeast] of seedChecks) {
  const n = Number(query(`SELECT count(*) FROM public.${table}`));
  if (!(n >= atLeast)) {
    failures.push(`${table}: expected at least ${atLeast} seeded row(s), found ${n}`);
  }
}
const scopeCount = Number(query('SELECT count(*) FROM public.connection_scope_keys'));
if (scopeCount !== 7) failures.push(`scope vocabulary must be exactly 7 keys, found ${scopeCount}`);

const buckets = query(`SELECT string_agg(id, ',' ORDER BY id) FROM storage.buckets`);
if (buckets !== 'builder-documents,builder-stock-images,builder-stock-lists') {
  failures.push(`storage buckets are ${buckets || '(none)'} — expected the network's three`);
}

const tableCount = Number(query(`
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'builder\\_%'`));
console.log(`builder_* tables: ${tableCount}; buckets: ${buckets}`);

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('\nBaseline check passed: the squash stands alone and equals the corpus end-state.');
