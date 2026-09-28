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
 *    response is the same generic success, because "that email already
 *    exists on the network" is an oracle over other organisations' staff.
 *  * Every invitation WAITS for the invitee to accept it, an account that
 *    already signs in included (doc 68). It used to be granted live at
 *    once, which put people into organisations they had not agreed to join
 *    and was the last way an administrator could tell an address had an
 *    account. The invitation lives on this organisation's own seat, is
 *    answered after a fixed floor, and is emailed after the answer, paced.
 *  * The `owner` role is NOT mintable here. Granting ownership is a
 *    transfer of control, not an invitation, and it gets its own surface
 *    with its own ceremony later.
 *  * Every read and write is scoped to the caller's active organisation
 *    BEFORE the database is asked anything else.
 *
 * Actions: invite | resend | revoke_invite | list_members | manage_member
 *
 * MEMBER MANAGEMENT (20260927100000). `list_members` reads the active
 * organisation's live memberships (members and pending invitations apart);
 * `manage_member` changes a role, suspends, reactivates or removes one. Both
 * sit behind the same owner/administrator gate as invitations, and every act
 * is re-decided by `builder_org_manage_membership` in the database: owners
 * only by owners, never oneself, never the last active owner, never `owner`.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import {
  builderAppBaseUrl,
  INVITE_EXPIRY_HOURS,
  mintBuilderInvite,
  type MintedInvite,
} from '../_shared/builderInvite.ts';
import { builderEmailConfigured, sendBuilderEmail } from '../_shared/builderInviteEmail.ts';
import { afterAnswer, holdAnswer, readDeliveryHealth, sendPacedBuilderEmail } from '../_shared/builderEmailDelivery.ts';
import { invitationEmail } from '../_shared/builderInvitationCopy.pure.ts';
import { getPortalClientIp } from '../_shared/requestSecurity.ts';
import { authRateLimitedResponse, enforceSessionRateLimit } from '../_shared/authRateLimit.ts';
import { INVITE_SEND_BUDGETS, INVITE_SEND_SCOPE } from '../_shared/sessionRateLimit.pure.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';
import { MEMBER_ACTIONS, memberRefusal, shapeMembers } from '../_shared/builderMemberManagement.pure.ts';
import {
  invitationRequiresPassword,
  inviterMayHoldInvitationLink,
  PENDING_MEMBERSHIP_STATUS,
  readInviteeName,
  tenantInviteResponse,
} from '../_shared/builderInviteScope.pure.ts';


/** Roles an owner or administrator may hand out. Never 'owner' — see header. */
const INVITABLE_ROLES = new Set(['administrator', 'manager', 'member', 'read_only']);

const GENERIC_OK = { success: true as const };

Deno.serve(async (req) => {
  const receivedAt = Date.now();
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  /*
   * EVERY `invite` AND `resend` ANSWER TAKES THE SAME TIME (doc 68).
   *
   * Only some kinds of address used to send an email before answering, so the
   * time an answer took told an administrator what kind of address it was — a
   * revoked account answered ~450 ms sooner than the rest (doc 67 §5). Every
   * email now leaves after the answer, and every answer waits for this floor.
   */
  const answer = async (response: Response) => {
    await holdAnswer(receivedAt);
    return response;
  };

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  // A fault in `invite` or `resend` is held to the same floor as their answers.
  let heldToFloor = false;
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === 'string' ? body.action : 'invite';
    heldToFloor = action === 'invite' || action === 'resend';

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

    /*
     * A CEILING ON WHAT AN ADMINISTRATOR CAN SEND.
     *
     * `invite` and `resend` each mint a token and send an email through the
     * mail provider every tenant shares, and nothing bounded them. Counted per
     * person and per organisation, on ids the validated session supplied —
     * never the source address, which behind the portal's proxy can be one
     * address for everybody. After the role gate, so a member cannot spend the
     * organisation's allowance on requests that were going to be refused; and
     * before anything is looked up, written, minted or sent, so a refused
     * request leaves no trace and the refusal cannot vary with the address.
     */
    if (action === 'invite' || action === 'resend') {
      const ceiling = await enforceSessionRateLimit(supabase, {
        scope: INVITE_SEND_SCOPE,
        userId: caller.id,
        organisationId: activeOrganisationId,
        budgets: INVITE_SEND_BUDGETS,
      });
      if (!ceiling.allowed) {
        console.warn('[builder-portal-invite] invitation ceiling reached',
          { refused_by: ceiling.refusedBy, degraded: ceiling.degraded });
        return authRateLimitedResponse(corsHeaders, ceiling.retryAfterSeconds,
          'Too many invitations have been sent recently. Please try again later.');
      }
    }

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

    /**
     * A target is in reach only through a live seat in THIS organisation, and
     * since doc 68 it is the SEAT that decides what an invitation act does —
     * whether it still waits, and the name this organisation typed for it —
     * never what the account behind it has done anywhere else.
     */
    const loadScopedSeat = async (builderUserId: string) => {
      if (!builderUserId) return null;
      const { data: seat, error: seatError } = await supabase
        .from('builder_organisation_memberships')
        .select('id, builder_user_id, status, invited_name')
        .eq('builder_user_id', builderUserId)
        .eq('organisation_id', activeOrganisationId)
        .is('revoked_at', null)
        .maybeSingle();
      if (seatError) throw seatError;
      if (!seat) return null;
      const { data: user, error: userError } = await supabase
        .from('builder_portal_users')
        .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
        .eq('id', builderUserId)
        .maybeSingle();
      if (userError) throw userError;
      return user ? { seat, user } : null;
    };

    /** By the same lower(btrim(email)) identity the unique index holds. */
    const findAccountByEmail = async (email: string) => {
      const { data, error } = await supabase
        .from('builder_portal_users')
        .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    };

    /**
     * RE-MINT THIS ORGANISATION'S OWN INVITATION, AND NOTHING ELSE (doc 68).
     *
     * The token lives on this organisation's seat, so a re-send replaces this
     * organisation's link and can never reach another organisation's — which
     * the account's single token slot could not promise. Only while the seat
     * still waits: one the invitee has accepted, or an administrator has
     * suspended or cancelled since, is not re-invited behind their back.
     */
    const reissueSeatInvitation = async (seatId: string, minted: MintedInvite) => {
      const { data, error } = await supabase
        .from('builder_organisation_memberships')
        .update({
          invite_token_hash: minted.tokenHash,
          invite_token_expires_at: minted.expiresAt.toISOString(),
        })
        .eq('id', seatId)
        .eq('organisation_id', activeOrganisationId)
        .eq('status', PENDING_MEMBERSHIP_STATUS)
        .is('revoked_at', null)
        .select('id');
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    };

    /**
     * The act, logged when it happens. Whether its email left is logged when
     * THAT happens, after the answer, by `deliverInvitation` (doc 68).
     */
    const recordInvitation = (targetId: string, resent: boolean, minted: MintedInvite, requiresPassword: boolean) =>
      logInviteActivity(resent ? 'builder_invite_resent' : 'builder_invite_sent', targetId, {
        expires_at: minted.expiresAt.toISOString(),
        requires_password: requiresPassword,
      });

    /**
     * SEND THE INVITATION — AFTER THE ANSWER, AND IN ITS TURN (doc 68).
     *
     * Sent after answering, so how long the answer took cannot say what kind of
     * address this was; sent through the deployment's pacer, so a burst cannot
     * run the shared mail provider past its per-second ceiling. The copy
     * depends on whether the account sets a password, and the greeting is the
     * name this organisation typed. Whether the email left goes to the activity
     * log, which only an operator reads — the inviter is never told, because an
     * answer that varies with the address is an oracle (doc 67).
     */
    const deliverInvitation = async (invitation: {
      readonly targetId: string;
      readonly email: string;
      readonly inviteeName: string | null;
      readonly requiresPassword: boolean;
      readonly url: string;
      readonly resent: boolean;
    }) => {
      const brand = await getBrandConfig();
      const mail = invitationEmail({
        organisationName: session.active_organisation?.legal_name || brand.companyName,
        companyName: brand.companyName,
        inviterName: caller.name,
        inviteeName: invitation.inviteeName,
        url: invitation.url,
        requiresPassword: invitation.requiresPassword,
        expiryHours: INVITE_EXPIRY_HOURS,
      });
      const outcome = await sendPacedBuilderEmail(supabase, {
        to: invitation.email,
        subject: mail.subject,
        brand,
        category: 'builder_portal_invite',
        content: mail.content,
      });
      // Narrowed on `outcome` itself: `reason` exists only on the unsent arm of
      // the union, and a derived string cannot carry that discrimination back.
      let delivered = 'sent';
      if (!outcome.sent) {
        delivered = outcome.reason;
        console.warn('[builder-portal-invite] the invitation email did not leave; the invitation still waits', {
          reason: outcome.reason,
          builder_user_id: invitation.targetId,
        });
      }
      await logInviteActivity('builder_invite_delivery', invitation.targetId, {
        email_sent: outcome.sent,
        outcome: delivered,
        resent: invitation.resent,
      });
    };

    // -------------------------------------------------------- delivery_health
    /*
     * ONE READING FOR THE WHOLE DEPLOYMENT (doc 68).
     *
     * An administrator whose invitation never arrives had no way to know
     * whether mail was working at all — the per-invitation answer that used to
     * hint at it varied with the address, which was the leak. This answers
     * from a check sent to a sink that belongs to nobody and from the length
     * of the send queue, and reads no invitation, address or message to do it.
     */
    if (action === 'delivery_health') {
      const delivery = await readDeliveryHealth(supabase, getBrandConfig);
      return json({ success: true, delivery });
    }

    // ---------------------------------------------------------------- invite
    if (action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return await answer(json({ error: 'A valid email address is required' }, 400));
      }
      const invitee = readInviteeName(body.name);
      if (!invitee.ok) return await answer(json({ error: invitee.error }, 400));
      const role = String(body.membership_role || 'member');
      if (!INVITABLE_ROLES.has(role)) {
        return await answer(json({ error: 'Choose a role: administrator, manager, member or read_only' }, 400));
      }

      // Find or create. The RESPONSE never says which happened.
      let target = await findAccountByEmail(email);
      if (!target) {
        const { data: created, error: createError } = await supabase
          .from('builder_portal_users')
          .insert({
            email, name: invitee.name, status: 'invited', is_active: false, created_by: null,
            invited_by: caller.id, invited_at: new Date().toISOString(),
          })
          .select('id, email, name, status, revoked_at, invite_accepted_at, password_hash')
          .single();
        if (createError && String(createError.code) !== '23505') throw createError;
        // 23505 is two invitations of one new address racing: the other one
        // created the account, and this invitation is for it too.
        target = created ?? await findAccountByEmail(email);
      }
      if (!target || target.revoked_at || target.status === 'revoked') {
        /*
         * A revoked account is an operator decision this surface may not undo,
         * and the database refuses any live seat for one
         * (`builder_guard_membership`), so nothing is created. The answer is
         * the one every address gets. The members list is where this still
         * differs (doc 68 §6): a seat that cannot exist cannot be listed.
         */
        return await answer(json(tenantInviteResponse({ inviteUrl: null })));
      }

      const requiresPassword = invitationRequiresPassword(target);
      const minted = await mintBuilderInvite();
      if (!minted) {
        console.error('[builder-portal-invite] hashing unavailable — refusing to store an unpeppered invite token');
        return await answer(json({ error: 'Invite service unavailable' }, 503));
      }

      /*
       * THE SEAT WAITS, AND CARRIES ITS OWN INVITATION (doc 68).
       *
       * Every organisation invitation waits for its invitee, an account that
       * already signs in included: nobody joins an organisation they have not
       * agreed to join, and the members list files every invitation alike. The
       * token is on this seat, never in the account's single slot, so no other
       * organisation's invitation can be replaced by this one, and this door
       * writes nothing to an account that already exists — there is no status
       * of theirs to deactivate or downgrade if it changes meanwhile.
       */
      let inviteeName = invitee.name;
      const { error: membershipError } = await supabase
        .from('builder_organisation_memberships')
        .insert({
          builder_user_id: target.id,
          organisation_id: activeOrganisationId,
          membership_role: role,
          is_primary: false,
          status: PENDING_MEMBERSHIP_STATUS,
          granted_by: caller.id,
          invited_name: invitee.name,
          invite_token_hash: minted.tokenHash,
          invite_token_expires_at: minted.expiresAt.toISOString(),
        });
      if (membershipError && String(membershipError.code) === '23505') {
        /*
         * THIS ORGANISATION ALREADY HOLDS A LIVE SEAT FOR THEM, AND THE SEAT DECIDES.
         *
         * Read from this organisation's own row, which its administrators
         * already see on the members list — never from the account behind it,
         * which is what made a repeat an oracle (doc 67 §2).
         *
         *  * `suspended` — an administrator's decision an invitation may not
         *    undo, so it is refused.
         *  * `active` — a working member here already: nothing to grant and
         *    nothing to send, answered as every invitation is.
         *  * `invited` — the invitation still owed: this organisation's own
         *    token is re-minted and sent again.
         */
        const { data: seat, error: seatError } = await supabase
          .from('builder_organisation_memberships')
          .select('id, status, invited_name')
          .eq('builder_user_id', target.id)
          .eq('organisation_id', activeOrganisationId)
          .is('revoked_at', null)
          .maybeSingle();
        if (seatError) throw seatError;
        if (!seat) throw new Error('the seat that refused the grant is no longer live');
        if (seat.status === 'suspended') {
          return await answer(json({
            error: 'That person already has a membership here that is not waiting on an invitation. '
              + 'Reactivate them on the members list instead.',
            code: 'membership_not_promotable',
          }, 409));
        }
        if (seat.status === 'active') {
          return await answer(json(tenantInviteResponse({ inviteUrl: null })));
        }
        const reissued = await reissueSeatInvitation(seat.id, minted);
        if (!reissued) {
          /*
           * NOTHING WAS WAITING BY THE TIME THE RE-MINT RAN: the invitee
           * accepted in between, or a concurrent repeat or an administrator
           * changed the seat. The seat decides here too — `active` is a member,
           * answered as everyone is; anything else is refused as above.
           */
          const { data: seatNow, error: seatNowError } = await supabase
            .from('builder_organisation_memberships')
            .select('status')
            .eq('builder_user_id', target.id)
            .eq('organisation_id', activeOrganisationId)
            .is('revoked_at', null)
            .maybeSingle();
          if (seatNowError) throw seatNowError;
          if (seatNow?.status === 'active') return await answer(json(tenantInviteResponse({ inviteUrl: null })));
          return await answer(json({
            error: 'That person already has a membership here that is not waiting on an invitation. '
              + 'Reactivate them on the members list instead.',
            code: 'membership_not_promotable',
          }, 409));
        }
        inviteeName = seat.invited_name ?? invitee.name;
      } else if (membershipError) {
        throw membershipError;
      }

      // A first invitation's account needs its onboarding steps when it
      // activates. An account that signs in already has its own, and adding
      // steps behind its back could park it at a gate it had already passed.
      if (requiresPassword) await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: target.id });
      await recordInvitation(target.id, false, minted, requiresPassword);

      const providerConfigured = builderEmailConfigured();
      if (providerConfigured) {
        afterAnswer(deliverInvitation({
          targetId: target.id, email: target.email, inviteeName, requiresPassword, url: minted.url, resent: false,
        }), 'invitation email');
      }
      const handedLink = inviterMayHoldInvitationLink({
        send: providerConfigured ? 'sent' : 'not_configured',
        requiresPassword,
      }) ? minted.url : null;
      return await answer(json(tenantInviteResponse({ inviteUrl: handedLink })));
    }

    // ---------------------------------------------------------------- resend
    if (action === 'resend') {
      const scoped = await loadScopedSeat(String(body.builder_user_id || ''));
      if (!scoped) return await answer(json({ error: 'No such member of this organisation' }, 404));
      const { seat, user: target } = scoped;
      if (target.revoked_at || target.status === 'revoked') {
        return await answer(json({ error: 'This user has been revoked.' }, 409));
      }
      if (seat.status !== PENDING_MEMBERSHIP_STATUS) {
        /*
         * NOTHING IS OWED: THE SEAT IS NOT WAITING. A member here has nothing
         * to accept, and a suspended seat is an administrator's decision. It
         * is answered as a re-sent invitation is, and nothing is sent — the
         * seat decides, never whether the account signs in elsewhere, which
         * made `invite` then `resend` an oracle (doc 67 §2).
         */
        return await answer(json(tenantInviteResponse({ inviteUrl: null })));
      }
      const requiresPassword = invitationRequiresPassword(target);
      const minted = await mintBuilderInvite();
      if (!minted) {
        console.error('[builder-portal-invite] hashing unavailable — refusing to store an unpeppered invite token');
        return await answer(json({ error: 'Invite service unavailable' }, 503));
      }
      const reissued = await reissueSeatInvitation(seat.id, minted);
      if (!reissued) return await answer(json(tenantInviteResponse({ inviteUrl: null })));
      await recordInvitation(target.id, true, minted, requiresPassword);

      const providerConfigured = builderEmailConfigured();
      if (providerConfigured) {
        afterAnswer(deliverInvitation({
          targetId: target.id,
          email: target.email,
          inviteeName: seat.invited_name ?? target.name,
          requiresPassword,
          url: minted.url,
          resent: true,
        }), 'invitation email');
      }
      const handedLink = inviterMayHoldInvitationLink({
        send: providerConfigured ? 'sent' : 'not_configured',
        requiresPassword,
      }) ? minted.url : null;
      return await answer(json(tenantInviteResponse({ inviteUrl: handedLink })));
    }

    // ---------------------------------------------------------- revoke_invite
    if (action === 'revoke_invite') {
      const scoped = await loadScopedSeat(String(body.builder_user_id || ''));
      if (!scoped) return json({ error: 'No such member of this organisation' }, 404);
      const { seat, user: target } = scoped;
      /*
       * ONLY THIS ORGANISATION'S OWN TOKEN IS DESTROYED. An invitation issued
       * before doc 68 may still be in the account's single slot; it is cleared
       * only where this organisation minted it, so cancelling can never stop
       * another organisation's link. Invitations since then live on the seat
       * and go with it below.
       */
      const { error } = await supabase.from('builder_portal_users').update({
        invite_token_hash: null,
        invite_token_expires_at: null,
        invite_token_organisation_id: null,
      }).eq('id', target.id).eq('invite_token_organisation_id', activeOrganisationId);
      if (error) throw error;

      /*
       * THE SEAT GOES WITH THE INVITATION — WHENEVER IT IS STILL WAITING.
       *
       * It used to go only for an account that had never signed in, because an
       * established account's grant was live at once; the same button then
       * cancelled one kind of invitation and left the other standing. Since
       * doc 68 every invitation is a waiting seat, and a waiting seat is
       * cancelled whoever it is for. A seat that is active is a working
       * colleague, and removing one is `manage_member`'s act, not this one.
       * The representation is the one `builder_admin_revoke_membership`
       * writes, and the trigger destroys the seat's token with it.
       */
      if (seat.status === PENDING_MEMBERSHIP_STATUS) {
        const { error: membershipError } = await supabase
          .from('builder_organisation_memberships')
          .update({
            status: 'revoked',
            revoked_at: new Date().toISOString(),
            revoked_reason: 'invitation revoked',
          })
          .eq('id', seat.id)
          .eq('status', PENDING_MEMBERSHIP_STATUS)
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
      if (requester?.email) {
        const brand = await getBrandConfig();
        const organisationName = session.active_organisation?.legal_name || brand.companyName;
        // Third and last send in this file, on the same letterhead. Its own
        // copy of the base URL went with it — `builderAppBaseUrl()` already
        // reads `APP_BASE_URL` behind the same default, and two readings of
        // one setting is how a link comes to point somewhere nobody hosts.
        await sendBuilderEmail({
          to: requester.email,
          subject: approve
            ? `You have joined ${organisationName} on the ${brand.companyName} Builder Portal`
            : `Your request to join ${organisationName}`,
          brand,
          category: 'builder_org_join_request',
          content: approve
            ? {
              heading: `You have joined ${organisationName}`,
              paragraphs: [
                `Hi ${String(requester.name || 'there')},`,
                `Your request to join ${organisationName} was approved.`,
              ],
              action: { label: 'Sign in to continue', url: `${builderAppBaseUrl()}/builder/login` },
            }
            : {
              heading: `Your request to join ${organisationName}`,
              paragraphs: [
                `Hi ${String(requester.name || 'there')},`,
                `Your request to join ${organisationName} was not approved.`,
                'If you believe this is a mistake, contact the organisation directly.',
              ],
            },
        });
      }

      return json({
        success: true,
        request_id: decided?.request_id ?? requestId,
        status: decided?.request_status ?? (approve ? 'approved' : 'declined'),
        membership_created: decided?.membership_created === true,
      });
    }

    // ───────────────────────── MEMBERS ─────────────────────────
    if (action === 'list_members') {
      const { data: memberships, error: membershipsError } = await supabase
        .from('builder_organisation_memberships')
        .select('id, builder_user_id, membership_role, status, invited_name')
        .eq('organisation_id', activeOrganisationId)
        .is('revoked_at', null)
        .limit(500);
      if (membershipsError) throw membershipsError;
      const ids = (memberships || []).map((m: any) => m.builder_user_id);
      const { data: users, error: usersError } = ids.length
        ? await supabase.from('builder_portal_users').select('id, name, email, status').in('id', ids)
        : { data: [], error: null };
      if (usersError) throw usersError;
      return json({
        success: true,
        ...shapeMembers(memberships || [], users || [], { callerId: caller.id, callerRole: membershipRole }),
      });
    }

    if (action === 'manage_member') {
      const membershipId = typeof body.membership_id === 'string' ? body.membership_id : '';
      const memberAction = typeof body.member_action === 'string' ? body.member_action : '';
      if (!membershipId) return json({ error: 'membership_id is required' }, 400);
      if (!(MEMBER_ACTIONS as readonly string[]).includes(memberAction)) {
        return json({ error: 'That action is not recognised' }, 400);
      }
      const { data, error } = await supabase.rpc('builder_org_manage_membership', {
        _actor_builder_user_id: caller.id,
        _organisation_id: activeOrganisationId,
        _membership_id: membershipId,
        _action: memberAction,
        _role: typeof body.role === 'string' ? body.role : null,
        _reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
      });
      if (error) {
        const refusal = memberRefusal(String(error.message || ''));
        if (refusal) return json({ error: refusal.error, code: refusal.code }, refusal.status);
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        success: true,
        member: { membership_id: row?.id ?? membershipId, role: row?.membership_role ?? null, status: row?.status ?? null },
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error('[builder-portal-invite]', error);
    const failure = json({ error: 'Internal server error' }, 500);
    return heldToFloor ? await answer(failure) : failure;
  }
});
