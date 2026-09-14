/**
 * Builder / Developer Portal — Transactions
 *
 * Portal-facing sales workspace: transactions, their lifecycle, the pipeline
 * projection, parties, the client link and the transaction-case link. Mirrors
 * `builder-portal-inventory` and `builder-portal-projects` — which mirror
 * `solicitor-portal-matters` — operation shape for operation shape: cookie
 * session, governance gate, server-held active organisation, parent-first access
 * resolution, tri-state permission matrix, guarded transactional commands.
 *
 * Every transaction is reached through its PARENT PROJECT's grant. There is no
 * transaction-level grant a caller could aim at: a transaction id in the body is
 * a lookup key, never authority.
 *
 * DATA BOUNDARY: no cost, margin, supplier price, contractor price or commission
 * is selected here, because no such column exists — the migration asserts that
 * at apply time. `builder_invoices` and `build_progress_payments` are
 * Finance-owned and are not referenced. The case-link projection reports only
 * that a case exists and which slots are filled; the Legal matter's contents,
 * the Finance file's contents and every client financial position stay out.
 *
 * Operations
 *   list_transactions | get_transaction | update_transaction | set_status
 *   list_parties | upsert_party | delete_party
 *   status_history | pipeline | transaction_stats
 *   set_client | link_case | unlink_case | case_link
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
  BUILDER_TRANSACTION_PORTAL_LIST_SELECT,
  BUILDER_TRANSACTION_PORTAL_DETAIL_SELECT,
  BUILDER_TRANSACTION_PARTY_SELECT,
  BUILDER_TRANSACTION_HISTORY_SELECT,
  BUILDER_PIPELINE_STAGE_SELECT,
  BUILDER_CASE_LINK_SELECT,
  BUILDER_TRANSACTION_STATUSES,
  BUILDER_TRANSACTION_TYPES,
  buildTransactionPayload,
  buildTransactionPartyPayload,
  transactionCommandFailure,
  cleanEnum,
  cleanText,
} from '../_shared/builderTransactions.ts';

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

    /** Resolve one project exactly as `builder-portal-projects` does. */
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
     * Load a transaction, then authorise it through its parent project and the
     * database's own resolver. The second check is not redundant: the resolver
     * additionally applies unit-scoped and transaction-scoped DENY overrides
     * that the project matrix does not see.
     */
    const loadTransaction = async (
      transactionId: string, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; transaction: any; project: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!transactionId) return { ok: false, status: 400, error: 'transaction_id is required' };

      const { data: transaction } = await supabase
        .from('builder_transactions')
        .select(BUILDER_TRANSACTION_PORTAL_DETAIL_SELECT)
        .eq('id', transactionId)
        .maybeSingle();
      if (!transaction) return { ok: false, status: 404, error: 'Transaction not found' };

      const parent = await loadProject(transaction.project_id);
      // A transaction whose project the caller cannot see is reported as "not
      // found", never "forbidden" — probing ids must not reveal one exists.
      if (!parent.ok) return { ok: false, status: 404, error: 'Transaction not found' };

      const { data: allowed, error } = await supabase.rpc('builder_resolve_transaction_permission', {
        _user_id: me.id, _transaction_id: transactionId,
        _permission_key: 'transactions', _level: level,
      });
      if (error) throw error;
      if (allowed !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Transaction not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this transaction' };
      }
      return { ok: true, transaction, project: parent.project, perms: parent.perms };
    };

    const fail = (message: string, fallbackStatus = 400, fallbackError = 'The request failed') => {
      const mapped = transactionCommandFailure(message);
      return mapped
        ? json({ error: mapped.error, code: mapped.code }, mapped.status)
        : json({ error: fallbackError }, fallbackStatus);
    };

    // ───────────────────────── LIST ─────────────────────────
    if (operation === 'list_transactions') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'transactions');
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
        .from('builder_transactions')
        .select(BUILDER_TRANSACTION_PORTAL_LIST_SELECT, { count: 'exact' })
        .in('project_id', projectIds)
        .order('created_at', { ascending: false });

      const status = cleanEnum(body.status, BUILDER_TRANSACTION_STATUSES);
      if (status) query = query.eq('status', status);
      const transactionType = cleanEnum(body.transaction_type, BUILDER_TRANSACTION_TYPES);
      if (transactionType) query = query.eq('transaction_type', transactionType);
      const search = cleanText(body.search, 120);
      if (search) {
        const escaped = search.replace(/[%_,()]/g, ' ');
        query = query.or(
          `transaction_reference.ilike.%${escaped}%,purchaser_name.ilike.%${escaped}%`);
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

    // ───────────────────────── DETAIL ─────────────────────────
    if (operation === 'get_transaction') {
      const res = await loadTransaction(String(body.transaction_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { transaction, project, perms } = res;

      const [{ data: parties }, { data: history }, { data: unit }, { data: caseLink }] =
        await Promise.all([
          supabase.from('builder_transaction_parties').select(BUILDER_TRANSACTION_PARTY_SELECT)
            .eq('transaction_id', transaction.id).order('created_at', { ascending: true }),
          supabase.from('builder_transaction_status_history')
            .select(BUILDER_TRANSACTION_HISTORY_SELECT)
            .eq('transaction_id', transaction.id).order('created_at', { ascending: false }).limit(50),
          transaction.unit_id
            ? supabase.from('builder_units')
              .select('id, unit_number, unit_type, availability_status')
              .eq('id', transaction.unit_id).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from('transaction_case_links').select(BUILDER_CASE_LINK_SELECT)
            .eq('builder_transaction_id', transaction.id).maybeSingle(),
        ]);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_transaction_viewed', entityType: 'transaction', entityId: transaction.id,
      });

      return json({
        success: true,
        transaction,
        project: { id: project.id, name: project.name, project_reference: project.project_reference },
        unit: unit ?? null,
        parties: parties || [],
        status_history: history || [],
        // Only the existence of the case link is exposed. Nothing is read from
        // the Legal, Finance or Client side of that case.
        case_link: caseLink ?? null,
        permissions: perms,
      });
    }

    // ───────────────────────── UPDATE ─────────────────────────
    if (operation === 'update_transaction') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required', code: 'EXPECTED_VERSION_REQUIRED' }, 400);
      }
      // The reference is Command Centre owned, exactly as matter_reference is.
      const payload = buildTransactionPayload(body, { isCreate: false, audience: 'builder' });
      if (!Object.keys(payload).length) return json({ error: 'Nothing to update' }, 400);

      // Guarded command: the row write and its trusted audit record share ONE
      // transaction, so a failed audit rolls the update back.
      const { data, error } = await supabase.rpc('builder_upsert_transaction', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _project_id: null,
        _unit_id: cleanText(body.unit_id, 64),
        _organisation_id: null,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The transaction could not be updated');
      return json({ success: true, transaction: data });
    }

    // ───────────────────────── STATUS ─────────────────────────
    if (operation === 'set_status') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const next = cleanEnum(body.status, BUILDER_TRANSACTION_STATUSES);
      const expectedVersion = Number(body.expected_version);
      const reason = cleanText(body.reason, 1000);
      if (!next || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason) {
        return json({ error: 'status, expected_version and reason are required' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_transition_transaction', {
        _transaction_id: res.transaction.id,
        _expected_version: expectedVersion,
        _from: res.transaction.status,
        _to: next,
        _reason: reason,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _actor_staff_user_id: null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The status could not be changed');
      // The transition wrote its own history row and trusted audit record inside
      // the same transaction; a failure there has already rolled it back.
      return json({ success: true, transaction: data });
    }

    // ───────────────────────── PARTIES ─────────────────────────
    if (operation === 'list_parties') {
      const res = await loadTransaction(String(body.transaction_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_transaction_parties')
        .select(BUILDER_TRANSACTION_PARTY_SELECT)
        .eq('transaction_id', res.transaction.id).order('created_at', { ascending: true });
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_party') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const partyId = cleanText(body.party_id, 64);
      let expectedVersion: number | null = null;
      if (partyId) {
        const supplied = Number(body.expected_version);
        if (!Number.isInteger(supplied) || supplied < 1) {
          return json({
            error: 'expected_version is required when updating an existing party',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400);
        }
        expectedVersion = supplied;
      }

      const payload = buildTransactionPartyPayload(body);
      if (!payload.name) return json({ error: 'Party name is required' }, 400);

      // Guarded command: the party write and its trusted audit row share one
      // transaction. The party id is scoped to this transaction inside the
      // command, so an id belonging to another one matches no row.
      const { data, error } = await supabase.rpc('builder_upsert_transaction_party', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _party_id: partyId,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The party could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'delete_party') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'delete');
      if (!res.ok) return json({ error: res.error }, res.status);
      if (!builderMatrixCan(res.perms, 'transactions', 'delete')) {
        return json({ error: 'You do not have permission to remove parties' }, 403);
      }
      const partyId = cleanText(body.party_id, 64);
      if (!partyId) return json({ error: 'party_id is required' }, 400);

      const { error } = await supabase.rpc('builder_delete_transaction_party', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _party_id: partyId,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The party could not be removed');
      return json({ success: true });
    }

    // ───────────────────────── CLIENT AND CASE ─────────────────────────
    if (operation === 'set_client') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const expectedVersion = Number(body.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json({ error: 'expected_version is required', code: 'EXPECTED_VERSION_REQUIRED' }, 400);
      }

      const { data, error } = await supabase.rpc('builder_set_transaction_client', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _client_id: cleanText(body.client_id, 64),
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The client could not be set');
      return json({ success: true, transaction: data });
    }

    if (operation === 'case_link') {
      const res = await loadTransaction(String(body.transaction_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('transaction_case_links').select(BUILDER_CASE_LINK_SELECT)
        .eq('builder_transaction_id', res.transaction.id).maybeSingle();
      return json({ success: true, case_link: data ?? null });
    }

    if (operation === 'link_case') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);
      const caseId = cleanText(body.case_id, 64);
      if (!caseId) return json({ error: 'case_id is required' }, 400);

      // The guarded command re-checks that the transaction has a client and
      // that the case belongs to the same client. A case id from the browser is
      // a lookup key, never proof of anything.
      const { data, error } = await supabase.rpc('builder_link_transaction_to_case', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _case_id: caseId,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The case could not be linked');
      return json({
        success: true,
        case_link: data
          ? { id: data.id, case_id: data.case_id, builder_transaction_id: data.builder_transaction_id,
              link_source: data.link_source, linked_at: data.linked_at }
          : null,
      });
    }

    if (operation === 'unlink_case') {
      const res = await loadTransaction(String(body.transaction_id || ''), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const { error } = await supabase.rpc('builder_unlink_transaction_from_case', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _transaction_id: res.transaction.id,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The case could not be unlinked');
      return json({ success: true });
    }

    // ───────────────────────── HISTORY / PIPELINE / STATS ─────────────────────────
    if (operation === 'status_history') {
      const res = await loadTransaction(String(body.transaction_id || ''));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_transaction_status_history')
        .select(BUILDER_TRANSACTION_HISTORY_SELECT)
        .eq('transaction_id', res.transaction.id).order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'pipeline') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'transactions');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;

      const { data: stages } = await supabase.from('builder_transaction_pipeline_stages')
        .select(BUILDER_PIPELINE_STAGE_SELECT).order('stage_order', { ascending: true });

      if (!projectIds.length) {
        return json({ success: true, stages: stages || [], columns: [] });
      }

      const { data: rows } = await supabase.from('builder_transactions')
        .select(BUILDER_TRANSACTION_PORTAL_LIST_SELECT).in('project_id', projectIds)
        .order('updated_at', { ascending: false }).limit(500);

      // The mapping lives in the database so the portal and the Command Centre
      // group identically and a status can never appear in two columns.
      const stageForStatus = new Map<string, any>((stages || []).map((s: any) => [s.status, s]));
      const columns = new Map<string, any>();
      for (const stage of stages || []) {
        if (!columns.has(stage.stage_key)) {
          columns.set(stage.stage_key, {
            stage_key: stage.stage_key, stage_label: stage.stage_label,
            stage_order: stage.stage_order, is_terminal: stage.is_terminal, records: [],
          });
        }
      }
      for (const row of rows || []) {
        const stage = stageForStatus.get(row.status);
        if (stage) columns.get(stage.stage_key)?.records.push(row);
      }

      return json({
        success: true,
        stages: stages || [],
        columns: [...columns.values()].sort((a, b) => a.stage_order - b.stage_order),
      });
    }

    if (operation === 'transaction_stats') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId, 'transactions');
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;
      if (!projectIds.length) {
        return json({ success: true, total: 0, by_status: {}, at_risk: 0, unlinked: 0 });
      }
      const { data } = await supabase.from('builder_transactions')
        .select('status, risk_flag, client_id').in('project_id', projectIds);
      const byStatus: Record<string, number> = {};
      let atRisk = 0;
      let unlinked = 0;
      for (const row of data || []) {
        byStatus[row.status] = (byStatus[row.status] || 0) + 1;
        if (row.risk_flag) atRisk += 1;
        if (!row.client_id) unlinked += 1;
      }
      return json({
        success: true, total: (data || []).length, by_status: byStatus,
        at_risk: atRisk, unlinked,
      });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-transactions]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
