import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronLeft, ChevronRight, HardHat, Loader2, RefreshCw, TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DimensionRail } from '@/components/builder-portal/ui/DimensionRail';
import {
  isOffSequenceStatus, railIndexFromStatus, railStationsFromStatuses,
} from '@/lib/builderConstructionRail.pure';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderPortalMetricCard } from '@/components/builder-portal/ui/BuilderPortalMetricCard';
import { useDebounce } from '@/hooks/useDebounce';
import {
  useBuilderConstructionCases, useBuilderConstructionStats, useBuilderProjects,
} from '@/lib/builderQueries';
import {
  CONSTRUCTION_STATUS_CLASSES, CONSTRUCTION_STATUS_LABELS, CONSTRUCTION_STATUS_ORDER,
  formatConstructionDate, formatPercentComplete, isConstructionOverdue,
  type BuilderConstructionStatus,
} from '@/lib/builderConstruction';

/**
 * External Builder Portal construction list. Mirrors `BuilderTransactions`:
 * server-side search, server-side pagination, debounced input, and a list that
 * contains only construction cases the server decided this user may see.
 *
 * The project filter narrows within what is already permitted. It cannot widen
 * anything: the server intersects it with the caller's accessible projects.
 */
/*
 * The extent every row is measured against — the case lifecycle, in order.
 * Built once at module scope because it is the same line for every build and
 * `DimensionRail` takes it by value; rebuilding it per row would hand React a
 * new array on every render for no gain.
 */
const STATUS_RAIL_STAGES = railStationsFromStatuses();

export default function BuilderConstruction() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);

  const projectId = params.get('project') ?? 'all';
  const setProjectId = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('project'); else next.set('project', value);
    setParams(next, { replace: true });
  };

  useEffect(() => { setPage(1); }, [debounced, projectId, status]);

  const projectsQuery = useBuilderProjects({ search: '', status: '', page: 1, pageSize: 100 });
  const statsQuery = useBuilderConstructionStats(projectId === 'all' ? '' : projectId);
  const query = useBuilderConstructionCases({
    projectId: projectId === 'all' ? '' : projectId,
    search: debounced.trim(),
    status: status === 'all' ? '' : status,
    page,
    pageSize: 25,
  });

  const records = query.data?.records || [];
  const pagination = query.data?.pagination;
  const stats = statsQuery.data;

  const summary = [
    { label: 'Visible builds', value: stats?.total ?? pagination?.total ?? 0, icon: HardHat },
    { label: 'Average complete', value: `${stats?.average_percent ?? 0}%`, icon: TrendingUp },
    { label: 'Past estimate', value: stats?.overdue ?? 0, icon: AlertTriangle },
  ];

  return (
    <BuilderPortalShell
      title="Construction"
      description="Build programmes across the projects you have been granted access to."
      actions={
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {summary.map(({ label, value, icon }) => (
          <BuilderPortalMetricCard key={label} icon={icon} label={label} value={value} />
        ))}
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">Build programmes</CardTitle>
            <CardDescription>
              Search requests are debounced and cancelled when filters change.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search reference or site supervisor"
              aria-label="Search construction cases"
              containerClassName="flex-1"
            />
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="lg:w-56" aria-label="Filter by project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {(projectsQuery.data?.records || []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="lg:w-52" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CONSTRUCTION_STATUS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>{CONSTRUCTION_STATUS_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading construction" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Construction could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No build programmes to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the filters, or ask your administrator to confirm your construction access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Build</TableHead>
                    <TableHead className="w-[30%] min-w-64">Stage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Est. completion</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <Link
                          to={`/builder/construction/${record.id}`}
                          className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex items-center gap-2 font-medium">
                            {record.case_reference || 'No reference'}
                            {isConstructionOverdue(record) ? (
                              <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="Past estimate" />
                            ) : null}
                          </span>
                          <span className="block max-w-80 truncate text-xs text-muted-foreground">
                            {record.site_supervisor_name || 'No site supervisor recorded'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="w-[30%] min-w-64">
                        {/*
                          A DENSE DIMENSION RAIL, NOT A PROGRESS BAR.

                          A bar answers "how much" and a build is asked "which
                          stage" — the same question the detail page answers.
                          `railIndexFromStatus` returns null for a status that
                          is not a point on the line (on hold, cancelled), so
                          those rows draw the extent with no mark rather than
                          being placed somewhere the record does not say.

                          The percentage is KEPT: the rail replaces how the
                          row is drawn, never what it tells you.
                        */}
                        <DimensionRail
                          dense
                          stages={STATUS_RAIL_STAGES}
                          currentIndex={
                            isOffSequenceStatus(record.status)
                              ? null
                              : railIndexFromStatus(record.status)
                          }
                        />
                        <span className="mt-1.5 block text-xs tabular-nums text-muted-foreground">
                          {formatPercentComplete(record.percent_complete)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={CONSTRUCTION_STATUS_CLASSES[
                            record.status as BuilderConstructionStatus]}
                        >
                          {CONSTRUCTION_STATUS_LABELS[record.status as BuilderConstructionStatus]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {formatConstructionDate(record.estimated_completion_date)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pagination && pagination.total_pages > 1 ? (
            <nav aria-label="Construction pages" className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.total_pages} · {pagination.total} builds
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline" size="sm"
                  disabled={page <= 1 || query.isFetching}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />Previous
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={page >= pagination.total_pages || query.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next<ChevronRight className="ml-1 h-4 w-4" aria-hidden />
                </Button>
              </div>
            </nav>
          ) : null}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
