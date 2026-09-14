import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Loader2, Receipt, RefreshCw, UserPlus,
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
import {
  useBuilderProjects, useBuilderTransactionStats, useBuilderTransactions,
} from '@/lib/builderQueries';
import {
  TRANSACTION_STATUS_CLASSES, TRANSACTION_STATUS_LABELS, TRANSACTION_STATUS_ORDER,
  TRANSACTION_TYPE_LABELS, formatTransactionDate, formatTransactionMoney, sunsetCountdown,
  type BuilderTransactionStatus,
} from '@/lib/builderTransactions';

/**
 * External Builder Portal transaction list. Mirrors `BuilderInventory`, which
 * mirrors `BuilderProjects`: server-side search, server-side pagination,
 * debounced input, and a list that contains only transactions the server decided
 * this user may see.
 *
 * The project filter narrows within what is already permitted. It cannot widen
 * anything: the server intersects it with the caller's accessible projects.
 */
export default function BuilderTransactions() {
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
  const statsQuery = useBuilderTransactionStats(projectId === 'all' ? '' : projectId);
  const query = useBuilderTransactions({
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
    { label: 'Visible transactions', value: stats?.total ?? pagination?.total ?? 0, icon: Receipt },
    { label: 'At risk', value: stats?.at_risk ?? 0, icon: AlertTriangle },
    { label: 'Without a client', value: stats?.unlinked ?? 0, icon: UserPlus },
  ];

  return (
    <BuilderPortalShell
      title="Transactions"
      description="Sales across the projects you have been granted access to."
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/pipeline">Pipeline view</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </>
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
            <CardTitle className="text-base">Transaction list</CardTitle>
            <CardDescription>
              Search requests are debounced and cancelled when filters change.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search reference or purchaser"
              aria-label="Search transactions"
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
                {TRANSACTION_STATUS_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>{TRANSACTION_STATUS_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading transactions" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Transactions could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No transactions to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the filters, or ask your administrator to confirm your transaction access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction</TableHead>
                    <TableHead className="hidden lg:table-cell">Type</TableHead>
                    <TableHead>Contract price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Est. settlement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((transaction) => {
                    const countdown = sunsetCountdown(transaction.sunset_date);
                    return (
                      <TableRow key={transaction.id}>
                        <TableCell>
                          <Link
                            to={`/builder/transactions/${transaction.id}`}
                            className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="flex items-center gap-2 font-medium">
                              {transaction.transaction_reference || 'No reference'}
                              {transaction.risk_flag ? (
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="At risk" />
                              ) : null}
                            </span>
                            <span className="block max-w-80 truncate text-xs text-muted-foreground">
                              {transaction.purchaser_name || 'No purchaser recorded'}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {TRANSACTION_TYPE_LABELS[transaction.transaction_type]}
                        </TableCell>
                        <TableCell>{formatTransactionMoney(transaction.contract_price)}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={TRANSACTION_STATUS_CLASSES[
                              transaction.status as BuilderTransactionStatus]}
                          >
                            {TRANSACTION_STATUS_LABELS[transaction.status as BuilderTransactionStatus]}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {formatTransactionDate(transaction.estimated_settlement_date)}
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
            <nav aria-label="Transaction pages" className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.total_pages} · {pagination.total} transactions
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
