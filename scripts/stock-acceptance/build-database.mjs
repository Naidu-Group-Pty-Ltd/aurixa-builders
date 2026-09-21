#!/usr/bin/env node
/**
 * A PRODUCTION-EQUIVALENT DATABASE FOR THE ACCEPTANCE CORPUS.
 *
 * Built the way `baseline-check.mjs` builds its own: the Supabase-compatible
 * bootstrap, then the consolidated baseline, then every follow-on migration in
 * order. It is the same schema a hosted project runs, which is what lets the
 * corpus below be run against REAL PostgREST rather than a double.
 *
 * WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS REPOSITORY. Two
 * separate defects in this product's history — the AML screening claim's
 * `.or()` string and the builder-stock ranking fallback's error code — were
 * both invisible for weeks because a TEST DOUBLE agreed with the code while
 * the server disagreed with both. A corpus that proves the PDF pipeline
 * against a hand-written emulation of PostgREST would be the same mistake a
 * third time, so nothing here emulates a query: the filters this pipeline
 * composes are answered by the same PostgREST version Supabase runs, over the
 * same catalogue the migrations produce.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');

const HOST = process.env.LOCAL_PG_HOST || 'localhost';
const PORT = process.env.LOCAL_PG_PORT || '54999';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.ACCEPTANCE_DB || 'stock_acceptance';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args],
  { encoding: 'utf8', stdio: 'pipe' });

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f',
  join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);

const followOn = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql') && !f.startsWith('00000000000000_'))
  .sort();
for (const file of followOn) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}

/**
 * The authenticator role PostgREST connects as. The bootstrap creates the
 * Supabase role set; this only makes sure it can actually log in locally,
 * which a hosted project arranges outside the migration corpus.
 */
psql(['-d', DB, '-c',
  `ALTER ROLE authenticator WITH LOGIN PASSWORD 'acceptance';
   GRANT anon, authenticated, service_role TO authenticator;`]);

const tables = psql(['-d', DB, '-At', '-c',
  `select count(*) from information_schema.tables
    where table_schema='public' and table_name like 'builder_%'`]).trim();
console.log(`acceptance database ${DB}: ${followOn.length} follow-on migrations, ${tables} builder_* tables`);
