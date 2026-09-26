/**
 * The reads behind a builder's conversations with agencies
 * (docs/builder-portal/61, 62).
 *
 * One conversation per activation, and membership is the authority. A
 * conversation is found only within the session's organisation, and its
 * messages and participants are read only after the viewer is found among its
 * CURRENT participants. For anyone else the answer is `not_a_participant` and
 * the messages are never queried: `inventory` access, the property and the id
 * in the request decide nothing.
 */
import {
  projectAgencyMessages, projectAgencyParticipants,
  type AgencyMessageView, type AgencyParticipantView,
} from './agencyMessages.pure.ts';

// deno-lint-ignore no-explicit-any
type Client = any;
type Row = Record<string, any>;

/** How many participant rows one read asks for. */
const ROSTER_PAGE = 500;

export type AgencyConversationRead =
  | {
    ok: true; conversation_id: string; stock_item_id: string; open: boolean;
    participants: AgencyParticipantView[]; messages: AgencyMessageView[];
  }
  | { ok: false; reason: 'not_found' | 'not_a_participant' | 'unavailable' };

/**
 * Open means a new message could be written now — the database's rule: the
 * connection is active and the conversation's own activation is live and
 * acknowledged.
 */
function isOpen(connection: Row | null, announcement: Row | null, selectionRef: unknown): boolean {
  return connection?.state === 'active' && !!selectionRef && !!announcement
    && announcement.status !== 'withdrawn' && !!announcement.acknowledged_at;
}

export async function readAgencyConversation(
  supabase: Client,
  args: { organisationId: string; conversationId: string; viewerUserId: string },
): Promise<AgencyConversationRead> {
  const { data: conversation, error } = await supabase.from('builder_agency_conversations')
    .select('id, connection_id, stock_item_id, organisation_id, selection_ref')
    .eq('id', args.conversationId).eq('organisation_id', args.organisationId).maybeSingle();
  if (error) return { ok: false, reason: 'unavailable' };
  if (!conversation) return { ok: false, reason: 'not_found' };

  // The whole roster, a page at a time, before membership is decided: a
  // response ceiling must never refuse somebody who is in the conversation.
  const rows: Row[] = [];
  for (let from = 0; ; from += ROSTER_PAGE) {
    const { data: people, error: peopleError } = await supabase.from('builder_agency_conversation_participants')
      .select('participant_ref, side, builder_user_id, display_name, state')
      .eq('conversation_id', conversation.id)
      .order('participant_ref', { ascending: true })
      .range(from, from + ROSTER_PAGE - 1);
    if (peopleError) return { ok: false, reason: 'unavailable' };
    const page = (people ?? []) as Row[];
    rows.push(...page);
    if (page.length < ROSTER_PAGE) break;
  }
  if (!rows.some((row) => row.builder_user_id === args.viewerUserId && row.state === 'joined' && row.side === 'builder')) {
    return { ok: false, reason: 'not_a_participant' };
  }

  const [connection, announcement] = await Promise.all([
    supabase.from('workspace_connections').select('state')
      .eq('id', conversation.connection_id).eq('builder_organisation_id', args.organisationId).maybeSingle(),
    conversation.selection_ref
      ? supabase.from('builder_stock_selection_announcements').select('status, acknowledged_at')
        .eq('connection_id', conversation.connection_id).eq('remote_selection_ref', conversation.selection_ref).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (connection.error || announcement.error) return { ok: false, reason: 'unavailable' };

  // The window is the newest 500 by ARRIVAL here, drawn in the order written
  // (Step 5's rule).
  const { data: messages, error: messagesError } = await supabase
    .from('builder_agency_messages')
    .select('id, side, sender_builder_user_id, sender_display_name, body, sent_at, delivery_state, delivered_at, failure_reason')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);
  if (messagesError) return { ok: false, reason: 'unavailable' };

  const open = isOpen(connection.data, announcement.data, conversation.selection_ref);
  return {
    ok: true,
    conversation_id: String(conversation.id),
    stock_item_id: String(conversation.stock_item_id),
    open,
    participants: projectAgencyParticipants(rows, args.viewerUserId),
    messages: projectAgencyMessages((messages ?? []) as Row[], args.viewerUserId)
      .map((message) => ({ ...message, can_retry: message.can_retry && open })),
  };
}

export interface AgencyConversationSummary {
  conversation_id: string;
  stock_item_id: string;
  address: string | null;
  lot_number: string | null;
  agency_name: string | null;
  open: boolean;
  last_message_at: string | null;
}

const LIST_PAGE = 500;
const IN_CHUNK = 200;

/** A `.in()` lookup over any number of ids, asked in bounded chunks, within one scope. */
async function readIn(
  supabase: Client, table: string, columns: string, column: string, values: unknown[],
  scope: { column: string; value: string },
): Promise<{ data: Row[]; error: unknown }> {
  const ids = [...new Set(values.map(String))];
  const data: Row[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data: rows, error } = await supabase.from(table).select(columns)
      .in(column, ids.slice(i, i + IN_CHUNK)).eq(scope.column, scope.value);
    if (error) return { data: [], error };
    data.push(...((rows ?? []) as Row[]));
  }
  return { data, error: null };
}

/** The conversations one member is in now, in the session's organisation. */
export async function listMyAgencyConversations(
  supabase: Client, args: { organisationId: string; viewerUserId: string },
): Promise<{ ok: true; conversations: AgencyConversationSummary[] } | { ok: false }> {
  // Every conversation the viewer is in, a page at a time: a response cap
  // would otherwise drop threads with nothing saying so.
  const mine: Row[] = [];
  for (let from = 0; ; from += LIST_PAGE) {
    const { data, error } = await supabase.from('builder_agency_conversation_participants')
      .select('conversation_id')
      .eq('builder_user_id', args.viewerUserId).eq('side', 'builder').eq('state', 'joined')
      .order('conversation_id', { ascending: true })
      .range(from, from + LIST_PAGE - 1);
    if (error) return { ok: false };
    const page = (data ?? []) as Row[];
    mine.push(...page);
    if (page.length < LIST_PAGE) break;
  }
  if (!mine.length) return { ok: true, conversations: [] };

  // Only this organisation's conversations; every lookup scoped to it too.
  const org = { column: 'organisation_id', value: args.organisationId };
  const conversations = await readIn(supabase, 'builder_agency_conversations',
    'id, connection_id, stock_item_id, selection_ref, last_message_at', 'id', mine.map((row) => row.conversation_id), org);
  if (conversations.error) return { ok: false };
  const list = conversations.data;
  if (!list.length) return { ok: true, conversations: [] };

  const [items, announcements, connections] = await Promise.all([
    readIn(supabase, 'builder_stock_items', 'id, address_line, lot_number', 'id', list.map((c) => c.stock_item_id), org),
    readIn(supabase, 'builder_stock_selection_announcements',
      'connection_id, remote_selection_ref, status, acknowledged_at, agency_name',
      'remote_selection_ref', list.map((c) => c.selection_ref).filter(Boolean), org),
    readIn(supabase, 'workspace_connections', 'id, state', 'id', list.map((c) => c.connection_id),
      { column: 'builder_organisation_id', value: args.organisationId }),
  ]);
  if (items.error || announcements.error || connections.error) return { ok: false };
  const itemById = new Map(((items.data ?? []) as Row[]).map((row) => [row.id, row]));
  const connectionById = new Map(((connections.data ?? []) as Row[]).map((row) => [row.id, row]));
  const announcementOf = (c: Row) => ((announcements.data ?? []) as Row[])
    .find((a) => a.connection_id === c.connection_id && a.remote_selection_ref === c.selection_ref) ?? null;

  return {
    ok: true,
    conversations: list.map((c) => {
      const announcement = announcementOf(c);
      return {
        conversation_id: String(c.id),
        stock_item_id: String(c.stock_item_id),
        address: itemById.get(c.stock_item_id)?.address_line ?? null,
        lot_number: itemById.get(c.stock_item_id)?.lot_number ?? null,
        agency_name: announcement?.agency_name ?? null,
        open: isOpen(connectionById.get(c.connection_id) ?? null, announcement, c.selection_ref),
        last_message_at: c.last_message_at ?? null,
      };
    }).sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? ''))
      || a.conversation_id.localeCompare(b.conversation_id)),
  };
}
