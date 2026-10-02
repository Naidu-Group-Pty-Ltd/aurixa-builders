import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  useBuilderConstructionCases, useBuilderProjects, useBuilderTransactions, useBuilderUnits,
} from '@/lib/builderQueries';
import { useBuilderStockItems } from '@/lib/builderStockQueries';
import { stockItemTitle } from '@/lib/builderStock';
import {
  SCOPE_TYPE_LABELS, type BuilderScopeType,
} from '@/lib/builderCollaboration';
import {
  OFFERED_BUILDER_SCOPE_TYPES, offeredBuilderScopeType,
} from '@/lib/builderHiddenSections.pure';

/**
 * Choose the aggregate a collaboration surface is scoped to.
 *
 * Every option comes from a list the SERVER already filtered to what this user
 * may see, so the picker can only ever offer reachable scopes. It is still not
 * authority: the chosen pair is sent as a lookup key and the server re-resolves
 * the permission on the request that follows.
 *
 * TWO SHAPES OF SCOPE, and the second is why this component changed.
 *
 * A unit, a transaction and a build hang off a PROJECT, so choosing one is
 * choosing a project and then a child of it. A `stock_item` does not: stock
 * belongs to the ORGANISATION (the activation fan-out writes its task against
 * the property before any project exists, and the database resolver for that
 * scope is the active membership itself). Requiring a project first would make
 * the only records that actually hold tasks unreachable — which is exactly
 * what Tasks → By Record did until 2 October 2026, because this picker could
 * not name a property at all.
 *
 * So the project selector is drawn only for the scopes that need one, and a
 * property is chosen from the organisation's own stock.
 */
export interface BuilderScopeValue {
  scopeType: BuilderScopeType | '';
  scopeId: string;
}

/** The scopes that are a child OF a project, and so need one chosen first. */
const PROJECT_ANCHORED: readonly BuilderScopeType[] = ['unit', 'transaction', 'construction_case'];

export function BuilderScopePicker({
  value, onChange, projectId, onProjectChange,
}: {
  value: BuilderScopeValue;
  onChange: (next: BuilderScopeValue) => void;
  projectId: string;
  onProjectChange: (projectId: string) => void;
}) {
  const projectsQuery = useBuilderProjects({ search: '', status: '', page: 1, pageSize: 100 });
  const projects = projectsQuery.data?.records || [];

  const needsProject = value.scopeType === 'project'
    || PROJECT_ANCHORED.includes(value.scopeType as BuilderScopeType);
  const childEnabled = Boolean(projectId) && PROJECT_ANCHORED.includes(value.scopeType as BuilderScopeType);
  const unitsQuery = useBuilderUnits({
    projectId: childEnabled && value.scopeType === 'unit' ? projectId : '',
    search: '', availabilityStatus: '', releaseStatus: '', page: 1, pageSize: 100,
  }, { enabled: childEnabled && value.scopeType === 'unit' });
  const transactionsQuery = useBuilderTransactions({
    projectId: childEnabled && value.scopeType === 'transaction' ? projectId : '',
    search: '', status: '', page: 1, pageSize: 100,
  }, { enabled: childEnabled && value.scopeType === 'transaction' });
  const casesQuery = useBuilderConstructionCases({
    projectId: childEnabled && value.scopeType === 'construction_case' ? projectId : '',
    search: '', status: '', page: 1, pageSize: 100,
  }, { enabled: childEnabled && value.scopeType === 'construction_case' });
  /*
   * The organisation's own stock, read exactly as the Stock List reads it —
   * one list, server-scoped by the session's active organisation, so no
   * property of anybody else's can be offered. Asked for only while a
   * property is what is being chosen.
   */
  const stockQuery = useBuilderStockItems({
    search: '', availability: '', uploadId: '', page: 1, pageSize: 100,
  }, {});
  const stockEnabled = value.scopeType === 'stock_item';

  const children: Array<{ id: string; label: string }> = (() => {
    if (value.scopeType === 'unit') {
      return (unitsQuery.data?.records || []).map((unit) => ({
        id: unit.id, label: unit.unit_number || 'Unit',
      }));
    }
    if (value.scopeType === 'transaction') {
      return (transactionsQuery.data?.records || []).map((record) => ({
        id: record.id, label: record.transaction_reference || 'Transaction',
      }));
    }
    if (value.scopeType === 'construction_case') {
      return (casesQuery.data?.records || []).map((record) => ({
        id: record.id, label: record.case_reference || 'Build',
      }));
    }
    if (stockEnabled) {
      return (stockQuery.data?.records || []).map((record) => ({
        id: record.id, label: stockItemTitle(record) || 'Property',
      }));
    }
    return [];
  })();

  const setProject = (next: string) => {
    onProjectChange(next);
    // Changing the project invalidates any child selection under the old one.
    onChange(value.scopeType === 'project'
      ? { scopeType: 'project', scopeId: next }
      : { scopeType: value.scopeType, scopeId: '' });
  };

  const setScopeType = (next: string) => {
    /*
     * COERCED, NEVER CAST. The list above is already the offered set, but a
     * value can reach this from outside it — a stale URL, a restored form,
     * a future option — and a withdrawn aggregate selected here would open a
     * picker onto a section this portal no longer has. `offeredBuilderScopeType`
     * is the one rule that decides, and it answers `project` for anything it
     * does not offer.
     */
    const scopeType = offeredBuilderScopeType(next);
    onChange(scopeType === 'project'
      ? { scopeType, scopeId: projectId }
      : { scopeType, scopeId: '' });
  };

  /** A scope with its own list needs no project, so none is demanded of it. */
  const childDisabled = PROJECT_ANCHORED.includes(value.scopeType as BuilderScopeType)
    ? !projectId || !children.length
    : !children.length;
  const childPlaceholder = (() => {
    const what = value.scopeType ? SCOPE_TYPE_LABELS[value.scopeType].toLowerCase() : 'record';
    if (PROJECT_ANCHORED.includes(value.scopeType as BuilderScopeType) && !projectId) {
      return 'Choose a project first';
    }
    return `Choose a ${what}`;
  })();

  return (
    <div className="flex flex-col gap-2 lg:flex-row">
      {needsProject ? (
        <Select value={projectId} onValueChange={setProject}>
          <SelectTrigger className="lg:w-64" aria-label="Choose a project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <Select value={value.scopeType || 'project'} onValueChange={setScopeType}>
        <SelectTrigger className="lg:w-48" aria-label="Choose a record type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OFFERED_BUILDER_SCOPE_TYPES.map((scopeType) => (
            <SelectItem key={scopeType} value={scopeType}>
              {SCOPE_TYPE_LABELS[scopeType]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.scopeType && value.scopeType !== 'project' ? (
        <Select
          value={value.scopeId}
          onValueChange={(next) => onChange({ scopeType: value.scopeType, scopeId: next })}
          disabled={childDisabled}
        >
          <SelectTrigger
            className="lg:w-64"
            aria-label={`Choose a ${value.scopeType ? SCOPE_TYPE_LABELS[value.scopeType].toLowerCase() : 'record'}`}
          >
            <SelectValue placeholder={childPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {children.map((child) => (
              <SelectItem key={child.id} value={child.id}>{child.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
