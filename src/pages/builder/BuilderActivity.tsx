import { useSearchParams } from 'react-router-dom';
import { History, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { useBuilderActivity } from '@/lib/builderQueries';
import {
  ACTIVITY_ENTITY_LABELS, ACTOR_TYPE_LABELS, BUILDER_ACTIVITY_ENTITY_TYPES,
  activityActionLabel, formatWorkspaceTime,
} from '@/lib/builderWorkspace';

/**
 * External Builder Portal activity history.
 *
 * The feed is `builder_visible_activity`. It refuses identity and
 * administration entity types outright — membership, permission, session and
 * organisation changes are never in it — and resolves every remaining row
 * through the resolver that governs the record itself. So a user who cannot
 * open a defect cannot read that the defect changed.
 *
 * The rows carry what changed, who changed it and why. They deliberately carry
 * no before/after state and no request metadata: those are the Command Centre's
 * forensic record, and the server never sends them here.
 */
export default function BuilderActivity() {
  const [params, setParams] = useSearchParams();
  const entityType = params.get('type') ?? 'all';

  const setEntityType = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('type'); else next.set('type', value);
    setParams(next, { replace: true });
  };

  const query = useBuilderActivity(entityType === 'all' ? '' : entityType);
  const records = query.data || [];

  return (
    <BuilderPortalShell
      title="Activity"
      description="What has changed on the records you can reach."
      actions={
        <Button
          variant="outline" size="sm"
          onClick={() => void query.refetch()} disabled={query.isFetching}
        >
          <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      }
    >
      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">History</CardTitle>
            <CardDescription>
              Administrative changes — organisation access, permissions and sessions — are not shown here.
              Your administrator holds that record.
            </CardDescription>
          </div>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger className="lg:w-64" aria-label="Filter by record type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All record types</SelectItem>
              {BUILDER_ACTIVITY_ENTITY_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {ACTIVITY_ENTITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading activity" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Activity could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Check your connection and try again.
              </p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <History className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="mt-2 font-medium">Nothing to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {entityType === 'all'
                  ? 'Changes to your projects, builds, documents and tasks will appear here.'
                  : 'Nothing of that type has changed on the records you can reach.'}
              </p>
            </div>
          ) : (
            <ol className="space-y-2">
              {records.map((entry) => (
                <li key={entry.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      {/* A div, not a p: Badge renders a div, and a div inside
                          a p is invalid HTML the browser silently reflows. */}
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        {activityActionLabel(entry.action)}
                        {entry.entity_type ? (
                          <Badge variant="outline">
                            {ACTIVITY_ENTITY_LABELS[entry.entity_type] ?? entry.entity_type}
                          </Badge>
                        ) : null}
                      </div>
                      {entry.reason ? (
                        <p className="mt-1 text-sm text-muted-foreground">{entry.reason}</p>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {ACTOR_TYPE_LABELS[entry.actor_type] ?? entry.actor_type} ·{' '}
                      {formatWorkspaceTime(entry.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
