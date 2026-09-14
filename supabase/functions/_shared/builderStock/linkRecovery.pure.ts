/**
 * BUILDER STOCK — RECOVERING THE LINK TARGETS A GOOGLE SHEET WILL NOT EXPORT.
 *
 * A stock list carries its documents as hyperlinks: the cell reads "Brochure"
 * and the address is underneath it. Google puts those addresses in exactly one
 * public representation — `/export` — and a document whose owner has not
 * enabled file export answers that endpoint with a sign-in page. Measured
 * against a live sheet: `/export` (xlsx and csv) and `/pubhtml` all 401, while
 * `gviz` in every output mode returns the cell TEXT with zero anchors and zero
 * file ids. The address never reaches this product at all.
 *
 * That is not something a better parser fixes. It needs an authenticated read,
 * and this module is the contract for having one performed elsewhere: the
 * import asks a Make scenario — which holds its own authorised Google
 * connection — to read the same sheet and hand back the targets.
 *
 * WHAT THIS MODULE IS FOR. Every decision in that exchange that can be made
 * without IO: when to ask at all, what may be sent, what may be believed on
 * the way back, and how a recovered URL enters the row it belongs to. The IO
 * lives beside it; the judgement lives here so it can be tested without a
 * network, a clock or a database.
 *
 * THE SECURITY POSTURE, STATED ONCE. The callback is an inbound write path
 * that decides what a client sees on a property card. It is therefore built so
 * that the caller CANNOT NAME ITS OWN AUTHORITY: the payload carries a
 * request id and grid data, and every fact with consequences — which
 * organisation, which upload, which properties — is read from the row this
 * product wrote when it asked. A caller who forges a whole body still cannot
 * reach another organisation's stock, because nothing in the body is consulted
 * to decide whose stock is touched.
 *
 * Pure: no IO, no clock, no network. Every function that needs "now" is given
 * it.
 */
import type { HyperlinkAvailability } from './sheetHyperlinks.pure.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a recovery request may be answered for.
 *
 * Long enough for a Make run to retry a transient Google error; short enough
 * that a leaked request id is worthless within the hour. The window is also
 * what bounds row drift: a sheet edited between the ask and the answer is
 * matched by property identity rather than by position, so a longer window
 * would not corrupt anything — it would simply raise the number of rows that
 * no longer resolve and are therefore discarded.
 */
export const RECOVERY_REQUEST_TTL_MINUTES = 30;

/** The largest callback body that will be read. */
export const MAX_CALLBACK_BYTES = 5 * 1024 * 1024;

/**
 * The largest workbook that will be decoded, AFTER base64.
 *
 * WHY A WORKBOOK AND NOT THE SHEETS API's GRID. `spreadsheets.get` will return
 * a grid only when no field mask is set — a mask makes `includeGridData`
 * ignored, so `data` is never populated — and without a mask every cell
 * carries its full formatting. Measured against the live 119-row document:
 * **14.2 MB** for one tab, about 1.4 KB a cell, which the body cap refuses and
 * which a larger builder would only make worse. The same document exports as a
 * compressed workbook two orders of magnitude smaller, and the workbook is the
 * one representation that carries link targets at all.
 *
 * The cap is on the DECODED bytes because base64 inflates by a third, so a
 * body inside `MAX_CALLBACK_BYTES` can still decode to more than a reader
 * should be handed.
 */
export const MAX_WORKBOOK_BYTES = 3 * 1024 * 1024;

/**
 * How much randomness a callback token carries.
 *
 * 32 bytes — 256 bits — because the token IS the authorisation. It is minted
 * per request, so there is no key distribution and nothing to rotate; the only
 * property that matters is that it cannot be guessed within the half hour it
 * is valid for.
 */
export const CALLBACK_TOKEN_BYTES = 32;

/** How often one upload may be refreshed by hand. */
export const MANUAL_REFRESH_WINDOW_SECONDS = 600;

/**
 * THE ONE AVAILABILITY READING THAT WARRANTS ASKING.
 *
 * `resolved` and `none_present` are readings of the SPREADSHEET — the links
 * were read, or the tab genuinely has none — and there is nothing to recover.
 * `unavailable_workbook_unreadable`, `unavailable_no_worksheet_match` and
 * `unavailable_ambiguous_worksheet` are all cases where the workbook DID
 * arrive: an authenticated re-read returns the same bytes and the same
 * problem, so asking would spend an operation to learn nothing.
 *
 * Only `unavailable_source_export` means the file itself never came, which is
 * the one thing a different, authorised reader can change.
 */
export const RECOVERABLE_AVAILABILITY: HyperlinkAvailability = 'unavailable_source_export';

/**
 * WHAT THAT SAME READING WAS CALLED BEFORE IT WAS SPLIT IN TWO.
 *
 * `unavailable_source_sharing` covered both "the document refused to hand over
 * the workbook" and "we got the workbook and could not read it" until those
 * were separated, because they have different remedies. Rows written before
 * that split still carry the old name, and they are overwhelmingly the first
 * case — the second is rare and the first is what a restricted export always
 * produced.
 *
 * IT IS ACCEPTED ONLY WHERE A STORED ROW IS BEING READ: the manual refresh and
 * the control that offers it. The automatic trigger is handed its availability
 * by the current reader, which cannot emit the old name, so widening it there
 * would be accepting a value that can no longer occur.
 */
export const RECOVERABLE_AVAILABILITY_LEGACY = 'unavailable_source_sharing';

/**
 * Does a STORED upload's recorded reason describe links worth asking for?
 *
 * For historical rows only. `shouldRequestLinkRecovery` deliberately does not
 * use this — see above.
 */
export function isRecoverableStoredAvailability(
  reason: string | null | undefined,
): boolean {
  return reason === RECOVERABLE_AVAILABILITY || reason === RECOVERABLE_AVAILABILITY_LEGACY;
}

/**
 * Project an upload row for the browser: keep `error_detail` behind the
 * server, and send the one thing the portal's control needs from it — whether
 * brochure links are waiting to be recovered — as a plain boolean.
 *
 * MEASURED, 2 SEPTEMBER 2026: the portal's "Refresh brochure links" control
 * had NEVER rendered. The page asked this module's question of
 * `upload.error_detail.reason` — a field no list response carries, because
 * `error_detail` holds the internal diagnosis and is deliberately kept off
 * the wire — so the gate always read `undefined`. An automated type-fix then
 * repointed it at `upload.error_code`, which carries the notice code
 * (`source_links_unavailable`), never an availability reason: still always
 * false. Two spellings of the same wrong answer, and no test caught either,
 * because the pin only checked that the page NAMED the rule, not what it fed
 * it.
 *
 * So the server answers the question itself, beside the data only it may
 * read, with exactly the read `refresh_brochure_links` makes before acting —
 * and the page renders that answer. The mutation still re-checks its own row,
 * so a stale list can offer the act and be refused, never the reverse.
 */
export function projectUploadListRow<Row extends { error_detail?: unknown }>(
  row: Row,
): Omit<Row, 'error_detail'> & { link_recovery_available: boolean } {
  const { error_detail, ...safe } = row;
  return {
    ...safe,
    link_recovery_available: isRecoverableStoredAvailability(
      ((error_detail ?? {}) as { reason?: string }).reason ?? null,
    ),
  };
}

// ---------------------------------------------------------------------------
// Should we ask?
// ---------------------------------------------------------------------------

export interface RecoveryTriggerInput {
  /** True only where the import itself succeeded. */
  importSucceeded: boolean;
  /** What the existing reader concluded about this source's links. */
  availability: HyperlinkAvailability | null | undefined;
  /** The document and tab, parsed from the source URL. Null for every other source. */
  spreadsheetId: string | null | undefined;
  /** Whether a webhook is configured at all. */
  webhookConfigured: boolean;
}

/**
 * Ask only where all four hold.
 *
 * Written as one expression of four named facts rather than as branching,
 * because the expensive mistake here is not refusing too often — it is asking
 * for a source that was never a Google Sheet, or when the reader already has
 * the links. Each of those spends a metered operation from a small shared
 * budget and, worse, sends a document identifier to a third party for no
 * reason.
 *
 * THERE IS NO PER-ORGANISATION GATE, DELIBERATELY. A sheet whose links this
 * product cannot read is the same defect whoever uploaded it, and a builder
 * whose brochures silently never arrive is not a support burden worth
 * protecting a budget with. The conditions above already make this narrow —
 * only a Google Sheet, only one reading of it, only where the workbook itself
 * never came — and what bounds the spend is the rate limiting, not a list of
 * approved tenants.
 */
export function shouldRequestLinkRecovery(input: RecoveryTriggerInput): boolean {
  if (!input.importSucceeded) return false;
  if (input.availability !== RECOVERABLE_AVAILABILITY) return false;
  if (!input.spreadsheetId || !input.spreadsheetId.trim()) return false;
  if (!input.webhookConfigured) return false;
  return true;
}

// ---------------------------------------------------------------------------
// What may be sent
// ---------------------------------------------------------------------------

export interface RecoveryRequestRecord {
  id: string;
  organisation_id: string;
  upload_id: string;
  spreadsheet_id: string;
  gid: string | null;
  expires_at: string;
  consumed_at?: string | null;
  status?: string | null;
  /** SHA-256, lower-case hex, of the one-time token. Never the token itself. */
  callback_token_hash: string;
}

export interface OutboundRecoveryPayload {
  request_id: string;
  spreadsheet_id: string;
  gid: string | null;
  callback_token: string;
}

/**
 * THE WHOLE OF WHAT LEAVES THIS PRODUCT.
 *
 * Four fields: which request, which document, which tab, and the one-time
 * token that authorises answering. No organisation, no upload, no property, no
 * row, no customer. Make does not need to know whose sheet it is reading in
 * order to read it, and the callback consults none of it to decide whose stock
 * may be touched, so sending more would be pure risk.
 *
 * THE TOKEN IS A CAPABILITY, NOT A CREDENTIAL. It authorises exactly one
 * answer to exactly one question this product asked, it is useless the moment
 * that answer arrives or the half hour lapses, and only its hash is stored. So
 * it can sit in a third party's execution log without being worth anything —
 * which is the whole reason it replaced a shared secret. A static secret in
 * that same log would be worth every future request.
 *
 * Written as an explicit object rather than a subset of the request row, so a
 * column added to that row later cannot silently start being transmitted —
 * and so that `callback_token_hash` in particular can never be.
 */
export function outboundRecoveryPayload(
  request: RecoveryRequestRecord,
  callbackToken: string,
): OutboundRecoveryPayload {
  return {
    request_id: request.id,
    spreadsheet_id: request.spreadsheet_id,
    gid: request.gid ?? null,
    callback_token: callbackToken,
  };
}

/**
 * Compare two equal-purpose strings without revealing where they differ.
 *
 * Used for the token hash. Both sides are SHA-256 hex of the same length, so
 * the early length return leaks nothing an attacker does not already know.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// What may be believed on the way back
// ---------------------------------------------------------------------------

export interface CallbackBody {
  request_id?: unknown;
  spreadsheet_id?: unknown;
  gid?: unknown;
  /**
   * The exported workbook, base64. Carries link targets, and is available
   * only where the document's owner permits it to be downloaded.
   */
  workbook_base64?: unknown;
  /**
   * A `spreadsheets.get` grid. Carries the same targets cell by cell, and
   * answers where the export refuses — because reading cells and downloading
   * a file are different permissions on the builder's own document.
   */
  grid?: unknown;
}

export type CallbackRefusal =
  | { code: 'malformed_payload'; status: 400 }
  | { code: 'unknown_request'; status: 404 }
  | { code: 'request_already_consumed'; status: 409 }
  | { code: 'request_expired'; status: 409 }
  | { code: 'missing_token'; status: 401 }
  | { code: 'invalid_token'; status: 401 }
  | { code: 'spreadsheet_mismatch'; status: 409 }
  | { code: 'gid_mismatch'; status: 409 };

/**
 * The refusals a caller reached by PROVING it holds the request's token.
 *
 * Only these may write anything — a status stamp on the request row. An
 * unauthenticated caller that guesses a request id must not be able to make
 * this product write, even a diagnostic field, so everything before the token
 * check answers and stops.
 */
export const AUTHENTICATED_REFUSALS: ReadonlySet<string> = new Set([
  'spreadsheet_mismatch', 'gid_mismatch',
]);

/**
 * May this body be acted on for this stored request?
 *
 * Order matters and is deliberate: shape, then existence, then single-use,
 * then freshness, then AUTHORISATION, then binding. Each refusal writes
 * nothing by itself, and none reveals which of the later checks would also
 * have failed.
 *
 * THE TOKEN IS THE AUTHORISATION AND IT IS CHECKED BEFORE THE BINDING. What
 * comes before it is only what can be answered from the request row's own
 * existence and lifetime, which a caller learns nothing from. Everything that
 * follows — and every write — happens only once possession of the one-time
 * token minted for this exact request has been proven.
 *
 * The caller hands in the SHA-256 of the presented token rather than the token,
 * so this stays free of IO and the plaintext never enters a comparison. `null`
 * means no token was presented at all, which is refused separately from a wrong
 * one because the two are different operational faults: one is a scenario that
 * was never configured to send it, the other is a scenario sending the wrong
 * thing or somebody guessing.
 *
 * THE BINDING CHECKS ARE THE POINT. Make is told which spreadsheet and which
 * tab to read; if what comes back names a different document or a different
 * worksheet then either the scenario is misconfigured or an answer to one
 * question is being offered against another. Neither is a state in which a
 * brochure should be attached to a property, so it is refused outright rather
 * than reconciled.
 */
export function callbackRefusal(
  request: RecoveryRequestRecord | null | undefined,
  body: CallbackBody,
  nowMs: number,
  presentedTokenHash: string | null,
): CallbackRefusal | null {
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
  const spreadsheetId = typeof body.spreadsheet_id === 'string'
    ? body.spreadsheet_id.trim() : '';
  if (!requestId || !spreadsheetId) return { code: 'malformed_payload', status: 400 };
  /*
   * EITHER REPRESENTATION, NEVER NEITHER. A workbook and a grid are two ways
   * of reading the SAME document, and which one a builder's sharing settings
   * allow is not ours to choose — so the contract accepts both and requires
   * one. A body carrying neither says nothing about any spreadsheet and is
   * refused on shape, before the request row is consulted at all.
   */
  const workbook = typeof body.workbook_base64 === 'string' ? body.workbook_base64.trim() : '';
  const grid = body.grid !== null && body.grid !== undefined && typeof body.grid === 'object';
  if (!workbook && !grid) return { code: 'malformed_payload', status: 400 };

  if (!request || request.id !== requestId) return { code: 'unknown_request', status: 404 };
  if (request.consumed_at) return { code: 'request_already_consumed', status: 409 };

  const expiresAt = Date.parse(request.expires_at ?? '');
  if (!Number.isFinite(expiresAt) || nowMs > expiresAt) {
    return { code: 'request_expired', status: 409 };
  }

  if (!presentedTokenHash) return { code: 'missing_token', status: 401 };
  if (!request.callback_token_hash
    || !constantTimeEquals(presentedTokenHash, request.callback_token_hash)) {
    return { code: 'invalid_token', status: 401 };
  }

  if (request.spreadsheet_id !== spreadsheetId) {
    return { code: 'spreadsheet_mismatch', status: 409 };
  }
  if (normalisedGid(body.gid) !== normalisedGid(request.gid)) {
    return { code: 'gid_mismatch', status: 409 };
  }
  return null;
}

/**
 * One spelling for "which tab", so the two sides can be compared at all.
 *
 * A gid reaches this product as a URL fragment and returns through a JSON
 * round trip, so the same worksheet can present as `"0"`, `0`, `null`,
 * `undefined` or `""`. Absent and empty are the same statement — no tab was
 * named — and a number and its digits are the same tab.
 */
function normalisedGid(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

export interface RecoveredRow {
  /** Column heading -> displayed cell text, exactly as the sheet shows it. */
  values: Record<string, string>;
  /** Column heading -> link target, for the cells that carry one. */
  links: Record<string, string>;
}

/**
 * Decode the workbook a callback carried, refusing anything oversized.
 *
 * The cap is applied to the DECODED length, computed from the base64 before
 * any of it is turned into bytes — so an enormous body is refused by
 * arithmetic rather than by allocating it first.
 */
export function decodeWorkbook(
  base64: string,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'undecodable' } {
  const clean = String(base64 ?? '').replace(/\s+/g, '');
  if (!clean) return { ok: false, reason: 'undecodable' };

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const decodedLength = Math.floor((clean.length * 3) / 4) - padding;
  if (decodedLength > MAX_WORKBOOK_BYTES) return { ok: false, reason: 'too_large' };

  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

/**
 * Turn the matched worksheet into headed rows.
 *
 * THE WORKSHEET IS CHOSEN BEFORE THIS RUNS, and it is chosen by CONTENT —
 * `matchWorksheet` scores every tab against the CSV the import already proved
 * and demands a decisive winner. An XLSX export is the WHOLE workbook and
 * records no gid anywhere, so position is not identity: the requested tab is
 * routinely not the first, and borrowing a near-identical tab's links is
 * precisely the failure that rule exists to prevent.
 *
 * Here the only job left is pairing each row's cells with their headings, and
 * a link is read at THIS row and THIS column. Nothing is looked up by lot, by
 * address or by anything two rows could share.
 *
 * THE HEADING ROW IS GIVEN, NOT GUESSED. `matchWorksheet` located it by
 * content and hands it over. Assuming row 0 was true of no real document: the
 * live stocklist opens with a banner and spacers and names its columns on the
 * eighth row, so taking `values[0]` produced empty headings, no headed rows,
 * and a recovery that applied nothing while reporting success.
 *
 * Only http(s) targets are kept. A cell may legitimately link within the
 * workbook, to a local file, or to a mail address, and none of those is a
 * document this pipeline can open.
 */
export function recoveredRowsFromWorksheet(sheet: {
  values: (string | null)[][]; links: (string | null)[][];
} | null | undefined, headerRow = 0): RecoveredRow[] {
  const values = sheet?.values ?? [];
  const links = sheet?.links ?? [];
  const head = Number.isInteger(headerRow) && headerRow >= 0 ? headerRow : 0;
  if (values.length < head + 2) return [];

  const headings = (values[head] ?? []).map((cell) => String(cell ?? '').trim());

  const rows: RecoveredRow[] = [];
  for (let index = head + 1; index < values.length; index += 1) {
    const cells = values[index] ?? [];
    const linkCells = links[index] ?? [];
    const rowValues: Record<string, string> = {};
    const rowLinks: Record<string, string> = {};
    let sawAnything = false;

    for (let column = 0; column < headings.length; column += 1) {
      const heading = headings[column];
      if (!heading) continue;
      const text = String(cells[column] ?? '').trim();
      if (text) { rowValues[heading] = text; sawAnything = true; }
      const target = String(linkCells[column] ?? '').trim();
      if (target && /^https?:\/\//i.test(target)) rowLinks[heading] = target;
    }
    if (sawAnything) rows.push({ values: rowValues, links: rowLinks });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// How a recovered URL enters the row it belongs to
// ---------------------------------------------------------------------------

/**
 * Add a recovered target to the cell it came from, under its own heading.
 *
 * THIS IS DELIBERATELY NOT A NEW MODEL. `rowSourceBranches` already walks
 * `source_row.unmapped` and treats any http(s) token it finds as a builder
 * source, carrying the column heading through as provenance. So a recovered
 * link is stored by making the cell look the way it would have looked if the
 * builder had typed the URL beside the label — which is a shape the pipeline
 * has always understood, and which needs no stage-1 change whatsoever.
 *
 * The display text is KEPT. It is what the sheet actually shows, it is what an
 * operator reading the audit record expects to see, and `rowSourceBranches`
 * ignores any token that is not a URL, so nothing is confused by its presence.
 *
 * Returns null where there is nothing to do — no target, or a target the cell
 * already carries — which is what makes a duplicate callback harmless.
 */
export function mergeRecoveredLink(
  existing: string | null | undefined,
  target: string,
): string | null {
  const url = String(target ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const current = String(existing ?? '').trim();
  if (!current) return url;
  // Already present — as the whole value or as one of its tokens.
  if (current.split(/\s+/).some((token) => token.replace(/[),.]+$/, '') === url)) return null;
  return `${current} ${url}`;
}
