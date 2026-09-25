/**
 * The read behind a builder's conversation with an agency.
 *
 * A conversation is readable only where THIS organisation holds an activation
 * of the property on that connection — the same announcement row the
 * Agencies page lists — so a connection or property id from the browser is a
 * lookup key and never authority. A withdrawn activation leaves the history
 * readable and the conversation closed.
 */
import { projectAgencyMessages, type AgencyMessageView } from './agencyMessages.pure.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

export type AgencyConversationRead =
  | { ok: true; conversation_id: string | null; open: boolean; messages: AgencyMessageView[] }
  | { ok: false; reason: 'not_found' | 'unavailable' };

export async function readAgencyConversation(
  supabase: Client,
  args: { organisationId: string; connectionId: string; stockItemId: string; viewerUserId: string },
): Promise<AgencyConversationRead> {
  const { data: announcements, error } = await supabase
    .from('builder_stock_selection_announcements')
    .select('id, status')
    .eq('organisation_id', args.organisationId)
    .eq('connection_id', args.connectionId)
    .eq('stock_item_id', args.stockItemId);
  if (error) return { ok: false, reason: 'unavailable' };
  const rows = (announcements ?? []) as Array<{ status: string }>;
  if (!rows.length) return { ok: false, reason: 'not_found' };
  // Open means a new message could be written now: the same two facts the
  // writer checks — a live activation AND an active connection. A revoked
  // connection keeps its announcement rows, so the rows alone would leave a
  // composer that every send is refused from.
  const { data: connection, error: connectionError } = await supabase
    .from('workspace_connections')
    .select('state')
    .eq('id', args.connectionId)
    .eq('builder_organisation_id', args.organisationId)
    .maybeSingle();
  if (connectionError) return { ok: false, reason: 'unavailable' };
  const open = (connection as { state?: string } | null)?.state === 'active'
    && rows.some((row) => row.status !== 'withdrawn');

  const { data: conversation, error: conversationError } = await supabase
    .from('builder_agency_conversations')
    .select('id')
    .eq('organisation_id', args.organisationId)
    .eq('connection_id', args.connectionId)
    .eq('stock_item_id', args.stockItemId)
    .maybeSingle();
  if (conversationError) return { ok: false, reason: 'unavailable' };
  if (!conversation) return { ok: true, conversation_id: null, open, messages: [] };

  const columns = 'id, side, sender_builder_user_id, sender_display_name, body, sent_at, delivery_state, delivered_at, failure_reason';
  const [{ data: newest, error: newestError }, { data: arrived, error: arrivedError }] = await Promise.all([
    // The NEWEST page: a thread past the cap must keep showing what was just
    // written. The projection puts it back in reading order.
    supabase.from('builder_agency_messages').select(columns)
      .eq('conversation_id', conversation.id)
      .order('sent_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(500),
    // And what arrived most recently HERE, whatever time it carries: a message
    // written earlier that arrived late sorts below the newest page, and would
    // otherwise never reach the reader at all.
    supabase.from('builder_agency_messages').select(columns)
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50),
  ]);
  if (newestError || arrivedError) return { ok: false, reason: 'unavailable' };
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(newest ?? []), ...(arrived ?? [])] as Record<string, unknown>[]) byId.set(String(row.id), row);

  return {
    ok: true,
    conversation_id: String(conversation.id),
    open,
    messages: projectAgencyMessages([...byId.values()], args.viewerUserId),
  };
}
