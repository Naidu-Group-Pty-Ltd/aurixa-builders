/**
 * Builder / Developer Portal — login.
 *
 * Mirrors `solicitor-portal-login` with three deliberate corrections:
 *
 *  1. The Solicitor function declares DUMMY_PASSWORD_HASH but never uses it: a
 *     missing account returns before bcrypt runs, leaving a timing oracle. Here
 *     the dummy hash is ALWAYS verified when the account is missing or has no
 *     password, so every path costs the same.
 *
 *  2. The Solicitor function checks account state (inactive, locked, firm
 *     inactive) BEFORE verifying the password, so those states are observable
 *     without credentials. Here the password is verified first; account state is
 *     only evaluated once the caller has proven who they are.
 *
 *  3. No raw session token is returned in JSON. It exists only in the
 *     Set-Cookie header.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { verifyPassword } from '../_shared/password.ts';
import { createCorsHeaders, createBuilderSessionCookie } from '../_shared/auth.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import {
  auditBuilderIdentity, GENERIC_AUTH_ERROR, issueBuilderSession,
} from '../_shared/builderSessions.ts';
import { listAccessibleOrganisations } from '../_shared/builderPortalAuth.ts';
import { authRateLimitedResponse, enforceAuthRateLimit } from '../_shared/authRateLimit.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { PortalLoginRequest, AUTH_MAX_BODY_BYTES } from '../_shared/authBodySchemas.ts';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const LOGIN_IP_BUDGET = { max: 30, windowSeconds: 900 };
const LOGIN_IDENTIFIER_BUDGET = { max: 12, windowSeconds: 900 };

// A fixed bcrypt hash keeps missing and passwordless accounts on the same
// expensive verification path as accounts with a stored password.
const DUMMY_PASSWORD_HASH = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
    });

  if (!validateBuilderPortalRequest(req)) {
    return json({ error: GENERIC_AUTH_ERROR }, 401);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // WP-27: bounded and shape-checked. This endpoint needs no session, so the
    // read had no size limit and the destructure below no runtime check — a
    // password arriving as an object reached the comparison as one.
    const __body = await parseJsonBody(req, PortalLoginRequest, corsHeaders, AUTH_MAX_BODY_BYTES);
    if (!__body.ok) return __body.response;
    const { email, password, turnstile_token } = __body.data;
    if (!email || !password) {
      return json({ error: 'Email and password are required' }, 400);
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // Rate limit before any lookup so enumeration cannot outrun the throttle.
    //
    // This previously keyed the source bucket on `x-forwarded-for[0]`, which the
    // caller sets — one header per request and the ceiling was gone. It also read
    // only `allowed === false`, so an RPC *error* (data: undefined) fell straight
    // through as "allowed" and the throttle silently did nothing. The shared
    // helper keys on the platform's unforgeable address header and degrades to a
    // per-isolate counter rather than failing open. See _shared/authRateLimit.ts.
    const rateLimit = await enforceAuthRateLimit(supabase, req, {
      scope: 'bpl',
      ip: LOGIN_IP_BUDGET,
      identifier: normalizedEmail,
      identifierBudget: LOGIN_IDENTIFIER_BUDGET,
    });
    if (!rateLimit.allowed) {
      console.warn('[builder-portal-login] rate limited', { ipTrusted: rateLimit.ipTrusted, degraded: rateLimit.degraded });
      return authRateLimitedResponse(corsHeaders, rateLimit.retryAfterSeconds, GENERIC_AUTH_ERROR);
    }

    // Turnstile, mirroring `solicitor-portal-login`: fails closed when
    // REQUIRE_TURNSTILE=true but the secret is absent. Deliberate ordering
    // difference — the Solicitor function verifies the challenge before rate
    // limiting; here the throttle runs first so an unauthenticated flood cannot
    // drive an outbound request per attempt.
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY');
    if (!turnstileSecret && Deno.env.get('REQUIRE_TURNSTILE') === 'true') {
      console.error('[builder-portal-login] TURNSTILE_SECRET_KEY missing while REQUIRE_TURNSTILE=true — failing closed');
      return json({ error: 'Security verification is unavailable. Please try again later.' }, 503);
    }
    if (turnstileSecret) {
      if (!turnstile_token) return json({ error: 'Security verification required' }, 400);
      const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: turnstileSecret, response: String(turnstile_token) }),
      });
      const verifyData = await verifyResponse.json().catch(() => null);
      if (!verifyData?.success) {
        return json({ error: 'Security verification failed. Please try again.' }, 403);
      }
    }

    const { data: portalUser } = await supabase
      .from('builder_portal_users')
      .select(`id, email, name, phone, job_title, password_hash, status, is_active,
               revoked_at, must_change_password, has_accepted_current_terms,
               has_completed_onboarding, failed_login_attempts, locked_until`)
      .eq('email', normalizedEmail)
      .maybeSingle();

    // ALWAYS verify a password, even with no account. Correction of the unused
    // Solicitor dummy hash.
    const candidateHash = portalUser?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordValid = await verifyPassword(password, candidateHash);

    if (!portalUser || !portalUser.password_hash || !passwordValid) {
      if (portalUser) {
        const attempts = (portalUser.failed_login_attempts || 0) + 1;
        const updates: Record<string, unknown> = { failed_login_attempts: attempts };
        if (attempts >= MAX_FAILED_ATTEMPTS) {
          updates.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
          updates.failed_login_attempts = 0;
          await auditBuilderIdentity(supabase, req, {
            userId: portalUser.id, action: 'builder_login_lockout', reason: 'excessive failures',
          });
        }
        await supabase.from('builder_portal_users').update(updates).eq('id', portalUser.id);
        // Telemetry is best effort. `rpc()` resolves with `{ error }` rather
        // than rejecting, so awaiting it cannot fail the login path — the
        // PostgREST builder has no `.catch`, which is why one is not chained.
        await supabase.rpc('record_portal_operational_event', {
          _event_name: attempts >= MAX_FAILED_ATTEMPTS ? 'excessive_authentication_failures' : 'builder_login_failure',
          _severity: attempts >= MAX_FAILED_ATTEMPTS ? 'high' : 'warning',
          _correlation_id: crypto.randomUUID(), _request_id: req.headers.get('x-request-id'),
          _actor_type: 'builder_user', _actor_id: portalUser.id, _portal: 'builder',
          _case_id: null, _matter_id: null, _firm_id: null, _duration_ms: null, _success: false,
          _metadata: { attempt_bucket: attempts >= MAX_FAILED_ATTEMPTS ? 'lockout' : 'below_lockout' },
        });
      }
      return json({ error: GENERIC_AUTH_ERROR }, 401);
    }

    // --- Credentials proven. Only now is account state evaluated. ---

    if (portalUser.locked_until && new Date(portalUser.locked_until) > new Date()) {
      return json({ error: GENERIC_AUTH_ERROR }, 401);
    }
    if (!portalUser.is_active || portalUser.status !== 'active' || portalUser.revoked_at) {
      return json({ error: GENERIC_AUTH_ERROR }, 401);
    }

    // An active membership of an active organisation is required. Same generic
    // error, so a builder cannot probe organisation state either.
    const organisations = await listAccessibleOrganisations(supabase, portalUser.id);
    if (!organisations.length) return json({ error: GENERIC_AUTH_ERROR }, 401);
    await supabase.from('builder_portal_users').update({
      last_login_at: new Date().toISOString(),
      failed_login_attempts: 0,
      locked_until: null,
    }).eq('id', portalUser.id);

    // `builder_issue_session` re-checks the user and membership server-side.
    const issued = await issueBuilderSession(supabase, portalUser.id, req, {
      deviceLabel: req.headers.get('user-agent') || undefined,
    });

    // Auto-select the accessible primary organisation, or the only accessible one.
    const autoSelected = organisations.find((organisation) => organisation.is_primary)
      ?? (organisations.length === 1 ? organisations[0] : null);
    if (autoSelected) {
      await supabase.rpc('builder_select_session_organisation', {
        _session_id: issued.id,
        _builder_user_id: portalUser.id,
        _organisation_id: autoSelected.organisation_id,
      });
    }

    await auditBuilderIdentity(supabase, req, {
      userId: portalUser.id, organisationId: autoSelected?.organisation_id ?? null,
      action: 'builder_login', sessionId: issued.id,
    });
    await supabase.rpc('record_portal_operational_event', {
      _event_name: 'builder_login_success', _severity: 'info',
      _correlation_id: crypto.randomUUID(), _request_id: req.headers.get('x-request-id'),
      _actor_type: 'builder_user', _actor_id: portalUser.id, _portal: 'builder',
      _case_id: null, _matter_id: null, _firm_id: null, _duration_ms: null, _success: true,
      _metadata: { session_id: issued.id },
    });

    return json({
      success: true,
      user: {
        id: portalUser.id,
        email: portalUser.email,
        name: portalUser.name,
        phone: portalUser.phone,
        job_title: portalUser.job_title,
        must_change_password: !!portalUser.must_change_password,
        has_accepted_current_terms: !!portalUser.has_accepted_current_terms,
        has_completed_onboarding: !!portalUser.has_completed_onboarding,
      },
      organisations,
      active_organisation: autoSelected,
      requires_organisation_selection: !autoSelected,
      // Session METADATA only. The token is in the Set-Cookie header.
      session: {
        id: issued.id,
        absolute_expires_at: issued.absoluteExpiresAt.toISOString(),
        idle_expires_at: issued.idleExpiresAt.toISOString(),
      },
    }, 200, { 'Set-Cookie': createBuilderSessionCookie(issued.token, issued.absoluteExpiresAt) });
  } catch (error) {
    console.error('[builder-portal-login]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
