/**
 * Builder / Developer Portal — self-registration (network edition).
 *
 * The portal's SECOND door (extraction plan §5). The first door is the
 * operator invite the prime always had; this one lets a builder sign up for
 * the network themselves — as an UNVERIFIED user whose organisation arrives
 * at `pending_verification`, because a self-assertion is a claim to be
 * vetted, not an account to be trusted.
 *
 * Three rules carry it:
 *
 *  1. **Never auto-join on a match.** An ABN that equals an existing
 *     organisation's proves the registrant KNOWS the ABN — a public fact —
 *     not that they belong to the organisation. A match creates a pending
 *     `builder_org_join_requests` row an owner decides; the registrant gets
 *     no membership, no organisation data, and the same generic response as
 *     everyone else.
 *
 *  2. **Registration is enumeration-safe.** An email that already holds an
 *     account gets the SAME "check your inbox" answer as a fresh one; the
 *     difference happens in the mailbox (an "you already have an account"
 *     note instead of a verification link). The unique index on
 *     lower(btrim(email)) is the arbiter, so two concurrent registrations
 *     cannot both create.
 *
 *  3. **The mailbox is proven by the token, never by the form.** The user is
 *     created with `email_verified_at` NULL and every governed surface is
 *     closed until `builder-portal-verify-email` consumes the emailed token
 *     — the governance chain reads it SECOND, before password rotation.
 *
 * Abuse posture: Turnstile (same fail-closed semantics as login), a honeypot
 * field real forms never render, and a per-IP rate limit tighter than the
 * invite path's, because this endpoint WRITES rows unauthenticated.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { hashPassword } from '../_shared/password.ts';
import { validatePasswordStrength } from '../_shared/passwordValidation.ts';
import { createCorsHeaders } from '../_shared/auth.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import { auditBuilderIdentity } from '../_shared/builderSessions.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { BuilderRegisterRequest, AUTH_MAX_BODY_BYTES } from '../_shared/authBodySchemas.ts';
import { verifyTurnstile, honeypotTripped } from '../_shared/publicAbuseControls.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { meteredFetch } from '../_shared/meteredFetch.ts';

const TOKEN_EXPIRY_HOURS = 24;
const ORG_TYPES = new Set(['developer', 'builder', 'builder_developer', 'sales_representative']);

/** One response for every outcome a caller may not distinguish. */
const GENERIC_OK = {
  success: true,
  message: 'Check your inbox — if this address can register, a verification email is on its way.',
};

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  if (!validateBuilderPortalRequest(req)) return json({ error: 'Invalid request' }, 400);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const __body = await parseJsonBody(req, BuilderRegisterRequest, corsHeaders, AUTH_MAX_BODY_BYTES);
    if (!__body.ok) return __body.response;
    const { email, password, name, phone, job_title, organisation, turnstile_token } = __body.data;

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    // The honeypot answers success and writes nothing: an automaton that
    // filled the invisible field learns nothing from the response.
    if (honeypotTripped(__body.data as Record<string, unknown>)) return json(GENERIC_OK, 202);

    const { data: allowed } = await supabase.rpc('check_and_bump_rate_limit', {
      p_key: `builder_register:${ip}`, p_max: 10, p_window_seconds: 3600,
    });
    if (allowed === false) return json({ error: 'Too many registrations from this address. Try again later.' }, 429);

    const turnstile = await verifyTurnstile(turnstile_token, ip);
    if (!turnstile.ok) {
      return json({ error: 'Security verification failed. Refresh and try again.' }, 400);
    }

    // --- Validate the form (these errors are the caller's to see) ----------
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      return json({ error: 'A valid email address is required' }, 400);
    }
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return json({ error: 'Your name is required' }, 400);
    if (!password || typeof password !== 'string') {
      return json({ error: 'A password is required' }, 400);
    }
    const strength = await validatePasswordStrength(password);
    if (!strength.isValid) {
      return json({ error: strength.error || 'Password does not meet the required strength' }, 400);
    }

    const orgLegalName = String(organisation?.legal_name || '').trim();
    if (!orgLegalName) return json({ error: 'Your organisation\'s legal name is required' }, 400);
    const orgType = String(organisation?.org_type || '').trim();
    if (!ORG_TYPES.has(orgType)) {
      return json({ error: 'Choose what kind of organisation you are registering' }, 400);
    }
    // An ABN is optional; a MALFORMED one is refused rather than silently
    // dropped, because writing NULL over a typo loses the fact the
    // registrant tried to state ("a figure is refused, never clamped").
    const abnRaw = String(organisation?.abn || '').replace(/\s+/g, '');
    if (abnRaw && !/^[0-9]{11}$/.test(abnRaw)) {
      return json({ error: 'An ABN is eleven digits' }, 400);
    }
    const abn = abnRaw || null;
    const state = String(organisation?.state || '').trim().toUpperCase() || null;
    if (state && !['NSW','VIC','QLD','SA','WA','TAS','NT','ACT'].includes(state)) {
      return json({ error: 'State must be an Australian state or territory code' }, 400);
    }

    const brand = await getBrandConfig();
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const appUrl = Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au';
    const sendEmail = async (subject: string, text: string) => {
      if (!resendApiKey) {
        console.warn('[builder-portal-register] RESEND_API_KEY unset — email not delivered');
        return;
      }
      try {
        await meteredFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
          body: JSON.stringify({
            from: brand.fromHeaderAdmin,
            to: [normalizedEmail],
            subject,
            text,
            tags: [{ name: 'category', value: 'builder_portal_register' }],
          }),
        });
      } catch (error) {
        console.error('[builder-portal-register] email send failed', error);
      }
    };

    // --- Existing account? Same response, different email. -----------------
    const { data: existing } = await supabase
      .from('builder_portal_users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (existing) {
      await sendEmail(
        `Your ${brand.companyName} account`,
        `Hi,\n\nSomeone (probably you) tried to register this address on the ${brand.companyName} Builder Portal, but it already has an account.\n\nSign in: ${appUrl}/builder/login\nForgot your password: ${appUrl}/builder/forgot-password\n\nIf this wasn't you, you can ignore this email.`,
      );
      return json(GENERIC_OK, 202);
    }

    // --- Create the user (unverified; the unique index is the arbiter) -----
    const passwordHash = await hashPassword(password);
    const { data: createdUser, error: userError } = await supabase
      .from('builder_portal_users')
      .insert({
        email: normalizedEmail,
        name: trimmedName,
        phone: String(phone || '').trim() || null,
        job_title: String(job_title || '').trim() || null,
        password_hash: passwordHash,
        must_change_password: false,
        status: 'active',
        is_active: true,
        // The whole point: nothing is verified yet.
        email_verified_at: null,
      })
      .select('id')
      .single();
    if (userError || !createdUser) {
      // A unique-index race (or a case-variant the pre-check's exact match
      // missed — the index is on lower(btrim(email))) lands here:
      // registration already happened, so the answer is the existing-account
      // answer, mailbox included, and never an error oracle.
      if (String(userError?.code) === '23505') {
        await sendEmail(
          `Your ${brand.companyName} account`,
          `Hi,\n\nSomeone (probably you) tried to register this address on the ${brand.companyName} Builder Portal, but it already has an account.\n\nSign in: ${appUrl}/builder/login\nForgot your password: ${appUrl}/builder/forgot-password\n\nIf this wasn't you, you can ignore this email.`,
        );
        return json(GENERIC_OK, 202);
      }
      console.error('[builder-portal-register] user insert failed', userError);
      return json({ error: 'Registration could not be completed. Try again shortly.' }, 500);
    }

    // The onboarding checklist exists from the moment the user does — the
    // same `builder_ensure_onboarding_steps` call the invite paths make, so
    // both doors mint identical journeys. Without it a self-registered user
    // reaches the onboarding gate with zero mandatory steps, and
    // `has_completed_mandatory_onboarding` (which requires steps to EXIST)
    // can never come true. Idempotent in the database; a transient failure
    // is repaired by the decision path's own ensure call and logged here.
    const { error: onboardingSeedError } = await supabase
      .rpc('builder_ensure_onboarding_steps', { _builder_user_id: createdUser.id });
    if (onboardingSeedError) {
      console.error('[builder-portal-register] onboarding seed failed', onboardingSeedError);
    }

    // --- Organisation: join request on an ABN match, new org otherwise -----
    let organisationOutcome = 'created_pending_verification';
    let joinRequestOrgId: string | null = null;
    if (abn) {
      const { data: abnMatch } = await supabase
        .from('builder_organisations')
        .select('id, legal_name')
        .eq('abn', abn)
        .maybeSingle();
      if (abnMatch) {
        // NEVER auto-join: the match creates a request an owner decides.
        joinRequestOrgId = abnMatch.id;
        organisationOutcome = 'join_request_pending';
        const { error: joinError } = await supabase
          .from('builder_org_join_requests')
          .insert({
            organisation_id: abnMatch.id,
            builder_user_id: createdUser.id,
            message: `Registered as ${trimmedName} <${normalizedEmail}> claiming ABN ${abn}.`,
          });
        if (joinError && String(joinError.code) !== '23505') {
          console.error('[builder-portal-register] join request insert failed', joinError);
        }
      }
    }
    if (!joinRequestOrgId) {
      const { data: createdOrg, error: orgError } = await supabase
        .from('builder_organisations')
        .insert({
          legal_name: orgLegalName,
          trading_name: String(organisation?.trading_name || '').trim() || null,
          org_type: orgType,
          abn,
          state,
          contact_email: normalizedEmail,
          status: 'pending_verification',
          is_active: false,
          created_by: createdUser.id,
        })
        .select('id')
        .single();
      if (orgError || !createdOrg) {
        console.error('[builder-portal-register] organisation insert failed', orgError);
        return json({ error: 'Registration could not be completed. Try again shortly.' }, 500);
      }
      const { error: membershipError } = await supabase
        .from('builder_organisation_memberships')
        .insert({
          builder_user_id: createdUser.id,
          organisation_id: createdOrg.id,
          membership_role: 'owner',
          is_primary: true,
          status: 'active',
        });
      if (membershipError) {
        console.error('[builder-portal-register] membership insert failed', membershipError);
        return json({ error: 'Registration could not be completed. Try again shortly.' }, 500);
      }
    }

    // --- Mint and send the verification token ------------------------------
    const verificationToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const tokenHash = await hashSessionToken(verificationToken);
    if (tokenHash) {
      const { error: tokenError } = await supabase
        .from('builder_email_verification_tokens')
        .insert({
          builder_user_id: createdUser.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600_000).toISOString(),
          requested_ip: ip,
        });
      if (tokenError) console.error('[builder-portal-register] token insert failed', tokenError);
    }
    const verifyUrl = `${appUrl}/builder/verify-email?token=${encodeURIComponent(verificationToken)}`;
    await sendEmail(
      `Verify your email for the ${brand.companyName} Builder Portal`,
      `Hi ${trimmedName.replace(/[<>]/g, '')},\n\nConfirm your email address to finish setting up your ${brand.companyName} Builder / Developer Portal account:\n\n${verifyUrl}\n\nThe link expires in ${TOKEN_EXPIRY_HOURS} hours.${joinRequestOrgId ? '\n\nYour request to join your organisation has been sent to its owners — they decide membership, and you\'ll be notified when they do.' : '\n\nYour organisation has been recorded and is pending verification by the Aurixa team.'}\n\nIf you didn't register, ignore this email.`,
    );

    await auditBuilderIdentity(supabase, req, {
      userId: createdUser.id,
      actorType: 'builder_user',
      action: 'builder_registered',
      metadata: { organisation_outcome: organisationOutcome },
    });

    return json(GENERIC_OK, 202);
  } catch (error) {
    console.error('[builder-portal-register] error', error);
    return json({ error: 'Registration could not be completed. Try again shortly.' }, 500);
  }
});
