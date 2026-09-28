#!/usr/bin/env node
/**
 * ===========================================================================
 * WHAT THE COMMAND CENTRE SHOWS A STAFF MEMBER WHO IS NOT A SUPERADMIN.
 * ===========================================================================
 *
 * The Tier-0 lifecycle proof (28 September 2026) opened lot 101's Builder
 * Stock page as a proof staff member holding Listings access and found none
 * of the property's facts on it — the session was accepted (the page did not
 * send it to sign in), but the property was not drawn. Every genuine Command
 * Centre user of the marketplace is a superadmin, and a superadmin passes
 * every module and plan check by design, so a refusal of anybody else is
 * invisible in production. This probe says which of the page's FIXED states
 * such a staff member meets (`COMMAND_CENTRE_PAGE_STATES`: the guard's own
 * titles, "This property is not available", …) and which functions answered
 * what — nothing else.
 *
 * IT OPENS ONE PAGE THAT CANNOT SHOW GENUINE DATA: a Builder Stock property
 * page for an id that exists nowhere. If the guards admit the staff member it
 * says "This property is not available"; if they refuse, it says which guard.
 * It never opens a list, a dashboard or anything else that draws real stock or
 * clients, it logs no page text, and it takes no screenshot — this repository
 * is public, and so are its Actions logs and artifacts.
 *
 * It creates one disposable staff member (Listings + Client Management, no
 * role that bypasses anything) and one session, reads, and deletes both.
 *
 * Runs from the production-rollout workflow (phase `cc-page-probe`).
 */
import { randomUUID } from 'node:crypto';
import {
  record, cleanup, leftovers, finish, seedStaff, storageFor, NETWORK_REF, inspectCommandCentrePage,
} from './tier0/common.mjs';

const TAG = 'cc-probe';
const NOWHERE = `/listings/builder-stock/${randomUUID()}`;
const VIEWPORTS = [['desktop', 1440, 900], ['phone', 390, 844]];

let storage = null;
let browser = null;
try {
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const staff = await seedStaff(TAG, 'probe', ['listings', 'client_management']);
  record('0: a disposable staff member with Listings and Client Management, and a session', !!staff.token);
  for (const [viewport, width, height] of VIEWPORTS) {
    const seen = await inspectCommandCentrePage(browser, { token: staff.token, path: NOWHERE, viewport: { width, height }, wait: 6_000 });
    console.log(`  property page for an id that exists nowhere (${viewport}) → ${seen.url === NOWHERE ? 'stayed' : seen.url}`);
    console.log(`    states: ${JSON.stringify(seen.states)}`);
    console.log(`    calls: ${seen.calls.join(' ') || '—'}`);
    console.log(`    script errors: ${seen.errors.length}`);
    console.log(`    width: ${seen.overflow ? `${seen.width}px, widest ${JSON.stringify(seen.widest)}` : 'fits'}`);
    record(`${viewport}: the guards admit a Listings holder to a Builder Stock page`,
      seen.states.includes('This property is not available'), JSON.stringify(seen.states), { required: false });
    await seen.context.close();
  }
} catch (error) {
  record('the probe completed', false, String(error?.message ?? error).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this probe made remains on either side',
      Object.values(left.network).every((v) => Number(v) === 0) && Object.values(left.command).every((v) => Number(v) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('cc-page-probe', {});
}
