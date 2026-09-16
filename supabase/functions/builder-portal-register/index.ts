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
 * verification token — it refuses every request before touching the database,
 * and records the attempt as an operational event so a spike in probing is
 * visible rather than silent.
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
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
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
      _metadata: { reason: 'invitation_only', ip },
    });
  } catch (error) {
    console.warn('[builder-portal-register] closed-door event not recorded', error);
  }

  // 403, not 404: the door exists and its answer is a policy, not a mystery.
  return json(REGISTRATION_CLOSED, 403);
});
