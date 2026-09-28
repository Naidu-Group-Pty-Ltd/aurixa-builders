#!/usr/bin/env node
/**
 * ===========================================================================
 * THE OFFERED ACTIONS NO OTHER PROOF REACHED — ON THE LIVE PORTAL.
 * ===========================================================================
 *
 * The final Builder Portal audit (28 September 2026) mapped every operation
 * the portal offers onto the production proofs that call it. Most are called
 * by several. These were called by none, although each is a button a builder
 * can press:
 *
 *   Settings → Signed-in devices   revoke one device, "Sign out this device",
 *                                  "Revoke all other devices";
 *   Settings → Requests to join    approve and decline;
 *   Project → Change status        "Update status" (and the history it writes);
 *   Tasks → By record              the tasks of one record;
 *   Messages → agency thread       "Add user" (who may be added) and
 *                                  "Send again" on a message that failed;
 *   Stock List → sources           "Source images" (recover a list's own
 *                                  pictures) and "Refresh brochure links".
 *
 * For each, the server's answer to a role that may act, to one that may not,
 * and the effect in the database — never the page alone.
 *
 * And, in a real Chromium, the controls the other browser proofs never
 * pressed: the notification bell's "Mark all read" and a single "Mark read",
 * the user menu (Settings, Replay portal tour, Sign out), the organisation
 * switcher, the phone navigation drawer, sending in an agency thread, a
 * task's status select, a property's schedule dialog, a project's "Update
 * status", "Revoke all other devices", and the password field's show/hide
 * toggle. Each is judged by what reached the database, not by the page.
 *
 * One organisation of the run's own, detached from every workspace and joined
 * to the live Command Centre only by a proof-only transport: an owner, a
 * member, a read-only colleague and a fourth person whose devices are signed
 * out; a published five-lot stock list; one activation made through the
 * Command Centre's own marketplace function by a proof staff member for a
 * proof client. Registration is closed, so no join request can be written by
 * the product any more; the two this proof decides are seeded as registration
 * wrote them, for two proof accounts. A message's failure is set by SQL on the
 * proof's own message — the only way to reach "Send again" on demand — and
 * everything after that is the product's.
 *
 * Nothing it reads is logged but statuses, counts and the proof's own values.
 * Everything is deleted on both sides and counted to zero.
 * Runs from the production-rollout workflow (phase `portal-controls-proof`).
 */
import { randomUUID } from 'node:crypto';
import {
  RUN, record, net, cc, id, secs, waitFor, stock, portal, commandCentre, fixture, storageFor, withLinks,
  seedOrganisation, establishSession, connectTransport, seedStaff, seedClient, uploadDocument, waitImported,
  itemsOf, cleanup, leftovers, finish, names, NETWORK_REF, ORIGIN, sqlLit,
} from './tier0/common.mjs';

const TAG = 'controls';
const verify = (cookie, body = {}) => portal('builder-portal-verify', body, cookie);
const invite = (cookie, body) => portal('builder-portal-invite', body, cookie);
const projects = (cookie, body) => portal('builder-portal-projects', body, cookie);
const collab = (cookie, body) => portal('builder-portal-collaboration', body, cookie);
const said = (answer) => `HTTP ${answer.status}${answer.json?.error ? ` "${String(answer.json.error).slice(0, 90)}"` : ''}`;

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A browser context signed in as `cookie`, the way the portal's own cookie is set. */
async function openAs(browser, cookie, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: '__Host-builder_session_token', value: cookie.split('=')[1], url: ORIGIN,
    secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  return { context, page };
}
const go = async (page, path) => {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
};
/** One control, pressed; a step that throws is recorded as failed and the rest go on. */
async function step(name, run) {
  try { await run(); } catch (error) { record(name, false, String(error?.message ?? error).slice(0, 240)); }
}

async function browserControls({ owner, member, projectId, conversationId, byLot }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const unread = async (who) => Number((await net('unread', `SELECT count(*)::int AS n FROM public.builder_notifications
      WHERE builder_user_id = ${id(who.userId)} AND organisation_id = ${id(who.orgId)} AND read_at IS NULL`))[0]?.n);

    // The guided tour opens itself on a first visit; these people have it done.
    await net('tours done', `
      INSERT INTO public.builder_user_preferences(builder_user_id, tour_completed_at)
      SELECT u, now() FROM unnest(ARRAY[${id(owner.userId)}, ${id(member.userId)}]) AS u
      ON CONFLICT (builder_user_id) DO UPDATE SET tour_completed_at = coalesce(public.builder_user_preferences.tour_completed_at, now())`);

    await step('G1: "Mark read" on one notification marks that one, and the bell\'s "Mark all read" the rest', async () => {
      const before = await unread(owner);
      const { context, page } = await openAs(browser, owner.cookie);
      await go(page, '/builder/notifications');
      await page.getByRole('button', { name: /^Mark read$/ }).first().click();
      await page.waitForTimeout(2500);
      const afterOne = await unread(owner);
      await go(page, '/builder');
      await page.getByRole('button', { name: /^Notifications/ }).first().click();
      await page.getByRole('button', { name: /Mark all read/i }).first().click();
      await page.waitForTimeout(2500);
      const afterAll = await unread(owner);
      const label = await page.getByRole('button', { name: /^Notifications/ }).first().getAttribute('aria-label').catch(() => '');
      await context.close();
      record('G1: "Mark read" on one notification marks that one, and the bell\'s "Mark all read" the rest',
        before >= 2 && afterOne === before - 1 && afterAll === 0 && !/unread/.test(label ?? ''),
        `unread ${before} → ${afterOne} → ${afterAll}; bell "${label}"`);
    });

    await step('G2: the user menu opens Settings and replays the tour', async () => {
      const { context, page } = await openAs(browser, owner.cookie);
      await go(page, '/builder');
      const menu = page.locator('button[aria-haspopup="menu"]', { hasText: 'Tier0 owner' }).last();
      await menu.click();
      await page.getByRole('menuitem', { name: /^Settings$/ }).click();
      await page.waitForTimeout(1500);
      const toSettings = new URL(page.url()).pathname;
      await menu.click();
      await page.getByRole('menuitem', { name: /Replay portal tour/ }).click();
      await page.waitForTimeout(1500);
      const tour = await page.getByRole('button', { name: /Start tour|Skip for now/i }).count();
      await page.keyboard.press('Escape').catch(() => {});
      await context.close();
      record('G2: the user menu opens Settings and replays the tour', toSettings === '/builder/settings' && tour > 0,
        `Settings → ${toSettings}; tour offered ${tour > 0}`);
    });

    await step('G3: "Sign out" in the user menu ends the session', async () => {
      const cookie = await establishSession(owner);
      const { context, page } = await openAs(browser, cookie);
      await go(page, '/builder');
      await page.locator('button[aria-haspopup="menu"]', { hasText: 'Tier0 owner' }).last().click();
      await page.getByRole('menuitem', { name: /^Sign out$/ }).click();
      await page.waitForTimeout(2500);
      const landed = new URL(page.url()).pathname;
      await context.close();
      const after = await verify(cookie);
      record('G3: "Sign out" in the user menu ends the session', after.status === 401 && /\/builder\/login/.test(landed),
        `landed on ${landed}; the session then answers HTTP ${after.status}`);
    });

    await step('G4: the organisation switcher moves the owner into the other organisation and back', async () => {
      const cookie = await establishSession(owner);
      const { context, page } = await openAs(browser, cookie);
      await go(page, '/builder');
      const active = async () => (await verify(cookie)).json?.active_organisation?.organisation_id ?? null;
      const before = await active();
      await page.locator('button[aria-haspopup="menu"]', { hasText: owner.orgName }).first().click();
      const other = page.getByRole('menuitem').filter({ hasNotText: owner.orgName }).first();
      await other.click();
      await page.waitForTimeout(2500);
      const moved = await active();
      await page.locator('button[aria-haspopup="menu"]').filter({ hasNotText: 'Tier0 owner' }).first().click();
      await page.getByRole('menuitem').filter({ hasText: owner.orgName }).first().click();
      await page.waitForTimeout(2500);
      const back = await active();
      await context.close();
      record('G4: the organisation switcher moves the owner into the other organisation and back',
        before === owner.orgId && moved && moved !== owner.orgId && back === owner.orgId,
        `active ${before === owner.orgId ? 'own' : before} → ${moved && moved !== owner.orgId ? 'the other' : moved} → ${back === owner.orgId ? 'own' : back}`);
    });

    await step('G5: on a phone, the navigation drawer opens, navigates and closes', async () => {
      const { context, page } = await openAs(browser, member.cookie, PHONE);
      await go(page, '/builder');
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      await page.waitForTimeout(600);
      const drawer = page.getByRole('navigation', { name: 'Builder portal navigation' });
      const opened = await drawer.isVisible().catch(() => false);
      await drawer.getByRole('link', { name: /^Tasks/ }).first().click();
      await page.waitForTimeout(1500);
      const landed = new URL(page.url()).pathname;
      const closed = !(await drawer.isVisible().catch(() => false));
      await context.close();
      record('G5: on a phone, the navigation drawer opens, navigates and closes', opened && landed === '/builder/tasks' && closed,
        `opened ${opened}; Tasks → ${landed}; closed ${closed}`);
    });

    if (conversationId) {
      await step('G6: typing in an agency thread and pressing "Send" delivers the message', async () => {
        const text = `Proof ${RUN}: sent from the page`;
        const { context, page } = await openAs(browser, owner.cookie);
        await go(page, '/builder/messages?view=agencies');
        await page.getByRole('option').first().click().catch(() => {});
        await page.waitForTimeout(1500);
        await page.getByLabel(/^Message$/).fill(text);
        await page.getByRole('button', { name: /^Send$/ }).click();
        const arrived = await waitFor('page message', async () => {
          const row = (await net('page message', `SELECT delivery_state FROM public.builder_agency_messages
            WHERE conversation_id = ${id(conversationId)} AND body = ${sqlLit(text)}`))[0];
          return { done: row?.delivery_state === 'delivered', row };
        }, 3 * 60_000, 3_000);
        await context.close();
        record('G6: typing in an agency thread and pressing "Send" delivers the message', arrived.done,
          `${arrived.row?.delivery_state ?? 'not written'} in ${secs(arrived)}`);
      });
    }

    await step('G7: a task\'s status select changes the task', async () => {
      const task = (await net('a task', `SELECT id, title, status FROM public.builder_tasks
        WHERE scope_type = 'stock_item' AND scope_id = ${id(byLot['101'])} AND status <> 'in_progress' ORDER BY created_at LIMIT 1`))[0];
      const { context, page } = await openAs(browser, owner.cookie);
      await go(page, '/builder/tasks');
      await page.getByRole('combobox', { name: `Change status of ${task.title}` }).first().click();
      await page.getByRole('option', { name: /^In progress$/ }).click();
      await page.waitForTimeout(2500);
      const after = (await net('task after', `SELECT status FROM public.builder_tasks WHERE id = ${id(task.id)}`))[0];
      await context.close();
      record('G7: a task\'s status select changes the task', after?.status === 'in_progress', `${task.status} → ${after?.status}`);
    });

    await step('G8: a property\'s schedule dialog saves the figure the builder states', async () => {
      const lot = byLot['103'];
      const { context, page } = await openAs(browser, owner.cookie);
      await go(page, '/builder/stock');
      await page.getByRole('button', { name: /(Complete|Update) the schedule for .*16 Proofline Way/i }).first().click();
      await page.getByLabel(/^Bedrooms/).first().fill('6');
      await page.getByRole('button', { name: /^Save schedule$/ }).click();
      await page.waitForTimeout(2500);
      const after = (await net('stated', `SELECT manual_stats->'values'->>'bedrooms' AS bedrooms FROM public.builder_stock_items
        WHERE id = ${id(lot)}`))[0];
      await context.close();
      record('G8: a property\'s schedule dialog saves the figure the builder states', String(after?.bedrooms) === '6',
        `stated bedrooms ${after?.bedrooms ?? 'none'}`);
    });

    if (projectId) {
      await step('G9: "Update status" on the project page moves the project, with its reason', async () => {
        const before = (await net('project', `SELECT status FROM public.builder_projects WHERE id = ${id(projectId)}`))[0]?.status;
        const { context, page } = await openAs(browser, owner.cookie);
        await go(page, `/builder/projects/${projectId}`);
        await page.locator('#next-status').click();
        const option = page.getByRole('option').filter({ hasNotText: /Cancelled|On hold/ }).first();
        const label = await option.innerText();
        await option.click();
        await page.locator('#status-reason').fill(`Proof ${RUN} from the page`);
        await page.getByRole('button', { name: /^Update status$/ }).click();
        await page.waitForTimeout(2500);
        const after = (await net('project after', `SELECT p.status,
            (SELECT count(*) FROM public.builder_project_status_history h
              WHERE h.project_id = p.id AND h.reason = ${sqlLit(`Proof ${RUN} from the page`)})::int AS logged
          FROM public.builder_projects p WHERE p.id = ${id(projectId)}`))[0];
        await context.close();
        record('G9: "Update status" on the project page moves the project, with its reason',
          after?.status && after.status !== before && Number(after.logged) === 1,
          `${before} → ${after?.status} ("${label}"), history entries with the reason ${after?.logged}`);
      });
    }

    await step('G10: "Revoke all other devices" on Settings signs the others out and keeps this one', async () => {
      const others = [await establishSession(member), await establishSession(member)];
      const { context, page } = await openAs(browser, member.cookie);
      await go(page, '/builder/settings');
      await page.getByRole('button', { name: /^Revoke all other devices$/ }).click();
      await page.waitForTimeout(2500);
      await context.close();
      const answers = await Promise.all(others.map((c) => verify(c)));
      const me = await verify(member.cookie);
      record('G10: "Revoke all other devices" on Settings signs the others out and keeps this one',
        answers.every((a) => a.status === 401) && me.status === 200,
        `others ${answers.map((a) => a.status).join('/')}; this device ${me.status}`);
    });

    await step('G11: the password field\'s show/hide toggle reveals and hides what was typed', async () => {
      const context = await browser.newContext({ viewport: DESKTOP });
      const page = await context.newPage();
      await go(page, '/builder/login');
      const field = page.getByLabel(/^Password$/).first();
      await field.fill('not-a-real-password');
      const hidden = await field.getAttribute('type');
      await page.getByRole('button', { name: /^Show password$/ }).click();
      const shown = await field.getAttribute('type');
      await page.getByRole('button', { name: /^Hide password$/ }).click();
      const again = await field.getAttribute('type');
      await context.close();
      record('G11: the password field\'s show/hide toggle reveals and hides what was typed',
        hidden === 'password' && shown === 'text' && again === 'password', `${hidden} → ${shown} → ${again}`);
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

let storage = null;
try {
  console.log(`portal controls proof run=${RUN}`);
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);

  // --- The organisation, its people, its stock, one activation ---------------------------
  const owner = await seedOrganisation(TAG, 'owner');
  await connectTransport(TAG, owner);
  const member = await seedOrganisation(TAG, 'member', { role: 'member', existingOrgId: owner.orgId });
  const viewer = await seedOrganisation(TAG, 'viewer', { role: 'read_only', existingOrgId: owner.orgId });
  const devices = await seedOrganisation(TAG, 'devices', { role: 'member', existingOrgId: owner.orgId });
  const outsider = await seedOrganisation(TAG, 'outsider');

  const list = new TextEncoder().encode(await withLinks(storage, owner.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
  const sent = await uploadDocument(owner.cookie, 'Controls proof stock list.csv', list);
  await waitImported(sent.uploadId);
  const published = await waitFor('published', async () => {
    const now = await itemsOf(owner.orgId);
    return { done: now.length === 5 && now.every((i) => i.lifecycle_status === 'active'), now };
  }, 18 * 60_000, 10_000);
  const byLot = Object.fromEntries((published.now ?? []).map((i) => [i.lot_number, i.id]));
  record('0: the organisation holds a published stock list', published.done, `${published.now?.length ?? 0} live in ${secs(published)}`);

  const staff = await seedStaff(TAG, 'agent', ['listings', 'client_management']);
  await cc('agent sink', `UPDATE public.custom_users SET email = ${sqlLit(`delivered+controls-${RUN}@resend.dev`)} WHERE id = ${id(staff.userId)}`);
  const clientId = await seedClient(TAG, { owner: staff.userId });
  const mirrored = await waitFor('mirrored', async () => {
    const rows = await cc('mirror', `SELECT count(*)::int AS n FROM public.builder_network_stock_items
      WHERE organisation_id = ${id(owner.orgId)} AND lifecycle_status = 'active'`);
    return { done: Number(rows[0]?.n) === 5 };
  }, 8 * 60_000, 5_000);
  record('0: the Command Centre holds the five properties', mirrored.done, secs(mirrored));
  const selected = await commandCentre('select_for_client', { stock_item_id: byLot['101'], client_id: clientId }, staff.token);
  record('0: the Command Centre activates lot 101 for a client', selected.status === 200, `HTTP ${selected.status}`);
  const selected2 = await commandCentre('select_for_client', { stock_item_id: byLot['102'], client_id: clientId }, staff.token);
  record('0: and lot 102, so the owner has two notifications to read', selected2.status === 200, `HTTP ${selected2.status}`);
  await net('owner joins a second organisation', `
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    VALUES (${id(owner.userId)}, ${id(outsider.orgId)}, 'member', false, 'active')`);
  const arrived = await waitFor('activation arrives', async () => {
    const announcement = (await net('announcement', `SELECT id FROM public.builder_stock_selection_announcements
      WHERE stock_item_id = ${id(byLot['101'])}`))[0] ?? null;
    const project = (await net('project', `SELECT id FROM public.builder_projects
      WHERE builder_organisation_id = ${id(owner.orgId)} ORDER BY created_at LIMIT 1`))[0] ?? null;
    return { done: !!announcement && !!project, announcement, project };
  }, 6 * 60_000, 4_000);
  const projectId = arrived.project?.id ?? null;
  record('0: the activation reaches the builder and opens a project', arrived.done, secs(arrived));
  const acknowledged = await stock({ operation: 'acknowledge_selection', selection_id: arrived.announcement?.id }, owner.cookie);
  const opened = await waitFor('conversation', async () => {
    const listed = await stock({ operation: 'list_my_agency_conversations' }, owner.cookie);
    const conversation = (listed.json?.conversations ?? [])[0] ?? null;
    return { done: !!conversation?.conversation_id, conversation };
  }, 3 * 60_000, 4_000);
  const conversationId = opened.conversation?.conversation_id ?? null;
  record('0: acknowledging opens the activation\'s agency conversation', acknowledged.status === 200 && !!conversationId,
    `HTTP ${acknowledged.status}, ${secs(opened)}`);

  // --- A. Settings → Signed-in devices ----------------------------------------------------
  {
    const second = await establishSession(devices);
    const listed = await verify(devices.cookie, { action: 'list_sessions' });
    const live = (listed.json?.sessions ?? []).filter((s) => !s.revoked_at);
    const current = listed.json?.current_session_id ?? null;
    const other = live.find((s) => s.id !== current) ?? null;
    record('A: the device list shows this device and the other one', listed.status === 200 && live.length >= 2 && !!current && !!other,
      `HTTP ${listed.status}, ${live.length} live, current ${current ? 'named' : 'missing'}`);

    const foreign = await verify(viewer.cookie, { action: 'revoke_session', session_id: other?.id ?? randomUUID() });
    const stillLive = await verify(second);
    record('A: another person cannot revoke somebody else\'s device', foreign.status === 404 && stillLive.status === 200,
      `${said(foreign)}; that device still signed in: ${stillLive.status === 200}`);

    const revoked = await verify(devices.cookie, { action: 'revoke_session', session_id: other?.id });
    const afterRevoke = await verify(second);
    const stamped = other ? (await net('revoked device', `SELECT revoked_at IS NOT NULL AS revoked, revoked_reason
      FROM public.builder_portal_sessions WHERE id = ${id(other.id)}`))[0] : null;
    record('A: "Revoke" signs the other device out, and it is refused from then on',
      revoked.status === 200 && afterRevoke.status === 401 && stamped?.revoked === true,
      `${said(revoked)}; the device then answers HTTP ${afterRevoke.status}; recorded ${stamped?.revoked_reason ?? 'nothing'}`);
    const stillMe = await verify(devices.cookie);
    record('A: revoking another device leaves this one signed in', stillMe.status === 200, `HTTP ${stillMe.status}`);

    const third = await establishSession(devices);
    const fourth = await establishSession(devices);
    const all = await verify(devices.cookie, { action: 'revoke_other_sessions' });
    const thirdAfter = await verify(third);
    const fourthAfter = await verify(fourth);
    const meAfter = await verify(devices.cookie);
    record('A: "Revoke all other devices" signs every other device out and keeps this one',
      all.status === 200 && Number(all.json?.revoked) >= 2 && thirdAfter.status === 401 && fourthAfter.status === 401 && meAfter.status === 200,
      `${said(all)}, revoked ${all.json?.revoked ?? '?'}; the others answer ${thirdAfter.status}/${fourthAfter.status}; this device ${meAfter.status}`);

    const current2 = (await verify(devices.cookie, { action: 'list_sessions' })).json?.current_session_id ?? null;
    const self = await verify(devices.cookie, { action: 'revoke_session', session_id: current2 });
    const clears = self.setCookies.some((c) => /^__Host-builder_session_token=;/.test(c) || /Max-Age=0/i.test(c));
    const selfAfter = await verify(devices.cookie);
    record('A: "Sign out this device" ends this session and clears its cookie',
      self.status === 200 && clears && selfAfter.status === 401,
      `${said(self)}; cookie cleared ${clears}; afterwards HTTP ${selfAfter.status}`);
  }

  // --- B. Settings → Requests to join -----------------------------------------------------
  {
    const n = names(TAG);
    const requesters = await net('join requesters', `
      INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(`${n.emailPrefix}asks-a-${RUN}@example.com`)}, 'Tier0 asks a', 'active', true, now(), false,
              extensions.crypt(${sqlLit(`Pr00f!${RUN}!asks-a`)}, extensions.gen_salt('bf', 10))),
             (${sqlLit(`${n.emailPrefix}asks-b-${RUN}@example.com`)}, 'Tier0 asks b', 'active', true, now(), false,
              extensions.crypt(${sqlLit(`Pr00f!${RUN}!asks-b`)}, extensions.gen_salt('bf', 10)))
      RETURNING id, email`);
    const [a, b] = [requesters.find((r) => r.email.includes('asks-a')), requesters.find((r) => r.email.includes('asks-b'))];
    const requests = await net('join requests', `
      INSERT INTO public.builder_org_join_requests(organisation_id, builder_user_id, message)
      VALUES (${id(owner.orgId)}, ${id(a.id)}, 'Proof request a'), (${id(owner.orgId)}, ${id(b.id)}, 'Proof request b')
      RETURNING id, builder_user_id`);
    const requestOf = (user) => requests.find((r) => r.builder_user_id === user.id)?.id;

    const listed = await invite(owner.cookie, { action: 'list_join_requests' });
    record('B: an owner sees the organisation\'s pending join requests',
      listed.status === 200 && (listed.json?.join_requests ?? []).length === 2, `${said(listed)}, ${(listed.json?.join_requests ?? []).length} listed`);
    const viewerList = await invite(viewer.cookie, { action: 'list_join_requests' });
    record('B: a read-only colleague is not shown them', viewerList.status === 403, said(viewerList));
    const viewerApprove = await invite(viewer.cookie, { action: 'approve_join_request', request_id: requestOf(a) });
    const memberApprove = await invite(member.cookie, { action: 'approve_join_request', request_id: requestOf(a) });
    const outsiderApprove = await invite(outsider.cookie, { action: 'approve_join_request', request_id: requestOf(a) });
    record('B: nobody but an owner or administrator of THIS organisation may decide one',
      viewerApprove.status === 403 && memberApprove.status === 403 && [403, 404].includes(outsiderApprove.status),
      `read-only ${viewerApprove.status}, member ${memberApprove.status}, another organisation's owner ${outsiderApprove.status}`);

    const approved = await invite(owner.cookie, { action: 'approve_join_request', request_id: requestOf(a) });
    const granted = (await net('granted', `SELECT m.status, m.membership_role, r.status AS request
      FROM public.builder_org_join_requests r LEFT JOIN public.builder_organisation_memberships m
        ON m.builder_user_id = r.builder_user_id AND m.organisation_id = r.organisation_id
     WHERE r.id = ${id(requestOf(a))}`))[0] ?? {};
    record('B: "Approve" admits the requester — live, because the account already signs in',
      approved.status === 200 && granted.request === 'approved' && granted.status === 'active',
      `${said(approved)}; request ${granted.request}, membership ${granted.status ?? 'none'} (${granted.membership_role ?? '—'})`);
    const again = await invite(owner.cookie, { action: 'approve_join_request', request_id: requestOf(a) });
    record('B: a decided request cannot be decided again', again.status === 409, said(again));

    const declined = await invite(owner.cookie, { action: 'decline_join_request', request_id: requestOf(b) });
    const refused = (await net('refused', `SELECT r.status AS request,
        (SELECT count(*) FROM public.builder_organisation_memberships m
          WHERE m.builder_user_id = r.builder_user_id AND m.organisation_id = r.organisation_id)::int AS memberships
      FROM public.builder_org_join_requests r WHERE r.id = ${id(requestOf(b))}`))[0] ?? {};
    record('B: "Decline" refuses the requester and grants nothing',
      declined.status === 200 && refused.request === 'declined' && Number(refused.memberships) === 0,
      `${said(declined)}; request ${refused.request}, memberships ${refused.memberships}`);
  }

  // --- C. Project → Change status ---------------------------------------------------------
  if (projectId) {
    const read = async () => (await projects(owner.cookie, { operation: 'get_project', project_id: projectId })).json?.project ?? null;
    const before = await read();
    const version = Number(before?.row_version ?? before?.version);
    const allowed = {
      planning: 'pre_sales', pre_sales: 'approved', approved: 'under_construction', on_hold: 'planning',
      under_construction: 'practical_completion', practical_completion: 'handover', handover: 'completed',
    };
    const next = allowed[before?.status] ?? null;
    record('C: the activated property\'s project is readable, with its status and version',
      !!before && Number.isInteger(version) && !!next, `status ${before?.status}, version ${version}`);

    const viewerMove = await projects(viewer.cookie, { operation: 'set_status', project_id: projectId,
      expected_version: version, status: next, reason: 'A read-only colleague tries' });
    record('C: a read-only colleague cannot change a project\'s status', viewerMove.status === 403, said(viewerMove));
    const invalid = await projects(owner.cookie, { operation: 'set_status', project_id: projectId,
      expected_version: version, status: before?.status === 'completed' ? 'planning' : 'completed', reason: 'Skipping ahead' });
    record('C: a transition the programme does not allow is refused', invalid.status === 409 || (before?.status === 'handover' && invalid.status === 200),
      `${before?.status} → completed: ${said(invalid)}`);
    const stale = await projects(owner.cookie, { operation: 'set_status', project_id: projectId,
      expected_version: version + 50, status: next, reason: 'From a stale page' });
    record('C: a change made from a stale page is refused', stale.status === 409, said(stale));

    const moved = await projects(owner.cookie, { operation: 'set_status', project_id: projectId,
      expected_version: version, status: next, reason: `Proof ${RUN} moves the programme on` });
    const after = await read();
    record('C: "Update status" moves the project to the next stage', moved.status === 200 && after?.status === next,
      `${said(moved)}; ${before?.status} → ${after?.status}`);
    const history = await projects(owner.cookie, { operation: 'status_history', project_id: projectId });
    const entries = history.json?.history ?? history.json?.records ?? after?.status_history ?? [];
    const logged = entries.some((h) => (h.to_status ?? h.status ?? h.to) === next
      && String(h.reason ?? '').includes(`Proof ${RUN}`));
    record('C: the change is written to the project\'s history, with its reason', logged,
      `${Array.isArray(entries) ? entries.length : 0} history entr${entries.length === 1 ? 'y' : 'ies'} (status_history: ${said(history)})`);
  }

  // --- D. Tasks → By record ---------------------------------------------------------------
  {
    const scope = { operation: 'list_tasks', scope_type: 'stock_item', scope_id: byLot['101'] };
    const expected = Number((await net('record tasks', `SELECT count(*)::int AS n FROM public.builder_tasks
      WHERE scope_type = 'stock_item' AND scope_id = ${id(byLot['101'])}`))[0]?.n);
    const ownerTasks = await collab(owner.cookie, scope);
    const viewerTasks = await collab(viewer.cookie, scope);
    const outsiderTasks = await collab(outsider.cookie, scope);
    const count = (answer) => (answer.json?.tasks ?? answer.json?.records ?? []).length;
    record('D: "By record" lists the tasks on one property — all of them, for anyone who may view tasks',
      ownerTasks.status === 200 && viewerTasks.status === 200 && expected >= 1 && count(ownerTasks) === expected && count(viewerTasks) === expected,
      `owner ${said(ownerTasks)} ${count(ownerTasks)}, read-only ${said(viewerTasks)} ${count(viewerTasks)}, stored ${expected}`);
    record('D: another organisation reads none of them', [403, 404].includes(outsiderTasks.status) || count(outsiderTasks) === 0,
      `${said(outsiderTasks)} ${count(outsiderTasks)}`);
  }

  // --- E. Messages → agency thread: "Add user" and "Send again" ---------------------------
  if (conversationId) {
    const invitees = await stock({ operation: 'list_agency_conversation_invitees', conversation_id: conversationId }, owner.cookie);
    const ids = (invitees.json?.invitees ?? []).map((i) => i.user_id);
    record('E: "Add user" offers the colleagues who may message and are not in the thread yet',
      invitees.status === 200 && ids.includes(member.userId) && !ids.includes(owner.userId) && !ids.includes(outsider.userId),
      `${said(invitees)}; offers the member ${ids.includes(member.userId)}, the owner ${ids.includes(owner.userId)}, the outsider ${ids.includes(outsider.userId)}, read-only ${ids.includes(viewer.userId)}`);
    const foreignList = await stock({ operation: 'list_agency_conversation_invitees', conversation_id: conversationId }, outsider.cookie);
    record('E: another organisation cannot list who may be added', foreignList.status !== 200 || (foreignList.json?.invitees ?? []).length === 0,
      said(foreignList));

    const posted = await stock({ operation: 'send_agency_message', conversation_id: conversationId,
      client_message_id: randomUUID(), body: `Proof ${RUN}: is lot 101 still available?` }, owner.cookie);
    const messageId = posted.json?.message?.id ?? null;
    const delivered = await waitFor('first delivery', async () => {
      const here = (await net('message', `SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${id(messageId ?? randomUUID())}`))[0];
      return { done: here?.delivery_state === 'delivered', here };
    }, 3 * 60_000, 3_000);
    record('E: the owner\'s message is delivered to the Command Centre', posted.status === 200 && delivered.done,
      `${said(posted)}; ${delivered.here?.delivery_state} in ${secs(delivered)}`);

    const notFailed = await stock({ operation: 'retry_agency_message', message_id: messageId }, owner.cookie);
    record('E: a message that did not fail cannot be sent again', notFailed.status >= 400 && notFailed.status < 500, said(notFailed));

    await net('the delivery fails', `UPDATE public.builder_agency_messages
      SET delivery_state = 'failed', failure_reason = 'proof: delivery failed' WHERE id = ${id(messageId)}`);
    const viewerRetry = await stock({ operation: 'retry_agency_message', message_id: messageId }, viewer.cookie);
    const memberRetry = await stock({ operation: 'retry_agency_message', message_id: messageId }, member.cookie);
    record('E: only the person who wrote it may send it again',
      viewerRetry.status === 403 && memberRetry.status >= 400 && memberRetry.status < 500,
      `read-only ${viewerRetry.status}, another colleague ${memberRetry.status}`);
    const retried = await stock({ operation: 'retry_agency_message', message_id: messageId }, owner.cookie);
    const redelivered = await waitFor('redelivery', async () => {
      const here = (await net('message again', `SELECT delivery_state, delivery_generation FROM public.builder_agency_messages
        WHERE id = ${id(messageId)}`))[0];
      const there = Number((await cc('copies', `SELECT count(*)::int AS n FROM public.builder_network_messages
        WHERE id = ${id(messageId)}`))[0]?.n);
      return { done: here?.delivery_state === 'delivered' && there === 1, here, there };
    }, 3 * 60_000, 3_000);
    record('E: "Send again" re-queues it, it is delivered, and the Command Centre holds it once',
      retried.status === 200 && retried.json?.message?.delivery_state === 'queued' && redelivered.done,
      `${said(retried)} (${retried.json?.message?.delivery_state}); then ${redelivered.here?.delivery_state}, generation ${redelivered.here?.delivery_generation}, copies there ${redelivered.there} in ${secs(redelivered)}`);
  }

  // --- F. Stock List → sources: "Source images" and "Refresh brochure links" --------------
  {
    const viewerImages = await stock({ operation: 'reprocess_source_images', upload_id: sent.uploadId }, viewer.cookie);
    record('F: a read-only colleague cannot re-read a list\'s own pictures', viewerImages.status === 403, said(viewerImages));
    const before = Number((await net('pictures before', `SELECT count(*)::int AS n FROM public.builder_stock_item_images
      WHERE organisation_id = ${id(owner.orgId)}`))[0]?.n);
    const images = await stock({ operation: 'reprocess_source_images', upload_id: sent.uploadId }, owner.cookie);
    const run = (images.json?.results ?? [])[0] ?? null;
    const after = Number((await net('pictures after', `SELECT count(*)::int AS n FROM public.builder_stock_item_images
      WHERE organisation_id = ${id(owner.orgId)}`))[0]?.n);
    const live = (await itemsOf(owner.orgId)).filter((i) => i.lifecycle_status === 'active').length;
    record('F: "Source images" re-reads the list, says what it did, and leaves every property live',
      images.status === 200 && !!run && run.upload_id === sent.uploadId && !run.error && live === 5 && after >= before,
      `${said(images)}; rows read ${run?.rows_read ?? '?'}, matched ${run?.matched ?? '?'}, stored ${run?.images_stored ?? '?'}; pictures ${before} → ${after}; live ${live}`);
    const foreignImages = await stock({ operation: 'reprocess_source_images', upload_id: sent.uploadId }, outsider.cookie);
    record('F: another organisation cannot reach this list', foreignImages.status === 404, said(foreignImages));

    const viewerLinks = await stock({ operation: 'refresh_brochure_links', upload_id: sent.uploadId }, viewer.cookie);
    const links = await stock({ operation: 'refresh_brochure_links', upload_id: sent.uploadId }, owner.cookie);
    record('F: "Refresh brochure links" is refused to a read-only colleague, and for a list with no links waiting says so',
      viewerLinks.status === 403 && links.status === 409 && /brochure links waiting/i.test(String(links.json?.error ?? '')),
      `read-only ${viewerLinks.status}; owner ${said(links)}`);
    record('F: recovering a Google Sheet\'s restricted brochure links is not exercised: it needs a restricted Google Sheet and the '
      + 'link-recovery webhook, which is the Make scenario this audit leaves out of scope', false, 'NOT TESTABLE here', { required: false });
  }
  // --- G. The controls, pressed in a real Chromium --------------------------------------
  await browserControls({ owner, member, projectId, conversationId, byLot });
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 500));
} finally {
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    const zero = (o) => Object.values(o ?? {}).every((v) => Number(v) === 0);
    record('cleanup: nothing this proof made remains on either side', zero(left.network) && zero(left.command), JSON.stringify(left));
  } catch (error) {
    record('cleanup: nothing this proof made remains on either side', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('portal-controls-proof');
}
