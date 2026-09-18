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
import { INVITE_EXPIRY_HOURS, inviteUrlFor, mintBuilderInvite } from '../_shared/builderInvite.ts';
import { meteredFetch } from '../_shared/meteredFetch.ts';
import { getPortalClientIp } from '../_shared/requestSecurity.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';


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
        // The audit trail of who invited whom must not be fillable with
        // addresses of the caller's choosing: `X-Forwarded-For` is appended
        // to by the client. Only an address the platform vouched for is
        // recorded; an unvouched one is recorded honestly as nothing.
        _ip_address: getPortalClientIp(req.headers),
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
      const minted = await mintBuilderInvite();
      if (!minted) {
        console.error('[builder-portal-invite] hashing unavailable — refusing to store an unpeppered invite token');
        return json({ error: 'Invite service unavailable' }, 503);
      }
      const { token: inviteToken, tokenHash: inviteTokenHash, expiresAt } = minted;

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
      const inviteUrl = inviteUrlFor(inviteToken);
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

      /*
       * THE MEMBERSHIP GOES WITH THE INVITATION.
       *
       * `invite` grants the membership BEFORE it issues the token, so clearing
       * the token alone left the invitee a member of this organisation holding
       * the role it chose. That is not a dead end for them: accepting a
       * DIFFERENT organisation's invitation later activates the same account,
       * and this organisation is then sitting in their switcher — revoked in
       * name only.
       *
       * ONLY FOR AN ACCOUNT THAT HAS NOT ACCEPTED, tested exactly as `resend`
       * tests it. An already-active account was never invited into this seat:
       * `invite` grants a live user their membership outright and issues no
       * token at all, so revoking an INVITATION here must not silently remove a
       * working colleague. Removing a member is a different act and belongs to
       * a surface that says so.
       *
       * The representation is the one `builder_admin_revoke_membership` writes
       * and `builder_memberships_revocation_stamp` requires — status, stamp and
       * reason together — scoped to the ACTIVE organisation and this user, so
       * no membership of theirs anywhere else is touched.
       */
      if (!target.invite_accepted_at && !target.password_hash) {
        const { error: membershipError } = await supabase
          .from('builder_organisation_memberships')
          .update({
            status: 'revoked',
            revoked_at: new Date().toISOString(),
            revoked_reason: 'invitation revoked',
          })
          .eq('builder_user_id', target.id)
          .eq('organisation_id', activeOrganisationId)
          .is('revoked_at', null);
        if (membershipError) throw membershipError;
      }

      await logInviteActivity('builder_invite_revoked', target.id);
      return json(GENERIC_OK);
    }

    // ======================================================================
    // Join requests — the deciding half of registration's never-auto-join
    // rule (extraction plan §5). Registration writes the pending row; the
    // organisation's OWN owners and administrators decide it here, behind
    // the same session + governance + role gate as every other act in this
    // function. Mission Control sees the queue (builder-network-admin
    // list_join_requests) and deliberately cannot decide it.
    // ======================================================================

    // ----------------------------------------------------- list_join_requests
    if (action === 'list_join_requests') {
      // The ACTIVE organisation's queue and nobody else's: the filter is the
      // server-resolved organisation id, never one the browser named.
      const { data: requests, error } = await supabase
        .from('builder_org_join_requests')
        .select('id, builder_user_id, status, message, created_at, decided_by, decided_at')
        .eq('organisation_id', activeOrganisationId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (error) {
        console.error('[builder-portal-invite] join request list failed', error.message);
        return json({ error: 'Join requests could not be read' }, 500);
      }

      // The requester's own name and email are what the owner is deciding
      // on — they were volunteered TO this organisation by the request.
      const userIds = [...new Set((requests ?? []).map((r: any) => r.builder_user_id))];
      const { data: users } = userIds.length
        ? await supabase.from('builder_portal_users')
          .select('id, name, email, email_verified_at').in('id', userIds)
        : { data: [] };
      const userById = new Map((users ?? []).map((u: any) => [u.id, u]));

      return json({
        success: true,
        join_requests: (requests ?? []).map((r: any) => {
          const requester = userById.get(r.builder_user_id) as
            | { name: string; email: string; email_verified_at: string | null }
            | undefined;
          return {
            id: r.id,
            status: r.status,
            message: r.message,
            created_at: r.created_at,
            requester: requester
              ? {
                name: requester.name,
                email: requester.email,
                email_verified: !!requester.email_verified_at,
              }
              : null,
          };
        }),
      });
    }

    // ------------------------------- approve_join_request / decline_join_request
    if (action === 'approve_join_request' || action === 'decline_join_request') {
      const requestId = String(body.request_id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        return json({ error: 'request_id is required' }, 400);
      }
      const approve = action === 'approve_join_request';

      // One transactional command: decision stamp, membership grant and the
      // activity entry commit together. The database re-verifies the
      // decider's own owner/administrator membership of THIS organisation —
      // the browser supplied only the request id.
      const { data, error } = await supabase.rpc('builder_decide_org_join_request', {
        _request_id: requestId,
        _organisation_id: activeOrganisationId,
        _decided_by: caller.id,
        _approve: approve,
      });
      if (error) {
        const message = String(error.message);
        if (message.includes('BUILDER_JOIN_REQUEST_NOT_FOUND')) {
          return json({ error: 'No such join request for this organisation' }, 404);
        }
        if (message.includes('BUILDER_JOIN_REQUEST_ALREADY_DECIDED')) {
          return json({ error: 'This request has already been decided.', code: 'already_decided' }, 409);
        }
        if (message.includes('BUILDER_JOIN_REQUEST_USER_REVOKED')) {
          return json({ error: 'This account has been revoked and cannot be approved.' }, 409);
        }
        if (message.includes('BUILDER_NOT_ORG_ADMIN')) {
          return json({ error: 'Only an organisation owner or administrator may decide join requests' }, 403);
        }
        throw error;
      }
      const decided = Array.isArray(data) ? data[0] : data;

      // The registrant was promised "you'll be notified when they do". The
      // notice goes to the mailbox; the response to the decider says only
      // what they did.
      const { data: requestRow } = await supabase
        .from('builder_org_join_requests')
        .select('builder_user_id')
        .eq('id', requestId)
        .maybeSingle();
      const { data: requester } = requestRow
        ? await supabase.from('builder_portal_users')
          .select('email, name').eq('id', requestRow.builder_user_id).maybeSingle()
        : { data: null };
      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      if (requester?.email && resendApiKey) {
        const brand = await getBrandConfig();
        const appUrl = Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au';
        const organisationName = session.active_organisation?.legal_name || brand.companyName;
        try {
          await meteredFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
            body: JSON.stringify({
              from: brand.fromHeaderAdmin,
              to: [requester.email],
              subject: approve
                ? `You have joined ${organisationName} on the ${brand.companyName} Builder Portal`
                : `Your request to join ${organisationName}`,
              text: approve
                ? `Hi ${String(requester.name || 'there').replace(/[<>]/g, '')},\n\nYour request to join ${organisationName} was approved. Sign in to continue:\n\n${appUrl}/builder/login`
                : `Hi ${String(requester.name || 'there').replace(/[<>]/g, '')},\n\nYour request to join ${organisationName} was not approved. If you believe this is a mistake, contact the organisation directly.`,
              tags: [{ name: 'category', value: 'builder_org_join_request' }],
            }),
          });
        } catch (mailError) {
          console.error('[builder-portal-invite] decision notice failed', mailError);
        }
      }

      return json({
        success: true,
        request_id: decided?.request_id ?? requestId,
        status: decided?.request_status ?? (approve ? 'approved' : 'declined'),
        membership_created: decided?.membership_created === true,
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error('[builder-portal-invite]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
