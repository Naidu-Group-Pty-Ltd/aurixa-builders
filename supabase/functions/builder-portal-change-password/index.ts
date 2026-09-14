/**
 * Builder / Developer Portal — authenticated password change.
 *
 * Mirrors `solicitor-portal-change-password`, including its rotation behaviour:
 * every existing session is revoked and a fresh one is issued, so the caller is
 * not signed out of the tab they are using while every other device is.
 *
 * Corrections applied against the Solicitor original (Phase 0 NOCOPY list):
 *   - the session is resolved from the HttpOnly cookie only; the request body
 *     cannot carry a session token (NOCOPY-01/02),
 *   - the new session token is returned ONLY in `Set-Cookie`, never in the JSON
 *     body (NOCOPY-02),
 *   - password strength goes through the shared validator instead of a bare
 *     length check,
 *   - the current password is required unconditionally. The Solicitor version
 *     skips the check when `password_hash` is null; a Builder account always has
 *     a hash by the time it can sign in, so there is no branch to skip.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { hashPassword, verifyPassword } from '../_shared/password.ts';
import { validatePasswordStrength } from '../_shared/passwordValidation.ts';
import { createCorsHeaders, createBuilderSessionCookie } from '../_shared/auth.ts';
import { csrfDenied, enforceCsrf } from '../_shared/csrfGuard.ts';
import { resolveBuilderSession } from '../_shared/builderPortalAuth.ts';
import {
  auditBuilderIdentity, issueBuilderSession, revokeAllBuilderSessions,
} from '../_shared/builderSessions.ts';

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
    });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // The session comes from the cookie. The body is read afterwards and is only
    // ever consulted for the two password fields.
    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error, code: session.code }, session.status);
    }

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* handled by the checks below */ }
    const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

    if (!currentPassword) return json({ error: 'Your current password is required' }, 400);
    if (!newPassword) return json({ error: 'A new password is required' }, 400);

    const strength = await validatePasswordStrength(newPassword);
    if (!strength.isValid) {
      return json({ error: strength.error || 'Password does not meet the required strength' }, 400);
    }

    const { data: record } = await supabase
      .from('builder_portal_users')
      .select('id, password_hash')
      .eq('id', session.user.id)
      .maybeSingle();

    if (!record?.password_hash) return json({ error: 'Account not found' }, 404);

    const valid = await verifyPassword(currentPassword, record.password_hash);
    if (!valid) {
      await auditBuilderIdentity(supabase, req, {
        userId: record.id,
        organisationId: session.active_organisation?.organisation_id ?? null,
        action: 'builder_password_change_rejected',
        sessionId: session.session_id,
        reason: 'current_password_incorrect',
      });
      return json({ error: 'Your current password is incorrect' }, 401);
    }
    if (currentPassword === newPassword) {
      return json({ error: 'Your new password must be different from your current password' }, 400);
    }

    const passwordHash = await hashPassword(newPassword);

    const { error: updateError } = await supabase.from('builder_portal_users').update({
      password_hash: passwordHash,
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
      reset_token_hash: null,
      reset_token_expires_at: null,
      reset_attempts: 0,
      failed_login_attempts: 0,
      locked_until: null,
    }).eq('id', record.id);
    if (updateError) throw updateError;

    // Everything issued under the old password dies, including this request's
    // own session, and a new one is issued for the caller's current device.
    const revoked = await revokeAllBuilderSessions(supabase, record.id, 'password_changed');
    const issued = await issueBuilderSession(supabase, record.id, req, {
      deviceLabel: req.headers.get('user-agent') || undefined,
    });

    // A password change is an access-control change, so the audit write must
    // succeed (Phase 0 NOCOPY-04). If it does not, the freshly issued session is
    // revoked and the caller is asked to sign in again rather than continuing
    // with an unlogged credential rotation.
    const logged = await auditBuilderIdentity(supabase, req, {
      userId: record.id,
      organisationId: session.active_organisation?.organisation_id ?? null,
      action: 'builder_password_changed',
      sessionId: issued.id,
      metadata: { sessions_revoked: revoked },
    });
    if (!logged) {
      await revokeAllBuilderSessions(supabase, record.id, 'audit_write_failed');
      return json({ error: 'Password changed but the security log could not be written. Please sign in again.' }, 500);
    }

    // Token in the cookie only — the body carries no credential material.
    return json({ success: true, sessions_revoked: revoked }, 200, {
      'Set-Cookie': createBuilderSessionCookie(issued.token, issued.absoluteExpiresAt),
    });
  } catch (error) {
    console.error('[builder-portal-change-password]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
