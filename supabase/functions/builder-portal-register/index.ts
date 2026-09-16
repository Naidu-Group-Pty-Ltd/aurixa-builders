/**
 * Builder / Developer Portal — self-registration is CLOSED.
 *
 * The portal is invitation-only. An account comes to exist exactly one way:
 * an existing organisation's owner or administrator invites a colleague
 * (`builder-portal-invite`), who accepts an emailed, hashed, single-use token
 * (`builder-portal-accept-invite`). There is no public sign-up.
 *
 * This endpoint used to be the network's "second door": a stranger could
 * register their own organisation as an unverified, operator-vetted account.
 * That door is now shut at the source. It does not validate a form, it does
 * not write a user, an organisation, a membership, a join request or a
 * verification token. It touches the database for exactly one reason — to
 * record a budgeted operational event so a spike in probing is visible
 * rather than silent — and that record can never change the answer.
 *
 * The route and the deployed function are kept (rather than deleted) so that
 * an old bookmark, a cached client or a scripted probe meets an explicit,
 * stable "invitation only" answer instead of a 404 that invites guessing —
 * the same reasoning the withdrawn portal sections follow. The frontend
 * `/builder/register` page renders the same message.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import { enforceAuthRateLimit } from '../_shared/authRateLimit.ts';
import { getTrustedClientIp } from '../_shared/requestSecurity.ts';

/** The one answer this door gives, whatever the request carried. */
const REGISTRATION_CLOSED = {
  error: 'The Builder Portal is invitation only. Ask an administrator at your '
    + 'organisation to invite you; the invitation arrives by email.',
  code: 'registration_closed',
};

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // The origin/shape guard still runs first, so a cross-origin probe is turned
  // away exactly as every other portal endpoint turns it away.
  if (!validateBuilderPortalRequest(req)) return json({ error: 'Invalid request' }, 400);

  // Best-effort visibility: a closed door that stays quiet hides a probing
  // spike. The record is never allowed to change the answer — any failure
  // here is swallowed, and the refusal is returned regardless.
  //
  // Two corrections from the security audit of 16 Sep 2026, both against the
  // first version of this door:
  //
  //  * It wrote a row for EVERY request, unauthenticated and unbounded, so the
  //    event stream meant to make probing visible was itself the amplifier.
  //    The write is now budgeted; past the budget the door still refuses, it
  //    simply stops repeating itself. A burst therefore shows as a handful of
  //    records and then silence, which is the signal, not noise.
  //  * The recorded address came from `X-Forwarded-For`, which the caller
  //    sets — so the security log could be filled with addresses of the
  //    attacker's choosing. Only an address the platform vouched for is
  //    recorded now, and an unvouched one is recorded honestly as unknown.
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const budget = await enforceAuthRateLimit(supabase, req, {
      scope: 'brg', ip: { max: 10, windowSeconds: 3600 },
    });
    if (budget.allowed) {
      await supabase.rpc('record_portal_operational_event', {
        _event_name: 'registration_attempt_refused',
        _severity: 'info',
        _correlation_id: crypto.randomUUID(),
        _request_id: req.headers.get('x-request-id'),
        _actor_type: 'anonymous',
        _actor_id: null,
        _portal: 'builder',
        _case_id: null, _matter_id: null, _firm_id: null,
        _duration_ms: null, _success: false,
        _metadata: { reason: 'invitation_only', ip: getTrustedClientIp(req.headers) ?? 'unknown' },
      });
    }
  } catch (error) {
    console.warn('[builder-portal-register] closed-door event not recorded', error);
  }

  // 403, not 404: the door exists and its answer is a policy, not a mystery.
  return json(REGISTRATION_CLOSED, 403);
});
