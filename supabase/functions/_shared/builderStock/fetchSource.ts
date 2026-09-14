/**
 * Builder stock lists — retrieving a source the builder linked to.
 *
 * THE SSRF CONTROL IS THE EXISTING ONE. `assertPublicUrl` and
 * `isPrivateOrReservedAddress` come from `_shared/ssrfGuard.ts` — the
 * guard the link importer already uses, already covered by its own unit tests,
 * and already the place this deployment states which address space is
 * off-limits. A second implementation here would be a second thing to keep
 * right, and the two would drift the first time a range was added to one.
 *
 * The fetch itself mirrors `import-from-url`'s `safeFetch`: redirects are
 * followed MANUALLY so that every hop is re-checked, because a public hostname
 * that 302s to 169.254.169.254 is the whole attack.
 *
 * WHAT IS NEVER SENT: no cookie, no Authorization header, no Supabase key, no
 * portal session. The request carries a User-Agent and an Accept and nothing
 * else, and `credentials` never applies because nothing is attached to omit.
 */
import { assertPublicUrl, type DnsRecordType } from '../ssrfGuard.ts';

/** One hop's wall clock. */
const HOP_TIMEOUT_MS = 15_000;
/** The whole retrieval, redirects included. */
const TOTAL_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * 25 MB, the same ceiling `MAX_STOCK_FILE_BYTES` puts on an upload. A linked
 * source must not be a way to put a bigger object in the bucket.
 */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/*
 * `Deno.resolveDns` exists in the edge runtime but not in the browser-side
 * ambient shim this module is dragged into by the unit tests, so the global is
 * narrowed here rather than being widened for every consumer of `Deno`.
 */
const denoDns = Deno as unknown as {
  resolveDns(hostname: string, recordType: DnsRecordType): Promise<string[]>;
};

const resolveDns = (hostname: string, recordType: DnsRecordType) =>
  denoDns.resolveDns(hostname, recordType);

import {
  googleSheetsReadAttempts, googleSheetsRef, resolveSheetsPayload, sentinelReadUrl,
  type GoogleSheetsRef,
} from './googleSheetsSource.pure.ts';
import {
  htmlViewSheetUrl, parseHtmlViewGrid,
} from './googleSheetsHtmlGrid.pure.ts';
import {
  matchWorksheet, mergeHyperlinkColumns, type HyperlinkAvailability, type WorkbookSheet,
} from './sheetHyperlinks.pure.ts';
import { sharedLinkFileUrl } from './sourceBranches.pure.ts';
import { readWorkbookSheets } from './workbookSheets.ts';
import { parseDelimited } from './table.pure.ts';
import { matrixToCsv } from './notionRecordMap.pure.ts';

export interface FetchedSource {
  bytes: Uint8Array;
  /**
   * Whether a spreadsheet source's hyperlink targets were recoverable.
   *
   * Absent for every other kind of source. Present and NOT `resolved` means
   * link-bearing cells were read as labels only — which is a fact about our
   * access to the document, never a finding that the property has no builder
   * imagery. See `sourcesFullyEnumerable`.
   */
  hyperlinks?: HyperlinkAvailability;
  /** Which public representation surrendered the link targets, when one did. */
  hyperlinkMethod?: 'workbook_export' | 'htmlview';
  /** What the server said it was. A claim, checked against the bytes later. */
  declaredContentType: string;
  /** After redirects. This is what gets recorded as `final_url`. */
  finalUrl: string;
  status: number;
}

/** A retrieval failure carrying a message that is safe to show the builder. */
export class SourceFetchError extends Error {
  readonly code: string;
  readonly safeMessage: string;
  constructor(code: string, safeMessage: string) {
    super(`${code}: ${safeMessage}`);
    this.name = 'SourceFetchError';
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

/**
 * Retrieve a public URL, or refuse with a reason a builder can act on.
 *
 * `startUrl` must already have passed `normaliseStockSourceUrl`, which settles
 * the scheme. This settles the destination.
 */
export async function fetchStockSource(startUrl: string): Promise<FetchedSource> {
  /*
   * A GOOGLE SHEETS LINK IS RESOLVED TO ITS DATA BEFORE ANYTHING ELSE.
   *
   * Fetched as an ordinary URL it answers 675 KB of `text/html` — the Sheets
   * APPLICATION — and the generic table extractor reads a 101 x 27 grid whose
   * header is the spreadsheet's column letters and whose first column is the
   * row-number gutter. The import does not fail; it succeeds at reading the
   * wrong thing, which is worse.
   *
   * Done here rather than at the caller so that EVERY retrieval gets it: the
   * import, the source-image repair and anything added later all come through
   * this one function, and a builder may paste a Sheets link into any of them.
   */
  const sheets = googleSheetsRef(startUrl);
  if (sheets) return await fetchGoogleSheet(sheets, startUrl);

  /*
   * AND A SHARED-LINK HOST IS ASKED FOR THE FILE, for the same reason and in
   * the same place. A Dropbox brochure link answers 207 KB of `text/html` —
   * the viewer application — where the PDF behind it is 6.2 MB, and every one
   * of the live Luxton source's thirteen brochures came back that way. See
   * `sharedLinkFileUrl`: it moves a query parameter the host publishes and
   * nothing else, so the address the SSRF guard judges is the address it would
   * have judged.
   */
  return await fetchOrdinaryUrl(sharedLinkFileUrl(startUrl));
}

/**
 * Read one tab of a public Google Sheet through Google's own endpoints.
 *
 * Each candidate goes through `fetchOrdinaryUrl`, so the SSRF guard, the
 * redirect policy, the timeouts and the byte cap are the existing ones — this
 * chooses addresses, it does not fetch differently.
 */
async function fetchGoogleSheet(
  ref: GoogleSheetsRef,
  startUrl: string,
): Promise<FetchedSource> {
  let lastRefusal: SourceFetchError | null = null;

  for (const attempt of googleSheetsReadAttempts(ref)) {
    let body: FetchedSource;
    try {
      body = await fetchOrdinaryUrl(attempt.url);
    } catch (error) {
      // A document that refuses one endpoint may serve another: the reported
      // source answers 401 on `export` and 200 on `gviz`. Keep the refusal in
      // case every endpoint refuses, so the builder is told the real reason.
      if (error instanceof SourceFetchError) { lastRefusal = error; continue; }
      throw error;
    }

    /*
     * WHAT CAME BACK MUST BE THE TAB THAT WAS ASKED FOR.
     *
     * `gviz` answers an unknown gid with 200, `status: "ok"` and a DIFFERENT
     * worksheet. So where the link named a gid and the endpoint is one that
     * substitutes, the same endpoint is asked for a tab that cannot exist and
     * the two answers are compared. Identical means the gid did not resolve.
     */
    let sentinelBody: string | null = null;
    if (attempt.substitutes && ref.gid !== null) {
      try {
        sentinelBody = decodeUtf8(
          (await fetchOrdinaryUrl(sentinelReadUrl(ref, attempt))).bytes);
      } catch {
        sentinelBody = null;
      }
    }

    const resolved = resolveSheetsPayload({
      ref, attempt, body: decodeUtf8(body.bytes), sentinelBody,
    });

    if (resolved.ok === false) {
      if (resolved.reason === 'gid_unresolved') {
        throw new SourceFetchError(
          'sheet_tab_not_found',
          'That link names a tab this spreadsheet does not have. '
            + 'Open the tab you want and copy the address again.',
        );
      }
      continue;
    }

    /*
     * THE LINKS THE CSV THREW AWAY, IF THE WORKBOOK WILL GIVE THEM UP.
     *
     * A stock list keeps its documents as hyperlinks — the cell says
     * `Brochure`, the address is underneath — and every CSV export writes the
     * label and discards the target. XLSX keeps them, so the workbook is asked
     * for the same tab's links and they are appended as columns beside the
     * rows they belong to.
     *
     * MEMBERSHIP DOES NOT MOVE. `resolved.csv` is still the whole of which
     * properties exist, in its order, with its values. This can only ever add
     * columns, and it is skipped entirely the moment anything about it is
     * uncertain — a workbook that will not open, a tab that cannot be
     * identified decisively, or two tabs that look alike.
     */
    const enriched = await enrichWithHyperlinks(ref, resolved.csv);

    return {
      bytes: new TextEncoder().encode(enriched.csv),
      // It IS a CSV now, whatever the endpoint labelled it, and saying so is
      // what puts it through the parser every other CSV source uses.
      declaredContentType: 'text/csv',
      finalUrl: attempt.url,
      status: body.status,
      hyperlinks: enriched.availability,
      hyperlinkMethod: enriched.method,
    };
  }

  if (lastRefusal) throw lastRefusal;
  throw new SourceFetchError(
    'sheet_unreadable',
    'That spreadsheet could not be read. Share it so anyone with the link can '
      + 'view it, or upload the stock list instead.',
  );
}

/**
 * Ask the workbook for the selected tab's hyperlink targets.
 *
 * Every refusal is an availability reading rather than an error: the CSV is
 * already proven and the import proceeds on it. What must never happen is the
 * import proceeding while REPORTING that it saw the builder's sources.
 */
async function enrichWithHyperlinks(
  ref: GoogleSheetsRef,
  csv: string,
): Promise<{
  csv: string;
  availability: HyperlinkAvailability;
  /** Which public representation surrendered the targets, when one did. */
  method?: 'workbook_export' | 'htmlview';
}> {
  const matrix = parseDelimited(csv);
  if (matrix.length < 2) return { csv, availability: 'none_present' };

  /*
   * TWO PUBLIC SOURCES OF LINK TARGETS, TRIED IN ORDER, MERGED BY ONE RULE.
   *
   * The workbook export is first: it is the richest representation (every
   * tab, HYPERLINK formulas, hidden columns included) and the one this
   * pipeline has always read. But a document shared "anyone with the link can
   * view" whose owner disabled download answers 401 to EVERY `export?format=…`
   * while serving its rows over `gviz` — the live VG master list does exactly
   * that — and this comment used to claim that only `/export` carries link
   * targets. Measured on that document, that was wrong by one:
   * `htmlview/sheet?gid=N` is a server-rendered grid of the VISIBLE tab
   * carrying every anchor, and it honours the gid outright (an unknown gid is
   * HTTP 400, not a substituted tab). See `googleSheetsHtmlGrid.pure.ts` for
   * the full survey.
   *
   * WHAT DOES NOT VARY IS THE MERGE. Whichever source answered is converted
   * to the same `WorkbookSheet` shape and goes through the same
   * `matchWorksheet` / `alignWorksheetRows` / `mergeHyperlinkColumns` — the
   * tab proven by content, every row proven by content, every target laid
   * beside its own row. A link source that cannot pass those proofs lends
   * nothing, whatever endpoint served it.
   */
  let sheets: WorkbookSheet[] | null = null;
  let method: 'workbook_export' | 'htmlview' = 'workbook_export';
  let workbookRefused: HyperlinkAvailability | null = null;
  try {
    // The workbook export carries no gid — it is the WHOLE document — which is
    // exactly why the worksheet is identified by content below.
    const fetched = await fetchOrdinaryUrl(
      `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/export?format=xlsx`);
    try {
      sheets = await readWorkbookSheets(fetched.bytes);
    } catch {
      // We got the file and could not read it. A different fault, and a
      // different remedy, from a document that refused to send it.
      workbookRefused = 'unavailable_workbook_unreadable';
    }
  } catch {
    workbookRefused = 'unavailable_source_export';
  }

  if (!sheets) {
    try {
      const page = await fetchOrdinaryUrl(htmlViewSheetUrl(ref.spreadsheetId, ref.gid));
      const grid = parseHtmlViewGrid(decodeUtf8(page.bytes));
      if (grid) {
        sheets = [grid];
        method = 'htmlview';
      }
    } catch {
      // The grid was refused too. The workbook's refusal remains the answer.
    }
  }

  if (!sheets) {
    return { csv, availability: workbookRefused ?? 'unavailable_source_export' };
  }

  const match = matchWorksheet(matrix, sheets);
  if (match.ok === false) {
    return {
      csv,
      availability: match.reason === 'ambiguous'
        ? 'unavailable_ambiguous_worksheet'
        : 'unavailable_no_worksheet_match',
    };
  }

  const merged = mergeHyperlinkColumns(matrix, match.sheet);
  if (!merged.linksResolved) return { csv, availability: 'none_present', method };

  return { csv: matrixToCsv(merged.matrix), availability: 'resolved', method };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** The retrieval every source has always used. Unchanged. */
async function fetchOrdinaryUrl(startUrl: string): Promise<FetchedSource> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  let current: URL;
  try {
    current = await assertPublicUrl(startUrl, resolveDns);
  } catch (error) {
    throw refusal(error);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() >= deadline) {
      throw new SourceFetchError('source_timeout', 'That address took too long to respond.');
    }

    const controller = new AbortController();
    const budget = Math.min(HOP_TIMEOUT_MS, Math.max(1000, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), budget);

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        // Deliberately minimal, and deliberately not credentialed.
        headers: {
          'User-Agent': 'NPC-BuilderStock/1.0',
          Accept: 'text/html,application/xhtml+xml,application/pdf,text/csv,'
            + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.8',
          'Accept-Language': 'en-AU,en;q=0.9',
        },
      });
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError';
      throw new SourceFetchError(
        aborted ? 'source_timeout' : 'source_unreachable',
        aborted
          ? 'That address took too long to respond.'
          : 'That address could not be reached.',
      );
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SourceFetchError('source_bad_redirect', 'That address redirected somewhere unreadable.');
      }
      // EVERY hop, not just the first. This is the check that stops a public
      // hostname from bouncing the fetch into the private network.
      try {
        current = await assertPublicUrl(next.toString(), resolveDns);
      } catch (error) {
        throw refusal(error);
      }
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new SourceFetchError(
        'source_forbidden',
        'That page is not publicly accessible. Share it publicly, or upload the stock list instead.',
      );
    }
    if (response.status === 404 || response.status === 410) {
      throw new SourceFetchError('source_not_found', 'Nothing was found at that address.');
    }
    if (!response.ok) {
      throw new SourceFetchError('source_error_status', 'That address returned an error.');
    }

    // Believe a declared length when it is over the ceiling: it saves
    // downloading 500 MB to find out.
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
      throw new SourceFetchError('source_too_large', 'That file is larger than the 25 MB limit.');
    }

    const bytes = await readCapped(response, deadline);
    if (!bytes.length) {
      throw new SourceFetchError('source_empty', 'That address returned an empty document.');
    }

    return {
      bytes,
      declaredContentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
      finalUrl: current.toString(),
      status: response.status,
    };
  }

  throw new SourceFetchError('source_too_many_redirects', 'That address redirected too many times.');
}

/**
 * POST a JSON body to a public endpoint and read a JSON answer, under exactly
 * the same guard, timeouts and size ceiling as `fetchStockSource`.
 *
 * This exists for ONE caller: recovering a PUBLIC Notion page's own content
 * from Notion's public, unauthenticated endpoints, which is the only way that
 * content exists at all (the first HTML response is a rendering shell). It is
 * not a general-purpose client and deliberately cannot become one:
 *
 *   • `assertPublicUrl` runs on the destination, same as a GET;
 *   • a redirect is REFUSED rather than followed — an API POST that bounces is
 *     not something to chase, and refusing keeps "every destination went
 *     through the guard" true by construction;
 *   • nothing credentialed is sent. No cookie, no Authorization, no Supabase
 *     key, no builder session. The headers below are the whole request.
 */
export async function postGuardedJson(
  rawUrl: string,
  payload: unknown,
  options: { deadline?: number } = {},
): Promise<{ status: number; json: unknown; byteLength: number }> {
  const deadline = options.deadline ?? (Date.now() + TOTAL_TIMEOUT_MS);

  let target: URL;
  try {
    target = await assertPublicUrl(rawUrl, resolveDns);
  } catch (error) {
    throw refusal(error);
  }

  const controller = new AbortController();
  const budget = Math.min(HOP_TIMEOUT_MS, Math.max(1000, deadline - Date.now()));
  const timer = setTimeout(() => controller.abort(), budget);

  let response: Response;
  try {
    response = await fetch(target.toString(), {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'NPC-BuilderStock/1.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === 'AbortError';
    throw new SourceFetchError(
      aborted ? 'source_timeout' : 'source_unreachable',
      aborted
        ? 'That address took too long to respond.'
        : 'That address could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    // Not followed, so nothing reaches an address the guard has not seen.
    try { await response.body?.cancel(); } catch { /* already drained */ }
    throw new SourceFetchError('source_bad_redirect', 'That address redirected somewhere unreadable.');
  }

  const bytes = await readCapped(response, deadline);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed, byteLength: bytes.length };
}

/**
 * Read the body, stopping at the ceiling.
 *
 * Streamed rather than `arrayBuffer()`d: a server that lies about
 * `content-length`, or omits it, must not be able to make us buffer an
 * unbounded response.
 */
async function readCapped(response: Response, deadline: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        throw new SourceFetchError('source_timeout', 'That address took too long to respond.');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        throw new SourceFetchError('source_too_large', 'That file is larger than the 25 MB limit.');
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the stream is already done */ }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Translate a guard rejection into a builder-facing refusal.
 *
 * The guard's own wording names the address space, which is internal detail;
 * what the builder needs to know is that the link points somewhere we will not
 * go.
 */
function refusal(error: unknown): SourceFetchError {
  const message = String((error as { message?: string })?.message ?? '');
  if (/private|internal/i.test(message)) {
    return new SourceFetchError(
      'source_private_address',
      'That address points inside a private network, so it cannot be read.',
    );
  }
  if (/resolve/i.test(message)) {
    return new SourceFetchError('source_unresolvable', 'That website could not be found.');
  }
  if (/http\(s\)/i.test(message)) {
    return new SourceFetchError('source_scheme_not_allowed', 'Only http:// and https:// addresses can be read.');
  }
  return new SourceFetchError('source_url_invalid', 'That does not look like a web address.');
}
