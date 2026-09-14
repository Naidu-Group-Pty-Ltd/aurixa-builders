/**
 * Builder / Developer Portal — Inventory
 *
 * Portal-facing stage, building, lot, unit, pricing, hold, reservation and
 * allocation workspace. Mirrors `builder-portal-projects` — which itself mirrors
 * `solicitor-portal-matters` — operation shape for operation shape: cookie
 * session, governance gate, server-held active organisation, parent-first access
 * resolution, tri-state permission matrix, guarded transactional commands.
 *
 * Every unit is reached through its PARENT PROJECT's grant. There is no separate
 * unit access table and no unit-level grant a caller could aim at: a unit id in
 * the body is a lookup key, never authority.
 *
 * DATA BOUNDARY: no build cost, margin, supplier price or contractor price is
 * selected here, because no such column exists — the migration asserts that at
 * apply time. `builder_invoices` and `build_progress_payments` are Finance-owned
 * and are not referenced by this function at all.
 *
 * Operations
 *   list_units | get_unit | update_unit | set_availability | set_release
 *   set_price | price_history | unit_history
 *   list_stages | upsert_stage | list_buildings | upsert_building
 *   list_lots | upsert_lot
 *   create_hold | release_hold | list_holds
 *   create_reservation | set_reservation_status | list_reservations | reservation_history
 *   list_allocations | inventory_stats
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
  BUILDER_UNIT_PORTAL_LIST_SELECT,
  BUILDER_UNIT_PORTAL_DETAIL_SELECT,
  BUILDER_STAGE_SELECT,
  BUILDER_BUILDING_SELECT,
  BUILDER_LOT_SELECT,
  BUILDER_PRICING_SELECT,
  BUILDER_HOLD_SELECT,
  BUILDER_RESERVATION_SELECT,
  BUILDER_ALLOCATION_SELECT,
  BUILDER_UNIT_HISTORY_SELECT,
  BUILDER_RESERVATION_HISTORY_SELECT,
  BUILDER_AVAILABILITY_STATUSES,
  BUILDER_RELEASE_STATUSES,
  BUILDER_RESERVATION_STATUSES,
  BUILDER_PRICE_BASES,
  BUILDER_UNIT_TYPES,
  buildUnitPayload,
  buildStagePayload,
  buildBuildingPayload,
  buildLotPayload,
  buildReservationPayload,
  cleanEnum,
  cleanNumber,
  cleanText,
  inventoryCommandFailure,
} from '../_shared/builderInventory.ts';


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

    // Server-held. A browser-supplied organisation_id is never consulted.
    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }

    /**
     * Resolve one project the way `builder-portal-projects` does: live grant,
     * grant organisation equal to the session organisation, project still naming
     * that organisation on the granted side, then the permission matrix.
     */
    const loadProject = async (projectId: string): Promise<
      { ok: true; project: any; perms: BuilderPermissionMatrix; accessRole: string }
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
        .select('id, developer_organisation_id, builder_organisation_id, name, project_reference, status')
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
      return { ok: true, project, perms, accessRole: access.access_role };
    };

    /**
     * Load a unit by id, then authorise it through its parent project and the
     * database's own unit resolver. The second check is not redundant: the
     * resolver additionally applies stage-scoped and unit-scoped DENY overrides
     * that the project matrix does not see.
     */
    const loadUnit = async (
      unitId: string, permissionKey = 'inventory', level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; unit: any; project: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!unitId) return { ok: false, status: 400, error: 'unit_id is required' };

      const { data: unit } = await supabase
        .from('builder_units')
        .select(BUILDER_UNIT_PORTAL_DETAIL_SELECT)
        .eq('id', unitId)
        .maybeSingle();
      if (!unit) return { ok: false, status: 404, error: 'Unit not found' };

      const parent = await loadProject(unit.project_id);
      // A unit whose project the caller cannot see is reported as "not found",
      // never "forbidden" — probing unit ids must not reveal that one exists.
      if (!parent.ok) return { ok: false, status: 404, error: 'Unit not found' };

      const { data: allowed, error } = await supabase.rpc('builder_resolve_unit_permission', {
        _user_id: me.id, _unit_id: unitId, _permission_key: permissionKey, _level: level,
      });
      if (error) throw error;
      if (allowed !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Unit not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this unit' };
      }
      return { ok: true, unit, project: parent.project, perms: parent.perms };
    };

    // ───────────────────────── UNITS ─────────────────────────
    if (operation === 'list_units') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'inventory');
      if (!accessibleProjectIds.length) {
        return json({
          success: true, records: [],
          pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 },
        });
      }

      // A project_id filter narrows within what is already permitted; it can
      // never widen it, because the intersection is taken server-side.
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
        .from('builder_units')
        .select(BUILDER_UNIT_PORTAL_LIST_SELECT, { count: 'exact' })
        .in('project_id', projectIds)
        .order('unit_number', { ascending: true });

      const availability = cleanEnum(body.availability_status, BUILDER_AVAILABILITY_STATUSES);
      if (availability) query = query.eq('availability_status', availability);
      const release = cleanEnum(body.release_status, BUILDER_RELEASE_STATUSES);
      if (release) query = query.eq('release_status', release);
      const unitType = cleanEnum(body.unit_type, BUILDER_UNIT_TYPES);
      if (unitType) query = query.eq('unit_type', unitType);
      const stageId = cleanText(body.stage_id, 64);
      if (stageId) query = query.eq('stage_id', stageId);
      const bedrooms = cleanNumber(body.bedrooms);
      if (bedrooms !== null) query = query.eq('bedrooms', bedrooms);
      const search = cleanText(body.search, 120);
      if (search) {
        const escaped = search.replace(/[%_,()]/g, ' ');
        query = query.or(`unit_number.ilike.%${escaped}%,description.ilike.%${escaped}%`);
      }

      const { data, error, count } = await query.range(from, from + pageSize - 1);
      if (error) throw error;

      const rows = data || [];
      // Current price is a separate row per unit; fetch the current ones only.
      const priceMap = new Map<string, any>();
      if (rows.length) {
        const { data: prices } = await supabase
          .from('builder_unit_pricing')
          .select('unit_id, list_price, price_basis')
          .in('unit_id', rows.map((row: any) => row.id))
          .eq('is_current', true);
        for (const price of prices || []) priceMap.set(price.unit_id, price);
      }

      const records = rows.map((row: any) => ({
        ...row,
        list_price: priceMap.get(row.id)?.list_price ?? null,
        price_basis: priceMap.get(row.id)?.price_basis ?? null,
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

    if (operation === 'get_unit') {
      const res = await loadUnit(String(body.unit_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { unit, project, perms } = res;

      const [
        { data: price }, { data: history }, { data: holds },
        { data: reservations }, { data: allocations },
        { data: stage }, { data: building }, { data: lot },
      ] = await Promise.all([
        supabase.from('builder_unit_pricing').select(BUILDER_PRICING_SELECT)
          .eq('unit_id', unit.id).eq('is_current', true).maybeSingle(),
        supabase.from('builder_unit_status_history').select(BUILDER_UNIT_HISTORY_SELECT)
          .eq('unit_id', unit.id).order('created_at', { ascending: false }).limit(50),
        builderMatrixCan(perms, 'reservations', 'view')
          ? supabase.from('builder_unit_holds').select(BUILDER_HOLD_SELECT)
            .eq('unit_id', unit.id).order('created_at', { ascending: false }).limit(20)
          : Promise.resolve({ data: [] as any[] }),
        builderMatrixCan(perms, 'reservations', 'view')
          ? supabase.from('builder_reservations').select(BUILDER_RESERVATION_SELECT)
            .eq('unit_id', unit.id).order('created_at', { ascending: false }).limit(20)
          : Promise.resolve({ data: [] as any[] }),
        supabase.from('builder_allocations').select(BUILDER_ALLOCATION_SELECT)
          .eq('unit_id', unit.id).order('created_at', { ascending: false }).limit(20),
        unit.stage_id
          ? supabase.from('builder_stages').select(BUILDER_STAGE_SELECT)
            .eq('id', unit.stage_id).maybeSingle()
          : Promise.resolve({ data: null }),
        unit.building_id
          ? supabase.from('builder_buildings').select(BUILDER_BUILDING_SELECT)
            .eq('id', unit.building_id).maybeSingle()
          : Promise.resolve({ data: null }),
        unit.lot_id
          ? supabase.from('builder_lots').select(BUILDER_LOT_SELECT)
            .eq('id', unit.lot_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_unit_viewed', entityType: 'unit', entityId: unit.id,
      });

      return json({
        success: true,
        unit,
        project: { id: project.id, name: project.name, project_reference: project.project_reference },
        current_price: price ?? null,
        status_history: history || [],
        holds: holds || [],
        reservations: reservations || [],
        allocations: allocations || [],
        stage: stage ?? null,
        building: building ?? null,
        lot: lot ?? null,
        permissions: perms,
      });
    }

    if (operation === 'update_unit') {
      const res = await loadUnit(String(body.unit_id || ''), 'inventory', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required' }, 400);
      }
      const payload = buildUnitPayload(body, { isCreate: false });
      if (!Object.keys(payload).length) return json({ error: 'Nothing to update' }, 400);

      // Guarded command: the row write and its trusted audit record share ONE
      // transaction, so a failed audit rolls the update back.
      const { data, error } = await supabase.rpc('builder_upsert_unit', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _unit_id: res.unit.id,
        _project_id: null,
        // A null parent leaves the current one in place. A supplied one is
        // validated by `builder_enforce_unit_parentage`, which refuses a parent
        // belonging to another project — so re-parenting cannot cross projects.
        _stage_id: cleanText(body.stage_id, 64),
        _building_id: cleanText(body.building_id, 64),
        _lot_id: cleanText(body.lot_id, 64),
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        throw error;
      }
      return json({ success: true, unit: data });
    }

    if (operation === 'set_availability' || operation === 'set_release') {
      const res = await loadUnit(String(body.unit_id || ''), 'inventory', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const isAvailability = operation === 'set_availability';
      const next = cleanEnum(
        body.status, isAvailability ? BUILDER_AVAILABILITY_STATUSES : BUILDER_RELEASE_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data, error } = await supabase.rpc(
        isAvailability ? 'builder_transition_unit_availability' : 'builder_transition_unit_release', {
          _unit_id: res.unit.id,
          _expected_version: expectedVersion,
          _from: isAvailability ? res.unit.availability_status : res.unit.release_status,
          _to: next,
          _reason: reason,
          _actor_type: 'builder_user',
          _actor_builder_user_id: me.id,
          _actor_staff_user_id: null,
        });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        return json({ error: 'Unable to change the unit status' }, 400);
      }
      // The transition wrote its own history row and trusted audit record inside
      // the same transaction; a failure there has already rolled it back.
      return json({ success: true, unit: data });
    }

    if (operation === 'unit_history') {
      const res = await loadUnit(String(body.unit_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_unit_status_history')
        .select(BUILDER_UNIT_HISTORY_SELECT)
        .eq('unit_id', res.unit.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    // ───────────────────────── PRICING ─────────────────────────
    if (operation === 'set_price') {
      const res = await loadUnit(String(body.unit_id || ''), 'pricing', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const listPrice = cleanNumber(body.list_price);
      if (listPrice === null || listPrice < 0) {
        return json({ error: 'list_price is required' }, 400);
      }
      const basis = cleanEnum(body.price_basis, BUILDER_PRICE_BASES, 'fixed');

      // Guarded command: retires the previous current price and inserts the new
      // one alongside the trusted audit row in one transaction.
      const { data, error } = await supabase.rpc('builder_set_unit_price', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _unit_id: res.unit.id,
        _list_price: listPrice,
        _price_basis: basis,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        throw error;
      }
      return json({ success: true, price: data });
    }

    if (operation === 'price_history') {
      const res = await loadUnit(String(body.unit_id || ''), 'pricing', 'view');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_unit_pricing').select(BUILDER_PRICING_SELECT)
        .eq('unit_id', res.unit.id).order('effective_from', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    // ───────────────────────── STRUCTURE ─────────────────────────
    if (operation === 'list_stages' || operation === 'list_buildings' || operation === 'list_lots') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'inventory', 'view')) {
        return json({ error: 'You do not have access to this project inventory' }, 403);
      }
      // Written out per table rather than through a computed table name: the
      // generated Supabase types cannot resolve a union of table names.
      const rows = operation === 'list_stages'
        ? await supabase.from('builder_stages').select(BUILDER_STAGE_SELECT)
          .eq('project_id', res.project.id).order('created_at', { ascending: true }).limit(500)
        : operation === 'list_buildings'
          ? await supabase.from('builder_buildings').select(BUILDER_BUILDING_SELECT)
            .eq('project_id', res.project.id).order('created_at', { ascending: true }).limit(500)
          : await supabase.from('builder_lots').select(BUILDER_LOT_SELECT)
            .eq('project_id', res.project.id).order('created_at', { ascending: true }).limit(500);
      if (rows.error) throw rows.error;
      return json({ success: true, records: rows.data || [] });
    }

    if (operation === 'upsert_stage' || operation === 'upsert_building' || operation === 'upsert_lot') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'inventory', 'edit')) {
        return json({ error: 'You do not have permission to change this inventory' }, 403);
      }

      const idField = operation === 'upsert_stage' ? 'stage_id'
        : operation === 'upsert_building' ? 'building_id' : 'lot_id';
      const recordId = cleanText(body[idField], 64);
      let expectedVersion: number | null = null;
      if (recordId) {
        const supplied = Number(body.expected_version);
        if (!Number.isInteger(supplied) || supplied < 1) {
          return json({
            error: 'expected_version is required when updating an existing record',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400);
        }
        expectedVersion = supplied;
      }

      const rpcName = operation === 'upsert_stage' ? 'builder_upsert_stage'
        : operation === 'upsert_building' ? 'builder_upsert_building' : 'builder_upsert_lot';
      const payload = operation === 'upsert_stage' ? buildStagePayload(body)
        : operation === 'upsert_building' ? buildBuildingPayload(body) : buildLotPayload(body);

      const args: Record<string, unknown> = {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _project_id: recordId ? null : res.project.id,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      };
      if (operation === 'upsert_stage') args._stage_id = recordId;
      if (operation === 'upsert_building') {
        args._building_id = recordId;
        // On update a null stage leaves the current parent in place; a supplied
        // one is validated against the project by the parentage trigger.
        args._stage_id = cleanText(body.stage_id, 64);
      }
      if (operation === 'upsert_lot') {
        args._lot_id = recordId;
        args._stage_id = cleanText(body.stage_id, 64);
      }

      const { data, error } = await supabase.rpc(rpcName, args);
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        throw error;
      }
      return json({ success: true, record: data });
    }

    // ───────────────────────── HOLDS ─────────────────────────
    if (operation === 'list_holds') {
      const res = await loadUnit(String(body.unit_id || ''), 'reservations', 'view');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_unit_holds').select(BUILDER_HOLD_SELECT)
        .eq('unit_id', res.unit.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'create_hold') {
      const res = await loadUnit(String(body.unit_id || ''), 'reservations', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const expiresAt = body.expires_at ? String(body.expires_at) : null;
      if (!expiresAt) return json({ error: 'expires_at is required' }, 400);

      // The holding organisation is the SESSION's organisation, never a value
      // from the request body — otherwise a caller could hold stock for someone
      // else's organisation.
      const { data, error } = await supabase.rpc('builder_create_unit_hold', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _unit_id: res.unit.id,
        _organisation_id: activeOrganisationId,
        _expires_at: expiresAt,
        _hold_reference: cleanText(body.hold_reference, 60),
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        if (String(error.message || '').includes('builder_unit_holds_one_active')) {
          return json({ error: 'This unit already has an active hold', code: 'HOLD_EXISTS' }, 409);
        }
        throw error;
      }
      return json({ success: true, hold: data });
    }

    if (operation === 'release_hold') {
      const holdId = cleanText(body.hold_id, 64);
      if (!holdId) return json({ error: 'hold_id is required' }, 400);
      const { data: hold } = await supabase.from('builder_unit_holds')
        .select('id, unit_id').eq('id', holdId).maybeSingle();
      if (!hold) return json({ error: 'Hold not found' }, 404);

      const res = await loadUnit(hold.unit_id, 'reservations', 'edit');
      if (!res.ok) {
        return json({ error: res.status === 404 ? 'Hold not found' : res.error }, res.status);
      }

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required', code: 'EXPECTED_VERSION_REQUIRED' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_release_unit_hold', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _hold_id: hold.id,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        throw error;
      }
      return json({ success: true, hold: data });
    }

    // ───────────────────────── RESERVATIONS ─────────────────────────
    if (operation === 'list_reservations') {
      const requestedUnitId = cleanText(body.unit_id, 64);
      if (requestedUnitId) {
        const res = await loadUnit(requestedUnitId, 'reservations', 'view');
        if (!res.ok) return json({ error: res.error }, res.status);
        const { data } = await supabase.from('builder_reservations')
          .select(BUILDER_RESERVATION_SELECT)
          .eq('unit_id', res.unit.id).order('created_at', { ascending: false }).limit(100);
        return json({ success: true, records: data || [] });
      }

      const projectRes = await loadProject(String(body.project_id || ''));
      if (!projectRes.ok) return json({ error: projectRes.error }, projectRes.status);
      if (!builderMatrixCan(projectRes.perms, 'reservations', 'view')) {
        return json({ error: 'You do not have access to reservations' }, 403);
      }
      const { data: unitRows } = await supabase.from('builder_units')
        .select('id').eq('project_id', projectRes.project.id).limit(2000);
      const unitIds = (unitRows || []).map((row: any) => row.id);
      if (!unitIds.length) return json({ success: true, records: [] });
      const { data } = await supabase.from('builder_reservations')
        .select(BUILDER_RESERVATION_SELECT)
        .in('unit_id', unitIds).order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'create_reservation') {
      const res = await loadUnit(String(body.unit_id || ''), 'reservations', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const payload = buildReservationPayload(body);
      if (!payload.purchaser_name) return json({ error: 'purchaser_name is required' }, 400);

      // As with holds, the reserving organisation is the session's.
      const { data, error } = await supabase.rpc('builder_create_reservation', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _unit_id: res.unit.id,
        _organisation_id: activeOrganisationId,
        _payload: payload,
        _reason: cleanText(body.reason, 500),
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        if (String(error.message || '').includes('builder_reservations_one_active')) {
          return json({ error: 'This unit already has a live reservation', code: 'RESERVATION_EXISTS' }, 409);
        }
        throw error;
      }
      return json({ success: true, reservation: data });
    }

    if (operation === 'set_reservation_status') {
      const reservationId = cleanText(body.reservation_id, 64);
      if (!reservationId) return json({ error: 'reservation_id is required' }, 400);
      const { data: reservation } = await supabase.from('builder_reservations')
        .select('id, unit_id, status').eq('id', reservationId).maybeSingle();
      if (!reservation) return json({ error: 'Reservation not found' }, 404);

      const res = await loadUnit(reservation.unit_id, 'reservations', 'edit');
      if (!res.ok) {
        return json({ error: res.status === 404 ? 'Reservation not found' : res.error }, res.status);
      }

      const next = cleanEnum(body.status, BUILDER_RESERVATION_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_transition_reservation', {
        _reservation_id: reservation.id,
        _expected_version: expectedVersion,
        _from: reservation.status,
        _to: next,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) {
        const mapped = inventoryCommandFailure(String(error.message || ''));
        if (mapped) return json({ error: mapped.error, code: mapped.code }, mapped.status);
        return json({ error: 'Unable to change the reservation status' }, 400);
      }
      return json({ success: true, reservation: data });
    }

    if (operation === 'reservation_history') {
      const reservationId = cleanText(body.reservation_id, 64);
      if (!reservationId) return json({ error: 'reservation_id is required' }, 400);
      const { data: reservation } = await supabase.from('builder_reservations')
        .select('id, unit_id').eq('id', reservationId).maybeSingle();
      if (!reservation) return json({ error: 'Reservation not found' }, 404);
      const res = await loadUnit(reservation.unit_id, 'reservations', 'view');
      if (!res.ok) return json({ error: 'Reservation not found' }, 404);
      const { data } = await supabase.from('builder_reservation_status_history')
        .select(BUILDER_RESERVATION_HISTORY_SELECT)
        .eq('reservation_id', reservation.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    // ───────────────────────── ALLOCATIONS ─────────────────────────
    if (operation === 'list_allocations') {
      const res = await loadUnit(String(body.unit_id || ''), 'inventory', 'view');
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_allocations').select(BUILDER_ALLOCATION_SELECT)
        .eq('unit_id', res.unit.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    // ───────────────────────── STATS ─────────────────────────
    if (operation === 'inventory_stats') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'inventory');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;
      if (!projectIds.length) {
        return json({
          success: true, total: 0, by_availability: {}, by_release: {}, released: 0,
        });
      }
      const { data } = await supabase.from('builder_units')
        .select('availability_status, release_status').in('project_id', projectIds);
      const byAvailability: Record<string, number> = {};
      const byRelease: Record<string, number> = {};
      for (const row of data || []) {
        byAvailability[row.availability_status] = (byAvailability[row.availability_status] || 0) + 1;
        byRelease[row.release_status] = (byRelease[row.release_status] || 0) + 1;
      }
      return json({
        success: true,
        total: (data || []).length,
        by_availability: byAvailability,
        by_release: byRelease,
        released: byRelease.released || 0,
      });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-inventory]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
