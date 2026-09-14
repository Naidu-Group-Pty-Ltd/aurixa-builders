/**
 * Builder / Developer Portal — logout.
 *
 * Mirrors `solicitor-portal-logout`: revoke the session, clear the cookie, and
 * always answer 200 so a failure cannot be probed. The cookie is cleared on
 * every path, including when no valid session was presented, so a stale or
 * revoked cookie never survives a logout attempt.
 *
 * Correction: logout revokes a session, so it is a state-changing request and
 * passes the central CSRF guard. The Solicitor original does not, which lets a
 * third-party page force a signed-in solicitor out (Phase 0 NOCOPY-06).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders, createClearBuilderSessionCookie } from '../_shared/auth.ts';
import { csrfDenied, enforceCsrf } from '../_shared/csrfGuard.ts';
import { resolveBuilderSession } from '../_shared/builderPortalAuth.ts';
import { auditBuilderIdentity, revokeBuilderSession } from '../_shared/builderSessions.ts';

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const headers = {
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Set-Cookie': createClearBuilderSessionCookie(),
  };

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const session = await resolveBuilderSession(supabase, req);
    if (session.ok && session.user && session.session_id) {
      await revokeBuilderSession(supabase, session.session_id, 'user_logout');
      await auditBuilderIdentity(supabase, req, {
        userId: session.user.id,
        organisationId: session.active_organisation?.organisation_id ?? null,
        action: 'builder_logout',
        sessionId: session.session_id,
      });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (error) {
    console.error('[builder-portal-logout]', error);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  }
});
