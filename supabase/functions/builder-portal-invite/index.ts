/**
 * Builder / Developer Portal — invitation issuance (Command Centre side).
 *
 * Mirrors `solicitor-portal-invite`: an INTERNAL function gated on the
 * `builder_portal_admin` module permission, with CSRF on every mutation. It
 * resolves a Command Centre session and never accepts a Builder session cookie.
 *
 * Correction: the generated token is stored as a HASH. The plaintext exists only
 * in the invite email and the returned link, never at rest.
 *
 * Actions: invite | resend | revoke_invite
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders, createForbiddenResponse, verifyAuth } from '../_shared/auth.ts';
import { requireModulePermission } from '../_shared/authz.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { meteredFetch } from "../_shared/meteredFetch.ts";

const MODULE_KEY = 'builder_portal_admin';
const INVITE_EXPIRY_HOURS = 72;

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // Cookie-carried staff session: CSRF first, matching solicitor-portal-invite.
  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === 'string' ? body.action : 'invite';
    const builderUserId = typeof body.builder_user_id === 'string' ? body.builder_user_id : null;

    const auth = await verifyAuth(supabase, req.headers, body as any);
    if (auth.error || !auth.userId) {
      return json({ error: auth.error || 'Authentication required' }, 401);
    }

    const authz = await requireModulePermission(
      supabase, { userId: auth.userId, authMethod: auth.authMethod }, MODULE_KEY, 'can_edit');
    if (!authz.ok) return createForbiddenResponse(authz.error || 'Not authorized', corsHeaders);

    // verifyAuth returns the literal string 'service_role' for internal calls;
    // it is not a uuid and must never reach a uuid column.
    const adminUserId = auth.userId === 'service_role' ? null : auth.userId;
    const actorType = auth.userId === 'service_role' ? 'service_role' : 'command_user';

    if (!builderUserId) return json({ error: 'builder_user_id is required' }, 400);

    const { data: portalUser } = await supabase
      .from('builder_portal_users')
      .select('id, email, name, status, is_active, revoked_at, invite_accepted_at, password_hash, row_version')
      .eq('id', builderUserId).maybeSingle();
    if (!portalUser) return json({ error: 'Portal user not found' }, 404);

    if (action === 'revoke_invite') {
      const { error } = await supabase.from('builder_portal_users').update({
        invite_token_hash: null, invite_token_expires_at: null, updated_by: adminUserId,
      }).eq('id', builderUserId);
      if (error) throw error;
      await logInviteActivity(supabase, req, {
        adminUserId, actorType, action: 'builder_invite_revoked', builderUserId,
      });
      return json({ success: true });
    }

    if (portalUser.revoked_at || portalUser.status === 'revoked') {
      return json({ error: 'This user has been revoked. Restore access before inviting them.' }, 409);
    }
    if (portalUser.invite_accepted_at || portalUser.password_hash) {
      return json({
        error: 'This account is already active. Use the password reset flow instead.',
        code: 'already_active',
      }, 409);
    }

    // A user with no membership has nowhere to sign in to.
    const { data: memberships } = await supabase
      .from('builder_organisation_memberships')
      .select('id').eq('builder_user_id', builderUserId).is('revoked_at', null).limit(1);
    if (!Array.isArray(memberships) || !memberships.length) {
      return json({
        error: 'Grant this user an organisation membership before inviting them.',
        code: 'no_membership',
      }, 409);
    }

    const inviteToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const inviteTokenHash = await hashSessionToken(inviteToken);
    if (!inviteTokenHash) {
      console.error('[builder-portal-invite] hashing unavailable — refusing to store an unpeppered invite token');
      return json({ error: 'Invite service unavailable' }, 503);
    }
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 3_600_000);

    const { error: updateError } = await supabase.from('builder_portal_users').update({
      invite_token_hash: inviteTokenHash,
      invite_token_expires_at: expiresAt.toISOString(),
      invited_by: adminUserId,
      invited_at: new Date().toISOString(),
      status: 'invited',
      is_active: false,
      updated_by: adminUserId,
    }).eq('id', builderUserId);
    if (updateError) throw updateError;

    await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: builderUserId });

    const brand = await getBrandConfig();
    const appUrl = Deno.env.get('APP_BASE_URL') || 'https://command-centre.npcservices.com.au';
    const inviteUrl = `${appUrl}/builder/accept-invite?token=${encodeURIComponent(inviteToken)}`;

    let emailSent = false;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (resendApiKey) {
      try {
        const response = await meteredFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
          body: JSON.stringify({
            from: brand.fromHeaderAdmin,
            to: [portalUser.email],
            subject: `You have been invited to the ${brand.companyName} Builder / Developer Portal`,
            text: `Hi ${String(portalUser.name || 'there').replace(/[<>]/g, '')},\n\n`
              + `You have been invited to the ${brand.companyName} Builder / Developer Portal.\n\n`
              + `Set your password here: ${inviteUrl}\n\n`
              + `This link expires in ${INVITE_EXPIRY_HOURS} hours.`,
            tags: [{ name: 'category', value: 'builder_portal_invite' }],
          }),
        });
        emailSent = response.ok;
      } catch (error) {
        console.error('[builder-portal-invite] email send failed', error);
      }
    } else {
      console.warn('[builder-portal-invite] RESEND_API_KEY unset — invite email was not sent');
    }

    await logInviteActivity(supabase, req, {
      adminUserId, actorType,
      action: action === 'resend' ? 'builder_invite_resent' : 'builder_invite_sent',
      builderUserId, metadata: { email_sent: emailSent, expires_at: expiresAt.toISOString() },
    });

    return json({
      success: true,
      email_sent: emailSent,
      expires_at: expiresAt.toISOString(),
      // Returned so an administrator can pass the link on when mail delivery is
      // not configured. It is not stored anywhere in plaintext.
      invite_url: emailSent ? undefined : inviteUrl,
    });
  } catch (error) {
    console.error('[builder-portal-invite]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});

async function logInviteActivity(
  supabase: any,
  req: Request,
  entry: {
    adminUserId: string | null;
    actorType: string;
    action: string;
    builderUserId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.rpc('builder_log_activity', {
    _actor_user_id: entry.adminUserId,
    _actor_type: entry.actorType,
    _action: entry.action,
    _entity_type: 'portal_user',
    _entity_id: entry.builderUserId,
    _organisation_id: null,
    _builder_user_id: entry.builderUserId,
    _previous_state: null,
    _new_state: null,
    _reason: null,
    _metadata: entry.metadata ?? {},
    _ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    _user_agent: req.headers.get('user-agent') || null,
  });
  if (error) console.error('[builder-portal-invite] activity log failed', error.message);
}
