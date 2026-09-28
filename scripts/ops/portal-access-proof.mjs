#!/usr/bin/env node
/**
 * ===========================================================================
 * A BRAND-NEW BUILDER ORGANISATION, FROM NOTHING — PROVED ON THE LIVE PORTAL.
 * ===========================================================================
 *
 * The other proofs start from an organisation that is already governed and
 * signed in. This one starts from empty rows and walks what a new customer
 * walks, over the deployed portal, through the same-origin proxy a browser
 * uses:
 *
 *   A. three fresh organisations (A, B, C). Each owner row is what Mission
 *      Control's `create_organisation` + `invite_organisation_owner` produce;
 *      that operator plane needs an RS256 federation assertion this workflow
 *      cannot mint, so the rows are seeded exactly as the smoke test seeds
 *      them. Everything after that is the real portal: terms, onboarding,
 *      the empty surfaces a new organisation sees.
 *   B. an invitation for every invitable role, accepted through the real
 *      accept-invite door (the invite token replayed with the deploy's own
 *      pepper), each member governed through terms and onboarding;
 *   C. sessions: the 12 h absolute / 240 min idle windows as issued, the idle
 *      window sliding and never past the absolute cap, idle expiry, absolute
 *      expiry, logout, a deactivated user, a revoked membership, a suspended
 *      organisation (and its reinstatement), a password change and a password
 *      reset each revoking what came before;
 *   D. the role matrix — for every role, what the portal ANSWERS compared with
 *      what the database's own resolvers DECIDE, over stock, projects,
 *      project messages, invitations and organisation settings;
 *   E. a project and its conversation: participants read and post, read_only
 *      reads and cannot post, an outsider organisation reaches nothing;
 *   F. notifications: a task assignment notifies its assignee, only them,
 *      only in their organisation; another organisation cannot mark it read;
 *   G. multi-tenant isolation: another organisation's project, conversation,
 *      notification and organisation id are all refused, and a user in two
 *      organisations is refused a write filed under the wrong one.
 *   J. an invitation answers the same bytes whatever the address already is —
 *      new, pending elsewhere, already signed in, revoked — and so do a second
 *      invitation of each and a resend of each seat, while the server handles
 *      the four differently underneath;
 *   K. the invitation ceiling: counted once per person and per organisation,
 *      a burst refused past the person's ceiling with the shared 429, a
 *      refused request leaving nothing behind, the organisation's ceiling
 *      holding for a second administrator, and another organisation untouched.
 *
 * Every organisation, user, session, project, conversation, task and
 * notification it creates is deleted before it exits and counted to zero.
 * The append-only activity log and the security log keep their entries by
 * design — that is retained evidence, not residue.
 *
 * Runs from the production-rollout workflow (phase `portal-access-proof`).
 * No secret, token or password is ever printed.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = randomBytes(4).toString('hex');
const MARK = 'smoke-rollout';
const TAG = 'access';
const ORG_PREFIX = `Smoke Rollout ${TAG} ${RUN}`;
const EMAIL_PREFIX = `${MARK}-${TAG}-${RUN}-`;
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const IDLE_MINUTES = 240;
const ABSOLUTE_HOURS = 12;

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }
if (!PEPPER) { console.error('NETWORK_SESSION_PEPPER is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, detail, required });
  console.log(`  ${ok ? 'PASS' : required ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function q(label, sql, ref = PROJECT_REF) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 400)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}

const latency = {};
/**
 * Call a portal function through the same-origin proxy, as the browser does —
 * or, with `direct`, at the function itself, for the one thing the proxy does
 * not carry back (it forwards only content-type and set-cookie).
 */
async function call(fn, body, cookie = null, { direct = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-portal-request': 'builder-portal',
    Origin: ORIGIN,
  };
  if (cookie) headers.Cookie = cookie;
  const started = Date.now();
  const url = direct ? `https://${PROJECT_REF}.supabase.co/functions/v1/${fn}` : `${ORIGIN}/fn/${fn}`;
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  const ms = Date.now() - started;
  (latency[fn + ':' + (body?.operation ?? body?.action ?? '')] ??= []).push(ms);
  return {
    status: response.status, json, ms, text,
    retryAfter: response.headers.get('retry-after'),
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}

const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const id = (value) => `${sqlLit(value)}::uuid`;
const cookieFrom = (setCookies) => (setCookies ?? [])
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('__Host-builder_session_token=')) ?? null;
const tokenOf = (cookie) => cookie.slice('__Host-builder_session_token='.length);
const refused = (status) => status === 401 || status === 403;
/**
 * A response body as it may be printed. On a deployment with no mail provider
 * an invitation's answer carries a live one-time link, and this proof prints no
 * token (header) — so a link is never printed, whatever the deployment.
 */
const shown = (text) => String(text ?? '').replace(/"invite_url"\s*:\s*"[^"]*"/g, '"invite_url":"[redacted]"');

const cc = (label, sql) => q(`cc ${label}`, sql, CC_REF);

// ------------------------------------------------------------------ cleanup
/**
 * NEVER CONNECTED TO A REAL WORKSPACE. Since 20260921060000 an ACTIVE builder
 * organisation is provisioned onto every registered workspace the moment it
 * is inserted and announces itself with `connection.authorised`; so the
 * connections and everything queued on them go in the SAME transaction as the
 * insert (`stock-import-proof.mjs`' rule), and again at cleanup.
 */
function detachFromNetwork(orgIdsSql) {
  const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql})`;
  return `
    DELETE FROM public.builder_network_outbox
     WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text
                            FROM public.workspace_connections c
                           WHERE c.builder_organisation_id IN (${orgIdsSql}));
    DELETE FROM public.workspace_connection_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connections});
    DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgIdsSql});`;
}
const ORGS_SQL = `SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`;

/**
 * The invitation ceiling's buckets for this run's own people and organisations
 * (`binv_user:<id>`, `binv_org:<id>`). Named by id, so it can only ever reach
 * a bucket belonging to an account or organisation this proof created.
 */
const LIMITER_KEYS_SQL = `
  SELECT 'binv_user:' || id::text FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}
  UNION ALL
  SELECT 'binv_org:' || id::text FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`;
let limiterKeysAtCleanup = [];

async function cleanup(stage) {
  const orgIds = (await q(`cleanup (${stage}) organisations`, ORGS_SQL)).map((r) => r.id);
  limiterKeysAtCleanup = (await q(`cleanup (${stage}) limiter keys`, `SELECT k FROM (${LIMITER_KEYS_SQL}) AS keys(k)`))
    .map((r) => r.k);
  await q(`cleanup (${stage})`, `
    DO $$
    BEGIN
      DELETE FROM public.auth_rate_limits WHERE bucket_key IN (${LIMITER_KEYS_SQL});
      ${detachFromNetwork(ORGS_SQL)}
      ALTER TABLE public.builder_project_status_history
        DISABLE TRIGGER trg_builder_project_status_history_append_only;
      -- Messages are immutable BY TRIGGER for real conversations; these are this
      -- run's own synthetic rows, so the trigger steps aside for this statement
      -- inside this transaction only (the status-history rule, verbatim).
      ALTER TABLE public.builder_messages DISABLE TRIGGER trg_builder_messages_immutable;
      DELETE FROM public.builder_conversations WHERE organisation_id IN (${ORGS_SQL});
      ALTER TABLE public.builder_messages ENABLE TRIGGER trg_builder_messages_immutable;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN
        (SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)});
      ALTER TABLE public.builder_project_status_history
        ENABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
      DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};
    END $$;`);
  // Defence in depth: nothing of this proof should ever reach a Command
  // Centre, but if a connection existed for even a moment, its mirror goes too.
  const orgList = orgIds.length ? orgIds.map(id).join(', ') : 'NULL::uuid';
  const connList = `SELECT c.id FROM public.builder_network_connections c
     WHERE c.builder_org_label LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)} OR c.builder_organisation_id IN (${orgList})`;
  await cc(`cleanup (${stage})`, `
    SET LOCAL lock_timeout = '5s';
    DELETE FROM public.builder_network_stock_items WHERE organisation_id IN (${orgList});
    DELETE FROM public.builder_network_stock_organisations WHERE id IN (${orgList})
       OR legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connList});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connList});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connList});
    DELETE FROM public.builder_network_connections WHERE id IN (${connList});`);
}

async function residue() {
  const rows = await q('residue', `
    SELECT
      (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS orgs,
      (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users,
      (SELECT count(*) FROM public.builder_projects WHERE name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS projects,
      (SELECT count(*) FROM public.builder_conversations c WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_organisations o WHERE o.id = c.organisation_id)) AS orphan_conversations,
      (SELECT count(*) FROM public.builder_tasks t WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_organisations o WHERE o.id = t.organisation_id)) AS orphan_tasks,
      (SELECT count(*) FROM public.builder_notifications n WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_portal_users u WHERE u.id = n.builder_user_id)) AS orphan_notifications,
      (SELECT count(*) FROM public.builder_portal_sessions s WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_portal_users u WHERE u.id = s.builder_user_id)) AS orphan_sessions,
      (SELECT count(*) FROM public.builder_project_access a WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_projects p WHERE p.id = a.project_id)) AS orphan_project_access,
      (SELECT count(*) FROM public.workspace_connections c WHERE NOT EXISTS
         (SELECT 1 FROM public.builder_organisations o WHERE o.id = c.builder_organisation_id)) AS orphan_connections,
      (SELECT count(*) FROM public.auth_rate_limits
         WHERE bucket_key = ANY(ARRAY[${limiterKeysAtCleanup.map(sqlLit).join(', ') || "''"}]::text[])) AS limiter_buckets`);
  const ccRows = await cc('residue', `
    SELECT
      (SELECT count(*) FROM public.builder_network_connections WHERE builder_org_label LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS cc_connections,
      (SELECT count(*) FROM public.builder_network_stock_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS cc_organisations`);
  return { ...(rows[0] ?? {}), ...(ccRows[0] ?? {}) };
}

// ------------------------------------------------------------------ seeding
/** The rows Mission Control's create_organisation + invite_organisation_owner produce. */
async function seedOrganisation(letter) {
  const email = `${EMAIL_PREFIX}owner-${letter.toLowerCase()}@example.com`;
  const password = `Acc3ss!${RUN}!${letter}owner`;
  const rows = await q(`seed org ${letter}`, `
    WITH org AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES (${sqlLit(`${ORG_PREFIX} ${letter}`)}, 'builder', 'active', true, now())
      RETURNING id
    ), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(`Access Owner ${letter}`)}, 'active', true, now(), false,
              extensions.crypt(${sqlLit(password)}, extensions.gen_salt('bf', 10)))
      RETURNING id
    ), membership AS (
      INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
      SELECT person.id, org.id, 'owner', true, 'active' FROM person, org
      RETURNING id
    )
    SELECT count(*) FROM membership;
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(`${ORG_PREFIX} ${letter}`)}`)}
    SELECT u.id AS user_id, o.id AS org_id, m.id AS membership_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id)::int AS connections
      FROM public.builder_portal_users u
      JOIN public.builder_organisation_memberships m ON m.builder_user_id = u.id
      JOIN public.builder_organisations o ON o.id = m.organisation_id
     WHERE u.email = ${sqlLit(email)} AND o.legal_name = ${sqlLit(`${ORG_PREFIX} ${letter}`)}`);
  const row = rows[0];
  record(`A: organisation ${letter} is detached from every real workspace in the transaction that created it`,
    Number(row.connections) === 0, `connections=${row.connections}`);
  await q(`seed org ${letter} onboarding`, `SELECT public.builder_ensure_onboarding_steps(${id(row.user_id)})`);
  return { letter, email, password, userId: row.user_id, orgId: row.org_id, membershipId: row.membership_id, role: 'owner' };
}

/** A session whose hash the live runtime recognises — the same shape login issues. */
async function mintSession(userId, { hours = ABSOLUTE_HOURS, idleMinutes = IDLE_MINUTES } = {}) {
  const token = randomBytes(32).toString('hex');
  const rows = await q('mint session', `
    SELECT public.builder_issue_session(
      ${id(userId)}, ${sqlLit(hmacHex(PEPPER, token))},
      now() + make_interval(hours => ${hours}), now() + make_interval(mins => ${idleMinutes}),
      NULL, NULL, 'smoke-rollout access proof') AS session_id`);
  return { cookie: `__Host-builder_session_token=${token}`, sessionId: rows[0].session_id, token };
}

const sessionRow = async (cookie) => (await q('session row', `
  SELECT id, revoked_at IS NOT NULL AS revoked, revoked_reason,
         extract(epoch FROM (absolute_expires_at - created_at))/3600 AS absolute_hours,
         extract(epoch FROM (idle_expires_at - now()))/60 AS idle_minutes_left,
         idle_expires_at = absolute_expires_at AS idle_at_cap
  FROM public.builder_portal_sessions WHERE token_hash = ${sqlLit(hmacHex(PEPPER, tokenOf(cookie)))}`))[0] ?? null;

/** Terms and onboarding, through the real doors. */
async function govern(cookie) {
  const accept = await call('builder-portal-verify',
    { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
  const onboard = await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
  const verify = await call('builder-portal-verify', {}, cookie);
  return { accept, onboard, verify };
}

/** Invite through the real endpoint, then accept through the real door. */
async function inviteAndAccept(owner, ownerCookie, role, label) {
  const email = `${EMAIL_PREFIX}${label}@example.com`;
  const password = `Acc3ss!${RUN}!${label}`;
  const invite = await call('builder-portal-invite',
    { action: 'invite', email, name: `Access ${label}`, membership_role: role }, ownerCookie);
  const userRow = (await q('invited user', `
    SELECT u.id, m.id AS membership_id, m.membership_role
    FROM public.builder_portal_users u
    JOIN public.builder_organisation_memberships m ON m.builder_user_id = u.id
      AND m.organisation_id = ${id(owner.orgId)} AND m.revoked_at IS NULL
    WHERE u.email = ${sqlLit(email)}`))[0];
  if (invite.status !== 200 || !userRow) {
    return { invite, user: null };
  }
  const inviteToken = `${randomUUID()}-${randomUUID()}`;
  await q('mint invite token', `
    UPDATE public.builder_portal_users
       SET invite_token_hash = ${sqlLit(hmacHex(PEPPER, inviteToken))},
           invite_token_expires_at = now() + interval '1 hour',
           invite_token_organisation_id = ${id(owner.orgId)}
     WHERE id = ${id(userRow.id)}`);
  const accepted = await call('builder-portal-accept-invite',
    { action: 'accept', token: inviteToken, password });
  const cookie = cookieFrom(accepted.setCookies);
  return {
    invite, accepted,
    user: {
      label, role, email, password, userId: userRow.id, membershipId: userRow.membership_id,
      orgId: owner.orgId, cookie, storedRole: userRow.membership_role,
    },
  };
}

const requiredFailed = () => results.some((r) => r.required && !r.ok);

// ===========================================================================
console.log(`portal access proof run=${RUN} origin=${ORIGIN} project=${PROJECT_REF}`);
await cleanup('start');
let crashed = null;

try {
  // --- A. Fresh organisations -----------------------------------------------
  console.log('\nA. Fresh organisations, governed through the real portal');
  const A = await seedOrganisation('A');
  const B = await seedOrganisation('B');
  const C = await seedOrganisation('C');

  const loginA = await call('builder-portal-login', { email: A.email, password: A.password });
  const realLogin = cookieFrom(loginA.setCookies);
  record('A: login posture', true,
    realLogin ? 'real HTTP login issued the cookie'
      : `login answered ${loginA.status} (${loginA.json?.error ?? 'no body'}) — Turnstile blocks automation; sessions are pepper-minted`,
    { required: false });
  for (const owner of [A, B, C]) {
    owner.cookie = owner === A && realLogin ? realLogin : (await mintSession(owner.userId)).cookie;
  }

  const beforeGov = await call('builder-portal-workspace', { operation: 'workspace_summary' }, A.cookie);
  record('A: a new organisation is held at the governance gate before terms',
    beforeGov.status === 403 && beforeGov.json?.code === 'terms_acceptance_required',
    `status ${beforeGov.status} code=${beforeGov.json?.code}`);

  for (const owner of [A, B, C]) {
    const g = await govern(owner.cookie);
    record(`A: owner ${owner.letter} accepts terms, completes onboarding, reaches the dashboard`,
      g.accept.json?.success === true && g.onboard.json?.onboarding_complete === true
        && g.verify.status === 200 && g.verify.json?.governance === null,
      `accept=${g.accept.status} onboard=${g.onboard.status} governance=${String(g.verify.json?.governance)}`);
  }

  const freshSurfaces = [
    ['Dashboard', 'builder-portal-workspace', { operation: 'workspace_summary' }],
    ['Projects', 'builder-portal-projects', { operation: 'list_projects' }],
    ['Stock sources', 'builder-portal-stock', { operation: 'list_uploads' }],
    ['Stock properties', 'builder-portal-stock', { operation: 'list_stock' }],
    ['Agency Activations', 'builder-portal-stock', { operation: 'list_activated_properties' }],
    ['Agency conversations', 'builder-portal-stock', { operation: 'list_my_agency_conversations' }],
    ['Tasks', 'builder-portal-collaboration', { operation: 'my_tasks' }],
    ['Notifications', 'builder-portal-collaboration', { operation: 'list_notifications' }],
    ['Unread counts', 'builder-portal-collaboration', { operation: 'unread_counts' }],
    ['Activity', 'builder-portal-workspace', { operation: 'activity_history' }],
    ['Settings: organisation', 'builder-portal-workspace', { operation: 'get_organisation_settings' }],
    ['Settings: preferences', 'builder-portal-workspace', { operation: 'get_my_preferences' }],
    ['Settings: join requests', 'builder-portal-invite', { action: 'list_join_requests' }],
    ['Devices', 'builder-portal-verify', { action: 'list_sessions' }],
  ];
  for (const [label, fn, body] of freshSurfaces) {
    const r = await call(fn, body, B.cookie);
    record(`A: fresh organisation — ${label} answers without error`,
      r.status === 200 && !r.json?.error, `status ${r.status}${r.json?.error ? ` (${String(r.json.error).slice(0, 80)})` : ''}`);
  }
  const emptyStock = await call('builder-portal-stock', { operation: 'list_stock' }, B.cookie);
  const emptyActs = await call('builder-portal-stock', { operation: 'list_activated_properties' }, B.cookie);
  const emptyConvs = await call('builder-portal-stock', { operation: 'list_my_agency_conversations' }, B.cookie);
  const emptyProjects = await call('builder-portal-projects', { operation: 'list_projects' }, B.cookie);
  const lenOf = (r) => (r.json?.records ?? r.json?.properties ?? r.json?.conversations ?? r.json?.projects ?? []).length;
  record('A: a fresh organisation sees nothing that is not its own (empty stock, activations, chats, projects)',
    [emptyStock, emptyActs, emptyConvs, emptyProjects].every((r) => r.status === 200 && lenOf(r) === 0),
    `stock=${lenOf(emptyStock)} activations=${lenOf(emptyActs)} chats=${lenOf(emptyConvs)} projects=${lenOf(emptyProjects)}`);

  // --- B. Invitations for every invitable role --------------------------------
  console.log('\nB. An invitation for every invitable role, accepted through the real door');
  const ownerAsOwner = await call('builder-portal-invite',
    { action: 'invite', email: `${EMAIL_PREFIX}second-owner@example.com`, name: 'Nope', membership_role: 'owner' }, A.cookie);
  record('B: the owner role cannot be granted by invitation', ownerAsOwner.status === 400,
    `status ${ownerAsOwner.status}`);

  const members = {};
  for (const [role, label] of [
    ['administrator', 'administrator'], ['manager', 'manager'], ['member', 'member'],
    ['read_only', 'read-only'], ['member', 'revokee'], ['member', 'deactivated'], ['member', 'multi'],
  ]) {
    const { invite, accepted, user } = await inviteAndAccept(A, A.cookie, role, label);
    const ok = invite.status === 200 && accepted?.status === 200 && accepted?.json?.signed_in === true
      && !!user?.cookie && user.storedRole === role;
    record(`B: ${label} (${role}) is invited and accepts, signed in`, ok,
      `invite=${invite.status} accept=${accepted?.status} signed_in=${accepted?.json?.signed_in} stored=${user?.storedRole}`);
    if (!user?.cookie) continue;
    members[label] = user;
    const s = await sessionRow(user.cookie);
    if (label === 'member') {
      record('C: an accepted invitation issues a 12 h absolute / 240 min idle session',
        s && Math.abs(Number(s.absolute_hours) - ABSOLUTE_HOURS) < 0.02
          && Number(s.idle_minutes_left) > IDLE_MINUTES - 3 && Number(s.idle_minutes_left) <= IDLE_MINUTES + 0.5,
        `absolute=${Number(s?.absolute_hours).toFixed(2)}h idle_left=${Number(s?.idle_minutes_left).toFixed(1)}m`);
    }
    const g = await govern(user.cookie);
    record(`B: ${label} reaches the dashboard through terms and onboarding`,
      g.verify.status === 200 && g.verify.json?.governance === null,
      `governance=${String(g.verify.json?.governance)}`);
  }

  const replay = await call('builder-portal-accept-invite', {
    action: 'accept', token: `${randomUUID()}-${randomUUID()}`, password: `Acc3ss!${RUN}!replay`,
  });
  record('B: an unknown or spent invite token is refused', replay.status === 400, `status ${replay.status}`);

  // --- D. The role matrix ------------------------------------------------------
  console.log('\nD. Role matrix — the portal against the database resolvers');
  // A project in organisation A, granted to its members exactly as the
  // activation fan-out grants it (20260917090000).
  const project = (await q('seed project', `
    SELECT (public.builder_upsert_project(NULL, 'system', NULL, NULL,
      ${sqlLit(JSON.stringify({ name: `${ORG_PREFIX} project`, suburb: 'Proofville', state: 'NSW', postcode: '2000' }))}::jsonb,
      NULL, ${id(A.orgId)}, NULL, NULL, 'portal access proof')).id AS id`))[0].id;
  await q('grant project', `
    INSERT INTO public.builder_project_access(builder_user_id, project_id, organisation_id, organisation_side, access_role)
    SELECT m.builder_user_id, ${id(project)}, m.organisation_id, 'builder',
           CASE m.membership_role WHEN 'owner' THEN 'responsible' WHEN 'administrator' THEN 'supervisor'
             WHEN 'manager' THEN 'supervisor' WHEN 'read_only' THEN 'read_only' ELSE 'team_member' END
    FROM public.builder_organisation_memberships m
    WHERE m.organisation_id = ${id(A.orgId)} AND m.status = 'active' AND m.revoked_at IS NULL
    ON CONFLICT (builder_user_id, project_id) DO NOTHING`);
  const projectVersion = Number((await q('project version', `
    SELECT row_version FROM public.builder_projects WHERE id = ${id(project)}`))[0].row_version);

  const matrixUsers = [
    { ...A, label: 'owner' },
    members.administrator, members.manager, members.member, members['read-only'],
  ].filter(Boolean);
  const matrix = [];
  for (const u of matrixUsers) {
    const expect = (await q(`resolve ${u.label}`, `
      SELECT
        public.builder_resolve_permission(${id(u.userId)}, ${id(A.orgId)}, 'inventory', 'view')   AS inv_view,
        public.builder_resolve_permission(${id(u.userId)}, ${id(A.orgId)}, 'inventory', 'edit')   AS inv_edit,
        public.builder_resolve_permission(${id(u.userId)}, ${id(A.orgId)}, 'inventory', 'delete') AS inv_delete,
        public.builder_resolve_project_permission(${id(u.userId)}, ${id(project)}, 'projects', 'view') AS prj_view,
        public.builder_resolve_project_permission(${id(u.userId)}, ${id(project)}, 'projects', 'edit') AS prj_edit,
        public.builder_resolve_scope_permission(${id(u.userId)}, 'project', ${id(project)}, 'messages', 'view') AS msg_view,
        public.builder_resolve_scope_permission(${id(u.userId)}, 'project', ${id(project)}, 'messages', 'edit') AS msg_edit`))[0];
    const role = u.label === 'owner' ? 'owner' : u.role;
    const isAdmin = role === 'owner' || role === 'administrator';
    const rowResult = { role };

    const stockView = await call('builder-portal-stock', { operation: 'list_stock' }, u.cookie);
    rowResult.stockView = stockView.status;
    const stockEdit = await call('builder-portal-stock',
      { operation: 'set_availability', stock_item_id: randomUUID(), availability_status: 'available' }, u.cookie);
    rowResult.stockEdit = stockEdit.status;
    const stockDelete = await call('builder-portal-stock',
      { operation: 'archive_stock_item', stock_item_id: randomUUID() }, u.cookie);
    rowResult.stockDelete = stockDelete.status;
    const pView = await call('builder-portal-projects', { operation: 'get_project', project_id: project }, u.cookie);
    rowResult.projectView = pView.status;
    const pEdit = await call('builder-portal-projects', {
      operation: 'update_project', project_id: project, expected_version: projectVersion + 1000,
      name: `${ORG_PREFIX} project`, reason: 'access proof — stale on purpose',
    }, u.cookie);
    rowResult.projectEdit = pEdit.status;
    const settings = await call('builder-portal-workspace', { operation: 'get_organisation_settings' }, u.cookie);
    rowResult.settingsCanEdit = settings.json?.can_edit;
    const saveSettings = isAdmin ? null : await call('builder-portal-workspace',
      { operation: 'save_organisation_settings', reason: 'access proof' }, u.cookie);
    const inviteTry = await call('builder-portal-invite', {
      action: 'invite', email: `${EMAIL_PREFIX}by-${u.label}@example.com`, name: 'Access invitee', membership_role: 'read_only',
    }, u.cookie);
    rowResult.invite = inviteTry.status;

    // Stock: view gates the whole function; edit and delete are checked before the
    // (random, absent) item is looked up, so permitted means 404 and denied 403.
    const stockOk = expect.inv_view
      ? stockView.status === 200
        && stockEdit.status === (expect.inv_edit ? 404 : 403)
        && stockDelete.status === (expect.inv_delete ? 404 : 403)
      : stockView.status === 403;
    const projectOk = (expect.prj_view ? pView.status === 200 : pView.status === 403)
      && (!expect.prj_view || pEdit.status === (expect.prj_edit ? 409 : 403));
    const adminOk = settings.status === 200 && settings.json?.can_edit === isAdmin
      && (isAdmin || saveSettings.status === 403)
      && inviteTry.status === (isAdmin ? 200 : 403);
    record(`D: ${role} — stock answers what builder_resolve_permission decides`, stockOk,
      `view=${stockView.status}/${expect.inv_view} edit=${stockEdit.status}/${expect.inv_edit} delete=${stockDelete.status}/${expect.inv_delete}`);
    record(`D: ${role} — projects answer what builder_resolve_project_permission decides`, projectOk,
      `view=${pView.status}/${expect.prj_view} edit=${pEdit.status}/${expect.prj_edit}`);
    record(`D: ${role} — invitations and organisation settings are owner/administrator only`, adminOk,
      `can_edit=${settings.json?.can_edit} save=${saveSettings?.status ?? 'n/a'} invite=${inviteTry.status}`);
    if (role === 'read_only') {
      record('D: read_only can change nothing', !expect.inv_edit && !expect.inv_delete && !expect.prj_edit && !expect.msg_edit,
        `inv_edit=${expect.inv_edit} inv_delete=${expect.inv_delete} prj_edit=${expect.prj_edit} msg_edit=${expect.msg_edit}`);
    }
    Object.assign(rowResult, expect);
    matrix.push(rowResult);
  }
  console.log('\n  ROLE MATRIX (portal status / database decision)');
  for (const r of matrix) {
    console.log(`    ${r.role.padEnd(13)} stock v=${r.stockView}/${r.inv_view} e=${r.stockEdit}/${r.inv_edit} d=${r.stockDelete}/${r.inv_delete}`
      + ` | project v=${r.projectView}/${r.prj_view} e=${r.projectEdit}/${r.prj_edit}`
      + ` | messages v=${r.msg_view} e=${r.msg_edit} | settings.can_edit=${r.settingsCanEdit} invite=${r.invite}`);
  }

  // --- E. A project conversation ------------------------------------------------
  console.log('\nE. Project conversation');
  const participants = [members.member, members['read-only'], members.manager].filter(Boolean).map((m) => m.userId);
  const created = await call('builder-portal-collaboration', {
    operation: 'create_conversation', scope_type: 'project', scope_id: project,
    subject: `${ORG_PREFIX} site meeting`, participant_ids: participants, reason: 'access proof',
  }, A.cookie);
  const conversationId = created.json?.record?.id ?? null;
  record('E: the owner opens a project conversation with named members', created.status === 200 && !!conversationId,
    `status ${created.status}${created.json?.error ? ` (${created.json.error})` : ''}`);

  const timings = [];
  if (conversationId) {
    for (let i = 0; i < 3; i += 1) {
      const author = i % 2 === 0 ? A : members.member;
      const reader = i % 2 === 0 ? members.member : A;
      const body = `access proof ${RUN} message ${i}`;
      const t0 = Date.now();
      const posted = await call('builder-portal-collaboration',
        { operation: 'post_message', conversation_id: conversationId, body }, author.cookie);
      const tPosted = Date.now();
      const read = await call('builder-portal-collaboration',
        { operation: 'get_conversation', conversation_id: conversationId }, reader.cookie);
      const seen = (read.json?.messages ?? []).some((m) => m.body === body);
      timings.push({ post: tPosted - t0, visible: Date.now() - t0 });
      record(`E: message ${i} posted by ${author === A ? 'owner' : 'member'} is visible to the other participant on the next read`,
        posted.status === 200 && seen, `post=${posted.status} ${tPosted - t0}ms, visible after ${Date.now() - t0}ms`);
    }
    const roRead = await call('builder-portal-collaboration',
      { operation: 'get_conversation', conversation_id: conversationId }, members['read-only']?.cookie);
    const roPost = await call('builder-portal-collaboration',
      { operation: 'post_message', conversation_id: conversationId, body: 'read only tries' }, members['read-only']?.cookie);
    // A reader who can see the conversation is told 403, not "not found".
    record('E: a read_only participant reads the conversation and cannot post (403)',
      roRead.status === 200 && roPost.status === 403
        && roRead.json?.permissions?.messages?.edit === false,
      `read=${roRead.status} post=${roPost.status} permissions.messages.edit=${roRead.json?.permissions?.messages?.edit}`);
    const markRead = await call('builder-portal-collaboration',
      { operation: 'mark_conversation_read', conversation_id: conversationId }, members.member.cookie);
    record('E: a participant marks the conversation read', markRead.status === 200, `status ${markRead.status}`);
    const author = (await q('message author', `
      SELECT count(*) FILTER (WHERE author_builder_user_id IS NULL) AS anonymous, count(*) AS total
      FROM public.builder_messages WHERE conversation_id = ${id(conversationId)}`))[0];
    record('E: every message is attributed to its session user, never to the request body',
      Number(author.anonymous) === 0 && Number(author.total) === 3, `anonymous=${author.anonymous} total=${author.total}`);
  }
  if (timings.length) {
    const posts = timings.map((t) => t.post).sort((a, b) => a - b);
    const vis = timings.map((t) => t.visible).sort((a, b) => a - b);
    console.log(`  timing: post ${posts[0]}–${posts.at(-1)}ms (median ${posts[1]}), send→visible-on-next-read ${vis[0]}–${vis.at(-1)}ms (median ${vis[1]})`);
  }

  // --- F. Notifications ---------------------------------------------------------
  console.log('\nF. Notifications');
  const task = await call('builder-portal-collaboration', {
    operation: 'upsert_task', scope_type: 'project', scope_id: project,
    title: `${ORG_PREFIX} check setout`, reason: 'access proof',
  }, A.cookie);
  const taskId = task.json?.record?.id ?? null;
  const assign = taskId ? await call('builder-portal-collaboration',
    { operation: 'set_task_assignment', task_id: taskId, builder_user_id: members.member.userId, reason: 'access proof' }, A.cookie) : null;
  record('F: the owner creates a project task and assigns a member', task.status === 200 && assign?.status === 200,
    `task=${task.status} assign=${assign?.status}`);
  const memberNotes = await call('builder-portal-collaboration', { operation: 'list_notifications' }, members.member.cookie);
  const note = (memberNotes.json?.records ?? []).find((n) => n.entity_id === taskId);
  const counts = await call('builder-portal-collaboration', { operation: 'unread_counts' }, members.member.cookie);
  record('F: the assignee is notified and it counts as unread',
    !!note && note.notification_type === 'task_assigned' && !note.read_at && Number(counts.json?.unread_notifications) >= 1,
    `notified=${!!note} unread=${counts.json?.unread_notifications}`);
  const managerNotes = await call('builder-portal-collaboration', { operation: 'list_notifications' }, members.manager.cookie);
  const bNotes = await call('builder-portal-collaboration', { operation: 'list_notifications' }, B.cookie);
  record('F: nobody else — in the organisation or outside it — sees that notification',
    !(managerNotes.json?.records ?? []).some((n) => n.entity_id === taskId)
      && !(bNotes.json?.records ?? []).some((n) => n.entity_id === taskId),
    `manager=${(managerNotes.json?.records ?? []).length} orgB=${(bNotes.json?.records ?? []).length}`);
  const myTasks = await call('builder-portal-collaboration', { operation: 'my_tasks' }, members.member.cookie);
  record('F: the task is on the assignee’s own task list',
    (myTasks.json?.records ?? []).some((t) => t.id === taskId), `records=${(myTasks.json?.records ?? []).length}`);
  if (note) {
    const foreignMark = await call('builder-portal-collaboration',
      { operation: 'mark_notifications_read', notification_ids: [note.id] }, B.cookie);
    const still = (await q('note unread', `SELECT read_at IS NULL AS unread FROM public.builder_notifications WHERE id = ${id(note.id)}`))[0];
    record('F: another organisation cannot mark it read', foreignMark.status === 200
      && Number(foreignMark.json?.marked_read) === 0 && still?.unread === true,
      `marked_read=${foreignMark.json?.marked_read} still_unread=${still?.unread}`);
    const ownMark = await call('builder-portal-collaboration',
      { operation: 'mark_notifications_read', notification_ids: [note.id] }, members.member.cookie);
    const after = await call('builder-portal-collaboration', { operation: 'unread_counts' }, members.member.cookie);
    record('F: the assignee marks it read and the unread count falls',
      Number(ownMark.json?.marked_read) === 1
        && Number(after.json?.unread_notifications) === Number(counts.json?.unread_notifications) - 1,
      `marked=${ownMark.json?.marked_read} unread ${counts.json?.unread_notifications}→${after.json?.unread_notifications}`);
  }

  // --- G. Multi-tenant isolation ------------------------------------------------
  console.log('\nG. Multi-tenant isolation');
  const bProject = await call('builder-portal-projects', { operation: 'get_project', project_id: project }, B.cookie);
  const bProjectEdit = await call('builder-portal-projects',
    { operation: 'update_project', project_id: project, expected_version: projectVersion, name: 'hijack', reason: 'x' }, B.cookie);
  const bList = await call('builder-portal-projects', { operation: 'list_projects' }, B.cookie);
  record('G: another organisation cannot read, edit or list the project',
    bProject.status === 404 && bProjectEdit.status === 404 && lenOf(bList) === 0,
    `get=${bProject.status} update=${bProjectEdit.status} listed=${lenOf(bList)}`);
  if (conversationId) {
    const bConv = await call('builder-portal-collaboration',
      { operation: 'get_conversation', conversation_id: conversationId }, B.cookie);
    const bPost = await call('builder-portal-collaboration',
      { operation: 'post_message', conversation_id: conversationId, body: 'intruder' }, B.cookie);
    const bScope = await call('builder-portal-collaboration',
      { operation: 'list_conversations', scope_type: 'project', scope_id: project }, B.cookie);
    const bCreate = await call('builder-portal-collaboration',
      { operation: 'create_conversation', scope_type: 'project', scope_id: project, subject: 'intruder' }, B.cookie);
    record('G: another organisation cannot read, post to, list or open conversations on the project',
      bConv.status === 404 && [403, 404].includes(bPost.status)
        && bScope.status === 404 && bCreate.status === 404,
      `get=${bConv.status} post=${bPost.status} list=${bScope.status} create=${bCreate.status}`);
    const intruded = (await q('intruder message', `
      SELECT count(*) AS n FROM public.builder_messages WHERE conversation_id = ${id(conversationId)} AND body = 'intruder'`))[0];
    record('G: nothing the outsider sent was written', Number(intruded.n) === 0, `rows=${intruded.n}`);
  }
  const selectForeign = await call('builder-portal-verify',
    { action: 'select_organisation', organisation_id: B.orgId }, members.member.cookie);
  record('G: a member cannot switch their session into an organisation they do not belong to',
    selectForeign.status === 403 && selectForeign.json?.code === 'organisation_not_accessible',
    `status ${selectForeign.status} code=${selectForeign.json?.code}`);

  // A user in TWO organisations: the session names one, and a write filed
  // under the other is refused rather than silently re-homed.
  const multi = members.multi;
  if (multi) {
    const addToB = await call('builder-portal-invite',
      { action: 'invite', email: multi.email, name: 'Access multi', membership_role: 'member' }, B.cookie);
    const gate = await call('builder-portal-workspace', { operation: 'workspace_summary' }, multi.cookie);
    const selectB = await call('builder-portal-verify',
      { action: 'select_organisation', organisation_id: B.orgId }, multi.cookie);
    const activeRow = (await q('active org', `
      SELECT active_organisation_id FROM public.builder_portal_sessions
      WHERE token_hash = ${sqlLit(hmacHex(PEPPER, tokenOf(multi.cookie)))}`))[0];
    record('G: a user in two organisations can select the second one', addToB.status === 200
      && selectB.status === 200 && activeRow?.active_organisation_id === B.orgId,
      `added=${addToB.status} workspace-before-select=${gate.status}${gate.json?.code ? `/${gate.json.code}` : ''} select=${selectB.status}`);
    const mismatch = await call('builder-portal-stock',
      { operation: 'list_stock', expected_organisation_id: A.orgId }, multi.cookie);
    record('G: a request filed under the organisation the session no longer names is refused (409)',
      mismatch.status === 409 && mismatch.json?.code === 'organisation_context_changed',
      `status ${mismatch.status} code=${mismatch.json?.code}`);
    const inB = await call('builder-portal-projects', { operation: 'get_project', project_id: project }, multi.cookie);
    record('G: acting as organisation B, the same person cannot reach organisation A’s project',
      inB.status === 404, `status ${inB.status}`);
  }

  // --- H. Member management ---------------------------------------------------------
  console.log('\nH. Member management');
  const manageMember = (cookie, membershipId, memberAction, role) => call('builder-portal-invite',
    { action: 'manage_member', membership_id: membershipId, member_action: memberAction, role }, cookie);
  const listMembers = (cookie) => call('builder-portal-invite', { action: 'list_members' }, cookie);
  const { user: target } = await inviteAndAccept(A, A.cookie, 'member', 'managed');
  if (target) await govern(target.cookie);
  const pendingEmail = `${EMAIL_PREFIX}pending@example.com`;
  await call('builder-portal-invite', { action: 'invite', email: pendingEmail, name: 'Access pending', membership_role: 'read_only' }, A.cookie);
  const ownerList = await listMembers(A.cookie);
  const listed = ownerList.json?.members ?? [];
  const pendingListed = (ownerList.json?.invitations ?? []).find((m) => m.email === pendingEmail);
  const selfRow = listed.find((m) => m.is_self);
  record('H: the owner lists members (role, status) and pending invitations apart',
    ownerList.status === 200 && listed.some((m) => m.builder_user_id === target?.userId && m.role === 'member' && m.status === 'active')
      && !!pendingListed && !listed.some((m) => m.email === pendingEmail) && selfRow?.role === 'owner' && selfRow?.can_manage === false,
    `members=${listed.length} invitations=${(ownerList.json?.invitations ?? []).length}`);
  const bMembers = await listMembers(B.cookie);
  record('H: another organisation\'s owner lists only their own members',
    bMembers.status === 200 && !(bMembers.json?.members ?? []).some((m) => m.builder_user_id === target?.userId),
    `members=${(bMembers.json?.members ?? []).length}`);
  const managerCookie = (await mintSession(members.manager.userId)).cookie;
  for (const [who, cookie] of [['manager', managerCookie], ['member', members.member.cookie], ['read_only', members['read-only'].cookie]]) {
    const l = await listMembers(cookie);
    const m = await manageMember(cookie, target?.membershipId, 'suspend');
    record(`H: a ${who} can neither list nor manage members`, l.status === 403 && m.status === 403, `list=${l.status} manage=${m.status}`);
  }
  const stockEdit = (cookie) => call('builder-portal-stock',
    { operation: 'set_availability', stock_item_id: randomUUID(), availability_status: 'available' }, cookie);
  const beforePromote = await stockEdit(target.cookie);
  const promoted = await manageMember(members.administrator.cookie, target.membershipId, 'set_role', 'manager');
  const afterPromote = await stockEdit(target.cookie);
  record('H: an administrator changes a role and the member\'s permissions change on their very next request',
    beforePromote.status === 403 && promoted.status === 200 && promoted.json?.member?.role === 'manager' && afterPromote.status === 404,
    `edit before=${beforePromote.status} change=${promoted.status} edit after=${afterPromote.status}`);
  const demoted = await manageMember(A.cookie, target.membershipId, 'set_role', 'read_only');
  const staleEdit = await stockEdit(target.cookie);
  record('H: a demotion is enforced at once — the member\'s stale page cannot write',
    demoted.status === 200 && staleEdit.status === 403, `change=${demoted.status} edit=${staleEdit.status}`);
  const ownerByAdmin = await manageMember(members.administrator.cookie, A.membershipId, 'suspend');
  const selfManage = await manageMember(A.cookie, A.membershipId, 'set_role', 'member');
  const ownerRole = await manageMember(A.cookie, target.membershipId, 'set_role', 'owner');
  const unknownRole = await manageMember(A.cookie, target.membershipId, 'set_role', 'superuser');
  record('H: an administrator cannot touch the owner; nobody manages themselves; owner and unknown roles are refused',
    ownerByAdmin.status === 403 && selfManage.status === 409 && ownerRole.status === 400 && unknownRole.status === 400,
    `owner-by-admin=${ownerByAdmin.status} self=${selfManage.status} owner-role=${ownerRole.status} unknown=${unknownRole.status}`);
  const soleOwner = (await q('owners', `SELECT count(*) AS n FROM public.builder_organisation_memberships
    WHERE organisation_id = ${id(A.orgId)} AND membership_role = 'owner' AND status = 'active' AND revoked_at IS NULL`))[0];
  record('H: the organisation keeps its one active owner', Number(soleOwner.n) === 1, `owners=${soleOwner.n}`);
  const crossOrg = await manageMember(B.cookie, target.membershipId, 'remove');
  record('H: another organisation cannot manage this organisation\'s member (reads as absent)', crossOrg.status === 404,
    `status ${crossOrg.status}`);
  const suspended = await manageMember(A.cookie, target.membershipId, 'suspend');
  const suspendedCall = await call('builder-portal-verify', {}, target.cookie);
  const reissue = await q('reissue', `SELECT EXISTS (SELECT 1 FROM public.builder_accessible_organisations(${id(target.userId)})) AS has_org`);
  record('H: a suspended member loses access on their next request and cannot be issued a session',
    suspended.status === 200 && suspended.json?.member?.status === 'suspended' && refused(suspendedCall.status) && reissue[0]?.has_org === false,
    `suspend=${suspended.status} next=${suspendedCall.status} accessible_org=${reissue[0]?.has_org}`);
  const reactivated = await manageMember(A.cookie, target.membershipId, 'reactivate');
  const back = await mintSession(target.userId);
  const backCall = await call('builder-portal-verify', {}, back.cookie);
  record('H: a reactivated member can sign in again', reactivated.status === 200 && backCall.status === 200,
    `reactivate=${reactivated.status} verify=${backCall.status}`);
  const removed = await manageMember(A.cookie, target.membershipId, 'remove');
  const removedCall = await call('builder-portal-verify', {}, back.cookie);
  const afterRemove = await listMembers(A.cookie);
  record('H: removal ends access and the member leaves the list',
    removed.status === 200 && refused(removedCall.status) && !(afterRemove.json?.members ?? []).some((m) => m.builder_user_id === target.userId),
    `remove=${removed.status} next=${removedCall.status}`);
  const cancelled = await call('builder-portal-invite', { action: 'revoke_invite', builder_user_id: pendingListed?.builder_user_id }, A.cookie);
  const afterCancel = await listMembers(A.cookie);
  record('H: a pending invitation is cancelled and leaves the list',
    cancelled.status === 200 && !(afterCancel.json?.invitations ?? []).some((m) => m.email === pendingEmail), `cancel=${cancelled.status}`);
  const audited = (await q('member audit', `SELECT count(*) AS n FROM public.builder_portal_activity_log
    WHERE organisation_id = ${id(A.orgId)} AND entity_type = 'membership' AND actor_type = 'builder_user'`))[0];
  record('H: every membership act was audited', Number(audited.n) >= 5, `rows=${audited.n}`);

  // --- I. One invitation opens one organisation ------------------------------
  //
  // The cross-organisation invitation takeover, reproduced against the live
  // deployment with disposable organisations only, and then shown refused.
  //
  // Before the fix: A's administrator invites an address that is still a
  // pending invitee of B; the send fails so the link comes back to A; and
  // accepting it activated the ACCOUNT, bringing B's membership alive too —
  // up to `owner`. The guarantee now is that acceptance promotes exactly the
  // organisation whose token was accepted, and that a link is never handed to
  // an organisation the address does not belong to.
  const victimEmail = `${EMAIL_PREFIX}crossorg@example.com`;
  const victimPassword = `Cr0ss!${RUN}!org`;

  // B invites first, at the highest role an invitation may carry.
  const bInvite = await call('builder-portal-invite',
    { action: 'invite', email: victimEmail, name: 'Access crossorg', membership_role: 'administrator' },
    B.cookie);
  const membershipStatus = async (orgId) => (await q('cross-org membership', `
    SELECT m.status, m.membership_role
      FROM public.builder_organisation_memberships m
      JOIN public.builder_portal_users u ON u.id = m.builder_user_id
     WHERE u.email = ${sqlLit(victimEmail)} AND m.organisation_id = ${id(orgId)}
       AND m.revoked_at IS NULL`))[0] ?? null;
  const bPending = await membershipStatus(B.orgId);
  record('I: a membership granted to an account that cannot sign in yet WAITS for its own invitation',
    bInvite.status === 200 && bPending?.status === 'invited',
    `invite=${bInvite.status} B.status=${bPending?.status} role=${bPending?.membership_role}`);
  /*
   * NO LINK COMES BACK, FOR ANYBODY, ON A DEPLOYMENT THAT HAS A POSTMAN.
   *
   * The first fix withheld the link only where the address belonged to another
   * organisation, and asserted here that a brand-new address still got one. The
   * independent review showed both halves of that were wrong:
   *
   *  * holding the link for an unclaimed address lets the CALLER accept it —
   *    setting a password and stamping the mailbox verified on an account
   *    bearing somebody else's address — and an established account is granted
   *    a LIVE membership whenever any organisation adds it later, so the claim
   *    pays off the first time the real person is invited somewhere;
   *  * the link's PRESENCE was itself a per-address answer to "does this address
   *    belong somewhere that is not mine?", which is the oracle the invite
   *    function's own header forbids.
   *
   * Both sends here fail — the recipient is a reserved `@example.com` name the
   * provider refuses — and a failed send now returns nothing. The affordance
   * survives only where there is no mail provider at all, which this deployment
   * is not.
   *
   * That the send failed is read from the activity log, where the function
   * records the provider's answer: the response stopped carrying `email_sent`
   * because it differed for a revoked account (section J).
   */
  const bSend = (await q('B invitation send outcome', `
    SELECT l.metadata->>'email_sent' AS email_sent
      FROM public.builder_portal_activity_log l
      JOIN public.builder_portal_users u ON u.id = l.entity_id
     WHERE u.email = ${sqlLit(victimEmail)} AND l.organisation_id = ${id(B.orgId)}
       AND l.action = 'builder_invite_sent'
     ORDER BY l.created_at DESC LIMIT 1`))[0];
  record('I: a failed send hands the inviter NO link, so nobody can claim the account behind an address',
    bInvite.status === 200 && bSend?.email_sent === 'false' && !bInvite.json?.invite_url,
    `send (activity log)=${bSend?.email_sent} invite_url=${bInvite.json?.invite_url ? 'RETURNED' : 'absent'}`);

  // A now invites the same address. This is the attacker's move.
  const aInvite = await call('builder-portal-invite',
    { action: 'invite', email: victimEmail, name: 'Access crossorg', membership_role: 'read_only' },
    A.cookie);
  const aPending = await membershipStatus(A.orgId);
  record('I: the second organisation may invite the same address, and its grant waits too',
    aInvite.status === 200 && aPending?.status === 'invited',
    `invite=${aInvite.status} A.status=${aPending?.status}`);
  // The link is the delivery mechanism the takeover needed, and this run's own
  // recipient is a reserved `@example.com` name the provider refuses — so the
  // send fails here for the same reason every proof send always has (doc 65
  // §4), and before the fix this response carried a working credential for B's
  // pending seat. The withholding is what makes that unreachable; note the
  // assertion above proves it is withheld from A while still returned to B.
  record('I: and the same for an address that DOES belong elsewhere — no link either',
    aInvite.status === 200 && !aInvite.json?.invite_url,
    `invite_url=${aInvite.json?.invite_url ? 'RETURNED' : 'absent'}`);
  // THE ORACLE IS GONE BECAUSE THE TWO ANSWERS ARE THE SAME ANSWER. Withholding
  // the link from one address and returning it for another makes its absence the
  // disclosure; asserted as an equality of the whole body — values as well as
  // keys — so narrowing the rule cannot pass.
  record('I: the two responses are the same bytes, so a caller learns nothing about where an address belongs',
    bInvite.status === aInvite.status && bInvite.text === aInvite.text,
    `belongs-nowhere=${shown(bInvite.text)} belongs-elsewhere=${shown(aInvite.text)}`);

  // Accept A's invitation, with A's own token, exactly as the portal would.
  const crossToken = `${randomUUID()}-${randomUUID()}`;
  const victimId = (await q('cross-org user', `
    SELECT id FROM public.builder_portal_users WHERE email = ${sqlLit(victimEmail)}`))[0]?.id;
  await q('mint cross-org token', `
    UPDATE public.builder_portal_users
       SET invite_token_hash = ${sqlLit(hmacHex(PEPPER, crossToken))},
           invite_token_expires_at = now() + interval '1 hour',
           invite_token_organisation_id = ${id(A.orgId)}
     WHERE id = ${id(victimId)}`);

  // What the form is told before a password is set: this organisation only.
  const validated = await call('builder-portal-accept-invite', { action: 'validate', token: crossToken });
  const named = validated.json?.organisations ?? [];
  record('I: the acceptance form names the ONE organisation being joined, never where else the address is pending',
    validated.status === 200 && named.length === 1 && named[0]?.organisation_id === A.orgId,
    `status=${validated.status} named=${named.length}`);

  const crossAccepted = await call('builder-portal-accept-invite',
    { action: 'accept', token: crossToken, password: victimPassword });
  const crossCookie = cookieFrom(crossAccepted.setCookies);
  const aAfter = await membershipStatus(A.orgId);
  const bAfter = await membershipStatus(B.orgId);
  record('I: accepting activates the organisation whose invitation it was',
    crossAccepted.status === 200 && aAfter?.status === 'active',
    `status=${crossAccepted.status} A.status=${aAfter?.status}`);
  record('I: and leaves the OTHER organisation exactly where it was — the takeover is refused',
    bAfter?.status === 'invited',
    `B.status=${bAfter?.status} role=${bAfter?.membership_role}`);

  // Asked of the runtime rather than of the rows: the session cannot reach B.
  const crossRestore = crossCookie
    ? await call('builder-portal-verify', {}, crossCookie)
    : { status: 0, json: null };
  const reachable = (crossRestore.json?.organisations ?? []).map((o) => o.organisation_id);
  record('I: the session the acceptance issued reaches that organisation and no other',
    crossRestore.status === 200 && reachable.length === 1 && reachable[0] === A.orgId,
    `restore=${crossRestore.status} reachable=${reachable.length}`);
  const intoB = crossCookie
    ? await call('builder-portal-verify', { action: 'select_organisation', organisation_id: B.orgId }, crossCookie)
    : { status: 0, json: null };
  record('I: selecting the other organisation is refused, by the server, on the live deployment',
    intoB.status === 403 && intoB.json?.code === 'organisation_not_accessible',
    `status=${intoB.status} code=${intoB.json?.code}`);

  // No lockout, and no seat stuck waiting for ever. The victim now has an
  // account, so B adding them is no longer an invitation: B's administrator
  // grants it and the waiting row is promoted on the spot.
  const bRegrant = await call('builder-portal-invite',
    { action: 'invite', email: victimEmail, name: 'Access crossorg', membership_role: 'manager' },
    B.cookie);
  const bFinal = await membershipStatus(B.orgId);
  record('I: the other organisation can still add them itself, and the waiting seat is promoted',
    bRegrant.status === 200 && bFinal?.status === 'active',
    `regrant=${bRegrant.status} B.status=${bFinal?.status} role=${bFinal?.membership_role}`);
  /*
   * AND A REFUSAL TO PROMOTE IS NOT REPORTED AS A GRANT.
   *
   * Suspend the seat that was just promoted, then add them again. Promoting
   * nothing is the right answer — a suspended membership is an administrator's
   * decision an invitation may not undo — but the door used to answer 200 and
   * email "You now have access … your existing sign-in still works" over a
   * membership the portal still refuses, because a zero-row update carries no
   * error. That is the exact failure the promotion exists to prevent.
   */
  const bMembershipId = (await q('cross-org membership id', `
    SELECT m.id FROM public.builder_organisation_memberships m
      JOIN public.builder_portal_users u ON u.id = m.builder_user_id
     WHERE u.email = ${sqlLit(victimEmail)} AND m.organisation_id = ${id(B.orgId)}
       AND m.revoked_at IS NULL`))[0]?.id;
  const bSuspend = await call('builder-portal-invite',
    { action: 'manage_member', membership_id: bMembershipId, member_action: 'suspend' }, B.cookie);
  const readd = await call('builder-portal-invite',
    { action: 'invite', email: victimEmail, name: 'Access crossorg', membership_role: 'member' },
    B.cookie);
  const afterReadd = await membershipStatus(B.orgId);
  record('I: re-adding a SUSPENDED member is refused rather than reported as a grant',
    bSuspend.status === 200 && readd.status === 409
      && readd.json?.code === 'membership_not_promotable' && afterReadd?.status === 'suspended',
    `suspend=${bSuspend.status} readd=${readd.status} code=${readd.json?.code} B.status=${afterReadd?.status}`);
  // Put it back, so the assertions below read the state they were written for.
  await call('builder-portal-invite',
    { action: 'manage_member', membership_id: bMembershipId, member_action: 'reactivate' }, B.cookie);

  const reachesBoth = crossCookie
    ? await call('builder-portal-verify', {}, crossCookie)
    : { status: 0, json: null };
  const bothIds = (reachesBoth.json?.organisations ?? []).map((o) => o.organisation_id).sort();
  record('I: only then does the session reach both — the rule protects them without stranding them',
    bothIds.length === 2 && bothIds.includes(A.orgId) && bothIds.includes(B.orgId),
    `reachable=${bothIds.length}`);

  // --- J. An invitation answers the same, whatever the address already is ----
  //
  // `expires_at` came back for a new or pending address and not for one that
  // already signs in, and `email_sent: false` came back for an operator-revoked
  // account while mail worked — so the answer told an organisation's
  // administrator whether an arbitrary address held a Builder Portal account.
  // Asked of the live deployment over disposable addresses of all four kinds,
  // three of each, from a disposable organisation (D) that nothing else in this
  // run touches: the answers must be the same bytes. The server's own rows are
  // read afterwards, to show the four really were handled four different ways.
  console.log('\nJ. An invitation answers the same whatever the address already is');
  const D = await seedOrganisation('D'); // the inviter
  const E = await seedOrganisation('E'); // where the already-signed-in accounts live
  for (const owner of [D, E]) {
    owner.cookie = (await mintSession(owner.userId)).cookie;
    const g = await govern(owner.cookie);
    record(`J: owner ${owner.letter} is governed and reaches the dashboard`,
      g.verify.status === 200 && g.verify.json?.governance === null,
      `governance=${String(g.verify.json?.governance)}`);
  }

  /** An account that exists before D asks: signed in (a member of E), or revoked by an operator. */
  const seedAccount = async (label, { revoked }) => {
    const email = `${EMAIL_PREFIX}${label}@example.com`;
    const rows = await q(`seed ${label}`, `
      WITH person AS (
        INSERT INTO public.builder_portal_users(
          email, name, status, is_active, email_verified_at, password_hash, revoked_at)
        VALUES (${sqlLit(email)}, ${sqlLit(`Access ${label}`)},
                ${revoked ? "'revoked', false" : "'active', true"}, now(),
                extensions.crypt(${sqlLit(`Acc3ss!${RUN}!${label}`)}, extensions.gen_salt('bf', 4)),
                ${revoked ? 'now()' : 'NULL'})
        RETURNING id
      ), membership AS (
        INSERT INTO public.builder_organisation_memberships(
          builder_user_id, organisation_id, membership_role, is_primary, status)
        SELECT person.id, ${id(E.orgId)}, 'member', true, 'active' FROM person WHERE ${revoked ? 'false' : 'true'}
        RETURNING id
      )
      SELECT id FROM person`);
    return { email, userId: rows[0]?.id };
  };

  const kinds = ['new', 'pending', 'established', 'revoked'];
  const addressOf = (kind, i) => `${EMAIL_PREFIX}oracle-${kind}-${i}@example.com`;
  for (let i = 1; i <= 3; i += 1) {
    // Pending ELSEWHERE: B invites first, so the address is B's waiting invitee.
    await call('builder-portal-invite',
      { action: 'invite', email: addressOf('pending', i), name: `Access pending ${i}`, membership_role: 'member' }, B.cookie);
    await seedAccount(`oracle-established-${i}`, { revoked: false });
    await seedAccount(`oracle-revoked-${i}`, { revoked: true });
  }
  const answers = Object.fromEntries(kinds.map((kind) => [kind, []]));
  for (let i = 1; i <= 3; i += 1) {
    for (const kind of kinds) { // interleaved, so no kind runs on a warmer instance than another
      answers[kind].push(await call('builder-portal-invite',
        { action: 'invite', email: addressOf(kind, i), name: `Access ${kind} ${i}`, membership_role: 'read_only' },
        D.cookie));
    }
  }
  const every = kinds.flatMap((kind) => answers[kind]);
  const bodies = [...new Set(every.map((a) => a.text))];
  record('J: every kind of address gets 200 and the same bytes — new, pending elsewhere, already signed in, revoked',
    every.every((a) => a.status === 200) && bodies.length === 1 && bodies[0] === '{"success":true}',
    `statuses=[${[...new Set(every.map((a) => a.status))]}] distinct bodies=${bodies.length} body=${shown(bodies[0])}`);
  record('J: no answer carries expires_at, email_sent or a link',
    every.every((a) => a.json && !('expires_at' in a.json) && !('email_sent' in a.json) && !('invite_url' in a.json)),
    `answers=${every.length}`);

  // Underneath, the four were four different things. Counted by kind; no address is printed.
  const truth = await q('what the server did with each kind', `
    SELECT split_part(split_part(u.email, 'oracle-', 2), '-', 1) AS kind,
           u.status AS account, m.status AS in_d, b.status AS in_b, count(*)::int AS n
      FROM public.builder_portal_users u
      LEFT JOIN public.builder_organisation_memberships m
        ON m.builder_user_id = u.id AND m.organisation_id = ${id(D.orgId)} AND m.revoked_at IS NULL
      LEFT JOIN public.builder_organisation_memberships b
        ON b.builder_user_id = u.id AND b.organisation_id = ${id(B.orgId)} AND b.revoked_at IS NULL
     WHERE u.email LIKE ${sqlLit(`${EMAIL_PREFIX}oracle-%`)}
     GROUP BY 1, 2, 3, 4 ORDER BY 1`);
  const shape = (kind) => truth.filter((r) => r.kind === kind)
    .map((r) => `${r.account}/${r.in_d ?? 'none'}/${r.in_b ?? 'none'}x${r.n}`).join(',');
  record('J: underneath, the four were handled four different ways (account / in D / in B)',
    shape('new') === 'invited/invited/nonex3'
      && shape('pending') === 'invited/invited/invitedx3'
      && shape('established') === 'active/active/nonex3'
      && shape('revoked') === 'revoked/none/nonex3',
    kinds.map((kind) => `${kind}=${shape(kind)}`).join(' '));
  const logged = (await q('where the send outcomes went', `
    SELECT count(*) FILTER (WHERE l.action = 'builder_invite_sent' AND l.metadata ? 'email_sent')::int AS invitations,
           count(*) FILTER (WHERE l.action = 'builder_membership_granted' AND l.metadata ? 'email_sent')::int AS grants
      FROM public.builder_portal_activity_log l
     WHERE l.organisation_id = ${id(D.orgId)}`))[0] ?? {};
  record('J: whether each email left is still recorded — in the operator-only activity log, for invitations and grants alike',
    Number(logged.invitations) === 6 && Number(logged.grants) === 3,
    `invitations=${logged.invitations} grants=${logged.grants}`);
  const median = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
  record('J: response time by kind, median of three (ms) — measured, not asserted',
    true, kinds.map((kind) => `${kind}=${median(answers[kind].map((a) => a.ms))}`).join(' '), { required: false });

  // A SECOND invitation of every address, and a resend of every seat D now
  // holds. The independent review found the first answer uniform and the
  // repeat not: an address that already signed in held an active seat after
  // one invitation, so the repeat answered 409 and `resend` 409
  // `already_active`, while every other kind answered 200.
  const again = Object.fromEntries(kinds.map((kind) => [kind, []]));
  for (let i = 1; i <= 3; i += 1) {
    for (const kind of kinds) {
      again[kind].push(await call('builder-portal-invite',
        { action: 'invite', email: addressOf(kind, i), name: `Access ${kind} ${i}`, membership_role: 'read_only' },
        D.cookie));
    }
  }
  const seatsInD = await q('the seats D holds, by kind', `
    SELECT split_part(split_part(u.email, 'oracle-', 2), '-', 1) AS kind, u.id
      FROM public.builder_portal_users u
      JOIN public.builder_organisation_memberships m
        ON m.builder_user_id = u.id AND m.organisation_id = ${id(D.orgId)} AND m.revoked_at IS NULL
     WHERE u.email LIKE ${sqlLit(`${EMAIL_PREFIX}oracle-%`)}`);
  const resends = Object.fromEntries(kinds.map((kind) => [kind, []]));
  for (const seat of seatsInD) {
    resends[seat.kind]?.push(await call('builder-portal-invite', { action: 'resend', builder_user_id: seat.id }, D.cookie));
  }
  const repeated = kinds.flatMap((kind) => [...again[kind], ...resends[kind]]);
  const repeatBodies = [...new Set(repeated.map((a) => a.text))];
  record('J: a second invitation, and a resend, answer those same bytes for every kind of address',
    repeated.every((a) => a.status === 200) && repeatBodies.length === 1 && repeatBodies[0] === bodies[0]
      && kinds.every((kind) => again[kind].length === 3)
      && resends.new.length === 3 && resends.pending.length === 3 && resends.established.length === 3
      && resends.revoked.length === 0,
    `statuses=[${[...new Set(repeated.map((a) => a.status))]}] distinct bodies=${repeatBodies.length} `
    + `resends ${kinds.map((kind) => `${kind}=${resends[kind].length}`).join(' ')} (a revoked address gets no seat to resend)`);
  const grantsAfter = Number((await q('grants after the repeats', `
    SELECT count(*)::int AS n FROM public.builder_portal_activity_log
     WHERE organisation_id = ${id(D.orgId)} AND action = 'builder_membership_granted'`))[0]?.n);
  record('J: repeating an address that already signs in grants nothing more and sends nothing',
    grantsAfter === 3, `grants=${grantsAfter}`);
  const inviteCallsByD = every.length + repeated.length;

  // --- K. The invitation ceiling ------------------------------------------------
  //
  // `invite` and `resend` are now counted per person (40 an hour) and per
  // organisation (100 an hour), on ids from the validated session. Crossed
  // here with a real burst: the person's bucket is positioned two short of the
  // ceiling, which is a row in this run's own disposable organisation, and three
  // invitations go through the real door. Positioning rather than sending forty
  // is what keeps this from spending forty sends at the provider every tenant
  // shares — the counting itself is shown on the calls section J just made.
  console.log('\nK. The invitation ceiling — per person, then per organisation');
  const bucket = async (key) => {
    const row = (await q('ceiling bucket', `
      SELECT count FROM public.auth_rate_limits WHERE bucket_key = ${sqlLit(key)}`))[0];
    return row ? Number(row.count) : null;
  };
  const personKey = (userId) => `binv_user:${userId}`;
  const orgKey = (orgId) => `binv_org:${orgId}`;
  record('K: every invitation and resend is counted once — against the person, and against the organisation',
    await bucket(personKey(D.userId)) === inviteCallsByD && await bucket(orgKey(D.orgId)) === inviteCallsByD,
    `person=${await bucket(personKey(D.userId))} organisation=${await bucket(orgKey(D.orgId))} `
    + `after ${inviteCallsByD} calls`);

  // A second administrator and a member of D, through the real invitation and acceptance.
  const { user: dAdmin } = await inviteAndAccept(D, D.cookie, 'administrator', 'ceiling-admin');
  const { user: dMember } = await inviteAndAccept(D, D.cookie, 'member', 'ceiling-member');
  for (const u of [dAdmin, dMember]) if (u?.cookie) await govern(u.cookie);
  record('K: a second administrator and a member of D sign in', !!dAdmin?.cookie && !!dMember?.cookie,
    `admin=${!!dAdmin?.cookie} member=${!!dMember?.cookie}`);

  // A member is refused by the role gate, BEFORE the ceiling, and spends none of it.
  const orgBeforeMember = await bucket(orgKey(D.orgId));
  const byMember = await call('builder-portal-invite',
    { action: 'invite', email: `${EMAIL_PREFIX}by-ceiling-member@example.com`, name: 'Nope', membership_role: 'read_only' },
    dMember?.cookie);
  record('K: a member is refused (403) before the ceiling and spends none of the organisation\'s allowance',
    byMember.status === 403 && await bucket(orgKey(D.orgId)) === orgBeforeMember
      && await bucket(personKey(dMember?.userId)) === null,
    `status=${byMember.status} organisation ${orgBeforeMember}→${await bucket(orgKey(D.orgId))}`);

  // The person's ceiling, crossed by a burst.
  await q('position the owner two short of the ceiling', `
    UPDATE public.auth_rate_limits SET count = 38 WHERE bucket_key = ${sqlLit(personKey(D.userId))}`);
  const burst = [];
  for (let i = 1; i <= 2; i += 1) {
    burst.push(await call('builder-portal-invite',
      { action: 'invite', email: `${EMAIL_PREFIX}burst-${i}@example.com`, name: `Access burst ${i}`, membership_role: 'read_only' },
      D.cookie));
  }
  const refusedEmail = `${EMAIL_PREFIX}burst-3@example.com`;
  const activityInD = async () => Number((await q('D invitation activity', `
    SELECT count(*)::int AS n FROM public.builder_portal_activity_log
     WHERE organisation_id = ${id(D.orgId)}
       AND action IN ('builder_invite_sent', 'builder_invite_resent', 'builder_membership_granted')`))[0]?.n);
  const activityBefore = await activityInD();
  const orgBeforeRefusal = await bucket(orgKey(D.orgId));
  burst.push(await call('builder-portal-invite',
    { action: 'invite', email: refusedEmail, name: 'Access burst 3', membership_role: 'read_only' }, D.cookie));
  record('K: a burst is admitted up to the person\'s ceiling of 40 and refused past it',
    burst[0].status === 200 && burst[1].status === 200 && burst[2].status === 429,
    `statuses=${burst.map((b) => b.status).join(',')} person=${await bucket(personKey(D.userId))}`);
  const waitFor = Number(burst[2].json?.retry_after_seconds);
  record('K: the refusal is the shared 429, saying how long to wait',
    burst[2].status === 429 && waitFor >= 1 && waitFor <= 3600 && typeof burst[2].json?.error === 'string',
    `retry_after_seconds=${burst[2].json?.retry_after_seconds}`);
  // The function sets `Retry-After` as well. The portal's proxy forwards only
  // content-type and set-cookie, for every door alike, so it is read at the
  // function itself — one more refused request, to an address of its own.
  const directEmail = `${EMAIL_PREFIX}burst-4@example.com`;
  const direct = await call('builder-portal-invite',
    { action: 'invite', email: directEmail, name: 'Access burst 4', membership_role: 'read_only' }, D.cookie, { direct: true });
  record('K: and the function sends Retry-After, matching the body',
    direct.status === 429 && Number(direct.retryAfter) >= 1 && Number(direct.retryAfter) === direct.json?.retry_after_seconds,
    `status=${direct.status} retry-after=${direct.retryAfter} body=${direct.json?.retry_after_seconds}`);
  const trace = (await q('what the refused requests left', `
    SELECT (SELECT count(*) FROM public.builder_portal_users
             WHERE email IN (${sqlLit(refusedEmail)}, ${sqlLit(directEmail)}))::int AS accounts,
           (SELECT count(*) FROM public.builder_organisation_memberships m
              JOIN public.builder_portal_users u ON u.id = m.builder_user_id
             WHERE u.email IN (${sqlLit(refusedEmail)}, ${sqlLit(directEmail)}))::int AS memberships`))[0] ?? {};
  const activityAfter = await activityInD();
  record('K: the refused requests wrote nothing — no account, no membership, no token, no email, no activity',
    Number(trace.accounts) === 0 && Number(trace.memberships) === 0 && activityAfter === activityBefore,
    `accounts=${trace.accounts} memberships=${trace.memberships} activity ${activityBefore}→${activityAfter}`);
  record('K: a person over their own ceiling spends none of the organisation\'s',
    await bucket(orgKey(D.orgId)) === orgBeforeRefusal,
    `organisation ${orgBeforeRefusal}→${await bucket(orgKey(D.orgId))}`);

  // Resend is under the same ceiling, and the refused one re-mints nothing.
  const waiting = (await q('a waiting invitee of D', `
    SELECT u.id, u.invite_token_hash FROM public.builder_portal_users u
     WHERE u.email = ${sqlLit(addressOf('new', 1))}`))[0];
  const resent = await call('builder-portal-invite', { action: 'resend', builder_user_id: waiting?.id }, D.cookie);
  const waitingAfter = (await q('the waiting invitee after', `
    SELECT invite_token_hash FROM public.builder_portal_users WHERE id = ${id(waiting?.id)}`))[0];
  record('K: resend is under the same ceiling, and the refused resend re-minted nothing',
    resent.status === 429 && !!waiting?.invite_token_hash && waitingAfter?.invite_token_hash === waiting.invite_token_hash,
    `status=${resent.status} token ${waitingAfter?.invite_token_hash === waiting?.invite_token_hash ? 'unchanged' : 'CHANGED'}`);

  // What sends nothing is not limited.
  const stillLists = await call('builder-portal-invite', { action: 'list_members' }, D.cookie);
  const pendingToCancel = (await q('a waiting invitee to cancel', `
    SELECT id FROM public.builder_portal_users WHERE email = ${sqlLit(addressOf('new', 2))}`))[0]?.id;
  const stillCancels = await call('builder-portal-invite',
    { action: 'revoke_invite', builder_user_id: pendingToCancel }, D.cookie);
  record('K: acts that send nothing are not limited — listing members and cancelling an invitation still answer',
    stillLists.status === 200 && stillCancels.status === 200,
    `list=${stillLists.status} cancel=${stillCancels.status}`);

  // The organisation's ceiling holds for an administrator whose own allowance is untouched.
  await q('position D at its organisation ceiling', `
    UPDATE public.auth_rate_limits SET count = 100 WHERE bucket_key = ${sqlLit(orgKey(D.orgId))}`);
  const orgRefusedEmail = `${EMAIL_PREFIX}org-ceiling@example.com`;
  const byAdmin = await call('builder-portal-invite',
    { action: 'invite', email: orgRefusedEmail, name: 'Access org ceiling', membership_role: 'read_only' }, dAdmin?.cookie);
  const orgRefusedAccounts = Number((await q('what the organisation refusal left', `
    SELECT count(*)::int AS n FROM public.builder_portal_users WHERE email = ${sqlLit(orgRefusedEmail)}`))[0]?.n);
  record('K: the organisation\'s ceiling holds for a second administrator whose own allowance is untouched',
    byAdmin.status === 429 && await bucket(personKey(dAdmin?.userId)) === 1 && orgRefusedAccounts === 0,
    `status=${byAdmin.status} admin's own count=${await bucket(personKey(dAdmin?.userId))} accounts=${orgRefusedAccounts}`);

  // Another organisation is untouched by D's exhausted ceilings.
  const elsewhere = await call('builder-portal-invite',
    { action: 'invite', email: `${EMAIL_PREFIX}other-organisation@example.com`, name: 'Access elsewhere', membership_role: 'read_only' },
    E.cookie);
  record('K: another organisation is unaffected — its administrators invite as normal',
    elsewhere.status === 200 && elsewhere.text === '{"success":true}',
    `status=${elsewhere.status}`);

  // --- C. Sessions ----------------------------------------------------------------
  console.log('\nC. Sessions');
  const probe = (cookie) => call('builder-portal-verify', {}, cookie);

  const slide = await mintSession(members.manager.userId);
  await q('shorten idle', `UPDATE public.builder_portal_sessions SET idle_expires_at = now() + interval '5 minutes' WHERE id = ${id(slide.sessionId)}`);
  const slid = await probe(slide.cookie);
  const slidRow = await sessionRow(slide.cookie);
  record('C: a request slides the idle window forward to 240 minutes',
    slid.status === 200 && Number(slidRow?.idle_minutes_left) > IDLE_MINUTES - 3,
    `status ${slid.status} idle_left=${Number(slidRow?.idle_minutes_left).toFixed(1)}m`);

  const capped = await mintSession(members.manager.userId);
  await q('near cap', `UPDATE public.builder_portal_sessions
     SET absolute_expires_at = now() + interval '30 minutes', idle_expires_at = now() + interval '5 minutes'
     WHERE id = ${id(capped.sessionId)}`);
  const cappedCall = await probe(capped.cookie);
  const cappedRow = await sessionRow(capped.cookie);
  record('C: the idle window never slides past the 12 h absolute cap',
    cappedCall.status === 200 && cappedRow?.idle_at_cap === true, `idle_at_cap=${cappedRow?.idle_at_cap}`);

  const idleGone = await mintSession(members.manager.userId);
  await q('expire idle', `UPDATE public.builder_portal_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = ${id(idleGone.sessionId)}`);
  const idleCall = await probe(idleGone.cookie);
  record('C: a session idle past its window is refused', idleCall.status === 401, `status ${idleCall.status}`);

  const absGone = await mintSession(members.manager.userId);
  await q('expire absolute', `UPDATE public.builder_portal_sessions
     SET created_at = now() - interval '13 hours', absolute_expires_at = now() - interval '1 hour',
         idle_expires_at = now() - interval '1 hour'
     WHERE id = ${id(absGone.sessionId)}`);
  const absCall = await probe(absGone.cookie);
  record('C: a session past its 12 h absolute cap is refused', absCall.status === 401, `status ${absCall.status}`);

  const outSession = await mintSession(members.manager.userId);
  const logout = await call('builder-portal-logout', {}, outSession.cookie);
  const outRow = await sessionRow(outSession.cookie);
  const afterLogout = await probe(outSession.cookie);
  record('C: logout revokes the session and the cookie stops working',
    logout.status === 200 && outRow?.revoked === true && outRow?.revoked_reason === 'user_logout'
      && afterLogout.status === 401,
    `logout=${logout.status} revoked=${outRow?.revoked} reason=${outRow?.revoked_reason} after=${afterLogout.status}`);

  const deactivated = members.deactivated;
  if (deactivated) {
    const before = await probe(deactivated.cookie);
    await q('deactivate', `UPDATE public.builder_portal_users SET is_active = false, status = 'suspended' WHERE id = ${id(deactivated.userId)}`);
    const after = await probe(deactivated.cookie);
    record('C: a deactivated user loses access on their very next request',
      before.status === 200 && refused(after.status), `before=${before.status} after=${after.status}`);
  }

  const revokee = members.revokee;
  if (revokee) {
    const before = await probe(revokee.cookie);
    await q('revoke membership', `SELECT public.builder_admin_revoke_membership(NULL, 'system', ${id(revokee.membershipId)}, 'portal access proof')`);
    const after = await probe(revokee.cookie);
    const reissue = await q('reissue refused?', `
      SELECT EXISTS (SELECT 1 FROM public.builder_accessible_organisations(${id(revokee.userId)})) AS has_org`);
    record('C: a revoked membership ends access immediately and no session can be issued',
      before.status === 200 && refused(after.status) && reissue[0]?.has_org === false,
      `before=${before.status} after=${after.status} accessible_org=${reissue[0]?.has_org}`);
  }

  const cBefore = await probe(C.cookie);
  await q('suspend C', `UPDATE public.builder_organisations SET status = 'suspended', is_active = false, suspended_at = now() WHERE id = ${id(C.orgId)}`);
  const cSuspended = await probe(C.cookie);
  // Reinstating is an activation, which provisions routes again; detached in the same transaction.
  await q('reinstate C', `UPDATE public.builder_organisations SET status = 'active', is_active = true, suspended_at = NULL WHERE id = ${id(C.orgId)};
    ${detachFromNetwork(`SELECT ${id(C.orgId)}`)}`);
  const cReinstated = await probe(C.cookie);
  record('C: a suspended organisation’s members are refused, and reinstatement restores them',
    cBefore.status === 200 && refused(cSuspended.status) && cReinstated.status === 200,
    `before=${cBefore.status} suspended=${cSuspended.status} reinstated=${cReinstated.status}`);

  const admin = members.administrator;
  if (admin) {
    const newPassword = `Acc3ss!${RUN}!changed2`;
    const wrong = await call('builder-portal-change-password',
      { current_password: 'not-the-password-1A!', new_password: newPassword }, admin.cookie);
    const changed = await call('builder-portal-change-password',
      { current_password: admin.password, new_password: newPassword }, admin.cookie);
    const fresh = cookieFrom(changed.setCookies);
    const oldCall = await probe(admin.cookie);
    const newCall = fresh ? await probe(fresh) : { status: 0 };
    record('C: changing the password needs the current one, revokes old sessions and issues a new one',
      wrong.status === 401 && changed.status === 200 && oldCall.status === 401 && newCall.status === 200,
      `wrong=${wrong.status} change=${changed.status} old=${oldCall.status} new=${newCall.status} revoked=${changed.json?.sessions_revoked}`);
    admin.cookie = fresh ?? admin.cookie;
  }

  const manager = members.manager;
  if (manager) {
    const otp = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
    const other = await mintSession(manager.userId);
    await q('mint reset code', `
      UPDATE public.builder_portal_users
         SET reset_token_hash = ${sqlLit(hmacHex(PEPPER, otp))},
             reset_token_expires_at = now() + interval '15 minutes', reset_attempts = 0
       WHERE id = ${id(manager.userId)}`);
    const wrongOtp = otp === '123456' ? '654321' : '123456';
    const bad = await call('builder-portal-reset-password',
      { email: manager.email, otp: wrongOtp, new_password: `Acc3ss!${RUN}!reset9` });
    const good = await call('builder-portal-reset-password',
      { email: manager.email, otp, new_password: `Acc3ss!${RUN}!reset9` });
    const oldCall = await probe(other.cookie);
    const spent = await call('builder-portal-reset-password',
      { email: manager.email, otp, new_password: `Acc3ss!${RUN}!reset10` });
    record('C: a password reset refuses a wrong code, accepts the right one once, and revokes every session',
      bad.status === 400 && good.status === 200 && oldCall.status === 401 && spent.status === 400,
      `wrong=${bad.status} right=${good.status} old-session=${oldCall.status} replay=${spent.status}`);
  }
  const forgotUnknown = await call('builder-portal-forgot-password',
    { email: `${EMAIL_PREFIX}nobody@example.com` });
  const createdByForgot = (await q('forgot wrote?', `
    SELECT count(*) AS n FROM public.builder_portal_users WHERE email = ${sqlLit(`${EMAIL_PREFIX}nobody@example.com`)}`))[0];
  record('C: forgot-password answers an unknown address generically and writes nothing',
    forgotUnknown.status === 200 && Number(createdByForgot.n) === 0,
    `status ${forgotUnknown.status} rows=${createdByForgot.n}`);

  const noCookie = await call('builder-portal-workspace', { operation: 'workspace_summary' });
  const forged = await call('builder-portal-workspace', { operation: 'workspace_summary' },
    `__Host-builder_session_token=${randomBytes(32).toString('hex')}`);
  record('C: no cookie, and a forged cookie, are both refused 401', noCookie.status === 401 && forged.status === 401,
    `none=${noCookie.status} forged=${forged.status}`);
} catch (error) {
  crashed = error;
  record('the proof ran to completion', false, String(error?.message ?? error).slice(0, 300));
}

// --- cleanup -------------------------------------------------------------------
console.log('\nCleanup');
try {
  await cleanup('end');
  const left = await residue();
  const total = Object.values(left).reduce((sum, n) => sum + Number(n), 0);
  record('cleanup: every organisation, user, session, project, conversation, task and notification is gone',
    total === 0, JSON.stringify(left));
  const retained = (await q('retained evidence', `
    SELECT count(*) AS n FROM public.builder_portal_activity_log
    WHERE created_at > now() - interval '2 hours'
      AND (reason = 'portal access proof' OR reason = 'access proof' OR reason LIKE 'access proof%')`))[0];
  console.log(`  retained append-only activity entries for this run (evidence, by design): ${retained?.n ?? 'unknown'}`);
} catch (error) {
  record('cleanup ran', false, String(error?.message ?? error).slice(0, 300));
}

console.log('\nLatency by operation (ms: min / median / max, n)');
for (const [key, list] of Object.entries(latency).sort()) {
  const sorted = [...list].sort((a, b) => a - b);
  console.log(`  ${key.padEnd(58)} ${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]} / ${sorted.at(-1)}  n=${sorted.length}`);
}
const required = results.filter((r) => r.required);
const passed = required.filter((r) => r.ok).length;
console.log(`\n${passed} of ${required.length} required checks passed (run ${RUN})`);
console.log(requiredFailed() || crashed ? 'PORTAL ACCESS PROOF FAILED' : 'PORTAL ACCESS PROOF PASSED');
process.exit(requiredFailed() || crashed ? 1 : 0);
