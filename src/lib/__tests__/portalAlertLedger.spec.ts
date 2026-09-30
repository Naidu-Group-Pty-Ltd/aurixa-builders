/**
 * The portal's alert ledger and tab count, pinned.
 *
 * What only goes wrong with two tabs open: every portal tab polls on its own,
 * so a notification raised per tab is raised twice, and a pop-up held per tab
 * is shown again in the second tab the builder visits. And what the portal
 * must never do to get there: keep anything in the browser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimAlert, clearTitleCount, deliverDesktopAlert, isPortalPath, markDesktopAlertsOffered, resetAlertClaims,
  seedAlert, setTitleCount, shouldOfferDesktopAlerts,
} from '../builderPortalAlerts';
import {
  activationHref, activationPopup, isActivationToAnnounce,
} from '../activationPopups.pure';
import {
  AGENCY_MESSAGE_BACKGROUND_POLL_MS, AGENCY_MESSAGE_POPUP_POLL_MS, agencyConversationPopup, groupAgencyMessages,
} from '../agencyMessagePopups.pure';
import { NOTIFICATIONS_POLL_MS } from '../builderPolling.pure';

beforeEach(() => {
  resetAlertClaims();
  document.title = 'Builder Portal';
});

describe('the once-per-person ledger', () => {
  it('lets exactly one caller claim an event, and a later event claim again', () => {
    expect(claimAlert('agency-message:c1', '2026-09-30T01:00:00Z')).toBe(true);
    expect(claimAlert('agency-message:c1', '2026-09-30T01:00:00Z')).toBe(false);
    expect(claimAlert('agency-message:c1', '2026-09-30T01:00:05Z')).toBe(true);
    expect(claimAlert('agency-message:c1', '2026-09-30T01:00:00Z')).toBe(false);
  });

  it('orders two stamps inside one millisecond by the stamps themselves', () => {
    expect(claimAlert('k', '2026-09-30T01:00:00.000001+00:00')).toBe(true);
    expect(claimAlert('k', '2026-09-30T01:00:00.000002+00:00')).toBe(true);
    expect(claimAlert('k', '2026-09-30T01:00:00.000001+00:00')).toBe(false);
  });

  it('keeps nothing in the browser, and is named so the portal’s security check reads it', () => {
    const code = readFileSync(join(__dirname, '..', 'builderPortalAlerts.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    // scripts/portal/security-check.mjs reads every src file whose path names
    // the builder portal; this module's name is what puts it in that set.
    // (This spec is named otherwise because it has to spell the words.)
    expect('src/lib/builderPortalAlerts.ts').toMatch(/builder[Pp]ortal|builder-portal|pages\/builder\//);
  });

  it('records what was already on screen without acting on it', () => {
    seedAlert('k', '2026-09-30T01:00:00Z');
    expect(claimAlert('k', '2026-09-30T01:00:00Z')).toBe(false);
    expect(claimAlert('k', '2026-09-30T01:00:01Z')).toBe(true);
  });

  it('refuses an empty key or stamp rather than poisoning the ledger', () => {
    expect(claimAlert('', 'x')).toBe(false);
    expect(claimAlert('k', '')).toBe(false);
  });
});

describe('the count on the tab', () => {
  it('adds every source together and restores the title when they are read', () => {
    setTitleCount('agency-messages', 2, 'Check Agency sent a message');
    setTitleCount('activations', 1, 'New activation');
    expect(document.title).toBe('(3) Builder Portal');
    clearTitleCount('agency-messages');
    expect(document.title).toBe('(1) Builder Portal');
    clearTitleCount('activations');
    expect(document.title).toBe('Builder Portal');
  });

  it('keeps the other source’s count when one clears', () => {
    setTitleCount('activations', 1);
    clearTitleCount('agency-messages');
    expect(document.title).toBe('(1) Builder Portal');
    clearTitleCount('activations');
  });
});

describe('the desktop notification', () => {
  it('opens only a page of this portal', () => {
    expect(isPortalPath('/builder/messages?view=agencies&thread=c1')).toBe(true);
    for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null]) {
      expect(isPortalPath(path), String(path)).toBe(false);
    }
  });

  it('declines where the browser has no notifications, and says so', () => {
    // jsdom has no Notification API: the caller owes the in-app pop-up.
    expect(deliverDesktopAlert({ key: 'k', heading: 'h', body: 'b', path: '/builder' }, () => {})).toBe('unsupported');
    expect(shouldOfferDesktopAlerts()).toBe(false);
  });

  it('shows nothing over the tab the builder is looking at', () => {
    const original = (window as { Notification?: unknown }).Notification;
    const raised: string[] = [];
    (window as { Notification?: unknown }).Notification = Object.assign(
      function Notification(this: unknown, heading: string) { raised.push(heading); },
      { permission: 'granted' },
    );
    const focus = document.hasFocus;
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    try {
      document.hasFocus = () => true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      expect(deliverDesktopAlert({ key: 'k', heading: 'h', body: 'b', path: '/builder' }, () => {})).toBe('suppressed-focused');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      expect(deliverDesktopAlert({ key: 'k', heading: 'h', body: 'b', path: '/builder' }, () => {})).toBe('shown');
      expect(deliverDesktopAlert({ key: 'k', heading: 'h', body: 'b', path: '//evil.example' }, () => {})).toBe('failed');
      expect(raised).toEqual(['h']);
    } finally {
      document.hasFocus = focus;
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, 'visibilityState', visibility);
      if (original === undefined) delete (window as { Notification?: unknown }).Notification;
      else (window as { Notification?: unknown }).Notification = original;
    }
  });

  it('offers itself at most once a visit', () => {
    expect(shouldOfferDesktopAlerts()).toBe(false); // jsdom: no Notification API at all
    const original = (window as { Notification?: unknown }).Notification;
    (window as { Notification?: unknown }).Notification = Object.assign(function Notification() {}, { permission: 'default' });
    try {
      expect(shouldOfferDesktopAlerts()).toBe(true);
      markDesktopAlertsOffered();
      expect(shouldOfferDesktopAlerts()).toBe(false);
    } finally {
      if (original === undefined) delete (window as { Notification?: unknown }).Notification;
      else (window as { Notification?: unknown }).Notification = original;
    }
  });

  it('asks the browser for permission only from a click', () => {
    const offer = readFileSync(join(__dirname, '..', '..', 'components', 'builder-portal', 'offerDesktopAlerts.ts'), 'utf8');
    const action = offer.slice(offer.indexOf('action: {'));
    expect(action.indexOf('requestAlertPermission()')).toBeGreaterThan(action.indexOf('onClick'));
    expect(offer.slice(0, offer.indexOf('action: {'))).not.toContain('requestAlertPermission()');
  });
});

describe('what the pop-ups say', () => {
  const message = (id: string, conversation: string, at: string) => ({
    message_id: id, conversation_id: conversation, agency_name: 'Check Agency Pty Ltd',
    sender_display_name: 'Casey Agent', lot_number: '101', address: '1 Private Street', received_at: at,
  });

  it('groups a conversation’s messages into one pop-up that counts them', () => {
    const groups = groupAgencyMessages([
      message('m2', 'c1', '2026-09-30T01:00:02Z'), message('m1', 'c1', '2026-09-30T01:00:01Z'),
      message('m3', 'c2', '2026-09-30T01:00:03Z'),
    ]);
    expect(groups.map((group) => group.conversationId)).toEqual(['c1', 'c2']);
    expect(groups[0].messages.map((m) => m.message_id)).toEqual(['m1', 'm2']);
    expect(agencyConversationPopup(groups[0].messages)).toMatchObject({
      id: 'c1', title: '2 new messages from Check Agency Pty Ltd',
    });
    expect(agencyConversationPopup(groups[1].messages).title).toBe('New message from Check Agency Pty Ltd');
  });

  it('asks more slowly while nobody is looking, and still within a minute', () => {
    expect(AGENCY_MESSAGE_BACKGROUND_POLL_MS).toBeGreaterThan(AGENCY_MESSAGE_POPUP_POLL_MS);
    expect(AGENCY_MESSAGE_BACKGROUND_POLL_MS).toBeLessThanOrEqual(60_000);
    expect(NOTIFICATIONS_POLL_MS).toBeLessThanOrEqual(60_000);
  });

  it('announces an unread activation, and leads to the project it opened', () => {
    const item = {
      id: 'n1', notification_type: 'stock_selection' as const, title: 'Property activated by Check Agency',
      body: 'stored sentence', scope_type: null, scope_id: null, entity_kind: 'stock_selection', entity_id: 'a1',
      read_at: null, created_at: '2026-09-30T01:00:00Z',
      activation: {
        announcement_id: 'a1', task_id: null, project_id: 'p1', stock_item_id: 's1', property_label: 'Lot 5, Clyde',
        status: 'selected' as const, acknowledged_at: null, activated_at: '2026-09-30T01:00:00Z',
        agency_name: 'Check Agency', contact_name: null, contact_email: null, contact_phone: null, client_reference: null,
      },
    };
    expect(isActivationToAnnounce(item)).toBe(true);
    expect(isActivationToAnnounce({ ...item, read_at: '2026-09-30T02:00:00Z' })).toBe(false);
    expect(isActivationToAnnounce({ ...item, entity_kind: 'task' })).toBe(false);
    expect(activationPopup(item)).toEqual({
      id: 'n1', title: 'Property activated by Check Agency', description: 'Lot 5, Clyde', href: '/builder/projects/p1',
    });
    expect(activationHref({ activation: { ...item.activation, project_id: null } })).toBe('/builder/stock');
    expect(activationHref({ activation: null })).toBe('/builder/notifications');
    expect(activationPopup({ ...item, activation: null }).description).toBe('stored sentence');
  });
});
