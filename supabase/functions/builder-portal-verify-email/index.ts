/**
 * Builder / Developer Portal — email verification (network edition).
 *
 * Consumes the token `builder-portal-register` mailed, and stamps
 * `email_verified_at` — the fact the governance chain reads SECOND. Its own
 * token table (`builder_email_verification_tokens`, the reset-token shape:
 * hash-only, expiry, single consumption) and NEVER the invite columns: an
 * invite is an operator's act with organisation bindings hanging off it,
 * and a self-service verification that borrowed it would read as an
 * invitation nobody sent.
 *
 * Two actions:
 *
 *  - `verify` (default): `{ token }`, no session required — the emailed link
 *    must work in whatever browser it was opened in. Possession of the token
 *    IS the proof, so a token whose user is already verified answers success
 *    rather than a puzzle. Consumption is atomic (conditional UPDATE on
 *    `consumed_at IS NULL`), the same idiom the reset flow uses.
 *
 *  - `resend`: session required (the signed-in, still-unverified user asking
 *    for another email). Resolved directly off the session WITHOUT the
 *    governance gate — the gate's second stage is exactly what this endpoint
 *    discharges, so gating it would lock the door from both sides. Every
 *    prior token for the user is invalidated first: one live link at a time.
 *
 * Every refusal on the verify path is the same generic message — a token is
 * a secret, and "expired" vs "unknown" vs "consumed" is an oracle over other
 * people's tokens. The ONE distinction shown (`expired: true`) matches the
 * accept-invite precedent: it changes what the holder should DO (ask for a
 * new link), and only a holder ever sees it.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { csrfDenied, enforceCsrf } from '../_shared/csrfGuard.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import { auditBuilderIdentity } from '../_shared/builderSessions.ts';
import { resolveBuilderSession } from '../_shared/builderPortalAuth.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { VerifyEmailRequest, AUTH_MAX_BODY_BYTES } from '../_shared/authBodySchemas.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { meteredFetch } from '../_shared/meteredFetch.ts';

const GENERIC_TOKEN_ERROR = 'Invalid or expired verification link';
const TOKEN_EXPIRY_HOURS = 24;

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  if (!validateBuilderPortalRequest(req)) return json({ error: GENERIC_TOKEN_ERROR }, 400);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const __body = await parseJsonBody(req, VerifyEmailRequest, corsHeaders, AUTH_MAX_BODY_BYTES);
    if (!__body.ok) return __body.response;
    const { action, token } = __body.data;

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { data: allowed } = await supabase.rpc('check_and_bump_rate_limit', {
      p_key: `builder_verify_email:${ip}`, p_max: 30, p_window_seconds: 3600,
    });
    if (allowed === false) return json({ error: 'Too many attempts. Try again later.' }, 429);

    // ---------------------------------------------------------------- resend
    if (action === 'resend') {
      // The resend is a cookie-authenticated mutation — the one branch here
      // ambient authority can reach — so it is CSRF-guarded like every other.
      const csrf = enforceCsrf(req);
      if (!csrf.ok) return csrfDenied(corsHeaders, csrf);
      const session = await resolveBuilderSession(supabase, req);
      if (!session.ok || !session.user) {
        return json({ error: 'Sign in to request a new verification email' }, 401);
      }
      if (session.user.email_verified_at) {
        return json({ success: true, already_verified: true });
      }

      // One live link at a time: everything unconsumed dies first, so a
      // stolen older email cannot verify after a newer one was requested.
      await supabase
        .from('builder_email_verification_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('builder_user_id', session.user.id)
        .is('consumed_at', null);

      const verificationToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const tokenHash = await hashSessionToken(verificationToken);
      if (!tokenHash) return json({ error: 'Verification could not be prepared' }, 500);
      const { error: tokenError } = await supabase
        .from('builder_email_verification_tokens')
        .insert({
          builder_user_id: session.user.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600_000).toISOString(),
          requested_ip: ip,
        });
      if (tokenError) {
        console.error('[builder-portal-verify-email] token insert failed', tokenError);
        return json({ error: 'Verification could not be prepared' }, 500);
      }

      const brand = await getBrandConfig();
      const appUrl = Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au';
      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      const verifyUrl = `${appUrl}/builder/verify-email?token=${encodeURIComponent(verificationToken)}`;
      if (resendApiKey) {
        try {
          await meteredFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: brand.fromHeaderAdmin,
              to: [session.user.email],
              subject: `Verify your email for the ${brand.companyName} Builder Portal`,
              text: `Hi ${String(session.user.name || 'there').replace(/[<>]/g, '')},\n\nConfirm your email address:\n\n${verifyUrl}\n\nThe link expires in ${TOKEN_EXPIRY_HOURS} hours.\n\nIf you didn't request this, ignore this email.`,
              tags: [{ name: 'category', value: 'builder_portal_verify_email' }],
            }),
          });
        } catch (error) {
          console.error('[builder-portal-verify-email] email send failed', error);
        }
      } else {
        console.warn('[builder-portal-verify-email] RESEND_API_KEY unset — email not delivered');
      }
      return json({ success: true, sent: true });
    }

    // ---------------------------------------------------------------- verify
    if (!token || typeof token !== 'string') {
      return json({ error: GENERIC_TOKEN_ERROR }, 400);
    }
    const tokenHash = await hashSessionToken(token);
    if (!tokenHash) return json({ error: GENERIC_TOKEN_ERROR }, 400);

    const { data: row } = await supabase
      .from('builder_email_verification_tokens')
      .select('id, builder_user_id, expires_at, consumed_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (!row) return json({ error: GENERIC_TOKEN_ERROR }, 400);

    // Possession proves the mailbox, so an already-verified holder gets the
    // truth rather than a riddle — this is the double-click on the email.
    const { data: holder } = await supabase
      .from('builder_portal_users')
      .select('id, email_verified_at, revoked_at, status')
      .eq('id', row.builder_user_id)
      .maybeSingle();
    if (!holder || holder.revoked_at || holder.status === 'revoked') {
      return json({ error: GENERIC_TOKEN_ERROR }, 400);
    }
    if (holder.email_verified_at) {
      return json({ success: true, already_verified: true });
    }

    if (row.consumed_at) return json({ error: GENERIC_TOKEN_ERROR }, 400);
    if (new Date(row.expires_at) < new Date()) {
      return json({ error: GENERIC_TOKEN_ERROR, expired: true }, 400);
    }

    // Atomic consumption: of two concurrent requests carrying this token,
    // exactly one matches `consumed_at IS NULL`.
    const { data: consumed } = await supabase
      .from('builder_email_verification_tokens')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle();
    if (!consumed) return json({ error: GENERIC_TOKEN_ERROR }, 400);

    // Stamp the proof — conditionally, so the FIRST proof's date is history
    // nothing rewrites.
    await supabase
      .from('builder_portal_users')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('id', holder.id)
      .is('email_verified_at', null);

    await auditBuilderIdentity(supabase, req, {
      userId: holder.id,
      actorType: 'builder_user',
      action: 'builder_email_verified',
    });

    return json({ success: true, verified: true });
  } catch (error) {
    console.error('[builder-portal-verify-email] error', error);
    return json({ error: 'Verification could not be completed. Try again shortly.' }, 500);
  }
});
