import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Building2, ChevronLeft, ChevronRight, HardHat, Loader2, RefreshCw, } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderPortalMetricCard } from '@/components/builder-portal/ui/BuilderPortalMetricCard';
import { useDebounce } from '@/hooks/useDebounce';
import { useBuilderProjects } from '@/lib/builderQueries';
import { ProjectPropertyPicture } from '@/components/builder-portal/ProjectProperty';
import {
  stockItemConfiguration, stockItemPrice, type BuilderStockItem,
} from '@/lib/builderStock';
import {
  PROJECT_STATUS_CLASSES, PROJECT_STATUS_LABELS, PROJECT_STATUS_ORDER,
  PROJECT_TYPE_LABELS, countdownLabel, formatProjectAddress, formatProjectDate,
  type BuilderProjectStatus,
} from '@/lib/builderProjects';

/** The row's headline figures: price, layout, home and land size. */
function propertyLine(item: Partial<BuilderStockItem> | null | undefined): string | null {
  if (!item) return null;
  const size = (value: unknown, label: string) => {
    const parsed = Number(value);
    return value !== null && value !== undefined && Number.isFinite(parsed)
      ? `${parsed.toLocaleString('en-AU')} m² ${label}` : null;
  };
  const parts = [
    stockItemPrice(item as BuilderStockItem),
    stockItemConfiguration(item as BuilderStockItem),
    size(item.building_size_sqm, 'home'),
    size(item.land_size_sqm, 'land'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * External Builder Portal project list. Mirrors `SolicitorMatters`:
 * server-side search, server-side pagination, debounced input, and a list that
 * contains only projects the server decided this user may see.
 */
export default function BuilderProjects() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);

  useEffect(() => { setPage(1); }, [debounced, status]);

  const query = useBuilderProjects({
    search: debounced.trim(),
    status: status === 'all' ? '' : status,
    page,
    pageSize: 25,
  });
  const records = query.data?.records || [];
  const pagination = query.data?.pagination;

  const summary = [
    { label: 'Visible projects', value: pagination?.total ?? 0, icon: HardHat },
    { label: 'Page', value: pagination?.page ?? page, icon: Building2 },
    { label: 'At risk on page', value: records.filter((p) => p.risk_flag).length, icon: AlertTriangle },
  ];

  return (
    <BuilderPortalShell
      title="Projects"
      description="Projects you have been granted access to, with server-side search and pagination."
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
            <CardTitle className="text-base">Project list</CardTitle>
            <CardDescription>
              Search requests are debounced and cancelled when filters change.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search project name, reference or address"
              aria-label="Search projects"
              containerClassName="flex-1"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-56" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {PROJECT_STATUS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>{PROJECT_STATUS_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading projects" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Projects could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No projects to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the filters, or ask your administrator to confirm your project access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead className="hidden md:table-cell">Developer</TableHead>
                    <TableHead className="hidden lg:table-cell">Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Est. completion</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((project) => {
                    const countdown = countdownLabel(project.estimated_completion_date);
                    const figures = propertyLine(project.property);
                    return (
                      <TableRow key={project.id}>
                        <TableCell>
                          <Link
                            to={`/builder/projects/${project.id}`}
                            className="flex items-start gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {project.property ? (
                              <ProjectPropertyPicture
                                projectId={project.id}
                                item={project.property}
                                alt=""
                                aspectClassName="aspect-[4/3]"
                                className="w-16 shrink-0 overflow-hidden rounded-md border border-border/60 sm:w-24"
                                emptyLabel="No photo"
                              />
                            ) : null}
                            <span className="min-w-0">
                            <span className="flex items-center gap-2 font-medium">
                              {project.name}
                              {project.risk_flag ? (
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="At risk" />
                              ) : null}
                            </span>
                            <span className="block max-w-80 truncate text-xs text-muted-foreground">
                              {project.project_reference ? `${project.project_reference} · ` : ''}
                              {formatProjectAddress(project)}
                            </span>
                            {project.activation ? (
                              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span
                                  aria-hidden
                                  className={cn(
                                    'inline-block h-1.5 w-1.5 rounded-full',
                                    project.activation.status === 'selected' ? 'bg-warning' : 'bg-success',
                                  )}
                                />
                                Activated by {project.activation.agency_name || 'a connected agency'}
                                {project.activation.status === 'selected' ? ' · awaiting acknowledgement' : ''}
                              </span>
                            ) : null}
                            {figures ? (
                              <span className="mt-0.5 block text-xs text-foreground/80">{figures}</span>
                            ) : null}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {project.developer_organisation_name || '—'}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {PROJECT_TYPE_LABELS[project.project_type]}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={PROJECT_STATUS_CLASSES[project.status as BuilderProjectStatus]}
                          >
                            {PROJECT_STATUS_LABELS[project.status as BuilderProjectStatus]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {formatProjectDate(project.estimated_completion_date)}
                          {countdown ? (
                            <span className="block text-xs text-muted-foreground">{countdown}</span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {pagination && pagination.total_pages > 1 ? (
            <nav aria-label="Project pages" className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.total_pages} · {pagination.total} projects
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
