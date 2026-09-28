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
  inviteUrlFor,
  mintBuilderInvite,
  promoteWaitingMembership,
} from '../_shared/builderInvite.ts';
import { sendBuilderEmail } from '../_shared/builderInviteEmail.ts';
import { getPortalClientIp } from '../_shared/requestSecurity.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';
import { MEMBER_ACTIONS, memberRefusal, shapeMembers } from '../_shared/builderMemberManagement.pure.ts';
import {
  type InviteSendState,
  mayHandLinkToInviter,
  membershipStatusForGrant,
} from '../_shared/builderInviteScope.pure.ts';


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
        // The token REMEMBERS the organisation it was minted for, so acceptance
        // activates that membership and no other. Without it, acceptance could
        // only infer a scope from the account's whole membership set, which is
        // the cross-organisation takeover `builderInviteScope.pure.ts` records.
        invite_token_organisation_id: activeOrganisationId,
        status: 'invited',
        is_active: false,
      }).eq('id', target.id);
      if (updateError) throw updateError;

      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: target.id });

      const brand = await getBrandConfig();
      const inviteUrl = inviteUrlFor(inviteToken);
      const organisationName = session.active_organisation?.legal_name || brand.companyName;

      // One send path, one letterhead. This was a paragraph of plain text
      // composed here; `builderInviteEmail.ts` draws it in the portal's own
      // colours and still sends a plain part beside the HTML. Escaping moved
      // there too, so the `[<>]` strip this used to do by hand is a property
      // of the renderer rather than of each call site.
      const outcome = await sendBuilderEmail({
        to: target.email,
        subject: `You have been invited to ${organisationName} on the ${brand.companyName} Builder Portal`,
        brand,
        category: 'builder_portal_invite',
        content: {
          heading: `You have been invited to ${organisationName}`,
          paragraphs: [
            `Hi ${String(target.name || 'there')},`,
            `${String(caller.name || 'A colleague')} has invited you to join ${organisationName} on the ${brand.companyName} Builder / Developer Portal.`,
          ],
          action: { label: 'Set your password', url: inviteUrl },
          footnote: `This link can be used once and expires in ${INVITE_EXPIRY_HOURS} hours.`,
        },
      });
      const emailSent = outcome.sent;

      await logInviteActivity(
        resent ? 'builder_invite_resent' : 'builder_invite_sent',
        target.id,
        { email_sent: emailSent, expires_at: expiresAt.toISOString() },
      );

      /*
       * THE ONE-TIME LINK IS RETURNED ONLY WHERE THERE IS NO POSTMAN.
       *
       * It used to come back whenever a send merely failed, so an inviter could
       * hold a credential for a mailbox they do not own. The first fix withheld
       * it where the address belonged to another organisation — which closed the
       * cross-organisation case and left two things the independent review
       * found:
       *
       *  * a FAILED send is attacker-triggerable (the provider limits sends per
       *    second and this endpoint has no limiter of its own), and holding the
       *    link for an unclaimed address lets the caller accept it themselves —
       *    setting a password and stamping the mailbox verified on an account
       *    bearing somebody else's address. Acceptance is scoped, so that
       *    account reaches nowhere today; but an account that already signs in
       *    is granted a LIVE membership whenever any organisation adds it
       *    later, correctly and by design, so the claim pays off the first time
       *    the real person is invited somewhere.
       *  * the link's PRESENCE was itself the answer to "does this address hold
       *    a membership somewhere that is not mine?" — the very oracle this
       *    file's header forbids. Protecting WHICH organisation while disclosing
       *    THAT one exists is not protection.
       *
       * So `mayHandLinkToInviter` keeps the affordance for the case it was
       * written for — a deployment with no mail provider at all, where the
       * inviter is the only delivery channel there is — and never for a send
       * that went wrong. The response is now the SAME SHAPE for every address,
       * which is what removes the oracle rather than narrowing it.
       */
      const sendState: InviteSendState = outcome.sent
        ? 'sent'
        : outcome.reason === 'not_configured' ? 'not_configured' : 'failed';
      if (sendState === 'failed') {
        console.warn('[builder-portal-invite] the invitation email did not leave; no link is returned', {
          reason: outcome.reason,
          builder_user_id: target.id,
        });
      }

      return json({
        ...GENERIC_OK,
        email_sent: emailSent,
        expires_at: expiresAt.toISOString(),
        invite_url: mayHandLinkToInviter({ send: sendState }) ? inviteUrl : undefined,
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
      //
      // A grant to an account that cannot sign in yet WAITS: the invitation for
      // this organisation is what promotes it, and nothing else can. An account
      // that already signs in is being added by its own organisation's
      // administrator, so that membership is live at once — unchanged.
      const accountIsActive = !!(target.invite_accepted_at || target.password_hash);
      const { error: membershipError } = await supabase
        .from('builder_organisation_memberships')
        .insert({
          builder_user_id: target.id,
          organisation_id: activeOrganisationId,
          membership_role: role,
          is_primary: false,
          status: membershipStatusForGrant({ accountIsActive }),
          granted_by: caller.id,
        });
      if (membershipError && String(membershipError.code) === '23505' && accountIsActive) {
        /*
         * A LIVE ACCOUNT MUST END UP LIVE IN THIS ORGANISATION.
         *
         * 23505 on the live key means a membership already exists — and it may
         * be one that is still WAITING, from an invitation issued before this
         * account accepted somebody else's. Adding a colleague who already
         * signs in is not an invitation and mints nothing, so nothing would
         * ever promote that row: the notice below would promise access the
         * portal then refused, and the seat would be stuck for good.
         *
         * Only ever from `invited`. A `suspended` membership is an
         * administrator's decision and an invitation may not undo it.
         */
        const promotion = await promoteWaitingMembership(supabase, {
          builderUserId: target.id,
          organisationId: activeOrganisationId,
          membershipRole: role,
          grantedBy: caller.id,
        });
        if (promotion.error) throw promotion.error;
        /*
         * A REFUSAL TO PROMOTE MAY NOT BE REPORTED AS A GRANT.
         *
         * Promoting nothing is the right answer for a `suspended` membership —
         * that is an administrator's decision and an invitation may not undo
         * it — but the branch below then emailed "You now have access … your
         * existing sign-in still works" over a membership the portal still
         * refuses, which is the exact failure this promotion exists to
         * prevent. The row count is what tells the two apart; without it a
         * zero-row update carries no error and reads as success.
         *
         * 409 rather than 403: the act is refused because of the state this
         * membership is in, and the remedy is to reactivate it on the members
         * screen, which is where that decision belongs.
         */
        if (promotion.promoted === 0) {
          return json({
            error: 'That person already has a membership here that is not waiting on an invitation. '
              + 'Reactivate them on the members list instead.',
            code: 'membership_not_promotable',
          }, 409);
        }
      } else if (membershipError && String(membershipError.code) !== '23505') {
        throw membershipError;
      }

      if (accountIsActive) {
        // Already active on the network: access granted, nothing to accept.
        // The notice goes to the MAILBOX, not the caller.
        const brand = await getBrandConfig();
        const organisationName = session.active_organisation?.legal_name || brand.companyName;
        const notice = await sendBuilderEmail({
          to: target.email,
          subject: `You now have access to ${organisationName} on the ${brand.companyName} Builder Portal`,
          brand,
          category: 'builder_portal_invite',
          content: {
            heading: `You now have access to ${organisationName}`,
            paragraphs: [
              `Hi ${String(target.name || 'there')},`,
              `${String(caller.name || 'A colleague')} has added you to ${organisationName} on the ${brand.companyName} Builder / Developer Portal.`,
              'Your existing sign-in still works — nothing about your account has changed. The organisation is in the switcher next time you sign in.',
            ],
            action: { label: 'Open the Builder Portal', url: builderAppBaseUrl() },
          },
        });
        await logInviteActivity('builder_membership_granted', target.id, { membership_role: role });
        // Was `!!resendApiKey` — which reported a send that a 403 from an
        // unverified sender domain had refused. It reports the send now.
        return json({ ...GENERIC_OK, email_sent: notice.sent });
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
      /*
       * ONLY THIS ORGANISATION'S OWN TOKEN IS DESTROYED.
       *
       * The token slot is one per account, so nulling it by user id alone let
       * any organisation cancel an invitation somebody else had issued: A
       * invites an address B is also inviting, calls `revoke_invite`, and B's
       * live link stops working with nothing to say why. `loadScopedUser`
       * admits any non-revoked membership, including the `invited` one A just
       * created itself, so no other check stood in the way.
       *
       * `invite_token_organisation_id` exists for exactly this, and the first
       * fix added it without using it here. Scoped, the statement clears a
       * token this organisation minted and no other; a token belonging
       * elsewhere is left standing, and A's own membership is still revoked
       * below either way.
       */
      const { error } = await supabase.from('builder_portal_users').update({
        invite_token_hash: null,
        invite_token_expires_at: null,
        invite_token_organisation_id: null,
      }).eq('id', target.id).eq('invite_token_organisation_id', activeOrganisationId);
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
        .select('id, builder_user_id, membership_role, status')
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
    return json({ error: 'Internal server error' }, 500);
  }
});
