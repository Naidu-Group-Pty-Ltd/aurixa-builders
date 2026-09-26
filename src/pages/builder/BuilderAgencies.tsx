import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Handshake, Loader2, LogOut, MessageSquare, RefreshCw, Send, ShieldAlert, UserPlus } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  ActivationContact, ActivationProjectLink, ActivationStatusBadge,
} from '@/components/builder-portal/StockActivation';
import { StockPicture } from '@/components/stock/StockPicture';
import {
  builderStockImageUrl, useAgencyConversation, useAgencyConversationInvitees, useEarlierAgencyConversationMessages, useBuilderActivatedProperties,
  useInviteAgencyParticipant, useLeaveAgencyConversation, useMyAgencyConversations, useRefreshMyAgencyConversations,
  useRetryAgencyMessage, useSendAgencyMessage,
} from '@/lib/builderStockQueries';
import { useToast } from '@/hooks/use-toast';
import { isDisplayableSourceImage, type BuilderStockImage } from '@/lib/builderStock';
import {
  AGENCIES_PATH, activatedPropertyLocality, activatedPropertyTitle, agencyLabel,
  accessRefused, agencyTabFrom, mergeAgencyConversationPages, newClientMessageId, outboundStateLabel, arrivalScrollTarget, scrollLogToEnd, scrollMessageIntoView,
  type ActivatedProperty, type AgencyConversation, type AgencyConversationSummary, type AgencyMessageView, type AgencyTab,
} from '@/lib/builderAgency';

/**
 * Builder Portal — Agencies.
 *
 * The connected Command Centre workspaces, as a builder meets them: what each
 * has activated from this organisation's stock, and (once messaging is carried
 * over the network) the conversations about those properties. One section,
 * two bookmarkable tabs: `/builder/agencies/activations` and
 * `/builder/agencies/messages`.
 *
 * Nothing here is a second record. The activations are the ones the network
 * sweep converged; the page reads them through `list_activated_properties`,
 * which pins every row to the session's organisation and withholds what the
 * builder was never told (who the agency's client is). A project is linked
 * only where the builder already has project access.
 *
 * The Messages tab lists the conversations the reader is in — one per
 * activation, private to its participants (docs/builder-portal/62) — and
 * reads each through `get_agency_conversation`, polled while it is open. A
 * participant can add a colleague and can leave; nobody removes anyone. A message
 * is written with one idempotency key (reused if the same send is repeated),
 * shows who wrote it and — for what this side sent — whether it arrived, and
 * a failed one stays visible with "Send again". Writing needs inventory edit
 * and an activation that is still live; the server decides both.
 */
export default function BuilderAgencies() {
  const params = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const tab = agencyTabFrom(params.tab);
  const query = useBuilderActivatedProperties(1);
  const refreshConversations = useRefreshMyAgencyConversations();
  const refresh = () => { void query.refetch(); void refreshConversations(); };

  const records = query.data?.records ?? [];
  const status = (query.error as { status?: number } | null)?.status;
  const denied = status === 403;
  // A refusal withdraws what was read; any other failure keeps it.
  const refused = accessRefused(query.error);

  return (
    <BuilderPortalShell
      title="Agencies"
      description="The agencies connected to you through their Command Centre: the properties they have activated from your stock list, and your conversations with them."
      actions={(
        <Button variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      )}
    >
      <Tabs
        value={tab}
        onValueChange={(next) => navigate(`${AGENCIES_PATH}/${next as AgencyTab}`)}
      >
        <TabsList>
          <TabsTrigger value="activations">
            <Handshake className="mr-2 h-4 w-4" aria-hidden />
            Activated Properties
          </TabsTrigger>
          <TabsTrigger value="messages">
            <MessageSquare className="mr-2 h-4 w-4" aria-hidden />
            Messages
          </TabsTrigger>
        </TabsList>

        {/* A read that fails blocks the page only when nothing was read:
            a failed refresh keeps what was read, which is still true and
            may just be behind. */}
        <TabsContent value="activations" className="mt-6">
          {query.isLoading ? <Loading /> : query.error && (!query.data || refused) ? (
            <ReadFailure denied={denied} onRetry={() => void query.refetch()} />
          ) : (
            <div className="space-y-3">
              {query.error ? (
                <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                  <span>Your activations could not be refreshed. This is the list as last read.</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
                </div>
              ) : null}
              <ActivatedPropertiesList records={records} />
            </div>
          )}
        </TabsContent>

        {/* The Messages tab reads the full list itself and says when that
            fails; the first page is only its stand-in while it loads. */}
        <TabsContent value="messages" className="mt-6">
          {query.isLoading ? <Loading /> : query.error && (!query.data || refused) ? (
            <ReadFailure denied={denied} onRetry={() => void query.refetch()} />
          ) : (
            <MessagesShell />
          )}
        </TabsContent>
      </Tabs>
    </BuilderPortalShell>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Loading your agencies…
    </p>
  );
}

function ReadFailure({ denied, onRetry }: { denied: boolean; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-6">
        <ShieldAlert className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
        {denied ? (
          <p className="text-sm text-muted-foreground">
            You do not have access to your organisation&apos;s activations. An administrator of your
            organisation can grant it.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your activations could not be loaded just now. Nothing has changed — try again shortly.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The property's photograph by the Stock List's own rule, or none. */
function activationImage(record: ActivatedProperty): BuilderStockImage | null {
  const image = record.primary_image as BuilderStockImage | null;
  return image && isDisplayableSourceImage(image) ? image : null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-AU') : '');

function ActivatedPropertiesList({ records }: { records: ActivatedProperty[] }) {
  if (!records.length) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          No agency has activated any of your properties yet. When a connected agency activates a
          property from your stock list, it appears here with the agency&apos;s contact.
        </CardContent>
      </Card>
    );
  }
  return (
    <ul className="space-y-4" aria-label="Activated properties">
      {records.map((record) => {
        const title = activatedPropertyTitle(record.property);
        const locality = activatedPropertyLocality(record.property);
        return (
          <li key={record.id} className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <StockPicture
              image={activationImage(record)}
              resolveUrl={builderStockImageUrl}
              className="rounded-md"
              alt={`${title} — the picture shown on the marketplace`}
              emptyLabel="No picture yet"
            />
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">{title}</h2>
                  {locality ? <p className="text-sm text-muted-foreground">{locality}</p> : null}
                </div>
                <ActivationStatusBadge status={record.status} />
              </div>
              {record.property?.house_design ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Design </span>
                  <span className="font-medium text-foreground">{record.property.house_design}</span>
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Activated {when(record.activated_at)} by{' '}
                <span className="font-medium text-foreground">{agencyLabel(record.agency)}</span>
                {record.agency.name && record.agency.workspace_label ? (
                  <span> · via {record.agency.workspace_label}</span>
                ) : null}
              </p>
              <ActivationContact activation={record.agency} />
              {record.acknowledged_at ? (
                <p className="text-xs text-muted-foreground">
                  You acknowledged this {when(record.acknowledged_at)}
                  {record.acknowledged_by_name ? ` — ${record.acknowledged_by_name}` : ''}
                </p>
              ) : null}
              <ActivationProjectLink projectId={record.project?.accessible ? record.project.id : null} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MessagesShell() {
  // Only the conversations the reader is in: the server lists nobody else's.
  const mine = useMyAgencyConversations();
  const threads = mine.data?.conversations ?? [];
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('thread') ?? '';
  const selected = threads.find((thread) => thread.conversation_id === selectedKey) ?? null;

  if (mine.isLoading) return <Loading />;
  if (mine.error && (!mine.data || accessRefused(mine.error))) {
    const status = (mine.error as { status?: number } | null)?.status;
    return <ReadFailure denied={status === 403} onRetry={() => void mine.refetch()} />;
  }

  const stale = mine.error && mine.data ? (
    <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      <span>The conversation list could not be refreshed. This is the list as last read.</span>
      <Button type="button" variant="outline" size="sm" onClick={() => void mine.refetch()}>Try again</Button>
    </div>
  ) : null;

  if (!threads.length && !selectedKey) {
    return (
      <div className="space-y-3">
        {stale}
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            No conversations yet. When you acknowledge an activation, a private conversation opens with the agency
            user who activated it, and either of you can add a colleague.
          </CardContent>
        </Card>
      </div>
    );
  }

  const choose = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('thread', key);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-3">
    {stale}
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div role="listbox" aria-label="Conversations" className="space-y-2">
        {threads.map((thread) => (
          <button
            key={thread.conversation_id}
            type="button"
            role="option"
            aria-selected={thread.conversation_id === selectedKey}
            onClick={() => choose(thread.conversation_id)}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
              thread.conversation_id === selectedKey ? 'border-primary bg-accent/40' : 'border-border hover:bg-accent/20',
            )}
          >
            <span className="block font-medium text-foreground">{thread.agency_name ?? 'Agency'}</span>
            <span className="block truncate text-muted-foreground">{threadTitle(thread)}</span>
          </button>
        ))}
      </div>
      {selectedKey ? <ThreadView key={selectedKey} conversationId={selectedKey} summary={selected} /> : (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Choose a conversation to see it.
          </CardContent>
        </Card>
      )}
    </div>
    </div>
  );
}

function threadTitle(thread: AgencyConversationSummary | null): string {
  if (!thread) return 'Property';
  return [thread.lot_number ? `Lot ${thread.lot_number}` : null, thread.address].filter(Boolean).join(', ') || 'Property';
}

function ThreadView({ conversationId, summary }: { conversationId: string; summary: AgencyConversationSummary | null }) {
  const { toast } = useToast();
  const query = useAgencyConversation(conversationId);
  const send = useSendAgencyMessage(conversationId);
  const retry = useRetryAgencyMessage(conversationId);
  const [draft, setDraft] = useState('');
  // One key per message the person writes. A send that fails in flight is
  // repeated with the SAME key, so it can never arrive twice.
  const [clientMessageId, setClientMessageId] = useState(newClientMessageId);

  // A refusal withdraws the history and the composer; a transient failure
  // keeps what was read.
  const accessLost = accessRefused(query.error);
  const conversation = accessLost ? undefined : query.data;
  // The poll keeps the newest window current; earlier pages are added above
  // it when asked for, so the whole history can be read however long it is.
  const earlierPage = useEarlierAgencyConversationMessages(conversationId);
  // Once paging has begun, every newest window the poll brings is kept too:
  // the window moves on as messages arrive, and a message that slides out of
  // it lies after the earliest page's cursor, so no page would ever return it.
  const [earlier, setEarlier] = useState<{
    messages: AgencyMessageView[]; cursor: string | null; more: boolean; window: readonly AgencyMessageView[];
  } | null>(null);
  const pollWindow = conversation?.messages;
  if (earlier && pollWindow && earlier.window !== pollWindow) {
    // A window that shares nothing with the last one, with more before it,
    // means a whole window arrived unseen: the messages between are reached
    // by paging again from the new window, never skipped over.
    const kept = new Set(earlier.window.map((m) => m.id));
    const disjoint = kept.size > 0 && !!conversation?.has_earlier && !pollWindow.some((m) => kept.has(m.id));
    setEarlier(disjoint ? null : { ...earlier, messages: mergeAgencyConversationPages(earlier.messages, pollWindow), window: pollWindow });
  }
  const messages = conversation ? mergeAgencyConversationPages(earlier?.messages ?? [], conversation.messages ?? []) : [];
  const earlierCursor = earlier ? earlier.cursor : conversation?.earlier_cursor ?? null;
  const moreEarlier = earlier ? earlier.more : !!conversation?.has_earlier;
  const canSend = !!conversation?.can_send;
  // Open at the newest message, and follow whatever a poll brings in, even a
  // late message that sorts above the newest one.
  const logRef = useRef<HTMLDivElement>(null);
  const seenIdsRef = useRef<string[] | null>(null);
  const idsKey = messages.map((message) => message.id).join(',');
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    const target = arrivalScrollTarget(seenIdsRef.current, ids);
    seenIdsRef.current = ids;
    if (target === 'end') scrollLogToEnd(logRef.current);
    else if (target) scrollMessageIntoView(logRef.current, target);
  }, [idsKey]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    try {
      await send.mutateAsync({ clientMessageId, body });
      setDraft('');
      setClientMessageId(newClientMessageId());
    } catch (error) {
      toast({
        title: 'Your message was not sent',
        description: error instanceof Error ? error.message : 'Try again shortly.',
        variant: 'destructive',
      });
    }
  };

  const showEarlier = async () => {
    if (!earlierCursor || earlierPage.isPending) return;
    try {
      const page = await earlierPage.mutateAsync(earlierCursor);
      setEarlier((previous) => ({
        messages: mergeAgencyConversationPages([...(page.messages ?? []), ...(previous?.messages ?? [])], pollWindow ?? []),
        cursor: page.earlier_cursor ?? null,
        more: !!page.has_earlier && !!page.earlier_cursor,
        window: pollWindow ?? [],
      }));
    } catch (error) {
      toast({
        title: 'Earlier messages could not be loaded',
        description: error instanceof Error ? error.message : 'Try again shortly.',
        variant: 'destructive',
      });
    }
  };

  const sendAgain = async (messageId: string) => {
    try {
      const answer = await retry.mutateAsync(messageId);
      // A message from an earlier page is not in the polled window the retry
      // refreshes, so what the server now says of it replaces the kept copy.
      const updated = answer?.message;
      if (updated) {
        setEarlier((previous) => (previous
          ? { ...previous, messages: previous.messages.map((m) => (m.id === updated.id ? updated : m)) }
          : previous));
      }
    } catch (error) {
      toast({
        title: 'That message could not be sent again',
        description: error instanceof Error ? error.message : 'Try again shortly.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <p className="text-base font-semibold text-foreground">{summary?.agency_name ?? 'Agency'}</p>
          <p className="text-sm text-muted-foreground">{threadTitle(summary)}</p>
        </div>

        {conversation ? <People conversationId={conversationId} conversation={conversation} /> : null}

        {/* A poll that fails after the conversation was read keeps what was
            read: the history is still true, it may just be behind. */}
        {accessLost ? (
          <p className="text-sm text-muted-foreground">
            {(query.error as { code?: string } | null)?.code === 'not_a_participant'
              ? 'You are not in this conversation. Only its participants can read it.'
              : 'This conversation is no longer available to you.'}
          </p>
        ) : null}

        {query.error && conversation ? (
          <p role="status" className="text-sm text-muted-foreground">
            This conversation could not be refreshed just now, so newer messages may be missing. It will try again shortly.
          </p>
        ) : null}

        {query.isLoading ? <Loading /> : query.error && !conversation && !accessLost ? (
          <p className="text-sm text-muted-foreground">
            This conversation could not be loaded just now. It will try again shortly.
          </p>
        ) : accessLost ? null : messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No messages yet.</p>
            <p className="mt-1">Anything you write here is sent to {summary?.agency_name ?? 'the agency'} about this property.</p>
          </div>
        ) : (
          <>
            {moreEarlier && earlierCursor ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void showEarlier()} disabled={earlierPage.isPending}>
                {earlierPage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                Show earlier messages
              </Button>
            ) : null}
            <div ref={logRef} role="log" aria-label="Conversation" aria-live="polite" className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} canRetry={canSend && message.can_retry} onRetry={sendAgain} retrying={retry.isPending} />
              ))}
            </div>
          </>
        )}

        {conversation && !conversation.open ? (
          <p className="text-sm text-muted-foreground">
            This property is no longer activated by this agency, so the conversation is closed. Its history stays here.
          </p>
        ) : null}

        <div className="space-y-2">
          <Textarea
            aria-label="Message"
            placeholder={canSend ? 'Write a message' : 'You cannot write in this conversation'}
            value={draft}
            maxLength={4000}
            onChange={(event) => {
              // Different text is a different message: the key a failed send
              // is repeated under belongs to the text it was sent with.
              setDraft(event.target.value);
              setClientMessageId(newClientMessageId());
            }}
            disabled={!canSend || send.isPending}
            rows={3}
          />
          <div className="flex justify-end">
            <Button type="button" onClick={() => void submit()} disabled={!canSend || send.isPending || !draft.trim()}>
              {send.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                : <Send className="mr-2 h-4 w-4" aria-hidden />}
              Send
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message, canRetry, onRetry, retrying,
}: {
  message: AgencyMessageView;
  /** The message's own retry flag AND whether this reader may write here now. */
  canRetry: boolean;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  const ours = message.side === 'builder';
  return (
    <article
      data-message-id={message.id}
      className={cn(
        'max-w-[85%] rounded-lg border px-3 py-2 text-sm',
        ours ? 'ml-auto border-primary/30 bg-primary/5' : 'mr-auto border-border bg-card',
      )}
    >
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{message.sender_display_name}</span>
        {' · '}{ours ? 'Your team' : 'Agency'}{' · '}{when(message.sent_at)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{message.body}</p>
      {message.delivery_state ? (
        <p className={cn('mt-1 flex items-center gap-2 text-xs',
          message.delivery_state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          <span>{outboundStateLabel(message.delivery_state, message.failure_reason)}</span>
          {canRetry ? (
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs"
              onClick={() => onRetry(message.id)} disabled={retrying}>
              Send again
            </Button>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The people in the conversation, from both sides, and the two acts a
 * participant has: add a colleague from this organisation, and leave. There
 * is no way to remove somebody else.
 */
function People({ conversationId, conversation }: { conversationId: string; conversation: AgencyConversation }) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const invitees = useAgencyConversationInvitees(conversationId, adding);
  const invite = useInviteAgencyParticipant(conversationId);
  const leave = useLeaveAgencyConversation(conversationId);
  const participants = conversation.participants ?? [];

  const add = async (userId: string) => {
    try {
      await invite.mutateAsync(userId);
      setAdding(false);
    } catch (error) {
      toast({ title: 'That person was not added', description: error instanceof Error ? error.message : 'Try again shortly.', variant: 'destructive' });
    }
  };
  const doLeave = async () => {
    try {
      await leave.mutateAsync();
    } catch (error) {
      toast({ title: 'You have not left the conversation', description: error instanceof Error ? error.message : 'Try again shortly.', variant: 'destructive' });
    } finally {
      setConfirmLeave(false);
    }
  };

  return (
    <section className="space-y-2">
      <ul aria-label="Participants" className="flex flex-wrap gap-2">
        {participants.map((p) => (
          <li key={p.participant_ref} className="rounded-full border border-border px-2.5 py-0.5 text-xs">
            <span className="font-medium text-foreground">{p.display_name}</span>
            <span className="text-muted-foreground">{' · '}{p.side === 'command_centre' ? 'Agency' : p.is_me ? 'You' : 'Your team'}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {conversation.can_invite ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden /> Add user
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmLeave(true)}
          disabled={conversation.can_leave === false || leave.isPending}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden /> Leave chat
        </Button>
        {conversation.can_leave === false ? (
          <span className="text-xs text-muted-foreground">
            Add a colleague before you leave: someone from your organisation stays in a live conversation.
          </span>
        ) : null}
      </div>
      {adding ? (
        <div className="rounded-md border border-border p-3">
          {invitees.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading colleagues…</p>
          ) : invitees.error && !invitees.data ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Your colleagues could not be loaded just now.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void invitees.refetch?.()}>Try again</Button>
            </div>
          ) : (invitees.data ?? []).length ? (
            <ul className="space-y-1">
              {(invitees.data ?? []).map((person) => (
                <li key={person.user_id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{person.display_name}</span>
                  <Button type="button" size="sm" variant="secondary" disabled={invite.isPending}
                    aria-label={`Add ${person.display_name}`} onClick={() => void add(person.user_id)}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">There is nobody else in your organisation who can be added.</p>
          )}
        </div>
      ) : null}
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              You will stop seeing it straight away. Its history stays for the people still in it, and a colleague can add
              you back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doLeave()}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
