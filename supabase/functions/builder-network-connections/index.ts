/**
 * Workspace connections — the builder-side surface over the connection
 * graph (extraction plan §2).
 *
 * A connection is ACCESS CONTROL, never agreement formation: it records that
 * a workspace (a clone) and a builder organisation may exchange the scoped
 * flows, and nothing about commercial terms. The graph's rules are enforced
 * by the schema and re-stated here where the schema cannot see them:
 *
 *  * `none` is not a row; `revoked` is TERMINAL. There is no un-revoke —
 *    reconnection is a NEW row, so the history of who could see what stays
 *    whole. This function refuses any transition off `revoked`.
 *  * Scopes are GRANT ROWS, FK-checked against `connection_scope_keys` — a
 *    misspelled scope is a write error, never an access decision that
 *    silently never applies. This surface writes `granted_by_side =
 *    'builder'` only; the workspace's own grants arrive on its side.
 *  * Every act appends a `workspace_connection_events` row. The ledger is
 *    append-only; nothing here updates or deletes one.
 *
 * Acceptance mints the connection's symmetric `outbound_hmac_secret` when
 * none exists — the transport credential both directions sign with. It is
 * RLS-closed and never returned by any read this function serves.
 *
 * Authorisation: any active member may LIST; only an owner or administrator
 * of the ACTIVE organisation may accept, revoke, or move scopes — the same
 * org-owner re-gate the admin-plane lift uses (plan §5).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';

const CONNECTION_SELECT = `id, workspace_id, builder_organisation_id, state,
  initiated_by, invite_expires_at, accepted_at, revoked_at, revoke_reason,
  created_at, updated_at`;

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, any>));
    const operation = String(body.operation || 'list');

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error || 'Unauthorised', code: session.code }, session.status || 401);
    }
    const governanceError = builderGovernanceError(session);
    if (governanceError) return json({ error: 'Portal setup required', code: governanceError }, 403);

    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }

    const membershipRole = session.organisations
      ?.find((o) => o.organisation_id === activeOrganisationId)?.membership_role ?? null;
    const canAdminister = membershipRole === 'owner' || membershipRole === 'administrator';

    /** Load one connection, scoped to the active organisation before anything else. */
    const loadConnection = async (connectionId: string) => {
      if (!connectionId || typeof connectionId !== 'string') return null;
      const { data } = await supabase
        .from('workspace_connections')
        .select(`${CONNECTION_SELECT}, invite_code_hash, outbound_hmac_secret`)
        .eq('id', connectionId)
        .eq('builder_organisation_id', activeOrganisationId)
        .maybeSingle();
      return data ?? null;
    };

    const appendEvent = async (
      connectionId: string,
      eventType: string,
      detail: Record<string, unknown> = {},
    ) => {
      const { error } = await supabase.from('workspace_connection_events').insert({
        connection_id: connectionId,
        event_type: eventType,
        actor_side: 'builder',
        detail: { ...detail, actor_builder_user_id: session.user!.id },
      });
      if (error) console.error('[builder-network-connections] event append failed', error);
    };

    // ------------------------------------------------------------------ list
    if (operation === 'list') {
      const [{ data: connections }, { data: scopeKeys }] = await Promise.all([
        supabase
          .from('workspace_connections')
          .select(CONNECTION_SELECT)
          .eq('builder_organisation_id', activeOrganisationId)
          .order('created_at', { ascending: false }),
        supabase.from('connection_scope_keys').select('key, direction, description'),
      ]);
      const rows = connections ?? [];

      const ids = rows.map((row: any) => row.id);
      const [{ data: registry }, { data: grants }] = await Promise.all([
        rows.length
          ? supabase
              .from('workspace_registry')
              .select('id, slug, display_name')
              .in('id', rows.map((row: any) => row.workspace_id))
          : Promise.resolve({ data: [] } as any),
        ids.length
          ? supabase
              .from('connection_scope_grants')
              .select('connection_id, scope_key, granted_at, granted_by_side')
              .in('connection_id', ids)
          : Promise.resolve({ data: [] } as any),
      ]);

      const workspaceById = new Map((registry ?? []).map((w: any) => [w.id, w]));
      const grantsByConnection = new Map<string, any[]>();
      for (const grant of grants ?? []) {
        const list = grantsByConnection.get(grant.connection_id) ?? [];
        list.push({ scope_key: grant.scope_key, granted_at: grant.granted_at, granted_by_side: grant.granted_by_side });
        grantsByConnection.set(grant.connection_id, list);
      }

      return json({
        connections: rows.map((row: any) => {
          const workspace = workspaceById.get(row.workspace_id) as
            | { slug: string; display_name: string | null }
            | undefined;
          return {
            ...row,
            workspace: workspace
              ? { slug: workspace.slug, display_name: workspace.display_name }
              : null,
            scopes: grantsByConnection.get(row.id) ?? [],
          };
        }),
        scope_catalogue: scopeKeys ?? [],
        can_administer: canAdminister,
      });
    }

    if (!canAdminister) {
      return json({ error: 'Only an organisation owner or administrator may change connections' }, 403);
    }

    // ---------------------------------------------------------------- accept
    if (operation === 'accept') {
      const connection = await loadConnection(String(body.connection_id || ''));
      if (!connection) return json({ error: 'Connection not found' }, 404);
      if (connection.state === 'revoked') {
        // Terminal means terminal: the remedy is a new invitation, never a
        // resurrection of the audit trail's dead row.
        return json({ error: 'This connection was revoked. Ask the workspace to issue a new invitation.' }, 409);
      }
      if (connection.state === 'active') return json({ success: true, already_active: true });

      const inviteCode = String(body.invite_code || '');
      if (!inviteCode) return json({ error: 'The invitation code is required' }, 400);
      if (!connection.invite_code_hash) {
        return json({ error: 'This connection has no open invitation' }, 409);
      }
      if (connection.invite_expires_at && new Date(connection.invite_expires_at) < new Date()) {
        return json({ error: 'The invitation has expired. Ask the workspace to issue a new one.' }, 409);
      }
      const codeHash = await hashSessionToken(inviteCode);
      if (!codeHash || codeHash !== connection.invite_code_hash) {
        return json({ error: 'The invitation code is not valid' }, 400);
      }

      // The symmetric transport secret is minted at acceptance if absent —
      // never rotated here, and never returned to any caller.
      const secret = connection.outbound_hmac_secret
        ?? Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, '0')).join('');

      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({
          state: 'active',
          accepted_at: new Date().toISOString(),
          invite_code_hash: null,
          outbound_hmac_secret: secret,
        })
        .eq('id', connection.id)
        .eq('state', 'invited')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'The connection could not be accepted' }, 409);

      await appendEvent(connection.id, 'connection_accepted', {});
      return json({ success: true, state: 'active' });
    }

    // ---------------------------------------------------------------- revoke
    if (operation === 'revoke') {
      const connection = await loadConnection(String(body.connection_id || ''));
      if (!connection) return json({ error: 'Connection not found' }, 404);
      if (connection.state === 'revoked') return json({ success: true, already_revoked: true });

      const reason = String(body.reason || '').trim();
      if (!reason) return json({ error: 'A reason is required to revoke a connection' }, 400);

      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({
          state: 'revoked',
          revoked_at: new Date().toISOString(),
          revoke_reason: reason,
        })
        .eq('id', connection.id)
        .neq('state', 'revoked')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'The connection could not be revoked' }, 409);

      await appendEvent(connection.id, 'connection_revoked', { reason });
      return json({ success: true, state: 'revoked' });
    }

    // ---------------------------------------------- grant_scope / revoke_scope
    if (operation === 'grant_scope' || operation === 'revoke_scope') {
      const connection = await loadConnection(String(body.connection_id || ''));
      if (!connection) return json({ error: 'Connection not found' }, 404);
      if (connection.state !== 'active') {
        return json({ error: 'Scopes move only on an active connection' }, 409);
      }
      const scopeKey = String(body.scope_key || '');
      if (!scopeKey) return json({ error: 'scope_key is required' }, 400);

      if (operation === 'grant_scope') {
        const { error } = await supabase.from('connection_scope_grants').insert({
          connection_id: connection.id,
          scope_key: scopeKey,
          granted_by_side: 'builder',
        });
        if (error) {
          // 23503: the FK said this scope does not exist — a write error by
          // design, never a grant that silently never applies. 23505: it is
          // already granted, which is the state the caller asked for.
          if (String(error.code) === '23505') return json({ success: true, already_granted: true });
          if (String(error.code) === '23503') return json({ error: `Unknown scope: ${scopeKey}` }, 400);
          console.error('[builder-network-connections] grant failed', error);
          return json({ error: 'The scope could not be granted' }, 500);
        }
        await appendEvent(connection.id, 'scope_granted', { scope_key: scopeKey });
        return json({ success: true });
      }

      const { data: removed, error } = await supabase
        .from('connection_scope_grants')
        .delete()
        .eq('connection_id', connection.id)
        .eq('scope_key', scopeKey)
        .select('scope_key');
      if (error) {
        console.error('[builder-network-connections] scope revoke failed', error);
        return json({ error: 'The scope could not be revoked' }, 500);
      }
      if (!removed?.length) return json({ success: true, already_absent: true });
      await appendEvent(connection.id, 'scope_revoked', { scope_key: scopeKey });
      return json({ success: true });
    }

    return json({ error: `Unknown operation: ${operation}` }, 400);
  } catch (error) {
    console.error('[builder-network-connections] error', error);
    return json({ error: 'The request could not be completed' }, 500);
  }
});
