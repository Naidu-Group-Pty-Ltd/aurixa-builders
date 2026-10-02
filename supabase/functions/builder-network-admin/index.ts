/**
 * The network's operator API — called by Mission Control's
 * `/builders-network/*` console and nothing else (extraction plan §5).
 *
 * MC must not hold the network's service-role key, so the door is the
 * federation assertion: an RS256 JWT MC signs with the platform key, aud
 * bound to this origin, carrying `builders:operate`. Revoking that scope on
 * MC's side is a complete rollback of this entire surface.
 *
 * What lives here is the plan's operator plane and no more: organisation
 * vetting (approve / suspend / reinstate / close / reopen — the lifecycle of the
 * `pending_verification` state registration mints), the workspace
 * DIRECTORY (MC → network per §6: registry upserts and connection
 * minting), the MARKETPLACE RANKING's manual instruments (pin, suppress,
 * freeze, commercial placement — never the score itself), and read-only
 * visibility. What deliberately does NOT:
 *
 *  * Join requests are DECIDED BY ORGANISATION OWNERS — the operator sees
 *    the queue and cannot decide it. A platform that decides membership in
 *    somebody else's organisation has re-grown the agency-administers-
 *    builder shape the extraction exists to end.
 *  * `closed` ends an organisation's life on the network until an operator
 *    reopens it. Suspension is the everyday reversible instrument; closing
 *    is the end-of-life act, with a reason it will not proceed without — and
 *    because it writes only the organisation's status, every member, seat
 *    and record survives it, which is what lets `reopen_organisation` bring
 *    the organisation back (suspended, or pending if it was never approved)
 *    rather than leave the operator to build a replacement the unique
 *    indexes refuse. Nothing here DELETES an organisation an operator could
 *    have seen used — the network's record of who was on it is not an
 *    operator's to destroy. The one delete is an access request rolling back
 *    the empty row it created itself a moment earlier.
 *  * `create_organisation` and `update_organisation` write DESCRIPTION only.
 *    The lifecycle columns move under their own verbs, which set the whole
 *    consistent group the table's CHECK constraints demand; an edit form
 *    that could also set `status` would be a second way to move a lifecycle.
 *  * `invite_organisation_owner` bootstraps a brand-new organisation's FIRST
 *    member and refuses once one exists — which is how the rule above it
 *    survives. An operator seeding an empty organisation is not deciding
 *    membership in somebody else's; once there is an owner, they invite.
 *  * A REVOKED connection is never revived — reconnection is a NEW row
 *    with a NEW invite code, so the audit history stays whole.
 *
 * The invite code minted by `create_connection` is returned ONCE, hashed
 * at rest, and travels operator → builder out of band; the builder-side
 * acceptance is `builder-network-connections`.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { verifyMcAssertion } from '../_shared/mcFederation.ts';
import { hashSessionToken } from '../_shared/sessionHash.ts';
import {
  builderAppBaseUrl,
  mintBuilderInvite,
  INVITE_EXPIRY_HOURS,
} from '../_shared/builderInvite.ts';
import { readOrganisationConflict } from '../_shared/builderOrganisationConflict.pure.ts';
import { operatorMayHandLink } from '../_shared/builderInviteScope.pure.ts';
import { grantOwnerSeat } from '../_shared/builderOwnerSeat.ts';
import { ownerInvitationMayBeReissued, type OrganisationSeat } from '../_shared/builderOwnerSeat.pure.ts';
import {
  ADDRESS_WINDOW_OUTCOMES,
  APPLICATION_WINDOW_HOURS,
  IN_FLIGHT_MINUTES,
  ORIGIN_WINDOWS,
  organisationFromRequest,
  readAccessRequest,
} from '../_shared/builderAccessRequest.pure.ts';
import { getBrandConfig } from '../_shared/brand-config.ts';
import {
  sendBuilderEmail,
  type InviteEmailOutcome,
} from '../_shared/builderInviteEmail.ts';
import { readOrganisationInput } from '../_shared/builderOrganisationInput.pure.ts';
import { reopenTarget, type ReopenTarget } from '../_shared/builderOrganisationReopen.pure.ts';

const MAX_BODY_BYTES = 32 * 1024;
const INVITE_CODE_EXPIRY_DAYS = 14;

Deno.serve(async (req) => {
  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
    if (!bounded.ok) return bounded.error;

    const authorization = req.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const verdict = await verifyMcAssertion(token, 'builders:operate');
    if (!verdict.ok) {
      // `unconfigured` is the operator's fault to fix, not the caller's to
      // probe — it is the one reason named, because the remedy is an env var.
      const status = verdict.reason === 'unconfigured' ? 503 : 401;
      return json({ error: verdict.reason === 'unconfigured' ? 'federation_unconfigured' : 'unauthorised' }, status);
    }
    const operator = verdict.claims.sub;

    let body: Record<string, any>;
    try {
      body = bounded.raw ? JSON.parse(bounded.raw) : {};
    } catch {
      return json({ error: 'invalid_body' }, 400);
    }
    const operation = String(body.operation || 'overview');

    const logActivity = async (action: string, entityId: string | null, organisationId: string | null, metadata: Record<string, unknown> = {}) => {
      const { error } = await supabase.rpc('builder_log_activity', {
        _actor_user_id: null,
        _actor_type: 'system',
        _action: action,
        _entity_type: 'network_admin',
        _entity_id: entityId,
        _organisation_id: organisationId,
        _builder_user_id: null,
        _previous_state: null,
        _new_state: null,
        _reason: typeof body.reason === 'string' ? body.reason : null,
        _metadata: { mc_operator: operator, ...metadata },
        _ip_address: null,
        _user_agent: 'mission-control',
      });
      if (error) console.error('[builder-network-admin] activity log failed', error.message);
    };

    // -------------------------------------------------------------- overview
    if (operation === 'overview') {
      const countBy = async (table: string, column: string) => {
        const { data } = await supabase.from(table).select(column);
        const counts: Record<string, number> = {};
        for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
          const key = String(row[column] ?? 'unknown');
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
      };
      const [organisations, connections, { count: pendingJoinRequests }, { count: deadLetters }] = await Promise.all([
        countBy('builder_organisations', 'status'),
        countBy('workspace_connections', 'state'),
        supabase.from('builder_org_join_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('builder_network_outbox').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
      ]);
      return json({
        organisations,
        connections,
        pending_join_requests: pendingJoinRequests ?? 0,
        dead_letters: deadLetters ?? 0,
      });
    }

    // -------------------------------------------------- organisation reading
    if (operation === 'list_organisations') {
      let query = supabase
        .from('builder_organisations')
        .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (typeof body.status === 'string' && body.status) query = query.eq('status', body.status);
      const { data, error } = await query;
      if (error) return json({ error: 'read_failed' }, 500);
      return json({ organisations: data ?? [] });
    }

    if (operation === 'list_join_requests') {
      const { data, error } = await supabase
        .from('builder_org_join_requests')
        .select('id, organisation_id, builder_user_id, status, message, created_at, decided_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return json({ error: 'read_failed' }, 500);
      // Visibility only: owners decide (see module header). Labels are
      // resolved so the operator sees names, not uuids.
      const orgIds = [...new Set((data ?? []).map((r: any) => r.organisation_id))];
      const userIds = [...new Set((data ?? []).map((r: any) => r.builder_user_id))];
      const [{ data: orgs }, { data: users }] = await Promise.all([
        orgIds.length ? supabase.from('builder_organisations').select('id, legal_name').in('id', orgIds) : Promise.resolve({ data: [] } as any),
        userIds.length ? supabase.from('builder_portal_users').select('id, name, email').in('id', userIds) : Promise.resolve({ data: [] } as any),
      ]);
      const orgById = new Map((orgs ?? []).map((o: any) => [o.id, o.legal_name]));
      const userById = new Map((users ?? []).map((u: any) => [u.id, { name: u.name, email: u.email }]));
      return json({
        join_requests: (data ?? []).map((r: any) => ({
          ...r,
          organisation_legal_name: orgById.get(r.organisation_id) ?? null,
          requester: userById.get(r.builder_user_id) ?? null,
        })),
      });
    }

    // ----------------------------------------------- organisation lifecycle
    if (operation === 'approve_organisation' || operation === 'suspend_organisation' || operation === 'reinstate_organisation') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status, activated_at')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      if (operation === 'approve_organisation') {
        if (organisation.status === 'active') return json({ success: true, already_active: true });
        const { data: updated } = await supabase
          .from('builder_organisations')
          .update({
            status: 'active',
            is_active: true,
            activated_at: organisation.activated_at ?? new Date().toISOString(),
            suspended_at: null,
            suspension_reason: null,
          })
          .in('status', ['pending_verification', 'pending_activation'])
          .eq('id', organisation.id)
          .select('id')
          .maybeSingle();
        if (!updated) return json({ error: 'not_approvable_from_current_status' }, 409);
        await logActivity('network_organisation_approved', organisation.id, organisation.id);
        return json({ success: true, status: 'active' });
      }

      if (operation === 'suspend_organisation') {
        const reason = String(body.reason || '').trim();
        if (!reason) return json({ error: 'a_reason_is_required' }, 400);
        if (organisation.status === 'suspended') return json({ success: true, already_suspended: true });
        const { data: updated } = await supabase
          .from('builder_organisations')
          .update({
            status: 'suspended',
            is_active: false,
            suspended_at: new Date().toISOString(),
            suspension_reason: reason,
          })
          .eq('id', organisation.id)
          .neq('status', 'closed')
          .select('id')
          .maybeSingle();
        if (!updated) return json({ error: 'suspend_failed' }, 409);
        await logActivity('network_organisation_suspended', organisation.id, organisation.id, { reason });
        return json({ success: true, status: 'suspended' });
      }

      // reinstate: suspension is the reversible instrument.
      if (organisation.status !== 'suspended') {
        return json({ error: 'only_a_suspended_organisation_reinstates' }, 409);
      }
      const { data: updated } = await supabase
        .from('builder_organisations')
        .update({
          status: 'active',
          is_active: true,
          activated_at: organisation.activated_at ?? new Date().toISOString(),
          suspended_at: null,
          suspension_reason: null,
        })
        .eq('id', organisation.id)
        .eq('status', 'suspended')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'reinstate_failed' }, 409);
      await logActivity('network_organisation_reinstated', organisation.id, organisation.id);
      return json({ success: true, status: 'active' });
    }

    // --------------------------------------------- organisation description
    if (operation === 'create_organisation' || operation === 'update_organisation') {
      const creating = operation === 'create_organisation';
      const input = readOrganisationInput(body, creating ? 'create' : 'update');
      if (!input.ok) return json({ error: input.error }, 400);

      if (creating) {
        // Born unapproved, exactly as a self-serve registration is: an
        // operator creating the row is not the same act as vetting it, and
        // `approve_organisation` remains the only way to `active`.
        const { data: created, error } = await supabase
          .from('builder_organisations')
          .insert({ ...input.patch, status: 'pending_activation', is_active: false })
          .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
          .single();
        if (error || !created) {
          // A unique index is the only authority on what is already taken, so
          // the collision is read from its own error rather than pre-checked —
          // a SELECT-then-INSERT would be a race. 409, because the row is
          // refused by something already in the table rather than by anything
          // wrong with this request's own shape.
          const conflict = readOrganisationConflict(error);
          if (conflict) return json({ error: conflict.error, field: conflict.field }, 409);
          console.error('[builder-network-admin] organisation create failed', error);
          return json({ error: 'create_failed' }, 500);
        }
        await logActivity('network_organisation_created', created.id, created.id, {
          legal_name: created.legal_name,
        });
        return json({ success: true, organisation: created });
      }

      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const { data: existing } = await supabase
        .from('builder_organisations')
        .select('id, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!existing) return json({ error: 'organisation_not_found' }, 404);
      if (existing.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      const { data: updated, error: updateError } = await supabase
        .from('builder_organisations')
        .update(input.patch)
        .eq('id', organisationId)
        .neq('status', 'closed')
        .select('id, legal_name, trading_name, org_type, abn, state, status, is_active, activated_at, suspended_at, suspension_reason, contact_email, created_at')
        .maybeSingle();
      if (updateError || !updated) {
        const conflict = readOrganisationConflict(updateError);
        if (conflict) return json({ error: conflict.error, field: conflict.field }, 409);
        console.error('[builder-network-admin] organisation update failed', updateError);
        return json({ error: 'update_failed' }, 500);
      }
      await logActivity('network_organisation_updated', updated.id, updated.id, {
        fields: Object.keys(input.patch),
      });
      return json({ success: true, organisation: updated });
    }

    // ------------------------------------------------ organisation end of life
    if (operation === 'close_organisation') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const reason = String(body.reason || '').trim();
      if (!reason) return json({ error: 'a_reason_is_required' }, 400);

      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') return json({ success: true, already_closed: true });

      // `is_active` false is not optional: `status_active_agree` refuses the
      // row otherwise. Members lose access on their next request because
      // `builder_accessible_organisations` requires an active organisation —
      // nothing has to hunt down their sessions.
      //
      // `status_before_closure` is what reopening reads back
      // (builderOrganisationReopen.pure.ts), so it is written in the same
      // update, and the update moves only a row still in the status that was
      // read: one approved or suspended in between is refused rather than
      // recorded as what it no longer was.
      const { data: updated } = await supabase
        .from('builder_organisations')
        .update({ status: 'closed', is_active: false, status_before_closure: organisation.status })
        .eq('id', organisation.id)
        .eq('status', organisation.status)
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'close_failed' }, 409);
      await logActivity('network_organisation_closed', organisation.id, organisation.id, {
        reason,
        previous_status: organisation.status,
      });
      return json({ success: true, status: 'closed' });
    }

    /*
     * A CLOSED ORGANISATION CAN BE REOPENED.
     *
     * Closing was written as terminal with "no route back", while closing
     * itself writes only `status` and `is_active` — every member, seat,
     * listing, document and connection stays exactly as it was, and members
     * lose access only because `builder_accessible_organisations` requires an
     * active organisation. So a closure made in error, or for a builder who
     * comes back, left the operator a choice between a record they could see
     * and not use, and a replacement organisation the unique indexes refuse
     * (the closed row still holds its ABN, ACN and legal name).
     *
     * Reopening never makes an organisation MORE than it was:
     *
     *  * One that had been approved (`activated_at` is set) comes back
     *    SUSPENDED unless the operator asks for its access back in the same
     *    act (`reinstate: true`) — suspension is the reversible instrument,
     *    and restoring members' access is a decision, not a side effect.
     *  * One that was never approved goes back to the pending state it held
     *    when it was closed — `pending_verification` and `pending_activation`
     *    have different owners — and `approve_organisation` is still the only
     *    road to `active` for it, with everything that gates an approval.
     *
     * It demands a reason, like closing, and moves only a row that is still
     * closed, so two operators cannot reopen it twice.
     */
    if (operation === 'reopen_organisation') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const reason = String(body.reason || '').trim();
      if (!reason) return json({ error: 'a_reason_is_required' }, 400);
      const reinstate = body.reinstate === true;

      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status, activated_at, status_before_closure')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status !== 'closed') {
        return json({ success: true, already_open: true, status: organisation.status });
      }

      const wasApproved = Boolean(organisation.activated_at);
      // A never-approved organisation goes back to the pending state the
      // close wrote on the row. A closure made before that column existed
      // says nothing, and the target falls back to `pending_activation`,
      // which is approved by the same act and gates — so it can misfile an
      // organisation, never admit one.
      const reopenedTo: ReopenTarget = reopenTarget({
        activatedAt: organisation.activated_at,
        statusBeforeClosure: organisation.status_before_closure,
        reinstate,
      });
      // Each target writes the whole group its CHECK constraints demand:
      // `active` agrees with `is_active` and carries `activated_at`;
      // `suspended` carries `suspended_at`. Every target clears
      // `status_before_closure`, which describes a closure that is over.
      const patch: Record<string, unknown> = reopenedTo === 'active'
        ? { status: 'active', is_active: true, suspended_at: null, suspension_reason: null }
        : reopenedTo === 'suspended'
          ? {
            status: 'suspended',
            is_active: false,
            suspended_at: new Date().toISOString(),
            suspension_reason: `Reopened after closure: ${reason}`.slice(0, 500),
          }
          : { status: reopenedTo, is_active: false, suspended_at: null, suspension_reason: null };
      patch.status_before_closure = null;
      const { data: updated, error: reopenError } = await supabase
        .from('builder_organisations')
        .update(patch)
        .eq('id', organisation.id)
        .eq('status', 'closed')
        .select('id')
        .maybeSingle();
      if (reopenError || !updated) {
        if (reopenError) console.error('[builder-network-admin] reopen failed', reopenError);
        return json({ error: 'reopen_failed' }, 409);
      }
      await logActivity('network_organisation_reopened', organisation.id, organisation.id, {
        reason,
        reopened_to: reopenedTo,
        reinstate_requested: reinstate,
      });
      return json({ success: true, status: reopenedTo, was_approved: wasApproved });
    }

    // ----------------------------------------------------- bootstrap an owner
    // ------------------------------------------------ builder lead applies
    /*
     * The automated intake: one submission becomes an organisation and an
     * invitation, with nobody in between.
     *
     * It is federation-gated like everything else here — Mission Control's
     * public application page calls it server-side, so the NETWORK gains no
     * public door and the applicant's browser never speaks to it. That also
     * keeps the abuse controls in one place: MC sees the real client, this
     * sees a signed assertion.
     *
     * The order is load-bearing. The application is recorded FIRST and
     * updated with whatever happens next, so a failure half way through
     * leaves evidence rather than nothing — an unattended pipeline whose
     * failures are invisible is one nobody can debug from the outside, which
     * is precisely the position an operator was in this morning.
     */
    if (operation === 'submit_access_request') {
      const read = readAccessRequest(body);
      if (!read.ok) return json({ error: read.error }, 400);
      const fields = read.fields;

      // One invitation per address per window. Without this the same
      // mailbox could be applied for repeatedly and each attempt would mail
      // it. Read at submit rather than enforced by a unique index, because a
      // second attempt is evidence worth keeping.
      //
      // Only applications that WROTE to the address are counted, plus one
      // still being acted on. A REFUSED application sent nothing, and counting
      // it is what told an applicant who had corrected a mistyped ABN that we
      // "already have" an application we had refused (builderAccessRequest
      // §3). Separate counts rather than one `.or()` string with a timestamp
      // interpolated into it: that is a filter PostgREST may not parse, and a
      // limiter whose predicate never parses is no limiter.
      //
      // The third count is the run that got as far as the send and never
      // settled. It is marked with its organisation BEFORE the send (below),
      // because the send cannot be undone and the settle after it can fail or
      // never run — and such a row, read as merely in flight, would release
      // the address after ten minutes to an application under different
      // company details that mints a second organisation, re-stamps the
      // invitation and writes to the address again.
      const since = new Date(Date.now() - APPLICATION_WINDOW_HOURS * 3600_000).toISOString();
      const inFlightSince = new Date(Date.now() - IN_FLIGHT_MINUTES * 60_000).toISOString();
      const [
        { count: recent, error: recentError },
        { count: inFlight, error: inFlightError },
        { count: unsettled, error: unsettledError },
      ] = await Promise.all([
        supabase
          .from('builder_access_requests')
          .select('id', { count: 'exact', head: true })
          .eq('contact_email', fields.contact_email)
          .in('status', ADDRESS_WINDOW_OUTCOMES)
          .gte('created_at', since),
        supabase
          .from('builder_access_requests')
          .select('id', { count: 'exact', head: true })
          .eq('contact_email', fields.contact_email)
          .eq('status', 'received')
          .gte('created_at', inFlightSince),
        supabase
          .from('builder_access_requests')
          .select('id', { count: 'exact', head: true })
          .eq('contact_email', fields.contact_email)
          .eq('status', 'received')
          .not('organisation_id', 'is', null)
          .gte('created_at', since),
      ]);
      // As the origin windows below: a count that FAILED is not a count of
      // zero, so this refuses rather than writes to a mailbox unbounded.
      if (recentError || inFlightError || unsettledError) {
        console.error('[builder-network-admin] address window read failed', recentError ?? inFlightError ?? unsettledError);
        return json({ error: 'application_not_recorded' }, 503);
      }
      if ((recent ?? 0) + (inFlight ?? 0) + (unsettled ?? 0) > 0) {
        return json({ error: 'an_application_for_that_address_is_already_with_us' }, 429);
      }

      // And a bound on the ORIGIN, because the address window bounds one
      // mailbox and nothing else — a script with a thousand addresses passes
      // it a thousand times, and every pass creates an organisation and
      // sends mail from our verified domain.
      //
      // A caller with no usable origin is NOT exempt: they are counted
      // together under one identity, so an upstream that stops forwarding
      // the header degrades to a shared allowance rather than to no limit
      // at all. That is the one shape of this control that cannot be turned
      // off by omitting a field.
      const origin = typeof body.source_ip === 'string' && body.source_ip.trim()
        ? body.source_ip.trim().slice(0, 100)
        : 'unattributed';
      for (const window of ORIGIN_WINDOWS) {
        const from = new Date(Date.now() - window.hours * 3600_000).toISOString();
        const { count, error: countError } = await supabase
          .from('builder_access_requests')
          .select('id', { count: 'exact', head: true })
          .eq('source_ip', origin)
          .gte('created_at', from);
        // A count that FAILED is not a count of zero. This is the only
        // control standing between a public form and an unbounded number of
        // organisations, so a database fault refuses rather than waves
        // everything through — the opposite of how the rest of this function
        // treats a failed read, and deliberately so.
        if (countError) {
          console.error('[builder-network-admin] origin window read failed', countError);
          return json({ error: 'application_not_recorded' }, 503);
        }
        if ((count ?? 0) >= window.limit) return json({ error: window.error }, 429);
      }

      const { data: request, error: requestError } = await supabase
        .from('builder_access_requests')
        .insert({
          ...fields,
          // The value the windows above counted, so the next count sees this
          // attempt. Storing the raw header here while counting the trimmed
          // one is how a limiter comes to count a set of rows that is not
          // the set it is limiting.
          source_ip: origin,
          user_agent: typeof body.user_agent === 'string' ? body.user_agent.slice(0, 500) : null,
        })
        .select('id')
        .single();
      if (requestError || !request) {
        console.error('[builder-network-admin] access request record failed', requestError);
        return json({ error: 'application_not_recorded' }, 500);
      }

      /** Close the application off, whatever happened. */
      const settle = async (
        status: 'provisioned' | 'attached' | 'refused',
        detail: string,
        extra: Record<string, unknown> = {},
      ) => {
        const { error: settleError } = await supabase
          .from('builder_access_requests')
          .update({ status, outcome_detail: detail, ...extra })
          .eq('id', request.id);
        // Not thrown: the applicant's outcome is already decided by now. But
        // a row left `received` is what the address window reads, so a
        // failed settle is said where an operator will look.
        if (settleError) {
          console.error('[builder-network-admin] access request not settled', request.id, status, settleError);
        }
      };

      // The owner, read BEFORE anything is created. Reuses the same rules the
      // operator console's bootstrap answers to: an established account is
      // ATTACHED and never re-minted, and a withdrawn one is refused — here,
      // where the refusal leaves nothing behind it. Read after the
      // organisation it used to leave a brand-new organisation with nobody in
      // it, holding the applicant's ABN and name, so the corrected application
      // collided with the debris of the refused one.
      const { data: existingUser } = await supabase
        .from('builder_portal_users')
        .select('id, status, revoked_at, password_hash, invite_accepted_at')
        .eq('email', fields.contact_email)
        .maybeSingle();
      if (existingUser && (existingUser.revoked_at || existingUser.status === 'revoked')) {
        await settle('refused', 'that_account_has_been_withdrawn');
        return json({ error: 'that_account_has_been_withdrawn', request_id: request.id }, 409);
      }
      const established = Boolean(
        existingUser && (existingUser.password_hash || existingUser.invite_accepted_at),
      );

      const minted = established ? null : await mintBuilderInvite();
      if (!established && !minted) {
        await settle('refused', 'invite_service_unavailable');
        return json({ error: 'invite_service_unavailable', request_id: request.id }, 503);
      }

      const { data: organisation, error: organisationError } = await supabase
        .from('builder_organisations')
        .insert({
          ...organisationFromRequest(fields),
          status: 'pending_activation',
          is_active: false,
        })
        .select('id, legal_name')
        .single();
      if (organisationError || !organisation) {
        // An application that collides with an organisation that already
        // exists is REFUSED and recorded — never merged into it. Editing a
        // live builder's details from an unauthenticated form is the one
        // thing this pipeline must not do.
        const conflict = readOrganisationConflict(organisationError);
        const detail = conflict?.error ?? 'organisation_not_created';
        await settle('refused', detail);
        console.error('[builder-network-admin] access request org create failed', organisationError);
        return json({ error: detail, request_id: request.id }, conflict ? 409 : 500);
      }

      /*
       * UNDO THE ORGANISATION THIS APPLICATION CREATED, WHEN NOBODY COULD BE
       * SEATED IN IT.
       *
       * Every failure below used to leave the organisation standing — pending,
       * ownerless, unreachable by anyone, and holding the ABN, ACN and legal
       * name the applicant would type again. So the retry was refused as a
       * collision with the failed attempt's own leftover (measured 1 Oct 2026:
       * `abn_already_registered` and `legal_name_already_registered`, minutes
       * after an `owner_not_attached`), and only an operator could clear it.
       *
       * This is a ROLLBACK, not the operator act the module header forbids.
       * "Nothing here deletes an organisation" protects the network's record
       * of who was on one; this row was inserted by this request a few lines
       * above and nobody has ever been on it, which is checked rather than
       * assumed: it goes only while it holds no seat at all and is still
       * exactly as it was born. Anything else — or a delete that fails — is
       * left standing and recorded against the application, as before. The
       * application row itself is never removed, so the evidence survives the
       * organisation.
       */
      const abandon = async (
        detail: string,
        extra: Record<string, unknown> = {},
      ) => {
        let removed = false;
        const { count: seated, error: seatedError } = await supabase
          .from('builder_organisation_memberships')
          .select('id', { count: 'exact', head: true })
          .eq('organisation_id', organisation.id);
        if (!seatedError && (seated ?? 0) === 0) {
          const { data: gone, error: removeError } = await supabase
            .from('builder_organisations')
            .delete()
            .eq('id', organisation.id)
            .eq('status', 'pending_activation')
            .is('activated_at', null)
            .select('id');
          removed = !removeError && Array.isArray(gone) && gone.length === 1;
          if (removeError) {
            console.error('[builder-network-admin] unseated organisation not rolled back', removeError);
          }
        }
        await settle('refused', detail, {
          ...extra,
          organisation_id: removed ? null : organisation.id,
        });
        return removed;
      };

      let ownerId = existingUser?.id ?? null;
      if (!ownerId) {
        const { data: created, error: createError } = await supabase
          .from('builder_portal_users')
          .insert({
            email: fields.contact_email,
            name: fields.contact_name,
            status: 'invited',
            is_active: false,
          })
          .select('id')
          .single();
        if (createError || !created) {
          await abandon('owner_not_created');
          console.error('[builder-network-admin] access request owner create failed', createError);
          return json({ error: 'owner_not_created', request_id: request.id }, 500);
        }
        ownerId = created.id;
      }

      if (!established && minted) {
        /*
         * ONLY WHILE THE ACCOUNT IS STILL AN UNACCEPTED INVITATION (doc 68).
         * `established` was read above, and an account that accepts an
         * organisation's invitation in between would otherwise be written back
         * to `invited` and inactive — deactivated by somebody else's
         * application. Nor is an operator's suspension of an account that never
         * accepted lifted by somebody applying in its name (the second review).
         * Stated in the statement, and the row count read: no row means the
         * account moved on, and this refuses rather than overwrite it.
         */
        const { data: stamped, error: stampError } = await supabase
          .from('builder_portal_users')
          .update({
            name: fields.contact_name,
            invite_token_hash: minted.tokenHash,
            invite_token_expires_at: minted.expiresAt.toISOString(),
            // The token remembers its organisation, so acceptance promotes this
            // owner seat and nothing else the address may be pending in.
            invite_token_organisation_id: organisation.id,
            invited_at: new Date().toISOString(),
            status: 'invited',
            is_active: false,
          })
          .eq('id', ownerId)
          .eq('status', 'invited')
          .is('password_hash', null)
          .is('invite_accepted_at', null)
          .is('revoked_at', null)
          .select('id');
        if (stampError || !Array.isArray(stamped) || stamped.length === 0) {
          await abandon('invite_not_issued', { builder_user_id: ownerId });
          console.error('[builder-network-admin] access request invite stamp failed',
            stampError ?? 'the account is no longer an unaccepted invitation; nothing was overwritten');
          return json({ error: 'invite_not_issued', request_id: request.id }, 500);
        }
      }

      // The owner seat, through the one grant both operator doors use. An
      // account whose earlier organisation was CLOSED still holds a primary
      // seat in it, and the seat granted here used to collide with that on
      // every application from the same address (builderOwnerSeat.pure.ts).
      // A grant that changed nothing is a failure, never an attachment: this
      // door goes on to email "this organisation is now yours to run".
      const seat = await grantOwnerSeat(supabase, {
        builderUserId: ownerId,
        organisationId: organisation.id,
        accountIsActive: established,
      });
      if (!seat.ok) {
        await abandon('owner_not_attached', { builder_user_id: ownerId });
        console.error('[builder-network-admin] access request owner seat not granted', seat.reason, seat.message);
        return json({ error: 'owner_not_attached', request_id: request.id }, 500);
      }

      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: ownerId });

      // Marked BEFORE the send. The send cannot be undone, and the settle
      // after it can fail or never run; a `received` row carrying its
      // organisation is what the address window holds for the whole day
      // rather than ten minutes. Not a reason to withhold the email if it
      // fails — the organisation and invitation already exist, and an
      // applicant who is never written to is the worse outcome.
      const { error: markError } = await supabase
        .from('builder_access_requests')
        .update({ organisation_id: organisation.id, builder_user_id: ownerId })
        .eq('id', request.id);
      if (markError) {
        console.error('[builder-network-admin] access request not marked before send', request.id, markError);
      }

      // The send is the last thing and cannot unwind any of it. "We created
      // the organisation but could not write to you" is a state an operator
      // must be able to see, which is why the outcome is stored rather than
      // only returned.
      const brand = await getBrandConfig();
      const org = organisation.legal_name;
      const emailOutcome = await sendBuilderEmail({
        to: fields.contact_email,
        subject: established
          ? `You now have access to ${org} on the ${brand.companyName} Builder Portal`
          : `Your ${brand.companyName} Builder Portal access is ready`,
        brand,
        category: 'builder_network_access_request',
        content: established
          ? {
            heading: `${org} is now yours to run`,
            paragraphs: [
              `Hi ${fields.contact_name},`,
              `Thank you for applying. ${org} has been set up on the ${brand.companyName} Builder / Developer Portal and you are its owner.`,
              'You already have an account, so your existing sign-in still works — the organisation appears in the switcher next time you sign in.',
              `If you no longer remember that password, choose a new one at ${builderAppBaseUrl()}/builder/forgot-password — no new invitation is needed.`,
            ],
            action: { label: 'Open the Builder Portal', url: builderAppBaseUrl() },
            footnote: 'Your listing is reviewed before it appears in the marketplace; we will be in touch.',
          }
          : {
            heading: `Welcome to the ${brand.companyName} Builder Portal`,
            paragraphs: [
              `Hi ${fields.contact_name},`,
              `Thank you for applying. ${org} has been set up on the ${brand.companyName} Builder / Developer Portal and you are its owner.`,
              'Choose a password to activate your account, and you can then invite your colleagues.',
            ],
            action: { label: 'Set your password', url: minted!.url },
            footnote:
              `This link can be used once and expires in ${INVITE_EXPIRY_HOURS} hours. Your listing is reviewed before it appears in the marketplace; we will be in touch.`,
          },
      });

      await settle(established ? 'attached' : 'provisioned', established ? 'attached' : 'provisioned', {
        organisation_id: organisation.id,
        builder_user_id: ownerId,
        invite_sent: emailOutcome.sent,
      });
      await logActivity('network_access_request_provisioned', ownerId, organisation.id, {
        request_id: request.id,
        email: fields.contact_email,
        outcome: established ? 'attached' : 'provisioned',
        owner_seat: seat.seat,
        owner_seat_primary: seat.isPrimary,
        email_sent: emailOutcome.sent,
      });

      // The invite URL is NOT returned. This answers a public page, and the
      // link is the credential — it goes to the mailbox that asked for it and
      // nowhere else. An operator who needs to hand it over re-mints it from
      // the console, which is an authenticated act.
      return json({
        success: true,
        request_id: request.id,
        outcome: established ? 'attached' : 'provisioned',
        organisation_legal_name: organisation.legal_name,
        email_sent: emailOutcome.sent,
        email_failure: emailOutcome.sent ? null : emailOutcome.reason,
      });
    }

    if (operation === 'list_access_requests') {
      const { data, error } = await supabase
        .from('builder_access_requests')
        .select('id, legal_name, trading_name, org_type, abn, contact_name, contact_email, contact_phone, website, suburb, state, postcode, message, status, outcome_detail, organisation_id, invite_sent, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return json({ error: 'read_failed' }, 500);
      return json({ access_requests: data ?? [] });
    }

    if (operation === 'invite_organisation_owner') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id is required' }, 400);
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ error: 'a_valid_email_is_required' }, 400);
      }
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'a_name_is_required' }, 400);

      const { data: organisation } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, status')
        .eq('id', organisationId)
        .maybeSingle();
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status === 'closed') {
        return json({ error: 'a_closed_organisation_is_terminal' }, 409);
      }

      // THE BOUNDARY. Seeding an empty organisation is bootstrap; adding a
      // person to one that already has members is administering somebody
      // else's organisation, which this plane does not do (module header).
      //
      // Read-then-write, so two operators racing on the SAME new organisation
      // could both pass. Left as it is deliberately: the window is one
      // operator console against an organisation created seconds earlier, and
      // the worst outcome is two owners on a row that has never been used —
      // which an owner can fix. A lock here would be ceremony against a fault
      // nobody can produce.
      //
      // The seats are READ rather than counted, revoked ones included, because
      // one shape is not a member at all: this door's own earlier invitation
      // to the same person, still waiting. Re-issuing that is "mint another",
      // which the console has always advised and this guard used to refuse
      // (`ownerInvitationMayBeReissued`). Decided below, once the account is
      // known. A read that FAILED is not an empty organisation.
      const { data: seated, error: seatedError } = await supabase
        .from('builder_organisation_memberships')
        .select('builder_user_id, membership_role, status, revoked_at')
        .eq('organisation_id', organisationId);
      if (seatedError) {
        console.error('[builder-network-admin] owner bootstrap could not read the seats', seatedError);
        return json({ error: 'invite_failed' }, 500);
      }
      const seats = (seated ?? []) as OrganisationSeat[];

      // An account that already exists on the network is never re-minted
      // here: its owner has a password, and issuing an invite link for a live
      // account would be a credential reset dressed as an invitation.
      //
      // THAT IS A RULE ABOUT THE CREDENTIAL, NOT ABOUT THE PERSON. It used to
      // refuse the whole operation, and since `close_organisation` touches
      // only the organisation row — the account and its memberships survive —
      // anyone who had ever used the network could never be made the first
      // owner of a new one. There is no `add_member` on this plane either, so
      // the refusal named no remedy and there was none: close an
      // organisation, create its replacement, and its own owner is locked
      // out of it.
      //
      // `builder-portal-invite` had already answered this question correctly
      // for a colleague ("an address that already holds an account is not an
      // error … the membership is granted"), so the network was answering one
      // question two ways. It attaches now, exactly as the portal does: the
      // owner membership is granted, NO token is minted, nothing about the
      // account changes, and they reach the organisation with the password
      // they already have.
      const { data: existingUser } = await supabase
        .from('builder_portal_users')
        .select('id, status, revoked_at, password_hash, invite_accepted_at')
        .eq('email', email)
        .maybeSingle();
      // Withdrawal is a standing decision about the person and this surface
      // may not undo it — checked FIRST, so a revoked account is never read
      // as merely established.
      if (existingUser && (existingUser.revoked_at || existingUser.status === 'revoked')) {
        return json({ error: 'that_account_has_been_withdrawn' }, 409);
      }
      const established = Boolean(
        existingUser && (existingUser.password_hash || existingUser.invite_accepted_at),
      );

      const reissue = seats.length > 0 && ownerInvitationMayBeReissued({
        seats,
        accountId: existingUser?.id ?? null,
      });
      if (seats.length > 0 && !reissue) {
        return json({ error: 'organisation_already_has_members' }, 409);
      }

      // An established account is never re-stamped, so nothing is minted for
      // it at all — the 503 below is about storing an unpeppered token, and
      // an attach stores no token.
      const minted = established ? null : await mintBuilderInvite();
      if (!established && !minted) {
        console.error('[builder-network-admin] hashing unavailable — refusing to store an unpeppered invite token');
        return json({ error: 'invite_service_unavailable' }, 503);
      }

      let ownerId = existingUser?.id ?? null;
      if (!ownerId) {
        const { data: created, error: createError } = await supabase
          .from('builder_portal_users')
          .insert({ email, name, status: 'invited', is_active: false })
          .select('id')
          .single();
        if (createError || !created) {
          console.error('[builder-network-admin] owner create failed', createError);
          return json({ error: 'invite_failed' }, 500);
        }
        ownerId = created.id;
      }

      // Their name, their status, their password: an attach touches none of
      // them. Re-stamping `status: 'invited'` on somebody who has already
      // accepted would take their access away until they clicked a link
      // nobody sent them.
      if (!established && minted) {
        // Only while still an unaccepted invitation, and the count read — as
        // above (doc 68): never over an activation, nor over a suspension.
        const { data: stamped, error: inviteError } = await supabase
          .from('builder_portal_users')
          .update({
            name,
            invite_token_hash: minted.tokenHash,
            invite_token_expires_at: minted.expiresAt.toISOString(),
            // The token remembers its organisation — see the access-request
            // door above and `builderInviteScope.pure.ts`.
            invite_token_organisation_id: organisationId,
            invited_at: new Date().toISOString(),
            status: 'invited',
            is_active: false,
          })
          .eq('id', ownerId)
          .eq('status', 'invited')
          .is('password_hash', null)
          .is('invite_accepted_at', null)
          .is('revoked_at', null)
          .select('id');
        if (inviteError || !Array.isArray(stamped) || stamped.length === 0) {
          console.error('[builder-network-admin] invite stamp failed',
            inviteError ?? 'the account is no longer an unaccepted invitation; nothing was overwritten');
          return json({ error: 'invite_failed' }, 500);
        }
      }

      /*
       * WHOSE PERSON IS THIS? Read BEFORE the grant below adds this
       * organisation's own row, so the answer is about where the account
       * already belonged. A read that FAILED withholds the link — fail closed,
       * rather than decide on missing evidence.
       */
      const { data: ownerMemberships, error: ownerScopeError } = await supabase
        .from('builder_organisation_memberships')
        .select('organisation_id')
        .eq('builder_user_id', ownerId)
        .is('revoked_at', null);
      const linkIsTheirs = !ownerScopeError && operatorMayHandLink({
        liveMemberships: (ownerMemberships ?? []) as { organisation_id: string }[],
        newOrganisationId: organisationId,
      });
      if (!linkIsTheirs) {
        console.warn('[builder-network-admin] owner link withheld — the account belongs elsewhere', {
          organisation_id: organisationId,
          scope_unreadable: !!ownerScopeError,
        });
      }

      // The owner seat, through the one grant both operator doors use. This
      // door failed six times running on 1 Oct 2026 with `invite_failed` and
      // nothing else: the address had owned an organisation that was later
      // CLOSED, still held its primary seat there, and every attempt to seat
      // it here collided with that one (builderOwnerSeat.pure.ts).
      const seat = await grantOwnerSeat(supabase, {
        builderUserId: ownerId,
        organisationId: organisationId,
        accountIsActive: established,
      });
      if (!seat.ok) {
        console.error('[builder-network-admin] owner seat not granted', seat.reason, seat.message);
        // A seat this organisation already holds for them in another shape —
        // suspended, or not an owner — is somebody's decision, so it is named
        // rather than overruled. Everything else is the old `invite_failed`.
        return seat.reason === 'seat_held_otherwise'
          ? json({ error: 'owner_seat_held_otherwise' }, 409)
          : json({ error: 'invite_failed' }, 500);
      }

      await supabase.rpc('builder_ensure_onboarding_steps', { _builder_user_id: ownerId });

      // The send is OPTIONAL and always LAST: the membership is already
      // granted and the token already stored, so a mail failure must never
      // read as an invitation that was not issued. Its outcome travels back
      // beside the link rather than instead of it.
      //
      // Except where the link is WITHHELD from the operator: then the email
      // is the only road the credential has to its owner, and a console that
      // unticked "Email it to them" would leave a person invited by a link
      // nobody holds — with this door refusing a second attempt, because the
      // organisation now has a member. Writing to the address the invitation
      // is FOR hands nobody else anything.
      const mustEmail = !established && !linkIsTheirs;
      const emailRequested = body.send_email === true || mustEmail;
      let emailOutcome: InviteEmailOutcome | null = null;
      if (emailRequested) {
        const brand = await getBrandConfig();
        const org = organisation.legal_name;
        emailOutcome = await sendBuilderEmail({
          to: email,
          subject: established
            ? `You now have access to ${org} on the ${brand.companyName} Builder Portal`
            : `You have been invited to lead ${org} on the ${brand.companyName} Builder Portal`,
          brand,
          category: 'builder_network_owner_invite',
          content: established
            ? {
                heading: `${org} is now yours to run`,
                paragraphs: [
                  `Hi ${name},`,
                  `You have been made the owner of ${org} on the ${brand.companyName} Builder / Developer Portal.`,
                  'Your existing sign-in still works — nothing about your account has changed. The organisation appears in the switcher next time you sign in.',
                  `If you no longer remember that password, choose a new one at ${builderAppBaseUrl()}/builder/forgot-password — no new invitation is needed.`,
                ],
                action: { label: 'Open the Builder Portal', url: builderAppBaseUrl() },
                footnote: 'As its owner you can invite your own colleagues from inside the portal.',
              }
            : {
                heading: `You have been invited to lead ${org}`,
                paragraphs: [
                  `Hi ${name},`,
                  `You have been invited to set up ${org} on the ${brand.companyName} Builder / Developer Portal as its owner.`,
                  'Choose a password to activate the account, and you can then invite your own colleagues.',
                ],
                action: { label: 'Set your password', url: minted!.url },
                footnote: `This link can be used once and expires in ${INVITE_EXPIRY_HOURS} hours. If it lapses, ask for another.`,
              },
        });
      }

      await logActivity(
        established ? 'network_organisation_owner_attached' : 'network_organisation_owner_invited',
        ownerId,
        organisationId,
        {
          email,
          membership_role: 'owner',
          outcome: established ? 'attached' : 'invited',
          owner_seat: seat.seat,
          owner_seat_primary: seat.isPrimary,
          link_withheld: !established && !linkIsTheirs,
          reissued: reissue,
          email_sent: emailOutcome?.sent ?? null,
        },
      );

      // Two outcomes, said plainly, because they hand the operator different
      // work: an invitation leaves a one-time link that only exists in this
      // response (the hash is all that is stored), and an attach leaves
      // nothing to pass on because the person already has a password.
      return json({
        success: true,
        outcome: established ? 'attached' : 'invited',
        /*
         * THE OPERATOR DOOR ANSWERS TO THE SAME LINK RULE AS THE PORTAL'S.
         *
         * This returned a working one-time credential for any address that was
         * not yet established — which includes a real tenant's PENDING
         * INVITEE, since `established` is `password_hash || invite_accepted_at`
         * and a pending invitee has neither. So an operator could create an
         * empty organisation, invite that address as its owner, receive the
         * link, accept it, set a password and stamp the mailbox verified: the
         * account is then theirs, and every live membership it holds comes with
         * it. The first fix guarded the portal door and left this one, which is
         * the stronger of the two.
         *
         * `submit_access_request`, one door along, already got this right and
         * says so: "the link is the credential".
         */
        invite_url: established || !linkIsTheirs ? null : minted!.url,
        /*
         * WHY THE LINK IS ABSENT, said rather than left for the console to
         * guess. An invitation was minted and stored — the address can accept
         * it from the email — but this response does not carry it, because
         * the account already belongs to another organisation (a closed one
         * counts: its seat still names the person). The console read the
         * absence as an empty link and drew an empty box to copy it from.
         */
        link_withheld: !established && !linkIsTheirs,
        // The same person's waiting invitation issued again: any link minted
        // before this one no longer works.
        reissued: reissue,
        expires_at: established ? null : minted!.expiresAt.toISOString(),
        expires_in_hours: established ? null : INVITE_EXPIRY_HOURS,
        organisation_legal_name: organisation.legal_name,
        email_requested: emailRequested,
        email_sent: emailOutcome?.sent ?? false,
        email_failure: emailOutcome && !emailOutcome.sent ? emailOutcome.reason : null,
      });
    }

    // ------------------------------------------------------------- directory
    if (operation === 'upsert_workspace') {
      const mcCloneId = String(body.mc_clone_id || '');
      const slug = String(body.slug || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mcCloneId)) {
        return json({ error: 'mc_clone_id_must_be_a_uuid' }, 400);
      }
      if (!slug) return json({ error: 'slug_is_required' }, 400);
      const { data, error } = await supabase
        .from('workspace_registry')
        .upsert({
          mc_clone_id: mcCloneId,
          slug,
          display_name: String(body.display_name || '').trim() || null,
          last_asserted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'mc_clone_id' })
        .select('id, mc_clone_id, slug, display_name')
        .single();
      if (error || !data) {
        console.error('[builder-network-admin] workspace upsert failed', error);
        return json({ error: 'upsert_failed' }, 500);
      }
      return json({ success: true, workspace: data });
    }

    if (operation === 'create_connection') {
      const mcCloneId = String(body.mc_clone_id || '');
      const organisationId = String(body.builder_organisation_id || '');
      if (!mcCloneId || !organisationId) {
        return json({ error: 'mc_clone_id_and_builder_organisation_id_are_required' }, 400);
      }
      const [{ data: workspace }, { data: organisation }] = await Promise.all([
        supabase.from('workspace_registry').select('id, slug').eq('mc_clone_id', mcCloneId).maybeSingle(),
        supabase.from('builder_organisations').select('id, status').eq('id', organisationId).maybeSingle(),
      ]);
      if (!workspace) return json({ error: 'workspace_not_registered' }, 404);
      if (!organisation) return json({ error: 'organisation_not_found' }, 404);
      if (organisation.status !== 'active') {
        return json({ error: 'organisation_not_active' }, 409);
      }

      // One LIVE connection per pair. Revoked rows do not count — that is
      // exactly what "reconnection is a new row" means.
      const { data: existing } = await supabase
        .from('workspace_connections')
        .select('id, state')
        .eq('workspace_id', workspace.id)
        .eq('builder_organisation_id', organisation.id)
        .in('state', ['invited', 'active'])
        .maybeSingle();
      if (existing) {
        return json({ error: 'a_live_connection_already_exists', state: existing.state }, 409);
      }

      const inviteCode = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const inviteCodeHash = await hashSessionToken(inviteCode);
      if (!inviteCodeHash) return json({ error: 'hashing_unavailable' }, 503);

      const { data: created, error } = await supabase
        .from('workspace_connections')
        .insert({
          workspace_id: workspace.id,
          builder_organisation_id: organisation.id,
          state: 'invited',
          initiated_by: 'workspace',
          invite_code_hash: inviteCodeHash,
          invite_expires_at: new Date(Date.now() + INVITE_CODE_EXPIRY_DAYS * 86_400_000).toISOString(),
        })
        .select('id')
        .single();
      if (error || !created) {
        console.error('[builder-network-admin] connection insert failed', error);
        return json({ error: 'create_failed' }, 500);
      }
      await supabase.from('workspace_connection_events').insert({
        connection_id: created.id,
        event_type: 'connection_invited',
        actor_side: 'platform',
        detail: { mc_operator: operator, workspace_slug: workspace.slug },
      });
      await logActivity('network_connection_invited', created.id, organisation.id, { workspace_slug: workspace.slug });
      return json({
        success: true,
        connection_id: created.id,
        // Returned ONCE; only the hash is stored. It travels to the builder
        // out of band and is consumed by builder-network-connections.
        invite_code: inviteCode,
        expires_at: new Date(Date.now() + INVITE_CODE_EXPIRY_DAYS * 86_400_000).toISOString(),
      });
    }

    if (operation === 'revoke_connection') {
      const connectionId = String(body.connection_id || '');
      const reason = String(body.reason || '').trim();
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      if (!reason) return json({ error: 'a_reason_is_required' }, 400);
      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({
          state: 'revoked',
          revoked_at: new Date().toISOString(),
          revoke_reason: reason,
          // Revocation retires the transport credential WITH the connection:
          // the secret is gone at rest, not merely unreachable, and a future
          // reconnection is a new row with a new secret.
          outbound_hmac_secret: null,
          hmac_provisioned_at: null,
        })
        .eq('id', connectionId)
        .neq('state', 'revoked')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'not_revocable' }, 409);
      await supabase.from('workspace_connection_events').insert({
        connection_id: connectionId,
        event_type: 'connection_revoked',
        actor_side: 'platform',
        detail: { mc_operator: operator, reason },
      });
      return json({ success: true, state: 'revoked' });
    }

    // ------------------------------------------------------------- transport
    // The courier half of the handshake. Acceptance (builder-network-
    // connections) MINTS the per-connection symmetric secret and stores it
    // RLS-closed; the clone's builder-network-inbound and this network's
    // outbox worker both need it, and Mission Control — which provisions the
    // clone and holds ITS service credentials, never this project's — is the
    // machinery that installs it clone-side (the prime's mirror migration
    // says exactly this). So the secret leaves this project EXACTLY ONCE,
    // through this federation-asserted door, and never through any Builder
    // Portal read: `provision_transport` returns it once and stamps
    // `hmac_provisioned_at`; afterwards only `rotate_transport` — which
    // mints a NEW secret — returns anything, so a compromised operator
    // token cannot quietly re-read a live credential. Neither event row
    // carries the secret.
    if (operation === 'provision_transport' || operation === 'rotate_transport') {
      const connectionId = String(body.connection_id || '');
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      const { data: connection } = await supabase
        .from('workspace_connections')
        .select('id, state, outbound_hmac_secret, hmac_provisioned_at')
        .eq('id', connectionId)
        .maybeSingle();
      if (!connection) return json({ error: 'connection_not_found' }, 404);
      if (connection.state !== 'active') {
        // Not yet accepted → no secret exists; revoked → none may exist.
        return json({ error: 'transport_provisions_only_on_an_active_connection', state: connection.state }, 409);
      }

      const networkInboundUrl =
        `${String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')}/functions/v1/builder-network-inbound`;

      if (operation === 'provision_transport') {
        if (connection.hmac_provisioned_at) {
          return json({
            error: 'transport_already_provisioned',
            provisioned_at: connection.hmac_provisioned_at,
            remedy: 'rotate_transport issues a new secret and invalidates the old one',
          }, 409);
        }
        if (!connection.outbound_hmac_secret) {
          // Active but secretless should be impossible (acceptance mints);
          // refuse rather than mint here so the mint stays in one place.
          return json({ error: 'connection_has_no_transport_secret' }, 409);
        }
        const { data: stamped } = await supabase
          .from('workspace_connections')
          .update({ hmac_provisioned_at: new Date().toISOString() })
          .eq('id', connection.id)
          .is('hmac_provisioned_at', null)
          .select('id')
          .maybeSingle();
        // A concurrent provision lost the conditional update: the secret was
        // already handed out once, and once is the contract.
        if (!stamped) return json({ error: 'transport_already_provisioned' }, 409);

        await supabase.from('workspace_connection_events').insert({
          connection_id: connection.id,
          event_type: 'transport_provisioned',
          actor_side: 'platform',
          detail: { mc_operator: operator },
        });
        return json({
          success: true,
          connection_id: connection.id,
          // Returned ONCE, for MC to install in the clone's
          // builder_network_connections row alongside this URL.
          hmac_secret: connection.outbound_hmac_secret,
          network_inbound_url: networkInboundUrl,
        });
      }

      // rotate_transport: a NEW secret, returned once. The old one stops
      // verifying the moment this commits — deliveries in flight retry with
      // the new signature on the worker's next pass.
      const rotated = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      const { data: stamped } = await supabase
        .from('workspace_connections')
        .update({
          outbound_hmac_secret: rotated,
          hmac_provisioned_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('state', 'active')
        .select('id')
        .maybeSingle();
      if (!stamped) return json({ error: 'transport_rotation_failed' }, 409);

      await supabase.from('workspace_connection_events').insert({
        connection_id: connection.id,
        event_type: 'transport_rotated',
        actor_side: 'platform',
        detail: { mc_operator: operator },
      });
      return json({
        success: true,
        connection_id: connection.id,
        hmac_secret: rotated,
        network_inbound_url: networkInboundUrl,
      });
    }

    if (operation === 'set_inbound_url') {
      const connectionId = String(body.connection_id || '');
      const inboundUrl = String(body.inbound_url || '').trim();
      if (!connectionId) return json({ error: 'connection_id_is_required' }, 400);
      if (!/^https:\/\//.test(inboundUrl)) return json({ error: 'inbound_url_must_be_https' }, 400);
      const { data: updated } = await supabase
        .from('workspace_connections')
        .update({ inbound_url: inboundUrl })
        .eq('id', connectionId)
        .neq('state', 'revoked')
        .select('id')
        .maybeSingle();
      if (!updated) return json({ error: 'connection_not_found_or_revoked' }, 404);
      await supabase.from('workspace_connection_events').insert({
        connection_id: connectionId,
        event_type: 'transport_configured',
        actor_side: 'platform',
        detail: { mc_operator: operator },
      });
      return json({ success: true });
    }


    // ================================================================ ranking
    /*
     * MISSION CONTROL'S HAND ON THE MARKETPLACE.
     *
     * The ranking is computed from evidence and published to every clone, and
     * these four operations are the only way a person changes it. They are
     * deliberately NOT a way to edit a score: a pin, a suppression and a freeze
     * sit BESIDE the computed answer rather than overwriting it, so the score
     * stays a true statement about the builder and the intervention stays
     * legible as an intervention for as long as the row exists.
     *
     * There is no `set_merit_score`, and there must never be one. An operator
     * who could type a merit score could tell a builder a number that no
     * evidence produced, and every explanation this feature offers — the
     * signal breakdown, the confidence, the list of what could not be measured
     * — would become decoration over a hand-entered figure.
     */

    if (operation === 'ranking_overview') {
      const [{ data: state }, { data: snapshots }, { data: overrides }, { data: placements }] =
        await Promise.all([
          supabase.from('builder_ranking_state').select('*').eq('id', true).maybeSingle(),
          supabase.from('builder_ranking_snapshots')
            .select('organisation_id, merit_score, confidence, measured_score, band, computed_at, ranking_version')
            .order('merit_score', { ascending: false }),
          supabase.from('builder_ranking_overrides')
            .select('id, organisation_id, kind, position, reason, created_by, created_at, expires_at')
            .is('revoked_at', null),
          supabase.from('builder_commercial_placements')
            .select('id, organisation_id, tier, priority, starts_at, ends_at, note, created_by')
            .is('revoked_at', null),
        ]);

      // Names, so an operator is never asked to act on a uuid.
      const ids = [...new Set((snapshots ?? []).map((row) => row.organisation_id))];
      const { data: organisations } = ids.length
        ? await supabase.from('builder_organisations')
          .select('id, legal_name, trading_name, status').in('id', ids)
        : { data: [] as Record<string, unknown>[] };

      const liveStock = await supabase
        .from('builder_stock_items')
        .select('organisation_id')
        .eq('lifecycle_status', 'active');
      const stockCount = new Map<string, number>();
      for (const row of liveStock.data ?? []) {
        stockCount.set(row.organisation_id, (stockCount.get(row.organisation_id) ?? 0) + 1);
      }

      return json({
        state: state ?? null,
        builders: (snapshots ?? []).map((row) => {
          const org = (organisations ?? []).find((o) => o.id === row.organisation_id);
          return {
            ...row,
            legal_name: org?.legal_name ?? null,
            trading_name: org?.trading_name ?? null,
            status: org?.status ?? null,
            live_stock: stockCount.get(row.organisation_id) ?? 0,
            override: (overrides ?? []).find((o) => o.organisation_id === row.organisation_id) ?? null,
            placement: (placements ?? []).find((p) => p.organisation_id === row.organisation_id) ?? null,
          };
        }),
      });
    }

    if (operation === 'ranking_explain') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      const { data: snapshot } = await supabase
        .from('builder_ranking_snapshots')
        .select('*')
        .eq('organisation_id', organisationId)
        .maybeSingle();
      if (!snapshot) return json({ error: 'not_yet_ranked' }, 404);
      return json({ snapshot });
    }

    if (operation === 'ranking_set_override') {
      const organisationId = String(body.organisation_id || '');
      const kind = String(body.kind || '');
      const reason = String(body.reason || '').trim();
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (kind !== 'pin' && kind !== 'suppress') return json({ error: 'kind_must_be_pin_or_suppress' }, 400);
      // The same floor the column enforces, said here so the operator gets a
      // sentence rather than a constraint violation.
      if (reason.length < 10) return json({ error: 'reason_must_be_written' }, 400);

      const position = kind === 'pin' ? Number(body.position) : null;
      if (kind === 'pin' && (!Number.isInteger(position) || (position as number) < 1 || (position as number) > 500)) {
        return json({ error: 'position_must_be_between_1_and_500' }, 400);
      }

      /*
       * An expiry is the default and a standing override has to be ASKED for.
       * `expires_at: null` in the body is that ask, and it is distinguished
       * from the field being absent — omitting it takes the column's ninety-day
       * default, which is the behaviour that stops a forgotten pin shaping the
       * marketplace for a year.
       */
      const explicitExpiry = Object.prototype.hasOwnProperty.call(body, 'expires_at');
      const expiresAt = explicitExpiry ? body.expires_at : undefined;
      if (explicitExpiry && expiresAt !== null && Number.isNaN(Date.parse(String(expiresAt)))) {
        return json({ error: 'expires_at_must_be_a_timestamp_or_null' }, 400);
      }

      // One live override of each kind per builder: replace rather than stack,
      // and keep the one being replaced as history.
      await supabase.from('builder_ranking_overrides')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_by: operator,
          revoked_reason: 'replaced by a newer override',
        })
        .eq('organisation_id', organisationId)
        .eq('kind', kind)
        .is('revoked_at', null);

      const row: Record<string, unknown> = {
        organisation_id: organisationId,
        kind,
        position: kind === 'pin' ? position : null,
        reason,
        created_by: operator,
      };
      if (explicitExpiry) row.expires_at = expiresAt;

      const { data: created, error } = await supabase
        .from('builder_ranking_overrides')
        .insert(row)
        .select('id, organisation_id, kind, position, reason, created_at, expires_at')
        .maybeSingle();
      if (error) {
        console.error('[builder-network-admin] override insert failed', error.message);
        return json({ error: 'override_not_recorded' }, 400);
      }

      await logActivity('builder_ranking_override_set', created?.id ?? null, organisationId, {
        kind, position: created?.position ?? null, expires_at: created?.expires_at ?? null,
      });
      return json({ success: true, override: created });
    }

    if (operation === 'ranking_clear_override') {
      const organisationId = String(body.organisation_id || '');
      const kind = String(body.kind || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (kind !== 'pin' && kind !== 'suppress') return json({ error: 'kind_must_be_pin_or_suppress' }, 400);

      // Revoked, never deleted. A register of who moved the marketplace and
      // why is the whole reason the table exists.
      const { data: cleared } = await supabase
        .from('builder_ranking_overrides')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_by: operator,
          revoked_reason: typeof body.reason === 'string' ? body.reason : null,
        })
        .eq('organisation_id', organisationId)
        .eq('kind', kind)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
      if (!cleared) return json({ error: 'no_live_override_of_that_kind' }, 404);

      await logActivity('builder_ranking_override_cleared', cleared.id, organisationId, { kind });
      return json({ success: true });
    }

    if (operation === 'ranking_set_freeze') {
      const frozen = body.frozen === true;
      const reason = String(body.reason || '').trim();
      if (frozen && reason.length < 10) return json({ error: 'reason_must_be_written' }, 400);

      /*
       * FREEZING HOLDS THE PUBLISHED ORDER STILL. It does not fall back to a
       * default ordering and it does not clear anything: a marketplace that
       * reshuffles the moment something goes wrong is a second incident on top
       * of the first. Recompute reads this before it writes, so a freeze takes
       * effect at the next run rather than needing the scheduler stopped.
       */
      const { error } = await supabase.from('builder_ranking_state').update({
        frozen,
        frozen_reason: frozen ? reason : null,
        frozen_by: frozen ? operator : null,
        frozen_at: frozen ? new Date().toISOString() : null,
      }).eq('id', true);
      if (error) {
        console.error('[builder-network-admin] freeze failed', error.message);
        return json({ error: 'freeze_not_recorded' }, 400);
      }

      await logActivity(frozen ? 'builder_ranking_frozen' : 'builder_ranking_unfrozen', null, null, {});
      return json({ success: true, frozen });
    }

    if (operation === 'ranking_set_placement') {
      const organisationId = String(body.organisation_id || '');
      const tier = String(body.tier || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      if (!['partner', 'premium', 'featured'].includes(tier)) {
        return json({ error: 'tier_must_be_partner_premium_or_featured' }, 400);
      }
      const priority = Number.isInteger(Number(body.priority)) ? Number(body.priority) : 100;
      if (priority < 1 || priority > 1000) return json({ error: 'priority_must_be_between_1_and_1000' }, 400);

      await supabase.from('builder_commercial_placements')
        .update({ revoked_at: new Date().toISOString(), revoked_by: operator })
        .eq('organisation_id', organisationId)
        .is('revoked_at', null);

      const { data: created, error } = await supabase
        .from('builder_commercial_placements')
        .insert({
          organisation_id: organisationId,
          tier,
          priority,
          ends_at: body.ends_at ?? null,
          note: typeof body.note === 'string' ? body.note : null,
          created_by: operator,
        })
        .select('id, organisation_id, tier, priority, starts_at, ends_at')
        .maybeSingle();
      if (error) {
        console.error('[builder-network-admin] placement insert failed', error.message);
        return json({ error: 'placement_not_recorded' }, 400);
      }

      await logActivity('builder_commercial_placement_set', created?.id ?? null, organisationId, {
        tier, priority, ends_at: created?.ends_at ?? null,
      });
      return json({ success: true, placement: created });
    }

    if (operation === 'ranking_clear_placement') {
      const organisationId = String(body.organisation_id || '');
      if (!organisationId) return json({ error: 'organisation_id_is_required' }, 400);
      const { data: cleared } = await supabase
        .from('builder_commercial_placements')
        .update({ revoked_at: new Date().toISOString(), revoked_by: operator })
        .eq('organisation_id', organisationId)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
      if (!cleared) return json({ error: 'no_live_placement' }, 404);
      await logActivity('builder_commercial_placement_cleared', cleared.id, organisationId, {});
      return json({ success: true });
    }

    return json({ error: `unknown_operation:${operation}` }, 400);
  } catch (error) {
    console.error('[builder-network-admin] error', error);
    return json({ error: 'internal_error' }, 500);
  }
});
