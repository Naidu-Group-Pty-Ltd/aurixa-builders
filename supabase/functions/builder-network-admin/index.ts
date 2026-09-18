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
 * minting), the MARKETPLACE RANKING's manual instruments (pin, suppress,
 * freeze, commercial placement — never the score itself), and read-only
 * visibility. What deliberately does NOT:
 *
 *  * Join requests are DECIDED BY ORGANISATION OWNERS — the operator sees
 *    the queue and cannot decide it. A platform that decides membership in
 *    somebody else's organisation has re-grown the agency-administers-
 *    builder shape the extraction exists to end.
 *  * `closed` is terminal for an organisation. Suspension is the
 *    reversible instrument; closing is an end-of-life act, and
 *    `close_organisation` is the ceremony it was promised: a reason it will
 *    not proceed without, and no route back. Nothing here DELETES an
 *    organisation — the network's record of who was on it is not an
 *    operator's to destroy.
 *  * `create_organisation` and `update_organisation` write DESCRIPTION only.
 *    The lifecycle columns move under their own verbs, which set the whole
 *    consistent group the table's CHECK constraints demand; an edit form
 *    that could also set `status` would be a second way to move a lifecycle.
 *  * `invite_organisation_owner` bootstraps a brand-new organisation's FIRST
 *    member and refuses once one exists — which is how the rule above it
 *    survives. An operator seeding an empty organisation is not deciding
 *    membership in somebody else's; once there is an owner, they invite.
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
import { mintBuilderInvite, INVITE_EXPIRY_HOURS } from '../_shared/builderInvite.ts';
import { readOrganisationInput } from '../_shared/builderOrganisationInput.pure.ts';

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

    // --------------------------------------------- organisation description
    if (operation === 'create_organisation' || operation === 'update_organisation') {
      const creating = operation === 'create_organisation';
      const input = readOrganisationInput(body, creating ? 'create' : 'update');
      if (!input.ok) return json({ error: input.error }, 400);

      if (creating) {
        // Born unapproved, exactly as a self-serve registration is: an
        // operator creating the row is not the same act as vetting it, and
        // `approve_organisation` remains the only way to `active`.
        const { data: created, error } = await supabase
          .from('builder_organisations')
          .insert({ ...input.patch, status: 'pending_activation', is_active: false })
          .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
          .single();
        if (error || !created) {
          console.error('[builder-network-admin] organisation create failed', error);
          return json({ error: 'create_failed' }, 500);
        }
        await logActivity('network_organisation_created', created.id, created.id, {
          legal_name: created.legal_name,
        });
        return json({ success: true, organisation: created });
      }

      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const { data: existing } = await supabase
        .from('builder_organisations')
        .select('id, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!existing) return json({ error: 'organisation_not_found' }, 404);
      if (existing.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      const { data: updated, error: updateError } = await supabase
        .from('builder_organisations')
        .update(input.patch)
        .eq('id', organisationId)
        .neq('status', 'closed')
        .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
        .maybeSingle();
      if (updateError || !updated) {
        console.error('[builder-network-admin] organisation update failed', updateError);
        return json({ error: 'update_failed' }, 500);
      }
      await logActivity('network_organisation_updated', updated.id, updated.id, {
        fields: Object.keys(input.patch),
      });
      return json({ success: true, organisation: updated });
    }

    // ------------------------------------------------ organisation end of life
    if (operation === 'close_organisation') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const reason = String(body.reason || '').trim();
      if (!reason) return json({ error: 'a_reason_is_required' }, 400);

      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') return json({ success: true, already_closed: true });

      // `is_active` false is not optional: `status_active_agree` refuses the
      // row otherwise. Members lose access on their next request because
      // `builder_accessible_organisations` requires an active organisation —
      // nothing has to hunt down their sessions.
      const { data: updated } = await supabase
        .from('builder_organisations')
        .update({ status: 'closed', is_active: false })
        .eq('id', organisation.id)
        .neq('status', 'closed')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'close_failed' }, 409);
      await logActivity('network_organisation_closed', organisation.id, organisation.id, { reason });
      return json({ success: true, status: 'closed' });
    }

    // ----------------------------------------------------- bootstrap an owner
    if (operation === 'invite_organisation_owner') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ error: 'a_valid_email_is_required' }, 400);
      }
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'a_name_is_required' }, 400);

      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      // THE BOUNDARY. Seeding an empty organisation is bootstrap; adding a
      // person to one that already has members is administering somebody
      // else's organisation, which this plane does not do (module header).
      //
      // Read-then-write, so two operators racing on the SAME new organisation
      // could both pass. Left as it is deliberately: the window is one
      // operator console against an organisation created seconds earlier, and
      // the worst outcome is two owners on a row that has never been used —
      // which an owner can fix. A lock here would be ceremony against a fault
      // nobody can produce.
      const { count: memberCount } = await supabase
        .from('builder_organisation_memberships')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', organisationId);
      if ((memberCount ?? 0) > 0) {
        return json({ error: 'organisation_already_has_members' }, 409);
      }

      // An account that already exists on the network is never re-minted
      // here: its owner has a password, and issuing an invite link for a live
      // account would be a credential reset dressed as an invitation.
      const { data: existingUser } = await supabase
        .from('builder_portal_users')
        .select('id, status, revoked_at, password_hash, invite_accepted_at')
        .eq('email', email)
        .maybeSingle();
      if (existingUser && (existingUser.password_hash || existingUser.invite_accepted_at)) {
        return json({ error: 'that_person_already_has_an_account' }, 409);
      }
      if (existingUser && (existingUser.revoked_at || existingUser.status === 'revoked')) {
        return json({ error: 'that_account_has_been_withdrawn' }, 409);
      }

      const minted = await mintBuilderInvite();
      if (!minted) {
        console.error('[builder-network-admin] hashing unavailable — refusing to store an unpeppered invite token');
        return json({ error: 'invite_service_unavailable' }, 503);
      }

      let ownerId = existingUser?.id ?? null;
      if (!ownerId) {
        const { data: created, error: createError } = await supabase
          .from('builder_portal_users')
          .insert({ email, name, status: 'invited', is_active: false })
          .select('id')
          .single();
        if (createError || !created) {
          console.error('[builder-network-admin] owner create failed', createError);
          return json({ error: 'invite_failed' }, 500);
        }
        ownerId = created.id;
      }

      const { error: inviteError } = await supabase
        .from('builder_portal_users')
        .update({
          name,
          invite_token_hash: minted.tokenHash,
          invite_token_expires_at: minted.expiresAt.toISOString(),
          invited_at: new Date().toISOString(),
          status: 'invited',
          is_active: false,
        })
        .eq('id', ownerId);
      if (inviteError) {
        console.error('[builder-network-admin] invite stamp failed', inviteError);
        return json({ error: 'invite_failed' }, 500);
      }

      const { error: membershipError } = await supabase
        .from('builder_organisation_memberships')
        .insert({
          builder_user_id: ownerId,
          organisation_id: organisationId,
          membership_role: 'owner',
          is_primary: true,
          status: 'active',
        });
      if (membershipError && String(membershipError.code) !== '23505') {
        console.error('[builder-network-admin] owner membership failed', membershipError);
        return json({ error: 'invite_failed' }, 500);
      }

      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: ownerId });
      await logActivity('network_organisation_owner_invited', ownerId, organisationId, {
        email, membership_role: 'owner',
      });

      // Returned ONCE, like the connection invite code above it. Only the
      // hash is stored, so a lost link is re-minted rather than re-read.
      return json({
        success: true,
        invite_url: minted.url,
        expires_at: minted.expiresAt.toISOString(),
        expires_in_hours: INVITE_EXPIRY_HOURS,
        organisation_legal_name: organisation.legal_name,
      });
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


    // ================================================================ ranking
    /*
     * MISSION CONTROL'S HAND ON THE MARKETPLACE.
     *
     * The ranking is computed from evidence and published to every clone, and
     * these four operations are the only way a person changes it. They are
     * deliberately NOT a way to edit a score: a pin, a suppression and a freeze
     * sit BESIDE the computed answer rather than overwriting it, so the score
     * stays a true statement about the builder and the intervention stays
     * legible as an intervention for as long as the row exists.
     *
     * There is no `set_merit_score`, and there must never be one. An operator
     * who could type a merit score could tell a builder a number that no
     * evidence produced, and every explanation this feature offers — the
     * signal breakdown, the confidence, the list of what could not be measured
     * — would become decoration over a hand-entered figure.
     */

    if (operation === 'ranking_overview') {
      const [{ data: state }, { data: snapshots }, { data: overrides }, { data: placements }] =
        await Promise.all([
          supabase.from('builder_ranking_state').select('*').eq('id', true).maybeSingle(),
          supabase.from('builder_ranking_snapshots')
            .select('organisation_id, merit_score, confidence, measured_score, band, computed_at, ranking_version')
            .order('merit_score', { ascending: false }),
          supabase.from('builder_ranking_overrides')
            .select('id, organisation_id, kind, position, reason, created_by, created_at, expires_at')
            .is('revoked_at', null),
          supabase.from('builder_commercial_placements')
            .select('id, organisation_id, tier, priority, starts_at, ends_at, note, created_by')
            .is('revoked_at', null),
        ]);

      // Names, so an operator is never asked to act on a uuid.
      const ids = [...new Set((snapshots ?? []).map((row) => row.organisation_id))];
      const { data: organisations } = ids.length
        ? await supabase.from('builder_organisations')
          .select('id, legal_name, trading_name, status').in('id', ids)
        : { data: [] as Record<string, unknown>[] };

      const liveStock = await supabase
        .from('builder_stock_items')
        .select('organisation_id')
        .eq('lifecycle_status', 'active');
      const stockCount = new Map<string, number>();
      for (const row of liveStock.data ?? []) {
        stockCount.set(row.organisation_id, (stockCount.get(row.organisation_id) ?? 0) + 1);
      }

      return json({
        state: state ?? null,
        builders: (snapshots ?? []).map((row) => {
          const org = (organisations ?? []).find((o) => o.id === row.organisation_id);
          return {
            ...row,
            legal_name: org?.legal_name ?? null,
            trading_name: org?.trading_name ?? null,
            status: org?.status ?? null,
            live_stock: stockCount.get(row.organisation_id) ?? 0,
            override: (overrides ?? []).find((o) => o.organisation_id === row.organisation_id) ?? null,
            placement: (placements ?? []).find((p) => p.organisation_id === row.organisation_id) ?? null,
          };
        }),
      });
    }

    if (operation === 'ranking_explain') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      const { data: snapshot } = await supabase
        .from('builder_ranking_snapshots')
        .select('*')
        .eq('organisation_id', organisationId)
        .maybeSingle();
      if (!snapshot) return json({ error: 'not_yet_ranked' }, 404);
      return json({ snapshot });
    }

    if (operation === 'ranking_set_override') {
      const organisationId = String(body.organisation_id || '');
      const kind = String(body.kind || '');
      const reason = String(body.reason || '').trim();
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (kind !== 'pin' && kind !== 'suppress') return json({ error: 'kind_must_be_pin_or_suppress' }, 400);
      // The same floor the column enforces, said here so the operator gets a
      // sentence rather than a constraint violation.
      if (reason.length < 10) return json({ error: 'reason_must_be_written' }, 400);

      const position = kind === 'pin' ? Number(body.position) : null;
      if (kind === 'pin' && (!Number.isInteger(position) || (position as number) < 1 || (position as number) > 500)) {
        return json({ error: 'position_must_be_between_1_and_500' }, 400);
      }

      /*
       * An expiry is the default and a standing override has to be ASKED for.
       * `expires_at: null` in the body is that ask, and it is distinguished
       * from the field being absent — omitting it takes the column's ninety-day
       * default, which is the behaviour that stops a forgotten pin shaping the
       * marketplace for a year.
       */
      const explicitExpiry = Object.prototype.hasOwnProperty.call(body, 'expires_at');
      const expiresAt = explicitExpiry ? body.expires_at : undefined;
      if (explicitExpiry && expiresAt !== null && Number.isNaN(Date.parse(String(expiresAt)))) {
        return json({ error: 'expires_at_must_be_a_timestamp_or_null' }, 400);
      }

      // One live override of each kind per builder: replace rather than stack,
      // and keep the one being replaced as history.
      await supabase.from('builder_ranking_overrides')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_by: operator,
          revoked_reason: 'replaced by a newer override',
        })
        .eq('organisation_id', organisationId)
        .eq('kind', kind)
        .is('revoked_at', null);

      const row: Record<string, unknown> = {
        organisation_id: organisationId,
        kind,
        position: kind === 'pin' ? position : null,
        reason,
        created_by: operator,
      };
      if (explicitExpiry) row.expires_at = expiresAt;

      const { data: created, error } = await supabase
        .from('builder_ranking_overrides')
        .insert(row)
        .select('id, organisation_id, kind, position, reason, created_at, expires_at')
        .maybeSingle();
      if (error) {
        console.error('[builder-network-admin] override insert failed', error.message);
        return json({ error: 'override_not_recorded' }, 400);
      }

      await logActivity('builder_ranking_override_set', created?.id ?? null, organisationId, {
        kind, position: created?.position ?? null, expires_at: created?.expires_at ?? null,
      });
      return json({ success: true, override: created });
    }

    if (operation === 'ranking_clear_override') {
      const organisationId = String(body.organisation_id || '');
      const kind = String(body.kind || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (kind !== 'pin' && kind !== 'suppress') return json({ error: 'kind_must_be_pin_or_suppress' }, 400);

      // Revoked, never deleted. A register of who moved the marketplace and
      // why is the whole reason the table exists.
      const { data: cleared } = await supabase
        .from('builder_ranking_overrides')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_by: operator,
          revoked_reason: typeof body.reason === 'string' ? body.reason : null,
        })
        .eq('organisation_id', organisationId)
        .eq('kind', kind)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
      if (!cleared) return json({ error: 'no_live_override_of_that_kind' }, 404);

      await logActivity('builder_ranking_override_cleared', cleared.id, organisationId, { kind });
      return json({ success: true });
    }

    if (operation === 'ranking_set_freeze') {
      const frozen = body.frozen === true;
      const reason = String(body.reason || '').trim();
      if (frozen && reason.length < 10) return json({ error: 'reason_must_be_written' }, 400);

      /*
       * FREEZING HOLDS THE PUBLISHED ORDER STILL. It does not fall back to a
       * default ordering and it does not clear anything: a marketplace that
       * reshuffles the moment something goes wrong is a second incident on top
       * of the first. Recompute reads this before it writes, so a freeze takes
       * effect at the next run rather than needing the scheduler stopped.
       */
      const { error } = await supabase.from('builder_ranking_state').update({
        frozen,
        frozen_reason: frozen ? reason : null,
        frozen_by: frozen ? operator : null,
        frozen_at: frozen ? new Date().toISOString() : null,
      }).eq('id', true);
      if (error) {
        console.error('[builder-network-admin] freeze failed', error.message);
        return json({ error: 'freeze_not_recorded' }, 400);
      }

      await logActivity(frozen ? 'builder_ranking_frozen' : 'builder_ranking_unfrozen', null, null, {});
      return json({ success: true, frozen });
    }

    if (operation === 'ranking_set_placement') {
      const organisationId = String(body.organisation_id || '');
      const tier = String(body.tier || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (!['partner', 'premium', 'featured'].includes(tier)) {
        return json({ error: 'tier_must_be_partner_premium_or_featured' }, 400);
      }
      const priority = Number.isInteger(Number(body.priority)) ? Number(body.priority) : 100;
      if (priority < 1 || priority > 1000) return json({ error: 'priority_must_be_between_1_and_1000' }, 400);

      await supabase.from('builder_commercial_placements')
        .update({ revoked_at: new Date().toISOString(), revoked_by: operator })
        .eq('organisation_id', organisationId)
        .is('revoked_at', null);

      const { data: created, error } = await supabase
        .from('builder_commercial_placements')
        .insert({
          organisation_id: organisationId,
          tier,
          priority,
          ends_at: body.ends_at ?? null,
          note: typeof body.note === 'string' ? body.note : null,
          created_by: operator,
        })
        .select('id, organisation_id, tier, priority, starts_at, ends_at')
        .maybeSingle();
      if (error) {
        console.error('[builder-network-admin] placement insert failed', error.message);
        return json({ error: 'placement_not_recorded' }, 400);
      }

      await logActivity('builder_commercial_placement_set', created?.id ?? null, organisationId, {
        tier, priority, ends_at: created?.ends_at ?? null,
      });
      return json({ success: true, placement: created });
    }

    if (operation === 'ranking_clear_placement') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      const { data: cleared } = await supabase
        .from('builder_commercial_placements')
        .update({ revoked_at: new Date().toISOString(), revoked_by: operator })
        .eq('organisation_id', organisationId)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
      if (!cleared) return json({ error: 'no_live_placement' }, 404);
      await logActivity('builder_commercial_placement_cleared', cleared.id, organisationId, {});
      return json({ success: true });
    }

    return json({ error: `unknown_operation:${operation}` }, 400);
  } catch (error) {
    console.error('[builder-network-admin] error', error);
    return json({ error: 'internal_error' }, 500);
  }
});
