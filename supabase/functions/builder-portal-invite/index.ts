/**
 * Builder / Developer Portal — team invitations (NETWORK EDITION).
 *
 * THE ADMIN-PLANE LIFT (extraction plan §5). The prime's edition is a
 * Command Centre function: staff JWT, `builder_portal_admin` module
 * permission, agency invites builder. The network has no Command Centre and
 * an agency no longer administers a builder's organisation — so the door
 * moves INTO the portal, re-gated on the organisation's own owners: a
 * caller with an active portal session whose membership in the ACTIVE
 * organisation is owner or administrator may invite, re-invite and revoke
 * invitations for THAT organisation and no other.
 *
 * `verify_jwt` flips to false in the SAME change (config.toml's block
 * carried the promise: flipping it alone would have opened a staff door
 * with no staff check behind it — this commit replaces the staff check).
 *
 * What carries from the prime unchanged: the token is stored as a HASH
 * (the plaintext exists only in the email and the returned link), CSRF on
 * every act, and the activity log.
 *
 * What changes with the lift:
 *  * Invitation is BY EMAIL. The Command Centre invited a pre-created row;
 *    an organisation owner names a colleague. An address that already
 *    holds an account is not an error and not an announcement — the
 *    membership is granted and the response is the same generic success,
 *    because "that email already exists on the network" is an oracle over
 *    other organisations' staff.
 *  * The `owner` role is NOT mintable here. Granting ownership is a
 *    transfer of control, not an invitation, and it gets its own surface
 *    with its own ceremony later.
 *  * Every read and write is scoped to the caller's active organisation
 *    BEFORE the database is asked anything else.
 *
 * Actions: invite | resend | revoke_invite
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { meteredFetch } from '../_shared/meteredFetch.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';

const INVITE_EXPIRY_HOURS = 72;

/** Roles an owner or administrator may hand out. Never 'owner' — see header. */
const INVITABLE_ROLES = new Set(['administrator', 'manager', 'member', 'read_only']);

const GENERIC_OK = { success: true as const };

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === 'string' ? body.action : 'invite';

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error || 'Unauthorised', code: session.code }, session.status || 401);
    }
    const governanceError = builderGovernanceError(session);
    if (governanceError) return json({ error: 'Portal setup required', code: governanceError }, 403);

    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }
    const membershipRole = session.organisations
      ?.find((o) => o.organisation_id === activeOrganisationId)?.membership_role ?? null;
    if (membershipRole !== 'owner' && membershipRole !== 'administrator') {
      return json({ error: 'Only an organisation owner or administrator may manage invitations' }, 403);
    }
    const caller = session.user;

    const logInviteActivity = async (
      logAction: string,
      builderUserId: string,
      metadata: Record<string, unknown> = {},
    ) => {
      const { error } = await supabase.rpc('builder_log_activity', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _action: logAction,
        _entity_type: 'portal_user',
        _entity_id: builderUserId,
        _organisation_id: activeOrganisationId,
        _builder_user_id: caller.id,
        _previous_state: null,
        _new_state: null,
        _reason: null,
        _metadata: { target_builder_user_id: builderUserId, ...metadata },
        _ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
        _user_agent: req.headers.get('user-agent') || null,
      });
      if (error) console.error('[builder-portal-invite] activity log failed', error.message);
    };

    /** A target is in reach only through a live membership of THIS org. */
    const loadScopedUser = async (builderUserId: string) => {
      if (!builderUserId) return null;
      const { data: membership } = await supabase
        .from('builder_organisation_memberships')
        .select('id, builder_user_id')
        .eq('builder_user_id', builderUserId)
        .eq('organisation_id', activeOrganisationId)
        .is('revoked_at', null)
        .maybeSingle();
      if (!membership) return null;
      const { data: user } = await supabase
        .from('builder_portal_users')
        .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
        .eq('id', builderUserId)
        .maybeSingle();
      return user ?? null;
    };

    const issueInvite = async (target: { id: string; email: string; name: string | null }, resent: boolean) => {
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
        invited_by: caller.id,
        invited_at: new Date().toISOString(),
        status: 'invited',
        is_active: false,
      }).eq('id', target.id);
      if (updateError) throw updateError;

      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: target.id });

      const brand = await getBrandConfig();
      const appUrl = Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au';
      const inviteUrl = `${appUrl}/builder/accept-invite?token=${encodeURIComponent(inviteToken)}`;
      const organisationName = session.active_organisation?.legal_name || brand.companyName;

      let emailSent = false;
      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      if (resendApiKey) {
        try {
          const response = await meteredFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: brand.fromHeaderAdmin,
              to: [target.email],
              subject: `You have been invited to ${organisationName} on the ${brand.companyName} Builder Portal`,
              text: `Hi ${String(target.name || 'there').replace(/[<>]/g, '')},\n\n`
                + `${String(caller.name || 'A colleague').replace(/[<>]/g, '')} has invited you to join `
                + `${organisationName} on the ${brand.companyName} Builder / Developer Portal.\n\n`
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

      await logInviteActivity(
        resent ? 'builder_invite_resent' : 'builder_invite_sent',
        target.id,
        { email_sent: emailSent, expires_at: expiresAt.toISOString() },
      );

      return json({
        ...GENERIC_OK,
        email_sent: emailSent,
        expires_at: expiresAt.toISOString(),
        // Returned so the inviter can pass the link on when mail delivery is
        // not configured. It is not stored anywhere in plaintext.
        invite_url: emailSent ? undefined : inviteUrl,
      });
    };

    // ---------------------------------------------------------------- invite
    if (action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ error: 'A valid email address is required' }, 400);
      }
      const name = String(body.name || '').trim();
      if (!name) return json({ error: "The colleague's name is required" }, 400);
      const role = String(body.membership_role || 'member');
      if (!INVITABLE_ROLES.has(role)) {
        return json({ error: 'Choose a role: administrator, manager, member or read_only' }, 400);
      }

      // Find or create — by the same lower(btrim(email)) identity the unique
      // index holds. The RESPONSE never says which happened.
      const { data: existing } = await supabase
        .from('builder_portal_users')
        .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
        .eq('email', email)
        .maybeSingle();

      let target = existing ?? null;
      if (target && (target.revoked_at || target.status === 'revoked')) {
        // A revoked account is an operator decision this surface may not
        // undo — and saying so would confirm the account exists. Generic.
        return json({ ...GENERIC_OK, email_sent: false });
      }
      if (!target) {
        const { data: created, error: createError } = await supabase
          .from('builder_portal_users')
          .insert({ email, name, status: 'invited', is_active: false, created_by: null })
          .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
          .single();
        if (createError) {
          if (String(createError.code) === '23505') {
            // The case-variant race: the account exists. Same generic path.
            return json({ ...GENERIC_OK, email_sent: false });
          }
          throw createError;
        }
        target = created;
      }

      // Membership in the CALLER'S organisation, idempotent on the live key.
      const { error: membershipError } = await supabase
        .from('builder_organisation_memberships')
        .insert({
          builder_user_id: target.id,
          organisation_id: activeOrganisationId,
          membership_role: role,
          is_primary: false,
          status: 'active',
          granted_by: caller.id,
        });
      if (membershipError && String(membershipError.code) !== '23505') throw membershipError;

      if (target.invite_accepted_at || target.password_hash) {
        // Already active on the network: access granted, nothing to accept.
        // The notice goes to the MAILBOX, not the caller.
        const brand = await getBrandConfig();
        const resendApiKey = Deno.env.get('RESEND_API_KEY');
        const organisationName = session.active_organisation?.legal_name || brand.companyName;
        if (resendApiKey) {
          try {
            await meteredFetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
              body: JSON.stringify({
                from: brand.fromHeaderAdmin,
                to: [target.email],
                subject: `You now have access to ${organisationName} on the ${brand.companyName} Builder Portal`,
                text: `Hi ${String(target.name || 'there').replace(/[<>]/g, '')},\n\n`
                  + `${String(caller.name || 'A colleague').replace(/[<>]/g, '')} has added you to `
                  + `${organisationName}. It is available from the organisation switcher next time you sign in.`,
                tags: [{ name: 'category', value: 'builder_portal_invite' }],
              }),
            });
          } catch (error) {
            console.error('[builder-portal-invite] membership notice failed', error);
          }
        }
        await logInviteActivity('builder_membership_granted', target.id, { membership_role: role });
        return json({ ...GENERIC_OK, email_sent: !!resendApiKey });
      }

      return await issueInvite(target, false);
    }

    // ---------------------------------------------------------------- resend
    if (action === 'resend') {
      const target = await loadScopedUser(String(body.builder_user_id || ''));
      if (!target) return json({ error: 'No such member of this organisation' }, 404);
      if (target.revoked_at || target.status === 'revoked') {
        return json({ error: 'This user has been revoked.' }, 409);
      }
      if (target.invite_accepted_at || target.password_hash) {
        return json({
          error: 'This account is already active. Use the password reset flow instead.',
          code: 'already_active',
        }, 409);
      }
      return await issueInvite(target, true);
    }

    // ---------------------------------------------------------- revoke_invite
    if (action === 'revoke_invite') {
      const target = await loadScopedUser(String(body.builder_user_id || ''));
      if (!target) return json({ error: 'No such member of this organisation' }, 404);
      const { error } = await supabase.from('builder_portal_users').update({
        invite_token_hash: null, invite_token_expires_at: null,
      }).eq('id', target.id);
      if (error) throw error;
      await logInviteActivity('builder_invite_revoked', target.id);
      return json(GENERIC_OK);
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error('[builder-portal-invite]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
