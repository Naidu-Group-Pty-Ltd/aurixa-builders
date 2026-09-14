/**
 * BUILDER STOCK — ASKING FOR THE LINK TARGETS, WITHOUT EVER DEPENDING ON THE
 * ANSWER.
 *
 * The judgement lives in `linkRecovery.pure.ts`; this is the IO around it. Its
 * whole design is governed by one rule:
 *
 *     AN AUXILIARY RECOVERY SERVICE MUST NEVER BECOME A DEPENDENCY OF STOCK
 *     INGESTION.
 *
 * The import has already succeeded and published before anything here runs. So
 * every failure mode — no webhook configured, the endpoint down, a timeout,
 * a metered plan out of operations, a malformed response — resolves to the
 * same outcome: the upload keeps the truthful `unavailable_source_export`
 * notice it already had, the fallback ladder proceeds exactly as it does
 * today, and a line is logged. Nothing throws, nothing is rolled back, and
 * nothing is retried in a loop.
 *
 * WHAT IS LOGGED, AND WHAT IS NOT. The request id, the upload, the outcome and
 * a status code. Never the webhook URL, never the shared secret, never a
 * recovered address, never a cell value, never a spreadsheet id — a document
 * identifier is a capability for anyone who can reach the document.
 */
import {
  CALLBACK_TOKEN_BYTES, RECOVERY_REQUEST_TTL_MINUTES, outboundRecoveryPayload,
  type RecoveryRequestRecord,
} from './linkRecovery.pure.ts';

const REQUEST_TABLE = 'builder_stock_link_recovery_requests';

/** How long we will wait for the webhook to accept the request. */
const DISPATCH_TIMEOUT_MS = 5_000;

export interface LinkRecoveryAsk {
  organisationId: string;
  uploadId: string;
  spreadsheetId: string;
  gid: string | null;
  origin: 'import' | 'manual_refresh';
}

export interface LinkRecoveryOutcome {
  requested: boolean;
  requestId?: string;
  /** Why nothing was asked. Operational only; never shown to a builder. */
  reason?: string;
}

export function linkRecoveryWebhookConfigured(): boolean {
  return !!(Deno.env.get('MAKE_SHEET_LINKS_WEBHOOK_URL') ?? '').trim();
}

/**
 * Record the request, then ask.
 *
 * IN THAT ORDER, and the order is the security property. The row is the
 * authority the callback will be checked against, so it must exist before
 * anything is told the request id. Asking first and recording afterwards
 * would leave a window in which a valid id has no authority behind it.
 */
export async function requestLinkRecovery(
  db: any,
  ask: LinkRecoveryAsk,
): Promise<LinkRecoveryOutcome> {
  const webhook = (Deno.env.get('MAKE_SHEET_LINKS_WEBHOOK_URL') ?? '').trim();
  if (!webhook) return { requested: false, reason: 'not_configured' };

  /*
   * THE TOKEN IS MINTED HERE AND STORED ONLY AS A HASH.
   *
   * The plaintext exists in this function's memory, in the outbound request,
   * and in the callback that answers it. It is never written down. So a leak
   * of the database yields nothing that can answer a request, and the worst a
   * leak of the token yields is one answer to one question already asked —
   * within half an hour, and only until the real answer arrives first.
   */
  const callbackToken = mintCallbackToken();
  const callbackTokenHash = await sha256Hex(callbackToken);

  let request: RecoveryRequestRecord;
  try {
    const expiresAt = new Date(Date.now() + RECOVERY_REQUEST_TTL_MINUTES * 60_000);
    const { data, error } = await db.from(REQUEST_TABLE).insert({
      organisation_id: ask.organisationId,
      upload_id: ask.uploadId,
      spreadsheet_id: ask.spreadsheetId,
      gid: ask.gid,
      origin: ask.origin,
      expires_at: expiresAt.toISOString(),
      callback_token_hash: callbackTokenHash,
    }).select(
      'id, organisation_id, upload_id, spreadsheet_id, gid, expires_at, callback_token_hash',
    ).single();
    if (error || !data) return { requested: false, reason: 'request_not_recorded' };
    request = data as RecoveryRequestRecord;
  } catch {
    return { requested: false, reason: 'request_not_recorded' };
  }

  const body = JSON.stringify(outboundRecoveryPayload(request, callbackToken));

  let dispatched = false;
  let status = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      status = response.status;
      dispatched = response.ok;
      // The body is not read. Make answers the request through the callback,
      // and anything it returns here is neither trusted nor needed.
    } finally {
      clearTimeout(timer);
    }
  } catch {
    dispatched = false;
  }

  try {
    await db.from(REQUEST_TABLE)
      .update({ status: dispatched ? 'dispatched' : 'failed' })
      .eq('id', request.id);
  } catch {
    // The row's status is diagnostics. Its AUTHORITY is already stored, which
    // is the part the callback depends on.
  }

  console.info('[builder-stock] link recovery requested', {
    phase: 'link_recovery_dispatch',
    request_id: request.id,
    upload_id: ask.uploadId,
    origin: ask.origin,
    dispatched,
    status,
  });

  return dispatched
    ? { requested: true, requestId: request.id }
    : { requested: false, requestId: request.id, reason: 'dispatch_failed' };
}

/**
 * A fresh callback capability token: 256 bits, lower-case hex.
 *
 * `crypto.getRandomValues` is the platform CSPRNG. Nothing about the request
 * feeds into it — a token derived from the request id, the organisation or the
 * clock would be guessable by anyone who knows those, which is the whole set of
 * people it exists to stop.
 */
export function mintCallbackToken(): string {
  const bytes = new Uint8Array(CALLBACK_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256, lower-case hex. The one construction both sides of the token use. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
