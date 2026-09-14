import { Link, useSearchParams } from 'react-router-dom';
import { KanbanSquare, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { useBuilderPipeline, useBuilderProjects } from '@/lib/builderQueries';
import {
  TRANSACTION_STATUS_CLASSES, TRANSACTION_STATUS_LABELS, formatTransactionMoney,
  type BuilderTransactionStatus,
} from '@/lib/builderTransactions';

/**
 * External Builder Portal transaction pipeline.
 *
 * The status-to-column mapping lives in the database
 * (`builder_transaction_pipeline_stages`) and is returned by the server, so the
 * portal and the Command Centre group identically and a status can never appear
 * in two columns. This page renders what the server sent; it derives nothing.
 *
 * The board is read-only: a status change goes through the transaction detail
 * page, where a reason and the loaded `expected_version` are carried.
 */
export default function BuilderPipeline() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? 'all';
  const setProjectId = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('project'); else next.set('project', value);
    setParams(next, { replace: true });
  };

  const projectsQuery = useBuilderProjects({ search: '', status: '', page: 1, pageSize: 100 });
  const query = useBuilderPipeline(projectId === 'all' ? '' : projectId);
  const columns = query.data?.columns || [];
  const total = columns.reduce((sum, column) => sum + column.records.length, 0);

  return (
    <BuilderPortalShell
      title="Pipeline"
      description="Every transaction you can see, grouped by the stage the server assigned."
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/transactions">List view</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </>
      }
    >
      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">Pipeline board</CardTitle>
            <CardDescription>
              Stage grouping is defined by the server, not by this page.
            </CardDescription>
          </div>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="sm:w-64" aria-label="Filter by project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {(projectsQuery.data?.records || []).map((project) => (
                <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading pipeline" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">The pipeline could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !total ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <KanbanSquare className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 font-medium">No transactions in the pipeline</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the filter, or ask your administrator to confirm your transaction access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto pb-2">
              <ol className="flex min-w-max gap-3">
                {columns.map((column) => (
                  <li key={column.stage_key} className="w-72 shrink-0">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-medium">{column.stage_label}</h3>
                      <Badge variant="outline">{column.records.length}</Badge>
                    </div>
                    <div className="space-y-2">
                      {!column.records.length ? (
                        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                          Nothing at this stage
                        </p>
                      ) : column.records.map((transaction) => (
                        <Link
                          key={transaction.id}
                          to={`/builder/transactions/${transaction.id}`}
                          className="block rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate text-sm font-medium">
                            {transaction.transaction_reference || 'No reference'}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {transaction.purchaser_name || 'No purchaser recorded'}
                          </span>
                          <span className="mt-2 flex items-center justify-between gap-2">
                            <Badge
                              variant="outline"
                              className={TRANSACTION_STATUS_CLASSES[
                                transaction.status as BuilderTransactionStatus]}
                            >
                              {TRANSACTION_STATUS_LABELS[
                                transaction.status as BuilderTransactionStatus]}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatTransactionMoney(transaction.contract_price)}
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
