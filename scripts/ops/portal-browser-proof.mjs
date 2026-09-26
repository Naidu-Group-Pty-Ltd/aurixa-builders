#!/usr/bin/env node
/**
 * ===========================================================================
 * THE BUILDER PORTAL, LOOKED AT — AN AUTHENTICATED BROWSER ON THE LIVE SITE.
 * ===========================================================================
 *
 * Every other proof speaks to the portal's functions. This one opens the
 * deployed site in a real Chromium, signed in as a builder of a proof
 * organisation of its own, and looks at what a person sees:
 *
 *   1. every live route renders signed in — no bounce to the login page, no
 *      uncaught page error, a heading on the page — at desktop width, and the
 *      main pages again at phone width without sideways scrolling;
 *   2. the retired `/builder/agencies` bookmarks land on Agency Activations
 *      and Messages, and a withdrawn section says so;
 *   3. an open project conversation shows a colleague's reply WITHOUT a
 *      reload, timed from the send;
 *   4. the newer-build banner appears when the site serves a different build.
 *
 * Screenshots are written to `proof-artifacts/` and uploaded by the workflow.
 * The organisation is detached from every workspace in the transaction that
 * creates it; everything is deleted and counted at the end.
 *
 * Runs from the production-rollout workflow (phase `portal-browser-proof`).
 * No secret, token or password is printed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RUN = randomBytes(4).toString('hex');
const MARK = 'smoke-rollout';
const TAG = 'browser';
const ORG_NAME = `Smoke Rollout ${TAG} ${RUN}`;
const OUT = 'proof-artifacts';
const ALL_ACKS = [
  'global_confidentiality_privacy', 'authority_binding_acceptance',
  'portal_access', 'binding_amlctf_arrangement',
];

if (!ACCESS_TOKEN || !PEPPER) { console.error('SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER are required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, required });
  console.log(`  ${ok ? 'PASS' : required ? 'FAIL' : 'note'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
async function q(label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 400)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}
async function call(fn, body, token) {
  const response = await fetch(`${ORIGIN}/fn/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN,
      Cookie: `__Host-builder_session_token=${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, json };
}
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const id = (v) => `${sqlLit(v)}::uuid`;
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');

function detachFromNetwork(orgIdsSql) {
  const connections = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql})`;
  return `
    DELETE FROM public.builder_network_outbox
     WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text FROM public.workspace_connections c
                           WHERE c.builder_organisation_id IN (${orgIdsSql}));
    DELETE FROM public.workspace_connection_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${connections});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${connections});
    DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgIdsSql});`;
}
const ORGS = `SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`;

async function cleanup(stage) {
  await q(`cleanup (${stage})`, `
    DO $$ BEGIN
      ${detachFromNetwork(ORGS)}
      ALTER TABLE public.builder_project_status_history
        DISABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN (${ORGS});
      ALTER TABLE public.builder_project_status_history
        ENABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
      DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};
    END $$;`);
}

/** A person in the proof organisation, governed through the real doors, with a session. */
async function seedPerson(label, role, orgId = null) {
  const email = `${MARK}-${TAG}-${RUN}-${label}@example.com`;
  const orgSql = orgId ? `SELECT ${id(orgId)} AS id`
    : `INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
       VALUES (${sqlLit(ORG_NAME)}, 'builder', 'active', true, now()) RETURNING id`;
  const rows = await q(`seed ${label}`, `
    WITH org AS (${orgSql}), person AS (
      INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(`Browser ${label}`)}, 'active', true, now(), false,
              extensions.crypt(${sqlLit(randomBytes(12).toString('hex'))}, extensions.gen_salt('bf', 10)))
      RETURNING id)
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT person.id, org.id, ${sqlLit(role)}, true, 'active' FROM person, org;
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(ORG_NAME)}`)}
    SELECT u.id AS user_id, o.id AS org_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id)::int AS connections
      FROM public.builder_portal_users u, public.builder_organisations o
     WHERE u.email = ${sqlLit(email)} AND o.legal_name = ${sqlLit(ORG_NAME)}`);
  const row = rows[0];
  if (Number(row.connections) !== 0) throw new Error('the proof organisation is connected to a workspace; refusing');
  await q('onboarding', `SELECT public.builder_ensure_onboarding_steps(${id(row.user_id)})`);
  const token = randomBytes(32).toString('hex');
  await q('session', `SELECT public.builder_issue_session(${id(row.user_id)}, ${sqlLit(hmacHex(PEPPER, token))},
    now() + interval '2 hours', now() + interval '2 hours', NULL, NULL, 'smoke-rollout browser proof')`);
  await call('builder-portal-verify', { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, token);
  await call('builder-portal-verify', { action: 'complete_onboarding' }, token);
  return { label, userId: row.user_id, orgId: row.org_id, token };
}

// ===========================================================================
console.log(`portal browser proof run=${RUN} origin=${ORIGIN}`);
await cleanup('start');
let browser = null;
try {
  const owner = await seedPerson('owner', 'owner');
  const colleague = await seedPerson('colleague', 'member', owner.orgId);
  const project = (await q('project', `
    SELECT (public.builder_upsert_project(NULL, 'system', NULL, NULL,
      ${sqlLit(JSON.stringify({ name: `${ORG_NAME} project`, suburb: 'Proofville', state: 'NSW', postcode: '2000' }))}::jsonb,
      NULL, ${id(owner.orgId)}, NULL, NULL, 'portal browser proof')).id AS id`))[0].id;
  await q('grant', `
    INSERT INTO public.builder_project_access(builder_user_id, project_id, organisation_id, organisation_side, access_role)
    VALUES (${id(owner.userId)}, ${id(project)}, ${id(owner.orgId)}, 'builder', 'responsible'),
           (${id(colleague.userId)}, ${id(project)}, ${id(owner.orgId)}, 'builder', 'team_member')`);
  const conversation = await call('builder-portal-collaboration', {
    operation: 'create_conversation', scope_type: 'project', scope_id: project,
    subject: 'Site meeting', participant_ids: [colleague.userId], reason: 'portal browser proof',
  }, owner.token);
  const conversationId = conversation.json?.record?.id;
  await call('builder-portal-collaboration',
    { operation: 'post_message', conversation_id: conversationId, body: 'Setout is booked for Tuesday.' }, owner.token);
  record('0: a governed proof organisation, detached, with a project conversation', !!conversationId,
    `conversation=${conversation.status}`);

  browser = await chromium.launch();
  const open = async (viewport) => {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: false });
    await context.addCookies([{
      name: '__Host-builder_session_token', value: owner.token, url: ORIGIN,
      secure: true, httpOnly: true, sameSite: 'Lax',
    }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 160)));
    return { context, page, errors };
  };

  // 1. Every live route, signed in.
  const { context, page, errors } = await open({ width: 1366, height: 900 });
  const routes = [
    ['dashboard', '/builder/dashboard'], ['projects', '/builder/projects'],
    ['project', `/builder/projects/${project}`], ['stock', '/builder/stock'],
    ['activations', '/builder/activations'], ['messages', '/builder/messages'],
    ['messages-projects', `/builder/messages?view=projects&project=${project}`],
    ['tasks', '/builder/tasks'], ['notifications', '/builder/notifications'],
    ['activity', '/builder/activity'], ['settings', '/builder/settings'],
  ];
  for (const [name, path] of routes) {
    const before = errors.length;
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const url = new URL(page.url());
    const heading = (await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => null))?.trim() ?? null;
    const failed = await page.getByText(/something went wrong|could not be loaded/i).count();
    await page.screenshot({ path: `${OUT}/desktop-${name}.png`, fullPage: true });
    record(`1: ${path} renders signed in`,
      !url.pathname.startsWith('/builder/login') && !!heading && errors.length === before && failed === 0,
      `at=${url.pathname} h1="${heading}" pageErrors=${errors.length - before} errorText=${failed}`);
  }

  // 2. Retired bookmarks and withdrawn sections.
  for (const [from, to] of [['/builder/agencies', '/builder/activations'], ['/builder/agencies/messages', '/builder/messages']]) {
    await page.goto(`${ORIGIN}${from}`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    record(`2: the old bookmark ${from} lands on ${to}`, new URL(page.url()).pathname === to, `at=${new URL(page.url()).pathname}`);
  }
  await page.goto(`${ORIGIN}/builder/inventory`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/desktop-withdrawn-inventory.png`, fullPage: true });
  const withdrawnText = (await page.locator('main').textContent().catch(() => '')) ?? '';
  record('2: a withdrawn section says it was withdrawn rather than breaking',
    !new URL(page.url()).pathname.startsWith('/builder/login') && /withdrawn|no longer|moved/i.test(withdrawnText),
    `at=${new URL(page.url()).pathname}`);

  // 3. A colleague's reply appears in the open conversation, without a reload.
  await page.goto(`${ORIGIN}/builder/messages?view=projects&project=${project}&conversation=${conversationId}`,
    { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  await page.getByText('Setout is booked for Tuesday.').first().waitFor({ timeout: 20_000 }).catch(() => {});
  const replyBody = `Confirmed — I will be on site. (${RUN})`;
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  const sentAt = Date.now();
  await call('builder-portal-collaboration',
    { operation: 'post_message', conversation_id: conversationId, body: replyBody }, colleague.token);
  const appeared = await page.getByText(replyBody).first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  const waited = Date.now() - sentAt;
  await page.screenshot({ path: `${OUT}/desktop-project-conversation-live.png`, fullPage: true });
  record('3: an open project conversation shows a colleague\'s reply without a reload',
    appeared && navigations.length === 0, `appeared=${appeared} after ${waited}ms, reloads=${navigations.length} (polling)`);

  // 4. The newer-build banner.
  await page.goto(`${ORIGIN}/builder/dashboard`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  await page.route(`${ORIGIN}/`, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    return route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-NEWERBUILD.js"></script></head><body></body></html>',
    });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = await page.getByText(/A newer version of the portal is available/).first()
    .waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: `${OUT}/desktop-newer-build-banner.png` });
  record('4: the newer-build banner appears when the site serves a different build', banner);
  await page.unroute(`${ORIGIN}/`);
  await context.close();

  // 1 (phone). The main pages at 390 px, without sideways scrolling.
  const phone = await open({ width: 390, height: 844 });
  for (const [name, path] of [['dashboard', '/builder/dashboard'], ['stock', '/builder/stock'],
    ['activations', '/builder/activations'], ['messages', '/builder/messages'],
    ['project-conversation', `/builder/messages?view=projects&project=${project}&conversation=${conversationId}`]]) {
    await phone.page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await phone.page.waitForTimeout(1500);
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await phone.page.screenshot({ path: `${OUT}/phone-${name}.png`, fullPage: true });
    record(`1: ${path} fits a 390 px phone`, overflow <= 1
      && !new URL(phone.page.url()).pathname.startsWith('/builder/login'), `overflow=${overflow}px`,
      { required: false });
  }
  await phone.context.close();
} catch (error) {
  record('the proof ran to completion', false, String(error?.message ?? error).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
}

await cleanup('end');
const left = (await q('residue', `
  SELECT (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS orgs,
         (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users,
         (SELECT count(*) FROM public.builder_projects WHERE name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS projects`))[0];
record('cleanup: nothing of this run remains', Object.values(left ?? { x: 1 }).every((n) => Number(n) === 0), JSON.stringify(left));

const required = results.filter((r) => r.required);
const passed = required.filter((r) => r.ok).length;
console.log(`\n${passed} of ${required.length} required checks passed (run ${RUN})`);
console.log(passed === required.length ? 'PORTAL BROWSER PROOF PASSED' : 'PORTAL BROWSER PROOF FAILED');
process.exit(passed === required.length ? 0 : 1);
