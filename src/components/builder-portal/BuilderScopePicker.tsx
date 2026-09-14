import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  useBuilderConstructionCases, useBuilderProjects, useBuilderTransactions, useBuilderUnits,
} from '@/lib/builderQueries';
import {
  BUILDER_SCOPE_TYPES, SCOPE_TYPE_LABELS, type BuilderScopeType,
} from '@/lib/builderCollaboration';

/**
 * Choose the aggregate a collaboration surface is scoped to.
 *
 * Every option comes from a list the SERVER already filtered to what this user
 * may see, so the picker can only ever offer reachable scopes. It is still not
 * authority: the chosen pair is sent as a lookup key and the server re-resolves
 * the permission on the request that follows.
 */
export interface BuilderScopeValue {
  scopeType: BuilderScopeType | '';
  scopeId: string;
}

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

  const childEnabled = Boolean(projectId) && value.scopeType !== 'project';
  const unitsQuery = useBuilderUnits({
    projectId: childEnabled && value.scopeType === 'unit' ? projectId : '',
    search: '', availabilityStatus: '', releaseStatus: '', page: 1, pageSize: 100,
  });
  const transactionsQuery = useBuilderTransactions({
    projectId: childEnabled && value.scopeType === 'transaction' ? projectId : '',
    search: '', status: '', page: 1, pageSize: 100,
  });
  const casesQuery = useBuilderConstructionCases({
    projectId: childEnabled && value.scopeType === 'construction_case' ? projectId : '',
    search: '', status: '', page: 1, pageSize: 100,
  });

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
    const scopeType = next as BuilderScopeType;
    onChange(scopeType === 'project'
      ? { scopeType, scopeId: projectId }
      : { scopeType, scopeId: '' });
  };

  return (
    <div className="flex flex-col gap-2 lg:flex-row">
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

      <Select value={value.scopeType || 'project'} onValueChange={setScopeType}>
        <SelectTrigger className="lg:w-48" aria-label="Choose a scope type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BUILDER_SCOPE_TYPES.map((scopeType) => (
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
          disabled={!projectId || !children.length}
        >
          <SelectTrigger className="lg:w-64" aria-label={`Choose a ${SCOPE_TYPE_LABELS[value.scopeType].toLowerCase()}`}>
            <SelectValue placeholder={
              projectId ? `Choose a ${SCOPE_TYPE_LABELS[value.scopeType].toLowerCase()}` : 'Choose a project first'
            } />
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
