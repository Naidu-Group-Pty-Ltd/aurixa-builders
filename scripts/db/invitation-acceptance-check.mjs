#!/usr/bin/env node
/**
 * An invitation waits for its invitee — proved against a database rebuilt from
 * this repository's migrations, the same way the other checks here are (doc 68).
 *
 * `20260929090000_an_invitation_waits_for_its_invitee.sql` must:
 *   * change no existing row: every membership and account reads the same
 *     after it as before it, and no account is recorded as having set its
 *     password through a link only its mailbox held;
 *   * replace what an earlier draft of it defined, so no function is left
 *     with two signatures;
 *   * let a seat carry its own invitation — a token that is unique, only ever
 *     on a waiting, live seat, records what it was minted for and whether its
 *     link was handed to the inviter, and is destroyed by whatever moves the
 *     seat out of waiting (acceptance, suspension, removal), while a role
 *     change leaves it;
 *   * bound the name an inviter types to the registration door's 200
 *     characters, and refuse an empty one;
 *   * reserve send slots one at a time under a lock, spaced as asked — also
 *     when many isolates ask at once — and refuse a reservation past the
 *     longest wait rather than queueing without end, or past one scope's own
 *     ceiling on waiting sends, while another scope still gets its slot — and
 *     stamp that scope, so its own administrators can be told;
 *   * hold one deployment-wide delivery reading, claimed by one checker at a
 *     time and only once it is stale, which says a scope's sends were held
 *     back only to that scope, and only for a while;
 *   * all of it callable and readable by service_role only, sequences
 *     included — asked with Supabase's own default privileges in force, which
 *     grant anon and authenticated everything new in `public` unless a
 *     migration revokes it.
 *
 * Environment: LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432),
 * LOCAL_PG_USER (postgres), INVITATION_ACCEPTANCE_DB.
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
const DB = process.env.INVITATION_ACCEPTANCE_DB || 'aurixa_builders_invitation_acceptance_check';
const MIGRATION = '20260929090000_an_invitation_waits_for_its_invitee.sql';
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
function finish() {
  console.log(`\n${checks - failures} of ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
// What Supabase grants on anything new in `public` (anon and authenticated
// included), so a migration that forgets a REVOKE is caught here as it would be
// in production — the bootstrap other checks share does not emulate it.
psql(['-d', DB, '-q', '-c', `
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`]);
const migrations = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort();
check(`${MIGRATION} exists`, migrations.includes(MIGRATION));
if (!migrations.includes(MIGRATION)) finish();
// Everything before it runs first, so the rows seeded below predate it;
// anything after it runs once it has been checked.
const before = migrations.slice(0, migrations.indexOf(MIGRATION));
const later = migrations.slice(migrations.indexOf(MIGRATION) + 1);
for (const file of before) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}

// --- Rows that exist before the migration ------------------------------------------
const ORG_A = randomUUID(); const ORG_B = randomUUID();
const OWNER = randomUUID(); const ESTABLISHED = randomUUID(); const PENDING = randomUUID(); const SUSPENDED = randomUUID();
sql(`
  INSERT INTO public.builder_organisations(id, legal_name, org_type, status, is_active, activated_at)
  VALUES (${lit(ORG_A)}, 'Invitation Check A', 'builder', 'active', true, now()),
         (${lit(ORG_B)}, 'Invitation Check B', 'builder', 'active', true, now());
  DELETE FROM public.builder_network_outbox;
  DELETE FROM public.workspace_connection_events;
  DELETE FROM public.workspace_connections;
  INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password, password_hash)
  VALUES (${lit(OWNER)}, 'owen@invitation-check.example', 'Owen', 'active', true, now(), false, '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'),
         (${lit(ESTABLISHED)}, 'eddie@invitation-check.example', 'Eddie', 'active', true, now(), false, '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'),
         (${lit(PENDING)}, 'penny@invitation-check.example', 'Penny', 'invited', false, NULL, false, NULL),
         (${lit(SUSPENDED)}, 'sue@invitation-check.example', 'Sue', 'active', true, now(), false, '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.');
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (${lit(OWNER)}, ${lit(ORG_A)}, 'owner', true, 'active'),
         (${lit(ESTABLISHED)}, ${lit(ORG_B)}, 'member', true, 'active'),
         (${lit(PENDING)}, ${lit(ORG_B)}, 'member', false, 'invited'),
         (${lit(SUSPENDED)}, ${lit(ORG_A)}, 'member', true, 'suspended');`);
const snapshot = () => sql(`
  SELECT string_agg(row_text, E'\\n' ORDER BY row_text) FROM (
    SELECT concat_ws('|', m.id, m.builder_user_id, m.organisation_id, m.membership_role, m.status,
                     m.is_primary, m.revoked_at, m.updated_at) AS row_text
      FROM public.builder_organisation_memberships m
    UNION ALL
    SELECT concat_ws('|', u.id, u.email, u.name, u.status, u.is_active, u.password_hash,
                     u.invite_token_hash, u.invite_accepted_at, u.updated_at)
      FROM public.builder_portal_users u) rows`);
const beforeMigration = snapshot();

// What an earlier draft of the migration defined, as a database that ran it
// would still hold: the reading with no arguments and the two-argument pacer.
sql(`
  CREATE FUNCTION public.builder_email_delivery_reading()
  RETURNS TABLE (state text, checked_at timestamptz, backlog_ms integer)
  LANGUAGE sql AS $fn$ SELECT NULL::text, NULL::timestamptz, 0 $fn$;
  CREATE FUNCTION public.builder_reserve_email_send_slot(integer, integer)
  RETURNS integer LANGUAGE sql AS $fn$ SELECT 0 $fn$;`);

psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', MIGRATION)]);
check('the migration applies over the migrations before it', true);
check('it changes no existing membership or account', snapshot() === beforeMigration);
check('it leaves every existing seat without a token, a kind, a holder or a typed name',
  sql(`SELECT count(*) FROM public.builder_organisation_memberships
       WHERE invite_token_hash IS NOT NULL OR invite_token_expires_at IS NOT NULL
          OR invite_requires_password IS NOT NULL OR invite_link_handed IS NOT NULL
          OR invited_name IS NOT NULL`) === '0');
check('it records no account as having set its password through a mailbox-only link',
  sql(`SELECT count(*) FROM public.builder_portal_users WHERE password_set_by_mailbox_link_at IS NOT NULL`) === '0');
check('it replaces an earlier draft\'s functions — one reading, one pacer, and a call with no arguments is not ambiguous',
  sql(`SELECT count(*) FROM pg_proc WHERE proname = 'builder_email_delivery_reading'
         AND pronamespace = 'public'::regnamespace`) === '1'
    && sql(`SELECT count(*) FROM pg_proc WHERE proname = 'builder_reserve_email_send_slot'
              AND pronamespace = 'public'::regnamespace`) === '1'
    && refusal(`SELECT * FROM public.builder_email_delivery_reading()`) === null);
check('it is re-runnable', (() => {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', MIGRATION)]);
  return snapshot() === beforeMigration;
})());
for (const file of later) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}

// --- A seat carries its own invitation ---------------------------------------------
const hash = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const seat = (user, org) => sql(`SELECT id FROM public.builder_organisation_memberships
  WHERE builder_user_id = ${lit(user)} AND organisation_id = ${lit(org)} AND revoked_at IS NULL`);
const tokenOf = (id) => sql(`SELECT coalesce(invite_token_hash, '') || '|' || coalesce(invite_token_expires_at::text, '')
  || coalesce(invite_requires_password::text, '') || coalesce(invite_link_handed::text, '')
  FROM public.builder_organisation_memberships WHERE id = ${lit(id)}`);
const invite = (user, org, token, name = 'Typed Name', requiresPassword = false, handed = false) => `
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status,
    invited_name, invite_token_hash, invite_token_expires_at, invite_requires_password, invite_link_handed, granted_by)
  VALUES (${lit(user)}, ${lit(org)}, 'member', false, 'invited', ${lit(name)}, ${lit(token)}, now() + interval '72 hours',
          ${requiresPassword}, ${handed}, ${lit(OWNER)})
  RETURNING id`;

const t1 = hash();
const established = sql(invite(ESTABLISHED, ORG_A, t1, 'Eddie as A typed it'));
check('an established account can be given a WAITING seat with its own token', tokenOf(established).startsWith(`${t1}|`));
check('the account behind it is untouched by the invitation',
  sql(`SELECT status || ':' || is_active FROM public.builder_portal_users WHERE id = ${lit(ESTABLISHED)}`) === 'active:true');
// B's own invitation of Penny, re-sent under the new rule: its token is on B's seat.
const tB = hash();
sql(`UPDATE public.builder_organisation_memberships
        SET invite_token_hash = ${lit(tB)}, invite_token_expires_at = now() + interval '72 hours',
            invite_requires_password = true, invite_link_handed = true
      WHERE id = ${lit(seat(PENDING, ORG_B))}`);
const t2 = hash();
const pendingInA = sql(invite(PENDING, ORG_A, t2, 'Typed Name', true));
check('a second organisation\'s invitation of a pending invitee leaves the first organisation\'s token standing',
  tokenOf(pendingInA).startsWith(`${t2}|`) && tokenOf(seat(PENDING, ORG_B)).startsWith(`${tB}|`));
check('two seats can never hold the same token',
  /duplicate key|unique/i.test(refusal(`UPDATE public.builder_organisation_memberships SET invite_token_hash = ${lit(t1)},
    invite_token_expires_at = now() + interval '1 hour' WHERE id = ${lit(seat(PENDING, ORG_B))}`) ?? ''));
check('a token is refused on a seat that is not waiting',
  /builder_memberships_token_on_waiting_seat/.test(refusal(`UPDATE public.builder_organisation_memberships
    SET invite_token_hash = ${lit(hash())}, invite_token_expires_at = now() + interval '1 hour'
    WHERE id = ${lit(seat(OWNER, ORG_A))}`) ?? ''));
check('a token that is not a peppered hash (a plaintext link) is refused',
  /builder_memberships_invite_token_hash_check/.test(refusal(`UPDATE public.builder_organisation_memberships
    SET invite_token_hash = ${lit(`${randomUUID()}-${randomUUID()}`)}, invite_token_expires_at = now() + interval '1 hour'
    WHERE id = ${lit(seat(PENDING, ORG_B))}`) ?? ''));
check('a token is refused without a record of what it was minted for',
  /builder_memberships_token_on_waiting_seat/.test(refusal(`UPDATE public.builder_organisation_memberships
    SET invite_requires_password = NULL WHERE id = ${lit(seat(PENDING, ORG_B))}`) ?? ''));
check('a token is refused without a record of whether its link was handed to the inviter',
  /builder_memberships_token_on_waiting_seat/.test(refusal(`UPDATE public.builder_organisation_memberships
    SET invite_link_handed = NULL WHERE id = ${lit(seat(PENDING, ORG_B))}`) ?? ''));
check('a token is refused without an expiry',
  /builder_memberships_token_on_waiting_seat/.test(refusal(`UPDATE public.builder_organisation_memberships
    SET invite_token_hash = ${lit(hash())}, invite_token_expires_at = NULL WHERE id = ${lit(seat(PENDING, ORG_B))}`) ?? ''));
check('a role change leaves the invitation standing',
  (() => {
    sql(`SELECT public.builder_org_manage_membership(${lit(OWNER)}, ${lit(ORG_A)}, ${lit(established)}, 'set_role', 'manager', 'check')`);
    return tokenOf(established).startsWith(`${t1}|`);
  })());
check('acceptance — the seat brought up — destroys its token in the same statement',
  (() => {
    const failed = refusal(`UPDATE public.builder_organisation_memberships SET status = 'active'
         WHERE id = ${lit(established)} AND invite_token_hash = ${lit(t1)} AND status = 'invited'`);
    return failed === null && tokenOf(established) === '|'
      && sql(`SELECT status FROM public.builder_organisation_memberships WHERE id = ${lit(established)}`) === 'active';
  })());
check('the same token cannot bring anything up twice',
  sql(`WITH hit AS (UPDATE public.builder_organisation_memberships SET status = 'active'
       WHERE invite_token_hash = ${lit(t1)} AND status = 'invited' RETURNING 1) SELECT count(*) FROM hit`) === '0');
check('cancelling a waiting seat through member management destroys its token with it',
  (() => {
    const failed = refusal(`SELECT public.builder_org_manage_membership(${lit(OWNER)}, ${lit(ORG_A)}, ${lit(pendingInA)}, 'remove', NULL, 'check')`);
    return failed === null && tokenOf(pendingInA) === '|'
      && sql(`SELECT status || ':' || (revoked_at IS NOT NULL) FROM public.builder_organisation_memberships
              WHERE id = ${lit(pendingInA)}`) === 'revoked:true';
  })());
const t3 = hash();
const suspendMe = sql(invite(SUSPENDED, ORG_B, t3));
check('a seat moved to suspended loses its token',
  (() => {
    const failed = refusal(`UPDATE public.builder_organisation_memberships SET status = 'suspended' WHERE id = ${lit(suspendMe)}`);
    return failed === null && tokenOf(suspendMe) === '|';
  })());

// --- The name an inviter types ----------------------------------------------------------
const NEW = randomUUID();
sql(`INSERT INTO public.builder_portal_users(id, email, name, status, is_active) VALUES
     (${lit(NEW)}, 'nina@invitation-check.example', 'Nina', 'invited', false)`);
check('a typed name of 200 characters is kept',
  refusal(`${invite(NEW, ORG_A, hash(), 'x'.repeat(200))}`) === null);
sql(`DELETE FROM public.builder_organisation_memberships WHERE builder_user_id = ${lit(NEW)}`);
check('a typed name of 201 characters is refused',
  /builder_memberships_invited_name_length/.test(refusal(invite(NEW, ORG_A, hash(), 'x'.repeat(201))) ?? ''));
check('an empty typed name is refused',
  /builder_memberships_invited_name_length/.test(refusal(invite(NEW, ORG_A, hash(), '')) ?? ''));

// --- Send slots ----------------------------------------------------------------------------
const reserve = (spacing, maxWait, scope = null, scopeMax = null) =>
  `SELECT public.builder_reserve_email_send_slot(${spacing}, ${maxWait}, ${lit(scope)}, ${scopeMax === null ? 'NULL' : scopeMax})`;
const waits = [0, 1, 2].map(() => Number(sql(reserve(1000, 90000))));
check('sequential reservations are spaced as asked (0, ~1 s, ~2 s)',
  waits[0] <= 50 && waits[1] >= 900 && waits[1] <= 1050 && waits[2] >= 1900 && waits[2] <= 2050,
  `waits=${waits.join(',')}`);
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now()`);
const concurrent = (await Promise.all(Array.from({ length: 8 }, () => sqlAsync(reserve(1000, 90000)))))
  .map((r) => (r.startsWith('ERROR') ? NaN : Number(r))).sort((a, b) => a - b);
const gaps = concurrent.slice(1).map((w, i) => w - concurrent[i]);
check('eight isolates reserving at once get eight distinct slots, each at least ~1 s apart',
  concurrent.every(Number.isFinite) && gaps.every((g) => g >= 900),
  `waits=${concurrent.join(',')}`);
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now()`);
const bounded = [0, 1, 2, 3, 4].map(() => sql(reserve(1000, 2500)));
check('a reservation past the longest wait is refused (null), not queued without end',
  bounded.slice(0, 3).every((w) => w !== '') && bounded.slice(3).every((w) => w === ''),
  `waits=${bounded.map((w) => w || 'null').join(',')}`);
check('a refused reservation does not move the queue',
  Number(sql(`SELECT extract(epoch FROM (next_slot_at - now())) * 1000 FROM public.builder_email_send_pacing`)) <= 3100);
for (const [spacing, maxWait] of [[0, 1000], [-5, 1000], [1000, -1], [120000, 1000], [1000, 900000]]) {
  check(`nonsense pacing (${spacing}, ${maxWait}) is refused`,
    /BUILDER_EMAIL_PACING_INVALID/.test(refusal(reserve(spacing, maxWait)) ?? ''));
}
for (const [scope, scopeMax] of [['org:A', null], ['org:A', 0], ['ORG A; drop', 3], [null, 3]]) {
  check(`a nonsense scope (${scope}, ${scopeMax}) is refused`,
    /BUILDER_EMAIL_PACING_INVALID/.test(refusal(reserve(1000, 90000, scope, scopeMax)) ?? ''));
}
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now()`);
// A send whose slot has arrived is not waiting, so a ceiling of three admits the
// one going now and three behind it.
const scoped = [0, 1, 2, 3, 4].map(() => sql(reserve(1000, 90000, 'org:burst', 3)));
const other = sql(reserve(1000, 90000, 'org:other', 3));
check('one scope may hold only its own ceiling of waiting sends; another scope still gets its slot',
  scoped.slice(0, 4).every((w) => w !== '') && scoped[4] === '' && other !== '',
  `burst=${scoped.map((w) => w || 'null').join(',')} other=${other || 'null'}`);
check('a refused reservation does not move the queue for anybody else',
  // Behind four slots (~4 s less the time the reservations themselves took),
  // never behind five: the refused fifth reserved nothing.
  Number(other) >= 3500 && Number(other) <= 4100, `other waits ${other} ms, behind the burst's four`);
const stamped = (scope) => sql(`SELECT count(*) FROM public.builder_email_send_scope_refusals WHERE scope = ${lit(scope)}`);
check('a scope refused its share is stamped, and a scope that was not refused is not',
  stamped('org:burst') === '1' && stamped('org:other') === '0');
// A full queue refuses a scoped send too, and that is also the scope's to know.
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now() + interval '100 seconds'`);
const late = sql(reserve(1000, 90000, 'org:late', 3));
check('a scoped send refused because the whole queue is full stamps its scope as well',
  late === '' && stamped('org:late') === '1', `late=${late || 'null'}`);
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now()`);

// --- The delivery reading -------------------------------------------------------------------
const claim = () => sql(`SELECT public.builder_claim_email_delivery_check(1800, 120)`);
check('the first checker claims the check', claim() === 't');
check('a second checker does not, while the first holds it', claim() === 'f');
sql(`SELECT public.builder_record_email_delivery_check('operational')`);
const reading = sql(`SELECT state || ':' || (checked_at IS NOT NULL) || ':' || (backlog_ms >= 0)
  FROM public.builder_email_delivery_reading()`);
check('a recorded check is what the reading says', reading === 'operational:true:true', reading);
check('a fresh reading is not claimed again', claim() === 'f');
sql(`UPDATE public.builder_email_delivery_health SET checked_at = now() - interval '31 minutes'`);
check('a stale reading is claimed again', claim() === 't');
check('only the two states a check can find may be recorded',
  /BUILDER_EMAIL_DELIVERY_STATE_INVALID/.test(refusal(`SELECT public.builder_record_email_delivery_check('fine')`) ?? ''));
sql(`UPDATE public.builder_email_send_pacing SET next_slot_at = now() + interval '45 seconds'`);
check('the reading reports the queue as one number for the whole deployment',
  Number(sql(`SELECT backlog_ms FROM public.builder_email_delivery_reading()`)) >= 40000);
const heldBack = (scope, windowSeconds = 900) => sql(`SELECT scope_held_back
  FROM public.builder_email_delivery_reading(${lit(scope)}, ${windowSeconds})`);
check('a scope whose sends were held back reads so; another scope, and no scope, do not',
  heldBack('org:burst') === 't' && heldBack('org:other') === 'f' && heldBack(null) === 'f'
    && sql(`SELECT scope_held_back FROM public.builder_email_delivery_reading()`) === 'f');
sql(`UPDATE public.builder_email_send_scope_refusals SET refused_at = now() - interval '16 minutes' WHERE scope = 'org:burst'`);
check('and only for a while — a refusal older than the window no longer reads as held back',
  heldBack('org:burst') === 'f');

// --- Nobody but service_role -----------------------------------------------------------------
const fns = [
  'public.builder_reserve_email_send_slot(integer,integer,text,integer)',
  'public.builder_claim_email_delivery_check(integer,integer)',
  'public.builder_record_email_delivery_check(text)',
  'public.builder_email_delivery_reading(text,integer)',
];
for (const fn of fns) {
  check(`${fn.replace(/\(.*$/, '')} is callable by service_role only`,
    sql(`SELECT has_function_privilege('service_role', ${lit(fn)}, 'EXECUTE')`) === 't'
      && sql(`SELECT has_function_privilege('anon', ${lit(fn)}, 'EXECUTE')`) === 'f'
      && sql(`SELECT has_function_privilege('authenticated', ${lit(fn)}, 'EXECUTE')`) === 'f');
}
const tables = ['public.builder_email_send_pacing', 'public.builder_email_delivery_health',
  'public.builder_email_send_reservations', 'public.builder_email_send_scope_refusals'];
for (const table of tables) {
  check(`${table} is unreadable to anon and authenticated, and RLS is on`,
    sql(`SELECT has_table_privilege('anon', ${lit(table)}, 'SELECT')`) === 'f'
      && sql(`SELECT has_table_privilege('authenticated', ${lit(table)}, 'SELECT')`) === 'f'
      && sql(`SELECT relrowsecurity FROM pg_class WHERE oid = ${lit(table)}::regclass`) === 't');
}
// A sequence is a new object like any other, and an identity column makes one.
const sequences = sql(`SELECT string_agg(DISTINCT c.oid::regclass::text, ',')
  FROM pg_class c JOIN pg_depend d ON d.objid = c.oid
 WHERE c.relkind = 'S' AND d.refobjid IN (${tables.map((t) => `${lit(t)}::regclass`).join(', ')})`);
check('the sequences behind those tables are closed to anon and authenticated', (() => {
  const names = sequences ? sequences.split(',') : [];
  return names.length > 0 && names.every((seq) => ['anon', 'authenticated'].every((role) =>
    ['USAGE', 'SELECT', 'UPDATE'].every((privilege) =>
      sql(`SELECT has_sequence_privilege(${lit(role)}, ${lit(seq)}, ${lit(privilege)})`) === 'f')));
})(), `sequences=${sequences || 'none'}`);

finish();
