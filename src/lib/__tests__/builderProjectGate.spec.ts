/**
 * The project gate decides in one fixed order, whatever order its reads land.
 *
 * Opening a project and posting in its conversation made ~15 sequential
 * database round trips; the grant, the project row and the permission matrix
 * are now read at once. That is only safe if the ANSWER is still decided in
 * the original order — no grant, wrong organisation, missing project, moved
 * project: 404; no view: 403 — so a probe learns nothing it did not before.
 * `decideProjectGate` is that order, and both functions use it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideProjectGate } from '../../../supabase/functions/_shared/builderProjectGate.pure';

const ORG = 'org-a';
const access = { organisation_id: ORG, organisation_side: 'builder', access_role: 'member' };
const project = { id: 'p', builder_organisation_id: ORG, developer_organisation_id: null };
const canView = { projects: { view: true, edit: false, delete: false } };
const cannotView = { projects: { view: false, edit: false, delete: false } };

describe('decideProjectGate', () => {
  it('admits a live grant on the active organisation with view', () => {
    expect(decideProjectGate({ access, project, perms: canView, activeOrganisationId: ORG }))
      .toEqual({ ok: true });
  });

  it('reads as absent for no grant, another organisation, a missing or moved project', () => {
    const cases = [
      { access: null, project, perms: canView },
      { access: { ...access, organisation_id: 'org-b' }, project, perms: canView },
      { access, project: null, perms: canView },
      { access, project: { ...project, builder_organisation_id: 'org-b' }, perms: canView },
      { access: { ...access, organisation_side: 'developer' }, project, perms: canView },
    ];
    for (const c of cases) {
      expect(decideProjectGate({ ...c, activeOrganisationId: ORG })).toEqual({ ok: false, status: 404 });
    }
  });

  it('a 404 reason always outranks the 403, so a matrix read early leaks nothing', () => {
    expect(decideProjectGate({ access: null, project: null, perms: cannotView, activeOrganisationId: ORG }))
      .toEqual({ ok: false, status: 404 });
    expect(decideProjectGate({ access, project, perms: cannotView, activeOrganisationId: ORG }))
      .toEqual({ ok: false, status: 403 });
  });
});

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

describe('the project reads run together, and only where they are used', () => {
  for (const fn of ['builder-portal-projects', 'builder-portal-collaboration']) {
    it(`${fn} reads the grant, the project and the matrix concurrently and decides with the gate`, () => {
      const code = read(`supabase/functions/${fn}/index.ts`);
      expect(code).toMatch(/Promise\.all\(\[\s*resolveBuilderProjectAccess\(/);
      expect(code).toMatch(/resolveBuilderProjectPermissionsFor\(/);
      expect(code).toMatch(/decideProjectGate\(/);
    });
  }

  it('the accessible-project list is read only by the operations that use it', () => {
    const code = read('supabase/functions/builder-portal-projects/index.ts');
    const preamble = code.slice(code.indexOf("timer.mark('session')"), code.indexOf('const loadProject'));
    expect(preamble).not.toMatch(/const accessibleProjectIds = await listAccessibleBuilderProjectIds\(/);
    expect(code).toMatch(/if \(operation === 'list_projects'\) \{\s*const accessibleProjectIds = await readAccessibleProjectIds\(\);/);
    expect(code).toMatch(/if \(operation === 'project_stats'\) \{\s*const accessibleProjectIds = await readAccessibleProjectIds\(\);/);
  });

  it('a conversation\'s scope and its visibility are asked together', () => {
    const code = read('supabase/functions/builder-portal-collaboration/index.ts');
    const conv = code.slice(code.indexOf('const loadConversation'), code.indexOf('const loadTask'));
    expect(conv).toMatch(/Promise\.all\(\[\s*loadScope\(/);
  });
});
