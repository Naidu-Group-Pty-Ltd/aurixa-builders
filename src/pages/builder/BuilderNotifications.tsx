import { Bell, CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  useBuilderCollaborationMutation, useBuilderNotifications, useBuilderUnreadCounts,
} from '@/lib/builderQueries';
import {
  NOTIFICATION_TYPE_LABELS, formatCollaborationTime, type BuilderNotificationType,
} from '@/lib/builderCollaboration';

/**
 * External Builder Portal notifications.
 *
 * The list is always the caller's own, resolved from the session — no id from
 * this page selects whose notifications are read. Each row is a POINTER: it
 * names what happened and what it happened to, and carries no copy of the
 * record, so a notification about something later withdrawn cannot leak it.
 */
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
          { label: 'Unread notifications', value: countsQuery.data?.unread_notifications ?? unread.length },
          { label: 'Unread messages', value: countsQuery.data?.unread_messages ?? 0 },
          { label: 'Overdue tasks', value: countsQuery.data?.overdue_tasks ?? 0 },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 pt-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
                <Bell className="h-5 w-5 text-primary" aria-hidden />
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
            A notification points at a record. Open the record itself to see its current state.
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
            <ul className="space-y-2">
              {records.map((record) => (
                <li
                  key={record.id}
                  className={cn(
                    'rounded-lg border p-4',
                    record.read_at ? 'border-border' : 'border-primary/40 bg-primary/5',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      {/* A div, not a p: Badge renders a div, and a div inside
                          a p is invalid HTML the browser silently reflows. */}
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        {record.title}
                        <Badge variant="outline">
                          {NOTIFICATION_TYPE_LABELS[
                            record.notification_type as BuilderNotificationType]}
                        </Badge>
                      </div>
                      {record.body ? (
                        <p className="mt-1 text-sm text-muted-foreground">{record.body}</p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        {formatCollaborationTime(record.created_at)}
                      </p>
                    </div>
                    {record.read_at ? null : (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => void markOneRead(record.id)}
                        disabled={mutation.isPending}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
