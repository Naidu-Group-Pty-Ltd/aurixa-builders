/**
 * The project gate's decision — in ONE fixed order, whatever order its reads
 * arrived in.
 *
 * The grant, the project row and the permission matrix are read at once (they
 * are independent: the matrix is resolved in the database from the user and
 * the project id alone, and re-checks the grant itself). The answer is still
 * decided exactly as it was when they were read one after another:
 *
 *   no live grant                              → 404
 *   the grant runs through another organisation → 404
 *   no such project                            → 404
 *   the project no longer names that organisation on the granted side → 404
 *   no `projects` view                         → 403
 *
 * Every 404 reason outranks the 403, so a matrix that was read early can never
 * tell a prober that a project exists. Nothing here reads a browser value.
 */
export interface GateAccess { organisation_id: string; organisation_side: string }
export interface GateProject { builder_organisation_id: string | null; developer_organisation_id: string | null }
type Matrix = Record<string, { view?: boolean } | undefined> | null;

export function decideProjectGate(input: {
  access: GateAccess | null;
  project: GateProject | null;
  perms: Matrix;
  activeOrganisationId: string;
}): { ok: true } | { ok: false; status: 404 | 403 } {
  const { access, project, perms, activeOrganisationId } = input;
  if (!access) return { ok: false, status: 404 };
  if (access.organisation_id !== activeOrganisationId) return { ok: false, status: 404 };
  if (!project) return { ok: false, status: 404 };
  const sideOrg = access.organisation_side === 'developer'
    ? project.developer_organisation_id
    : project.builder_organisation_id;
  if (!sideOrg || sideOrg !== access.organisation_id) return { ok: false, status: 404 };
  if (perms?.projects?.view !== true) return { ok: false, status: 403 };
  return { ok: true };
}
