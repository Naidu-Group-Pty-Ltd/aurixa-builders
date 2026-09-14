/**
 * BUILDER STOCK — THE GOOGLE SHEETS HYPERLINK RECOVERY CALLBACK.
 *
 * A Google Sheet whose owner has not enabled file export answers `/export`
 * with a sign-in page, and `/export` is the only public representation that
 * carries a cell's link target. So the brochure addresses behind cells reading
 * "Brochure", "Estate Brochure" or "Masterplan" never reach this product, and
 * stage 1 has nothing to open. The recovery is performed by a Make scenario
 * holding its own authorised Google connection, which reads the same sheet and
 * posts the targets here.
 *
 * THIS IS AN INBOUND WRITE PATH THAT DECIDES WHAT A CLIENT SEES ON A PROPERTY
 * CARD, and it is built accordingly.
 *
 *   THE CALLER CANNOT NAME ITS OWN AUTHORITY. The body carries a request id
 *   and grid data. Which organisation, which upload and therefore which
 *   properties may be touched are read from the row this product wrote when it
 *   asked. Forging the entire payload still reaches nothing, because nothing
 *   in the payload is consulted to decide whose stock is reachable.
 *
 *   AUTHORISATION IS A ONE-TIME CAPABILITY, NOT A SHARED SECRET. Each request
 *   mints its own 256-bit token, sends it to Make, and stores only its
 *   SHA-256. The bearer proves possession on the way back. There is no
 *   long-lived key held in two systems, nothing to distribute, nothing to
 *   rotate, and a token in somebody's execution log is worth exactly one
 *   answer to one question already asked — for half an hour, and only until
 *   the real answer arrives first.
 *
 *   A ROW IS MATCHED BY WHAT IT IS, NEVER BY WHERE IT SITS. Position, order
 *   and count are ignored entirely; each returned row goes through the same
 *   normalisation and property identity the import itself used. Exactly one
 *   match applies the link; zero or several discard it. It is better to lose a
 *   brochure than to put one on the wrong lot.
 *
 *   IT FAILS CLOSED AND WRITES NOTHING ON REFUSAL. Bad signature, stale
 *   timestamp, replay, expiry, a document that is not the one we asked about,
 *   an oversized body — each answers and stops.
 *
 *   THE WORKBOOK IS THE REPRESENTATION, AND THE WORKSHEET IS CHOSEN BY WHAT
 *   IT CONTAINS. Make exports the document as XLSX with its own authorised
 *   Google connection — the one representation that carries link targets at
 *   all — and an export is the WHOLE workbook, recording no gid anywhere. So
 *   the tab is identified by scoring every worksheet against the CSV the
 *   import already proved, and exactly one must win decisively. Zero matches
 *   or two near-identical tabs both apply nothing, because borrowing another
 *   tab's links is the failure this exists to prevent.
 *
 * Nothing here decides anything about an image. A recovered URL is written
 * into the cell it came from and becomes an ordinary builder source; the
 * existing hierarchy, sanitisation, identity and role rules are untouched.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {
  AUTHENTICATED_REFUSALS, MAX_CALLBACK_BYTES, callbackRefusal, decodeWorkbook,
  mergeRecoveredLink, recoveredRowsFromWorksheet, type RecoveryRequestRecord,
} from '../_shared/builderStock/linkRecovery.pure.ts';
import { readWorkbookSheets } from '../_shared/builderStock/workbookSheets.ts';
import {
  GridTooLargeError, gridToWorkbookSheets,
} from '../_shared/builderStock/sheetGrid.pure.ts';
import {
  locateHeaderRow, matchWorksheet, worksheetScore,
} from '../_shared/builderStock/sheetHyperlinks.pure.ts';
import { fetchStockSource } from '../_shared/builderStock/fetchSource.ts';
import { parseDelimited } from '../_shared/builderStock/table.pure.ts';
import { sha256Hex } from '../_shared/builderStock/requestLinkRecovery.ts';
import {
  consumeRateLimit, enforceRawBodyLimit, securityJsonError,
} from '../_shared/requestSecurity.ts';
import { normaliseStockRow } from '../_shared/builderStock/normalise.pure.ts';
import {
  identityDifferences, stockPropertyIdentity,
} from '../_shared/builderStock/stockIdentity.pure.ts';

const REQUEST_TABLE = 'builder_stock_link_recovery_requests';

/** The columns a stored property needs for an identity comparison. */
const ITEM_COLUMNS = 'id, primary_image_id, source_row, development_name, project_name, '
  + 'address_line, suburb, state, postcode, lot_number, unit_number, building_size_sqm';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return securityJsonError(400, 'method_not_allowed');

  const bounded = await enforceRawBodyLimit(req, MAX_CALLBACK_BYTES);
  if (!bounded.ok) return bounded.error;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bounded.raw) as Record<string, unknown>;
  } catch {
    return securityJsonError(400, 'malformed_payload');
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  /*
   * THE ROW IS LOADED BY ID ALONE, AND IT IS THE ONLY AUTHORITY.
   *
   * Everything with consequences — organisation, upload, document, tab — comes
   * from here. The body's copies are compared against it and never trusted in
   * its place.
   */
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
  let request: RecoveryRequestRecord | null = null;
  if (/^[0-9a-f-]{36}$/i.test(requestId)) {
    const { data } = await supabase.from(REQUEST_TABLE)
      .select('id, organisation_id, upload_id, spreadsheet_id, gid, expires_at, '
        + 'consumed_at, status, callback_token_hash')
      .eq('id', requestId).maybeSingle();
    request = (data ?? null) as RecoveryRequestRecord | null;
  }

  /*
   * The presented token is hashed before it is compared, so the plaintext
   * never meets a stored value and a database read can never yield something
   * that answers a request.
   */
  const presented = bearerToken(req.headers.get('authorization'));
  const presentedTokenHash = presented ? await sha256Hex(presented) : null;

  const refusal = callbackRefusal(request, body, Date.now(), presentedTokenHash);
  if (refusal) {
    /*
     * ONLY AN AUTHENTICATED CALLER MAY CAUSE A WRITE, even a diagnostic one.
     * A caller that has not proven possession of this request's token gets an
     * answer and nothing else, so guessing request ids cannot make this
     * product write.
     */
    if (request && AUTHENTICATED_REFUSALS.has(refusal.code)) {
      await supabase.from(REQUEST_TABLE)
        .update({ status: 'refused', refusal_reason: refusal.code })
        .eq('id', request.id).is('consumed_at', null);
    }
    return jsonError(refusal.status, refusal.code);
  }
  const authority = request as RecoveryRequestRecord;

  /*
   * RATE LIMITED ON THE AUTHORITY WE RECOVERED, never on anything the caller
   * said. The key names the organisation from the stored row, so a flood of
   * forged bodies cannot exhaust another organisation's allowance.
   */
  const limit = await consumeRateLimit(
    supabase, `bs:link-recovery:${authority.organisation_id}`, 12, 600);
  if (!limit.allowed) return securityJsonError(429, 'rate_limited');

  /*
   * THE WORKBOOK IS DECODED BEFORE THE REQUEST IS CLAIMED.
   *
   * Decoding is validation rather than work: a payload that is oversized or
   * not base64 tells us nothing about this builder's stock, and burning the
   * one-shot request on it would leave Make unable to answer with a good one.
   * The caller has already proven possession of the token by this point, and
   * the organisation is already rate limited, so this cannot be used to probe.
   */
  const sentWorkbook = typeof body.workbook_base64 === 'string'
    && body.workbook_base64.trim() !== '';
  const decoded = sentWorkbook
    ? decodeWorkbook(String(body.workbook_base64 ?? ''))
    : null;
  if (decoded && !decoded.ok) {
    return jsonError(decoded.reason === 'too_large' ? 413 : 400,
      decoded.reason === 'too_large' ? 'workbook_too_large' : 'workbook_undecodable');
  }

  /*
   * SINGLE-USE, CLAIMED BEFORE THE WORK. The conditional update is the replay
   * guard: a second caller presenting the same id finds nothing to claim and
   * is refused, whatever it carries.
   */
  const { data: claimed } = await supabase.from(REQUEST_TABLE)
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', authority.id).is('consumed_at', null)
    .select('id').maybeSingle();
  if (!claimed) return jsonError(409, 'request_already_consumed');

  /*
   * WHICH WORKSHEET, THOUGH — asked of content, never of position.
   *
   * The workbook carries every tab and no gid. The CSV for the tab the upload
   * was built from is re-read through the same retrieval the import uses, and
   * `matchWorksheet` scores every worksheet against it under the floor and
   * margin that rule already defines. Anything short of a decisive winner
   * applies nothing at all.
   */
  let rows: ReturnType<typeof recoveredRowsFromWorksheet> = [];
  let worksheet = '';
  let refusedFor = '';
  /*
   * WHY A WORKSHEET WAS REFUSED, IN NUMBERS. `no_match` on its own is the
   * least actionable sentence this function can produce — it cannot be told
   * apart from an empty document, a header we failed to find, or a tab that
   * genuinely is not the one asked for. The scores and the shapes are logged
   * so the next refusal is diagnosable from the record rather than from a
   * fresh round of production experiments.
   */
  const diagnosis: Record<string, unknown> = {};
  try {
    /*
     * ONE READER'S WORTH OF WORKSHEETS, FROM WHICHEVER REPRESENTATION CAME.
     * A workbook is parsed; a grid is adapted into the identical shape. What
     * follows — the worksheet match, the row identity, the link merge — cannot
     * tell the two apart, which is the point: a builder whose document may not
     * be downloaded gets the same brochures, decided by the same rules.
     */
    const sheets = decoded && decoded.ok
      ? await readWorkbookSheets(decoded.bytes)
      : gridToWorkbookSheets(body.grid);
    const proven = await fetchStockSource(
      `https://docs.google.com/spreadsheets/d/${authority.spreadsheet_id}/edit`
      + `?gid=${encodeURIComponent(authority.gid ?? '0')}`);
    const matrix = parseDelimited(new TextDecoder('utf-8', { fatal: false })
      .decode(proven.bytes));

    diagnosis.csv_rows = matrix.length;
    diagnosis.csv_columns = (matrix[0] ?? []).length;
    diagnosis.worksheets = sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.values.length,
      header_row: locateHeaderRow(matrix, sheet),
      score: Number(worksheetScore(matrix, sheet).toFixed(4)),
    }));

    const match = matchWorksheet(matrix, sheets);
    if (match.ok) {
      worksheet = match.sheet.name;
      diagnosis.header_row = match.headerRow;
      diagnosis.score = Number(match.score.toFixed(4));
      rows = recoveredRowsFromWorksheet(match.sheet, match.headerRow);
    } else {
      refusedFor = match.reason;
      diagnosis.best = Number(match.best.toFixed(4));
      diagnosis.runner_up = Number(match.runnerUp.toFixed(4));
    }
  } catch (error) {
    // A workbook we could not read, a grid too large to convert, or a CSV we
    // could not re-prove. Either way nothing is known about which tab these
    // links belong to, so nothing is applied — the upload keeps the notice it
    // already had. The oversized grid is named separately because it points at
    // a different remedy from a document we simply could not parse.
    refusedFor = error instanceof GridTooLargeError
      ? 'grid_too_large' : 'workbook_unreadable';
  }

  const { data: items } = await supabase.from('builder_stock_items')
    .select(ITEM_COLUMNS)
    .eq('organisation_id', authority.organisation_id)
    .or(`upload_id.eq.${authority.upload_id},pending_upload_id.eq.${authority.upload_id}`);

  const stored = (items ?? []) as unknown as Array<Record<string, unknown>>;
  const applied = await applyRecoveredLinks(supabase, stored, rows);

  await supabase.from(REQUEST_TABLE).update({
    status: 'fulfilled',
    rows_returned: rows.length,
    links_applied: applied.linksApplied,
    properties_reopened: applied.reopened,
    /*
     * WHY NOTHING CAME BACK, WHERE NOTHING DID. A recovery that reads no rows
     * and records only a zero is indistinguishable from one that read the
     * sheet and found no links — which is exactly how a broken worksheet match
     * came to look like an empty spreadsheet. The reason is kept even on a
     * fulfilled request, because that is the request it needs explaining on.
     */
    refusal_reason: refusedFor || null,
  }).eq('id', authority.id);

  console.info('[builder-stock] link recovery applied', {
    phase: 'link_recovery_callback',
    request_id: authority.id,
    upload_id: authority.upload_id,
    rows_returned: rows.length,
    links_applied: applied.linksApplied,
    properties_reopened: applied.reopened,
    unmatched_rows: applied.unmatched,
    worksheet_matched: !!worksheet,
    worksheet_refused: refusedFor || null,
    worksheet_diagnosis: diagnosis,
  });

  return new Response(JSON.stringify({
    ok: true,
    rows_returned: rows.length,
    links_applied: applied.linksApplied,
    properties_reopened: applied.reopened,
    worksheet_matched: !!worksheet,
    worksheet_refused: refusedFor || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
});

/**
 * Attach each recovered target to the one property it belongs to.
 *
 * The match is `stockPropertyIdentity` over the SAME normalisation the import
 * used, compared with `identityDifferences` — the existing rule, imported
 * rather than re-implemented, so a row that would have matched at import time
 * matches here and nothing else does.
 */
async function applyRecoveredLinks(
  supabase: any,
  items: Array<Record<string, unknown>>,
  rows: ReturnType<typeof recoveredRowsFromWorksheet>,
): Promise<{ linksApplied: number; reopened: number; unmatched: number }> {
  const identities = items.map((item) => ({
    item, identity: stockPropertyIdentity(item as never),
  }));

  let linksApplied = 0;
  let unmatched = 0;
  const reopen: string[] = [];

  for (const row of rows) {
    if (!Object.keys(row.links).length) continue;

    const record = normaliseStockRow(row.values);
    if (!record) { unmatched += 1; continue; }
    const wanted = stockPropertyIdentity(record as never);

    const matches = identities.filter(
      (candidate) => identityDifferences(candidate.identity, wanted).length === 0);
    // FAIL CLOSED. Zero is a row we no longer hold; several is a row whose
    // identity does not distinguish it. Neither may receive a document.
    if (matches.length !== 1) { unmatched += 1; continue; }

    const target = matches[0].item;
    const sourceRow = (target.source_row ?? {}) as Record<string, unknown>;
    const unmapped = { ...((sourceRow.unmapped ?? {}) as Record<string, string>) };
    const recovered = new Set(
      Array.isArray(sourceRow.recovered_link_columns)
        ? (sourceRow.recovered_link_columns as string[]) : []);

    let changed = false;
    for (const [heading, url] of Object.entries(row.links)) {
      const merged = mergeRecoveredLink(unmapped[heading], url);
      if (merged === null) continue;
      unmapped[heading] = merged;
      recovered.add(heading);
      changed = true;
      linksApplied += 1;
    }
    if (!changed) continue;

    const { error } = await supabase.from('builder_stock_items').update({
      source_row: {
        ...sourceRow, unmapped, recovered_link_columns: Array.from(recovered).sort(),
      },
    }).eq('id', target.id);
    if (error) continue;

    /*
     * REOPENED ONLY WHERE THERE IS SOMETHING TO GAIN. A property already
     * holding a stage 1 image has its builder's own picture; re-running the
     * source stage for it would spend a claim to reach the same answer.
     */
    if (!target.primary_image_id) reopen.push(String(target.id));
  }

  let reopened = 0;
  if (reopen.length) {
    const { data } = await supabase.from('builder_stock_items').update({
      image_work_stage: 'source',
      enrichment_status: 'pending',
      image_work_claim_until: null,
      image_work_next_attempt_at: new Date().toISOString(),
      image_work_updated_at: new Date().toISOString(),
    }).in('id', reopen).select('id');
    reopened = ((data ?? []) as unknown[]).length;
  }

  return { linksApplied, reopened, unmatched };
}

/**
 * The bearer token, or null.
 *
 * Only the `Bearer` scheme is accepted, case-insensitively on the scheme
 * alone. Anything else — no header, a bare token, another scheme — is "no
 * token presented", which is refused as its own reading rather than being
 * silently treated as a wrong one.
 */
function bearerToken(header: string | null): string | null {
  const match = /^bearer\s+(.+)$/i.exec((header ?? '').trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: 'Invalid request', code }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
