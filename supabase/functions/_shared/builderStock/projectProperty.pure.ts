/**
 * BUILDER PROJECTS — WHICH PROPERTY A PROJECT IS.
 *
 * `builder_projects` has no stock column, and there are two ways a project and
 * a Stock List property come to name each other:
 *
 *   1. the ACTIVATION — `builder_stock_selection_announcements` carries the
 *      property it was opened for and, since the fan-out, the project it
 *      opened (`activation_project_id`);
 *   2. the PROPERTY — `builder_stock_items.builder_project_id`, which the
 *      fan-out writes onto the property when it opens the project.
 *
 * The activation is the stronger statement, because it names the property the
 * agency actually selected; the property's own column is read where there is
 * no activation, so a project linked any other way does not come up empty.
 * Where several properties name one project, the one the builder touched last
 * stands. A project nothing names has no property — never a guess.
 *
 * Pure: no IO.
 */

export interface LinkedStockRow {
  id: string;
  builder_project_id: string | null;
  updated_at?: string | null;
}

export function projectStockItemIds(args: {
  projectIds: readonly string[];
  activationStockItemByProject: ReadonlyMap<string, string | null | undefined>;
  linkedStock: readonly LinkedStockRow[];
}): Map<string, string> {
  const wanted = new Set(args.projectIds);
  const byProject = new Map<string, string>();

  for (const projectId of args.projectIds) {
    const fromActivation = args.activationStockItemByProject.get(projectId);
    if (fromActivation) byProject.set(projectId, fromActivation);
  }

  const latest = new Map<string, LinkedStockRow>();
  for (const row of args.linkedStock) {
    const projectId = row.builder_project_id;
    if (!projectId || !wanted.has(projectId) || byProject.has(projectId)) continue;
    const held = latest.get(projectId);
    if (!held || String(row.updated_at ?? '') > String(held.updated_at ?? '')
      || (String(row.updated_at ?? '') === String(held.updated_at ?? '') && row.id > held.id)) {
      latest.set(projectId, row);
    }
  }
  for (const [projectId, row] of latest) byProject.set(projectId, row.id);
  return byProject;
}
