/**
 * Builder / Developer Portal — Workspace
 *
 * Portal-facing dashboard summary, activity history, organisation settings and
 * user settings. Mirrors `builder-portal-collaboration`: cookie session,
 * governance gate, server-held active organisation, guarded transactional
 * commands.
 *
 * This module reads ACROSS the others rather than owning an aggregate, which
 * makes two boundaries the whole point of the function:
 *
 *   * Every dashboard number comes from an accessible-set function, so a count
 *     can never reveal a record the caller cannot open.
 *   * The activity feed is `builder_visible_activity`, which refuses identity
 *     and administration entity types outright and resolves everything else
 *     through the resolver that governs the record itself. A user who cannot
 *     open a defect cannot read that the defect changed.
 *
 * DATA BOUNDARY: the activity projection carries no `previous_state`,
 * `new_state`, `ip_address` or `user_agent` — those are the Command Centre's
 * forensic record. Settings carry contact and display preferences only.
 *
 * Operations
 *   workspace_summary | activity_history
 *   get_organisation_settings | save_organisation_settings
 *   get_my_preferences | save_my_preferences | complete_onboarding_tour
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
} from '../_shared/builderPortalAuth.ts';
import {
  BUILDER_ORGANISATION_SETTINGS_SELECT,
  BUILDER_USER_PREFERENCES_SELECT,
  BUILDER_ACTIVITY_ENTITY_TYPES,
  buildOrganisationSettingsPayload,
  buildUserPreferencesPayload,
  workspaceCommandFailure,
  cleanEnum,
  cleanLimit,
  cleanText,
} from '../_shared/builderWorkspace.ts';

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, any>));
    const operation = String(body.operation || '');

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error || 'Unauthorised', code: session.code }, session.status || 401);
    }
    const me = session.user;
    const governanceError = builderGovernanceError(session);
    if (governanceError) return json({ error: 'Portal setup required', code: governanceError }, 403);

    // The organisation is the SESSION's, never the request's. Every read and
    // write below is pinned to it.
    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }
    const membershipRole = session.active_organisation?.membership_role ?? '';

    const fail = (message: string, fallbackStatus = 400, fallbackError = 'The request failed') => {
      const mapped = workspaceCommandFailure(message);
      return mapped
        ? json({ error: mapped.error, code: mapped.code }, mapped.status)
        : json({ error: fallbackError }, fallbackStatus);
    };

    /**
     * Read expected_version for an update. Missing is a hard 400: it is never
     * silently replaced with the current database value.
     */
    const requireVersion = (): number | { error: Response } => {
      const supplied = Number(body.expected_version);
      if (!Number.isInteger(supplied) || supplied < 1) {
        return {
          error: json({
            error: 'expected_version is required when updating an existing record',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400),
        };
      }
      return supplied;
    };

    // ───────────────────────── DASHBOARD ─────────────────────────
    if (operation === 'workspace_summary') {
      const { data, error } = await supabase.rpc('builder_workspace_summary', {
        _user_id: me.id, _organisation_id: activeOrganisationId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        success: true,
        projects: Number(row?.projects ?? 0),
        units: Number(row?.units ?? 0),
        transactions: Number(row?.transactions ?? 0),
        construction_cases: Number(row?.construction_cases ?? 0),
        open_defects: Number(row?.open_defects ?? 0),
        documents: Number(row?.documents ?? 0),
        open_conversations: Number(row?.open_conversations ?? 0),
        open_tasks: Number(row?.open_tasks ?? 0),
        overdue_tasks: Number(row?.overdue_tasks ?? 0),
        unread_messages: Number(row?.unread_messages ?? 0),
        unread_notifications: Number(row?.unread_notifications ?? 0),
      });
    }

    // ───────────────────────── ACTIVITY ─────────────────────────
    if (operation === 'activity_history') {
      // A filter narrows within what is already permitted. An entity type
      // outside the portal-visible list is rejected here and refused again by
      // the database, which is the authority.
      const entityType = 'entity_type' in body
        ? cleanEnum(body.entity_type, BUILDER_ACTIVITY_ENTITY_TYPES)
        : null;
      if ('entity_type' in body && body.entity_type && !entityType) {
        return json({ error: 'That record type has no activity history' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_visible_activity', {
        _user_id: me.id,
        _organisation_id: activeOrganisationId,
        _entity_type: entityType,
        _entity_id: cleanText(body.entity_id, 64),
        _limit: cleanLimit(body.limit, 50, 200),
      });
      if (error) throw error;
      return json({ success: true, records: data || [] });
    }

    // ───────────────────────── ORGANISATION SETTINGS ─────────────────────────
    if (operation === 'get_organisation_settings') {
      const { data } = await supabase.from('builder_organisation_settings')
        .select(BUILDER_ORGANISATION_SETTINGS_SELECT)
        .eq('organisation_id', activeOrganisationId).maybeSingle();
      return json({
        success: true,
        settings: data ?? null,
        // The client uses this only to decide whether to render the form as
        // editable. The write path re-checks it and is the authority.
        can_edit: ['owner', 'administrator'].includes(membershipRole),
      });
    }

    if (operation === 'save_organisation_settings') {
      // Organisation settings are an ORGANISATION-level change: only an owner or
      // administrator of the active organisation may make one. The role comes
      // from the verified session, never the request.
      if (!['owner', 'administrator'].includes(membershipRole)) {
        return json({ error: 'You do not have permission to change organisation settings' }, 403);
      }

      const { data: existing } = await supabase.from('builder_organisation_settings')
        .select('id').eq('organisation_id', activeOrganisationId).maybeSingle();

      let expectedVersion: number | null = null;
      if (existing) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      }

      const { data, error } = await supabase.rpc('builder_upsert_organisation_settings', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _organisation_id: activeOrganisationId,
        _payload: buildOrganisationSettingsPayload(body),
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The settings could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── USER SETTINGS ─────────────────────────
    if (operation === 'get_my_preferences') {
      // Always the caller's own row. No id from the request selects whose.
      const { data } = await supabase.from('builder_user_preferences')
        .select(BUILDER_USER_PREFERENCES_SELECT)
        .eq('builder_user_id', me.id).maybeSingle();
      return json({ success: true, preferences: data ?? null });
    }

    // Guided onboarding tour completion.
    //
    // A separate operation rather than a field on save_my_preferences: it is
    // idempotent, writes exactly one column, and must not 409 against the
    // preferences form's expected_version. The owner is always the session
    // user — no id is taken from the body.
    if (operation === 'complete_onboarding_tour') {
      const { data, error } = await supabase.rpc('builder_complete_onboarding_tour', {
        _builder_user_id: me.id,
      });
      if (error) return fail(error.message);
      return json({ success: true, tour_completed_at: data ?? null });
    }

    if (operation === 'save_my_preferences') {
      const { data: existing } = await supabase.from('builder_user_preferences')
        .select('id').eq('builder_user_id', me.id).maybeSingle();

      let expectedVersion: number | null = null;
      if (existing) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      }

      const { data, error } = await supabase.rpc('builder_upsert_user_preferences', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        // The owner is the SESSION user. A request naming someone else's id
        // reaches nothing, because no id from the body is passed.
        _actor_builder_user_id: me.id,
        _payload: buildUserPreferencesPayload(body),
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'Your preferences could not be saved');
      return json({ success: true, record: data });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-workspace]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
