/**
 * Builder / Developer Portal — session restoration and governance.
 *
 * Mirrors `solicitor-portal-verify`, which deliberately groups session restore,
 * terms, onboarding and device management into one function rather than
 * splitting them. Builder keeps that grouping and adds organisation selection,
 * which the Solicitor Portal has no equivalent of because a solicitor belongs to
 * exactly one firm.
 *
 * Actions
 *   (none)                  restore the session for the client
 *   get_governance          current terms + onboarding checklist
 *   accept_current_terms    record acceptance for the AUTHENTICATED user
 *   complete_onboarding     complete one step or all remaining steps
 *   select_organisation     set the server-held active organisation
 *   list_sessions           the caller's own devices
 *   revoke_session          revoke one of the caller's own sessions
 *   revoke_other_sessions   revoke every other session
 *
 * Every mutating action passes the central CSRF guard first, in the established
 * `csrfDenied(corsHeaders, result)` argument order.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders, createClearBuilderSessionCookie } from '../_shared/auth.ts';
import { csrfDenied, enforceCsrf } from '../_shared/csrfGuard.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import {
  resolveBuilderSession, builderGovernanceError, builderPermissionMatrix,
} from '../_shared/builderPortalAuth.ts';
import { auditBuilderIdentity, revokeBuilderSession, revokeAllBuilderSessions } from '../_shared/builderSessions.ts';
import { ACKNOWLEDGEMENTS_INCOMPLETE_ERROR, readAcknowledgements } from '../_shared/portalAgreement.ts';

const MUTATING_ACTIONS = new Set([
  'accept_current_terms', 'complete_onboarding', 'select_organisation',
  'revoke_session', 'revoke_other_sessions',
]);

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
    });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* a bare restore call has no body */ }
    const action = typeof body?.action === 'string' ? body.action : null;

    if (action && MUTATING_ACTIONS.has(action)) {
      const csrf = enforceCsrf(req);
      if (!csrf.ok) return csrfDenied(corsHeaders, csrf);
    }

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      // An invalid session must not leave a stale cookie behind.
      return json({ valid: false, error: session.error, code: session.code }, session.status, {
        'Set-Cookie': createClearBuilderSessionCookie(),
      });
    }

    const user = session.user;
    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;

    // ---------------------------------------------------------------- terms
    if (action === 'accept_current_terms') {
      // Every mandatory acknowledgment must be asserted. The list is shared
      // with the Solicitor and Finance portals: one agreement, one gate.
      const { acknowledgements, missing } = readAcknowledgements(body);
      if (missing.length > 0) {
        return json({
          error: ACKNOWLEDGEMENTS_INCOMPLETE_ERROR,
          code: 'ACKNOWLEDGEMENTS_INCOMPLETE',
          missing,
        }, 400);
      }

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
      const userAgent = req.headers.get('user-agent');
      const { data, error } = await supabase.rpc('builder_accept_current_terms', {
        _builder_user_id: user.id,
        _session_id: session.session_id,
        _ip_hash: ip ? await hashSessionToken(`ip:${ip}`) : null,
        _user_agent_hash: userAgent ? await hashSessionToken(`ua:${userAgent}`) : null,
        _acknowledgements: acknowledgements,
      });
      if (error) {
        if (String(error.message).includes('BUILDER_TERMS_UNAVAILABLE')) {
          return json({ error: 'Current terms unavailable' }, 503);
        }
        if (String(error.message).includes('BUILDER_SESSION_NOT_FOUND')) {
          return json({ error: 'Invalid or expired session', code: 'auth_required' }, 401, {
            'Set-Cookie': createClearBuilderSessionCookie(),
          });
        }
        throw error;
      }
      // `builder_accept_current_terms` writes the acceptance, the user flag and
      // the activity-log entry — including which acknowledgments were asserted —
      // in one transaction. Logging again here would double-count the event.
      const accepted = Array.isArray(data) ? data[0] : data;
      return json({ success: true, terms_version_id: accepted?.terms_version_id ?? null });
    }

    if (action === 'get_governance') {
      const [{ data: terms }, { data: steps }] = await Promise.all([
        supabase.from('portal_terms_versions')
          .select('id, version, title, content_markdown, document_hash, effective_at')
          .eq('portal', 'builder').is('retired_at', null)
          .lte('effective_at', new Date().toISOString())
          .order('effective_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('builder_onboarding_steps')
          .select('step_key, mandatory, completed_at')
          .eq('builder_user_id', user.id).order('created_at'),
      ]);
      return json({
        success: true,
        terms,
        terms_accepted: user.has_accepted_current_terms,
        steps: steps ?? [],
      });
    }

    // ----------------------------------------------------------- onboarding
    if (action === 'complete_onboarding') {
      const stepKey = typeof body.step_key === 'string' ? body.step_key : null;
      const { data, error } = await supabase.rpc('builder_complete_onboarding', {
        _builder_user_id: user.id,
        _session_id: session.session_id,
        _step_key: stepKey,
      });
      if (error) {
        if (String(error.message).includes('BUILDER_SESSION_NOT_FOUND')) {
          return json({ error: 'Invalid or expired session', code: 'auth_required' }, 401, {
            'Set-Cookie': createClearBuilderSessionCookie(),
          });
        }
        throw error;
      }
      return json({ success: true, onboarding_complete: data === true });
    }

    // -------------------------------------------------- organisation context
    if (action === 'select_organisation') {
      const requested = typeof body.organisation_id === 'string' ? body.organisation_id : null;
      if (!requested) return json({ error: 'organisation_id is required' }, 400);

      // The requested id is a REQUEST, not authority: it must appear in the
      // server-resolved reach, and the database command re-verifies membership
      // again before it writes.
      if (!session.organisations?.some((o) => o.organisation_id === requested)) {
        return json({
          error: 'You do not have access to that organisation', code: 'organisation_not_accessible',
        }, 403);
      }

      const { error } = await supabase.rpc('builder_select_session_organisation', {
        _session_id: session.session_id,
        _builder_user_id: user.id,
        _organisation_id: requested,
      });
      if (error) {
        if (String(error.message).includes('BUILDER_ORGANISATION_NOT_ACCESSIBLE')) {
          return json({ error: 'You do not have access to that organisation', code: 'organisation_not_accessible' }, 403);
        }
        throw error;
      }

      const selected = session.organisations.find((o) => o.organisation_id === requested)!;
      return json({ success: true, active_organisation: selected });
    }

    // --------------------------------------------------------------- devices
    if (action === 'list_sessions') {
      const { data: sessions } = await supabase.from('builder_portal_sessions')
        .select('id, created_at, absolute_expires_at, idle_expires_at, last_used_at, revoked_at, revoked_reason, device_label')
        .eq('builder_user_id', user.id).order('last_used_at', { ascending: false });
      return json({ success: true, current_session_id: session.session_id ?? null, sessions: sessions ?? [] });
    }

    if (action === 'revoke_session') {
      const targetId = typeof body.session_id === 'string' ? body.session_id : '';
      // Scoped to the caller's own sessions: a forged id belonging to another
      // user matches no row.
      const { data: target } = await supabase.from('builder_portal_sessions')
        .select('id').eq('id', targetId).eq('builder_user_id', user.id)
        .is('revoked_at', null).maybeSingle();
      if (!target) return json({ error: 'Session not found' }, 404);

      await revokeBuilderSession(supabase, target.id, 'user_revoked_device');
      await auditBuilderIdentity(supabase, req, {
        userId: user.id, organisationId: activeOrganisationId,
        action: 'builder_session_revoked', sessionId: target.id,
      });
      return json({ success: true }, 200,
        target.id === session.session_id ? { 'Set-Cookie': createClearBuilderSessionCookie() } : {});
    }

    if (action === 'revoke_other_sessions') {
      const revoked = await revokeAllBuilderSessions(
        supabase, user.id, 'user_revoked_other_devices', session.session_id ?? null);
      await auditBuilderIdentity(supabase, req, {
        userId: user.id, organisationId: activeOrganisationId,
        action: 'builder_other_sessions_revoked', sessionId: session.session_id,
        metadata: { count: revoked },
      });
      return json({ success: true, revoked });
    }

    // ------------------------------------------------------ session restore
    const previousSeenAt = user.last_seen_at;
    await supabase.from('builder_portal_users')
      .update({ last_seen_at: new Date().toISOString() }).eq('id', user.id);

    const permissions = activeOrganisationId
      ? await builderPermissionMatrix(supabase, session, activeOrganisationId)
      : {};

    return json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        job_title: user.job_title,
        must_change_password: user.must_change_password,
        has_accepted_terms: user.has_accepted_terms,
        has_completed_onboarding: user.has_completed_onboarding,
        current_terms_version: user.current_terms_version,
        has_accepted_current_terms: user.has_accepted_current_terms,
        has_completed_mandatory_onboarding: user.has_completed_mandatory_onboarding,
      },
      organisations: session.organisations ?? [],
      active_organisation: session.active_organisation ?? null,
      requires_organisation_selection: !session.active_organisation,
      permissions,
      governance: builderGovernanceError(session),
      previous_seen_at: previousSeenAt,
      session: session.session_id ? { id: session.session_id } : null,
    });
  } catch (error) {
    console.error('[builder-portal-verify]', error);
    return json({ error: 'Internal server error', valid: false }, 500);
  }
});
