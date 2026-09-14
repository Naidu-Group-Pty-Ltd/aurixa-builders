/**
 * Builder / Developer Portal — Construction
 *
 * Portal-facing build-programme workspace: construction cases, stages,
 * milestones, progress updates, estimated completion dates and photographs.
 * Mirrors `builder-portal-transactions` operation shape for operation shape:
 * cookie session, governance gate, server-held active organisation,
 * parent-first access resolution, tri-state permission matrix, guarded
 * transactional commands.
 *
 * Every construction case is reached through its TRANSACTION and that
 * transaction's PROJECT grant. There is no construction-level grant a caller
 * could aim at: a case id in the body is a lookup key, never authority.
 *
 * DATA BOUNDARY: no cost, margin, supplier price, contractor price or commission
 * is selected here, because no such column exists. A milestone carries no amount
 * and no payment flag — Finance owns `build_progress_payments` and every
 * commission trigger on it, and neither is referenced by this function.
 *
 * Photograph bytes: `storage_path` is read only to mint a SHORT-LIVED SIGNED URL
 * after the caller's permission has already been resolved. The path itself is
 * never returned to the browser and never becomes a public URL.
 *
 * Operations
 *   list_cases | get_case | update_case | set_status | set_date
 *   list_stages | upsert_stage
 *   list_milestones | upsert_milestone | set_milestone_status
 *   list_progress | add_progress
 *   list_photographs | add_photograph | delete_photograph | photograph_url
 *   status_history | date_history | construction_stats
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
  BUILDER_CONSTRUCTION_PORTAL_LIST_SELECT,
  BUILDER_CONSTRUCTION_PORTAL_DETAIL_SELECT,
  BUILDER_CONSTRUCTION_STAGE_SELECT,
  BUILDER_MILESTONE_SELECT,
  BUILDER_PROGRESS_UPDATE_SELECT,
  BUILDER_PHOTOGRAPH_SELECT,
  BUILDER_CONSTRUCTION_HISTORY_SELECT,
  BUILDER_CONSTRUCTION_DATE_HISTORY_SELECT,
  BUILDER_CONSTRUCTION_STATUSES,
  BUILDER_MILESTONE_STATUSES,
  BUILDER_CONSTRUCTION_DATE_KINDS,
  buildConstructionCasePayload,
  buildConstructionStagePayload,
  buildMilestonePayload,
  buildProgressUpdatePayload,
  buildPhotographPayload,
  constructionCommandFailure,
  cleanDate,
  cleanEnum,
  cleanText,
} from '../_shared/builderConstruction.ts';

/** Signed photograph URLs are short-lived: the grant is checked per request. */
const PHOTO_URL_TTL_SECONDS = 300;
const PHOTO_BUCKET = 'builder-construction-photos';

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

    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }

    /** Resolve one project exactly as the other Builder functions do. */
    const loadProject = async (projectId: string): Promise<
      { ok: true; project: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!projectId) return { ok: false, status: 400, error: 'project_id is required' };

      const access = await resolveBuilderProjectAccess(supabase, me.id, projectId);
      if (!access) return { ok: false, status: 404, error: 'Project not found' };
      if (access.organisation_id !== activeOrganisationId) {
        return { ok: false, status: 404, error: 'Project not found' };
      }

      const { data: project } = await supabase
        .from('builder_projects')
        .select('id, developer_organisation_id, builder_organisation_id, name, project_reference')
        .eq('id', projectId)
        .maybeSingle();
      if (!project) return { ok: false, status: 404, error: 'Project not found' };

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
      return { ok: true, project, perms };
    };

    /**
     * Load a construction case, then authorise it through its parent project and
     * the database's own resolver. The resolver additionally re-checks the
     * parent TRANSACTION and applies case-scoped DENY overrides that the project
     * matrix does not see.
     */
    const loadCase = async (
      caseId: string, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; record: any; project: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!caseId) return { ok: false, status: 400, error: 'construction_case_id is required' };

      const { data: record } = await supabase
        .from('builder_construction_cases')
        .select(BUILDER_CONSTRUCTION_PORTAL_DETAIL_SELECT)
        .eq('id', caseId)
        .maybeSingle();
      if (!record) return { ok: false, status: 404, error: 'Construction case not found' };

      const parent = await loadProject(record.project_id);
      // A case whose project the caller cannot see is reported as "not found",
      // never "forbidden" — probing ids must not reveal one exists.
      if (!parent.ok) return { ok: false, status: 404, error: 'Construction case not found' };

      const { data: allowed, error } = await supabase.rpc('builder_resolve_construction_permission', {
        _user_id: me.id, _construction_case_id: caseId,
        _permission_key: 'construction', _level: level,
      });
      if (error) throw error;
      if (allowed !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Construction case not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this construction case' };
      }
      return { ok: true, record, project: parent.project, perms: parent.perms };
    };

    const fail = (message: string, fallbackStatus = 400, fallbackError = 'The request failed') => {
      const mapped = constructionCommandFailure(message);
      return mapped
        ? json({ error: mapped.error, code: mapped.code }, mapped.status)
        : json({ error: fallbackError }, fallbackStatus);
    };

    // ───────────────────────── CASES ─────────────────────────
    if (operation === 'list_cases') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'construction');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;
      if (!projectIds.length) {
        return json({
          success: true, records: [],
          pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 },
        });
      }

      const page = Math.max(1, Math.floor(Number(body.page) || 1));
      const pageSize = Math.min(100, Math.max(10, Math.floor(Number(body.page_size) || 25)));
      const from = (page - 1) * pageSize;

      let query = supabase
        .from('builder_construction_cases')
        .select(BUILDER_CONSTRUCTION_PORTAL_LIST_SELECT, { count: 'exact' })
        .in('project_id', projectIds)
        .order('estimated_completion_date', { ascending: true, nullsFirst: false });

      const status = cleanEnum(body.status, BUILDER_CONSTRUCTION_STATUSES);
      if (status) query = query.eq('status', status);
      const search = cleanText(body.search, 120);
      if (search) {
        const escaped = search.replace(/[%_,()]/g, ' ');
        query = query.or(
          `case_reference.ilike.%${escaped}%,site_supervisor_name.ilike.%${escaped}%`);
      }

      const { data, error, count } = await query.range(from, from + pageSize - 1);
      if (error) throw error;

      return json({
        success: true,
        records: data || [],
        pagination: {
          page, page_size: pageSize, total: count || 0,
          total_pages: Math.max(1, Math.ceil((count || 0) / pageSize)),
        },
      });
    }

    if (operation === 'get_case') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { record, project, perms } = res;

      const [
        { data: stages }, { data: milestones }, { data: updates },
        { data: photographs }, { data: history }, { data: dates }, { data: unit },
      ] = await Promise.all([
        supabase.from('builder_construction_stages').select(BUILDER_CONSTRUCTION_STAGE_SELECT)
          .eq('construction_case_id', record.id).order('sequence_number', { ascending: true }),
        supabase.from('builder_construction_milestones').select(BUILDER_MILESTONE_SELECT)
          .eq('construction_case_id', record.id).order('planned_date', { ascending: true, nullsFirst: false }),
        supabase.from('builder_construction_progress_updates').select(BUILDER_PROGRESS_UPDATE_SELECT)
          .eq('construction_case_id', record.id).order('update_date', { ascending: false }).limit(50),
        supabase.from('builder_construction_photographs').select(BUILDER_PHOTOGRAPH_SELECT)
          .eq('construction_case_id', record.id).order('created_at', { ascending: false }).limit(100),
        supabase.from('builder_construction_status_history').select(BUILDER_CONSTRUCTION_HISTORY_SELECT)
          .eq('construction_case_id', record.id).order('created_at', { ascending: false }).limit(50),
        supabase.from('builder_construction_date_history').select(BUILDER_CONSTRUCTION_DATE_HISTORY_SELECT)
          .eq('construction_case_id', record.id).order('created_at', { ascending: false }).limit(50),
        record.unit_id
          ? supabase.from('builder_units').select('id, unit_number, unit_type')
            .eq('id', record.unit_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_construction_case_viewed',
        entityType: 'construction_case', entityId: record.id,
      });

      // The storage path is stripped from the response. A caller who needs the
      // image asks for a signed URL, which re-resolves the grant.
      const safePhotographs = (photographs || []).map(
        ({ storage_path: _path, ...rest }: any) => rest);

      return json({
        success: true,
        construction_case: record,
        project: { id: project.id, name: project.name, project_reference: project.project_reference },
        unit: unit ?? null,
        stages: stages || [],
        milestones: milestones || [],
        progress_updates: updates || [],
        photographs: safePhotographs,
        status_history: history || [],
        date_history: dates || [],
        permissions: perms,
      });
    }

    if (operation === 'update_case') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required', code: 'EXPECTED_VERSION_REQUIRED' }, 400);
      }
      const payload = buildConstructionCasePayload(body, { audience: 'builder' });
      if (!Object.keys(payload).length) return json({ error: 'Nothing to update' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_construction_case', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _construction_case_id: res.record.id,
        _transaction_id: null,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The construction case could not be updated');
      return json({ success: true, construction_case: data });
    }

    if (operation === 'set_status') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const next = cleanEnum(body.status, BUILDER_CONSTRUCTION_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_transition_construction_case', {
        _construction_case_id: res.record.id,
        _expected_version: expectedVersion,
        _from: res.record.status,
        _to: next,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The status could not be changed');
      return json({ success: true, construction_case: data });
    }

    if (operation === 'set_date') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const dateKind = cleanEnum(body.date_kind, BUILDER_CONSTRUCTION_DATE_KINDS);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!dateKind || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'date_kind, expected_version and reason are required' }, 400);
      }

      // Every date change is recorded with its previous value and a reason, so
      // slippage is auditable rather than silent.
      const { data, error } = await supabase.rpc('builder_set_construction_date', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _construction_case_id: res.record.id,
        _date_kind: dateKind,
        _new_date: cleanDate(body.new_date),
        _expected_version: expectedVersion,
        _reason: reason,
      });
      if (error) return fail(String(error.message || ''), 400, 'The date could not be changed');
      return json({ success: true, construction_case: data });
    }

    // ───────────────────────── STAGES ─────────────────────────
    if (operation === 'list_stages') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_stages')
        .select(BUILDER_CONSTRUCTION_STAGE_SELECT)
        .eq('construction_case_id', res.record.id).order('sequence_number', { ascending: true });
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_stage') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const stageId = cleanText(body.stage_id, 64);
      let expectedVersion: number | null = null;
      if (stageId) {
        const supplied = Number(body.expected_version);
        if (!Number.isInteger(supplied) || supplied < 1) {
          return json({
            error: 'expected_version is required when updating an existing stage',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400);
        }
        expectedVersion = supplied;
      }
      const payload = buildConstructionStagePayload(body);
      if (!stageId && !payload.name) return json({ error: 'A stage name is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_construction_stage', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _stage_id: stageId,
        _construction_case_id: stageId ? null : res.record.id,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The stage could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── MILESTONES ─────────────────────────
    if (operation === 'list_milestones') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_milestones')
        .select(BUILDER_MILESTONE_SELECT)
        .eq('construction_case_id', res.record.id)
        .order('planned_date', { ascending: true, nullsFirst: false });
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_milestone') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const milestoneId = cleanText(body.milestone_id, 64);
      let expectedVersion: number | null = null;
      if (milestoneId) {
        const supplied = Number(body.expected_version);
        if (!Number.isInteger(supplied) || supplied < 1) {
          return json({
            error: 'expected_version is required when updating an existing milestone',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400);
        }
        expectedVersion = supplied;
      }
      const payload = buildMilestonePayload(body);
      if (!milestoneId && !payload.name) return json({ error: 'A milestone name is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_milestone', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _milestone_id: milestoneId,
        _construction_case_id: milestoneId ? null : res.record.id,
        _construction_stage_id: cleanText(body.construction_stage_id, 64),
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The milestone could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'set_milestone_status') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const milestoneId = cleanText(body.milestone_id, 64);
      if (!milestoneId) return json({ error: 'milestone_id is required' }, 400);
      // Scoped to this case so an id from another case matches no row.
      const { data: milestone } = await supabase.from('builder_construction_milestones')
        .select('id, status').eq('id', milestoneId)
        .eq('construction_case_id', res.record.id).maybeSingle();
      if (!milestone) return json({ error: 'Milestone not found' }, 404);

      const next = cleanEnum(body.status, BUILDER_MILESTONE_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_transition_milestone', {
        _milestone_id: milestone.id,
        _expected_version: expectedVersion,
        _from: milestone.status,
        _to: next,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The milestone could not be changed');
      return json({ success: true, milestone: data });
    }

    // ───────────────────────── PROGRESS ─────────────────────────
    if (operation === 'list_progress') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_progress_updates')
        .select(BUILDER_PROGRESS_UPDATE_SELECT)
        .eq('construction_case_id', res.record.id)
        .order('update_date', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'add_progress') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);
      const payload = buildProgressUpdatePayload(body);
      if (!payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_add_progress_update', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _construction_case_id: res.record.id,
        _construction_stage_id: cleanText(body.construction_stage_id, 64),
        _payload: payload,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The update could not be added');
      return json({ success: true, record: data });
    }

    // ───────────────────────── PHOTOGRAPHS ─────────────────────────
    if (operation === 'list_photographs') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_photographs')
        .select(BUILDER_PHOTOGRAPH_SELECT)
        .eq('construction_case_id', res.record.id)
        .order('created_at', { ascending: false }).limit(200);
      // The storage path never leaves the server.
      return json({
        success: true,
        records: (data || []).map(({ storage_path: _path, ...rest }: any) => rest),
      });
    }

    if (operation === 'photograph_url') {
      // The grant is re-resolved on EVERY url request, and the url expires in
      // minutes — a link that leaks cannot outlive the access that produced it.
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const photographId = cleanText(body.photograph_id, 64);
      if (!photographId) return json({ error: 'photograph_id is required' }, 400);

      const { data: photograph } = await supabase.from('builder_construction_photographs')
        .select('id, storage_path').eq('id', photographId)
        .eq('construction_case_id', res.record.id).maybeSingle();
      if (!photograph) return json({ error: 'Photograph not found' }, 404);

      const { data: signed, error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrl(photograph.storage_path, PHOTO_URL_TTL_SECONDS);
      if (error || !signed?.signedUrl) {
        return json({ error: 'The photograph could not be prepared' }, 502);
      }
      return json({ success: true, url: signed.signedUrl, expires_in: PHOTO_URL_TTL_SECONDS });
    }

    if (operation === 'add_photograph') {
      const res = await loadCase(String(body.construction_case_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);
      const payload = buildPhotographPayload(body);
      if (!payload.storage_path || !payload.file_name) {
        return json({ error: 'A file is required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_add_construction_photograph', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _construction_case_id: res.record.id,
        _payload: payload,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The photograph could not be added');
      const { storage_path: _path, ...safe } = (data || {}) as any;
      return json({ success: true, record: safe });
    }

    if (operation === 'delete_photograph') {
      const res = await loadCase(String(body.construction_case_id || ''), 'delete');
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'construction', 'delete')) {
        return json({ error: 'You do not have permission to remove photographs' }, 403);
      }
      const photographId = cleanText(body.photograph_id, 64);
      if (!photographId) return json({ error: 'photograph_id is required' }, 400);

      const { error } = await supabase.rpc('builder_delete_construction_photograph', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _construction_case_id: res.record.id,
        _photograph_id: photographId,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The photograph could not be removed');
      return json({ success: true });
    }

    // ───────────────────────── HISTORY / STATS ─────────────────────────
    if (operation === 'status_history') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_status_history')
        .select(BUILDER_CONSTRUCTION_HISTORY_SELECT)
        .eq('construction_case_id', res.record.id)
        .order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'date_history') {
      const res = await loadCase(String(body.construction_case_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_construction_date_history')
        .select(BUILDER_CONSTRUCTION_DATE_HISTORY_SELECT)
        .eq('construction_case_id', res.record.id)
        .order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'construction_stats') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'construction');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;
      if (!projectIds.length) {
        return json({ success: true, total: 0, by_status: {}, average_percent: 0, overdue: 0 });
      }
      const { data } = await supabase.from('builder_construction_cases')
        .select('status, percent_complete, estimated_completion_date')
        .in('project_id', projectIds);
      const byStatus: Record<string, number> = {};
      let sum = 0;
      let overdue = 0;
      const today = new Date().toISOString().slice(0, 10);
      for (const row of data || []) {
        byStatus[row.status] = (byStatus[row.status] || 0) + 1;
        sum += Number(row.percent_complete || 0);
        if (row.estimated_completion_date && row.estimated_completion_date < today
            && !['completed', 'cancelled'].includes(row.status)) {
          overdue += 1;
        }
      }
      const total = (data || []).length;
      return json({
        success: true, total, by_status: byStatus,
        average_percent: total ? Math.round((sum / total) * 100) / 100 : 0,
        overdue,
      });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-construction]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
