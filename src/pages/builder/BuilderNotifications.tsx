import { AlertTriangle, Bell, Building2, CheckCheck, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  ActivationAgencyLine, ActivationContact, ActivationStatusBadge, ActivationStockLink,
} from '@/components/builder-portal/StockActivation';
import {
  useBuilderCollaborationMutation, useBuilderNotifications, useBuilderUnreadCounts,
} from '@/lib/builderQueries';
import {
  NOTIFICATION_TYPE_LABELS, formatCollaborationTime, formatRelativeTime,
  type BuilderNotification, type BuilderNotificationType,
} from '@/lib/builderCollaboration';

/**
 * External Builder Portal notifications.
 *
 * The list is always the caller's own, resolved from the session — no id from
 * this page selects whose notifications are read. Each row is a POINTER: it
 * names what happened and what it happened to, and carries no copy of the
 * record.
 *
 * A stock ACTIVATION gets its own card rather than the generic title-and-body
 * row, because its reader has three questions and a sentence answers none of
 * them cleanly: WHICH property (the headline), WHO activated it (the agency
 * line), and HOW to respond (a contact that is a link, a live status chip
 * resolved from the record at list time, and the road to the Stock List).
 * The stored body still exists — it is the fallback wherever the resolved
 * context cannot be, never the layout.
 */

/** Time reads relatively in a feed; the exact stamp lives in the tooltip. */
function NotificationTime({ value }: { value: string }) {
  return (
    <time
      dateTime={value}
      title={formatCollaborationTime(value)}
      className="text-xs text-muted-foreground"
    >
      {formatRelativeTime(value)}
    </time>
  );
}

function UnreadDot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />;
}

function ActivationNotificationCard({
  record, onMarkRead, busy,
}: {
  record: BuilderNotification;
  onMarkRead: () => void;
  busy: boolean;
}) {
  const activation = record.activation!;
  const unread = !record.read_at;
  return (
    <li
      className={cn(
        'relative overflow-hidden rounded-xl border p-4 transition-colors',
        unread ? 'border-primary/35 bg-primary/[0.04]' : 'border-border/70',
      )}
    >
      {/* The rail makes an activation recognisable before a word is read. */}
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-1', unread ? 'bg-primary/70' : 'bg-border')}
      />
      <div className="flex flex-wrap items-start gap-3 pl-2">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
          <Building2 className="h-4 w-4 text-primary" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {unread ? <UnreadDot /> : null}
            <span className="font-semibold leading-tight">
              {activation.property_label || 'A property from your stock list'}
            </span>
            <ActivationStatusBadge status={activation.status} />
          </div>
          <ActivationAgencyLine activation={activation} />
          <ActivationContact activation={activation} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
            <NotificationTime value={record.created_at} />
            <ActivationStockLink />
          </div>
        </div>
        {unread ? (
          <Button
            variant="ghost" size="sm" className="shrink-0"
            onClick={onMarkRead} disabled={busy}
          >
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function GenericNotificationCard({
  record, onMarkRead, busy,
}: {
  record: BuilderNotification;
  onMarkRead: () => void;
  busy: boolean;
}) {
  const unread = !record.read_at;
  return (
    <li
      className={cn(
        'rounded-xl border p-4 transition-colors',
        unread ? 'border-primary/35 bg-primary/[0.04]' : 'border-border/70',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Bell className="h-4 w-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          {/* A div, not a p: Badge renders a div, and a div inside a p is
              invalid HTML the browser silently reflows. */}
          <div className="flex flex-wrap items-center gap-2">
            {unread ? <UnreadDot /> : null}
            <span className="font-medium leading-tight">{record.title}</span>
            <Badge
              variant="outline"
              className="border-border bg-muted/40 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {NOTIFICATION_TYPE_LABELS[record.notification_type as BuilderNotificationType]}
            </Badge>
          </div>
          {record.body ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{record.body}</p>
          ) : null}
          <div className="pt-0.5">
            <NotificationTime value={record.created_at} />
          </div>
        </div>
        {unread ? (
          <Button
            variant="ghost" size="sm" className="shrink-0"
            onClick={onMarkRead} disabled={busy}
          >
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export default function BuilderNotifications() {
  const { toast } = useToast();
  const query = useBuilderNotifications();
  const countsQuery = useBuilderUnreadCounts();
  const mutation = useBuilderCollaborationMutation();

  const records = query.data || [];
  const unread = records.filter((record) => !record.read_at);

  const markAllRead = async () => {
    try {
      const result = await mutation.mutateAsync({
        operation: 'mark_notifications_read',
      }) as { marked_read?: number };
      toast({
        title: result?.marked_read
          ? `${result.marked_read} marked as read`
          : 'Nothing left to mark',
      });
    } catch (error) {
      toast({
        title: 'The notifications could not be updated',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const markOneRead = async (notificationId: string) => {
    try {
      await mutation.mutateAsync({
        operation: 'mark_notifications_read', notification_ids: [notificationId],
      });
    } catch (error) {
      toast({
        title: 'That notification could not be updated',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <BuilderPortalShell
      title="Notifications"
      description="What has happened on the records you can reach."
      actions={
        <>
          <Button
            variant="outline" size="sm"
            onClick={() => void query.refetch()} disabled={query.isFetching}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button
            size="sm" onClick={() => void markAllRead()}
            disabled={!unread.length || mutation.isPending}
          >
            <CheckCheck className="mr-2 h-4 w-4" aria-hidden />Mark all read
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: 'Unread notifications',
            value: countsQuery.data?.unread_notifications ?? unread.length,
            icon: Bell,
          },
          { label: 'Unread messages', value: countsQuery.data?.unread_messages ?? 0, icon: MessageSquare },
          { label: 'Overdue tasks', value: countsQuery.data?.overdue_tasks ?? 0, icon: AlertTriangle },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 pt-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
                <Icon className="h-5 w-5 text-primary" aria-hidden />
              </span>
              <div>
                <p className="text-2xl font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent</CardTitle>
          <CardDescription>
            Newest first. Property activations show the record&rsquo;s current
            state and the agency&rsquo;s contact details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading notifications" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Notifications could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">Nothing to show</p>
              <p className="mt-1 text-sm text-muted-foreground">
                You will be notified here when something changes on your records.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {records.map((record) => (
                record.activation ? (
                  <ActivationNotificationCard
                    key={record.id}
                    record={record}
                    busy={mutation.isPending}
                    onMarkRead={() => void markOneRead(record.id)}
                  />
                ) : (
                  <GenericNotificationCard
                    key={record.id}
                    record={record}
                    busy={mutation.isPending}
                    onMarkRead={() => void markOneRead(record.id)}
                  />
                )
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
