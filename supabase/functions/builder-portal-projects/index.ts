/**
 * Builder / Developer Portal — Projects (Phase 3)
 *
 * Portal-facing project workspace. Mirrors `solicitor-portal-matters`
 * operation-for-operation. Every operation is scoped by the caller's session, an
 * explicit project grant AND an exact non-null organisation on the named side,
 * then gated on the tri-state permission matrix.
 *
 * Financial, commission, AML and client-position data is never selected here.
 * `builder_invoices` and `build_progress_payments` are Finance-owned and are not
 * referenced by this function at all.
 *
 * Operations
 *   list_projects | get_project | update_project | set_status
 *   list_parties | upsert_party | delete_party
 *   status_history | project_stats
 *
 * Divergences from the Solicitor original, all deliberate:
 *   * The session is resolved from the HttpOnly cookie only (Phase 0 NOCOPY-02).
 *   * There is no legacy rollback path. The Solicitor function still carries a
 *     client-assignment fallback; Builder has one authorization model.
 *   * A project id in the body is a lookup key, never authority: every load goes
 *     through `resolveBuilderProjectAccess` and re-resolves permissions.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
  resolveBuilderProjectAccess,
  resolveBuilderProjectPermissions,
  listAccessibleBuilderProjectIds,
  logBuilderProjectActivity,
  builderMatrixCan,
  type BuilderPermissionMatrix,
} from '../_shared/builderPortalAuth.ts';
import {
  BUILDER_PROJECT_PORTAL_LIST_SELECT,
  BUILDER_PROJECT_PORTAL_DETAIL_SELECT,
  BUILDER_PARTY_SELECT,
  BUILDER_PROJECT_STATUS_HISTORY_SELECT,
  BUILDER_PROJECT_STATUSES,
  buildProjectPayload,
  buildPartyPayload,
  cleanEnum,
  cleanText,
} from '../_shared/builderProjects.ts';

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

    // The session's active organisation is server-held. A browser-supplied
    // organisation_id is never consulted anywhere in this function.
    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }

    const accessibleProjectIds = await listAccessibleBuilderProjectIds(
      supabase, me.id, activeOrganisationId);

    /** Load a project and confirm this builder user may see it. */
    const loadProject = async (projectId: string): Promise<
      { ok: true; project: any; perms: BuilderPermissionMatrix; accessRole: string }
      | { ok: false; status: number; error: string }
    > => {
      if (!projectId) return { ok: false, status: 400, error: 'project_id is required' };

      const access = await resolveBuilderProjectAccess(supabase, me.id, projectId);
      // No live grant is reported as "not found", not "forbidden": a caller must
      // not be able to discover that a project exists by probing ids.
      if (!access) return { ok: false, status: 404, error: 'Project not found' };

      // The grant must run through the organisation this session is acting as.
      // Otherwise switching organisation would silently widen what is visible.
      if (access.organisation_id !== activeOrganisationId) {
        return { ok: false, status: 404, error: 'Project not found' };
      }

      const { data: project } = await supabase
        .from('builder_projects')
        .select(BUILDER_PROJECT_PORTAL_DETAIL_SELECT)
        .eq('id', projectId)
        .maybeSingle();
      if (!project) return { ok: false, status: 404, error: 'Project not found' };

      // The project must still name the granting organisation on the granted
      // side — the grant alone is not enough if the project has since moved.
      const sideOrg = access.organisation_side === 'developer'
        ? project.developer_organisation_id
        : project.builder_organisation_id;
      if (!sideOrg || sideOrg !== access.organisation_id) {
        return { ok: false, status: 404, error: 'Project not found' };
      }

      const perms = await resolveBuilderProjectPermissions(supabase, access);
      if (!builderMatrixCan(perms, 'projects', 'view')) {
        return { ok: false, status: 403, error: 'You do not have access to this project' };
      }
      return { ok: true, project, perms, accessRole: access.access_role };
    };

    // ───────────────────────── LIST ─────────────────────────
    if (operation === 'list_projects') {
      if (!accessibleProjectIds.length) {
        return json({
          success: true,
          records: [],
          pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 },
        });
      }

      const page = Math.max(1, Math.floor(Number(body.page) || 1));
      const pageSize = Math.min(100, Math.max(10, Math.floor(Number(body.page_size) || 25)));
      const from = (page - 1) * pageSize;

      let query = supabase
        .from('builder_projects')
        .select(BUILDER_PROJECT_PORTAL_LIST_SELECT, { count: 'exact' })
        .in('id', accessibleProjectIds)
        .order('estimated_completion_date', { ascending: true, nullsFirst: false });

      const status = cleanEnum(body.status, BUILDER_PROJECT_STATUSES);
      if (status) query = query.eq('status', status);
      const search = cleanText(body.search, 120);
      if (search) {
        const escaped = search.replace(/[%_,()]/g, ' ');
        query = query.or(
          `name.ilike.%${escaped}%,project_reference.ilike.%${escaped}%,`
          + `address_line.ilike.%${escaped}%,suburb.ilike.%${escaped}%`);
      }

      const { data, error, count } = await query.range(from, from + pageSize - 1);
      if (error) throw error;

      const rows = data || [];
      const organisationIds = Array.from(new Set(rows.flatMap((row: any) =>
        [row.developer_organisation_id, row.builder_organisation_id].filter(Boolean))));
      const organisationMap = new Map<string, string>();
      if (organisationIds.length) {
        const { data: organisations } = await supabase
          .from('builder_organisations')
          .select('id, legal_name, trading_name')
          .in('id', organisationIds);
        for (const organisation of organisations || []) {
          organisationMap.set(organisation.id, organisation.trading_name || organisation.legal_name);
        }
      }

      const records = rows.map((row: any) => ({
        ...row,
        developer_organisation_name: organisationMap.get(row.developer_organisation_id) ?? null,
        builder_organisation_name: organisationMap.get(row.builder_organisation_id) ?? null,
      }));

      return json({
        success: true,
        records,
        pagination: {
          page, page_size: pageSize, total: count || 0,
          total_pages: Math.max(1, Math.ceil((count || 0) / pageSize)),
        },
      });
    }

    // ───────────────────────── DETAIL ─────────────────────────
    if (operation === 'get_project') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { project, perms } = res;

      const [{ data: parties }, { data: history }, { data: organisations }, { data: development }] =
        await Promise.all([
          builderMatrixCan(perms, 'projects', 'view')
            ? supabase.from('builder_project_parties').select(BUILDER_PARTY_SELECT)
              .eq('project_id', project.id).order('created_at', { ascending: true })
            : Promise.resolve({ data: [] as any[] }),
          supabase.from('builder_project_status_history')
            .select(BUILDER_PROJECT_STATUS_HISTORY_SELECT)
            .eq('project_id', project.id).order('created_at', { ascending: false }).limit(50),
          supabase.from('builder_organisations')
            .select('id, legal_name, trading_name, org_type')
            .in('id', [project.developer_organisation_id, project.builder_organisation_id].filter(Boolean)),
          project.development_id
            ? supabase.from('builder_developments')
              .select('id, name, development_reference, status')
              .eq('id', project.development_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);

      const organisationMap = new Map<string, any>((organisations || []).map((o: any) => [o.id, o]));

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_project_viewed', entityType: 'project', entityId: project.id,
      });

      return json({
        success: true,
        project,
        developer_organisation: organisationMap.get(project.developer_organisation_id) ?? null,
        builder_organisation: organisationMap.get(project.builder_organisation_id) ?? null,
        development: development ?? null,
        parties: parties || [],
        status_history: history || [],
        permissions: perms,
        access_role: res.accessRole,
      });
    }

    // ───────────────────────── UPDATE ─────────────────────────
    if (operation === 'update_project') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { project, perms } = res;
      if (!builderMatrixCan(perms, 'projects', 'edit')) {
        return json({ error: 'You do not have permission to edit this project' }, 403);
      }

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required' }, 400);
      }
      const payload = buildProjectPayload(body, { isCreate: false, audience: 'builder' });
      // The reference is Command Centre owned, exactly as matter_reference is.
      delete (payload as any).project_reference;
      if (!Object.keys(payload).length) return json({ error: 'Nothing to update' }, 400);

      // The guarded command writes the row and its trusted audit record in ONE
      // transaction, so a failed audit rolls the update back (Phase 0 NOCOPY-04).
      const { error } = await supabase.rpc('builder_upsert_project', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _project_id: project.id,
        _payload: payload,
        _developer_organisation_id: null,
        _builder_organisation_id: null,
        _development_id: null,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const message = String(error.message || '');
        if (message.includes('BUILDER_STALE_WRITE')) {
          await supabase.rpc('record_portal_operational_event', {
            _event_name: 'stale_write_conflict', _severity: 'warning',
            _correlation_id: crypto.randomUUID(), _request_id: req.headers.get('x-request-id'),
            _actor_type: 'builder_user', _actor_id: me.id, _portal: 'builder',
            _case_id: null, _matter_id: null, _firm_id: null, _duration_ms: null, _success: false,
            _metadata: { command: 'update_project', expected_version: expectedVersion },
          });
          return json({ error: 'This project was changed by another user', code: 'STALE_VERSION' }, 409);
        }
        if (message.includes('BUILDER_PROJECT_NOT_FOUND')) return json({ error: 'Project not found' }, 404);
        throw error;
      }

      // Re-read through the portal contract so the response never carries a
      // column the portal audience may not see.
      const { data: updated } = await supabase.from('builder_projects')
        .select(BUILDER_PROJECT_PORTAL_DETAIL_SELECT).eq('id', project.id).maybeSingle();

      return json({ success: true, project: updated });
    }

    // ───────────────────────── STATUS ─────────────────────────
    if (operation === 'set_status') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { project, perms } = res;
      if (!builderMatrixCan(perms, 'projects', 'edit')) {
        return json({ error: 'You do not have permission to change this project' }, 403);
      }

      const next = cleanEnum(body.status, BUILDER_PROJECT_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data: updated, error } = await supabase.rpc('builder_transition_project', {
        _project_id: project.id,
        _expected_version: expectedVersion,
        _from: project.status,
        _to: next,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) {
        const message = String(error.message || '');
        const conflict = /STALE_VERSION|STALE_STATUS|INVALID_TRANSITION/.test(message);
        return json({
          error: conflict ? 'Stale write or invalid status transition' : 'Unable to change the project status',
          code: message,
        }, conflict ? 409 : 400);
      }

      // The transition wrote its own trusted audit row inside the database
      // transaction, so a failure there has already rolled the change back.
      return json({ success: true, project: updated });
    }

    // ───────────────────────── PARTIES ─────────────────────────
    if (operation === 'list_parties') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_project_parties').select(BUILDER_PARTY_SELECT)
        .eq('project_id', res.project.id).order('created_at', { ascending: true });
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_party') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'projects', 'edit')) {
        return json({ error: 'You do not have permission to manage parties' }, 403);
      }
      const payload = buildPartyPayload(body);
      if (!payload.name) return json({ error: 'Party name is required' }, 400);

      // Guarded command: the party write and its trusted audit row share one
      // transaction. The party id is scoped to this project inside the command,
      // so an id belonging to another project matches no row.
      const { data: record, error } = await supabase.rpc('builder_upsert_project_party', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _project_id: res.project.id,
        _party_id: typeof body.party_id === 'string' ? body.party_id : null,
        _payload: payload,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const message = String(error.message || '');
        if (message.includes('BUILDER_PARTY_NOT_FOUND')) return json({ error: 'Party not found' }, 404);
        if (message.includes('BUILDER_PROJECT_NOT_FOUND')) return json({ error: 'Project not found' }, 404);
        if (message.includes('BUILDER_PARTY_NAME_REQUIRED')) {
          return json({ error: 'Party name is required' }, 400);
        }
        throw error;
      }
      return json({ success: true, record });
    }

    if (operation === 'delete_party') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'projects', 'delete')) {
        return json({ error: 'You do not have permission to remove parties' }, 403);
      }
      const partyId = String(body.party_id || '');
      if (!partyId) return json({ error: 'party_id is required' }, 400);

      // Guarded command: the delete and its trusted audit row share one
      // transaction, and the audit carries the removed record.
      const { error } = await supabase.rpc('builder_delete_project_party', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _project_id: res.project.id,
        _party_id: partyId,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const message = String(error.message || '');
        if (message.includes('BUILDER_PARTY_NOT_FOUND')) return json({ error: 'Party not found' }, 404);
        if (message.includes('BUILDER_PROJECT_NOT_FOUND')) return json({ error: 'Project not found' }, 404);
        throw error;
      }
      return json({ success: true });
    }

    // ───────────────────────── HISTORY / STATS ─────────────────────────
    if (operation === 'status_history') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_project_status_history')
        .select(BUILDER_PROJECT_STATUS_HISTORY_SELECT)
        .eq('project_id', res.project.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'project_stats') {
      if (!accessibleProjectIds.length) {
        return json({ success: true, total: 0, by_status: {}, at_risk: 0 });
      }
      const { data } = await supabase.from('builder_projects')
        .select('status, risk_flag').in('id', accessibleProjectIds);
      const byStatus: Record<string, number> = {};
      let atRisk = 0;
      for (const row of data || []) {
        byStatus[row.status] = (byStatus[row.status] || 0) + 1;
        if (row.risk_flag) atRisk += 1;
      }
      return json({ success: true, total: (data || []).length, by_status: byStatus, at_risk: atRisk });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-projects]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
