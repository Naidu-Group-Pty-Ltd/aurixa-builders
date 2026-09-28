#!/usr/bin/env node
/**
 * A CLEAN REBUILD GIVES THE AI SPEND CEILING PRODUCTION'S EXACT BEHAVIOUR.
 *
 * Six migrations were applied to production out of band on 20 Sep 2026, and
 * two of them never reached this repository: `ai_budget_settle_qualifies_its_
 * columns` (the settle function raised 42702 on its first call) and
 * `ai_budget_functions_are_revoked_from_public` (five SECURITY DEFINER
 * functions that move money were callable by an anonymous caller, because
 * Postgres grants EXECUTE to PUBLIC by default). The question that matters is
 * not whether a FILE exists for each, but whether an environment rebuilt from
 * this directory — a branch, a restore, a second region — comes up with the
 * same posture production has. That is asked here, by effect:
 *
 *   1. The end-state fingerprint of every object the six touched equals the
 *      one read from production on 28 Sep 2026 (ai-budget-fingerprint.expected).
 *   2. anon and authenticated can execute none of the five functions, and a
 *      call as either is REFUSED by the server rather than merely unlisted.
 *   3. service_role can execute all five — a fix that locked the product out of
 *      its own spend ceiling would pass (2) and fail here.
 *   4. settle runs: reserve then settle as service_role returns settled = true,
 *      which is exactly what the 42702 defect made impossible.
 *
 * Why this is its own check. `baseline-check.mjs` proves "privileged functions
 * answer to service_role and to nobody else" against the BASELINE file alone,
 * and the ai_budget functions were created after it — so no check had ever
 * looked at them.
 *
 * One difference is expected and handled explicitly rather than hidden:
 * `GRANT ALL` on a Postgres 17 server includes the MAINTAIN privilege, which
 * does not exist before 17. Production is 17; CI rebuilds on 16. The expected
 * fingerprint is production's, so on a server older than 17 the single token
 * `service_role:MAINTAIN,` is removed from it before comparing — and only that
 * token, from only the table-ACL lines. Anything else that differs fails.
 *
 * Same env contract as the other db checks: LOCAL_PG_HOST, LOCAL_PG_PORT,
 * LOCAL_PG_USER.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.AI_BUDGET_CHECK_DB || 'aurixa_builders_ai_budget_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPASSWORD: '' },
});
const sql = (statement) => psql(['-d', DB, '-qAt', '-c', statement]).trim();

const failures = [];
const ok = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures.push(label);
};

// --- Rebuild exactly as the other db:* checks do. ------------------------------
console.log(`Rebuilding from every migration on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
const migrations = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort();
for (const file of migrations) psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
console.log(`  applied the baseline and ${migrations.length} migrations`);

// --- 1. The end state equals production's. -------------------------------------
const serverMajor = Number(sql('SHOW server_version_num')) / 10000 | 0;
const expected = readFileSync(join(here, 'ai-budget-fingerprint.expected'), 'utf8')
  .split('\n').filter((line) => line && !line.startsWith('#'))
  .map((line) => (serverMajor < 17 && line.startsWith('tbl-acl ')
    ? line.replace('service_role:MAINTAIN,', '')
    : line));
const actual = psql(['-d', DB, '-qAt', '-f', join(here, 'ai-budget-fingerprint.sql')])
  .split('\n').filter(Boolean);
const missing = expected.filter((line) => !actual.includes(line));
const extra = actual.filter((line) => !expected.includes(line));
ok('the rebuilt end state of every object the six migrations touched equals production\'s',
  missing.length === 0 && extra.length === 0,
  `${expected.length} lines compared on Postgres ${serverMajor}`
  + (serverMajor < 17 ? ' (MAINTAIN, a Postgres 17 privilege, excluded from the table ACLs only)' : ''));
for (const line of missing) console.log(`        production has, rebuild lacks: ${line}`);
for (const line of extra) console.log(`        rebuild has, production lacks: ${line}`);

// --- 2 & 3. Who may call them, by catalogue AND by execution. ------------------
const FUNCTIONS = [
  ['ai_budget_reserve(text, bigint, bigint, text, text)', "public.ai_budget_reserve('probe', 1, 10)"],
  ['ai_budget_settle(uuid, bigint)', "public.ai_budget_settle(gen_random_uuid(), 0)"],
  ['ai_budget_release(uuid)', 'public.ai_budget_release(gen_random_uuid())'],
  ['ai_budget_reclaim_expired(text, date, interval)', "public.ai_budget_reclaim_expired('probe', current_date)"],
  ['ai_budget_status(text)', "public.ai_budget_status('probe')"],
];
for (const [signature, call] of FUNCTIONS) {
  const grants = sql(`SELECT has_function_privilege('anon', 'public.${signature}', 'EXECUTE')
                       || ',' || has_function_privilege('authenticated', 'public.${signature}', 'EXECUTE')
                       || ',' || has_function_privilege('service_role', 'public.${signature}', 'EXECUTE')`);
  ok(`${signature}: only service_role may execute it`, grants === 'false,false,true',
    `anon,authenticated,service_role = ${grants}`);

  for (const role of ['anon', 'authenticated']) {
    // Asked of the server, not of the catalogue: the call is made AS the role and
    // must be refused with 42501. A refusal inside a rolled-back transaction
    // writes nothing either way.
    let refused = false; let code = '';
    try {
      psql(['-d', DB, '-qAt', '-c', `BEGIN; SET LOCAL ROLE ${role}; SELECT * FROM ${call}; ROLLBACK;`]);
    } catch (error) {
      const text = String(error.stderr || error.message);
      refused = /permission denied for function/.test(text);
      code = refused ? '42501 permission denied' : text.split('\n')[0].slice(0, 120);
    }
    ok(`${signature}: a call as ${role} is refused by the server`, refused, code || 'the call SUCCEEDED');
  }
}

// --- 4. settle runs, which the 42702 defect made impossible. -------------------
let settled = '';
try {
  settled = sql(`BEGIN; SET LOCAL ROLE service_role;
    WITH r AS (SELECT reservation_id FROM public.ai_budget_reserve('rebuild_probe', 5, 100))
    SELECT s.settled::text || ',' || s.committed_micros FROM r, public.ai_budget_settle(r.reservation_id, 3) s;
    ROLLBACK;`).split('\n').filter((line) => /^(true|false),/.test(line)).pop() ?? '';
} catch (error) {
  settled = `ERROR ${String(error.stderr || error.message).split('\n')[0].slice(0, 120)}`;
}
ok('reserve then settle as service_role runs and settles — no 42702', settled === 'true,3', settled);

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ai-budget rebuild check (${failures.length} failure(s))`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
if (failures.length) process.exit(1);
