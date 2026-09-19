#!/usr/bin/env node
/**
 * Production smoke tests for the Builders Network — the live flows, proven,
 * with controlled test data.
 *
 * Runs from the production-rollout workflow (phase `smoke`), because only
 * that context holds the two credentials this needs: SUPABASE_ACCESS_TOKEN
 * (Management API SQL, for seeding and asserting controlled test rows) and
 * NETWORK_SESSION_PEPPER (the same value the deploy workflow ships to the
 * functions as SESSION_TOKEN_PEPPER, so this script can mint a session
 * token / verification token whose hash the live runtime recognises).
 *
 * What it proves, over the REAL deployed surface:
 *   A. governance — session restore, the 2026-08-07 agreement with its
 *      pinned hash, the acknowledgment gate refusing a partial set,
 *      acceptance, version-exact re-recognition, onboarding, dashboard;
 *   B. invitation-only — the closed registration door, and the invite journey
 *      (the repaired regression), the verify-email token path, then the
 *      same governed journey to the dashboard;
 *   C. the active surfaces answering without schema errors;
 *   D. the Stock List — a real URL import, sources and properties lists,
 *      a selection announcement delivered through the LIVE HMAC inbound
 *      door, convergence, list, acknowledgement with its atomic outbound
 *      event, duplicate refusal;
 *   E. the transport protocol against the live door — signed round trip,
 *      tampered body refused, stale timestamp refused.
 *
 * Everything it creates carries the run's `smoke-rollout` marker and is
 * deleted at the end (the append-only activity log keeps its entries by
 * design). No secret value and no agreement text is ever printed.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const AGREEMENT_HASH = 'f5612fc2daef61ef645b43465005f411cd85979c8687cfb023f358c615e00af5';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];
const RUN = randomBytes(4).toString('hex');
const MARK = 'smoke-rollout';

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, detail, required });
  console.log(`  ${ok ? 'PASS' : required ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function q(label, sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
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

/** Call a portal function through the same-origin proxy, as the browser does. */
async function call(fn, body, cookie = null) {
  const headers = {
    'Content-Type': 'application/json',
    'x-portal-request': 'builder-portal',
    Origin: ORIGIN,
  };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${ORIGIN}/fn/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON stays null */ }
  return { status: response.status, json, setCookies: response.headers.getSetCookie?.() ?? [] };
}

const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function cleanup(stage) {
  // Order matters only where FKs RESTRICT (announcements → connection);
  // everything user- and organisation-rooted cascades. The activity log and
  // operational events keep their rows: append-only audit, by design.
  const sql = `
    DO $$
    DECLARE v_conn uuid;
    BEGIN
      FOR v_conn IN
        SELECT c.id FROM public.workspace_connections c
        JOIN public.workspace_registry w ON w.id = c.workspace_id
        WHERE w.slug LIKE '${MARK}-%'
      LOOP
        DELETE FROM public.builder_stock_selection_announcements WHERE connection_id = v_conn;
        DELETE FROM public.builder_network_outbox WHERE connection_id = v_conn;
        DELETE FROM public.builder_network_inbound_events WHERE connection_id = v_conn;
        DELETE FROM public.builder_network_stamps WHERE connection_id = v_conn;
        DELETE FROM public.workspace_connections WHERE id = v_conn;
      END LOOP;
      DELETE FROM public.workspace_registry WHERE slug LIKE '${MARK}-%';
      -- Activation-opened projects RESTRICT the organisation delete, so they
      -- go first (their access grants, parties and history CASCADE with them,
      -- and the stock item / announcement pointers SET NULL). The status
      -- history is append-only BY TRIGGER for real records; these rows are
      -- this run's own synthetic fixtures, so the trigger steps aside for
      -- exactly this one statement, inside this transaction — a failure
      -- anywhere rolls the disable back with everything else. Real project
      -- history (real projects are never deleted by any portal path) keeps
      -- its guarantee.
      ALTER TABLE public.builder_project_status_history
        DISABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN
        (SELECT id FROM public.builder_organisations WHERE legal_name LIKE 'Smoke Rollout %');
      ALTER TABLE public.builder_project_status_history
        ENABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_organisations WHERE legal_name LIKE 'Smoke Rollout %';
      DELETE FROM public.builder_portal_users WHERE email LIKE '${MARK}-%@example.com';
    END $$;`;
  await q(`cleanup (${stage})`, sql);
}

async function seedGovernedUser(tag) {
  const email = `${MARK}-${tag}-${RUN}@example.com`;
  const password = `Sm0ke!${RUN}!rollout`;
  // Mirrors what the real doors produce: register/accept-invite set
  // must_change_password=false with the password, and every door seeds the
  // onboarding checklist through builder_ensure_onboarding_steps.
  const rows = await q(`seed ${tag} user`, `
    WITH org AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES ('Smoke Rollout ${tag} ${RUN}', 'builder', 'active', true, now())
      RETURNING id
    ), person AS (
      INSERT INTO public.builder_portal_users(
        email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, 'Smoke ${tag}', 'active', true, now(), false,
              extensions.crypt(${sqlLit(password)}, extensions.gen_salt('bf', 10)))
      RETURNING id
    ), membership AS (
      INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
      SELECT person.id, org.id, 'owner', true, 'active' FROM person, org
      RETURNING id
    )
    SELECT person.id AS user_id, org.id AS org_id FROM person, org, membership`);
  const { user_id, org_id } = rows[0];
  await q(`seed ${tag} onboarding`, `SELECT public.builder_ensure_onboarding_steps(${sqlLit(user_id)}::uuid)`);
  return { email, password, userId: user_id, orgId: org_id };
}

/** A real login when Turnstile allows automation; a pepper-minted session otherwise. */
async function establishSession(user, tag = 'alpha') {
  const login = await call('builder-portal-login', { email: user.email, password: user.password });
  if (login.status === 200 && login.setCookies.some((c) => c.startsWith('__Host-builder_session_token='))) {
    const cookie = login.setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('__Host-builder_session_token='));
    record(`login (${tag}): real HTTP login issues the session cookie`, true, 'Turnstile not blocking automation');
    return { cookie, via: 'login' };
  }
  const reason = login.json?.error ?? `status ${login.status}`;
  record(`login (${tag}): posture`, true,
    `login answered "${reason}" — falling back to a pepper-minted session`, { required: false });
  if (!PEPPER) throw new Error('NETWORK_SESSION_PEPPER is not available and login did not issue a cookie — cannot establish a session');
  const token = randomBytes(32).toString('hex');
  const tokenHash = hmacHex(PEPPER, token);
  await q('mint session', `
    SELECT public.builder_issue_session(
      ${sqlLit(user.userId)}::uuid, ${sqlLit(tokenHash)},
      now() + interval '2 hours', now() + interval '2 hours',
      NULL, NULL, 'smoke-rollout')`);
  return { cookie: `__Host-builder_session_token=${token}`, via: 'minted' };
}

const requiredFailed = () => results.some((r) => r.required && !r.ok);

// ===========================================================================
console.log(`production smoke run=${RUN} origin=${ORIGIN} project=${PROJECT_REF}`);
await cleanup('start');

try { // every section below; a crash must still reach the cleanup

// --- 0. The deployed frontend is main's ------------------------------------
// The Vercel project settings are not readable from here; what IS provable
// is which code the production domain serves. `announced_at` and the join
// request card exist only in the remediation's bundle, so finding them in
// the served assets proves production tracks main past the merge.
console.log('\n0. Deployed frontend');
try {
  const page = await (await fetch(`${ORIGIN}/`)).text();
  // Entry assets from the HTML, then lazy chunks named inside the entry —
  // the strings this looks for live in code-split routes.
  const seen = new Set([...page.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]));
  let bundle = '';
  const queue = [...seen];
  while (queue.length && seen.size <= 48) {
    const path = queue.shift();
    let source = '';
    try { source = await (await fetch(`${ORIGIN}${path}`)).text(); } catch { continue; }
    bundle += source;
    for (const match of source.matchAll(/assets\/[A-Za-z0-9._-]+\.js/g)) {
      const found = `/${match[0]}`;
      if (!seen.has(found) && seen.size < 48) { seen.add(found); queue.push(found); }
    }
    if (bundle.includes('announced_at') && bundle.includes('Requests to join')) break;
  }
  record('0: the production domain serves the remediation bundle (tracks main)',
    bundle.includes('announced_at') && bundle.includes('Requests to join'),
    `assetsScanned=${seen.size} announced_at=${bundle.includes('announced_at')} joinCard=${bundle.includes('Requests to join')}`,
    { required: false });
} catch (error) {
  record('0: the production domain serves the remediation bundle (tracks main)', false,
    String(error?.message ?? error).slice(0, 120), { required: false });
}

// --- A. Existing-user governance -------------------------------------------
console.log('\nA. Existing-user governance journey');
const alpha = await seedGovernedUser('alpha');
const session = await establishSession(alpha);

let verify = await call('builder-portal-verify', {}, session.cookie);
record('A: session restore answers valid', verify.status === 200 && verify.json?.valid === true,
  `status ${verify.status}`);
record('A: governance stands at terms acceptance',
  verify.json?.governance === 'terms_acceptance_required', String(verify.json?.governance));
record('A: the current terms version is 2026-08-07',
  verify.json?.user?.current_terms_version === '2026-08-07',
  String(verify.json?.user?.current_terms_version));

const governance = await call('builder-portal-verify', { action: 'get_governance' }, session.cookie);
const terms = governance.json?.terms;
record('A: the agreement loads with the pinned document hash',
  governance.json?.success === true && terms?.version === '2026-08-07'
    && terms?.document_hash === AGREEMENT_HASH && (terms?.content_markdown?.length ?? 0) > 10_000,
  `version=${terms?.version} hash=${String(terms?.document_hash).slice(0, 12)}… length=${terms?.content_markdown?.length}`);
record('A: four mandatory onboarding steps are listed',
  Array.isArray(governance.json?.steps) && governance.json.steps.filter((s) => s.mandatory).length === 4,
  `steps=${governance.json?.steps?.length}`);

const partial = await call('builder-portal-verify',
  { action: 'accept_current_terms', acknowledgements: ALL_ACKS.slice(0, 2) }, session.cookie);
record('A: a partial acknowledgment set is refused',
  partial.status === 400 && partial.json?.code === 'ACKNOWLEDGEMENTS_INCOMPLETE',
  `status ${partial.status} code ${partial.json?.code}`);

const accept = await call('builder-portal-verify',
  { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, session.cookie);
record('A: acceptance with all four acknowledgments succeeds',
  accept.status === 200 && accept.json?.success === true && !!accept.json?.terms_version_id,
  `status ${accept.status}`);

const ackRows = await q('acceptance row', `
  SELECT jsonb_array_length(a.acknowledgements) AS acks, v.version
  FROM public.builder_terms_acceptances a
  JOIN public.builder_terms_versions v ON v.id = a.terms_version_id
  WHERE a.builder_user_id = ${sqlLit(alpha.userId)}::uuid`);
record('A: the acceptance row stores the four-key acknowledgment history',
  ackRows.length === 1 && Number(ackRows[0].acks) === 4 && ackRows[0].version === '2026-08-07',
  `rows=${ackRows.length} acks=${ackRows[0]?.acks}`);

verify = await call('builder-portal-verify', {}, session.cookie);
record('A: session restore recognises that exact version as accepted',
  verify.json?.user?.has_accepted_current_terms === true
    && verify.json?.governance === 'onboarding_required',
  `governance=${verify.json?.governance}`);

const onboarding = await call('builder-portal-verify', { action: 'complete_onboarding' }, session.cookie);
record('A: onboarding completes', onboarding.json?.success === true && onboarding.json?.onboarding_complete === true,
  `status ${onboarding.status}`);

verify = await call('builder-portal-verify', {}, session.cookie);
record('A: governance clears to the dashboard',
  verify.json?.governance === null && Object.keys(verify.json?.permissions ?? {}).length > 0,
  `governance=${String(verify.json?.governance)} permissionKeys=${Object.keys(verify.json?.permissions ?? {}).length}`);

const dashboard = await call('builder-portal-workspace', { operation: 'workspace_summary' }, session.cookie);
record('A: the dashboard summary loads', dashboard.status === 200 && !dashboard.json?.error,
  `status ${dashboard.status}`);

// --- B. Invitation-only account creation ------------------------------------
// The portal is invitation only. This section proves the public registration
// door is CLOSED and writes nothing, and that the invite → accept path is the
// one and only way an account comes to exist.
console.log('\nB. Invitation-only account creation');

// B1. The public registration door refuses, and creates nothing.
const strangerEmail = `${MARK}-stranger-${RUN}@example.com`;
const strangerOrg = `Smoke Rollout Stranger ${RUN}`;
const register = await call('builder-portal-register', {
  email: strangerEmail, password: `Reg!${RUN}!rollout9`, name: 'Uninvited Stranger',
  organisation: { legal_name: strangerOrg, org_type: 'builder' },
});
record('B: the public registration door refuses (invitation only)',
  register.status === 403 && register.json?.code === 'registration_closed',
  `status ${register.status} code ${register.json?.code}`);
const strangerRows = await q('stranger wrote nothing', `
  SELECT
    (SELECT count(*) FROM public.builder_portal_users WHERE email = ${sqlLit(strangerEmail)}) AS users,
    (SELECT count(*) FROM public.builder_organisations WHERE legal_name = ${sqlLit(strangerOrg)}) AS orgs`);
record('B: the refused registration created no user and no organisation',
  Number(strangerRows[0]?.users) === 0 && Number(strangerRows[0]?.orgs) === 0,
  `users=${strangerRows[0]?.users} orgs=${strangerRows[0]?.orgs}`);

// B2. The only way in: an owner (alpha, governed above) invites a colleague.
const inviteEmail = `${MARK}-invited-${RUN}@example.com`;
const invitePassword = `Invited!${RUN}!ok9`;
const invite = await call('builder-portal-invite', {
  action: 'invite', email: inviteEmail, name: 'Smoke Invitee', membership_role: 'member',
}, session.cookie);
record('B: an owner may invite a colleague', invite.status === 200 && invite.json?.success === true,
  `status ${invite.status}${invite.json?.error ? ` (${invite.json.error})` : ''}`);

const invited = await q('invited rows', `
  SELECT u.id AS user_id, u.status, u.is_active,
    (SELECT count(*) FROM public.builder_organisation_memberships m
      WHERE m.builder_user_id = u.id AND m.organisation_id = ${sqlLit(alpha.orgId)}::uuid
        AND m.revoked_at IS NULL) AS memberships,
    (SELECT count(*) FROM public.builder_onboarding_steps s WHERE s.builder_user_id = u.id AND s.mandatory) AS steps
  FROM public.builder_portal_users u WHERE u.email = ${sqlLit(inviteEmail)}`);
const inv = invited[0] ?? {};
const inviteUserId = inv.user_id ?? null;
record('B: the invitation created an inactive, invited user in the inviter’s organisation',
  !!inviteUserId && inv.status === 'invited' && inv.is_active === false && Number(inv.memberships) === 1,
  `status=${inv.status} active=${inv.is_active} memberships=${inv.memberships}`);
record('B: the invitation seeded the four mandatory onboarding steps',
  Number(inv.steps) === 4, `steps=${inv.steps}`);

// B3. Accepting the invitation — the token path replayed faithfully, its hash
// computed with the same pepper the deploy ships to the functions.
if (PEPPER && inviteUserId) {
  const inviteToken = `${randomUUID()}-${randomUUID()}`;
  await q('mint invite token', `
    UPDATE public.builder_portal_users
       SET invite_token_hash = ${sqlLit(hmacHex(PEPPER, inviteToken))},
           invite_token_expires_at = now() + interval '1 hour'
     WHERE id = ${sqlLit(inviteUserId)}::uuid`);
  const acceptInvite = await call('builder-portal-accept-invite', {
    action: 'accept', token: inviteToken, password: invitePassword,
  });
  const cookie = (acceptInvite.setCookies ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('__Host-builder_session_token='));
  record('B: accepting the invitation activates the account and issues a session',
    acceptInvite.status === 200 && !!cookie, `status ${acceptInvite.status}`);
  const activated = await q('activated?', `
    SELECT is_active, email_verified_at IS NOT NULL AS verified,
           invite_token_hash IS NULL AS token_cleared
    FROM public.builder_portal_users WHERE id = ${sqlLit(inviteUserId)}::uuid`);
  record('B: the accepted account is active, verified, and its invite token is spent',
    activated[0]?.is_active === true && activated[0]?.verified === true
      && activated[0]?.token_cleared === true,
    `active=${activated[0]?.is_active} verified=${activated[0]?.verified} tokenCleared=${activated[0]?.token_cleared}`);

  // B4. The invited member reaches the dashboard through the governance chain.
  if (cookie) {
    const regAccept = await call('builder-portal-verify',
      { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
    const regOnboard = await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
    const regVerify = await call('builder-portal-verify', {}, cookie);
    record('B: the invited member reaches the dashboard through terms and onboarding',
      regAccept.json?.success === true && regOnboard.json?.onboarding_complete === true
        && regVerify.json?.governance === null,
      `governance=${String(regVerify.json?.governance)}`);
  }
} else {
  record('B: invitation acceptance journey', false,
    'NETWORK_SESSION_PEPPER unavailable — invite token path cannot be replayed', { required: false });
}

// --- C. Active surfaces -----------------------------------------------------
console.log('\nC. Active portal surfaces');
const surfaces = [
  ['Dashboard', 'builder-portal-workspace', { operation: 'workspace_summary' }],
  ['Projects', 'builder-portal-projects', { operation: 'list_projects' }],
  ['Stock sources', 'builder-portal-stock', { operation: 'list_uploads' }],
  ['Stock properties', 'builder-portal-stock', { operation: 'list_stock' }],
  ['Tasks', 'builder-portal-collaboration', { operation: 'my_tasks' }],
  ['Notifications', 'builder-portal-collaboration', { operation: 'list_notifications' }],
  ['Activity', 'builder-portal-workspace', { operation: 'activity_history' }],
  ['Settings: organisation', 'builder-portal-workspace', { operation: 'get_organisation_settings' }],
  ['Settings: preferences', 'builder-portal-workspace', { operation: 'get_my_preferences' }],
  ['Settings: join requests', 'builder-portal-invite', { action: 'list_join_requests' }],
];
for (const [label, fn, body] of surfaces) {
  const response = await call(fn, body, session.cookie);
  record(`C: ${label} loads`, response.status === 200 && !response.json?.error,
    `status ${response.status}${response.json?.error ? ` (${String(response.json.error).slice(0, 80)})` : ''}`);
}

// Messages: conversations are SCOPED (project/unit/transaction/case), and a
// fresh organisation holds none of those — the page's empty state. What the
// backend must prove is that the path parses, validates and authorises
// without a schema error: a bare list is refused by NAME, and a forged
// scope id reads as out of reach, never as a 500.
const messagesBare = await call('builder-portal-collaboration',
  { operation: 'list_conversations' }, session.cookie);
const messagesForged = await call('builder-portal-collaboration',
  { operation: 'list_conversations', scope_type: 'project', scope_id: randomUUID() }, session.cookie);
record('C: Messages validates and authorises its scope (no schema errors)',
  messagesBare.status === 400 && /scope_type and scope_id/.test(String(messagesBare.json?.error))
    && [403, 404].includes(messagesForged.status),
  `bare=${messagesBare.status} forged=${messagesForged.status}`);

// --- D. Stock List ----------------------------------------------------------
console.log('\nD. Stock List');
const fixtureUrl = 'https://raw.githubusercontent.com/Naidu-Group-Pty-Ltd/aurixa-builders/main/scripts/ops/fixtures/smoke-stock.csv';
const imported = await call('builder-portal-stock', { operation: 'import_url', url: fixtureUrl }, session.cookie);
record('D: a stock list imports over the normal URL path',
  imported.status === 200 && !imported.json?.error, `status ${imported.status}${imported.json?.error ? ` (${imported.json.error})` : ''}`);

/*
 * THE SOURCE-PHOTOGRAPH GATE, ON THE LIVE DEPLOYMENT.
 *
 * This fixture is a plain CSV carrying no imagery, so under the invariant its
 * properties MUST stage and MUST NOT publish: every client-visible Builder
 * Stock property needs a ready builder-source photograph, and a first upload
 * passes the same gate a replacement does. The old expectation here — two
 * ACTIVE properties straight off an import — is exactly the behaviour the
 * invariant removed.
 */
const stagedRows = await q('imported stock', `
  SELECT
    (SELECT count(*) FROM public.builder_stock_uploads WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND deleted_at IS NULL) AS uploads,
    (SELECT count(*) FROM public.builder_stock_items WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND lifecycle_status = 'staged') AS staged,
    (SELECT count(*) FROM public.builder_stock_items WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND lifecycle_status = 'active') AS active,
    (SELECT coalesce(publication_blocked_reason, '') FROM public.builder_stock_uploads
      WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND deleted_at IS NULL LIMIT 1) AS blocked`);
record('D: a photo-less first upload stages and does NOT publish (the source-photograph gate)',
  Number(stagedRows[0]?.uploads) === 1 && Number(stagedRows[0]?.staged) === 2
    && Number(stagedRows[0]?.active) === 0,
  `uploads=${stagedRows[0]?.uploads} staged=${stagedRows[0]?.staged} active=${stagedRows[0]?.active}`);

/*
 * =====================================================================
 * D2. THE MANUAL REMEDY — the act a builder is told to perform
 * =====================================================================
 *
 * WHY THIS IS HERE. A property whose own documents name no photograph of it
 * is not this pipeline's failure and cannot be fixed by it: on the 18
 * September list, Lot 1037 links the SIBLING row's brochure twice and both
 * covers read `Lot 1307 Fuchsia Street`. The product's answer is to tell the
 * builder and give them "Add picture" — so that act is the one thing between
 * a correctable data error and a stock list that never goes live, and until
 * now nothing proved it end to end.
 *
 * THE REAL PATH, NOT A SHORTCUT. The seed below writes images with SQL to
 * exercise the cutover; this drives what the browser drives —
 * `create_builder_image`, a PUT to the signed URL it returns, then
 * `attach_builder_image` — and then waits for the ORDINARY settler to promote
 * the result. Nothing here sets `primary_image_id`, and that is the point: if
 * the requeue inside `attachBuilderImage` ever stopped happening, the picture
 * would sit in the table, correct and eligible, while the card stayed blank —
 * the failure that module's header calls the hardest to notice.
 */
const remedyRows = await q('a property the builder must act on', `
  SELECT id, primary_image_id, image_work_stage
    FROM public.builder_stock_items
   WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid
     AND lifecycle_status = 'staged' AND primary_image_id IS NULL
   ORDER BY created_at LIMIT 1`);
const remedyItemId = remedyRows[0]?.id ?? null;
record('D2: a staged property is waiting on the builder, with no picture on it',
  !!remedyItemId && !remedyRows[0]?.primary_image_id,
  remedyItemId ? `item=${String(remedyItemId).slice(0, 8)} stage=${remedyRows[0]?.image_work_stage}` : 'no staged row');

/*
 * A REAL IMAGE, BUILT RATHER THAN COMMITTED. `validateSourceImageBytes`
 * refuses anything under 512 bytes or that does not sniff as an image, and
 * the eligibility measure reads the PIXELS for overlay treatment — so this is
 * a genuine 320x240 PNG with a smooth gradient and NO text on it, which is
 * what an unannotated photograph looks like to that measure. A 1x1 placeholder
 * would be refused, and rightly.
 */
function gradientPng(width = 320, height = 240) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[at++] = Math.round((x / (width - 1)) * 180) + 40;
      raw[at++] = Math.round((y / (height - 1)) * 150) + 60;
      raw[at++] = Math.round(((x + y) / (width + height - 2)) * 120) + 90;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crcTable = gradientPng.crcTable ??= (() => {
      const table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
      return table;
    })();
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcOut = Buffer.alloc(4);
    crcOut.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcOut]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const remedyImage = gradientPng();
record('D2: the picture a builder would choose passes the stored-image floor',
  remedyImage.length > 512 && remedyImage.subarray(1, 4).toString('latin1') === 'PNG',
  `${remedyImage.length} bytes`);

const created = await call('builder-portal-stock', {
  operation: 'create_builder_image', filename: 'facade.png', stock_item_id: remedyItemId,
}, session.cookie);
const uploadUrl = created.json?.upload_url ?? null;
const storagePath = created.json?.storage_path ?? null;
record('D2: the portal issues an upload location for that one property',
  created.status === 200 && !!uploadUrl && !!storagePath,
  `status=${created.status} path=${storagePath ? 'issued' : 'none'}`);

let putStatus = 0;
if (uploadUrl) {
  const put = await fetch(uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: remedyImage,
  });
  putStatus = put.status;
}
record('D2: the bytes upload to it', putStatus >= 200 && putStatus < 300, `status=${putStatus}`);

const attached = await call('builder-portal-stock', {
  operation: 'attach_builder_image', storage_path: storagePath, stock_item_id: remedyItemId,
}, session.cookie);
record('D2: the picture is accepted for that property and no other',
  attached.status === 200 && attached.json?.scope === 'property'
    && Number(attached.json?.properties) === 1,
  `status=${attached.status} scope=${attached.json?.scope} properties=${attached.json?.properties}`);

/*
 * AND THE ORDINARY LADDER PROMOTES IT. The kick only saves wall-clock — the
 * every-minute tick would do the same — and the poll is what proves the
 * requeue happened, because nothing above touched `primary_image_id`.
 */
/*
 * THE SUPPLIED IMAGE IS READ AS ITSELF, not through `primary_image_id`.
 *
 * The first version of this joined the image via the item's primary pointer,
 * so when the pointer stayed null every downstream assertion reported empty
 * strings — which cannot tell "the picture was refused" from "the picture was
 * never considered". A check that cannot distinguish its own failure modes is
 * not a check. The row is therefore read by the path it was stored under.
 */
await q('dispatch the image workers', 'SELECT public.builder_stock_kick_image_work(NULL)');
let settledRow = null;
for (let attempt = 0; attempt < 30; attempt++) {
  const rows = await q(`remedy settle poll ${attempt}`, `
    SELECT i.primary_image_id, i.image_work_stage, i.enrichment_status,
           coalesce(i.image_work_last_result, '') AS last_result,
           im.id AS image_id, im.source_stage, im.verification_status,
           im.processing_status, im.source_provider,
           (im.upload_id IS NOT DISTINCT FROM i.upload_id) AS upload_matches,
           (im.organisation_id = i.organisation_id) AS org_matches,
           coalesce(im.source_detail ->> 'role', '') AS role,
           coalesce(im.source_detail ->> 'role_evidence_level', '') AS level,
           coalesce(im.source_detail ->> 'marketplace_eligibility_state', '') AS elig_state,
           coalesce(im.source_detail ->> 'marketplace_display_eligible', '') AS eligible,
           coalesce(im.source_detail ->> 'marketplace_eligibility_version', '') AS elig_version
      FROM public.builder_stock_items i
      LEFT JOIN public.builder_stock_item_images im
        ON im.stock_item_id = i.id AND im.storage_path = ${sqlLit(storagePath ?? '')}
     WHERE i.id = ${sqlLit(remedyItemId)}::uuid`);
  settledRow = rows[0] ?? null;
  if (settledRow?.primary_image_id && settledRow?.image_work_stage === 'settled') break;
  await new Promise((resolve) => { setTimeout(resolve, 4000); });
}
record('D2: the supplied picture is stored where the sweeps look for it',
  !!settledRow?.image_id && settledRow?.source_stage === 'uploaded_document'
    && settledRow?.verification_status === 'source_supplied'
    && settledRow?.processing_status === 'ready'
    && String(settledRow?.org_matches) !== 'false',
  `image=${settledRow?.image_id ? 'stored' : 'MISSING'} stage=${settledRow?.source_stage}`
  + ` verification=${settledRow?.verification_status} processing=${settledRow?.processing_status}`
  + ` org_matches=${settledRow?.org_matches} upload_matches=${settledRow?.upload_matches}`);
record('D2: it carries the builder\'s own level-1 role, so the sweeps will judge it',
  settledRow?.role === 'primary_property',
  `role=${settledRow?.role} evidence_level=${settledRow?.level}`);
record('D2: the eligibility sweep reached it and passed it',
  String(settledRow?.eligible) === 'true',
  `eligible=${settledRow?.eligible} state=${settledRow?.elig_state} version=${settledRow?.elig_version}`);
record('D2: the ordinary pipeline promotes it to the card — nothing here set it',
  !!settledRow?.primary_image_id && settledRow?.primary_image_id === settledRow?.image_id,
  `primary=${settledRow?.primary_image_id ? 'set' : 'null'} provider=${settledRow?.source_provider}`);
record('D2: and the property settles rather than staying in the ladder',
  settledRow?.image_work_stage === 'settled' && settledRow?.enrichment_status === 'complete',
  `stage=${settledRow?.image_work_stage} enrichment=${settledRow?.enrichment_status}`
  + ` last=${String(settledRow?.last_result).slice(0, 90)}`);

/*
 * READINESS IS A COUNT THE BUILDER READS, so it is asserted as one: the same
 * function the Stock List banner renders from, before and after.
 */
const readiness = await q('readiness recalculated', `
  SELECT total, photos_ready, failed, working, blocked_reason
    FROM public.builder_stock_image_progress(${sqlLit(alpha.orgId)}::uuid)
   WHERE published = false LIMIT 1`);
record('D2: readiness recalculates — one of two properties is now ready',
  Number(readiness[0]?.photos_ready) === 1 && Number(readiness[0]?.total) === 2,
  `${readiness[0]?.photos_ready} of ${readiness[0]?.total} ready, blocked: ${String(readiness[0]?.blocked_reason ?? '').slice(0, 80)}`);

/*
 * AND THE CUTOVER, once every property carries its builder-source photograph.
 * The images are seeded here (this suite has no builder brochure to fetch);
 * what is being proven is the live gate and the live cutover — that 100%
 * coverage publishes the whole list atomically and each property then passes
 * client visibility.
 */
// The seed and the cutover run as their own statement: a DO block followed by
// a SELECT in one Management API call answers with the DO block's empty
// result, which is not a finding about the gate.
await q('seed builder-source photographs and publish', `
  DO $$
  DECLARE v_org uuid := ${sqlLit(alpha.orgId)}::uuid; v_item record; v_img uuid; v_upload uuid;
  BEGIN
    SELECT id INTO v_upload FROM public.builder_stock_uploads
      WHERE organisation_id = v_org AND deleted_at IS NULL LIMIT 1;
    -- The remedy section above already gave one property a real picture
    -- through the builder's own path; seeding over it would erase the one
    -- thing that proved the requeue.
    FOR v_item IN SELECT id FROM public.builder_stock_items
      WHERE organisation_id = v_org AND lifecycle_status = 'staged'
        AND primary_image_id IS NULL
    LOOP
      /*
       * Measured-eligible and SETTLED, so the live settler does not claim these
       * rows mid-assertion and demote a primary it cannot vouch for. Without
       * that the check races the real pipeline: it read active=2, published=true
       * and visible=1 because a worker had already re-judged one row.
       */
      INSERT INTO public.builder_stock_item_images
        (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
         verification_status, processing_status, storage_path, source_detail)
      VALUES (v_org, v_item.id, v_upload, 'uploaded_document', 'smoke-brochure#page1',
         'source_supplied', 'ready', 'smoke/' || v_item.id || '.jpg',
         jsonb_build_object(
           'role', 'primary_property',
           'marketplace_measured', true,
           'marketplace_display_eligible', true,
           'marketplace_eligibility_state', 'eligible'))
      RETURNING id INTO v_img;
      UPDATE public.builder_stock_items
         SET primary_image_id = v_img, image_work_stage = 'settled',
             enrichment_status = 'complete', enriched_at = now()
       WHERE id = v_item.id;
    END LOOP;
    PERFORM public.publish_builder_stock_upload(v_upload);
  END $$;`);
const publishRows = await q('publication outcome', `
  SELECT
    (SELECT count(*) FROM public.builder_stock_items WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND lifecycle_status = 'active') AS active,
    (SELECT count(*) FROM public.builder_stock_items i WHERE i.organisation_id = ${sqlLit(alpha.orgId)}::uuid
       AND public.builder_stock_item_client_visible(i.id)) AS visible,
    (SELECT (published_at IS NOT NULL) FROM public.builder_stock_uploads
      WHERE organisation_id = ${sqlLit(alpha.orgId)}::uuid AND deleted_at IS NULL LIMIT 1) AS published`);
record('D: 100% builder-source coverage publishes the list atomically, each property client-visible',
  Number(publishRows[0]?.active) === 2 && Number(publishRows[0]?.visible) === 2
    // The Management API answers JSON, so a boolean arrives as true — not the
    // 't' psql prints. Accept both spellings of the same fact.
    && ['true', 't'].includes(String(publishRows[0]?.published)),
  `active=${publishRows[0]?.active} visible=${publishRows[0]?.visible} published=${publishRows[0]?.published}`);

const uploadsList = await call('builder-portal-stock', { operation: 'list_uploads' }, session.cookie);
const itemsList = await call('builder-portal-stock', { operation: 'list_stock' }, session.cookie);
record('D: sources and properties list over HTTP',
  (uploadsList.json?.records?.length ?? 0) >= 1 && (itemsList.json?.records?.length ?? 0) === 2,
  `sources=${uploadsList.json?.records?.length} properties=${itemsList.json?.records?.length}`);
const smokeItemId = itemsList.json?.records?.[0]?.id ?? null;

// A controlled workspace connection for the announcement round trip.
const connectionRows = await q('seed connection', `
  WITH workspace AS (
    INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
    VALUES (gen_random_uuid(), '${MARK}-${RUN}', 'Smoke Rollout Workspace')
    RETURNING id
  )
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  SELECT workspace.id, ${sqlLit(alpha.orgId)}::uuid, 'active', 'workspace', now(),
         encode(extensions.gen_random_bytes(32), 'hex')
  FROM workspace
  RETURNING id`);
const connectionId = connectionRows[0].id;
const secretRows = await q('read connection secret', `
  SELECT outbound_hmac_secret FROM public.workspace_connections WHERE id = ${sqlLit(connectionId)}::uuid`);
const connectionSecret = secretRows[0].outbound_hmac_secret; // held in memory; never printed

// --- E interleaved: the LIVE transport round trip --------------------------
console.log('\nE. HMAC transport against the live inbound door');
const remoteRef = randomUUID();
const envelope = JSON.stringify({
  event_type: 'stock.selection.announced',
  dedupe_key: `${MARK}:${RUN}:announce:1`,
  payload: {
    remote_selection_ref: remoteRef,
    stock_item_id: smokeItemId,
    status: 'selected',
    remote_client_label: 'Smoke buyer',
    // The authorised agency disclosure, exercised over the real wire.
    agency: {
      name: 'Smoke Agency Group',
      contact_name: 'Ava Smoke',
      contact_email: 'ava@smoke.example',
      contact_phone: '03 9000 0000',
    },
  },
  source_version: 1,
});
async function deliver(body, { timestamp, signature } = {}) {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = signature ?? hmacHex(connectionSecret, `${ts}.${body}`);
  const response = await fetch(`${FUNCTIONS_BASE}/builder-network-inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-aurixa-connection': connectionId,
      'x-aurixa-timestamp': ts,
      'x-aurixa-signature': sig,
    },
    body,
  });
  let json = null;
  try { json = await response.json(); } catch { /* keep null */ }
  return { status: response.status, json };
}

const delivered = await deliver(envelope);
record('E: a signed delivery is accepted by the live door',
  delivered.status === 200 && delivered.json?.accepted === true, `status ${delivered.status}`);
const redelivered = await deliver(envelope);
record('E: a redelivery answers the duplicate acknowledgement',
  redelivered.status === 200 && redelivered.json?.duplicate === true, `status ${redelivered.status}`);
const tampered = await deliver(envelope.replace('"source_version":1', '"source_version":2'),
  { signature: hmacHex(connectionSecret, `${Math.floor(Date.now() / 1000)}.${envelope}`) });
record('E: a tampered body is refused', tampered.status === 401, `status ${tampered.status}`);
const stale = await deliver(envelope, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
record('E: a stale timestamp is refused', stale.status === 401, `status ${stale.status}`);
const adminProbe = await fetch(`${FUNCTIONS_BASE}/builder-network-admin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-assertion' },
  body: JSON.stringify({ operation: 'overview' }),
});
record('E: the operator door refuses a forged federation assertion',
  [401, 503].includes(adminProbe.status),
  `status ${adminProbe.status} (503 would mean federation is not yet configured)`, { required: false });

// --- D continued: convergence, list, atomic acknowledgement ------------------
await q('deterministic sweep', 'SELECT * FROM public.builder_network_apply_inbound_events(50)');
const converged = await q('announcement row', `
  SELECT id, status, organisation_id FROM public.builder_stock_selection_announcements
  WHERE connection_id = ${sqlLit(connectionId)}::uuid AND remote_selection_ref = ${sqlLit(remoteRef)}::uuid`);
record('D: the announcement converged into the domain table',
  converged.length === 1 && converged[0].status === 'selected' && converged[0].organisation_id === alpha.orgId,
  `status=${converged[0]?.status}`);
const announcementId = converged[0]?.id ?? null;

// The activation opened a PROJECT: the working record, granted to the team,
// linked from the stock item — created inside the same convergence sweep.
const projectRows = await q('activation project', `
  SELECT a.activation_project_id AS project_id, p.status, p.name,
         p.builder_organisation_id,
         (SELECT count(*) FROM public.builder_project_access g
          WHERE g.project_id = a.activation_project_id AND g.revoked_at IS NULL) AS grants,
         (SELECT i.builder_project_id FROM public.builder_stock_items i
          WHERE i.id = a.stock_item_id) AS linked_item_project
  FROM public.builder_stock_selection_announcements a
  LEFT JOIN public.builder_projects p ON p.id = a.activation_project_id
  WHERE a.id = ${sqlLit(announcementId)}::uuid`);
const activationProject = projectRows[0] ?? {};
record('D: the activation opened a project granted to the team',
  !!activationProject.project_id && activationProject.status === 'planning'
    && activationProject.builder_organisation_id === alpha.orgId
    && Number(activationProject.grants) >= 1
    && activationProject.linked_item_project === activationProject.project_id,
  `project=${activationProject.project_id ? 'opened' : 'MISSING'} status=${activationProject.status} grants=${activationProject.grants}`);

const projectDetail = await call('builder-portal-projects',
  { operation: 'get_project', project_id: activationProject.project_id }, session.cookie);
record('D: the project record serves the property and the agency contact over HTTP',
  projectDetail.status === 200
    && projectDetail.json?.project?.id === activationProject.project_id
    && projectDetail.json?.activation?.agency_name === 'Smoke Agency Group'
    && projectDetail.json?.activation?.contact_email === 'ava@smoke.example'
    && projectDetail.json?.activation?.status === 'selected'
    && projectDetail.json?.stock_item?.id === smokeItemId,
  `status ${projectDetail.status} agency=${projectDetail.json?.activation?.agency_name} item=${projectDetail.json?.stock_item?.id ? 'attached' : 'missing'}`);

const selections = await call('builder-portal-stock', { operation: 'list_selections' }, session.cookie);
const listed = (selections.json?.records ?? []).find((r) => r.remote_selection_ref === remoteRef);
record('D: the Builder Stock List shows the selection',
  !!listed && listed.status === 'selected' && listed.workspace_label === 'Smoke Rollout Workspace'
    && listed.remote_client_label === 'Smoke buyer',
  `listed=${!!listed} workspace=${listed?.workspace_label}`);
record('D: the Stock List row carries the agency disclosure',
  listed?.agency_name === 'Smoke Agency Group'
    && listed?.agency_contact?.contact_email === 'ava@smoke.example',
  `agency=${listed?.agency_name}`);

// The fan-out's surfaces, read exactly as the portal reads them: the member's
// notifications and tasks, with the LIVE activation context resolved.
const notificationsList = await call('builder-portal-collaboration',
  { operation: 'list_notifications' }, session.cookie);
const activationNotice = (notificationsList.json?.records ?? [])
  .find((r) => r.activation?.announcement_id === announcementId);
record('D: the activation reached Notifications with the resolved context',
  !!activationNotice
    && activationNotice.notification_type === 'stock_selection'
    && !!activationNotice.activation?.property_label
    && activationNotice.activation?.agency_name === 'Smoke Agency Group'
    && activationNotice.activation?.contact_email === 'ava@smoke.example'
    && activationNotice.activation?.status === 'selected'
    && activationNotice.activation?.project_id === activationProject.project_id,
  `notice=${!!activationNotice} property=${activationNotice?.activation?.property_label} project=${activationNotice?.activation?.project_id ? 'linked' : 'missing'}`);

const tasksBefore = await call('builder-portal-collaboration',
  { operation: 'my_tasks' }, session.cookie);
const activationTask = (tasksBefore.json?.records ?? [])
  .find((t) => t.activation?.announcement_id === announcementId);
record('D: the activation opened a pending task assigned to the member',
  !!activationTask && activationTask.status === 'open' && activationTask.priority === 'high'
    && activationTask.scope_type === 'stock_item'
    && activationTask.activation?.contact_email === 'ava@smoke.example'
    && activationTask.activation?.project_id === activationProject.project_id,
  `task=${!!activationTask} status=${activationTask?.status} project=${activationTask?.activation?.project_id ? 'linked' : 'missing'}`);

const acknowledge = await call('builder-portal-stock',
  { operation: 'acknowledge_selection', selection_id: announcementId }, session.cookie);
record('D: acknowledgement commits over HTTP',
  acknowledge.status === 200 && acknowledge.json?.record?.status === 'builder_acknowledged',
  `status ${acknowledge.status}`);

const outbox = await q('outbound event', `
  SELECT count(*) AS events,
    (SELECT source_version FROM public.builder_network_stamps
     WHERE connection_id = ${sqlLit(connectionId)}::uuid AND side = 'outbound') AS outbound_version
  FROM public.builder_network_outbox
  WHERE connection_id = ${sqlLit(connectionId)}::uuid
    AND event_type = 'stock.selection.acknowledged'
    AND dedupe_key = ${sqlLit(`stock.selection.acknowledged:${connectionId}:${remoteRef}`)}`);
record('D: the outbound event committed atomically with the stamp',
  Number(outbox[0]?.events) === 1 && Number(outbox[0]?.outbound_version) >= 1,
  `events=${outbox[0]?.events} outboundVersion=${outbox[0]?.outbound_version}`);

const duplicateAck = await call('builder-portal-stock',
  { operation: 'acknowledge_selection', selection_id: announcementId }, session.cookie);
record('D: a duplicate acknowledgement is refused without a second event',
  duplicateAck.status === 409 && duplicateAck.json?.code === 'not_acknowledgeable',
  `status ${duplicateAck.status}`);

const tasksAfter = await call('builder-portal-collaboration',
  { operation: 'my_tasks' }, session.cookie);
const closedTask = (tasksAfter.json?.records ?? [])
  .find((t) => t.activation?.announcement_id === announcementId);
record('D: acknowledging completed the activation task',
  !!closedTask && closedTask.status === 'done'
    && closedTask.activation?.status === 'builder_acknowledged',
  `status=${closedTask?.status} activation=${closedTask?.activation?.status}`);

// --- F. Builder brochure → Cloudflare PDF worker → Aurixa verification ------
/*
 * WHAT THIS SECTION EXISTS TO PROVE, AND WHY NOTHING ELSE ALREADY DID.
 *
 * The worker itself is proven by its own canary, which drives the deployed
 * bundle directly. What that cannot show is the half in between: that a
 * document arriving through the PORTAL reaches Cloudflare at all — import →
 * settlement → `runElection` → `electionRoute` → `pdfElectionClient` → the
 * worker → back into Aurixa's verification. Section D seeds its photographs
 * with SQL and says so in its own comment ("this suite has no builder brochure
 * to fetch"). This is that brochure.
 *
 * A LINKED BROCHURE, NOT AN UPLOADED ONE, and the reason is not convenience.
 * A PDF uploaded as a stock LIST has its rows recovered by a model
 * (`runImport` → `modelExtract`), and no model credential is configured on
 * this project — the upload would fail at row extraction long before any
 * image work. A CSV row carrying a brochure URL is both the dominant
 * production shape (linked packages are most of the live library) and the one
 * that reaches the election without a model in the way.
 *
 * SIZE IS NOT WHAT SENDS IT TO THE WORKER, which is worth stating because it
 * is easy to assume otherwise. `electionRoute` reads exactly three things —
 * `runtimeVersion`, `endpoint`, `token` — and no byte count. With
 * RUNTIME_VERSION past WORKER_RUNTIME_VERSION and both secrets configured,
 * EVERY document goes to the worker. The heavy-CPU case is proven separately,
 * at 8.6 MB, by the worker's own canary; what is proven here is the path.
 */
console.log('\nF. Builder brochure → Cloudflare PDF worker → Aurixa verification');

const BROCHURE_CSV = 'https://raw.githubusercontent.com/Naidu-Group-Pty-Ltd/aurixa-builders'
  + '/main/scripts/ops/fixtures/smoke-stock-brochure.csv';
const BROCHURE_PDF = 'https://raw.githubusercontent.com/Naidu-Group-Pty-Ltd/aurixa-builders'
  + '/main/workers/builder-stock-pdf-worker/scripts/fixtures/lot-717-enzo-brochure.pdf';

/*
 * THE LEDGER LINE BEFORE, so "a fresh row" is a difference and not a reading.
 * `meteredFetch` writes one row per worker call with the credential that paid
 * for it, and that row is the evidence this section turns on.
 */
const [fBaseline] = await q('worker usage and blast-radius baseline', `
  SELECT now() AS started_at,
         (SELECT count(*) FROM public.api_usage_log
           WHERE service_name = 'builderstockpdfworker') AS worker_calls,
         (SELECT count(*) FROM public.builder_stock_items
           WHERE organisation_id <> ${sqlLit(alpha.orgId)}::uuid) AS non_smoke_items`);
const workerUsageBefore = Number(fBaseline?.worker_calls ?? 0);

// The document must actually be fetchable by the production importer, or a
// failure here would look like a worker fault rather than a fixture fault.
const brochureHead = await fetch(BROCHURE_PDF, { method: 'GET' });
const brochureBytes = brochureHead.ok
  ? (await brochureHead.arrayBuffer()).byteLength : 0;
record('F: the brochure fixture is publicly retrievable by the importer',
  brochureHead.ok && brochureBytes > 100_000,
  `HTTP ${brochureHead.status}, ${brochureBytes} bytes`);

// --- 1. Real import, through the normal portal endpoint ---------------------
const brochureImport = await call('builder-portal-stock',
  { operation: 'import_url', url: BROCHURE_CSV }, session.cookie);
record('F1: the brochure stock list imports over the normal portal path',
  brochureImport.status === 200 && !brochureImport.json?.error,
  `status ${brochureImport.status}${brochureImport.json?.error ? ` (${brochureImport.json.error})` : ''}`);

const [brochureRow] = await q('the imported brochure row', `
  SELECT u.id AS upload_id, u.original_filename, u.byte_size,
         it.id AS item_id, it.lifecycle_status, it.image_work_stage,
         it.organisation_id, it.lot_number,
         (it.source_row::text ILIKE '%lot-717-enzo-brochure.pdf%') AS row_carries_the_link
    FROM public.builder_stock_uploads u
    JOIN public.builder_stock_items it ON it.upload_id = u.id
   WHERE u.organisation_id = ${sqlLit(alpha.orgId)}::uuid
     AND u.original_filename ILIKE '%brochure%'
     AND u.deleted_at IS NULL
   ORDER BY it.created_at DESC LIMIT 1`);

record('F1: the import created exactly one smoke property carrying the brochure link',
  Boolean(brochureRow?.item_id) && brochureRow?.row_carries_the_link === true
    && String(brochureRow?.lot_number) === '717',
  `upload=${brochureRow?.upload_id} item=${brochureRow?.item_id} lot=${brochureRow?.lot_number}`);

// --- 2. Claimability, through the REAL work queue ---------------------------
/*
 * The predicate below is `claim_builder_stock_image_work`'s own, restated
 * against this row. It is asserted rather than assumed because the last
 * attempt at an end-to-end proof died on exactly this: the candidate property
 * was `archived`, which the claim excludes, so no mutation could ever have
 * produced an election. Nothing here forces the row into the election
 * function by hand — it has to be claimable on the queue's terms.
 */
record('F2: the smoke property is claimable by the real image work queue',
  ['active', 'staged'].includes(String(brochureRow?.lifecycle_status))
    && !['settled', 'failed'].includes(String(brochureRow?.image_work_stage))
    && String(brochureRow?.organisation_id) === String(alpha.orgId),
  `lifecycle=${brochureRow?.lifecycle_status} stage=${brochureRow?.image_work_stage}`);

// --- 3. Drive the settlement the way the browser does -----------------------
/*
 * `enrich_images` is what the Stock List page calls in a loop after an import.
 * Its phase 0 settles the builder's own source imagery, and that is the call
 * chain that reaches the election. Driving the real endpoint is the point:
 * invoking the settler or the election directly would prove the worker, which
 * is already proven, and not the path.
 */
let settleRounds = 0;
let lastEnrich = null;
const settleDeadline = Date.now() + 180_000;
while (Date.now() < settleDeadline && settleRounds < 12) {
  settleRounds += 1;
  lastEnrich = await call('builder-portal-stock',
    { operation: 'enrich_images', upload_id: brochureRow?.upload_id }, session.cookie);
  if (lastEnrich.status !== 200) break;
  if (Number(lastEnrich.json?.source_images_outstanding ?? 0) === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
record('F3: the portal settled the upload\'s source imagery',
  lastEnrich?.status === 200 && Number(lastEnrich?.json?.source_images_outstanding ?? -1) === 0,
  `rounds=${settleRounds} status=${lastEnrich?.status} outstanding=${lastEnrich?.json?.source_images_outstanding}`);

// --- 4 & 10. The worker was exercised, on its own credential ----------------
/*
 * THE STRONGEST EVIDENCE THE ARCHITECTURE ALREADY PRODUCES. `pdfElectionClient`
 * calls the worker through `meteredFetch` naming
 * `BUILDER_STOCK_PDF_WORKER_TOKEN`, so a successful call writes a row whose
 * credential, host, HTTP status and round-trip time are all recorded. An image
 * appearing is NOT evidence of the worker — the in-process path produces one
 * too. This row is, because only the worker call writes it.
 */
const [workerCall] = await q('the worker call in the ledger', `
  SELECT id, service_name, endpoint, status, response_time_ms, created_at,
         metadata->>'secret_name' AS secret_name,
         metadata->>'host'        AS host,
         metadata->>'purpose'     AS purpose,
         metadata->>'http_status' AS http_status
    FROM public.api_usage_log
   WHERE service_name = 'builderstockpdfworker'
   ORDER BY created_at DESC LIMIT 1`);
const workerUsageAfter = Number((await q('worker usage after', `
  SELECT count(*) AS n FROM public.api_usage_log
   WHERE service_name = 'builderstockpdfworker'`))[0]?.n ?? 0);

record('F4: a FRESH worker call was recorded against the worker credential',
  workerUsageAfter > workerUsageBefore
    && workerCall?.secret_name === 'BUILDER_STOCK_PDF_WORKER_TOKEN',
  `before=${workerUsageBefore} after=${workerUsageAfter} secret=${workerCall?.secret_name}`);

record('F4: the call went to builder-stock-pdf-worker on Cloudflare, and it answered 200',
  String(workerCall?.host ?? '').includes('builder-stock-pdf-worker')
    && String(workerCall?.host ?? '').includes('workers.dev')
    && String(workerCall?.http_status) === '200'
    && workerCall?.status === 'success',
  `host=${workerCall?.host} http=${workerCall?.http_status} ${workerCall?.response_time_ms}ms`);

record('F4: it was the package-cover election that made the call',
  workerCall?.endpoint === 'builder-stock/pdf-election'
    && workerCall?.purpose === 'package_cover_election',
  `endpoint=${workerCall?.endpoint} purpose=${workerCall?.purpose}`);

// --- 5-9. The result came back through Aurixa's own verification ------------
const [elected] = await q('the elected image', `
  SELECT img.id, img.source_stage, img.source_provider, img.source_reference,
         img.verification_status, img.content_type, img.byte_size,
         img.source_detail->>'stored_sha256' AS stored_sha256,
         img.source_detail->>'source_sha256' AS source_sha256,
         img.source_detail->>'page'                AS page,
         img.source_detail->>'method'              AS method,
         img.source_detail->>'role'                AS role,
         img.source_detail->>'role_evidence_level' AS role_evidence_level,
         img.source_detail->>'role_evidence'       AS role_evidence,
         it.primary_image_id = img.id        AS is_primary,
         it.lifecycle_status
    FROM public.builder_stock_item_images img
    JOIN public.builder_stock_items it ON it.id = img.stock_item_id
   WHERE it.id = ${sqlLit(brochureRow?.item_id ?? '00000000-0000-0000-0000-000000000000')}::uuid
     AND img.source_stage = 'uploaded_document'
   ORDER BY img.created_at DESC LIMIT 1`);

record('F5: Aurixa stored an image elected out of the builder\'s own document',
  elected?.source_stage === 'uploaded_document' && Number(elected?.byte_size) > 10_000,
  `provider=${elected?.source_provider} ${elected?.byte_size} bytes ${elected?.content_type}`);

record('F6: the image is the builder\'s own bytes — source and stored hashes agree',
  Boolean(elected?.stored_sha256) && elected?.stored_sha256 === elected?.source_sha256,
  `${String(elected?.stored_sha256 ?? '').slice(0, 16)}…`);

record('F7: provenance names the page it was cut from',
  String(elected?.page) === '1' && String(elected?.source_reference ?? '').includes('page1'),
  `page=${elected?.page} ref=${elected?.source_reference}`);

/*
 * THE GATE IS STILL IN CHARGE. The worker returns evidence; what may lead a
 * card is Aurixa's decision, and `primary_property` is the only role it will
 * draw. A floorplan, a masterplan or a location map coming back from the same
 * call would be stored and refused — which is the rule this asserts.
 */
record('F8: Aurixa\'s own rules assigned the role, and it is the one a card may draw',
  elected?.role === 'primary_property' && elected?.is_primary === true,
  `role=${elected?.role} primary=${elected?.is_primary}`);

/*
 * AND THE ROLE IS EARNED, not defaulted. `role_evidence_level` is the strength
 * the DOCUMENT stated the hero with — lower is stronger, 2 being a
 * single-property package cover carrying the property's identity and its
 * package facts. A role arriving with no level, or at the weakest level, would
 * mean the picture leads a card on nothing the document actually said.
 */
record('F8: the role was earned at a stated evidence level, with the evidence recorded',
  Number(elected?.role_evidence_level) >= 1 && Number(elected?.role_evidence_level) <= 3
    && String(elected?.role_evidence ?? '').length > 20,
  `level=${elected?.role_evidence_level} evidence="${String(elected?.role_evidence ?? '').slice(0, 90)}"`);

record('F9: the publication gate remains in control of the property',
  ['active', 'staged'].includes(String(elected?.lifecycle_status)),
  `lifecycle=${elected?.lifecycle_status}`);

// --- 11. Nothing outside the smoke organisation moved ----------------------
const [blast] = await q('no customer property was touched', `
  SELECT
    (SELECT count(*) FROM public.builder_stock_items
      WHERE organisation_id <> ${sqlLit(alpha.orgId)}::uuid
        AND updated_at > ${sqlLit(fBaseline?.started_at ?? '1970-01-01')}::timestamptz)
      AS non_smoke_items_touched,
    (SELECT count(*) FROM public.builder_stock_items
      WHERE organisation_id <> ${sqlLit(alpha.orgId)}::uuid) AS non_smoke_items_now`);
/*
 * SINCE THIS SECTION BEGAN, not over a rolling window: a person using the
 * portal during the run would move a customer row for reasons that have
 * nothing to do with this test, and a window wide enough to be safe is also
 * wide enough to be meaningless. The count is compared too, so a row that
 * appeared or vanished is caught even if its timestamp did not move.
 */
record('F11: no property outside the smoke organisation was modified',
  Number(blast?.non_smoke_items_touched) === 0
    && Number(blast?.non_smoke_items_now) === Number(fBaseline?.non_smoke_items),
  `touched=${blast?.non_smoke_items_touched} count ${fBaseline?.non_smoke_items}→${blast?.non_smoke_items_now}`);

} catch (error) {
  record('smoke run aborted before completing every section', false,
    String(error?.message ?? error).slice(0, 300));
}

// ---------------------------------------------------------------------------
await cleanup('end');
const leftovers = await q('leftover check', `
  SELECT
    (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE '${MARK}-%@example.com') AS users,
    (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE 'Smoke Rollout %') AS orgs,
    (SELECT count(*) FROM public.workspace_registry WHERE slug LIKE '${MARK}-%') AS workspaces`);
record('cleanup: no smoke rows remain',
  Number(leftovers[0]?.users) === 0 && Number(leftovers[0]?.orgs) === 0 && Number(leftovers[0]?.workspaces) === 0,
  JSON.stringify(leftovers[0] ?? {}));

console.log('\n================ smoke summary ================');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : r.required ? 'FAIL' : 'note'}  ${r.name}`);
const failed = results.filter((r) => r.required && !r.ok);
console.log(`\n${results.length} checks, ${failed.length} required failure(s).`);
process.exit(failed.length ? 1 : 0);
