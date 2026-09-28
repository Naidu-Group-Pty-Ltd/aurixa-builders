#!/usr/bin/env node
/**
 * ===========================================================================
 * A TASK ON A STOCK ITEM ANSWERS TO THE ROLE MATRIX, LIKE EVERY OTHER TASK.
 * ===========================================================================
 *
 * MEASURED IN PRODUCTION, 28 SEPTEMBER 2026, by the portal UI audit
 * (`scripts/ops/portal-ui-audit.mjs`): a READ-ONLY colleague created a task on
 * one of the organisation's stock items and was answered HTTP 200. The role
 * matrix gives `read_only` tasks view and nothing else, and every other scope
 * (project, unit, transaction, construction case) resolves through
 * `builder_resolve_permission`, which applies the role default, the
 * membership's own overrides and the read-only clamp. The stock-item scope
 * (`builder_resolve_stock_item_permission`, 20260916150000) asked only whether
 * the caller was an active member of the item's organisation, so view and edit
 * were open to every member whatever their role or overrides said.
 *
 * Proved against a database rebuilt from this repository's migrations:
 *   * owner, administrator, manager and member may view and edit a stock
 *     item's tasks, as their role defaults say;
 *   * read_only may view and may NOT edit;
 *   * a membership override that denies tasks is obeyed;
 *   * a suspended membership, an inactive user and another organisation's
 *     member get nothing;
 *   * nothing but `tasks` view/edit is ever answered on a stock scope.
 *
 * Environment: LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432),
 * LOCAL_PG_USER (postgres), STOCK_TASK_PERMISSION_DB.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.STOCK_TASK_PERMISSION_DB || 'aurixa_builders_stock_task_permission_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: '' },
});
const q1 = (statement) => psql(['-d', DB, '-At', '-c', statement]).trim();
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
for (const file of readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort()) {
  psql(['-d', DB, '-f', join(repoRoot, 'supabase/migrations', file)]);
}
console.log('schema ready (baseline + every follow-on migration).\n');

const ORG = randomUUID(); const OTHER_ORG = randomUUID(); const ITEM = randomUUID();
const people = {
  owner: randomUUID(), administrator: randomUUID(), manager: randomUUID(), member: randomUUID(),
  read_only: randomUUID(), denied: randomUUID(), suspended: randomUUID(), inactive: randomUUID(), outsider: randomUUID(),
};
q1(`
  INSERT INTO public.builder_organisations(id, legal_name, org_type, status, is_active, activated_at)
  VALUES (${lit(ORG)}, 'Task Check Homes', 'builder', 'active', true, now()),
         (${lit(OTHER_ORG)}, 'Other Task Homes', 'builder', 'active', true, now());
  INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password)
  SELECT id, key || '@task-check.example', key, CASE WHEN key = 'inactive' THEN 'suspended' ELSE 'active' END,
         key <> 'inactive', now(), false
    FROM (VALUES ${Object.entries(people).map(([key, uid]) => `(${lit(uid)}::uuid, ${lit(key)})`).join(', ')}) AS t(id, key);
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (${lit(people.owner)}, ${lit(ORG)}, 'owner', true, 'active'),
         (${lit(people.administrator)}, ${lit(ORG)}, 'administrator', false, 'active'),
         (${lit(people.manager)}, ${lit(ORG)}, 'manager', false, 'active'),
         (${lit(people.member)}, ${lit(ORG)}, 'member', false, 'active'),
         (${lit(people.read_only)}, ${lit(ORG)}, 'read_only', false, 'active'),
         (${lit(people.denied)}, ${lit(ORG)}, 'member', false, 'active'),
         (${lit(people.suspended)}, ${lit(ORG)}, 'member', false, 'suspended'),
         (${lit(people.inactive)}, ${lit(ORG)}, 'member', false, 'active'),
         (${lit(people.outsider)}, ${lit(OTHER_ORG)}, 'owner', true, 'active');
  INSERT INTO public.builder_membership_permissions(membership_id, permission_key, scope_type, view_decision, edit_decision, delete_decision)
  SELECT m.id, 'tasks', 'organisation', 'inherit', 'deny', 'deny'
    FROM public.builder_organisation_memberships m WHERE m.builder_user_id = ${lit(people.denied)};
  INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
  VALUES (${lit(ITEM)}, ${lit(ORG)}, '101', '1 Task Street', 'active');
`);

const may = (who, level, key = 'tasks') => q1(`SELECT public.builder_resolve_scope_permission(
  ${lit(people[who])}::uuid, 'stock_item', ${lit(ITEM)}::uuid, ${lit(key)}, ${lit(level)})`) === 't';

for (const role of ['owner', 'administrator', 'manager', 'member']) {
  check(`${role} may view and edit a stock item's tasks (role default)`, may(role, 'view') && may(role, 'edit'));
}
check('read_only may view a stock item\'s tasks', may('read_only', 'view'));
check('read_only may NOT create or change a stock item\'s tasks (the measured defect)', !may('read_only', 'edit'));
check('a membership override denying task edits is obeyed on a stock item', may('denied', 'view') && !may('denied', 'edit'));
check('a suspended member gets nothing', !may('suspended', 'view') && !may('suspended', 'edit'));
check('an inactive user gets nothing', !may('inactive', 'view') && !may('inactive', 'edit'));
check('another organisation\'s owner gets nothing', !may('outsider', 'view') && !may('outsider', 'edit'));
check('nothing but tasks is answered on a stock scope', !may('owner', 'view', 'documents') && !may('owner', 'view', 'messages'));
check('no one may delete through a stock scope', !may('owner', 'delete'));
check('the resolver is not executable by anon or authenticated',
  q1(`SELECT has_function_privilege('anon', 'public.builder_resolve_stock_item_permission(uuid, uuid, text, text)', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.builder_resolve_stock_item_permission(uuid, uuid, text, text)', 'EXECUTE')`) === 'f');

console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
