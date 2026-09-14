/**
 * Builder / Developer Portal — password reset request.
 *
 * Mirrors `solicitor-portal-forgot-password`. Every path returns the same
 * generic success message, so the endpoint never reveals whether an email
 * belongs to a Builder account.
 *
 * Correction: the Solicitor function writes the OTP to a plaintext
 * `reset_token` column. Phase 1 stores `reset_token_hash` only, so the code is
 * hashed with the peppered `hashSessionToken` before persistence and exists in
 * plaintext only in the delivered email.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import { auditBuilderIdentity } from '../_shared/builderSessions.ts';
import { meteredFetch } from "../_shared/meteredFetch.ts";
import { authRateLimitedResponse, beginAuthRateLimit } from '../_shared/authRateLimit.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { ForgotPasswordRequest, AUTH_MAX_BODY_BYTES } from '../_shared/authBodySchemas.ts';

const OTP_EXPIRY_MINUTES = 15;
const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_SECONDS = 3600;

function generateOtp(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1000000).padStart(6, '0');
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const GENERIC_MESSAGE = 'If an account exists for that email, a reset code has been sent.';
  const genericOk = () => new Response(
    JSON.stringify({ success: true, message: GENERIC_MESSAGE }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  if (!validateBuilderPortalRequest(req)) return genericOk();

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // WP-27: bounded and shape-checked. This endpoint needs no session, so the
    // read had no size limit and the destructure below no runtime check — a
    // password arriving as an object reached the comparison as one.
    const __body = await parseJsonBody(req, ForgotPasswordRequest, corsHeaders, AUTH_MAX_BODY_BYTES);
    if (!__body.ok) return __body.response;
    const { email } = __body.data;
    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({ error: 'Email is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit BEFORE any lookup so enumeration cannot outrun the throttle.
    //
    // ABUSE-003: this used to consume an EMAIL-keyed bucket concurrently with
    // the IP one (`Promise.all`) and before the account was known to exist, so a
    // caller who was already over their IP ceiling could still mint a persistent
    // limiter row for every address they cared to type. The source-IP gate now
    // runs first and alone; the account bucket below is only reachable once the
    // account has been confirmed reachable. The address also no longer comes
    // from `x-forwarded-for`, which the caller sets.
    const gate = await beginAuthRateLimit(supabase, req, {
      scope: 'bpfp',
      ip: { max: MAX_REQUESTS_PER_WINDOW, windowSeconds: WINDOW_SECONDS },
    });
    if (!gate.allowed) {
      console.warn('[builder-portal-forgot-password] rate limited', { ipTrusted: gate.ipTrusted, degraded: gate.degraded });
      return authRateLimitedResponse(corsHeaders, gate.retryAfterSeconds, 'Too many reset requests. Please try again later.');
    }

    const { data: user } = await supabase
      .from('builder_portal_users')
      .select('id, email, name, status, is_active, revoked_at, password_hash, invited_at')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (!user || !user.is_active || user.status !== 'active' || user.revoked_at) return genericOk();

    // Password recovery must never bypass the invite flow.
    if (!user.password_hash && !user.invited_at) return genericOk();

    // A reset code must not resurrect an account with no live membership —
    // login would reject it anyway, so issuing a code would only leak existence.
    const { data: reachable } = await supabase.rpc('builder_accessible_organisations', {
      _user_id: user.id,
    });
    if (!Array.isArray(reachable) || !reachable.length) return genericOk();

    // A per-account bucket so rotating the source IP cannot churn reset tokens.
    const accountLimit = await gate.consumeIdentifier(user.id, {
      max: MAX_REQUESTS_PER_WINDOW, windowSeconds: WINDOW_SECONDS,
    });
    if (!accountLimit.allowed) {
      console.warn('[builder-portal-forgot-password] account rate limited', { degraded: accountLimit.degraded });
      return genericOk();
    }

    const otp = generateOtp();
    const otpHash = await hashSessionToken(otp);
    if (!otpHash) {
      console.error('[builder-portal-forgot-password] hashing unavailable — refusing to store an unpeppered code');
      return genericOk();
    }

    await supabase.from('builder_portal_users').update({
      reset_token_hash: otpHash,
      reset_token_expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000).toISOString(),
      reset_attempts: 0,
    }).eq('id', user.id);

    const brand = await getBrandConfig();
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const safeName = String(user.name || 'there').replace(/[<>]/g, '');

    if (resendApiKey) {
      try {
        await meteredFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
          body: JSON.stringify({
            from: brand.fromHeaderAdmin,
            to: [normalizedEmail],
            subject: `Your ${brand.companyName} Builder Portal reset code`,
            text: `Hi ${safeName},\n\nYour ${brand.companyName} Builder / Developer Portal password reset code is: ${otp}\n\nIt expires in ${OTP_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, ignore this email.`,
            tags: [{ name: 'category', value: 'builder_portal_reset' }],
          }),
        });
      } catch (error) {
        console.error('[builder-portal-forgot-password] email send failed', error);
      }
    } else {
      // Development and test environments have no mail provider configured.
      // The code is never logged — that would defeat hash-only storage.
      console.warn('[builder-portal-forgot-password] RESEND_API_KEY unset — reset code not delivered');
    }

    await auditBuilderIdentity(supabase, req, {
      userId: user.id, action: 'builder_password_reset_requested',
    });

    return genericOk();
  } catch (error) {
    console.error('[builder-portal-forgot-password]', error);
    return genericOk();
  }
});
