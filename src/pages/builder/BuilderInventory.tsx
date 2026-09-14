import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Boxes, ChevronLeft, ChevronRight, Home, Loader2, RefreshCw, Tag,
} from 'lucide-react';
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
import { useBuilderInventoryStats, useBuilderProjects, useBuilderUnits } from '@/lib/builderQueries';
import {
  AVAILABILITY_STATUS_CLASSES, AVAILABILITY_STATUS_LABELS, AVAILABILITY_STATUS_ORDER,
  RELEASE_STATUS_CLASSES, RELEASE_STATUS_LABELS, RELEASE_STATUS_ORDER,
  UNIT_TYPE_LABELS, formatListPrice, formatUnitArea, formatUnitConfiguration,
  type BuilderAvailabilityStatus, type BuilderReleaseStatus,
} from '@/lib/builderInventory';

/**
 * External Builder Portal inventory list. Mirrors `BuilderProjects`, which
 * mirrors `SolicitorMatters`: server-side search, server-side pagination,
 * debounced input, and a list that contains only units the server decided this
 * user may see.
 *
 * The project filter narrows within what is already permitted. It cannot widen
 * anything: the server intersects it with the caller's accessible projects.
 */
export default function BuilderInventory() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState('all');
  const [release, setRelease] = useState('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);

  // The project filter lives in the URL so a filtered inventory view is
  // linkable. It is a display filter only: the server intersects it with the
  // caller's accessible projects, so an arbitrary id in the query string widens
  // nothing.
  const projectId = params.get('project') ?? 'all';
  const setProjectId = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('project'); else next.set('project', value);
    setParams(next, { replace: true });
  };

  useEffect(() => { setPage(1); }, [debounced, projectId, availability, release]);

  const projectsQuery = useBuilderProjects({ search: '', status: '', page: 1, pageSize: 100 });
  const statsQuery = useBuilderInventoryStats(projectId === 'all' ? '' : projectId);
  const query = useBuilderUnits({
    projectId: projectId === 'all' ? '' : projectId,
    search: debounced.trim(),
    availabilityStatus: availability === 'all' ? '' : availability,
    releaseStatus: release === 'all' ? '' : release,
    page,
    pageSize: 25,
  });

  const records = query.data?.records || [];
  const pagination = query.data?.pagination;
  const stats = statsQuery.data;

  const summary = [
    { label: 'Visible units', value: stats?.total ?? pagination?.total ?? 0, icon: Boxes },
    { label: 'Available', value: stats?.by_availability?.available ?? 0, icon: Home },
    { label: 'Released', value: stats?.released ?? 0, icon: Tag },
  ];

  return (
    <BuilderPortalShell
      title="Inventory"
      description="Stages, lots and units across the projects you have been granted access to."
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
            <CardTitle className="text-base">Units</CardTitle>
            <CardDescription>
              Search requests are debounced and cancelled when filters change.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search unit number or description"
              aria-label="Search units"
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
            <Select value={availability} onValueChange={setAvailability}>
              <SelectTrigger className="lg:w-44" aria-label="Filter by availability">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All availability</SelectItem>
                {AVAILABILITY_STATUS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>{AVAILABILITY_STATUS_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={release} onValueChange={setRelease}>
              <SelectTrigger className="lg:w-40" aria-label="Filter by release">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All release states</SelectItem>
                {RELEASE_STATUS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>{RELEASE_STATUS_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading units" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Inventory could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No units to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the filters, or ask your administrator to confirm your inventory access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Unit</TableHead>
                    <TableHead className="hidden lg:table-cell">Type</TableHead>
                    <TableHead className="hidden md:table-cell">Internal area</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Availability</TableHead>
                    <TableHead className="hidden sm:table-cell">Release</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((unit) => (
                    <TableRow key={unit.id}>
                      <TableCell>
                        <Link
                          to={`/builder/inventory/${unit.id}`}
                          className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="font-medium">{unit.unit_number}</span>
                          <span className="block max-w-80 truncate text-xs text-muted-foreground">
                            {formatUnitConfiguration(unit)}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {UNIT_TYPE_LABELS[unit.unit_type]}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {formatUnitArea(unit.internal_area_sqm)}
                      </TableCell>
                      <TableCell>{formatListPrice(unit.list_price, unit.price_basis)}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={AVAILABILITY_STATUS_CLASSES[
                            unit.availability_status as BuilderAvailabilityStatus]}
                        >
                          {AVAILABILITY_STATUS_LABELS[
                            unit.availability_status as BuilderAvailabilityStatus]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge
                          variant="outline"
                          className={RELEASE_STATUS_CLASSES[unit.release_status as BuilderReleaseStatus]}
                        >
                          {RELEASE_STATUS_LABELS[unit.release_status as BuilderReleaseStatus]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pagination && pagination.total_pages > 1 ? (
            <nav aria-label="Unit pages" className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.total_pages} · {pagination.total} units
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
