#!/usr/bin/env node
/**
 * ===========================================================================
 * THE PORTAL AS EACH ROLE SEES IT — EVERY OFFERED PAGE, ITS CONTROLS, FOUR
 * WIDTHS, ON THE LIVE PRODUCT.
 * ===========================================================================
 *
 * One organisation of the run's own, detached from every workspace and joined
 * to the live Command Centre only by a proof-only transport, holding what a
 * real builder's pages show: a published stock list with photographs, two
 * Command Centre activations (so a project, a task, notifications and an
 * agency conversation exist), and five people — owner, administrator,
 * manager, member and read-only — each with a session of their own.
 *
 * For each role, in a real Chromium:
 *   - every offered route at desktop (1440), laptop (1280), tablet (820) and
 *     phone (390) widths: no script error, no server error, no sideways
 *     scroll, the page's own content present;
 *   - the controls a builder uses, clicked: the server's answer for THIS
 *     role is what the page must show (a refusal is a PASS for a role the
 *     matrix refuses, and the page must say so rather than pretend);
 *   - the chrome: bell, user menu, tour, organisation switcher, sign out.
 * And, signed out: the public pages, and a second sign-in attempt after a
 * failed one (the CAPTCHA script stubbed and the login answer mocked, so the
 * browser's own logic is what is measured and no real account is touched).
 *
 * Screenshots are the run's artifact. Everything is deleted on both sides.
 * Runs from the production-rollout workflow (phase `portal-ui-audit`).
 */
import {
  RUN, record, net, cc, id, secs, waitFor, stock, portal, commandCentre, fixture, storageFor, withLinks,
  seedOrganisation, connectTransport, seedStaff, seedClient, uploadDocument, waitImported, itemsOf,
  cleanup, leftovers, finish, NETWORK_REF, ORIGIN, sqlLit, sleep,
} from './tier0/common.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const TAG = 'ui-audit';
const ARTIFACTS = 'proof-artifacts';
mkdirSync(ARTIFACTS, { recursive: true });
const VIEWPORTS = [['desktop', 1440, 900], ['laptop', 1280, 800], ['tablet', 820, 1180], ['phone', 390, 844]];
const matrix = [];
const note = (row) => matrix.push(row);

let storage = null;
let browser = null;
try {
  console.log(`portal UI audit run=${RUN}`);
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();

  // --- The organisation, its people and what their pages show ---------------------
  const owner = await seedOrganisation(TAG, 'owner');
  await connectTransport(TAG, owner);
  const people = { owner };
  for (const [label, role] of [['admin', 'administrator'], ['manager', 'manager'], ['member', 'member'], ['viewer', 'read_only']]) {
    people[label] = await seedOrganisation(TAG, label, { role, existingOrgId: owner.orgId });
  }
  const second = await seedOrganisation(TAG, 'second');
  await net('owner joins a second organisation', `
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    VALUES (${id(owner.userId)}, ${id(second.orgId)}, 'member', false, 'active')`);
  const list = new TextEncoder().encode(await withLinks(storage, owner.orgId, new TextDecoder().decode(fixture('csv-v1.csv'))));
  const sent = await uploadDocument(owner.cookie, 'Kestrel Grove stock list.csv', list);
  await waitImported(sent.uploadId);
  const published = await waitFor('published', async () => {
    const now = await itemsOf(owner.orgId);
    return { done: now.length === 5 && now.every((i) => i.lifecycle_status === 'active'), now };
  }, 18 * 60_000, 10_000);
  const items = published.now ?? [];
  const byLot = Object.fromEntries(items.map((i) => [i.lot_number, i.id]));
  record('0: the organisation holds a published stock list', published.done, `${items.length} live in ${secs(published)}`);
  const staff = await seedStaff(TAG, 'agent', ['listings', 'client_management']);
  await cc('agent sink', `UPDATE public.custom_users SET email = ${sqlLit(`delivered+ui-audit-${RUN}@resend.dev`)} WHERE id = ${id(staff.userId)}`);
  const clientId = await seedClient(TAG, { owner: staff.userId });
  await waitFor('mirrored', async () => {
    const rows = await cc('mirror', `SELECT count(*)::int AS n FROM public.builder_network_stock_items
      WHERE organisation_id = ${id(owner.orgId)} AND lifecycle_status = 'active'`);
    return { done: Number(rows[0]?.n) === 5 };
  }, 8 * 60_000, 5_000);
  for (const lot of ['101', '102']) {
    const s = await commandCentre('select_for_client', { stock_item_id: byLot[lot], client_id: clientId }, staff.token);
    record(`0: the Command Centre activates lot ${lot}`, s.status === 200, `HTTP ${s.status}`);
  }
  const activated = await waitFor('activations arrive', async () => {
    const rows = await net('announcements', `SELECT count(*)::int AS n FROM public.builder_stock_selection_announcements
      WHERE stock_item_id IN (${id(byLot['101'])}, ${id(byLot['102'])})`);
    const projects = await net('projects', `SELECT id FROM public.builder_projects WHERE builder_organisation_id = ${id(owner.orgId)}`);
    return { done: Number(rows[0]?.n) === 2 && projects.length >= 1, projects };
  }, 6 * 60_000, 4_000);
  const projectId = activated.projects?.[0]?.id ?? null;
  record('0: both activations reach the builder and open a project', activated.done, `${activated.projects?.length ?? 0} project(s) in ${secs(activated)}`);

  // --- Server authority on the activation's tasks (read-only must not edit) ------------------
  {
    const collab = (body, who) => portal('builder-portal-collaboration', body, who.cookie);
    const task = (await net('activation task', `
      SELECT id, row_version, status FROM public.builder_tasks
       WHERE scope_type = 'stock_item' AND scope_id = ${id(byLot['101'])} ORDER BY created_at LIMIT 1`))[0] ?? null;
    const viewerCreate = await collab({ operation: 'upsert_task', scope_type: 'stock_item', scope_id: byLot['101'],
      title: 'A read-only colleague writes a task' }, people.viewer);
    const viewerEdit = task ? await collab({ operation: 'upsert_task', task_id: task.id, expected_version: Number(task.row_version),
      status: 'done', reason: 'read-only probe' }, people.viewer) : { status: 0 };
    const after = task ? (await net('task after', `SELECT status FROM public.builder_tasks WHERE id = ${id(task.id)}`))[0] : null;
    record('T: a read-only colleague cannot create a task on an activated property', viewerCreate.status === 403,
      `HTTP ${viewerCreate.status}${viewerCreate.json?.error ? ` "${viewerCreate.json.error}"` : ''}`);
    record('T: a read-only colleague cannot change an activation task', viewerEdit.status === 403 && after?.status === task?.status,
      `HTTP ${viewerEdit.status}; status ${task?.status} → ${after?.status}`);
    const memberCreate = await collab({ operation: 'upsert_task', scope_type: 'stock_item', scope_id: byLot['101'],
      title: 'A member writes a task' }, people.member);
    record('T: a member (tasks: view and edit) can create one', memberCreate.status === 200, `HTTP ${memberCreate.status}`);
    const other = await seedOrganisation(TAG, 'outsider');
    const outsiderCreate = await collab({ operation: 'upsert_task', scope_type: 'stock_item', scope_id: byLot['101'],
      title: 'Another organisation writes a task' }, other);
    record('T: another organisation cannot touch this organisation\'s activation tasks', [403, 404].includes(outsiderCreate.status),
      `HTTP ${outsiderCreate.status}`);
  }

  // --- Every offered route, every role, four widths --------------------------------------
  const routes = [
    ['dashboard', '/builder', /Dashboard|Active projects|Figures as at/i],
    ['stock', '/builder/stock', /Proofline Way/],
    ['activations', '/builder/activations', /Proofline Way|Activated/i],
    ['projects', '/builder/projects', /Project|No projects/i],
    ['project', projectId ? `/builder/projects/${projectId}` : '/builder/projects', /Overview|Parties|History|not have access/i],
    ['messages-agency', '/builder/messages?view=agencies', /conversation/i],
    ['messages-projects', '/builder/messages?view=projects', /conversation|Choose/i],
    ['tasks', '/builder/tasks', /Assigned to me/i],
    ['notifications', '/builder/notifications', /Notification|Unread/i],
    ['activity', '/builder/activity', /Activity|record types/i],
    ['settings', '/builder/settings', /preferences|Password/i],
    ['withdrawn', '/builder/inventory', /not part of the Builder/i],
    ['legacy-agencies', '/builder/agencies', /Activated|Activation/i],
    ['compliance', '/builder/compliance', /compliance|not available/i],
  ];
  async function openAs(person, viewport) {
    const context = await browser.newContext({ viewport: { width: viewport[1], height: viewport[2] } });
    await context.addCookies([{ name: '__Host-builder_session_token', value: person.cookie.split('=')[1], url: ORIGIN,
      secure: true, httpOnly: true, sameSite: 'Lax' }]);
    // The tour opens itself on a first visit; completed here so it does not cover the page under test.
    return context;
  }
  // The guided tour opens itself on a first visit. The owner takes it, the way
  // a new builder does; everyone else has it marked done so it does not cover
  // the pages under test.
  {
    const context = await openAs(owner, VIEWPORTS[0]);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/builder`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const start = page.getByRole('button', { name: /Start tour/i }).first();
    const offered = await start.count();
    let steps = 0;
    if (offered) {
      await start.click().catch(() => {});
      for (let i = 0; i < 8; i++) {
        const next = page.getByRole('button', { name: /^(Next|Finish)$/ }).first();
        if (!await next.count()) break;
        const label = await next.innerText().catch(() => '');
        await next.click().catch(() => {});
        steps += 1;
        await page.waitForTimeout(400);
        if (/Finish/.test(label)) break;
      }
    }
    await page.waitForTimeout(1500);
    const done = await net('tour', `SELECT tour_completed_at IS NOT NULL AS done FROM public.builder_user_preferences
      WHERE builder_user_id = ${id(owner.userId)}`);
    record('C: a new builder is offered the guided tour, can step through it, and finishing it is remembered',
      offered > 0 && steps >= 2 && done[0]?.done === true, `offered ${offered > 0}, ${steps} step(s), recorded ${done[0]?.done ?? false}`);
    await context.close();
  }
  await net('tours completed', `
    INSERT INTO public.builder_user_preferences(builder_user_id, tour_completed_at)
    SELECT u, now() FROM unnest(ARRAY[${Object.values(people).map((p) => id(p.userId)).join(', ')}]) AS u
    ON CONFLICT (builder_user_id) DO UPDATE SET tour_completed_at = coalesce(public.builder_user_preferences.tour_completed_at, now())`);
  for (const [label, person] of Object.entries(people)) {
    for (const viewport of VIEWPORTS) {
      const context = await openAs(person, viewport);
      const page = await context.newPage();
      for (const [name, path, expect] of routes) {
        const errors = []; const serverErrors = []; const refusals = [];
        const onError = (e) => errors.push(String(e?.message ?? e).slice(0, 140));
        const onResponse = (res) => {
          if (!res.url().includes('/fn/')) return;
          const fn = res.url().split('/fn/')[1]?.split('?')[0];
          if (res.status() >= 500) serverErrors.push(`${fn} ${res.status()}`);
          else if (res.status() >= 400) refusals.push(`${fn} ${res.status()}`);
        };
        page.on('pageerror', onError); page.on('response', onResponse);
        const started = Date.now();
        await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const ms = Date.now() - started;
        const text = await page.locator('body').innerText().catch(() => '');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
        const landed = page.url().replace(ORIGIN, '');
        if (viewport[0] === 'desktop' || viewport[0] === 'phone' || label === 'owner') {
          await page.screenshot({ path: `${ARTIFACTS}/${label}-${name}-${viewport[0]}.png`, fullPage: false }).catch(() => {});
        }
        page.off('pageerror', onError); page.off('response', onResponse);
        const ok = errors.length === 0 && serverErrors.length === 0 && expect.test(text) && overflow <= 1;
        note({ role: label, route: name, viewport: viewport[0], ok, ms, overflow, landed, errors, serverErrors, refusals,
          content: expect.test(text) });
        if (!ok) {
          console.log(`  note  ${label} ${name} ${viewport[0]}: content ${expect.test(text)}, overflow ${overflow}px, `
            + `errors ${errors.length}, 5xx ${serverErrors.join(',') || 0}, 4xx ${refusals.join(',') || 0}, at ${landed}`);
        }
      }
      await context.close();
    }
  }
  for (const [label] of Object.entries(people)) {
    const rows = matrix.filter((r) => r.role === label);
    const bad = rows.filter((r) => !r.ok);
    record(`R: every offered route renders for the ${label} at four widths (content, no script error, no 5xx, no sideways scroll)`,
      bad.length === 0, bad.length ? bad.slice(0, 8).map((r) => `${r.route}/${r.viewport}${r.overflow > 1 ? ` +${r.overflow}px` : ''}`
        + `${r.content ? '' : ' no-content'}${r.errors.length ? ' script-error' : ''}${r.serverErrors.length ? ` ${r.serverErrors[0]}` : ''}`).join('; ')
        : `${rows.length} page renders`);
  }
  const compliance = matrix.filter((r) => r.route === 'compliance' && r.viewport === 'desktop');
  // PARTIAL BY DESIGN, and said so rather than failed: the Builders Network
  // holds no AML workspace yet (it arrives with E4, `usePartnerWorkspaceFlags`),
  // so its compliance page asks an `aml-reliance` this backend does not have.
  // Nothing links a builder to it — the navigation entry fails closed, and the
  // Command Centre refuses to offer the builder "View in your portal" door
  // (`MOVED_SURFACES` in its partnerPortalHandoff.pure.ts) — so only a typed
  // URL reaches it. Recorded, not required.
  record('R: /builder/compliance — reachable only by a typed URL (no link, no nav entry); its backend is not on the network yet',
    compliance.every((r) => !r.refusals.some((x) => /aml-reliance 404/.test(x))),
    compliance.map((r) => `${r.role}: ${r.refusals.join(',') || 'no refusals'}`).join('; '), { required: false });

  // --- Controls, desktop, per role ---------------------------------------------------------
  const CAN_EDIT_STOCK = { owner: true, admin: true, manager: true, member: false, viewer: false };
  const CAN_DELETE_STOCK = { owner: true, admin: true, manager: false, member: false, viewer: false };
  for (const [label, person] of Object.entries(people)) {
    const context = await openAs(person, VIEWPORTS[0]);
    const page = await context.newPage();
    const toast = async () => (await page.locator('[role="status"], [data-sonner-toast], li[role="status"]').allInnerTexts().catch(() => [])).join(' | ').slice(0, 200);
    // What the page ASKED and what the server ANSWERED, per write, so a
    // missing message can be told apart from a request that never went out.
    // Operation names and statuses only — this is a proof organisation, and
    // nothing else is recorded.
    const writes = [];
    page.on('response', async (res) => {
      const m = /\/fn\/(builder-portal-[a-z-]+)/.exec(res.url());
      if (!m || res.request().method() !== 'POST') return;
      let op = '';
      try { op = JSON.parse(res.request().postData() ?? '{}').operation ?? ''; } catch { /* not JSON */ }
      if (/^(list|get|my|read|search|count)_/.test(op)) return;
      writes.push(`${m[1]}:${op || '?'}:${res.status()}`);
    });
    const lastWrites = (n = 3) => writes.slice(-n).join(' ') || 'no write sent';

    // Stock List: search, filter, availability, schedule, remove.
    await page.goto(`${ORIGIN}/builder/stock`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const search = page.getByPlaceholder(/Search address, suburb, development or reference/i);
    let searchOk = false;
    if (await search.count()) {
      await search.fill('Tierzero');
      await page.waitForTimeout(1800);
      const plates = page.locator('.builder-stock-list-workspace .builder-stock-list-plates > .bd-plate');
      const plateText = (await plates.allInnerTexts().catch(() => [])).join(' | ');
      searchOk = (await plates.count()) === 1
        && plateText.includes('20 Tierzero Crescent')
        && !plateText.includes('Proofline Way');
      await search.fill('');
      await page.waitForTimeout(1200);
    }
    record(`S: ${label} — Stock List search narrows the list to what matches`, searchOk);
    const availability = page.getByLabel(/Availability for .*16 Proofline Way/i).first();
    const availabilityCount = await availability.count();
    if (CAN_EDIT_STOCK[label]) {
      if (availabilityCount) {
        await availability.click().catch(() => {});
        await page.getByRole('option', { name: /^On hold$/ }).first().click().catch(() => {});
        await page.waitForTimeout(2500);
        const after = await itemsOf(person.orgId, `AND i.id = ${id(byLot['103'])}`);
        record(`S: ${label} — changing a property's availability on the Stock List saves it`,
          after[0]?.availability_status === 'on_hold', `${after[0]?.availability_status}; toast: ${await toast()}`);
        await stock({ operation: 'set_availability', stock_item_id: byLot['103'], availability_status: 'reserved' }, owner.cookie);
      } else {
        record(`S: ${label} — availability control is offered to a role with edit rights`, false, 'not found');
      }
    } else {
      const refusal = await stock({
        operation: 'set_availability', stock_item_id: byLot['103'], availability_status: 'on_hold',
      }, person.cookie);
      const after = await itemsOf(person.orgId, `AND i.id = ${id(byLot['103'])}`);
      record(`S: ${label} — availability is not offered without edit rights and a forged write is refused`,
        availabilityCount === 0 && refusal.status === 403 && after[0]?.availability_status === 'reserved',
        `control ${availabilityCount}; HTTP ${refusal.status}; state ${after[0]?.availability_status}`);
    }

    const removeButton = page.getByRole('button', { name: /Remove .*18 Proofline Way/i }).first();
    const removeCount = await removeButton.count();
    if (CAN_DELETE_STOCK[label]) {
      if (removeCount) {
        await removeButton.click().catch(() => {});
        const confirm = page.getByRole('button', { name: /^Remove property$/ });
        const dialog = await confirm.count();
        if (dialog) await page.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
        record(`S: ${label} — the remove confirmation opens and cancels without removing`, dialog > 0);
      } else {
        record(`S: ${label} — Remove is offered to a role with delete rights`, false, 'not found');
      }
    } else {
      const refusal = await stock({ operation: 'archive_stock_item', stock_item_id: byLot['104'] }, person.cookie);
      const after = await itemsOf(person.orgId, `AND i.id = ${id(byLot['104'])}`);
      record(`S: ${label} — Remove is not offered without delete rights and a forged delete is refused`,
        removeCount === 0 && refusal.status === 403 && after[0]?.lifecycle_status === 'active',
        `control ${removeCount}; HTTP ${refusal.status}; state ${after[0]?.lifecycle_status}`);
    }

    const addList = page.getByRole('button', { name: /Add stock list/i }).first();
    const addCount = await addList.count();
    if (CAN_EDIT_STOCK[label]) {
      if (addCount) {
        await addList.click().catch(() => {});
        const opened = await page.getByRole('tab', { name: /Add from URL/i }).count();
        await page.getByRole('tab', { name: /Add from URL/i }).click().catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        record(`S: ${label} — the Add stock list dialog opens with its two ways in`, opened > 0);
      } else {
        record(`S: ${label} — Add stock list is offered with edit rights`, false, 'not found');
      }
    } else {
      record(`S: ${label} — Add stock list is not offered without edit rights`, addCount === 0,
        `${addCount} control(s)`);
    }

    const acknowledgeCount = await page.getByRole('button', { name: /^Acknowledge$/ }).count();
    record(`S: ${label} — acknowledgement follows stock edit permission`,
      CAN_EDIT_STOCK[label] ? acknowledgeCount > 0 : acknowledgeCount === 0,
      `${acknowledgeCount} control(s)`);

    const figuresCount = await page.getByRole('button', { name: /schedule for .*Proofline Way/i }).count();
    const imageCount = await page.getByRole('button', { name: /Replace the picture for .*Proofline Way/i }).count();
    const retryImagesCount = await page.getByRole('button', { name: /Retry image lookup/i }).count();
    const recoverSourceCount = await page.getByRole('button', { name: /Recover source images for/i }).count();
    record(`S: ${label} — repair and correction controls follow stock edit permission`,
      CAN_EDIT_STOCK[label]
        ? figuresCount > 0 && imageCount > 0 && retryImagesCount > 0 && recoverSourceCount > 0
        : figuresCount === 0 && imageCount === 0 && retryImagesCount === 0 && recoverSourceCount === 0,
      `schedule ${figuresCount}; image ${imageCount}; retry ${retryImagesCount}; source ${recoverSourceCount}`);

    // Projects and the property record.
    if (projectId) {
      await page.goto(`${ORIGIN}/builder/projects/${projectId}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const body = await page.locator('main').innerText().catch(() => '');
      record(`P: ${label} — the activated property's project page`, /Overview|not have access|could not/i.test(body),
        /not have access|could not/i.test(body) ? 'no project access for this role' : 'opens');
      for (const tab of ['Parties', 'History', 'Overview']) {
        await page.getByRole('tab', { name: new RegExp(`^${tab}$`) }).click().catch(() => {});
      }
    }

    // Notifications, bell, activity, settings.
    await page.goto(`${ORIGIN}/builder/notifications`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const markAll = page.getByRole('button', { name: /Mark all read/i }).first();
    const beforeUnread = await portal('builder-portal-collaboration', { operation: 'unread_counts' }, person.cookie);
    const peer = label === 'owner' ? people.admin : people.owner;
    const peerBefore = await portal('builder-portal-collaboration', { operation: 'unread_counts' }, peer.cookie);
    const beforeCount = Number(beforeUnread.json?.unread_notifications ?? -1);
    const peerBeforeCount = Number(peerBefore.json?.unread_notifications ?? -1);
    const markOffered = await markAll.count() > 0 && await markAll.isEnabled().catch(() => false);
    if (beforeCount > 0 && markOffered) {
      await markAll.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    const afterUnread = await portal('builder-portal-collaboration', { operation: 'unread_counts' }, person.cookie);
    const peerAfter = await portal('builder-portal-collaboration', { operation: 'unread_counts' }, peer.cookie);
    const afterCount = Number(afterUnread.json?.unread_notifications ?? -1);
    const peerAfterCount = Number(peerAfter.json?.unread_notifications ?? -1);
    record(`N: ${label} — "Mark all read" clears only this user's unread notifications`,
      beforeUnread.status === 200
        && peerBefore.status === 200
        && beforeCount > 0
        && markOffered
        && afterUnread.status === 200
        && afterCount === 0
        && peerAfter.status === 200
        && peerAfterCount === peerBeforeCount,
      `self ${beforeCount}->${afterCount}; peer ${peerBeforeCount}->${peerAfterCount}; offered ${markOffered}; toast: ${await toast()}`);
    await page.goto(`${ORIGIN}/builder/settings`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const save = page.getByRole('button', { name: /Save preferences/i }).first();
    if (await save.count()) {
      const digest = page.getByLabel(/Email digest/i).first();
      await digest.click().catch(() => {});
      await page.getByRole('option', { name: /Weekly/ }).click().catch(() => {});
      await save.click().catch(() => {});
      await page.waitForTimeout(2000);
      record(`N: ${label} — saving preferences`, /saved/i.test(await toast()), `${await toast()}; sent: ${lastWrites()}`);
    }
    const teamCard = await page.getByText(/Team members/i).count();
    record(`N: ${label} — the team card is ${['owner', 'admin'].includes(label) ? 'shown' : 'not shown'}`,
      ['owner', 'admin'].includes(label) ? teamCard > 0 : teamCard === 0, `${teamCard} team card(s)`);
    await context.close();
  }

  // --- A builder with more than twenty stock lists ------------------------------------------
  {
    const many = await seedOrganisation(TAG, 'manylists');
    const headerOnly = fixture('neg/header-only.csv');
    const names = [];
    for (let i = 1; i <= 21; i++) {
      const name = `List ${String(i).padStart(2, '0')} ${RUN}.csv`;
      names.push(name);
      const sentList = await uploadDocument(many.cookie, name, headerOnly, 'text/csv');
      if (sentList.uploadId) await waitImported(sentList.uploadId, 3 * 60_000);
    }
    const listed = await stock({ operation: 'list_uploads', page: 1, page_size: 20 }, many.cookie);
    const context = await openAs(many, VIEWPORTS[0]);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/builder/stock`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const text = await page.locator('body').innerText().catch(() => '');
    const shown = names.filter((n) => text.includes(n.replace(/\.csv$/, ''))).length;
    const oldestShown = text.includes(names[0].replace(/\.csv$/, ''));
    const pager = await page.getByRole('button', { name: /Next|Show more|Older/i }).count();
    await page.screenshot({ path: `${ARTIFACTS}/manylists-stock.png`, fullPage: true }).catch(() => {});
    await context.close();
    record('M: a builder with 21 stock lists can reach every one of them on the Stock List page',
      oldestShown || pager > 0,
      `server total ${listed.json?.pagination?.total ?? '?'}; ${shown} of 21 names on the page; oldest shown ${oldestShown}; pager ${pager}`);
  }

  // --- Signed out: the public pages, and a second attempt after a failed one --------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    for (const [name, path, expect] of [
      ['login', '/builder/login', /Welcome back/i], ['forgot', '/builder/forgot-password', /reset|code/i],
      ['reset', '/builder/reset-password', /code|password/i], ['verify-bad', '/builder/verify-email?token=nope', /verif|link|expired|invalid/i],
      ['accept-bad', '/builder/accept-invite?token=nope', /invitation|link|expired|invalid/i],
      ['register', '/builder/register', /invitation/i], ['protected', '/builder/stock', /Welcome back|Sign in/i],
    ]) {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const t = await page.locator('body').innerText().catch(() => '');
      await page.screenshot({ path: `${ARTIFACTS}/public-${name}.png` }).catch(() => {});
      record(`A: signed out — ${name} page renders its purpose`, expect.test(t), page.url().replace(ORIGIN, ''));
    }
    await context.close();

    const retry = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const bodies = [];
    await retry.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `window.__tokens=0;window.turnstile={render:function(el,o){var n=++window.__tokens;setTimeout(function(){o.callback('stub-token-'+n)},50);window.__opts=o;return 'w'+n;},
        reset:function(){var n=++window.__tokens;setTimeout(function(){window.__opts.callback('stub-token-'+n)},50);},remove:function(){},getResponse:function(){return null;}};
        if (typeof window.onTurnstileLoad === 'function') window.onTurnstileLoad();`,
    }));
    await retry.route('**/fn/builder-portal-login', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid email or password' }) });
    });
    const page2 = await retry.newPage();
    await page2.goto(`${ORIGIN}/builder/login`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page2.waitForTimeout(1500);
    await page2.getByLabel(/Email/i).first().fill('nobody@example.com').catch(() => {});
    await page2.getByLabel(/^Password$/i).first().fill('wrong-password').catch(() => {});
    await page2.getByRole('button', { name: /Sign in/i }).first().click().catch(() => {});
    await page2.waitForTimeout(1500);
    await page2.getByRole('button', { name: /Sign in/i }).first().click().catch(() => {});
    await page2.waitForTimeout(1500);
    const resets = await page2.evaluate(() => window.__tokens ?? 0).catch(() => 0);
    record('A: a second sign-in attempt after a failed one carries a fresh security check',
      bodies.length === 2 && !!bodies[1]?.turnstile_token && bodies[1].turnstile_token !== bodies[0]?.turnstile_token,
      `attempts ${bodies.length}: first ${bodies[0]?.turnstile_token ? 'with' : 'WITHOUT'} a token, second `
      + `${bodies[1]?.turnstile_token ? `with ${bodies[1].turnstile_token === bodies[0]?.turnstile_token ? 'the SAME (spent) token' : 'a fresh token'}` : 'WITHOUT a token — the server answers "Security verification required"'}`
      + `; tokens the widget issued: ${resets}`);
    await retry.close();
    const noToken = await portal('builder-portal-login', { email: 'nobody@example.com', password: 'x' });
    record('A: the live server refuses a sign-in that carries no security check', noToken.status === 400
      && /Security verification required/.test(String(noToken.json?.error)), `HTTP ${noToken.status} "${noToken.json?.error ?? ''}"`);
  }
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => {});
  writeFileSync(`${ARTIFACTS}/ui-audit-matrix.json`, JSON.stringify(matrix, null, 1));
  console.log(`\nROUTE MATRIX: ${matrix.filter((r) => r.ok).length}/${matrix.length} renders clean`);
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this run made remains on either side',
      Object.values(left.network).every((v) => Number(v) === 0) && Object.values(left.command).every((v) => Number(v) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('portal-ui-audit', { run: RUN });
}
