/**
 * The network → clone delivery worker (extraction plan §6).
 *
 * The clone's cross-portal outbox idiom, mirrored onto the
 * `builder_network` aggregate: an internal-signature gate in front, an
 * atomic SKIP LOCKED claim by rpc, exponential retry with a terminal
 * dead-letter, and the privacy contract that THROWS rather than filters —
 * a payload composed wrong dead-letters loudly instead of shipping its
 * survivable subset.
 *
 * Delivery is an HMAC-signed POST to the connection's `inbound_url` (the
 * clone's own builder-network-inbound door). Three states short of
 * delivered, deliberately distinct:
 *
 *  * no `inbound_url` yet → RELEASED with backoff, never dead: the
 *    connection exists before its transport is configured, and killing the
 *    queue for configuration lag would drop real events;
 *  * connection revoked → DEAD immediately: a terminal connection has
 *    nowhere lawful to deliver to, and holding the event alive implies it
 *    might;
 *  * privacy violation → DEAD immediately with a CRITICAL operational
 *    event, whatever the attempt count.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { signDelivery, HMAC_CONNECTION_HEADER, HMAC_SIGNATURE_HEADER, HMAC_TIMESTAMP_HEADER } from '../_shared/builderNetworkHmac.ts';
import {
  BuilderNetworkPrivacyViolation,
  assertPayloadCrossesClean,
} from '../_shared/builderNetworkPrivacy.pure.ts';

const MAX_BODY_BYTES = 8 * 1024;
const TERMINAL_ATTEMPTS = 10;
const DELIVERY_TIMEOUT_MS = 15_000;

Deno.serve(async (req) => {
  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
    if (!bounded.ok) return bounded.error;
    const gate = await verifyInternal(supabase, req, bounded.raw);
    if (!gate.ok) {
      console.warn('[builder-network-outbox-worker] verifyInternal denied', {
        errorCode: (gate as { errorCode?: string }).errorCode,
      });
      return json({ error: 'Forbidden' }, 403);
    }

    const workerId = `outbox-${crypto.randomUUID().slice(0, 8)}`;
    const { data: events, error: claimError } = await supabase
      .rpc('builder_network_claim_outbox', { _worker_id: workerId, _limit: 25 });
    if (claimError) {
      console.error('[builder-network-outbox-worker] claim failed', claimError);
      return json({ error: 'claim_failed' }, 500);
    }

    const operationalEvent = async (
      name: string,
      severity: 'info' | 'warning' | 'critical',
      event: any,
      metadata: Record<string, unknown>,
    ) => {
      await supabase.from('portal_operational_events').insert({
        event_name: name,
        severity,
        request_id: event.id,
        actor_type: 'system',
        portal: 'builder',
        success: severity === 'info',
        metadata: { connection_id: event.connection_id, event_type: event.event_type, attempt: event.attempts, ...metadata },
      });
    };

    /** Release for retry — exponential, capped at an hour; terminal → dead. */
    const release = async (event: any, message: string, opts: { dead?: boolean } = {}) => {
      const terminal = opts.dead || event.attempts >= TERMINAL_ATTEMPTS;
      await supabase.from('builder_network_outbox').update({
        status: terminal ? 'dead' : 'pending',
        available_at: new Date(Date.now() + Math.min(3600, 2 ** event.attempts) * 1000).toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: message.slice(0, 2000),
      }).eq('id', event.id).eq('locked_by', workerId);
      if (terminal) {
        await operationalEvent('builder_network_delivery_dead', 'critical', event, { error_code: message.slice(0, 120) });
      }
    };

    let delivered = 0, retried = 0, dead = 0;
    for (const event of events ?? []) {
      try {
        const { data: connection } = await supabase
          .from('workspace_connections')
          .select('id, state, outbound_hmac_secret, inbound_url')
          .eq('id', event.connection_id)
          .maybeSingle();

        if (!connection || connection.state === 'revoked') {
          await release(event, 'connection_revoked', { dead: true });
          dead++;
          continue;
        }
        if (!connection.inbound_url || !connection.outbound_hmac_secret) {
          // Not yet deliverable is not failure: the transport arrives with
          // configuration, and the queue simply waits.
          await release(event, connection.inbound_url ? 'no_hmac_secret' : 'no_inbound_url');
          retried++;
          continue;
        }

        // The contract, at the last gate before the wire.
        assertPayloadCrossesClean(event.payload ?? {});

        const rawBody = JSON.stringify({
          event_type: event.event_type,
          dedupe_key: event.dedupe_key,
          payload: event.payload ?? {},
          source_version: Number(event.source_version ?? 0),
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signDelivery(connection.outbound_hmac_secret, timestamp, rawBody);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(connection.inbound_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [HMAC_CONNECTION_HEADER]: connection.id,
              [HMAC_TIMESTAMP_HEADER]: timestamp,
              [HMAC_SIGNATURE_HEADER]: signature,
            },
            body: rawBody,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          await supabase.from('builder_network_outbox').update({
            status: 'delivered',
            delivered_at: new Date().toISOString(),
            locked_at: null,
            locked_by: null,
            last_error: null,
          }).eq('id', event.id).eq('locked_by', workerId);
          delivered++;
        } else {
          await release(event, `http_${response.status}`);
          retried++;
        }
      } catch (error) {
        if (error instanceof BuilderNetworkPrivacyViolation) {
          await supabase.from('builder_network_outbox').update({
            status: 'dead',
            locked_at: null,
            locked_by: null,
            last_error: error.message.slice(0, 2000),
          }).eq('id', event.id).eq('locked_by', workerId);
          await operationalEvent('builder_network_outbound_privacy_violation', 'critical', event, {
            forbidden_path_count: error.paths.length,
            forbidden_paths: error.paths.slice(0, 20),
          });
          dead++;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        await release(event, message);
        retried++;
      }
    }

    return json({ claimed: events?.length ?? 0, delivered, retried, dead });
  } catch (error) {
    console.error('[builder-network-outbox-worker] error', error);
    return json({ error: 'worker_failed' }, 500);
  }
});
