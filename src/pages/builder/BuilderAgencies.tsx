import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Handshake, Loader2, MessageSquare, RefreshCw, Send, ShieldAlert } from 'lucide-react';
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
  builderStockImageUrl, useAgencyConversation, useBuilderActivatedProperties, useEveryBuilderActivatedProperty, useRefreshEveryBuilderActivatedProperty,
  useRetryAgencyMessage, useSendAgencyMessage,
} from '@/lib/builderStockQueries';
import { useToast } from '@/hooks/use-toast';
import { isDisplayableSourceImage, type BuilderStockImage } from '@/lib/builderStock';
import {
  AGENCIES_PATH, activatedPropertyLocality, activatedPropertyTitle, agencyLabel,
  agencyTabFrom, agencyThreadsFrom, newClientMessageId, outboundStateLabel,
  type ActivatedProperty, type AgencyMessageView, type AgencyThread, type AgencyTab,
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
 * The Messages tab lists one conversation per agency and property and reads
 * each through `get_agency_conversation`, polled while it is open. A message
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
  const refreshEvery = useRefreshEveryBuilderActivatedProperty();
  const refresh = () => { void query.refetch(); void refreshEvery(); };

  const records = query.data?.records ?? [];
  const status = (query.error as { status?: number } | null)?.status;
  const denied = status === 403;

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

        <TabsContent value="activations" className="mt-6">
          {query.isLoading ? <Loading /> : query.error ? (
            <ReadFailure denied={denied} onRetry={() => void query.refetch()} />
          ) : (
            <ActivatedPropertiesList records={records} />
          )}
        </TabsContent>

        <TabsContent value="messages" className="mt-6">
          {query.isLoading ? <Loading /> : query.error ? (
            <ReadFailure denied={denied} onRetry={() => void query.refetch()} />
          ) : (
            <MessagesShell firstPage={records} />
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

function MessagesShell({ firstPage }: { firstPage: ActivatedProperty[] }) {
  // Every activation, not just the first page the list tab shows, so no
  // conversation is unreachable; the first page stands in until it arrives.
  const every = useEveryBuilderActivatedProperty();
  const records = every.data ?? firstPage;
  const threads = useMemo(() => agencyThreadsFrom(records), [records]);
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('thread') ?? '';
  const selected = threads.find((thread) => thread.key === selectedKey) ?? null;

  // The first page stands in only while the full list is loading. A full
  // list that FAILED is said so: the first page is not the complete list.
  if (every.error && !every.data) {
    const status = (every.error as { status?: number } | null)?.status;
    return <ReadFailure denied={status === 403} onRetry={() => void every.refetch()} />;
  }

  if (!threads.length) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          No conversations yet. A conversation opens here for each property an agency activates
          from your stock list.
        </CardContent>
      </Card>
    );
  }

  const choose = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('thread', key);
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div role="listbox" aria-label="Conversations" className="space-y-2">
        {threads.map((thread) => (
          <button
            key={thread.key}
            type="button"
            role="option"
            aria-selected={thread.key === selectedKey}
            onClick={() => choose(thread.key)}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
              thread.key === selectedKey ? 'border-primary bg-accent/40' : 'border-border hover:bg-accent/20',
            )}
          >
            <span className="block font-medium text-foreground">{agencyLabel(thread.agency)}</span>
            <span className="block truncate text-muted-foreground">{activatedPropertyTitle(thread.property)}</span>
          </button>
        ))}
      </div>
      {selected ? <ThreadView key={selected.key} thread={selected} /> : (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Choose a conversation to see it.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ThreadView({ thread }: { thread: AgencyThread }) {
  const { toast } = useToast();
  const query = useAgencyConversation(thread.connection_id, thread.stock_item_id);
  const send = useSendAgencyMessage(thread.connection_id, thread.stock_item_id);
  const retry = useRetryAgencyMessage(thread.connection_id, thread.stock_item_id);
  const [draft, setDraft] = useState('');
  // One key per message the person writes. A send that fails in flight is
  // repeated with the SAME key, so it can never arrive twice.
  const [clientMessageId, setClientMessageId] = useState(newClientMessageId);

  const conversation = query.data;
  const messages = conversation?.messages ?? [];
  const canSend = !!conversation?.can_send;

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

  const sendAgain = async (messageId: string) => {
    try {
      await retry.mutateAsync(messageId);
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
          <p className="text-base font-semibold text-foreground">{agencyLabel(thread.agency)}</p>
          <p className="text-sm text-muted-foreground">
            {activatedPropertyTitle(thread.property)}
            {thread.agency.contact_name ? ` · ${thread.agency.contact_name}` : ''}
          </p>
        </div>

        {query.isLoading ? <Loading /> : query.error ? (
          <p className="text-sm text-muted-foreground">
            This conversation could not be loaded just now. It will try again shortly.
          </p>
        ) : messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No messages yet.</p>
            <p className="mt-1">Anything you write here is sent to {agencyLabel(thread.agency)} about this property.</p>
          </div>
        ) : (
          <div role="log" aria-label="Conversation" aria-live="polite" className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} canRetry={canSend && message.can_retry} onRetry={sendAgain} retrying={retry.isPending} />
            ))}
          </div>
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
