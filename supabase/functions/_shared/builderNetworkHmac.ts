/**
 * Per-connection HMAC transport authentication (extraction plan §2/§6).
 *
 * The secret is `workspace_connections.outbound_hmac_secret` — SYMMETRIC and
 * per-connection, RLS-closed, minted builder-side at acceptance. Both ends
 * sign `${timestamp}.${rawBody}` with SHA-256; the timestamp rides in a
 * header and is bounded to ±MAX_SKEW_SECONDS, so a captured request dies of
 * old age and a signature can never be replayed onto a different body.
 *
 * Verification compares digests in constant time. The raw BODY is signed —
 * never a parsed re-serialisation, which is how two ends come to sign two
 * different byte sequences that print identically.
 */

export const HMAC_SIGNATURE_HEADER = 'x-aurixa-signature';
export const HMAC_TIMESTAMP_HEADER = 'x-aurixa-timestamp';
export const HMAC_CONNECTION_HEADER = 'x-aurixa-connection';
export const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function signDelivery(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  return await hmacHex(secret, `${timestamp}.${rawBody}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type HmacVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

export async function verifyDelivery(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowMs = Date.now(),
): Promise<HmacVerdict> {
  const timestamp = headers.get(HMAC_TIMESTAMP_HEADER);
  const signature = headers.get(HMAC_SIGNATURE_HEADER);
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const stampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(stampMs) || Math.abs(nowMs - stampMs) > MAX_SKEW_SECONDS * 1000) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = await signDelivery(secret, timestamp, rawBody);
  return constantTimeEqual(expected, signature.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
