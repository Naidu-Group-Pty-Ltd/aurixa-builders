/**
 * Portal alerts — how a new agency message, or an activation of the builder's
 * stock, reaches somebody who is not looking at the portal: in another tab,
 * another window, or another application altogether.
 *
 * Until 30 Sep 2026 the portal's pop-ups reached nobody in that position. The
 * message check stopped asking the moment the tab was hidden, and the
 * activation pop-up lived on the Dashboard page alone — a builder on the
 * Stock List was never told. Three signals now, each degrading into the next:
 *
 *   1. A desktop notification, through the browser's Notification API. Only
 *      with permission, and permission is only ever asked for from a click.
 *      Silent while the reader is looking at this tab — the pop-up has it.
 *   2. A count on the tab's title, which needs no permission at all.
 *   3. The pop-up itself, held until they come back, and shown once.
 *
 * ONE ALERT PER EVENT PER PERSON, not per tab. Every open portal tab polls on
 * its own, so what may only happen once — the desktop notification, the
 * catch-up pop-up — is claimed through a ledger the open tabs share over a
 * `BroadcastChannel`. And a notification carries its event's tag, so should
 * two tabs claim inside the same instant, the operating system collapses the
 * two into one.
 *
 * IT PERSISTS NOTHING IN THE BROWSER. The Builder Portal keeps no
 * localStorage, sessionStorage or cookie of its own (`security:portal` fails
 * the build on any builder source that touches them — which is why this
 * module is named so the check reads it). The ledger lives in memory and is
 * shared with the tabs open now, like the identity channel in
 * `builderPortal.ts`; nothing is left for the next person at this browser.
 * Nothing is lost by it: a fresh page's first check takes a cursor and replays
 * nothing, and activations that were already waiting are recorded rather
 * than announced.
 *
 * It is the portal's counterpart of the Command Centre's
 * `desktopMessageAlerts.ts`, cut to what the portal needs: no service worker
 * (this portal ships none), so a notification is the page's own and its click
 * is routed by the page that raised it.
 */

const CLAIM_CHANNEL = 'aurixa.builder.alerts';
/** The portal's own mark — what its favicon already is. */
const NOTIFICATION_ICON = '/brand/aurixa-favicon-192.png';

export type AlertPermission = 'unsupported' | 'default' | 'denied' | 'granted';

/** Whether this browser has a Notification API at all. */
function notificationsExist(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

export function alertPermission(): AlertPermission {
  if (!notificationsExist()) return 'unsupported';
  return Notification.permission as AlertPermission;
}

/**
 * Ask the browser. Must be called from a click: browsers refuse (or remember
 * as a refusal) a request nobody asked for.
 */
export async function requestAlertPermission(): Promise<AlertPermission> {
  const status = alertPermission();
  if (status !== 'default') return status;
  try {
    return (await Notification.requestPermission()) as AlertPermission;
  } catch {
    return 'denied';
  }
}

/* ------------------------------------------------------------------ the offer */

let offered = false;

/**
 * Whether to offer desktop alerts now: the browser has not been asked, and
 * this visit has not offered already. Remembered for the visit only — the
 * portal keeps nothing in the browser, and the browser remembers the answer.
 */
export function shouldOfferDesktopAlerts(): boolean {
  return !offered && alertPermission() === 'default';
}

export function markDesktopAlertsOffered() {
  offered = true;
}

/* ------------------------------------------------- the once-per-person ledger */

/** The newest stamp each key has been claimed at, in this tab. */
const claims = new Map<string, string>();
let channel: BroadcastChannel | null = null;
let wired = false;

/**
 * Whether `candidate` is later than `existing`. The database stamps
 * microseconds and `Date.parse` keeps milliseconds, so two stamps that parse
 * equal are ordered by the stamps themselves.
 */
function newerThan(candidate: string, existing: string): boolean {
  const a = Date.parse(candidate);
  const b = Date.parse(existing);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return candidate > existing;
}

function remember(key: string, stamp: string) {
  const existing = claims.get(key);
  if (existing && !newerThan(stamp, existing)) return;
  claims.set(key, stamp);
}

function wire() {
  if (wired || typeof BroadcastChannel === 'undefined') return;
  wired = true;
  try {
    channel = new BroadcastChannel(CLAIM_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { key?: unknown; stamp?: unknown } | null;
      if (!data || typeof data.key !== 'string' || typeof data.stamp !== 'string') return;
      remember(data.key, data.stamp);
    };
  } catch {
    channel = null;
  }
}

function record(key: string, stamp: string) {
  claims.set(key, stamp);
  try {
    channel?.postMessage({ key, stamp });
  } catch {
    /* best effort: the notification's tag still collapses a duplicate */
  }
}

/**
 * Become the one tab that acts on this event. True once per (key, stamp)
 * across the open tabs; a later stamp under the same key claims again, so a
 * conversation keeps alerting — it is the duplicates that are suppressed,
 * not the follow-ups.
 */
export function claimAlert(key: string, stamp: string): boolean {
  if (!key || !stamp) return false;
  wire();
  const existing = claims.get(key);
  if (existing && !newerThan(stamp, existing)) return false;
  record(key, stamp);
  return true;
}

/** Record an event as already handled, without acting on it. */
export function seedAlert(key: string, stamp: string) {
  if (!key || !stamp) return;
  wire();
  const existing = claims.get(key);
  if (existing && !newerThan(stamp, existing)) return;
  record(key, stamp);
}

/** Forget every claim in this tab (tests, and a change of reader). */
export function resetAlertClaims() {
  claims.clear();
}

/* --------------------------------------------------------------- the tab title */

let baseTitle: string | null = null;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let flashOn = false;
let flashPrimary = '';
let flashAlt = '';
let clock = 0;
const counts = new Map<string, { count: number; label?: string; at: number }>();

function stopFlashing() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  if (baseTitle !== null && typeof document !== 'undefined') document.title = baseTitle;
  baseTitle = null;
  flashOn = false;
}

function renderTitle() {
  if (typeof document === 'undefined') return;
  let total = 0;
  let latest: { label?: string; at: number } | null = null;
  for (const entry of counts.values()) {
    if (entry.count <= 0) continue;
    total += entry.count;
    if (!latest || entry.at > latest.at) latest = entry;
  }
  if (total <= 0) {
    stopFlashing();
    return;
  }
  if (baseTitle === null) baseTitle = document.title;
  const badge = `(${total > 99 ? '99+' : total})`;
  flashPrimary = `${badge} ${baseTitle}`;
  flashAlt = `${badge} ${latest?.label ?? 'New in the portal'}`;
  document.title = flashPrimary;
  flashOn = false;
  if (flashTimer) return;
  flashTimer = setInterval(() => {
    flashOn = !flashOn;
    document.title = flashOn ? flashAlt : flashPrimary;
  }, 1600);
}

/**
 * Put a count on the tab — the one signal that needs no permission. Each
 * source (messages, activations) publishes its own and the tab shows the sum,
 * flashing a line about whichever rose last.
 */
export function setTitleCount(source: string, count: number, label?: string) {
  const next = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const previous = counts.get(source);
  if (next <= 0) counts.delete(source);
  else {
    const moved = !previous || next > previous.count || label !== previous.label;
    counts.set(source, { count: next, label, at: moved ? ++clock : previous.at });
  }
  renderTitle();
}

export function clearTitleCount(source: string) {
  setTitleCount(source, 0);
}

/* ------------------------------------------------------ the desktop notification */

export interface DesktopAlert {
  /** One notification per key: a later one with the same key replaces it. */
  key: string;
  heading: string;
  body: string;
  /** Where clicking it goes — a path in this portal, never another site. */
  path: string;
}

/**
 * Why a notification did or did not reach the desktop. `suppressed-focused`
 * is not a failure: the reader is looking at this tab and the pop-up has it.
 */
export type AlertOutcome = 'shown' | 'suppressed-focused' | 'denied' | 'unsupported' | 'failed';

const open = new Map<string, Notification>();

/** A path this origin serves: never another site, never `//host`. */
export function isPortalPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

function close(key: string) {
  const notification = open.get(key);
  if (!notification) return;
  try {
    notification.close();
  } catch {
    /* ignore */
  }
  open.delete(key);
}

/**
 * Raise the desktop notification. Safe to call always: it declines when the
 * reader is looking at this tab or the browser has not granted permission,
 * and says which, so the caller knows what it still owes. Callers claim the
 * event first; this does not de-duplicate on its own.
 */
export function deliverDesktopAlert(alert: DesktopAlert, onOpen: (path: string) => void): AlertOutcome {
  if (!notificationsExist()) return 'unsupported';
  if (Notification.permission !== 'granted') {
    return Notification.permission === 'denied' ? 'denied' : 'unsupported';
  }
  if (!alert.key || !isPortalPath(alert.path)) return 'failed';
  if (document.visibilityState === 'visible' && document.hasFocus()) return 'suppressed-focused';
  try {
    close(alert.key);
    const notification = new Notification(alert.heading, {
      body: alert.body,
      // One bubble per event, in every tab: a second tab's raise replaces it.
      tag: `aurixa-builder-${alert.key}`,
      icon: NOTIFICATION_ICON,
    });
    open.set(alert.key, notification);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus can be refused */
      }
      onOpen(alert.path);
      close(alert.key);
    };
    notification.onclose = () => open.delete(alert.key);
    return 'shown';
  } catch {
    return 'failed';
  }
}

/** Close the notification for `key` — what it announced has been opened. */
export function dismissDesktopAlert(key: string) {
  close(key);
}
