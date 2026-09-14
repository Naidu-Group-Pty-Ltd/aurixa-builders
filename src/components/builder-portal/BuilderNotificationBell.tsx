import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  useBuilderCollaborationMutation, useBuilderNotifications, useBuilderUnreadCounts,
} from '@/lib/builderQueries';
import type { BuilderNotification } from '@/lib/builderCollaboration';

/**
 * The top-bar notification control, in the same presentation as the Solicitor
 * bell: a badge when there is something unread, a popover list, and a
 * mark-all-read action.
 *
 * Every value comes from hooks the Builder Portal already ships and the
 * Notifications page already uses — `useBuilderNotifications`,
 * `useBuilderUnreadCounts` and `useBuilderCollaborationMutation`. No new query,
 * no new operation string, no new Edge Function, and no count is invented: the
 * badge renders only when the server reports one above zero.
 *
 * There is no realtime bridge here, because the Builder Portal has none. The
 * list refreshes on the same cadence its own query already defines.
 */
export function BuilderNotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const query = useBuilderNotifications();
  const countsQuery = useBuilderUnreadCounts();
  const mutation = useBuilderCollaborationMutation();

  const items = query.data ?? [];
  const unread = countsQuery.data?.unread_notifications ?? 0;

  const markRead = async (notificationIds: string[]) => {
    await mutation.mutateAsync({
      operation: 'mark_notifications_read',
      ...(notificationIds.length ? { notification_ids: notificationIds } : {}),
    });
  };

  const openItem = async (item: BuilderNotification) => {
    if (!item.read_at) await markRead([item.id]);
    // Notifications carry a scope rather than a path, so the destination is the
    // Notifications page — the one surface that knows how to resolve a scope.
    setOpen(false);
    navigate('/builder/notifications');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative"
          aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unread ? (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px]"
            >
              {unread > 9 ? '9+' : unread}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {unread ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markRead([])}
              disabled={mutation.isPending}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" aria-hidden />
              Mark all read
            </Button>
          ) : null}
        </div>

        <ScrollArea className="max-h-80" aria-live="polite">
          {query.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading notifications" />
            </div>
          ) : query.isError ? (
            <p role="alert" className="px-3 py-8 text-center text-sm text-muted-foreground">
              Notifications could not be loaded.
            </p>
          ) : !items.length ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              You&rsquo;re all caught up.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void openItem(item)}
                    className={cn(
                      'w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      !item.read_at && 'bg-primary/5',
                    )}
                  >
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.body ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
                    ) : null}
                    <time className="mt-1 block text-xs text-muted-foreground" dateTime={item.created_at}>
                      {new Date(item.created_at).toLocaleString('en-AU')}
                    </time>
                    {/* Unread is carried in words too, not by the tint alone. */}
                    {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export default BuilderNotificationBell;
