/**
 * Builder / Developer Portal — invitation acceptance.
 *
 * Mirrors `solicitor-portal-accept-invite` with three corrections:
 *
 *  1. The invite token is looked up by HASH. Phase 1 stores
 *     `invite_token_hash` and has no plaintext column, so a database leak
 *     cannot yield a usable invite link.
 *  2. The updated row is captured and checked, so a second concurrent
 *     acceptance cannot be reported as a success.
 *  3. Password strength uses the shared validator rather than a bare length
 *     check.
 *
 * The organisation lookup happens twice, and the two are not interchangeable:
 * `listInvitedOrganisations` reads memberships directly and is the only thing
 * that works before the account is active, while `listAccessibleOrganisations`
 * is the authoritative post-activation resolver the session is scoped to.
 * Collapsing them into one `organisations` binding is what made this function
 * fail to parse.
 *
 * Since doc 68 there are two kinds of invitation and two places a token
 * lives. An organisation's invitation is on its own waiting SEAT; the
 * operator's doors, and anything issued before doc 68, use the account's one
 * slot. Either kind is accepted in one of two ways:
 *
 *  * an account's FIRST invitation sets its password, activates it and signs
 *    it in, as it always has;
 *  * an invitation to an account that already signs in is a JOIN — one click,
 *    the seat comes up, and nothing about the account is written and no
 *    session is issued. The invitation it answers used to be granted without
 *    anyone accepting it.
 *
 * A LINK SOMEBODY ELSE HOLDS KEEPS THE KIND IT WAS MINTED FOR (independent
 * review of doc 68). A password-setting link may be held by the inviter (a
 * deployment with no mail provider) or an operator; had it become a one-click
 * join once the person started signing in elsewhere, its holder could accept
 * on their behalf. So a seat records what its token was minted for and whether
 * it was handed to the inviter, and a HANDED link whose account no longer
 * matches is refused; the organisation invites again, and the person is
 * emailed a join. A link only the mailbox holds follows the account, because
 * its holder is the person — who could reset the password with that mailbox
 * anyway — so somebody invited by two organisations before they had an
 * account can accept both (the second review). But only where the account's
 * own password was set through such a link too: a password an inviter set
 * through a HANDED link belongs to whoever set it, and a link that followed
 * that account would join the inviter's account to another organisation (the
 * third review). Every account-slot token was minted for an account with no
 * password and may be an operator's, so an account that has one is turned
 * away there, as it always was.
 *
 * Actions: `validate` (render the form, and say whether a password is asked
 * for) and accept (default).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { hashPassword } from '../_shared/password.ts';
import { validatePasswordStrength } from '../_shared/passwordValidation.ts';
import { createCorsHeaders, createBuilderSessionCookie } from '../_shared/auth.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import { validateBuilderPortalRequest } from '../_shared/builderSessionToken.ts';
import { auditBuilderIdentity, issueBuilderSession } from '../_shared/builderSessions.ts';
import {
  explainNoAccessibleOrganisation,
  listAccessibleOrganisations,
} from '../_shared/builderPortalAuth.ts';
import {
  acceptanceActivation,
  invitationRequiresPassword,
  PENDING_MEMBERSHIP_STATUS,
} from '../_shared/builderInviteScope.pure.ts';
import { promoteWaitingMembership } from '../_shared/builderInvite.ts';
import { parseJsonBody } from '../_shared/validate.ts';
import { AcceptInviteRequest, AUTH_MAX_BODY_BYTES } from '../_shared/authBodySchemas.ts';
import { enforceAuthRateLimit } from '../_shared/authRateLimit.ts';

const GENERIC_INVITE_ERROR = 'Invalid or expired invite link';

/**
 * What to say when the activation succeeded and the refusal cannot be named.
 *
 * `readAccessDenial` deliberately answers `unknown` with an EMPTY message for
 * a shape it cannot classify — saying nothing new is always safe, saying
 * something untrue is not. `builder-portal-login` falls back to its generic
 * refusal there; this path has no generic refusal to fall back to, because
 * nothing was refused: the account is active. An empty string would render as
 * a blank explanation, which reads as a broken page.
 *
 * So the fallback states only what is certainly true and sends the reader to
 * the one surface that CAN answer authoritatively.
 */
const PENDING_FALLBACK =
  'Your account is active and your password is set. Sign in to continue — if the workspace ' +
  'is not open yet, the sign-in page will say why.';

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (payload: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
    });

  if (!validateBuilderPortalRequest(req)) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // WP-27: bounded and shape-checked. This endpoint needs no session, so the
    // read had no size limit and the destructure below no runtime check — a
    // password arriving as an object reached the comparison as one.
    const __body = await parseJsonBody(req, AcceptInviteRequest, corsHeaders, AUTH_MAX_BODY_BYTES);
    if (!__body.ok) return __body.response;
    const { action, token, password } = __body.data;
    if (!token || typeof token !== 'string') {
      return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
    }

    // The shared limiter, not a hand-rolled one. The previous version keyed on
    // `X-Forwarded-For`, which the caller sets — a fresh value per request was
    // an unlimited allowance — and only refused on an explicit `false`, so an
    // RPC error (`undefined`) let the request through. `enforceAuthRateLimit`
    // buckets on the address the platform vouched for and falls back to a
    // per-isolate counter rather than to no limit at all. Same budget, same
    // response, so nothing downstream changes.
    const rateLimit = await enforceAuthRateLimit(supabase, req, {
      scope: 'bai', ip: { max: 20, windowSeconds: 3600 },
    });
    if (!rateLimit.allowed) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 429);

    const tokenHash = await hashSessionToken(token);
    if (!tokenHash) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);

    /*
     * A FIRST INVITATION SETS THE ACCOUNT'S PASSWORD — ONLY WHILE IT HAS NONE.
     *
     * The update is the statement that decides the race, so it states every
     * condition it depends on: still unaccepted, still no password, not
     * withdrawn. A second concurrent acceptance, an account that started
     * signing in some other way, and one an operator revoked meanwhile all
     * match no row, and are refused rather than activated over.
     *
     * An account-slot token is used up here, in the same statement. A seat's
     * own token is used up by the promotion that follows, in its statement.
     */
    /**
     * `mailboxOnly`: the link being accepted was held by the mailbox and
     * nobody else, so the password set here is the mailbox holder's — which is
     * what lets a later mailbox-held link follow this account (header).
     */
    const activateAccount = async (accountId: string, consumeSlotToken: boolean, mailboxOnly: boolean) => {
      if (!password || typeof password !== 'string') {
        return json({ error: 'Password is required' }, 400);
      }
      const strength = await validatePasswordStrength(password);
      if (!strength.isValid) {
        return json({ error: strength.error || 'Password does not meet the required strength' }, 400);
      }

      const hashedPassword = await hashPassword(password);
      let activation = supabase
        .from('builder_portal_users')
        .update({
          password_hash: hashedPassword,
          must_change_password: false,
          password_changed_at: new Date().toISOString(),
          // The scope goes with the token it scoped.
          ...(consumeSlotToken
            ? { invite_token_hash: null, invite_token_expires_at: null, invite_token_organisation_id: null }
            : {}),
          invite_accepted_at: new Date().toISOString(),
          ...(mailboxOnly ? { password_set_by_mailbox_link_at: new Date().toISOString() } : {}),
          // Accepting an emailed token proves the mailbox (network governance
          // reads this; see builderPortalAuth.builderGovernanceError).
          email_verified_at: new Date().toISOString(),
          status: 'active',
          is_active: true,
          last_login_at: new Date().toISOString(),
          failed_login_attempts: 0,
          locked_until: null,
        })
        .eq('id', accountId)
        // An account an operator suspended before it accepted stays suspended.
        .eq('status', 'invited')
        .is('invite_accepted_at', null)
        .is('password_hash', null)
        .is('revoked_at', null);
      if (consumeSlotToken) activation = activation.eq('invite_token_hash', tokenHash);
      const { data: updatedUser, error: updateError } = await activation
        .select('id, email, name, phone, job_title, must_change_password')
        .maybeSingle();

      if (updateError) {
        console.error('[builder-portal-accept-invite] activation failed', updateError.message);
        return json({ error: 'Failed to activate your account' }, 500);
      }
      if (!updatedUser) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
      return updatedUser;
    };

    /*
     * AN ACCOUNT THAT ALREADY SIGNS IN JOINS — AND NOTHING ELSE HAPPENS (doc 68).
     *
     * Every organisation invitation now waits for its invitee, established
     * accounts included, and for them the emailed link is the whole of the
     * acceptance: one deliberate click. The seat has already been brought up
     * by the promoter by the time this runs. Nothing about the ACCOUNT is
     * written — its password, status and activity are not this link's to
     * touch, since a link that could set one would be a password reset
     * dressed as an invitation — and no session is issued, because a link
     * that signed somebody in without their password would be a weaker door
     * than the one they already use. They sign in as they always have, and the
     * organisation is there.
     */
    const joinOnly = async (joined: {
      readonly promotion: { readonly error: { message: string } | null; readonly promoted: number };
      readonly builderUserId: string;
      readonly organisation: { organisation_id: string; legal_name: string; membership_role: string };
    }) => {
      if (joined.promotion.error) {
        console.error('[builder-portal-accept-invite] the join could not be recorded', joined.promotion.error.message);
        return json({ error: 'This service is temporarily unavailable. Please try again.', valid: false }, 503);
      }
      // Nothing was waiting on this token any more: spent, cancelled or suspended.
      if (joined.promotion.promoted === 0) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);

      await auditBuilderIdentity(supabase, req, {
        userId: joined.builderUserId, organisationId: joined.organisation.organisation_id,
        action: 'builder_invite_accepted', sessionId: null,
        newState: { membership: 'active', joined_existing_account: true, signed_in: false },
      });
      return json({
        success: true,
        accepted: true,
        activated: false,
        signed_in: false,
        organisation: joined.organisation,
      });
    };

    const finishActivation = async (
      accountId: string,
      updatedUser: { id: string; email: string; name: string; phone: string | null; job_title: string | null },
    ) => {
      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: accountId });

      // Only now is the account active, so this is the first point at which
      // `builder_accessible_organisations` can return anything. It is the
      // authoritative post-activation list and the one the session is scoped to.
      const accessibleOrganisations = await listAccessibleOrganisations(supabase, accountId);

      /*
       * ACTIVATED, AND NOT YET ALLOWED IN. These are different facts and this
       * function used to conflate them.
       *
       * `listInvitedOrganisations` deliberately counts a membership of an
       * organisation that is still `pending_activation` — its own comment says
       * the invite is legitimately issued ahead of the organisation going live
       * and "the organisation gate applies at login". The code then issued a
       * session unconditionally, and `builder_issue_session` applies exactly
       * that gate: it requires an accessible organisation and raises
       * `BUILDER_SESSION_NOT_PERMITTED` when there is none.
       *
       * So the two halves of this handler contradicted each other, and the
       * throw was caught by the outer `catch` and reported as **Internal server
       * error** — measured in production on 18 Sep 2026, on the first real
       * builder to accept an invitation into an organisation awaiting approval.
       *
       * The rule that makes the repair the right one: AN ACT THAT HAS ALREADY
       * COMMITTED MUST NEVER BE REPORTED AS A FAILURE. The update above has
       * happened — the password is set, the invite is spent, the account is
       * active — so a 500 tells somebody nothing happened when everything did,
       * and sends them back to a link that no longer works.
       *
       * `builder-portal-login` has answered this correctly since the access
       * denial work; it reads the memberships and explains the refusal rather
       * than guessing. This asks the same shared explainer, so the sentence a
       * builder meets here is the one they meet at sign-in.
       */
      if (!accessibleOrganisations.length) {
        const denial = await explainNoAccessibleOrganisation(supabase, accountId, new Date());
        await auditBuilderIdentity(supabase, req, {
          userId: accountId, organisationId: null,
          action: 'builder_invite_accepted', sessionId: null,
          newState: { status: 'active', signed_in: false, reason: denial.code },
        });
        return json({
          success: true,
          // The account IS active and the password IS set. Naming both stops a
          // reader — or a future caller — treating this as a failed activation.
          activated: true,
          signed_in: false,
          pending: { code: denial.code, message: denial.message || PENDING_FALLBACK },
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            name: updatedUser.name,
          },
        });
      }

      const autoSelected = accessibleOrganisations.find((organisation) => organisation.is_primary)
        ?? (accessibleOrganisations.length === 1 ? accessibleOrganisations[0] : null);

      const issued = await issueBuilderSession(supabase, accountId, req, {
        deviceLabel: req.headers.get('user-agent') || undefined,
      });
      if (autoSelected) {
        await supabase.rpc('builder_select_session_organisation', {
          _session_id: issued.id,
          _builder_user_id: accountId,
          _organisation_id: autoSelected.organisation_id,
        });
      }

      await auditBuilderIdentity(supabase, req, {
        userId: accountId, organisationId: autoSelected?.organisation_id ?? null,
        action: 'builder_invite_accepted', sessionId: issued.id,
        newState: { status: 'active' },
      });

      return json({
        success: true,
        activated: true,
        signed_in: true,
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          name: updatedUser.name,
          phone: updatedUser.phone,
          job_title: updatedUser.job_title,
          must_change_password: false,
          has_accepted_current_terms: false,
          has_completed_onboarding: false,
        },
        organisations: accessibleOrganisations,
        active_organisation: autoSelected,
        requires_organisation_selection: !autoSelected,
        session: {
          id: issued.id,
          absolute_expires_at: issued.absoluteExpiresAt.toISOString(),
          idle_expires_at: issued.idleExpiresAt.toISOString(),
        },
      }, 200, { 'Set-Cookie': createBuilderSessionCookie(issued.token, issued.absoluteExpiresAt) });
    };

    /*
     * A SEAT'S OWN INVITATION IS LOOKED FOR FIRST (doc 68).
     *
     * Since doc 68 an organisation's invitation lives on that organisation's
     * seat, so the seat IS the scope: this token can bring up this seat and no
     * other. The account's single slot is still read below, for the operator's
     * doors and for any invitation issued before this. A read that FAILED is
     * not a token that is ABSENT, so it answers 503, never "invalid".
     */
    const { data: seat, error: seatError } = await supabase
      .from('builder_organisation_memberships')
      .select(`id, builder_user_id, organisation_id, membership_role, status, revoked_at, invited_name,
               invite_token_expires_at, invite_requires_password, invite_link_handed`)
      .eq('invite_token_hash', tokenHash)
      .maybeSingle();
    if (seatError) {
      console.error('[builder-portal-accept-invite] the seat invitation lookup FAILED — this is not an absent token',
        seatError.code, seatError.message);
      return json({ error: 'This service is temporarily unavailable. Please try again.', valid: false }, 503);
    }

    if (seat) {
      // Every refusal is the same generic message, as below.
      if (seat.revoked_at || seat.status !== PENDING_MEMBERSHIP_STATUS) {
        return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
      }
      if (!seat.invite_token_expires_at || new Date(seat.invite_token_expires_at) < new Date()) {
        return json({ error: GENERIC_INVITE_ERROR, valid: false, expired: true }, 400);
      }
      const [{ data: account, error: accountError }, { data: organisation, error: organisationError }] =
        await Promise.all([
          supabase.from('builder_portal_users')
            .select('id, email, status, revoked_at, invite_accepted_at, password_hash, password_set_by_mailbox_link_at')
            .eq('id', seat.builder_user_id)
            .maybeSingle(),
          supabase.from('builder_organisations')
            .select('id, legal_name')
            .eq('id', seat.organisation_id)
            .neq('status', 'closed')
            .maybeSingle(),
        ]);
      if (accountError || organisationError) {
        console.error('[builder-portal-accept-invite] the invitation could not be read',
          accountError?.message ?? organisationError?.message);
        return json({ error: 'This service is temporarily unavailable. Please try again.', valid: false }, 503);
      }
      if (!account || account.revoked_at || account.status === 'revoked' || !organisation) {
        return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
      }
      const joining = {
        organisation_id: organisation.id,
        legal_name: organisation.legal_name,
        membership_role: seat.membership_role,
      };
      const requiresPassword = invitationRequiresPassword(account);
      // What a link is for may follow the account only while nobody but the
      // mailbox has held a credential for it: not this link, and not the one
      // that set the account's password (header). Otherwise the link must
      // still be what the account needs — a password-setting link never
      // becomes a join. Same answer as every other refusal, so the holder
      // learns nothing more than that the link no longer works.
      const kindFollowsAccount = !seat.invite_link_handed && !!account.password_set_by_mailbox_link_at;
      if (seat.invite_requires_password !== requiresPassword && !kindFollowsAccount) {
        return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
      }
      // A password is set only on an account that is still an invitation —
      // what activation itself requires — so the form is never offered to an
      // account an operator suspended before it accepted.
      if (requiresPassword && account.status !== 'invited') {
        return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
      }

      if (action === 'validate') {
        // Only this invitation's own facts: the name THIS organisation typed,
        // never the account's, which is another organisation's typed name or
        // the person's registered one — where the address already belongs.
        return json({
          valid: true,
          email: account.email,
          name: seat.invited_name ?? null,
          job_title: null,
          requires_password: requiresPassword,
          organisations: [joining],
        });
      }

      if (!requiresPassword) {
        const promotion = await promoteWaitingMembership(supabase, {
          builderUserId: account.id,
          organisationId: seat.organisation_id,
          inviteTokenHash: tokenHash,
        });
        return await joinOnly({ promotion, builderUserId: account.id, organisation: joining });
      }

      const activated = await activateAccount(account.id, false, !seat.invite_link_handed);
      if (activated instanceof Response) return activated;
      /*
       * THE SEAT THE TOKEN IS ON, AND IT IS USED UP HERE: promoted only while
       * it still carries this token, which the promotion clears. After the
       * update above, which decided the race, so a failure fails CLOSED —
       * active, nothing accessible, explained below — never the other way.
       */
      const { error: promoteError } = await promoteWaitingMembership(supabase, {
        builderUserId: account.id,
        organisationId: seat.organisation_id,
        inviteTokenHash: tokenHash,
      });
      if (promoteError) {
        console.error('[builder-portal-accept-invite] membership promotion failed', promoteError.message);
      }
      return await finishActivation(account.id, activated);
    }

    /*
     * THE ERROR IS READ. A read that FAILED is not a row that is ABSENT, and
     * this select is where that distinction became load-bearing: it now names
     * `invite_token_organisation_id`, so a deployment whose functions ship
     * ahead of migration `20260928090000` answers PostgREST's `PGRST204`, the
     * row reads as undefined, and EVERY invitation on that deployment answers
     * "Invalid or expired invite link" with nothing recorded anywhere. The same
     * goes for any transient database fault. Both are fail-closed, which is
     * right, and both were undiagnosable, which is not.
     */
    const { data: portalUser, error: portalUserError } = await supabase
      .from('builder_portal_users')
      .select(`id, email, name, job_title, status, is_active, revoked_at,
               invite_token_hash, invite_token_expires_at, invite_accepted_at, password_hash,
               invite_token_organisation_id`)
      .eq('invite_token_hash', tokenHash)
      .maybeSingle();
    if (portalUserError) {
      console.error('[builder-portal-accept-invite] the invitation lookup FAILED — this is not an absent token',
        portalUserError.code, portalUserError.message);
      // 503: the caller may retry, and an operator has something to read. The
      // body stays generic so a failure discloses nothing a success would not.
      return json({ error: 'This service is temporarily unavailable. Please try again.', valid: false }, 503);
    }

    // Every rejection below uses the same generic message so an attacker cannot
    // learn whether a token exists, has expired, or was already used.
    if (!portalUser) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
    if (!portalUser.invite_token_expires_at
        || new Date(portalUser.invite_token_expires_at) < new Date()) {
      return json({ error: GENERIC_INVITE_ERROR, valid: false, expired: true }, 400);
    }
    if (portalUser.revoked_at || portalUser.status === 'revoked') {
      return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
    }
    // Every account-slot token was minted for an account with no password
    // (header), so one that has since started signing in is refused here: a
    // password-setting link never becomes a join.
    if (portalUser.invite_accepted_at || portalUser.password_hash) {
      return json({ error: GENERIC_INVITE_ERROR, valid: false, already_active: true }, 400);
    }
    // And only while it is still an invitation, as activation requires: an
    // account an operator suspended before it accepted is not offered the form.
    if (portalUser.status !== 'invited') {
      return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
    }

    // An invite is only usable if the account still has somewhere to go.
    // This runs BEFORE activation, so it must not use
    // `listAccessibleOrganisations` — see `listInvitedOrganisations`.
    const invitedOrganisations = await listInvitedOrganisations(supabase, portalUser.id);
    if (!invitedOrganisations.length) return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);

    /*
     * ONE INVITATION, ONE ORGANISATION.
     *
     * This is the whole of the cross-organisation takeover fix on the read
     * side. The token names the organisation it was minted for, and that is
     * the only membership this acceptance may promote. An account pending in
     * several organisations therefore needs each organisation's own
     * invitation, and a link that reached the wrong hands opens nothing else.
     *
     * A refusal is the SAME generic message as every other rejection above, so
     * a holder learns nothing about where the address belongs.
     * `builderInviteScope.pure.ts` holds the rule and its reasoning.
     */
    const scope = acceptanceActivation({
      tokenOrganisationId: portalUser.invite_token_organisation_id ?? null,
      liveMemberships: invitedOrganisations.map((organisation) => ({
        organisation_id: organisation.organisation_id,
        status: organisation.status,
      })),
    });
    if (!scope.ok) {
      console.warn('[builder-portal-accept-invite] refused an out-of-scope invitation', {
        reason: scope.reason,
        builder_user_id: portalUser.id,
      });
      return json({ error: GENERIC_INVITE_ERROR, valid: false }, 400);
    }
    const acceptingOrganisation = invitedOrganisations.find(
      (organisation) => organisation.organisation_id === scope.activate,
    )!;

    if (action === 'validate') {
      return json({
        valid: true,
        email: portalUser.email,
        name: portalUser.name,
        job_title: portalUser.job_title,
        requires_password: true,
        // The organisation THIS invitation joins, and no other. Listing every
        // organisation the address is pending in told its holder — who may not
        // be its owner — where else that person has been invited.
        organisations: [{
          organisation_id: acceptingOrganisation.organisation_id,
          legal_name: acceptingOrganisation.legal_name,
          membership_role: acceptingOrganisation.membership_role,
        }],
      });
    }

    // An account-slot link may have been an operator's to hand on.
    const activated = await activateAccount(portalUser.id, true, false);
    if (activated instanceof Response) return activated;

    /*
     * PROMOTE EXACTLY ONE MEMBERSHIP — the organisation this token was for.
     *
     * Deliberately AFTER the single-use update above, which is the statement
     * that decides the race. If this promotion then fails, the account is
     * active with nothing accessible: `builder_issue_session` refuses, and the
     * "activated, not yet allowed in" branch explains it and invites a
     * sign-in. That fails CLOSED and is recoverable by re-sending the
     * invitation. Promoting first would risk the opposite — a live membership
     * on an account a later, different token activates, which is the very
     * cross-organisation activation this scoping exists to prevent.
     *
     * Scoped by organisation id as well as user: an update naming only the
     * user would light up every organisation again.
     */
    const { error: promoteError } = await promoteWaitingMembership(supabase, {
      builderUserId: portalUser.id,
      organisationId: scope.activate,
    });
    if (promoteError) {
      // Not fatal to an act that has already committed: say nothing new, let
      // the refusal below be read from the memberships themselves.
      console.error('[builder-portal-accept-invite] membership promotion failed', promoteError.message);
    }

    return await finishActivation(portalUser.id, activated);
  } catch (error) {
    console.error('[builder-portal-accept-invite]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});

/**
 * The organisations an invited user is bound to, read BEFORE activation.
 *
 * `builder_accessible_organisations` filters on `u.is_active AND u.status =
 * 'active'`, so for an account that is still `invited` it returns nothing. Using
 * it here answered "has this user any access?" with a permanent no, which both
 * blocked the eligibility gate from doing its job and left the acceptance form
 * unable to name the organisation being joined. Reading the memberships
 * directly is the only correct pre-activation source.
 *
 * A membership of an organisation that is still `pending_activation` counts: the
 * invite is legitimately issued ahead of the organisation going live, and the
 * organisation gate applies at login. A `closed` organisation does not count —
 * there is nowhere for the account to land.
 */
interface InvitedOrganisation {
  organisation_id: string;
  legal_name: string;
  membership_role: string;
  /*
   * Carried so the scoping rule can see it. This list is every non-revoked
   * membership, which includes `suspended` ones: promotion correctly no-ops on
   * those, so nothing is over-activated, but a legacy token naming no
   * organisation would otherwise pick a suspended membership as "the one" and
   * the validate response would name that organisation to whoever held the
   * link. A suspended membership is not an invitation waiting to be accepted.
   */
  status: string | null;
}

async function listInvitedOrganisations(
  supabase: any,
  userId: string,
): Promise<InvitedOrganisation[]> {
  const { data: memberships } = await supabase
    .from('builder_organisation_memberships')
    .select('organisation_id, membership_role, status')
    .eq('builder_user_id', userId)
    .is('revoked_at', null);
  if (!Array.isArray(memberships) || !memberships.length) return [];

  const ids = memberships.map((membership: any) => membership.organisation_id);
  const { data: organisations } = await supabase
    .from('builder_organisations')
    .select('id, legal_name, status')
    .in('id', ids)
    .neq('status', 'closed');

  // Explicitly typed for the same reason as the shared resolver: the PostgREST
  // row type erases to `{}` and would hide every field read below.
  const detailBy = new Map<string, { legal_name: string }>(
    (organisations ?? []).map((organisation: any) => [organisation.id, organisation]),
  );

  const invited: InvitedOrganisation[] = [];
  for (const membership of memberships) {
    const detail = detailBy.get(membership.organisation_id);
    if (!detail) continue;
    invited.push({
      organisation_id: membership.organisation_id,
      legal_name: detail.legal_name,
      membership_role: membership.membership_role,
      status: membership.status ?? null,
    });
  }
  return invited;
}
