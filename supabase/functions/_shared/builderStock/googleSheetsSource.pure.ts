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
 * There is no public endpoint that enumerates a document's tabs without
 * credentials, so the guard is a PROBE rather than a lookup: ask for a gid
 * that cannot exist, and if the requested gid answers with the same bytes, the
 * gid did not resolve. That is decidable from two responses, needs nothing
 * about the document, and fails closed.
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
 */
export function googleSheetsReadAttempts(ref: GoogleSheetsRef): SheetsReadAttempt[] {
  const base = `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}`;
  const gidQuery = ref.gid ? `&gid=${ref.gid}` : '';
  return [
    { url: `${base}/export?format=csv${gidQuery}`, endpoint: 'export_csv', substitutes: false },
    { url: `${base}/gviz/tq?tqx=out:csv${gidQuery}`, endpoint: 'gviz_csv', substitutes: true },
  ];
}

/** The same endpoint asked for a tab that cannot exist. */
export function sentinelReadUrl(ref: GoogleSheetsRef, attempt: SheetsReadAttempt): string {
  const base = `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}`;
  return attempt.endpoint === 'export_csv'
    ? `${base}/export?format=csv&gid=${SENTINEL_GID}`
    : `${base}/gviz/tq?tqx=out:csv&gid=${SENTINEL_GID}`;
}

export type SheetsResolution =
  | { ok: true; csv: string; endpoint: SheetsReadAttempt['endpoint']; tabProven: boolean }
  | { ok: false; reason: 'gid_unresolved' | 'empty' };

/**
 * Is what came back the tab that was asked for?
 *
 * THE PROBE IS ONLY MEANINGFUL WHERE A GID WAS ASKED FOR. A link with no gid
 * gets the document's first tab, which is Google's documented default and the
 * same tab a person opening the link would see; there is no instruction to
 * honour, so there is nothing to fail closed about. A link WITH a gid is an
 * instruction, and serving a different tab is the one thing this may never do.
 */
export function resolveSheetsPayload(input: {
  ref: GoogleSheetsRef;
  attempt: SheetsReadAttempt;
  body: string;
  sentinelBody: string | null;
}): SheetsResolution {
  const csv = input.body ?? '';
  if (!csv.trim()) return { ok: false, reason: 'empty' };

  if (input.attempt.substitutes && input.ref.gid !== null) {
    // Nothing to compare against is not proof of anything, so it refuses.
    if (input.sentinelBody === null) return { ok: false, reason: 'gid_unresolved' };
    if (normalise(csv) === normalise(input.sentinelBody)) {
      return { ok: false, reason: 'gid_unresolved' };
    }
    return { ok: true, csv, endpoint: input.attempt.endpoint, tabProven: true };
  }

  return {
    ok: true,
    csv,
    endpoint: input.attempt.endpoint,
    // An endpoint that refuses an unknown gid has proven the tab by answering
    // at all; a link with no gid asked for no particular tab.
    tabProven: !input.attempt.substitutes || input.ref.gid === null,
  };
}

/** Trailing-whitespace differences are not a different worksheet. */
function normalise(csv: string): string {
  return csv.replace(/\r\n/g, '\n').trimEnd();
}
