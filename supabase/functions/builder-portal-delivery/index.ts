/**
 * Builder / Developer Portal — Delivery
 *
 * Portal-facing variations, variation approvals, progress claims, inspections,
 * defects, practical completion, handover and warranty. Mirrors
 * `builder-portal-construction`: cookie session, governance gate, server-held
 * active organisation, parent-first access resolution, tri-state permission
 * matrix, guarded transactional commands.
 *
 * Every record here is a child of a CONSTRUCTION CASE and is authorised by
 * `builder_resolve_construction_permission`, which already walks project ->
 * transaction -> membership -> case override. There is no new access table and
 * no new resolver: a record id in the body is a lookup key, never authority,
 * and every lookup is scoped to the resolved case.
 *
 * DATA BOUNDARY: `build_progress_payments` and `builder_invoices` are
 * Finance-owned and are not referenced. A progress claim exposes what was
 * claimed and certified plus a nullable Finance POINTER — never a payment,
 * receipt or commission. Defects, inspections, practical completion, handover
 * and warranty records carry no money at all.
 *
 * Operations
 *   list_variations | upsert_variation | list_approvals | upsert_approval
 *   list_claims | upsert_claim
 *   list_inspections | upsert_inspection
 *   list_defects | upsert_defect
 *   get_completion | save_completion
 *   list_warranty_claims | upsert_warranty_claim
 *   set_status | delivery_history | delivery_summary
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
  builderMatrixCan,
  type BuilderPermissionMatrix,
} from '../_shared/builderPortalAuth.ts';
import {
  BUILDER_VARIATION_SELECT,
  BUILDER_VARIATION_APPROVAL_SELECT,
  BUILDER_CLAIM_SELECT,
  BUILDER_INSPECTION_SELECT,
  BUILDER_DEFECT_SELECT,
  BUILDER_PC_SELECT,
  BUILDER_HANDOVER_SELECT,
  BUILDER_WARRANTY_SELECT,
  BUILDER_WARRANTY_CLAIM_SELECT,
  BUILDER_DELIVERY_HISTORY_SELECT,
  BUILDER_DELIVERY_KINDS,
  buildVariationPayload,
  buildApprovalPayload,
  buildClaimPayload,
  buildInspectionPayload,
  buildDefectPayload,
  buildDeliveryRecordPayload,
  buildWarrantyClaimPayload,
  deliveryCommandFailure,
  permissionKeyFor,
  cleanEnum,
  cleanText,
} from '../_shared/builderDelivery.ts';

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
      { ok: true; perms: BuilderPermissionMatrix } | { ok: false; status: number; error: string }
    > => {
      if (!projectId) return { ok: false, status: 400, error: 'project_id is required' };
      const access = await resolveBuilderProjectAccess(supabase, me.id, projectId);
      if (!access) return { ok: false, status: 404, error: 'Not found' };
      if (access.organisation_id !== activeOrganisationId) {
        return { ok: false, status: 404, error: 'Not found' };
      }
      const { data: project } = await supabase.from('builder_projects')
        .select('id, developer_organisation_id, builder_organisation_id')
        .eq('id', projectId).maybeSingle();
      if (!project) return { ok: false, status: 404, error: 'Not found' };
      const sideOrg = access.organisation_side === 'developer'
        ? project.developer_organisation_id
        : project.builder_organisation_id;
      if (!sideOrg || sideOrg !== access.organisation_id) {
        return { ok: false, status: 404, error: 'Not found' };
      }
      const perms = await resolveBuilderProjectPermissions(supabase, access);
      if (!builderMatrixCan(perms, 'projects', 'view')) {
        return { ok: false, status: 403, error: 'You do not have access to this project' };
      }
      return { ok: true, perms };
    };

    /**
     * Load the construction case that owns the record, then authorise it through
     * its parent project and the database's own construction resolver — which
     * additionally re-checks the parent transaction and the case-scoped
     * override. The permission key varies by aggregate.
     */
    const loadCase = async (
      caseId: string, permissionKey: string, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; caseId: string; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!caseId) return { ok: false, status: 400, error: 'construction_case_id is required' };

      const { data: record } = await supabase.from('builder_construction_cases')
        .select('id, project_id').eq('id', caseId).maybeSingle();
      if (!record) return { ok: false, status: 404, error: 'Construction case not found' };

      const parent = await loadProject(record.project_id);
      // A case whose project the caller cannot see is reported as "not found",
      // never "forbidden" — probing ids must not reveal one exists.
      if (!parent.ok) return { ok: false, status: 404, error: 'Construction case not found' };

      const { data: allowed, error } = await supabase.rpc('builder_resolve_construction_permission', {
        _user_id: me.id, _construction_case_id: caseId,
        _permission_key: permissionKey, _level: level,
      });
      if (error) throw error;
      if (allowed !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Construction case not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this record' };
      }
      return { ok: true, caseId: record.id, perms: parent.perms };
    };

    const fail = (message: string, fallbackStatus = 400, fallbackError = 'The request failed') => {
      const mapped = deliveryCommandFailure(message);
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

    /**
     * Confirm a record belongs to the resolved case. Written out per table
     * because the generated Supabase types cannot resolve a union of table
     * names — and because this is the check that stops an id aimed at another
     * case, or at another aggregate, from matching anything.
     */
    const ownedByCase = async (kind: string, entityId: string, caseId: string) => {
      switch (kind) {
        case 'variation':
          return (await supabase.from('builder_variations').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'progress_claim':
          return (await supabase.from('builder_progress_claims').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'inspection':
          return (await supabase.from('builder_inspections').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'defect':
          return (await supabase.from('builder_defects').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'practical_completion':
          return (await supabase.from('builder_practical_completions').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'handover':
          return (await supabase.from('builder_handovers').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        case 'warranty_claim':
          return (await supabase.from('builder_warranty_claims').select('id')
            .eq('id', entityId).eq('construction_case_id', caseId).maybeSingle()).data;
        default:
          return null;
      }
    };

    // ───────────────────────── VARIATIONS ─────────────────────────
    if (operation === 'list_variations') {
      const res = await loadCase(String(body.construction_case_id || ''), 'variations');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_variations').select(BUILDER_VARIATION_SELECT)
        .eq('construction_case_id', res.caseId).order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_variation') {
      const res = await loadCase(String(body.construction_case_id || ''), 'variations', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const variationId = cleanText(body.variation_id, 64);
      let expectedVersion: number | null = null;
      if (variationId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        if (!await ownedByCase('variation', variationId, res.caseId)) {
          return json({ error: 'Variation not found' }, 404);
        }
      }
      const payload = buildVariationPayload(body);
      if (!variationId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_variation', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _variation_id: variationId,
        _construction_case_id: variationId ? null : res.caseId,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The variation could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'list_approvals') {
      const res = await loadCase(String(body.construction_case_id || ''), 'variations');
      if (!res.ok) return json({ error: res.error }, res.status);
      const variationId = cleanText(body.variation_id, 64);
      if (!variationId) return json({ error: 'variation_id is required' }, 400);
      if (!await ownedByCase('variation', variationId, res.caseId)) {
        return json({ error: 'Variation not found' }, 404);
      }
      const { data } = await supabase.from('builder_variation_approvals')
        .select(BUILDER_VARIATION_APPROVAL_SELECT)
        .eq('variation_id', variationId).order('created_at', { ascending: true });
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_approval') {
      const res = await loadCase(String(body.construction_case_id || ''), 'variations', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const approvalId = cleanText(body.approval_id, 64);
      const variationId = cleanText(body.variation_id, 64);
      let expectedVersion: number | null = null;
      if (approvalId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      } else {
        if (!variationId) return json({ error: 'variation_id is required' }, 400);
        if (!await ownedByCase('variation', variationId, res.caseId)) {
          return json({ error: 'Variation not found' }, 404);
        }
      }
      const payload = buildApprovalPayload(body);
      if (!approvalId && !payload.approver_name) {
        return json({ error: 'An approver name is required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_upsert_variation_approval', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _approval_id: approvalId,
        _variation_id: approvalId ? null : variationId,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The approval could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── PROGRESS CLAIMS ─────────────────────────
    if (operation === 'list_claims') {
      const res = await loadCase(String(body.construction_case_id || ''), 'progress_claims');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_progress_claims').select(BUILDER_CLAIM_SELECT)
        .eq('construction_case_id', res.caseId).order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_claim') {
      const res = await loadCase(String(body.construction_case_id || ''), 'progress_claims', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const claimId = cleanText(body.claim_id, 64);
      let expectedVersion: number | null = null;
      if (claimId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        if (!await ownedByCase('progress_claim', claimId, res.caseId)) {
          return json({ error: 'Progress claim not found' }, 404);
        }
      }

      const { data, error } = await supabase.rpc('builder_upsert_progress_claim', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _claim_id: claimId,
        _construction_case_id: claimId ? null : res.caseId,
        _milestone_id: cleanText(body.milestone_id, 64),
        _payload: buildClaimPayload(body),
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The claim could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── INSPECTIONS ─────────────────────────
    if (operation === 'list_inspections') {
      const res = await loadCase(String(body.construction_case_id || ''), 'inspections');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_inspections').select(BUILDER_INSPECTION_SELECT)
        .eq('construction_case_id', res.caseId)
        .order('scheduled_for', { ascending: false, nullsFirst: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_inspection') {
      const res = await loadCase(String(body.construction_case_id || ''), 'inspections', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const inspectionId = cleanText(body.inspection_id, 64);
      let expectedVersion: number | null = null;
      if (inspectionId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        if (!await ownedByCase('inspection', inspectionId, res.caseId)) {
          return json({ error: 'Inspection not found' }, 404);
        }
      }
      const payload = buildInspectionPayload(body);
      if (!inspectionId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_inspection', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _inspection_id: inspectionId,
        _construction_case_id: inspectionId ? null : res.caseId,
        _construction_stage_id: cleanText(body.construction_stage_id, 64),
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The inspection could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── DEFECTS ─────────────────────────
    if (operation === 'list_defects') {
      const res = await loadCase(String(body.construction_case_id || ''), 'defects');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_defects').select(BUILDER_DEFECT_SELECT)
        .eq('construction_case_id', res.caseId).order('raised_at', { ascending: false }).limit(500);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_defect') {
      const res = await loadCase(String(body.construction_case_id || ''), 'defects', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const defectId = cleanText(body.defect_id, 64);
      let expectedVersion: number | null = null;
      if (defectId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        if (!await ownedByCase('defect', defectId, res.caseId)) {
          return json({ error: 'Defect not found' }, 404);
        }
      }
      const payload = buildDefectPayload(body);
      if (!defectId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_defect', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _defect_id: defectId,
        _construction_case_id: defectId ? null : res.caseId,
        _inspection_id: cleanText(body.inspection_id, 64),
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The defect could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────── PRACTICAL COMPLETION / HANDOVER / WARRANTY ─────────────
    if (operation === 'get_completion') {
      const res = await loadCase(String(body.construction_case_id || ''), 'handover');
      if (!res.ok) return json({ error: res.error }, res.status);
      const [{ data: pc }, { data: handover }, { data: warranty }, { data: claims }] =
        await Promise.all([
          supabase.from('builder_practical_completions').select(BUILDER_PC_SELECT)
            .eq('construction_case_id', res.caseId).maybeSingle(),
          supabase.from('builder_handovers').select(BUILDER_HANDOVER_SELECT)
            .eq('construction_case_id', res.caseId).maybeSingle(),
          supabase.from('builder_warranties').select(BUILDER_WARRANTY_SELECT)
            .eq('construction_case_id', res.caseId).maybeSingle(),
          supabase.from('builder_warranty_claims').select(BUILDER_WARRANTY_CLAIM_SELECT)
            .eq('construction_case_id', res.caseId).order('lodged_at', { ascending: false }).limit(100),
        ]);
      return json({
        success: true,
        practical_completion: pc ?? null,
        handover: handover ?? null,
        warranty: warranty ?? null,
        warranty_claims: claims || [],
      });
    }

    if (operation === 'save_completion') {
      const res = await loadCase(String(body.construction_case_id || ''), 'handover', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const kind = cleanEnum(body.kind, ['practical_completion', 'handover', 'warranty'] as const);
      if (!kind) return json({ error: 'Unknown record type' }, 400);

      // The first save creates the row; every save after that carries a version.
      let expectedVersion: number | null = null;
      if (body.expected_version !== undefined && body.expected_version !== null) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      }

      const { data, error } = await supabase.rpc('builder_upsert_delivery_record', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _kind: kind,
        _construction_case_id: res.caseId,
        _payload: buildDeliveryRecordPayload(kind, body),
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The record could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'list_warranty_claims') {
      const res = await loadCase(String(body.construction_case_id || ''), 'handover');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_warranty_claims')
        .select(BUILDER_WARRANTY_CLAIM_SELECT)
        .eq('construction_case_id', res.caseId).order('lodged_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_warranty_claim') {
      const res = await loadCase(String(body.construction_case_id || ''), 'handover', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const claimId = cleanText(body.warranty_claim_id, 64);
      let expectedVersion: number | null = null;
      if (claimId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        if (!await ownedByCase('warranty_claim', claimId, res.caseId)) {
          return json({ error: 'Warranty claim not found' }, 404);
        }
      }
      const payload = buildWarrantyClaimPayload(body);
      if (!claimId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_warranty_claim', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _claim_id: claimId,
        _construction_case_id: claimId ? null : res.caseId,
        _warranty_id: cleanText(body.warranty_id, 64),
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The warranty claim could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── STATUS ─────────────────────────
    if (operation === 'set_status') {
      const kind = cleanEnum(body.kind, BUILDER_DELIVERY_KINDS);
      if (!kind) return json({ error: 'Unknown record type' }, 400);

      const res = await loadCase(
        String(body.construction_case_id || ''), permissionKeyFor(kind), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const entityId = cleanText(body.entity_id, 64);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      const from = cleanText(body.from_status, 60);
      const to = cleanText(body.status, 60);
      if (!entityId || !Number.isInteger(expectedVersion) || expectedVersion < 1
          || !reason || !from || !to) {
        return json({
          error: 'entity_id, status, from_status, expected_version and reason are required',
        }, 400);
      }

      // The record must belong to the resolved case, so an id aimed at another
      // case — or at another aggregate — matches nothing.
      if (!await ownedByCase(kind, entityId, res.caseId)) {
        return json({ error: 'Record not found' }, 404);
      }

      const { data, error } = await supabase.rpc('builder_transition_delivery', {
        _kind: kind,
        _entity_id: entityId,
        _expected_version: expectedVersion,
        _from: from,
        _to: to,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The status could not be changed');
      return json({ success: true, record: data });
    }

    // ───────────────────────── HISTORY / SUMMARY ─────────────────────────
    if (operation === 'delivery_history') {
      const res = await loadCase(String(body.construction_case_id || ''), 'defects');
      if (!res.ok) return json({ error: res.error }, res.status);
      let query = supabase.from('builder_delivery_status_history')
        .select(BUILDER_DELIVERY_HISTORY_SELECT)
        .eq('construction_case_id', res.caseId)
        .order('created_at', { ascending: false }).limit(200);
      const kind = cleanEnum(body.kind, BUILDER_DELIVERY_KINDS);
      if (kind) query = query.eq('entity_kind', kind);
      const { data } = await query;
      return json({ success: true, records: data || [] });
    }

    if (operation === 'delivery_summary') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'defects');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;
      const empty = {
        success: true, open_defects: 0, overdue_defects: 0,
        pending_variations: 0, scheduled_inspections: 0,
      };
      if (!projectIds.length) return json(empty);

      // Only cases inside the accessible projects are counted.
      const { data: caseRows } = await supabase.from('builder_construction_cases')
        .select('id').in('project_id', projectIds).limit(2000);
      const caseIds = (caseRows || []).map((row: any) => row.id);
      if (!caseIds.length) return json(empty);

      const today = new Date().toISOString().slice(0, 10);
      const [{ data: defects }, { data: variations }, { data: inspections }] = await Promise.all([
        supabase.from('builder_defects').select('status, due_date').in('construction_case_id', caseIds),
        supabase.from('builder_variations').select('status').in('construction_case_id', caseIds),
        supabase.from('builder_inspections').select('status').in('construction_case_id', caseIds),
      ]);

      const openDefects = (defects || []).filter(
        (d: any) => !['closed', 'rejected', 'verified'].includes(d.status));
      return json({
        success: true,
        open_defects: openDefects.length,
        overdue_defects: openDefects.filter((d: any) => d.due_date && d.due_date < today).length,
        pending_variations: (variations || []).filter(
          (v: any) => ['draft', 'submitted'].includes(v.status)).length,
        scheduled_inspections: (inspections || []).filter(
          (i: any) => ['scheduled', 'rescheduled'].includes(i.status)).length,
      });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-delivery]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
