/**
 * BUILDER STOCK — A GOOGLE SHEETS LINK IS A SPREADSHEET, NOT A WEB PAGE.
 *
 * A builder pastes the address out of their browser:
 *
 *     https://docs.google.com/spreadsheets/d/<ID>/edit?gid=0#gid=0
 *
 * Fetched as an ordinary URL that returns 675 KB of `text/html` — the Google
 * Sheets APPLICATION, not the data. Measured against the repository's own
 * generic table extractor, that page yields two tables: a 101 x 27 grid whose
 * header is the spreadsheet's COLUMN LETTERS (`"", "A", "B", "C" …`) and whose
 * first row is the row-number gutter, and a Google Finance disclaimer. Not one
 * property. The import does not fail; it succeeds at reading the wrong thing.
 *
 * So a Sheets link is resolved to the tab's data through Google's own public
 * read endpoints before the pipeline sees it. Nothing here renders, scrapes or
 * drives a browser, and nothing here parses stock: the answer is CSV, and the
 * CSV goes into the SAME parser every other CSV source already uses.
 *
 *
 * THE GID IS THE TAB, AND AN UNRESOLVED GID IS THE DANGEROUS CASE.
 *
 * Measured against a live document: `gviz/tq` answers an UNKNOWN gid with
 * HTTP 200, `status: "ok"`, and the contents of a different worksheet
 * entirely. Four impossible gids — 1, 2, 123456789, 987654321, 4294967290 —
 * all returned the same byte-identical substitute tab, while gid=0 returned
 * the real stock list. A reader that trusts the status line therefore imports
 * whatever tab Google felt like, silently, and replaces a builder's stock with
 * a page of marketing brochures.
 *
 * THE TABS CAN BE ENUMERATED, AND THAT CORRECTS THIS FILE'S OWN PREMISE. This
 * header used to continue "there is no public endpoint that enumerates a
 * document's tabs without credentials, so the guard is a PROBE rather than a
 * lookup". Measured 18 September 2026, that is wrong: `/htmlview` renders the
 * document's page switcher — every VISIBLE tab, in order, each with its gid —
 * to an anonymous client, on the same document whose `/export` refuses
 * everything with 401. So the tab is now LOOKED UP and the probe is the
 * fallback for when the lookup cannot be had, which is the right way round:
 * a lookup answers "which tab", where a probe only ever answered "not that
 * one".
 *
 * That premise was not merely imprecise, it was load-bearing. Believing the
 * tabs unknowable is what made a gid-less link look like a case with nothing
 * to check — see `SheetsTabAuthority` for what that cost.
 *
 * Pure: no IO, no clock, no network. The caller performs the fetches.
 */

/** Public Google Sheets hosts. Nothing else is treated as a spreadsheet. */
export function isGoogleSheetsUrl(raw: string | null | undefined): boolean {
  const ref = googleSheetsRef(raw);
  return !!ref;
}

export interface GoogleSheetsRef {
  spreadsheetId: string;
  /** The tab the link names, or null when it names none. */
  gid: string | null;
}

/**
 * The document and tab a link names.
 *
 * The gid is carried in the query on some links and in the FRAGMENT on others
 * — a browser's address bar usually shows both, `?gid=0#gid=0` — and a
 * fragment is not sent to a server, so it has to be read here rather than
 * relied upon downstream. The query wins where the two disagree, because it is
 * the half that survives a redirect.
 */
export function googleSheetsRef(raw: string | null | undefined): GoogleSheetsRef | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== 'docs.google.com') return null;

  const match = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/);
  if (!match) return null;

  const fromQuery = url.searchParams.get('gid');
  const fromHash = url.hash ? new URLSearchParams(url.hash.replace(/^#/, '')).get('gid') : null;
  const gid = (fromQuery ?? fromHash ?? '').trim();

  return {
    spreadsheetId: match[1],
    gid: /^\d+$/.test(gid) ? gid : null,
  };
}

/**
 * A gid no document has, used to find out what Google substitutes.
 *
 * Deliberately at the top of the 32-bit range: a real gid is assigned
 * sequentially from a small seed, so this cannot collide with one in practice,
 * and if it ever did the probe would refuse a good read rather than accept a
 * wrong one — which is the direction a guard is allowed to be wrong in.
 */
export const SENTINEL_GID = '4294967290';

/** One entry of the document's own page switcher. */
export interface SheetsTab {
  /** The worksheet id this tab is addressed by. */
  gid: string;
  /** What the tab is called on screen. Diagnostic only; nothing keys on it. */
  name: string;
}

/**
 * WHICH TAB EVERY READ OF THIS DOCUMENT WILL NAME, AND WHAT MAKES THAT SAFE.
 *
 * ONE DOCUMENT, TWO TABS — THE DEFECT THIS TYPE EXISTS TO CLOSE. The comment
 * above used to say a gid-less link "gets the document's first tab, which is
 * Google's documented default and the same tab a person opening the link would
 * see; there is no instruction to honour, so there is nothing to fail closed
 * about." Measured on the reported document, 18 September 2026, every clause
 * of that is wrong. `gviz/tq` with no gid serves the first SHEET, hidden
 * sheets included: the gid-less read and the read for the impossible gid
 * 4294967290 came back byte-identical (sha256 `ddf60eeb…`), both a hidden
 * "VERV AGENT PORTAL" brochure page of eight placeholder rows, while the tab
 * the browser actually opens — "STOCKLIST V002", gid 0 — holds all 47
 * properties. So the one case the substitution guard skipped was the one case
 * that was being substituted, and a builder's whole stock list was replaced by
 * a page they cannot even open.
 *
 * THE RULE IS NOW SIMPLY THIS: A READ ALWAYS NAMES A TAB. `?usp=sharing` is
 * what Google's own Share button produces and it never carries a gid, so this
 * is the ordinary case rather than an edge one. The tab is decided here, once,
 * and both the CSV read and the hyperlink read are built from it — they used
 * to disagree (this module dropped the gid, `htmlViewSheetUrl` defaulted it to
 * `0`), which is why the links of the correct tab were matched against the
 * rows of the wrong one and lent nothing.
 *
 * AND THE AUTHORITY TRAVELS WITH THE TAB, because it decides whether the
 * sentinel probe is still owed. A tab the document's own page switcher listed
 * needs no probe: the list is better evidence than a byte comparison, and
 * insisting on the probe anyway would refuse every SINGLE-TAB document — for
 * one of those, the substitute for an impossible gid IS the only sheet, so the
 * two bodies are identical for a reason that is not a fault.
 */
export type SheetsTabAuthority =
  /** The link named a tab and the page switcher lists it. Proven; no probe. */
  | 'named_and_listed'
  /** The link named no tab; the switcher's FIRST VISIBLE tab is it. No probe. */
  | 'first_visible'
  /** The link named a tab the switcher does not list, or could not be read. */
  | 'named_unlisted'
  /** No tab named and no switcher: gid 0, the original first tab. Probe owed. */
  | 'assumed_first';

export interface SheetsTabPlan {
  spreadsheetId: string;
  /** The tab every read of this document will name. Never null. */
  gid: string;
  authority: SheetsTabAuthority;
  /** Visible tabs the document published; empty when they could not be read. */
  tabs: SheetsTab[];
}

/** Whether a plan still owes the caller a sentinel comparison. */
export function tabPlanNeedsProbe(plan: SheetsTabPlan): boolean {
  return plan.authority === 'named_unlisted' || plan.authority === 'assumed_first';
}

/**
 * Decide the tab, from the link and the document's own page switcher.
 *
 * A gid the switcher does not list is NOT refused outright — a builder may
 * legitimately hold a link to a tab that is hidden today, and the switcher
 * lists only what is visible. It falls through to `named_unlisted`, where the
 * probe decides, so this can never refuse a tab `gviz` would have resolved.
 */
export function resolveSheetsTab(input: {
  ref: GoogleSheetsRef;
  /** From `parseHtmlViewTabs`. Empty when the switcher could not be read. */
  tabs: SheetsTab[];
}): SheetsTabPlan {
  const tabs = input.tabs ?? [];
  const base = { spreadsheetId: input.ref.spreadsheetId, tabs };

  if (input.ref.gid !== null) {
    const listed = tabs.some((tab) => tab.gid === input.ref.gid);
    return { ...base, gid: input.ref.gid, authority: listed ? 'named_and_listed' : 'named_unlisted' };
  }
  if (tabs.length) {
    // The first tab of the switcher is the tab the browser opens on.
    return { ...base, gid: tabs[0].gid, authority: 'first_visible' };
  }
  /*
   * NO SWITCHER AND NO GID: name gid 0 rather than naming nothing. It is the
   * original first tab of every document that has not deleted it, it is what
   * `htmlViewSheetUrl` has always assumed, and — unlike a gid-less read — it
   * is a claim the sentinel probe below can actually test.
   */
  return { ...base, gid: '0', authority: 'assumed_first' };
}

export interface SheetsReadAttempt {
  url: string;
  /** What this endpoint is, for the diagnostic the caller records. */
  endpoint: 'export_csv' | 'gviz_csv';
  /** Whether this endpoint substitutes a tab rather than refusing an unknown gid. */
  substitutes: boolean;
}

/**
 * The public reads to try, in order, and why the order is this way.
 *
 * `export?format=csv` is Google's documented export mechanism: it addresses the
 * tab exactly and answers a non-2xx rather than substituting, so it needs no
 * probe. It is not always available — a document shared "anyone with the link"
 * can still answer 401 there, which is what the reported source does — so
 * `gviz/tq` is the fallback, and the fallback is the one that has to be
 * policed.
 *
 * EVERY URL NAMES THE PLAN'S TAB. There is deliberately no branch that omits
 * the gid: an unnamed tab is what this whole module exists to stop.
 */
export function googleSheetsReadAttempts(plan: SheetsTabPlan): SheetsReadAttempt[] {
  const base = `https://docs.google.com/spreadsheets/d/${plan.spreadsheetId}`;
  const gid = `&gid=${plan.gid}`;
  return [
    { url: `${base}/export?format=csv${gid}`, endpoint: 'export_csv', substitutes: false },
    { url: `${base}/gviz/tq?tqx=out:csv${gid}`, endpoint: 'gviz_csv', substitutes: true },
  ];
}

/** The same endpoint asked for a tab that cannot exist. */
export function sentinelReadUrl(plan: SheetsTabPlan, attempt: SheetsReadAttempt): string {
  const base = `https://docs.google.com/spreadsheets/d/${plan.spreadsheetId}`;
  return attempt.endpoint === 'export_csv'
    ? `${base}/export?format=csv&gid=${SENTINEL_GID}`
    : `${base}/gviz/tq?tqx=out:csv&gid=${SENTINEL_GID}`;
}

export type SheetsResolution =
  | {
    ok: true;
    csv: string;
    endpoint: SheetsReadAttempt['endpoint'];
    /** The tab this payload is, and what proved it. */
    gid: string;
    authority: SheetsTabAuthority;
  }
  | { ok: false; reason: 'gid_unresolved' | 'empty' };

/**
 * Is what came back the tab that was asked for?
 *
 * The probe runs wherever the endpoint substitutes AND the plan has not
 * already been settled by the document's own tab list. It no longer turns on
 * whether the LINK named a gid, because the plan always names one now — that
 * test is what let the substituted read through.
 */
export function resolveSheetsPayload(input: {
  plan: SheetsTabPlan;
  attempt: SheetsReadAttempt;
  body: string;
  sentinelBody: string | null;
}): SheetsResolution {
  const csv = input.body ?? '';
  if (!csv.trim()) return { ok: false, reason: 'empty' };

  const served = {
    ok: true as const,
    csv,
    endpoint: input.attempt.endpoint,
    gid: input.plan.gid,
    authority: input.plan.authority,
  };

  if (input.attempt.substitutes && tabPlanNeedsProbe(input.plan)) {
    // Nothing to compare against is not proof of anything, so it refuses.
    if (input.sentinelBody === null) return { ok: false, reason: 'gid_unresolved' };
    if (normalise(csv) === normalise(input.sentinelBody)) {
      return { ok: false, reason: 'gid_unresolved' };
    }
  }
  return served;
}

/** Trailing-whitespace differences are not a different worksheet. */
function normalise(csv: string): string {
  return csv.replace(/\r\n/g, '\n').trimEnd();
}
