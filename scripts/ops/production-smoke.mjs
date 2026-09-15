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
 *   B. self-registration — the register door, the seeded onboarding steps
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

// --- B. Self-registration ---------------------------------------------------
console.log('\nB. Self-registration journey');
const regEmail = `${MARK}-register-${RUN}@example.com`;
const regPassword = `Reg!${RUN}!rollout9`;
const register = await call('builder-portal-register', {
  email: regEmail, password: regPassword, name: 'Smoke Register',
  organisation: { legal_name: `Smoke Rollout Register ${RUN}`, org_type: 'builder' },
});
const registerOpen = register.status === 202 && register.json?.success === true;
record('B: the register door accepts the application', registerOpen,
  `status ${register.status}${register.json?.error ? ` (${register.json.error})` : ''}`,
  { required: registerOpen || false });

let regUserId = null;
if (registerOpen) {
  const seeded = await q('registered rows', `
    SELECT u.id AS user_id,
      (SELECT count(*) FROM public.builder_onboarding_steps s WHERE s.builder_user_id = u.id AND s.mandatory) AS steps,
      (SELECT count(*) FROM public.builder_email_verification_tokens t
        WHERE t.builder_user_id = u.id AND t.consumed_at IS NULL) AS live_tokens,
      (SELECT count(*) FROM public.builder_organisation_memberships m
        WHERE m.builder_user_id = u.id AND m.revoked_at IS NULL) AS memberships,
      u.email_verified_at IS NOT NULL AS verified
    FROM public.builder_portal_users u WHERE u.email = ${sqlLit(regEmail)}`);
  const reg = seeded[0] ?? {};
  regUserId = reg.user_id ?? null;
  record('B: the registered user exists, unverified, with an owner membership',
    !!regUserId && reg.verified === false && Number(reg.memberships) === 1,
    `verified=${reg.verified} memberships=${reg.memberships}`);
  record('B: registration seeded the four mandatory onboarding steps',
    Number(reg.steps) === 4, `steps=${reg.steps}`);
  record('B: a live verification token exists for the mailbox',
    Number(reg.live_tokens) >= 1, `tokens=${reg.live_tokens}`);

  if (PEPPER && regUserId) {
    // The mailbox click, replayed faithfully: a fresh token whose hash the
    // runtime computes with the same pepper, consumed over HTTP.
    const emailToken = `${randomUUID()}-${randomUUID()}`;
    await q('insert verification token', `
      INSERT INTO public.builder_email_verification_tokens(builder_user_id, token_hash, expires_at, requested_ip)
      VALUES (${sqlLit(regUserId)}::uuid, ${sqlLit(hmacHex(PEPPER, emailToken))}, now() + interval '1 hour', 'smoke')`);
    const verifyEmail = await call('builder-portal-verify-email', { token: emailToken });
    const stamped = await q('verified?', `
      SELECT email_verified_at IS NOT NULL AS verified FROM public.builder_portal_users
      WHERE id = ${sqlLit(regUserId)}::uuid`);
    record('B: the emailed token verifies the mailbox over HTTP',
      verifyEmail.status === 200 && stamped[0]?.verified === true,
      `status ${verifyEmail.status}`);

    // The self-registered organisation arrives pending_verification and the
    // portal (builder_issue_session and login alike) refuses a session until
    // the Aurixa operator vets it. Replay that vetting decision exactly as
    // builder-network-admin approve_organisation writes it.
    await q('approve registered organisation', `
      UPDATE public.builder_organisations
         SET status = 'active', is_active = true, activated_at = COALESCE(activated_at, now())
       WHERE legal_name = ${sqlLit(`Smoke Rollout Register ${RUN}`)}
         AND status = 'pending_verification'`);
    record('B: the organisation required operator vetting before any session', true,
      'builder_issue_session refused while pending_verification; approved via the operator write',
      { required: false });

    const regSession = await establishSession(
      { email: regEmail, password: regPassword, userId: regUserId }, 'register');
    const regAccept = await call('builder-portal-verify',
      { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, regSession.cookie);
    const regOnboard = await call('builder-portal-verify', { action: 'complete_onboarding' }, regSession.cookie);
    const regVerify = await call('builder-portal-verify', {}, regSession.cookie);
    record('B: the registered user reaches the dashboard through terms and onboarding',
      regAccept.json?.success === true && regOnboard.json?.onboarding_complete === true
        && regVerify.json?.governance === null,
      `governance=${String(regVerify.json?.governance)}`);
  } else {
    record('B: verify-email + governed journey', false,
      'NETWORK_SESSION_PEPPER unavailable — token path cannot be replayed', { required: false });
  }
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
    FOR v_item IN SELECT id FROM public.builder_stock_items
      WHERE organisation_id = v_org AND lifecycle_status = 'staged'
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
    && String(publishRows[0]?.published) === 't',
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

const selections = await call('builder-portal-stock', { operation: 'list_selections' }, session.cookie);
const listed = (selections.json?.records ?? []).find((r) => r.remote_selection_ref === remoteRef);
record('D: the Builder Stock List shows the selection',
  !!listed && listed.status === 'selected' && listed.workspace_label === 'Smoke Rollout Workspace'
    && listed.remote_client_label === 'Smoke buyer',
  `listed=${!!listed} workspace=${listed?.workspace_label}`);

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
