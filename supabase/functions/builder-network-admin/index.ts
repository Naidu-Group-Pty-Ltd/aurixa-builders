/**
 * The network's operator API — called by Mission Control's
 * `/builders-network/*` console and nothing else (extraction plan §5).
 *
 * MC must not hold the network's service-role key, so the door is the
 * federation assertion: an RS256 JWT MC signs with the platform key, aud
 * bound to this origin, carrying `builders:operate`. Revoking that scope on
 * MC's side is a complete rollback of this entire surface.
 *
 * What lives here is the plan's operator plane and no more: organisation
 * vetting (approve / suspend / reinstate — the lifecycle of the
 * `pending_verification` state registration mints), the workspace
 * DIRECTORY (MC → network per §6: registry upserts and connection
 * minting), and read-only visibility. What deliberately does NOT:
 *
 *  * Join requests are DECIDED BY ORGANISATION OWNERS — the operator sees
 *    the queue and cannot decide it. A platform that decides membership in
 *    somebody else's organisation has re-grown the agency-administers-
 *    builder shape the extraction exists to end.
 *  * `closed` is terminal for an organisation. Suspension is the
 *    reversible instrument; closing is an end-of-life act that gets its
 *    own ceremony when it exists at all.
 *  * A REVOKED connection is never revived — reconnection is a NEW row
 *    with a NEW invite code, so the audit history stays whole.
 *
 * The invite code minted by `create_connection` is returned ONCE, hashed
 * at rest, and travels operator → builder out of band; the builder-side
 * acceptance is `builder-network-connections`.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { verifyMcAssertion } from '../_shared/mcFederation.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';

const MAX_BODY_BYTES = 32 * 1024;
const INVITE_CODE_EXPIRY_DAYS = 14;

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

    const authorization = req.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const verdict = await verifyMcAssertion(token, 'builders:operate');
    if (!verdict.ok) {
      // `unconfigured` is the operator's fault to fix, not the caller's to
      // probe — it is the one reason named, because the remedy is an env var.
      const status = verdict.reason === 'unconfigured' ? 503 : 401;
      return json({ error: verdict.reason === 'unconfigured' ? 'federation_unconfigured' : 'unauthorised' }, status);
    }
    const operator = verdict.claims.sub;

    let body: Record<string, any>;
    try {
      body = bounded.raw ? JSON.parse(bounded.raw) : {};
    } catch {
      return json({ error: 'invalid_body' }, 400);
    }
    const operation = String(body.operation || 'overview');

    const logActivity = async (action: string, entityId: string | null, organisationId: string | null, metadata: Record<string, unknown> = {}) => {
      const { error } = await supabase.rpc('builder_log_activity', {
        _actor_user_id: null,
        _actor_type: 'system',
        _action: action,
        _entity_type: 'network_admin',
        _entity_id: entityId,
        _organisation_id: organisationId,
        _builder_user_id: null,
        _previous_state: null,
        _new_state: null,
        _reason: typeof body.reason === 'string' ? body.reason : null,
        _metadata: { mc_operator: operator, ...metadata },
        _ip_address: null,
        _user_agent: 'mission-control',
      });
      if (error) console.error('[builder-network-admin] activity log failed', error.message);
    };

    // -------------------------------------------------------------- overview
    if (operation === 'overview') {
      const countBy = async (table: string, column: string) => {
        const { data } = await supabase.from(table).select(column);
        const counts: Record<string, number> = {};
        for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
          const key = String(row[column] ?? 'unknown');
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
      };
      const [organisations, connections, { count: pendingJoinRequests }, { count: deadLetters }] = await Promise.all([
        countBy('builder_organisations', 'status'),
        countBy('workspace_connections', 'state'),
        supabase.from('builder_org_join_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('builder_network_outbox').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
      ]);
      return json({
        organisations,
        connections,
        pending_join_requests: pendingJoinRequests ?? 0,
        dead_letters: deadLetters ?? 0,
      });
    }

    // -------------------------------------------------- organisation reading
    if (operation === 'list_organisations') {
      let query = supabase
        .from('builder_organisations')
        .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (typeof body.status === 'string' && body.status) query = query.eq('status', body.status);
      const { data, error } = await query;
      if (error) return json({ error: 'read_failed' }, 500);
      return json({ organisations: data ?? [] });
    }

    if (operation === 'list_join_requests') {
      const { data, error } = await supabase
        .from('builder_org_join_requests')
        .select('id, organisation_id, builder_user_id, status, message, created_at, decided_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return json({ error: 'read_failed' }, 500);
      // Visibility only: owners decide (see module header). Labels are
      // resolved so the operator sees names, not uuids.
      const orgIds = [...new Set((data ?? []).map((r: any) => r.organisation_id))];
      const userIds = [...new Set((data ?? []).map((r: any) => r.builder_user_id))];
      const [{ data: orgs }, { data: users }] = await Promise.all([
        orgIds.length ? supabase.from('builder_organisations').select('id, legal_name').in('id', orgIds) : Promise.resolve({ data: [] } as any),
        userIds.length ? supabase.from('builder_portal_users').select('id, name, email').in('id', userIds) : Promise.resolve({ data: [] } as any),
      ]);
      const orgById = new Map((orgs ?? []).map((o: any) => [o.id, o.legal_name]));
      const userById = new Map((users ?? []).map((u: any) => [u.id, { name: u.name, email: u.email }]));
      return json({
        join_requests: (data ?? []).map((r: any) => ({
          ...r,
          organisation_legal_name: orgById.get(r.organisation_id) ?? null,
          requester: userById.get(r.builder_user_id) ?? null,
        })),
      });
    }

    // ----------------------------------------------- organisation lifecycle
    if (operation === 'approve_organisation' || operation === 'suspend_organisation' || operation === 'reinstate_organisation') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status, activated_at')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      if (operation === 'approve_organisation') {
        if (organisation.status === 'active') return json({ success: true, already_active: true });
        const { data: updated } = await supabase
          .from('builder_organisations')
          .update({
            status: 'active',
            is_active: true,
            activated_at: organisation.activated_at ?? new Date().toISOString(),
            suspended_at: null,
            suspension_reason: null,
          })
          .in('status', ['pending_verification', 'pending_activation'])
          .eq('id', organisation.id)
          .select('id')
          .maybeSingle();
        if (!updated) return json({ error: 'not_approvable_from_current_status' }, 409);
        await logActivity('network_organisation_approved', organisation.id, organisation.id);
        return json({ success: true, status: 'active' });
      }

      if (operation === 'suspend_organisation') {
        const reason = String(body.reason || '').trim();
        if (!reason) return json({ error: 'a_reason_is_required' }, 400);
        if (organisation.status === 'suspended') return json({ success: true, already_suspended: true });
        const { data: updated } = await supabase
          .from('builder_organisations')
          .update({
            status: 'suspended',
            is_active: false,
            suspended_at: new Date().toISOString(),
            suspension_reason: reason,
          })
          .eq('id', organisation.id)
          .neq('status', 'closed')
          .select('id')
          .maybeSingle();
        if (!updated) return json({ error: 'suspend_failed' }, 409);
        await logActivity('network_organisation_suspended', organisation.id, organisation.id, { reason });
        return json({ success: true, status: 'suspended' });
      }

      // reinstate: suspension is the reversible instrument.
      if (organisation.status !== 'suspended') {
        return json({ error: 'only_a_suspended_organisation_reinstates' }, 409);
      }
      const { data: updated } = await supabase
        .from('builder_organisations')
        .update({
          status: 'active',
          is_active: true,
          activated_at: organisation.activated_at ?? new Date().toISOString(),
          suspended_at: null,
          suspension_reason: null,
        })
        .eq('id', organisation.id)
        .eq('status', 'suspended')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'reinstate_failed' }, 409);
      await logActivity('network_organisation_reinstated', organisation.id, organisation.id);
      return json({ success: true, status: 'active' });
    }

    // ------------------------------------------------------------- directory
    if (operation === 'upsert_workspace') {
      const mcCloneId = String(body.mc_clone_id || '');
      const slug = String(body.slug || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mcCloneId)) {
        return json({ error: 'mc_clone_id_must_be_a_uuid' }, 400);
      }
      if (!slug) return json({ error: 'slug_is_required' }, 400);
      const { data, error } = await supabase
        .from('workspace_registry')
        .upsert({
          mc_clone_id: mcCloneId,
          slug,
          display_name: String(body.display_name || '').trim() || null,
          last_asserted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'mc_clone_id' })
        .select('id, mc_clone_id, slug, display_name')
        .single();
      if (error || !data) {
        console.error('[builder-network-admin] workspace upsert failed', error);
        return json({ error: 'upsert_failed' }, 500);
      }
      return json({ success: true, workspace: data });
    }

    if (operation === 'create_connection') {
      const mcCloneId = String(body.mc_clone_id || '');
      const organisationId = String(body.builder_organisation_id || '');
      if (!mcCloneId || !organisationId) {
        return json({ error: 'mc_clone_id_and_builder_organisation_id_are_required' }, 400);
      }
      const [{ data: workspace }, { data: organisation }] = await Promise.all([
        supabase.from('workspace_registry').select('id, slug').eq('mc_clone_id', mcCloneId).maybeSingle(),
        supabase.from('builder_organisations').select('id, status').eq('id', organisationId).maybeSingle(),
      ]);
      if (!workspace) return json({ error: 'workspace_not_registered' }, 404);
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status !== 'active') {
        return json({ error: 'organisation_not_active' }, 409);
      }

      // One LIVE connection per pair. Revoked rows do not count — that is
      // exactly what "reconnection is a new row" means.
      const { data: existing } = await supabase
        .from('workspace_connections')
        .select('id, state')
        .eq('workspace_id', workspace.id)
        .eq('builder_organisation_id', organisation.id)
        .in('state', ['invited', 'active'])
        .maybeSingle();
      if (existing) {
        return json({ error: 'a_live_connection_already_exists', state: existing.state }, 409);
      }

      const inviteCode = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const inviteCodeHash = await hashSessionToken(inviteCode);
      if (!inviteCodeHash) return json({ error: 'hashing_unavailable' }, 503);

      const { data: created, error } = await supabase
        .from('workspace_connections')
        .insert({
          workspace_id: workspace.id,
          builder_organisation_id: organisation.id,
          state: 'invited',
          initiated_by: 'workspace',
          invite_code_hash: inviteCodeHash,
          invite_expires_at: new Date(Date.now() + INVITE_CODE_EXPIRY_DAYS * 86_400_000).toISOString(),
        })
        .select('id')
        .single();
      if (error || !created) {
        console.error('[builder-network-admin] connection insert failed', error);
        return json({ error: 'create_failed' }, 500);
      }
      await supabase.from('workspace_connection_events').insert({
        connection_id: created.id,
        event_type: 'connection_invited',
        actor_side: 'platform',
        detail: { mc_operator: operator, workspace_slug: workspace.slug },
      });
      await logActivity('network_connection_invited', created.id, organisation.id, { workspace_slug: workspace.slug });
      return json({
        success: true,
        connection_id: created.id,
        // Returned ONCE; only the hash is stored. It travels to the builder
        // out of band and is consumed by builder-network-connections.
        invite_code: inviteCode,
        expires_at: new Date(Date.now() + INVITE_CODE_EXPIRY_DAYS * 86_400_000).toISOString(),
      });
    }

    if (operation === 'revoke_connection') {
      const connectionId = String(body.connection_id || '');
      const reason = String(body.reason || '').trim();
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      if (!reason) return json({ error: 'a_reason_is_required' }, 400);
      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({
          state: 'revoked',
          revoked_at: new Date().toISOString(),
          revoke_reason: reason,
          // Revocation retires the transport credential WITH the connection:
          // the secret is gone at rest, not merely unreachable, and a future
          // reconnection is a new row with a new secret.
          outbound_hmac_secret: null,
          hmac_provisioned_at: null,
        })
        .eq('id', connectionId)
        .neq('state', 'revoked')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'not_revocable' }, 409);
      await supabase.from('workspace_connection_events').insert({
        connection_id: connectionId,
        event_type: 'connection_revoked',
        actor_side: 'platform',
        detail: { mc_operator: operator, reason },
      });
      return json({ success: true, state: 'revoked' });
    }

    // ------------------------------------------------------------- transport
    // The courier half of the handshake. Acceptance (builder-network-
    // connections) MINTS the per-connection symmetric secret and stores it
    // RLS-closed; the clone's builder-network-inbound and this network's
    // outbox worker both need it, and Mission Control — which provisions the
    // clone and holds ITS service credentials, never this project's — is the
    // machinery that installs it clone-side (the prime's mirror migration
    // says exactly this). So the secret leaves this project EXACTLY ONCE,
    // through this federation-asserted door, and never through any Builder
    // Portal read: `provision_transport` returns it once and stamps
    // `hmac_provisioned_at`; afterwards only `rotate_transport` — which
    // mints a NEW secret — returns anything, so a compromised operator
    // token cannot quietly re-read a live credential. Neither event row
    // carries the secret.
    if (operation === 'provision_transport' || operation === 'rotate_transport') {
      const connectionId = String(body.connection_id || '');
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      const { data: connection } = await supabase
        .from('workspace_connections')
        .select('id, state, outbound_hmac_secret, hmac_provisioned_at')
        .eq('id', connectionId)
        .maybeSingle();
      if (!connection) return json({ error: 'connection_not_found' }, 404);
      if (connection.state !== 'active') {
        // Not yet accepted → no secret exists; revoked → none may exist.
        return json({ error: 'transport_provisions_only_on_an_active_connection', state: connection.state }, 409);
      }

      const networkInboundUrl =
        `${String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')}/functions/v1/builder-network-inbound`;

      if (operation === 'provision_transport') {
        if (connection.hmac_provisioned_at) {
          return json({
            error: 'transport_already_provisioned',
            provisioned_at: connection.hmac_provisioned_at,
            remedy: 'rotate_transport issues a new secret and invalidates the old one',
          }, 409);
        }
        if (!connection.outbound_hmac_secret) {
          // Active but secretless should be impossible (acceptance mints);
          // refuse rather than mint here so the mint stays in one place.
          return json({ error: 'connection_has_no_transport_secret' }, 409);
        }
        const { data: stamped } = await supabase
          .from('workspace_connections')
          .update({ hmac_provisioned_at: new Date().toISOString() })
          .eq('id', connection.id)
          .is('hmac_provisioned_at', null)
          .select('id')
          .maybeSingle();
        // A concurrent provision lost the conditional update: the secret was
        // already handed out once, and once is the contract.
        if (!stamped) return json({ error: 'transport_already_provisioned' }, 409);

        await supabase.from('workspace_connection_events').insert({
          connection_id: connection.id,
          event_type: 'transport_provisioned',
          actor_side: 'platform',
          detail: { mc_operator: operator },
        });
        return json({
          success: true,
          connection_id: connection.id,
          // Returned ONCE, for MC to install in the clone's
          // builder_network_connections row alongside this URL.
          hmac_secret: connection.outbound_hmac_secret,
          network_inbound_url: networkInboundUrl,
        });
      }

      // rotate_transport: a NEW secret, returned once. The old one stops
      // verifying the moment this commits — deliveries in flight retry with
      // the new signature on the worker's next pass.
      const rotated = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const { data: stamped } = await supabase
        .from('workspace_connections')
        .update({
          outbound_hmac_secret: rotated,
          hmac_provisioned_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('state', 'active')
        .select('id')
        .maybeSingle();
      if (!stamped) return json({ error: 'transport_rotation_failed' }, 409);

      await supabase.from('workspace_connection_events').insert({
        connection_id: connection.id,
        event_type: 'transport_rotated',
        actor_side: 'platform',
        detail: { mc_operator: operator },
      });
      return json({
        success: true,
        connection_id: connection.id,
        hmac_secret: rotated,
        network_inbound_url: networkInboundUrl,
      });
    }

    if (operation === 'set_inbound_url') {
      const connectionId = String(body.connection_id || '');
      const inboundUrl = String(body.inbound_url || '').trim();
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      if (!/^https:\/\//.test(inboundUrl)) return json({ error: 'inbound_url_must_be_https' }, 400);
      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({ inbound_url: inboundUrl })
        .eq('id', connectionId)
        .neq('state', 'revoked')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'connection_not_found_or_revoked' }, 404);
      await supabase.from('workspace_connection_events').insert({
        connection_id: connectionId,
        event_type: 'transport_configured',
        actor_side: 'platform',
        detail: { mc_operator: operator },
      });
      return json({ success: true });
    }

    return json({ error: `unknown_operation:${operation}` }, 400);
  } catch (error) {
    console.error('[builder-network-admin] error', error);
    return json({ error: 'internal_error' }, 500);
  }
});
