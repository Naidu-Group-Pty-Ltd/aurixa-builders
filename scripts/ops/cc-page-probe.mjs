#!/usr/bin/env node
/**
 * ===========================================================================
 * WHAT THE COMMAND CENTRE DRAWS FOR A STAFF MEMBER WHO IS NOT A SUPERADMIN.
 * ===========================================================================
 *
 * The Tier-0 lifecycle proof (28 September 2026) opened lot 101's Builder
 * Stock page as a proof staff member holding Listings access and found none
 * of the property's facts on it — the session was accepted (the page did not
 * send it to sign in) and a picture was drawn, but not the property. Every
 * genuine Command Centre user of the marketplace is a superadmin, and a
 * superadmin passes every module and plan check by design, so a refusal of
 * anybody else is invisible in production. This probe says what such a staff
 * member is actually shown, and why, without guessing: for each page it
 * records where the page ended up, its headings and alerts, the start of its
 * text, every function it called with the status it got back, script errors
 * and, when the page is wider than the screen, the widest element.
 *
 * It creates one disposable staff member (Listings + Client Management, no
 * role that bypasses anything) and one session, reads, and deletes both. It
 * writes nothing else anywhere and asserts nothing about the product — its
 * output is evidence for a finding, not a verdict.
 *
 * Runs from the production-rollout workflow (phase `cc-page-probe`).
 */
import { mkdirSync } from 'node:fs';
import {
  record, cleanup, leftovers, finish, seedStaff, storageFor, NETWORK_REF, inspectCommandCentrePage,
} from './tier0/common.mjs';

const TAG = 'cc-probe';
const ARTIFACTS = 'proof-artifacts';
mkdirSync(ARTIFACTS, { recursive: true });

const PAGES = [
  ['dashboard', '/dashboard'],
  ['listings', '/listings?section=builder-stock'],
  ['property', '/listings/builder-stock/00000000-0000-4000-8000-000000000000'],
];
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
  for (const [name, path] of PAGES) {
    for (const [viewport, width, height] of VIEWPORTS) {
      const seen = await inspectCommandCentrePage(browser, { token: staff.token, path, viewport: { width, height }, wait: 6_000 });
      await seen.page.screenshot({ path: `${ARTIFACTS}/cc-${name}-${viewport}.png`, fullPage: true }).catch(() => {});
      console.log(`  ${name} (${viewport}) → ${seen.url}`);
      console.log(`    headings: ${JSON.stringify(seen.headings)}`);
      console.log(`    calls: ${seen.calls.join(' ') || '—'}`);
      console.log(`    errors: ${seen.errors.slice(0, 4).join(' | ') || '—'}`);
      console.log(`    width: ${seen.overflow ? `${seen.width}px, widest ${JSON.stringify(seen.widest)}` : 'fits'}`);
      console.log(`    text: ${seen.snippet}`);
      record(`${name} (${viewport}): the page was read`, !!seen.snippet, '', { required: false });
      await seen.context.close();
    }
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
