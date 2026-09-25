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
 *   status_history | project_stats | image_url
 *
 * The property a project IS — the Stock List record its activation named —
 * is read through `readPropertyViews`, the Stock List's own overlay and image
 * rows, so a project shows the same figures and the same photograph. Its
 * photograph is served by `image_url` to anybody the PROJECT is open to:
 * project access, not the Stock List's inventory permission, is what opens a
 * project, and a photograph is part of the project it belongs to.
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
import { readBoundedJson, DEFAULT_MAX_BODY_BYTES } from '../_shared/validate.ts';
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
import { readPropertyViews } from '../_shared/builderStock/propertyView.ts';
import { projectStockItemIds } from '../_shared/builderStock/projectProperty.pure.ts';
import { serveStockImage } from '../_shared/builderStock/serveStockImage.ts';

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

    // Bounded BEFORE the session is resolved below, so an unauthenticated
    // caller cannot make this isolate buffer a body of any size it likes.
    const body = await readBoundedJson(req, DEFAULT_MAX_BODY_BYTES)
      .catch(() => ({} as Record<string, any>));
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

    /**
     * The activation that opened each project, keyed by project id.
     *
     * A project opened by `builder_stock_activation_fanout` carries its
     * announcement via `activation_project_id`; the announcement carries the
     * agency's own disclosure. Both reads are pinned to the session's active
     * organisation, so a project reachable through a developer-side grant can
     * never leak another organisation's activation record. The agency name
     * falls back to the directory name the workspace asserted to the network —
     * the same resolution the fan-out and the collaboration surfaces use.
     */
    const loadActivationContext = async (
      projectIds: string[],
    ): Promise<Map<string, Record<string, unknown>>> => {
      const byProject = new Map<string, Record<string, unknown>>();
      const ids = projectIds.filter(Boolean);
      if (!ids.length) return byProject;

      const { data: announcements } = await supabase
        .from('builder_stock_selection_announcements')
        .select('id, stock_item_id, status, acknowledged_at, remote_client_label, agency_name, agency_contact, activation_task_id, activation_project_id, connection_id, created_at')
        .eq('organisation_id', activeOrganisationId)
        .in('activation_project_id', ids)
        .order('created_at', { ascending: true });
      if (!announcements?.length) return byProject;

      const clean = (value: unknown): string | null => {
        const s = String(value ?? '').trim();
        return s.length ? s : null;
      };

      const bareConnections = Array.from(new Set(
        announcements.filter((a: any) => !a.agency_name)
          .map((a: any) => a.connection_id).filter(Boolean)));
      const labelByConnection = new Map<string, string>();
      if (bareConnections.length) {
        const { data: connections } = await supabase.from('workspace_connections')
          .select('id, workspace_id').in('id', bareConnections);
        const workspaceIds = Array.from(new Set(
          (connections ?? []).map((c: any) => c.workspace_id).filter(Boolean)));
        const { data: registry } = workspaceIds.length
          ? await supabase.from('workspace_registry')
            .select('id, slug, display_name').in('id', workspaceIds)
          : { data: [] as any[] };
        const registryById = new Map((registry ?? []).map((w: any) => [w.id, w]));
        for (const connection of connections ?? []) {
          const workspace = registryById.get(connection.workspace_id) as
            | { display_name: string | null; slug: string } | undefined;
          if (workspace) {
            labelByConnection.set(
              connection.id, workspace.display_name || workspace.slug);
          }
        }
      }

      for (const a of announcements as any[]) {
        const contact = (a.agency_contact ?? {}) as Record<string, unknown>;
        byProject.set(a.activation_project_id, {
          announcement_id: a.id,
          task_id: a.activation_task_id ?? null,
          project_id: a.activation_project_id,
          stock_item_id: a.stock_item_id ?? null,
          status: a.status,
          acknowledged_at: a.acknowledged_at ?? null,
          activated_at: a.created_at,
          agency_name: a.agency_name || labelByConnection.get(a.connection_id) || null,
          contact_name: clean(contact.contact_name),
          contact_email: clean(contact.contact_email),
          contact_phone: clean(contact.contact_phone),
          client_reference: clean(a.remote_client_label),
        });
      }
      return byProject;
    };

    /**
     * The Stock List property each project IS, keyed by project id: the one
     * its activation named, else the one whose own row names the project
     * (`projectStockItemIds`). Pinned to the session's organisation.
     */
    const loadProjectStockIds = async (
      projectIds: string[],
      activationByProject: Map<string, Record<string, unknown>>,
    ): Promise<Map<string, string>> => {
      const ids = projectIds.filter(Boolean);
      if (!ids.length) return new Map();
      const { data: linked } = await supabase
        .from('builder_stock_items')
        .select('id, builder_project_id, updated_at')
        .eq('organisation_id', activeOrganisationId)
        .in('builder_project_id', ids);
      return projectStockItemIds({
        projectIds: ids,
        activationStockItemByProject: new Map(ids.map((id) =>
          [id, (activationByProject.get(id)?.stock_item_id as string | null | undefined) ?? null])),
        linkedStock: (linked ?? []) as any[],
      });
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

      // Light activation context: enough for the list to say which agency
      // opened a row and where the acknowledgement stands, without the
      // contact block the detail view carries.
      const activationByProject = await loadActivationContext(rows.map((row: any) => row.id));

      // The property each row IS, as the Stock List serves it: the list draws
      // its photograph and headline figures.
      const stockIdByProject = await loadProjectStockIds(
        rows.map((row: any) => row.id), activationByProject);
      const views = await readPropertyViews(supabase, {
        organisationId: activeOrganisationId,
        stockItemIds: [...stockIdByProject.values()],
      });

      const records = rows.map((row: any) => {
        const activation = activationByProject.get(row.id) ?? null;
        const stockItemId = stockIdByProject.get(row.id);
        return {
          ...row,
          property: stockItemId ? views.get(stockItemId)?.item ?? null : null,
          developer_organisation_name: organisationMap.get(row.developer_organisation_id) ?? null,
          builder_organisation_name: organisationMap.get(row.builder_organisation_id) ?? null,
          activation: activation
            ? {
              status: activation.status,
              agency_name: activation.agency_name,
              acknowledged_at: activation.acknowledged_at,
            }
            : null,
        };
      });

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

      // The activation that opened this project, with the property record it
      // was opened for. The stock read is organisation-pinned: the item is
      // served only when it belongs to the organisation this session acts as.
      const activationByProject = await loadActivationContext([project.id]);
      const activation = activationByProject.get(project.id) ?? null;
      if (activation) {
        // On this surface the project IS the property, so its name is the
        // label — the same string the fan-out named the project with.
        activation.property_label = project.name;
      }
      // The property this project IS, read exactly as the Stock List reads
      // it — overlay, images and the documents its own row links to.
      const stockIdByProject = await loadProjectStockIds([project.id], activationByProject);
      const stockItemId = stockIdByProject.get(project.id) ?? null;
      const views = await readPropertyViews(supabase, {
        organisationId: activeOrganisationId,
        stockItemIds: stockItemId ? [stockItemId] : [],
      });
      const view = stockItemId ? views.get(stockItemId) ?? null : null;
      const stockItem: Record<string, unknown> | null = view?.item ?? null;

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
        activation,
        stock_item: stockItem,
        property_documents: view?.documents ?? [],
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

    // ───────────────────────── PROPERTY PHOTOGRAPH ─────────────────────────
    if (operation === 'image_url') {
      const res = await loadProject(String(body.project_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const imageId = String(body.image_id || '').trim();
      if (!imageId) return json({ error: 'image_id is required' }, 400);

      // Only this project's own property, in this organisation. An image id
      // is a value the caller supplies; one belonging to any other property
      // answers exactly as one that does not exist.
      const activationByProject = await loadActivationContext([res.project.id]);
      const stockItemId = (await loadProjectStockIds([res.project.id], activationByProject))
        .get(res.project.id);
      if (!stockItemId) return json({ error: 'Image not found' }, 404);
      const { data: image } = await supabase
        .from('builder_stock_item_images')
        .select('id')
        .eq('id', imageId)
        .eq('stock_item_id', stockItemId)
        .eq('organisation_id', activeOrganisationId)
        .maybeSingle();
      if (!image) return json({ error: 'Image not found' }, 404);

      const served = await serveStockImage(supabase, {
        imageId, organisationId: activeOrganisationId,
      });
      if (!served.ok) {
        return json({ error: served.reason === 'not_found' ? 'Image not found' : 'Image not ready' },
          served.reason === 'not_found' ? 404 : 409);
      }
      return json({ success: true, url: served.url, expires_in: served.expiresIn });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-projects]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
