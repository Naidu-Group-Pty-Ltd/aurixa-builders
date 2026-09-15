/**
 * The transport handshake, protocol level.
 *
 * Both ends of a connection sign `${timestamp}.${rawBody}` with the same
 * per-connection secret and the same shared module (the clone carries a
 * byte-identical copy of builderNetworkHmac.ts), so a real sign→verify
 * round trip HERE is a real test of a network↔clone delivery: the sender
 * half below builds the exact headers builder-network-outbox-worker sends,
 * and the receiver half verifies them exactly as builder-network-inbound
 * (either side's) does.
 *
 * The provisioning rules — the secret leaves the network once, through the
 * federated operator door, and never through a Builder Portal read — are
 * pinned at the source alongside.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HMAC_CONNECTION_HEADER,
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  MAX_SKEW_SECONDS,
  signDelivery,
  verifyDelivery,
} from '../../../supabase/functions/_shared/builderNetworkHmac';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SECRET = 'b1946ac92492d2347c6235b4d2611184b1946ac92492d2347c6235b4d2611184';
const CONNECTION_ID = '4d1f0f27-6a86-4c39-9d3d-2a4c14b6a555';

/** Compose a delivery exactly as builder-network-outbox-worker does. */
async function composeDelivery(secret: string, rawBody: string, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = await signDelivery(secret, timestamp, rawBody);
  return new Headers({
    'Content-Type': 'application/json',
    [HMAC_CONNECTION_HEADER]: CONNECTION_ID,
    [HMAC_TIMESTAMP_HEADER]: timestamp,
    [HMAC_SIGNATURE_HEADER]: signature,
  });
}

describe('a test delivery signs on one end and verifies on the other', () => {
  const rawBody = JSON.stringify({
    event_type: 'stock.selection.acknowledged',
    dedupe_key: `stock.selection.acknowledged:${CONNECTION_ID}:ref-1`,
    payload: { remote_selection_ref: 'ref-1', status: 'builder_acknowledged' },
    source_version: 3,
  });

  it('round-trips', async () => {
    const headers = await composeDelivery(SECRET, rawBody);
    expect(await verifyDelivery(SECRET, headers, rawBody)).toEqual({ ok: true });
  });

  it('refuses a tampered body — the RAW body is what is signed', async () => {
    const headers = await composeDelivery(SECRET, rawBody);
    const tampered = rawBody.replace('"source_version":3', '"source_version":4');
    expect(await verifyDelivery(SECRET, headers, tampered))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses the wrong secret — rotation invalidates the old credential', async () => {
    const headers = await composeDelivery(SECRET, rawBody);
    const rotated = SECRET.split('').reverse().join('');
    expect(await verifyDelivery(rotated, headers, rawBody))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a captured request dies of old age', async () => {
    const stale = Date.now() - (MAX_SKEW_SECONDS + 5) * 1000;
    const headers = await composeDelivery(SECRET, rawBody, stale);
    expect(await verifyDelivery(SECRET, headers, rawBody))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('refuses a delivery with no signature at all', async () => {
    expect(await verifyDelivery(SECRET, new Headers(), rawBody))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('the secret is provisioned once, through the operator door only', () => {
  const admin = readCode('supabase/functions/builder-network-admin/index.ts');
  const connections = readCode('supabase/functions/builder-network-connections/index.ts');

  it('provision_transport is one-time: the conditional stamp is the gate', () => {
    expect(admin).toContain("'provision_transport'");
    expect(admin).toContain(".is('hmac_provisioned_at', null)");
    expect(admin).toContain('transport_already_provisioned');
  });

  it('rotation mints a NEW secret rather than re-reading the old one', () => {
    const rotateBlock = admin.slice(admin.indexOf('const rotated'));
    expect(rotateBlock.length).toBeGreaterThan(0);
    expect(rotateBlock).toContain('crypto.getRandomValues');
    expect(rotateBlock).toContain('outbound_hmac_secret: rotated');
  });

  it('the Builder Portal surface never returns the secret', () => {
    // The list projection omits the column, and no response body carries it.
    const selectConstant = connections.slice(
      connections.indexOf('const CONNECTION_SELECT'), connections.indexOf('Deno.serve'));
    expect(selectConstant).not.toContain('outbound_hmac_secret');
    expect(connections).not.toMatch(/json\(\{[^}]*hmac_secret/);
    expect(connections).not.toMatch(/json\(\{[^}]*outbound_hmac_secret/);
  });

  it('revocation clears the credential at rest, on both revoke doors', () => {
    for (const source of [admin, connections]) {
      const revokeBlock = source.slice(source.indexOf("state: 'revoked'"));
      expect(revokeBlock).toContain('outbound_hmac_secret: null');
      expect(revokeBlock).toContain('hmac_provisioned_at: null');
    }
  });

  it('both machine doors refuse a connection with no secret', () => {
    const inbound = readCode('supabase/functions/builder-network-inbound/index.ts');
    expect(inbound).toContain('!connection.outbound_hmac_secret');
    const worker = readCode('supabase/functions/builder-network-outbox-worker/index.ts');
    expect(worker).toContain('!connection.outbound_hmac_secret');
  });
});
