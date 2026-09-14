import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, MessageSquare, Plus, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderScopePicker, type BuilderScopeValue } from '@/components/builder-portal/BuilderScopePicker';
import {
  useBuilderCollaborationMutation, useBuilderConversation, useBuilderConversations,
} from '@/lib/builderQueries';
import {
  CONVERSATION_STATUS_LABELS, formatCollaborationTime,
  type BuilderConversationStatus, type BuilderScopeType,
} from '@/lib/builderCollaboration';

/**
 * External Builder Portal conversations.
 *
 * The list is `builder_accessible_conversations`, so a conversation whose scope
 * this user cannot reach — or one restricted to other participants — never
 * appears. Messages are immutable once posted; there is deliberately no edit or
 * delete control, because the database refuses both.
 */
export default function BuilderMessages() {
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();

  const projectId = params.get('project') ?? '';
  const scope: BuilderScopeValue = {
    scopeType: (params.get('scope') as BuilderScopeType) || 'project',
    scopeId: params.get('scopeId') ?? (params.get('scope') ? '' : projectId),
  };
  const selectedId = params.get('conversation') ?? '';

  const patchParams = (changes: Record<string, string | null>) => {
    const updated = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) updated.set(key, value); else updated.delete(key);
    }
    setParams(updated, { replace: true });
  };

  const setScope = (next: BuilderScopeValue) => patchParams({
    scope: next.scopeType || null, scopeId: next.scopeId || null, conversation: null,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [draft, setDraft] = useState('');

  const query = useBuilderConversations(scope);
  const detailQuery = useBuilderConversation(selectedId);
  const mutation = useBuilderCollaborationMutation();

  const records = query.data || [];
  const scopeChosen = Boolean(scope.scopeType && scope.scopeId);
  const permissionDenied = (query.error as { status?: number } | null)?.status === 403;
  const conversation = detailQuery.data?.conversation;

  const openConversation = async (conversationId: string) => {
    patchParams({ conversation: conversationId });
    try {
      await mutation.mutateAsync({ operation: 'mark_conversation_read', conversation_id: conversationId });
    } catch {
      // Not being a participant is a normal outcome for a conversation that is
      // open to the whole scope. It must not interrupt reading.
    }
  };

  const startConversation = async () => {
    if (!subject.trim()) return;
    try {
      const result = await mutation.mutateAsync({
        operation: 'create_conversation',
        scope_type: scope.scopeType, scope_id: scope.scopeId, subject: subject.trim(),
      }) as { record?: { id?: string } };
      toast({ title: 'Conversation started' });
      setCreateOpen(false);
      setSubject('');
      if (result?.record?.id) patchParams({ conversation: result.record.id });
    } catch (error) {
      toast({
        title: 'The conversation could not be started',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const send = async () => {
    if (!draft.trim() || !selectedId) return;
    try {
      await mutation.mutateAsync({
        operation: 'post_message', conversation_id: selectedId, body: draft.trim(),
      });
      setDraft('');
    } catch (error) {
      toast({
        title: 'The message could not be sent',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <BuilderPortalShell
      title="Messages"
      description="Conversations against the projects, units, transactions and builds you can reach."
      actions={
        <>
          <Button
            variant="outline" size="sm"
            onClick={() => void query.refetch()}
            disabled={!scopeChosen || query.isFetching}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!scopeChosen}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />New conversation
          </Button>
        </>
      }
    >
      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">Choose what to look at</CardTitle>
            <CardDescription>
              Every option below is one your access already reaches.
            </CardDescription>
          </div>
          <BuilderScopePicker
            value={scope} onChange={setScope}
            projectId={projectId}
            onProjectChange={(next) => patchParams({ project: next || null, conversation: null })}
          />
        </CardHeader>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            {!scopeChosen ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="font-medium">Choose a record first</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick a project above to see its conversations.
                </p>
              </div>
            ) : query.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading conversations" />
              </div>
            ) : permissionDenied ? (
              <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                <ShieldAlert className="mx-auto h-6 w-6 text-destructive" aria-hidden />
                <p className="mt-2 font-medium">You do not have access to these conversations</p>
              </div>
            ) : query.isError ? (
              <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                <p className="font-medium">Conversations could not be loaded</p>
                <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              </div>
            ) : !records.length ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="font-medium">No conversations yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Start the first one.</p>
              </div>
            ) : (
              <ul className="space-y-1">
                {records.map((record) => (
                  <li key={record.id}>
                    <button
                      type="button"
                      onClick={() => void openConversation(record.id)}
                      className={cn(
                        'w-full rounded-md border p-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        record.id === selectedId
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{record.subject}</span>
                        <Badge variant="outline" className="shrink-0">
                          {record.message_count}
                        </Badge>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {record.last_message_at
                          ? formatCollaborationTime(record.last_message_at)
                          : 'No messages yet'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {conversation?.subject || 'Select a conversation'}
            </CardTitle>
            {conversation ? (
              <CardDescription>
                <Badge variant="outline">
                  {CONVERSATION_STATUS_LABELS[conversation.status as BuilderConversationStatus]}
                </Badge>
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedId ? (
              <div className="rounded-lg border border-dashed p-12 text-center">
                <MessageSquare className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="mt-2 font-medium">Nothing selected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose a conversation on the left to read it.
                </p>
              </div>
            ) : detailQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading messages" />
              </div>
            ) : detailQuery.isError ? (
              <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                <p className="font-medium">This conversation could not be loaded</p>
                <Button className="mt-4" variant="outline" onClick={() => void detailQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : (
              <>
                <ol className="space-y-3">
                  {(detailQuery.data?.messages || []).length ? (
                    (detailQuery.data?.messages || []).map((message) => (
                      <li key={message.id} className="rounded-lg border border-border p-3">
                        <p className="text-sm whitespace-pre-wrap">{message.body}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {message.author_display_name || 'Aurixa Systems'} ·{' '}
                          {formatCollaborationTime(message.created_at)}
                        </p>
                      </li>
                    ))
                  ) : (
                    <li className="rounded-lg border border-dashed p-8 text-center">
                      <p className="font-medium">No messages yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">Post the first one below.</p>
                    </li>
                  )}
                </ol>

                {conversation?.status === 'archived' ? (
                  <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                    This conversation is archived. No new messages can be posted.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="message-body">Your message</Label>
                    <Textarea
                      id="message-body" value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Write a message"
                      rows={3}
                    />
                    <div className="flex justify-end">
                      <Button
                        onClick={() => void send()}
                        disabled={!draft.trim() || mutation.isPending}
                      >
                        {mutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Send className="mr-2 h-4 w-4" aria-hidden />
                        )}
                        Send
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New conversation</DialogTitle>
            <DialogDescription>
              Everyone who can reach this record can read it unless participants are named.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="conversation-subject">Subject</Label>
            <Input
              id="conversation-subject" value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Frame stage queries"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() => void startConversation()}
              disabled={!subject.trim() || mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Start conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BuilderPortalShell>
  );
}
