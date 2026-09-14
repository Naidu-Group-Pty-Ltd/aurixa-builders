#!/usr/bin/env node
/**
 * Build the Builders Network's consolidated baseline from the prime's corpus.
 *
 * This is the Phase 2 squash, executed rather than transcribed
 * (npc-property-dashbord docs/builder-portal/45-network-extraction-plan.md §7):
 *
 *   1. a fresh database gets the Supabase-compatible bootstrap and the
 *      network-standalone fixture (Part 1 services + Part 2 shims), both
 *      read from a prime checkout;
 *   2. the prime's 60 builder migrations replay in strict version order —
 *      one pass, or this build FAILS, because a returning ordering inversion
 *      is the defect that once halted every clone's sync;
 *   3. scripts/db/reshape.sql settles the six entanglements and drops every
 *      shim, asserting each step by effect in one transaction;
 *   4. the surviving schema is dumped, the seed rows the corpus planted are
 *      appended as data (a schema-only dump silently loses the permission
 *      catalogue, and a portal with no permission keys looks exactly like a
 *      portal that denies everything), and the result is written to
 *      supabase/migrations/00000000000000_network_baseline.sql with a
 *      generated provenance header;
 *   5. the catalog fingerprint of the built database is written beside the
 *      baseline. baseline-check.mjs rebuilds from the baseline ALONE and
 *      must land on the same hash — the proof the squash and the corpus
 *      end-state are one schema.
 *
 * Needs a prime checkout (PRIME_DIR or --prime <path>) and a local PostgreSQL
 * 16 (same env contract as the prime's local-db harness: LOCAL_PG_HOST
 * default /tmp, LOCAL_PG_PORT default 55432, LOCAL_PG_USER default postgres).
 * CI never runs this — it runs baseline-check.mjs, which needs no prime.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { catalogFingerprint } from './catalog-fingerprint.mjs';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');

const argv = process.argv.slice(2);
const primeArg = (() => {
  const i = argv.indexOf('--prime');
  return i >= 0 ? argv[i + 1] : process.env.PRIME_DIR;
})();
if (!primeArg || !existsSync(join(primeArg, 'supabase/migrations'))) {
  console.error('Point me at a prime checkout: --prime <path> or PRIME_DIR.');
  process.exit(2);
}
const PRIME = resolve(primeArg);

const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.BASELINE_BUILD_DB || 'aurixa_builders_baseline_build';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args, options = {}) =>
  execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8', stdio: options.stdio || 'pipe',
    env: { ...process.env, PGPASSWORD: '' },
  });
const query = (sql) => psql(['-d', DB, '-At', '-c', sql]).trim();

/**
 * The corpus: builder-named files minus the one Finance false positive —
 * builder_invoices / build_progress_payments merely wear the prefix and stay
 * in the clone (doc 44). The boundary itself is never judged by filename;
 * that is reshape.sql's job, from the catalog.
 */
const EXCLUDED = new Set(['20260717000000_add_builder_invoice_current_payment.sql']);
const migrationsDir = join(PRIME, 'supabase/migrations');
const corpus = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && /builder/i.test(f) && !EXCLUDED.has(f))
  .sort();

console.log(`corpus: ${corpus.length} files from ${PRIME}`);

// --- 1. Fresh database, bootstrap, fixture --------------------------------
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(PRIME, 'scripts/builder-portal/local-db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-f', join(PRIME, 'scripts/builder-portal/local-db/02-network-standalone.sql')]);

// --- 2. Strict version-order replay, ONE pass -----------------------------
for (const f of corpus) {
  try {
    psql(['-d', DB, '-q', '-f', join(migrationsDir, f)]);
  } catch (error) {
    const msg = String(error.stderr || '').split('\n').find((l) => l.includes('ERROR')) || '';
    console.error(`replay halted at ${f}\n  ${msg}`);
    console.error(
      'A version-order inversion is back, or the corpus grew a new prime '
      + 'dependency. Fix it in the PRIME (hoist a bootstrap, or extend the '
      + 'fixture and the extraction plan together) — never here.',
    );
    process.exit(1);
  }
}
console.log(`replayed ${corpus.length}/${corpus.length} in one pass`);

// --- 3. The reshape --------------------------------------------------------
psql(['-d', DB, '-q', '-f', join(here, 'reshape.sql')]);
console.log('reshape applied and self-asserted');

// --- 4. Dump schema + seeds ------------------------------------------------
const pgDump = (args) => execFileSync('pg_dump', [...conn, ...args, DB], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, PGPASSWORD: '' },
});

const schema = pgDump(['--schema-only', '--schema=public', '--no-owner'])
  // pg_dump's session block stays VERBATIM. The first cut of this script
  // scrubbed every SET line as environmental noise and removed
  // `check_function_bodies = false` with them — which is load-bearing: the
  // dump emits functions before the tables their bodies name, and without it
  // the very first such function refuses to create. The one line that is
  // ours to drop is the PG15+ CREATE SCHEMA public, because the platform
  // owns that schema and re-creating it refuses against a real project.
  .split('\n')
  .filter((l) => !/^(CREATE SCHEMA public;|COMMENT ON SCHEMA public )/.test(l))
  .join('\n');

/**
 * Seed tables: rows the corpus itself planted that ARE the product's
 * configuration, discovered rather than listed — every builder table holding
 * rows after a from-nothing build is by definition corpus-seeded, since no
 * operator ever touched this database. connection_scope_keys is the
 * reshape's own vocabulary and travels the same way.
 */
const seedTables = query(`
  SELECT string_agg(t.relname, ' ')
  FROM (
    SELECT c.relname,
           (xpath('/row/n/text()', query_to_xml(
             format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, ''))
           )[1]::text::bigint AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) t WHERE t.rows > 0`).split(' ').filter(Boolean).sort();
console.log(`seed tables: ${seedTables.join(', ')}`);

const seedDump = pgDump([
  '--data-only', '--column-inserts', '--no-owner',
  ...seedTables.flatMap((t) => ['--table', `public.${t}`]),
]);

const buckets = query(`
  SELECT string_agg(
    format('INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (%L, %L, %L, %s, %s) ON CONFLICT (id) DO NOTHING;',
           id, name, public::text, coalesce(file_size_limit::text, 'NULL'),
           coalesce('ARRAY[' || (SELECT string_agg(quote_literal(m), ',') FROM unnest(allowed_mime_types) m) || ']', 'NULL')),
    E'\n' ORDER BY id)
  FROM storage.buckets`);

// --- 5. Provenance ---------------------------------------------------------
const sha = (s) => createHash('sha256').update(s).digest('hex');
const corpusManifest = corpus.map((f) => ({
  file: f, sha256: sha(readFileSync(join(migrationsDir, f), 'utf8')),
}));
writeFileSync(
  join(repoRoot, 'docs/provenance/corpus-manifest.json'),
  `${JSON.stringify({
    built_at: new Date().toISOString(),
    prime: 'Naidu-Group-Pty-Ltd/npc-property-dashbord',
    reshape_sha256: sha(readFileSync(join(here, 'reshape.sql'), 'utf8')),
    // Part 1 of the fixture is where the network-service shapes come from,
    // so a baseline is only reproducible against this exact fixture.
    network_fixture_sha256: sha(readFileSync(
      join(PRIME, 'scripts/builder-portal/local-db/02-network-standalone.sql'), 'utf8')),
    corpus: corpusManifest,
  }, null, 2)}\n`,
);

const tableProvenance = query(`
  SELECT string_agg(relname, E'\n' ORDER BY relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'`)
  .split('\n')
  .map((t) => {
    const sources = corpus.filter((f) =>
      new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?(public\\.)?${t}\\b`, 'i')
        .test(readFileSync(join(migrationsDir, f), 'utf8')));
    return `--   ${t}: ${sources.length ? sources.join(', ') : 'reshape.sql / network fixture'}`;
  })
  .join('\n');

const header = `-- ===========================================================================
-- Aurixa Builders Network — consolidated baseline (the Phase 2 squash)
--
-- GENERATED by scripts/db/build-baseline.mjs. Do not hand-edit: change the
-- prime's corpus or scripts/db/reshape.sql and rebuild, exactly as the
-- prime's own generated migrations work. The WHY for every table below
-- lives in the corpus files, preserved verbatim under docs/provenance/ and
-- pinned by docs/provenance/corpus-manifest.json; the reshape decisions —
-- what was cut at the boundary and why — live in scripts/db/reshape.sql,
-- which is the reviewable half of this file.
--
-- Built ${new Date().toISOString()} from ${corpus.length} corpus files +
-- reshape.sql. Verified: strict version-order replay in ONE pass, reshape
-- self-assertions (boundary closed, RLS everywhere, no clone object
-- survives), and the catalog fingerprint beside this file, which
-- baseline-check.mjs re-derives from this file alone.
--
-- Table provenance (which corpus file created each):
${tableProvenance}
-- ===========================================================================

`;

const baseline = `${header}${schema}

-- ===========================================================================
-- Seeds the corpus planted (a schema-only dump loses these, and a portal
-- with no permission catalogue denies everything while looking healthy)
-- ===========================================================================
${seedDump}

-- ===========================================================================
-- The network's own storage buckets
-- ===========================================================================
${buckets}
`;

const outPath = join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql');
writeFileSync(outPath, baseline);

const fp = catalogFingerprint([...conn, '-d', DB]);
writeFileSync(join(repoRoot, 'supabase/migrations/.baseline-fingerprint'),
  `${fp.hash}  ${fp.lines} catalog lines\n`);

console.log(`baseline written: ${outPath.replace(repoRoot + '/', '')} (${baseline.split('\n').length} lines)`);
console.log(`fingerprint: ${fp.hash.slice(0, 16)}… over ${fp.lines} catalog lines`);
