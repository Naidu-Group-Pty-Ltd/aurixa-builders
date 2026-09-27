#!/usr/bin/env node
/**
 * Organisation members are managed in the portal — proved against a database
 * rebuilt from this repository's migrations, the same way the other checks
 * here are.
 *
 * `builder_org_manage_membership` (20260927100000) must:
 *   * be reachable only by an ACTIVE owner or administrator of THAT
 *     organisation (the authority invitations and join requests already use);
 *   * let an administrator manage non-owners only, and only an owner an owner;
 *   * refuse self-management, an unknown action, an invalid role and `owner`;
 *   * never leave the organisation without an active owner — including when
 *     two owners try to remove each other at the same moment;
 *   * read another organisation's membership as absent;
 *   * suspend / reactivate / remove through the existing states, ending the
 *     member's sessions when that was their last organisation and refusing a
 *     new session, while leaving authorship and history untouched;
 *   * write one audit row per act, and be callable by service_role only.
 *
 * Environment: LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432),
 * LOCAL_PG_USER (postgres), MEMBER_MANAGEMENT_DB.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.MEMBER_MANAGEMENT_DB || 'aurixa_builders_member_management_check';
const MIGRATION = '20260927100000_organisation_members_managed_in_the_portal.sql';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
const sql = (statement) => psql(['-d', DB, '-qAt', '-c', statement]).trim();
const sqlAsync = (statement) => new Promise((resolve) => {
  execFile('psql', [...conn, '-v', 'ON_ERROR_STOP=1', '-d', DB, '-qAt', '-c', statement], { encoding: 'utf8' },
    (error, stdout, stderr) => resolve(error ? `ERROR ${stderr}` : stdout.trim()));
});
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
function refusal(statement) {
  try { sql(statement); return null; } catch (error) { return String(error.stderr ?? error.message); }
}

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
const migrations = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort();
for (const file of migrations) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}
check(`${MIGRATION} exists and applied`, migrations.includes(MIGRATION)
  && sql(`SELECT to_regprocedure('public.builder_org_manage_membership(uuid,uuid,uuid,text,text,text)') IS NOT NULL`) === 't');
if (!migrations.includes(MIGRATION)) {
  console.log(`\n${checks - failures} of ${checks} checks passed`);
  process.exit(1);
}

// --- Fixtures ------------------------------------------------------------------
const ORG_A = randomUUID(); const ORG_B = randomUUID();
const OWNER = randomUUID(); const OWNER2 = randomUUID(); const ADMIN = randomUUID();
const MANAGER = randomUUID(); const MEMBER = randomUUID(); const READER = randomUUID();
const TWO_ORGS = randomUUID(); const B_OWNER = randomUUID();
sql(`
  INSERT INTO public.builder_organisations(id, legal_name, org_type, status, is_active, activated_at)
  VALUES (${lit(ORG_A)}, 'Member Check A', 'builder', 'active', true, now()),
         (${lit(ORG_B)}, 'Member Check B', 'builder', 'active', true, now());
  DELETE FROM public.builder_network_outbox;
  DELETE FROM public.workspace_connection_events;
  DELETE FROM public.workspace_connections;
  INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password)
  SELECT id, lower(name) || '@member-check.example', name, 'active', true, now(), false
    FROM (VALUES (${lit(OWNER)}::uuid, 'Owen'), (${lit(OWNER2)}::uuid, 'Olive'), (${lit(ADMIN)}::uuid, 'Ada'),
                 (${lit(MANAGER)}::uuid, 'Mia'), (${lit(MEMBER)}::uuid, 'Max'), (${lit(READER)}::uuid, 'Rae'),
                 (${lit(TWO_ORGS)}::uuid, 'Tess'), (${lit(B_OWNER)}::uuid, 'Bea')) AS t(id, name);
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (${lit(OWNER)}, ${lit(ORG_A)}, 'owner', true, 'active'),
         (${lit(ADMIN)}, ${lit(ORG_A)}, 'administrator', true, 'active'),
         (${lit(MANAGER)}, ${lit(ORG_A)}, 'manager', true, 'active'),
         (${lit(MEMBER)}, ${lit(ORG_A)}, 'member', true, 'active'),
         (${lit(READER)}, ${lit(ORG_A)}, 'read_only', true, 'active'),
         (${lit(TWO_ORGS)}, ${lit(ORG_A)}, 'member', false, 'active'),
         (${lit(TWO_ORGS)}, ${lit(ORG_B)}, 'member', true, 'active'),
         (${lit(B_OWNER)}, ${lit(ORG_B)}, 'owner', true, 'active');`);
const mid = (user, org = ORG_A) => sql(`SELECT id FROM public.builder_organisation_memberships
  WHERE builder_user_id = ${lit(user)} AND organisation_id = ${lit(org)} AND revoked_at IS NULL`);
const state = (user, org = ORG_A) => sql(`SELECT membership_role || ':' || status || ':' || (revoked_at IS NOT NULL)
  FROM public.builder_organisation_memberships WHERE builder_user_id = ${lit(user)} AND organisation_id = ${lit(org)}
  ORDER BY created_at DESC LIMIT 1`);
const manage = (actor, membership, action, role = null, org = ORG_A) =>
  `SELECT membership_role || ':' || status FROM public.builder_org_manage_membership(
     ${lit(actor)}, ${lit(org)}, ${lit(membership)}, ${lit(action)}, ${lit(role)}, 'member check')`;
const audits = () => Number(sql(`SELECT count(*) FROM public.builder_portal_activity_log
  WHERE organisation_id = ${lit(ORG_A)} AND actor_type = 'builder_user' AND entity_type = 'membership'`));
const session = (user) => {
  const hash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return sql(`SELECT public.builder_issue_session(${lit(user)}, ${lit(hash)}, now() + interval '1 hour', now() + interval '1 hour')`);
};
const sessionLive = (id) => sql(`SELECT revoked_at IS NULL FROM public.builder_portal_sessions WHERE id = ${lit(id)}`) === 't';

// --- Who may manage --------------------------------------------------------------
for (const [who, actor] of [['manager', MANAGER], ['member', MEMBER], ['read_only', READER]]) {
  const r = refusal(manage(actor, mid(TWO_ORGS), 'set_role', 'read_only'));
  check(`a ${who} cannot manage members`, /BUILDER_NOT_ORG_ADMIN/.test(r ?? ''), r ? 'refused' : 'ALLOWED');
}
check('another organisation\'s owner cannot manage this organisation',
  /BUILDER_NOT_ORG_ADMIN/.test(refusal(manage(B_OWNER, mid(MEMBER), 'suspend')) ?? ''));
check('an owner cannot reach another organisation\'s membership (reads as absent)',
  /BUILDER_MEMBERSHIP_NOT_FOUND/.test(refusal(manage(OWNER, mid(B_OWNER, ORG_B), 'suspend')) ?? ''));

// --- Roles -------------------------------------------------------------------------
const before = audits();
check('an owner changes a role (member → manager), effective at once',
  sql(manage(OWNER, mid(MEMBER), 'set_role', 'manager')) === 'manager:active'
    && sql(`SELECT public.builder_resolve_permission(${lit(MEMBER)}, ${lit(ORG_A)}, 'org_admin', 'view')::text`) !== null);
check('an administrator changes a non-owner role (manager → read_only)',
  sql(manage(ADMIN, mid(MEMBER), 'set_role', 'read_only')) === 'read_only:active');
check('read_only is clamped immediately by the resolver after the change',
  sql(`SELECT public.builder_resolve_permission(${lit(MEMBER)}, ${lit(ORG_A)}, 'inventory', 'edit')`) === 'f');
check('each act writes one audit row', audits() === before + 2, `${before} → ${audits()}`);
for (const bad of ['owner', 'superuser', '', null]) {
  check(`role ${JSON.stringify(bad)} is refused`,
    /BUILDER_MEMBER_ROLE_INVALID/.test(refusal(manage(OWNER, mid(MEMBER), 'set_role', bad)) ?? ''));
}
check('an unknown action is refused', /BUILDER_MEMBER_ACTION_UNKNOWN/.test(refusal(manage(OWNER, mid(MEMBER), 'promote')) ?? ''));
check('an administrator cannot touch an owner',
  /BUILDER_OWNER_ONLY/.test(refusal(manage(ADMIN, mid(OWNER), 'suspend')) ?? ''));
check('nobody manages their own membership',
  /BUILDER_MEMBER_SELF_MANAGEMENT/.test(refusal(manage(OWNER, mid(OWNER), 'set_role', 'member')) ?? '')
    && /BUILDER_MEMBER_SELF_MANAGEMENT/.test(refusal(manage(ADMIN, mid(ADMIN), 'suspend')) ?? ''));

// --- The last owner ------------------------------------------------------------
sql(`INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
     VALUES (${lit(OWNER2)}, ${lit(ORG_A)}, 'owner', true, 'active')`);
check('with two owners, an owner may demote the other', sql(manage(OWNER, mid(OWNER2), 'set_role', 'administrator')) === 'administrator:active');
check('the last owner cannot be demoted, suspended or removed (by another owner there is none; by an admin never)',
  /BUILDER_OWNER_ONLY/.test(refusal(manage(OWNER2, mid(OWNER), 'remove')) ?? ''));
sql(`UPDATE public.builder_organisation_memberships SET membership_role = 'owner' WHERE id = ${lit(mid(OWNER2))}`);
// Owen's account is no longer active: Olive is then the only VALID owner.
sql(`UPDATE public.builder_portal_users SET is_active = false, status = 'suspended' WHERE id = ${lit(OWNER)}`);
for (const action of ['suspend', 'remove']) {
  check(`an owner whose own account is inactive cannot act (${action} refused; one valid owner remains)`,
    /BUILDER_NOT_ORG_ADMIN/.test(refusal(manage(OWNER, mid(OWNER2), action)) ?? '')
      && sql(`SELECT count(*) FROM public.builder_organisation_memberships m JOIN public.builder_portal_users u ON u.id = m.builder_user_id
              WHERE m.organisation_id = ${lit(ORG_A)} AND m.membership_role = 'owner' AND m.status = 'active' AND u.is_active`) === '1');
}
sql(`UPDATE public.builder_portal_users SET is_active = true, status = 'active' WHERE id = ${lit(OWNER)}`);
// Olive (owner) tries to demote Owen while Owen is the only OTHER owner: allowed once, then refused.
sql(`UPDATE public.builder_organisation_memberships SET status = 'suspended' WHERE id = ${lit(mid(OWNER2))}`);
check('a suspended owner cannot act on the organisation\'s active owner',
  /BUILDER_NOT_ORG_ADMIN/.test(refusal(manage(OWNER2, mid(OWNER), 'set_role', 'member')) ?? ''));
check('the last active owner cannot be demoted by a suspended co-owner, and stays owner', state(OWNER) === 'owner:active:false');
sql(`UPDATE public.builder_organisation_memberships SET status = 'active' WHERE id = ${lit(mid(OWNER2))}`);

// Two owners removing each other at the same moment: exactly one may win.
const [r1, r2] = await Promise.all([
  sqlAsync(manage(OWNER, mid(OWNER2), 'remove')),
  sqlAsync(manage(OWNER2, mid(OWNER), 'remove')),
]);
const owners = sql(`SELECT count(*) FROM public.builder_organisation_memberships
  WHERE organisation_id = ${lit(ORG_A)} AND membership_role = 'owner' AND status = 'active' AND revoked_at IS NULL`);
check('two owners removing each other at once leave exactly one owner',
  owners === '1' && [r1, r2].filter((r) => r.startsWith('ERROR')).length === 1,
  `owners=${owners} results=${[r1, r2].map((r) => (r.startsWith('ERROR') ? (r.match(/BUILDER_\w+/)?.[0] ?? 'error') : 'ok')).join(',')}`);
const survivor = state(OWNER) === 'owner:active:false' ? OWNER : OWNER2;
const lastOwnerMid = mid(survivor);
sql(`INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
     VALUES (${lit(survivor === OWNER ? OWNER2 : OWNER)}, ${lit(ORG_A)}, 'administrator', false, 'active')
     ON CONFLICT DO NOTHING`);
const otherAdmin = survivor === OWNER ? OWNER2 : OWNER;
for (const [action, role] of [['set_role', 'administrator'], ['suspend', null], ['remove', null]]) {
  check(`the last owner cannot be ${action === 'set_role' ? 'demoted' : action + 'd'} by an administrator`,
    /BUILDER_OWNER_ONLY/.test(refusal(manage(otherAdmin, lastOwnerMid, action, role)) ?? ''));
}
check('the organisation still has its one active owner', state(survivor) === 'owner:active:false');

// --- Suspend, reactivate, remove -------------------------------------------------
const CONV = randomUUID();
sql(`
  INSERT INTO public.builder_conversations(id, scope_type, scope_id, organisation_id, subject)
  VALUES (${lit(CONV)}, 'project',
          (public.builder_upsert_project(NULL, 'system', NULL, NULL, '{"name":"Member check"}'::jsonb,
             NULL, ${lit(ORG_A)})).id, ${lit(ORG_A)}, 'History');
  INSERT INTO public.builder_messages(conversation_id, body, author_type, author_builder_user_id, author_display_name)
  VALUES (${lit(CONV)}, 'authored before suspension', 'builder_user', ${lit(MANAGER)}, 'Mia');`);
const authored = () => sql(`SELECT count(*) FROM public.builder_messages WHERE author_builder_user_id = ${lit(MANAGER)}`);
const authoredBefore = authored();
const managerSession = session(MANAGER);
check('a suspended member (only organisation) loses every session at once',
  sql(manage(survivor, mid(MANAGER), 'suspend')) === 'manager:suspended' && !sessionLive(managerSession));
check('a suspended member cannot be issued a new session',
  /BUILDER_SESSION_NOT_PERMITTED/.test(refusal(`SELECT public.builder_issue_session(${lit(MANAGER)}, ${lit('a'.repeat(64))}, now() + interval '1 hour', now() + interval '1 hour')`) ?? ''));
check('a suspended member resolves no permission', sql(`SELECT public.builder_resolve_permission(${lit(MANAGER)}, ${lit(ORG_A)}, 'inventory', 'view')`) === 'f');
check('suspending twice is refused', /BUILDER_MEMBER_NOT_ACTIVE/.test(refusal(manage(survivor, mid(MANAGER), 'suspend')) ?? ''));
check('reactivating restores access', sql(manage(survivor, mid(MANAGER), 'reactivate')) === 'manager:active'
  && sql(`SELECT public.builder_resolve_permission(${lit(MANAGER)}, ${lit(ORG_A)}, 'inventory', 'view')`) === 't');
check('reactivating an active member is refused', /BUILDER_MEMBER_NOT_SUSPENDED/.test(refusal(manage(survivor, mid(MANAGER), 'reactivate')) ?? ''));

const twoOrgSession = session(TWO_ORGS);
check('suspending a member of two organisations keeps their other organisation (session stays)',
  sql(manage(survivor, mid(TWO_ORGS), 'suspend')) === 'member:suspended' && sessionLive(twoOrgSession)
    && sql(`SELECT count(*) FROM public.builder_accessible_organisations(${lit(TWO_ORGS)})`) === '1');

const managerMid = mid(MANAGER);
check('removal revokes the membership (the existing revoked state)',
  sql(manage(survivor, managerMid, 'remove')).endsWith(':revoked') && state(MANAGER).endsWith(':true'));
check('a removed membership cannot be managed again (reads as absent)',
  /BUILDER_MEMBERSHIP_NOT_FOUND/.test(refusal(manage(survivor, managerMid, 'reactivate')) ?? ''));
check('authorship and history are untouched by suspension and removal', authored() === authoredBefore && authoredBefore === '1',
  `messages by the member ${authoredBefore} → ${authored()}`);

// --- Grants ----------------------------------------------------------------------------
check('only service_role may call it',
  sql(`SELECT has_function_privilege('authenticated', 'public.builder_org_manage_membership(uuid,uuid,uuid,text,text,text)', 'EXECUTE')`) === 'f'
    && sql(`SELECT has_function_privilege('anon', 'public.builder_org_manage_membership(uuid,uuid,uuid,text,text,text)', 'EXECUTE')`) === 'f'
    && sql(`SELECT has_function_privilege('service_role', 'public.builder_org_manage_membership(uuid,uuid,uuid,text,text,text)', 'EXECUTE')`) === 't');

console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
