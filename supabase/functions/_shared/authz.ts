/**
 * authz — deny-by-default authorization helpers for Edge Functions
 * (Security Remediation, second-round audit: High-priority item "centralized
 * deny-by-default authorization layer").
 *
 * These build on the module-permission model already used across the app
 * (dashboard_modules + user_permissions + superadmin bypass via user_roles),
 * but — unlike _shared/permissions.ts checkPermission, which is intentionally
 * allow-by-default for the generic data-mediation layer — these gates DENY when
 * a module is unknown or a permission row is absent. Use them on business-
 * critical functions (finance, compliance, generated documents, analytics,
 * admin operations) where "valid session" must never imply "authorized".
 *
 * Roles are resolved with the canonical resolver in auth_v2.
 */

import { canonicalizeRole, resolveRoles } from './auth_v2.ts';

export type ModulePerm = 'can_view' | 'can_edit' | 'can_delete';

export interface AuthzResult {
  ok: boolean;
  error?: string;
  reason_code?: string;
}

/** True when the actor is a superadmin (checks both role stores). */
export async function actorIsSuperadmin(supabase: any, userId: string): Promise<boolean> {
  if (!userId || userId === 'service_role') return false;
  const [{ data: user }, { data: roleRows }] = await Promise.all([
    supabase.from('custom_users').select('role').eq('id', userId).maybeSingle(),
    supabase.from('user_roles').select('role').eq('user_id', userId),
  ]);
  if (canonicalizeRole(user?.role) === 'superadmin') return true;
  for (const r of roleRows ?? []) {
    if (canonicalizeRole(r.role) === 'superadmin') return true;
  }
  return false;
}

/**
 * Require that the actor holds a specific module permission (deny-by-default).
 *
 *  - Verified internal/service calls (authMethod 'service_role') bypass — these
 *    are edge-function-to-edge-function calls that already passed a strict gate.
 *  - Superadmins bypass.
 *  - Otherwise the user must have the requested flag on the given module. A
 *    missing module registration or a missing permission row DENIES.
 */
export async function requireModulePermission(
  supabase: any,
  actor: { userId: string | null; authMethod?: string | null },
  moduleKey: string,
  requiredPerm: ModulePerm,
): Promise<AuthzResult> {
  const userId = actor.userId;
  if (actor.authMethod === 'service_role' || userId === 'service_role') {
    return { ok: true };
  }
  if (!userId) return { ok: false, error: 'Authentication required', reason_code: 'missing_actor' };

  if (await actorIsSuperadmin(supabase, userId)) return { ok: true };

  const { data: moduleData } = await supabase
    .from('dashboard_modules')
    .select('id')
    .eq('module_key', moduleKey)
    .eq('is_active', true)
    .maybeSingle();

  if (!moduleData) {
    // Deny-by-default: an unrecognized/inactive module is not authorizable by a
    // non-superadmin. (Superadmins already returned above.)
    return {
      ok: false,
      error: `Not authorized for "${moduleKey}"`,
      reason_code: 'module_not_registered',
    };
  }

  const { data: perm } = await supabase
    .from('user_permissions')
    .select('can_view, can_edit, can_delete')
    .eq('user_id', userId)
    .eq('module_id', moduleData.id)
    .maybeSingle();

  if (!perm || !perm[requiredPerm]) {
    const label = requiredPerm.replace('can_', '');
    return {
      ok: false,
      error: `You do not have ${label} permission for "${moduleKey}"`,
      reason_code: 'module_permission_denied',
    };
  }
  return { ok: true };
}

/** Require the actor be a superadmin (deny-by-default). Service calls bypass. */
export async function requireSuperadmin(
  supabase: any,
  actor: { userId: string | null; authMethod?: string | null },
): Promise<AuthzResult> {
  if (actor.authMethod === 'service_role' || actor.userId === 'service_role') {
    return { ok: true };
  }
  if (!actor.userId) return { ok: false, error: 'Authentication required', reason_code: 'missing_actor' };
  if (await actorIsSuperadmin(supabase, actor.userId)) return { ok: true };
  return { ok: false, error: 'Superadmin privilege required', reason_code: 'not_superadmin' };
}

/** Require the actor to hold an admin or superadmin role. Service calls bypass. */
export async function requireAdmin(
  supabase: any,
  actor: { userId: string | null; authMethod?: string | null },
): Promise<AuthzResult> {
  if (actor.authMethod === 'service_role' || actor.userId === 'service_role') {
    return { ok: true };
  }
  if (!actor.userId) return { ok: false, error: 'Authentication required', reason_code: 'missing_actor' };
  const roles = await resolveRoles(supabase, actor.userId);
  if (roles.includes('admin') || roles.includes('superadmin')) return { ok: true };
  return { ok: false, error: 'Admin privilege required', reason_code: 'not_admin' };
}

/** Map an action verb to the module permission flag it requires. */
export function permForAction(action: string): ModulePerm {
  const a = (action || '').toLowerCase();
  if (/(delete|remove|cancel|void|reconcile|mark_received|mark_paid|payout)/.test(a)) return 'can_delete';
  if (/(create|update|insert|upsert|save|send|generate|append|status|renew|set)/.test(a)) return 'can_edit';
  return 'can_view';
}
