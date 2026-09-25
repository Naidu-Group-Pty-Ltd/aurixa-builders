/**
 * AGENCY MESSAGES — WHAT A BUILDER IS SHOWN OF A CONVERSATION.
 *
 * The rows are written by `builder_agency_post_message` and by the message
 * sweep (`20260925180000_an_agency_and_a_builder_talk_over_the_network.sql`).
 * This decides what of them reaches a browser: the sender's display name and
 * side, the body, when it was written, and — for what this side sent — its
 * delivery state. Never a user id and never the client's idempotency key.
 *
 * Order is the writing side's server clock, then the id: the same order the
 * Command Centre draws, so both ends read one conversation the same way.
 *
 * Pure: no IO.
 */

export type AgencyMessageSide = 'builder' | 'command_centre';
export type AgencyDeliveryState = 'queued' | 'delivered' | 'failed';

export interface AgencyMessageView {
  id: string;
  side: AgencyMessageSide;
  sender_display_name: string;
  body: string;
  sent_at: string;
  /** Only for what this side sent; the other side's messages carry none. */
  delivery_state: AgencyDeliveryState | null;
  delivered_at: string | null;
  failure_reason: string | null;
  /** Written by the person reading. */
  mine: boolean;
  can_retry: boolean;
}

type Row = Record<string, unknown>;

export function projectAgencyMessages(rows: readonly Row[], viewerUserId: string): AgencyMessageView[] {
  return rows
    .map((row) => {
      const side = row.side === 'builder' ? 'builder' : 'command_centre';
      const mine = side === 'builder' && row.sender_builder_user_id === viewerUserId;
      const state = side === 'builder' ? (row.delivery_state as AgencyDeliveryState | null) ?? null : null;
      return {
        id: String(row.id),
        side,
        sender_display_name: String(row.sender_display_name ?? ''),
        body: String(row.body ?? ''),
        sent_at: String(row.sent_at),
        delivery_state: state,
        delivered_at: side === 'builder' ? (row.delivered_at as string | null) ?? null : null,
        failure_reason: side === 'builder' ? (row.failure_reason as string | null) ?? null : null,
        mine,
        can_retry: mine && state === 'failed',
      } satisfies AgencyMessageView;
    })
    .sort((a, b) => (a.sent_at === b.sent_at ? (a.id < b.id ? -1 : 1) : (a.sent_at < b.sent_at ? -1 : 1)));
}

/** A refusal raised by the SQL, as the browser is told it — or null for a fault of ours. */
export function agencyMessageRefusal(message: string): { status: number; code: string; error: string } | null {
  const table: Array<[string, number, string, string]> = [
    ['AGENCY_CONVERSATION_NOT_FOUND', 404, 'not_found', 'That conversation was not found.'],
    ['AGENCY_CONVERSATION_NOT_OPEN', 409, 'conversation_not_open', 'This property is no longer activated by that agency, so the conversation is closed.'],
    ['AGENCY_MESSAGE_INVALID', 400, 'invalid_message', 'A message needs between 1 and 4,000 characters.'],
    ['AGENCY_MESSAGE_NOT_RETRYABLE', 409, 'not_retryable', 'Only a message you sent that was not delivered can be sent again.'],
    ['AGENCY_SENDER_NOT_A_MEMBER', 403, 'not_a_member', 'You are not a member of this organisation.'],
    ['AGENCY_MESSAGE_ID_REUSED', 409, 'message_id_reused', 'That message was already sent to a different conversation.'],
  ];
  for (const [raw, status, code, error] of table) {
    if (message.includes(raw)) return { status, code, error };
  }
  return null;
}
