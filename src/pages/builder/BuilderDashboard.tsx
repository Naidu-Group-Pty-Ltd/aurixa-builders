import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Building2, History, Loader2, RefreshCw, ShieldCheck, UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { smartCapitalize } from '@/lib/nameUtils';
import { accessRoleLabel } from '@/lib/builderAccessTerms';
import { useToast } from '@/hooks/use-toast';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import {
  useBuilderActivity, useBuilderNotifications, useBuilderWorkspaceSummary,
} from '@/lib/builderQueries';
import {
  ACTIVITY_ENTITY_LABELS, ACTOR_TYPE_LABELS, activityActionLabel, formatWorkspaceTime,
} from '@/lib/builderWorkspace';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderSchedule } from '@/components/builder-portal/ui/BuilderSchedule';
import { TitleBlock } from '@/components/builder-portal/ui/TitleBlock';
/* The one place the locale is named; see docs/aml/ONGOING_CDD_AND_REMINDERS.md —
   an un-localed format prints 9/12/2026 to an Australian builder. */
import { AU_LOCALE } from '@/lib/aml/displayDate';
import { isWithdrawnBuilderPath } from '@/lib/builderHiddenSections.pure';

/**
 * Builder / Developer Portal landing surface.
 *
 * The hierarchy is the Solicitor dashboard's — gradient hero with an eyebrow, a
 * primary action, a three-card KPI row, then lower content cards — carrying
 * Builder's own figures.
 *
 * Every number is computed by the database from an accessible-set function, so
 * a tile can never count a record this user cannot open, and a count of zero
 * means "nothing you can reach", not "nothing exists". The recent activity list
 * is the same feed as the Activity page, narrowed to the most recent entries
 * and filtered through the resolvers that govern each record.
 *
 * There is deliberately no financial tile: no money, client position, AML
 * determination or commission is in the Builder audience. Nothing here invents
 * a trend, a percentage, a runway or a projection — `useBuilderWorkspaceSummary`
 * and `useBuilderActivity` are the only sources, and neither offers one.
 */
const formatTimestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-AU') : 'This is your first sign-in';

/**
 * The `entity_kind` `builder-stock-marketplace` writes when a Command Centre
 * adviser selects one of this builder's uploaded properties — the notification
 * titled "A property from your stock list has been selected". It is the only
 * kind this dashboard pops up; every other notification behaves exactly as it
 * did.
 */
const STOCK_SELECTION_ENTITY_KIND = 'stock_selection';

/**
 * Ids already popped, held at module scope so a refetch of the shared
 * notifications query — or leaving the dashboard and coming back — cannot show
 * the same one twice.
 *
 * Nothing here writes: the notification is not marked read, so the bell, its
 * dropdown and the unread count are untouched and the entry stays where it is.
 */
const poppedStockSelectionIds = new Set<string>();

export default function BuilderDashboard() {
  const { user, activeOrganisation, organisations, previousSeenAt, permissions } =
    useBuilderPortalAuth();

  const summaryQuery = useBuilderWorkspaceSummary();
  const activityQuery = useBuilderActivity();
  const summary = summaryQuery.data;
  const activity = (activityQuery.data || []).slice(0, 8);

  /**
   * Pop the stock-selection notification on the dashboard as well as in the
   * bell. The source is the notification list the bell itself reads — same hook,
   * same query key, so this adds no fetch and invents no second notification.
   * Oldest first, because the toast viewport shows one at a time and the most
   * recent should be the one left standing.
   */
  const { toast } = useToast();
  const notificationsQuery = useBuilderNotifications();
  const notifications = notificationsQuery.data;

  useEffect(() => {
    if (!notifications?.length) return;
    for (const item of [...notifications].reverse()) {
      if (item.entity_kind !== STOCK_SELECTION_ENTITY_KIND) continue;
      // Read in the bell already: nothing to announce.
      if (item.read_at) continue;
      if (poppedStockSelectionIds.has(item.id)) continue;
      poppedStockSelectionIds.add(item.id);
      toast({ title: item.title, description: item.body ?? undefined });
    }
  }, [notifications, toast]);

  const grantedCount = Object.values(permissions).filter(
    (entry) => entry.view || entry.edit || entry.delete,
  ).length;

  const organisationName = activeOrganisation
    ? activeOrganisation.trading_name || activeOrganisation.legal_name
    : 'No organisation selected';

  /*
   * THE EIGHT FIGURES, EACH WITH SOMETHING TO READ IT AGAINST.
   *
   * These used to be three stat cards over five smaller ones, and under them a
   * footnote apologising for the numbers: "a zero means nothing you can see,
   * not necessarily nothing at all". That sentence exists because a bare `0`
   * in a bordered box reads as a broken page.
   *
   * The scoping it was making is real and is kept — but it belongs to each
   * figure rather than to the grid, so it is said in the baseline where the
   * reader is already looking, and the footnote goes.
   *
   * NOTHING HERE INVENTS A TREND. `useBuilderWorkspaceSummary` returns counts,
   * not a series, so no baseline claims a movement. Where the summary holds a
   * genuinely related figure — overdue against open, defects against builds,
   * unread against conversations — the baseline uses it; otherwise it states
   * what the count is scoped to, which is the honest thing a count can say
   * about itself.
   */
  const count = (value: number | undefined) => value ?? 0;
  const plural = (value: number, one: string, many: string) => (value === 1 ? one : many);

  const openDefects = count(summary?.open_defects);
  const overdueTasks = count(summary?.overdue_tasks);
  const unreadMessages = count(summary?.unread_messages);
  const openTasks = count(summary?.open_tasks);
  const unreadNotifications = count(summary?.unread_notifications);

  const deliveryFigures = [
    {
      key: 'projects',
      label: 'Active projects',
      value: count(summary?.projects),
      unit: plural(count(summary?.projects), 'project', 'projects'),
      baseline: 'Shared with your account',
      to: '/builder/projects',
    },
    {
      key: 'units',
      label: 'Units in inventory',
      value: count(summary?.units),
      unit: plural(count(summary?.units), 'unit', 'units'),
      baseline: 'Across every project you reach',
      to: '/builder/inventory',
    },
    {
      key: 'builds',
      label: 'Active builds',
      value: count(summary?.construction_cases),
      unit: plural(count(summary?.construction_cases), 'build', 'builds'),
      baseline: openDefects > 0
        ? `${openDefects} open ${plural(openDefects, 'defect', 'defects')}`
        : 'No open defects',
      to: '/builder/construction',
    },
    {
      key: 'transactions',
      label: 'Transactions',
      value: count(summary?.transactions),
      baseline: 'Recorded against your lots',
      to: '/builder/transactions',
    },
    /*
     * A FIGURE IS A DOOR. Three of these four count things whose section is
     * withdrawn from this portal, and a count nobody can open is both a
     * number the reader can do nothing with and a link to a notice saying
     * the section is not offered. They are FILTERED rather than deleted, so
     * re-offering a section in `builderHiddenSections.pure.ts` brings its
     * figure back without a second edit here.
     */
  ].filter((figure) => !isWithdrawnBuilderPath(figure.to));

  const workspaceFigures = [
    {
      key: 'documents',
      label: 'Documents',
      value: count(summary?.documents),
      baseline: 'Across every project you reach',
      to: '/builder/documents',
    },
    {
      key: 'conversations',
      label: 'Open conversations',
      value: count(summary?.open_conversations),
      baseline: unreadMessages > 0
        ? `${unreadMessages} unread ${plural(unreadMessages, 'message', 'messages')}`
        : 'Nothing unread',
      to: '/builder/messages',
    },
    {
      key: 'tasks',
      label: 'Open tasks',
      value: openTasks,
      baseline: overdueTasks > 0
        ? `${overdueTasks} overdue`
        : openTasks === 0 ? 'Nothing waiting on you' : 'None overdue',
      to: '/builder/tasks',
    },
    {
      key: 'notifications',
      label: 'Unread notifications',
      value: unreadNotifications,
      baseline: unreadNotifications === 0 ? 'You are up to date' : 'Since your last visit',
      to: '/builder/notifications',
    },
  ].filter((figure) => !isWithdrawnBuilderPath(figure.to));

  const attention = [
    { label: 'Open defects', value: summary?.open_defects ?? 0, to: '/builder/construction' },
    { label: 'Overdue tasks', value: summary?.overdue_tasks ?? 0, to: '/builder/tasks' },
    { label: 'Unread messages', value: summary?.unread_messages ?? 0, to: '/builder/messages' },
    /* Same rule as the figures above — a row that leads to a withdrawn
       section is a door to a notice. */
  ].filter((item) => item.value > 0 && !isWithdrawnBuilderPath(item.to));

  return (
    <BuilderPortalShell
      eyebrow="Welcome back"
      title={smartCapitalize(user?.name) || 'Builder'}
      description="Your project-delivery workspace across every organisation and project shared with your account."
      /*
       * THE HERO CARRIES THE SHEET'S TITLE BLOCK.
       *
       * A drawing identifies itself in a keyed panel — who it is for, under
       * what authority, and when it was last revised — and that is exactly
       * what this page's chrome already knew and drew nowhere: the
       * organisation and role sat in the sidebar's user card, and how current
       * the figures are was not said at all, on a page whose whole content is
       * counts behind a Refresh button.
       *
       * Every cell is a fact the page already holds. Nothing here fetches.
       */
      aside={
        <TitleBlock
          wide={false}
          cells={[
            {
              key: 'organisation',
              label: 'Organisation',
              value: organisationName,
            },
            {
              key: 'access',
              label: 'Access',
              value: activeOrganisation
                ? accessRoleLabel(activeOrganisation.membership_role)
                : null,
            },
            {
              key: 'membership',
              label: 'Membership',
              /* `is_primary` is a fact about THIS organisation; where it is
                 false the honest reading is how many the account reaches,
                 not a blank. */
              value: activeOrganisation?.is_primary
                ? 'Primary'
                : organisations.length > 1
                  ? `1 of ${organisations.length}`
                  : null,
            },
            {
              key: 'updated',
              label: 'Figures as at',
              /* The revision date. `dataUpdatedAt` is 0 before the first
                 settled fetch, which is "not recorded" rather than 1970. */
              value: summaryQuery.dataUpdatedAt
                ? new Date(summaryQuery.dataUpdatedAt).toLocaleString(AU_LOCALE, {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })
                : null,
            },
          ]}
        />
      }
      actions={
        <>
          <Button
            variant="outline" size="sm"
            onClick={() => { void summaryQuery.refetch(); void activityQuery.refetch(); }}
            disabled={summaryQuery.isFetching || activityQuery.isFetching}
          >
            <RefreshCw
              className={cn('mr-2 h-4 w-4',
                (summaryQuery.isFetching || activityQuery.isFetching) && 'animate-spin')}
              aria-hidden
            />
            Refresh
          </Button>
          <Button asChild size="sm">
            <Link to="/builder/projects">
              Open projects <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </>
      }
    >
      {summaryQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/60 bg-card/70 px-6 py-7 shadow-lg shadow-primary/5">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">Loading your dashboard…</p>
          </div>
        </div>
      ) : summaryQuery.isError ? (
        <div role="alert" className="builder-portal-soft-panel p-6 text-center">
          <p className="font-medium text-foreground">Your summary could not be loaded</p>
          <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
          <Button className="mt-4" variant="outline" onClick={() => void summaryQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <BuilderSchedule figures={[...deliveryFigures, ...workspaceFigures]} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Recent activity */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-primary" aria-hidden />
                Recent activity
              </CardTitle>
              <CardDescription>
                Changes to records you can reach. Administrative events are not shown here.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/builder/activity">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {activityQuery.isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading activity" />
              </div>
            ) : activityQuery.isError ? (
              <div role="alert" className="rounded-lg border border-destructive/40 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">Activity could not be loaded</p>
                <Button className="mt-4" variant="outline" onClick={() => void activityQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : !activity.length ? (
              <div className="rounded-lg border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                Nothing has happened yet. Changes to your projects, builds and tasks will appear here.
              </div>
            ) : activity.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-border/70 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {activityActionLabel(entry.action)}
                  {entry.entity_type ? (
                    <Badge variant="outline" className="font-normal">
                      {ACTIVITY_ENTITY_LABELS[entry.entity_type] ?? entry.entity_type}
                    </Badge>
                  ) : null}
                </div>
                {entry.reason ? (
                  <p className="mt-1 text-sm text-muted-foreground">{entry.reason}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {ACTOR_TYPE_LABELS[entry.actor_type] ?? entry.actor_type} ·{' '}
                  {formatWorkspaceTime(entry.created_at)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* Project delivery attention */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
                Project delivery attention
              </CardTitle>
              <CardDescription>What is waiting on you across this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {attention.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                  Nothing needs your attention right now.
                </p>
              ) : attention.map((item) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 transition-colors hover:bg-destructive/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
                  <span className="shrink-0 text-base font-semibold tabular-nums text-foreground">
                    {item.value}
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>

          {/* Organisation context */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="h-4 w-4 text-primary" aria-hidden />
                Organisation context
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="break-words text-sm font-semibold leading-snug text-foreground">
                {organisationName}
              </p>
              {activeOrganisation ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="font-normal">
                    {accessRoleLabel(activeOrganisation.membership_role)}
                  </Badge>
                  {activeOrganisation.is_primary ? (
                    <Badge variant="outline" className="font-normal">Primary organisation</Badge>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose an organisation to continue
                </p>
              )}
              {organisations.length > 1 ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  You have organisation access to {organisations.length} organisations. Switch from
                  the sidebar.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Access and security */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
                Access and security
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <p className="text-2xl font-semibold tabular-nums leading-tight text-foreground">
                {grantedCount}
              </p>
              <p className="text-sm text-foreground">
                permission {grantedCount === 1 ? 'area' : 'areas'} granted
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Permissions are resolved by the server on every request. Anything not explicitly
                granted is denied.
              </p>
              <p className="flex items-center gap-1.5 pt-2 text-xs text-muted-foreground">
                <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{user?.email}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Last signed in: {formatTimestamp(previousSeenAt)}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </BuilderPortalShell>
  );
}
