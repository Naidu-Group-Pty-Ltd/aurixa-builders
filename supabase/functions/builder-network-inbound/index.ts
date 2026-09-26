/**
 * The clone → network delivery door (extraction plan §6).
 *
 * A machine endpoint: no session, no JWT — authorisation is the
 * per-connection symmetric HMAC over `${timestamp}.${rawBody}`, and the
 * connection must be ACTIVE. Three rules:
 *
 *  * **A webhook is not delivery; a sweep converges the mirror.** This door
 *    LANDS the envelope in `builder_network_inbound_events`, idempotent by
 *    dedupe_key, and updates the connection's inbound stamp. Applying the
 *    payload to domain tables is the consumers' sweep, which can re-run;
 *    an endpoint that applied on receipt would make redelivery a corruption.
 *
 *  * **The privacy contract holds INBOUND too, and throws rather than
 *    filters.** A clone that sends client PII has a composition bug; storing
 *    the payload "minus the bad fields" would hide it. The refusal is 422
 *    with a critical operational event, and nothing is stored.
 *
 *  * **The raw body is what is signed.** The bytes are read once, bounded,
 *    verified, and only then parsed — a re-serialisation is never signed or
 *    verified, because two ends that sign different byte sequences that
 *    print identically is the classic HMAC self-own.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import {
  HMAC_CONNECTION_HEADER,
  verifyDelivery,
} from '../_shared/builderNetworkHmac.ts';
import {
  BuilderNetworkPrivacyViolation,
  assertPayloadCrossesClean,
} from '../_shared/builderNetworkPrivacy.pure.ts';
import { buildStamp } from '../_shared/builderNetworkStamp.pure.ts';
import { agencyDedupeKeyFor, agencyPayloadContractViolation, sameAgencyEnvelope } from '../_shared/builderStock/agencyMessages.pure.ts';

const MAX_BODY_BYTES = 256 * 1024;

Deno.serve(async (req) => {
  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
    if (!bounded.ok) return bounded.error;

    // One generic refusal for the whole authentication ladder: which rung
    // failed is an oracle a probing caller does not get.
    const refuse = () => json({ error: 'delivery_refused' }, 401);

    const connectionId = req.headers.get(HMAC_CONNECTION_HEADER) || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) {
      return refuse();
    }

    const { data: connection } = await supabase
      .from('workspace_connections')
      .select('id, state, outbound_hmac_secret')
      .eq('id', connectionId)
      .maybeSingle();
    if (!connection || connection.state !== 'active' || !connection.outbound_hmac_secret) {
      return refuse();
    }

    const verdict = await verifyDelivery(connection.outbound_hmac_secret, req.headers, bounded.raw);
    if (!verdict.ok) return refuse();

    // Only now is the body data rather than bytes.
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(bounded.raw) as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_envelope' }, 400);
    }
    const eventType = String(envelope.event_type || '').trim();
    const dedupeKey = String(envelope.dedupe_key || '').trim();
    const sourceVersion = Number(envelope.source_version ?? 0);
    if (!eventType || !dedupeKey || !Number.isFinite(sourceVersion)) {
      return json({ error: 'invalid_envelope' }, 400);
    }

    try {
      assertPayloadCrossesClean(envelope.payload ?? {});
    } catch (violation) {
      if (violation instanceof BuilderNetworkPrivacyViolation) {
        await supabase.from('portal_operational_events').insert({
          event_name: 'builder_network_inbound_privacy_violation',
          severity: 'critical',
          request_id: dedupeKey,
          actor_type: 'system',
          portal: 'builder',
          success: false,
          metadata: {
            connection_id: connection.id,
            event_type: eventType,
            forbidden_path_count: violation.paths.length,
            // The PATHS travel; the values never do.
            forbidden_paths: violation.paths.slice(0, 20),
          },
        });
        return json({ error: 'privacy_contract_failed' }, 422);
      }
      throw violation;
    }

    // A message event carries exactly its contract's keys and nothing else:
    // refused here, before anything is stored, naming the keys and never a value.
    const contract = agencyPayloadContractViolation(eventType, envelope.payload ?? {});
    if (contract) {
      await supabase.from('portal_operational_events').insert({
        event_name: 'builder_network_inbound_message_contract_violation',
        severity: 'warning',
        request_id: dedupeKey,
        actor_type: 'system',
        portal: 'builder',
        success: false,
        metadata: {
          connection_id: connection.id,
          event_type: eventType,
          unexpected_keys: contract.unexpected.slice(0, 20),
          missing_keys: contract.missing.slice(0, 20),
          // A key present with the wrong type or value, e.g. a schema_version
          // this side cannot apply: the only trace of a skewed peer.
          mistyped_keys: contract.mistyped.slice(0, 20),
        },
      });
      return json({ error: 'message_contract_failed' }, 422);
    }
    // And its dedupe key is the one its payload implies: a reused key would
    // otherwise answer a NEW message as a duplicate and store nothing.
    const expectedKey = agencyDedupeKeyFor(eventType, envelope.payload ?? {});
    if (expectedKey !== null && dedupeKey !== expectedKey) {
      return json({ error: 'message_dedupe_key_mismatch' }, 422);
    }

    const { error: insertError } = await supabase
      .from('builder_network_inbound_events')
      .insert({
        connection_id: connection.id,
        event_type: eventType,
        dedupe_key: dedupeKey,
        payload: envelope.payload ?? {},
        source_version: sourceVersion,
      });
    if (insertError) {
      if (String(insertError.code) === '23505') {
        // A message key is a duplicate only if it is the SAME envelope: the
        // same key carrying other content is a conflict, never acknowledged.
        if (expectedKey !== null) {
          const { data: stored } = await supabase.from('builder_network_inbound_events')
            .select('connection_id, event_type, payload').eq('dedupe_key', dedupeKey).maybeSingle();
          if (!stored || !sameAgencyEnvelope(stored, { connection_id: connection.id, event_type: eventType, payload: envelope.payload ?? {} })) {
            return json({ error: 'message_conflict' }, 409);
          }
        }
        // Redelivery of something already landed: the 200 the sender lost.
        return json({ accepted: true, duplicate: true });
      }
      console.error('[builder-network-inbound] insert failed', insertError);
      return json({ error: 'delivery_not_recorded' }, 500);
    }

    // The sweep converges the mirror; this door only LANDS. Running one pass
    // here is opportunism, not application-on-receipt: the same idempotent
    // consumer pg_cron drives every minute, so a failure here changes nothing
    // but latency — which is why its error is logged and the delivery still
    // answers accepted.
    const { error: applyError } = await supabase
      .rpc('builder_network_apply_inbound_events', { _limit: 25 });
    if (applyError) {
      console.error('[builder-network-inbound] opportunistic apply failed', applyError.message);
    }
    // Messages have their own lane and sweep; the same opportunism, the same
    // rule: a failure here costs latency, never the delivery.
    if (eventType === 'agency.message.posted' || eventType === 'agency.message.receipt'
      || eventType === 'agency.message.participant') {
      const { error: messageError } = await supabase
        .rpc('builder_agency_apply_message_events', { _limit: 25 });
      if (messageError) {
        console.error('[builder-network-inbound] opportunistic message apply failed', messageError.message);
      }
    }

    // The stamp says WHETHER; source_version says WHAT. Monotonic: an
    // out-of-order redelivery may not wind the version back.
    const { data: pending } = await supabase
      .from('builder_network_inbound_events')
      .select('id, received_at', { count: 'exact', head: false })
      .eq('connection_id', connection.id)
      .is('processed_at', null)
      .order('received_at', { ascending: false })
      .limit(1);
    const { count } = await supabase
      .from('builder_network_inbound_events')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', connection.id)
      .is('processed_at', null);
    const stamp = buildStamp({
      count: count ?? 0,
      latest: pending?.[0]?.received_at ?? null,
      pendingRequests: count ?? 0,
      attention: 0,
    });
    const { data: existingStamp } = await supabase
      .from('builder_network_stamps')
      .select('source_version')
      .eq('connection_id', connection.id)
      .eq('side', 'inbound')
      .maybeSingle();
    await supabase.from('builder_network_stamps').upsert({
      connection_id: connection.id,
      side: 'inbound',
      stamp,
      source_version: Math.max(Number(existingStamp?.source_version ?? 0), sourceVersion),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'connection_id,side' });

    return json({ accepted: true });
  } catch (error) {
    console.error('[builder-network-inbound] error', error);
    return json({ error: 'delivery_failed' }, 500);
  }
});
