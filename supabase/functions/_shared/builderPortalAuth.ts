/**
 * Builder / Developer Portal — shared session resolution, governance and permissions.
 *
 * Mirrors `_shared/solicitorPortalAuth.ts`: every `builder-portal-*` function
 * funnels through `resolveBuilderSession`, so there is exactly ONE place that
 * decides whether a caller is a valid Builder user and what they may touch.
 * Later phases must not re-implement any of it.
 *
 * Divergences from the Solicitor module, all deliberate:
 *   * Cookie-only. No legacy header or body carrier is accepted.
 *   * Organisation reach is resolved server-side from memberships, never from a
 *     browser-supplied organisation id.
 *   * Permissions come from the Phase 1 deny-by-default
 *     `builder_resolve_permission()`. There is no default-allow key set and no
 *     OR-merge (Phase 0 NOCOPY-01).
 */
import { extractBuilderSessionToken, validateBuilderPortalHeaders } from './builderSessionToken.ts';
import { resolveBuilderSessionToken } from './builderSessions.ts';

export interface BuilderOrganisationSummary {
  organisation_id: string;
  legal_name: string;
  trading_name: string | null;
  org_type: string;
  membership_role: string;
  is_primary: boolean;
}

export interface BuilderSessionUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  job_title: string | null;
  status: string;
  must_change_password: boolean;
  /** The stored flag on the row. Mirrors `SolicitorSessionUser.has_accepted_terms`. */
  has_accepted_terms: boolean;
  has_completed_onboarding: boolean;
  last_seen_at: string | null;
  current_terms_version: string | null;
  /** Derived: an acceptance row exists for the CURRENT terms version. */
  has_accepted_current_terms: boolean;
  /** Derived: every mandatory onboarding step is completed. */
  has_completed_mandatory_onboarding: boolean;
}

export interface BuilderSessionResult {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  user?: BuilderSessionUser;
  session_id?: string;
  organisations?: BuilderOrganisationSummary[];
  active_organisation?: BuilderOrganisationSummary | null;
}

/**
 * Permission keys the Builder Portal may resolve. Mirrors
 * SOLICITOR_PERMISSION_KEYS. The catalogue itself lives in
 * `builder_permission_keys`; this list is the surface the portal asks about.
 */
export const BUILDER_PERMISSION_KEYS = [
  'organisation', 'org_admin', 'projects', 'inventory', 'pricing', 'reservations',
  'transactions', 'contracts', 'construction', 'variations', 'progress_claims',
  'inspections', 'defects', 'handover', 'documents', 'messages', 'tasks', 'audit',
  'finance_status', 'legal_status', 'settlement_status',
] as const;

/**
 * Keys that are ALWAYS denied to Builder users regardless of any stored grant.
 * Enforced again in the database by `builder_resolve_permission`; duplicated
 * here so a handler that forgets to call the resolver still cannot ask for one.
 */
export const BUILDER_FORBIDDEN_KEYS = new Set<string>([
  'income', 'expenses', 'assets', 'liabilities', 'employment',
  'borrowing_capacity', 'serviceability', 'commissions',
  'aml_restricted', 'smr', 'mlro', 'legal_privileged', 'conflict_checks',
  'finance_private', 'command_private', 'solicitor_private',
  // Named after the Finance-owned tables themselves. `builder_invoices` and
  // `build_progress_payments` carry the "builder" prefix but are Finance data,
  // so a future permission key borrowing the table name is refused here rather
  // than resolving through the normal matrix.
  'builder_invoices', 'build_progress_payments',
]);

const BUILDER_USER_SELECT = `id, email, name, phone, job_title, status, is_active,
  revoked_at, must_change_password, has_accepted_current_terms,
  has_completed_onboarding, last_seen_at`;

/**
 * Resolve the caller's Builder session.
 *
 * Order matters and is the same order the governance gate uses:
 *   1. portal headers and origin
 *   2. cookie present
 *   3. session valid, unexpired, unrevoked (database re-checks user + membership)
 *   4. user active
 *   5. at least one active membership
 *   6. active organisation still reachable
 *
 * Terms and onboarding are reported but NOT enforced here — handlers call
 * `builderGovernanceError()` so the terms and onboarding endpoints themselves
 * remain reachable while ungoverned.
 */
export async function resolveBuilderSession(
  supabase: any,
  req: Request,
): Promise<BuilderSessionResult> {
  if (!validateBuilderPortalHeaders(req.headers)) {
    return { ok: false, status: 401, error: 'Invalid or expired session', code: 'auth_required' };
  }

  const token = extractBuilderSessionToken(req.headers);
  if (!token) {
    return { ok: false, status: 401, error: 'Invalid or expired session', code: 'auth_required' };
  }

  const resolved = await resolveBuilderSessionToken(supabase, token);
  if (!resolved) {
    return { ok: false, status: 401, error: 'Invalid or expired session', code: 'auth_required' };
  }

  const { data: user, error: userError } = await supabase
    .from('builder_portal_users').select(BUILDER_USER_SELECT)
    .eq('id', resolved.builder_user_id).maybeSingle();

  if (userError || !user) {
    return { ok: false, status: 401, error: 'Invalid or expired session', code: 'auth_required' };
  }
  if (!user.is_active || user.status !== 'active' || user.revoked_at) {
    return {
      ok: false, status: 403, code: 'access_revoked',
      error: 'Your access has been revoked. Please contact your administrator.',
    };
  }

  const organisations = await listAccessibleOrganisations(supabase, user.id);
  if (!organisations.length) {
    return {
      ok: false, status: 403, code: 'no_membership',
      error: 'You do not have an active organisation membership. Please contact your administrator.',
    };
  }

  const { data: sessionRow } = await supabase
    .from('builder_portal_sessions').select('active_organisation_id')
    .eq('id', resolved.session_id).maybeSingle();

  // A stored selection that is no longer reachable — membership revoked, or the
  // organisation suspended — is dropped rather than honoured.
  const stored = sessionRow?.active_organisation_id ?? null;
  let active = stored
    ? organisations.find((organisation) => organisation.organisation_id === stored) ?? null
    : null;

  // Automatic selection: the accessible primary membership, or the only
  // accessible organisation. Otherwise the caller must choose.
  if (!active) {
    active = organisations.find((organisation) => organisation.is_primary)
      ?? (organisations.length === 1 ? organisations[0] : null);
  }

  // Governance is DERIVED here, exactly as `resolveSolicitorSession` derives it:
  // the current terms version is looked up, then an acceptance row for THAT
  // version, and the mandatory onboarding steps are counted. Reading the stored
  // `has_accepted_current_terms` flag instead would leave every existing user
  // showing as accepted the moment a new terms version is published, because
  // nothing clears the flag — acceptance would no longer be version-exact.
  const { data: terms } = await supabase
    .from('portal_terms_versions').select('id, version')
    .eq('portal', 'builder').is('retired_at', null)
    .lte('effective_at', new Date().toISOString())
    .order('effective_at', { ascending: false }).limit(1).maybeSingle();

  const [{ data: acceptance }, { data: onboarding }] = await Promise.all([
    terms
      ? supabase.from('portal_terms_acceptances').select('id')
        .eq('terms_version_id', terms.id).eq('builder_user_id', user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('builder_onboarding_steps').select('mandatory, completed_at')
      .eq('builder_user_id', user.id),
  ]);
  const mandatorySteps = (onboarding || []).filter((step: any) => step.mandatory);
  const mandatoryComplete = mandatorySteps.length > 0
    && mandatorySteps.every((step: any) => !!step.completed_at);

  return {
    ok: true,
    status: 200,
    session_id: resolved.session_id,
    organisations,
    active_organisation: active,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone ?? null,
      job_title: user.job_title ?? null,
      status: user.status,
      must_change_password: !!user.must_change_password,
      has_accepted_terms: !!user.has_accepted_current_terms,
      has_completed_onboarding: !!user.has_completed_onboarding,
      last_seen_at: user.last_seen_at ?? null,
      current_terms_version: terms?.version ?? null,
      has_accepted_current_terms: !!terms && !!acceptance,
      has_completed_mandatory_onboarding: mandatoryComplete,
    },
  };
}

/**
 * Organisations this user may actually reach.
 * Derived entirely server-side from `builder_accessible_organisations`, which
 * requires the user, the membership and the organisation all to be active.
 */
export async function listAccessibleOrganisations(
  supabase: any,
  userId: string,
): Promise<BuilderOrganisationSummary[]> {
  const { data: accessible, error } = await supabase.rpc('builder_accessible_organisations', {
    _user_id: userId,
  });
  if (error || !Array.isArray(accessible) || !accessible.length) return [];

  const ids = accessible.map((row: any) => row.organisation_id);
  const [{ data: organisations }, { data: memberships }] = await Promise.all([
    supabase.from('builder_organisations')
      .select('id, legal_name, trading_name, org_type').in('id', ids),
    supabase.from('builder_organisation_memberships')
      .select('organisation_id, is_primary')
      .eq('builder_user_id', userId).is('revoked_at', null).in('organisation_id', ids),
  ]);

  const primaryBy = new Map<string, boolean>(
    (memberships ?? []).map((m: any) => [m.organisation_id, !!m.is_primary]),
  );
  // Explicitly typed: the PostgREST row type erases to `{}`, which silently
  // turns every field read below into a type error the scoped Deno check
  // catches but an untyped Map would hide.
  const detailBy = new Map<string, { legal_name: string; trading_name: string | null; org_type: string }>(
    (organisations ?? []).map((o: any) => [o.id, o]),
  );

  const summaries: BuilderOrganisationSummary[] = [];
  for (const row of accessible) {
    const detail = detailBy.get(row.organisation_id);
    if (!detail) continue;
    summaries.push({
      organisation_id: row.organisation_id,
      legal_name: detail.legal_name,
      trading_name: detail.trading_name ?? null,
      org_type: detail.org_type,
      membership_role: row.membership_role,
      is_primary: primaryBy.get(row.organisation_id) === true,
    });
  }
  return summaries.sort((a, b) => Number(b.is_primary) - Number(a.is_primary)
    || a.legal_name.localeCompare(b.legal_name));
}

/**
 * The governance gate. Returns a machine-readable reason, or null when the
 * caller may proceed to a protected resource. Browser route guards mirror this
 * order for the journey; THIS is the authorization control.
 */
export function builderGovernanceError(result: BuilderSessionResult): string | null {
  if (!result.user) return 'auth_required';
  if (result.user.must_change_password) return 'password_rotation_required';
  if (!result.active_organisation) return 'organisation_selection_required';
  if (!result.user.has_accepted_current_terms) return 'terms_acceptance_required';
  if (!result.user.has_completed_mandatory_onboarding) return 'onboarding_required';
  return null;
}

/**
 * Deny-by-default permission resolution for one organisation.
 *
 * `organisationId` is verified against the caller's resolved reach before the
 * database is asked, so a forged organisation id can never widen access.
 */
export async function builderCan(
  supabase: any,
  session: BuilderSessionResult,
  organisationId: string,
  permissionKey: string,
  level: 'view' | 'edit' | 'delete' = 'view',
): Promise<boolean> {
  if (BUILDER_FORBIDDEN_KEYS.has(permissionKey)) return false;
  if (!session.ok || !session.user) return false;
  if (!session.organisations?.some((o) => o.organisation_id === organisationId)) return false;

  const { data, error } = await supabase.rpc('builder_resolve_permission', {
    _user_id: session.user.id,
    _org_id: organisationId,
    _permission_key: permissionKey,
    _level: level,
  });
  if (error) {
    console.error('[builderPortalAuth] permission resolution failed', error.message);
    return false;
  }
  return data === true;
}

/**
 * Resolve the full permission matrix for one organisation, for the client to
 * render with. Every key is resolved server-side; the browser receives a
 * result, never a policy it could edit.
 */
export async function builderPermissionMatrix(
  supabase: any,
  session: BuilderSessionResult,
  organisationId: string,
): Promise<Record<string, { view: boolean; edit: boolean; delete: boolean }>> {
  const matrix: Record<string, { view: boolean; edit: boolean; delete: boolean }> = {};
  for (const key of BUILDER_PERMISSION_KEYS) {
    const [view, edit, remove] = await Promise.all([
      builderCan(supabase, session, organisationId, key, 'view'),
      builderCan(supabase, session, organisationId, key, 'edit'),
      builderCan(supabase, session, organisationId, key, 'delete'),
    ]);
    matrix[key] = { view, edit, delete: remove };
  }
  return matrix;
}

// ===========================================================================
// Phase 3 — project access
//
// Mirrors the matter-access half of `_shared/solicitorPortalAuth.ts`:
//   resolveSolicitorMatterAccess -> resolveBuilderProjectAccess
//   resolveMatterPermissions     -> resolveBuilderProjectPermissions
//   listAccessibleMatterIds      -> listAccessibleBuilderProjectIds
//   logSolicitorActivity         -> logBuilderProjectActivity
//
// The resolution itself lives in the database (`builder_resolve_project_permission`),
// exactly as Phase 1 put permission resolution there. These functions are the
// thin adapter, not a second implementation.
// ===========================================================================

/**
 * A resolved permission matrix, as returned to a caller and to the browser.
 * Mirrors `PermissionMatrix` in `_shared/solicitorPortalAuth.ts`.
 */
export type BuilderPermissionMatrix = Record<string, { view: boolean; edit: boolean; delete: boolean }>;

/**
 * Read an already-resolved matrix. Mirrors `can(matrix, key, level)` on the
 * Solicitor side.
 *
 * Named `builderMatrixCan` rather than `builderCan` because this module already
 * exports an ASYNC `builderCan(supabase, session, organisationId, ...)` that
 * resolves an organisation permission against the database. Two functions with
 * the same name and different arities would be an easy call-site mistake, and a
 * silently-awaited boolean is always truthy.
 */
export function builderMatrixCan(
  matrix: BuilderPermissionMatrix | null,
  permissionKey: string,
  level: 'view' | 'edit' | 'delete' = 'view',
): boolean {
  if (BUILDER_FORBIDDEN_KEYS.has(permissionKey)) return false;
  if (!matrix) return false;
  return matrix[permissionKey]?.[level] === true;
}

export interface BuilderProjectAccess {
  id: string;
  builder_user_id: string;
  project_id: string;
  organisation_id: string;
  organisation_side: 'developer' | 'builder';
  access_role: string;
  permissions: Record<string, Record<string, string>>;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
  row_version: number;
}

/**
 * Resolve one user's live grant for one project.
 *
 * Returns null for absent, revoked, not-yet-valid and expired grants — the
 * database does the window arithmetic so a clock difference in the function
 * runtime cannot widen access. A project id supplied by the browser is only ever
 * a lookup key here; it is never treated as proof of anything.
 */
export async function resolveBuilderProjectAccess(
  supabase: any,
  builderUserId: string,
  projectId: string,
): Promise<BuilderProjectAccess | null> {
  if (!projectId) return null;
  const { data, error } = await supabase
    .from('builder_project_access')
    .select(`id, builder_user_id, project_id, organisation_id, organisation_side,
             access_role, permissions, valid_from, valid_until, revoked_at, row_version`)
    .eq('builder_user_id', builderUserId)
    .eq('project_id', projectId)
    .is('revoked_at', null)
    .lte('valid_from', new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;
  // Expiry is re-checked here as well as in the database so an expired grant can
  // never be returned by this adapter even if the query above is later relaxed.
  if (data.valid_until && new Date(data.valid_until).getTime() <= Date.now()) return null;
  return data as BuilderProjectAccess;
}

/**
 * The effective permission matrix for one grant, resolved by the database.
 *
 * `builder_resolve_project_permission` applies, in order: the grant must be live,
 * the organisation baseline from Phase 1 (which denies forbidden keys, requires
 * an active membership and clamps read_only), the project-scoped membership
 * override, the grant's own tri-state override, a forbidden-key re-assertion,
 * and the grant's read_only clamp.
 */
export async function resolveBuilderProjectPermissions(
  supabase: any,
  access: BuilderProjectAccess,
): Promise<BuilderPermissionMatrix> {
  const matrix: BuilderPermissionMatrix = {};
  for (const key of BUILDER_PERMISSION_KEYS) {
    if (BUILDER_FORBIDDEN_KEYS.has(key)) {
      matrix[key] = { view: false, edit: false, delete: false };
      continue;
    }
    const [view, edit, remove] = await Promise.all(
      (['view', 'edit', 'delete'] as const).map(async (level) => {
        const { data } = await supabase.rpc('builder_resolve_project_permission', {
          _user_id: access.builder_user_id,
          _project_id: access.project_id,
          _permission_key: key,
          _level: level,
        });
        return data === true;
      }),
    );
    matrix[key] = { view, edit, delete: remove };
  }
  return matrix;
}

/**
 * Every project id this user may currently see, optionally narrowed to the
 * session's active organisation. Mirrors `listAccessibleMatterIds`.
 */
export async function listAccessibleBuilderProjectIds(
  supabase: any,
  builderUserId: string,
  organisationId: string | null = null,
  permissionKey = 'projects',
): Promise<string[]> {
  const { data, error } = await supabase.rpc('builder_accessible_projects', {
    _user_id: builderUserId,
    _organisation_id: organisationId,
    _permission_key: permissionKey,
  });
  if (error || !Array.isArray(data)) return [];
  return data.map((row: any) => row.project_id);
}

/**
 * Every unit id this user may currently see, optionally narrowed to the
 * session's active organisation. The database resolver walks the parent project
 * first, so a unit can never be visible when its project is not.
 */
export async function listAccessibleBuilderUnitIds(
  supabase: any,
  builderUserId: string,
  organisationId: string | null = null,
  permissionKey = 'inventory',
): Promise<string[]> {
  const { data, error } = await supabase.rpc('builder_accessible_units', {
    _user_id: builderUserId,
    _organisation_id: organisationId,
    _permission_key: permissionKey,
  });
  if (error || !Array.isArray(data)) return [];
  return data.map((row: any) => row.unit_id);
}

/**
 * Entity types the trusted activity log accepts. Kept in step with the
 * `builder_portal_activity_log_entity_type_check` CHECK constraint: a value that
 * is not in both places is rejected by the database at write time.
 */
export type BuilderActivityEntityType =
  | 'organisation' | 'portal_user' | 'membership' | 'membership_permissions' | 'session'
  | 'development' | 'project' | 'project_party' | 'project_access'
  | 'stage' | 'building' | 'lot' | 'unit' | 'unit_price' | 'unit_hold'
  | 'reservation' | 'allocation'
  | 'transaction' | 'transaction_party' | 'transaction_case_link'
  | 'construction_case' | 'construction_stage' | 'milestone'
  | 'progress_update' | 'photograph'
  | 'variation' | 'variation_approval' | 'progress_claim'
  | 'inspection' | 'defect' | 'practical_completion' | 'handover' | 'warranty_claim'
  | 'document' | 'document_version' | 'document_grant'
  | 'conversation' | 'message' | 'task' | 'task_assignment' | 'notification'
  | 'stock_upload' | 'stock_item' | 'stock_selection';

/**
 * Append a project event to the trusted activity log.
 *
 * Returns whether the write succeeded, like `auditBuilderIdentity` and unlike
 * `logSolicitorActivity`, which swallows the failure (Phase 0 NOCOPY-04).
 * Callers performing an access-control change must fail closed on `false`.
 */
export async function logBuilderProjectActivity(
  supabase: any,
  req: Request,
  entry: {
    actorUserId?: string | null;
    actorType?: 'builder_user' | 'command_user' | 'service_role' | 'system';
    builderUserId?: string | null;
    organisationId?: string | null;
    action: string;
    entityType?: BuilderActivityEntityType;
    entityId?: string | null;
    previousState?: Record<string, unknown> | null;
    newState?: Record<string, unknown> | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const { error } = await supabase.rpc('builder_log_activity', {
    _actor_user_id: entry.actorUserId ?? null,
    _actor_type: entry.actorType ?? 'builder_user',
    _action: entry.action,
    _entity_type: entry.entityType ?? 'project',
    _entity_id: entry.entityId ?? null,
    _organisation_id: entry.organisationId ?? null,
    _builder_user_id: entry.builderUserId ?? null,
    _previous_state: entry.previousState ?? null,
    _new_state: entry.newState ?? null,
    _reason: entry.reason ?? null,
    _metadata: entry.metadata ?? {},
    _ip_address: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    _user_agent: req.headers.get('user-agent') || null,
  });

  if (error) {
    console.error('[builderPortalAuth] project activity log failed',
      { action: entry.action, message: error.message });
    return false;
  }
  return true;
}
