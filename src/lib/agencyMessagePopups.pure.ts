/**
 * The portal's "New message from <agency>" popup, as words and a destination.
 *
 * The server answers which messages an agency wrote after a cursor, in the
 * reader's own conversations (`list_new_agency_messages`). This module turns
 * each into what the popup says and where it leads, and decides the two
 * questions the component asks of every answer — is the reader already
 * looking at that conversation, and has the poll been refused — so the
 * wording, the link and the rules are tested without a browser.
 *
 * It is the builder-side counterpart of the Command Centre's
 * `builderMessagePopups.pure.ts`: the same shape of popup, the other side.
 */
import type { NewAgencyMessage } from '../../supabase/functions/_shared/builderStock/agencyMessages.pure';
import { MESSAGES_PATH, messagesViewFrom } from './builderAgency';

export type { NewAgencyMessage };

export interface AgencyMessagePopup {
  id: string;
  title: string;
  description: string;
  href: string;
}

/** Where an agency conversation opens: Messages, its agency tab, that thread. */
export function agencyConversationHref(conversationId: string): string {
  const params = new URLSearchParams({ view: 'agencies', thread: conversationId });
  return `${MESSAGES_PATH}?${params.toString()}`;
}

export function agencyMessagePopup(message: NewAgencyMessage): AgencyMessagePopup {
  const agency = message.agency_name?.trim() || 'an agency';
  const property = [message.lot_number ? `Lot ${message.lot_number}` : null, message.address]
    .filter(Boolean).join(', ');
  const sender = message.sender_display_name?.trim();
  return {
    id: message.message_id,
    title: `New message from ${agency}`,
    description: [sender, property].filter(Boolean).join(' · ') || 'Open the conversation to read it.',
    href: agencyConversationHref(message.conversation_id),
  };
}

/**
 * How often an open, visible portal asks for new agency messages. The same
 * read tells an open conversation to re-read itself, so this is also how soon
 * a message appears in a thread that is already on screen.
 */
export const AGENCY_MESSAGE_POPUP_POLL_MS = 5_000;

/**
 * How often a portal nobody is looking at — another tab, another window,
 * minimised — still asks. It used to ask nothing at all, so an agency that
 * wrote while the builder was elsewhere reached them only when they came
 * back. Slower than a visible tab, because the browser throttles a hidden
 * tab's timers anyway; quick enough that the desktop notification and the
 * count on the tab arrive within half a minute.
 */
export const AGENCY_MESSAGE_BACKGROUND_POLL_MS = 30_000;

/** What one conversation received in one check, oldest first. */
export interface AgencyConversationArrival {
  conversationId: string;
  messages: NewAgencyMessage[];
  latest: NewAgencyMessage;
}

const arrivedAt = (message: NewAgencyMessage) => String(message.received_at ?? '');
const byArrival = (a: NewAgencyMessage, b: NewAgencyMessage) =>
  (arrivedAt(a) < arrivedAt(b) ? -1 : arrivedAt(a) > arrivedAt(b) ? 1 : 0);

/**
 * One entry per conversation, in the order their latest message arrived: a
 * conversation that received three messages is told once, as three — not as
 * three pop-ups stacked over each other.
 */
export function groupAgencyMessages(messages: readonly NewAgencyMessage[]): AgencyConversationArrival[] {
  const byConversation = new Map<string, NewAgencyMessage[]>();
  for (const message of messages) {
    byConversation.set(message.conversation_id, [...(byConversation.get(message.conversation_id) ?? []), message]);
  }
  return [...byConversation.entries()]
    .map(([conversationId, list]) => {
      const ordered = [...list].sort(byArrival);
      return { conversationId, messages: ordered, latest: ordered[ordered.length - 1] };
    })
    .sort((a, b) => byArrival(a.latest, b.latest));
}

/**
 * The pop-up for everything one conversation received. Its id is the
 * conversation's, so a later message replaces the pop-up rather than stacking
 * a second one under it.
 */
export function agencyConversationPopup(messages: readonly NewAgencyMessage[]): AgencyMessagePopup {
  const latest = messages[messages.length - 1];
  const popup = agencyMessagePopup(latest);
  if (messages.length <= 1) return { ...popup, id: latest.conversation_id };
  const agency = latest.agency_name?.trim() || 'an agency';
  return { ...popup, id: latest.conversation_id, title: `${messages.length} new messages from ${agency}` };
}

/**
 * The keys the once-per-person ledger records a conversation under: one for
 * the desktop notification, one for the pop-up shown on coming back.
 */
export const agencyAlertKey = (conversationId: string) => `agency-message:${conversationId}`;
export const agencyCatchUpKey = (conversationId: string) => `agency-message-shown:${conversationId}`;

/**
 * Whether the reader is already looking at the conversation a message arrived
 * in. Then the thread re-reads itself at once and no popup is raised over it.
 */
export function isViewingAgencyConversation(
  location: { pathname: string; search: string }, conversationId: string,
): boolean {
  if (location.pathname !== MESSAGES_PATH) return false;
  const params = new URLSearchParams(location.search);
  return messagesViewFrom(params) === 'agencies' && params.get('thread') === conversationId;
}

/**
 * A refusal the next poll would get too ends the polling: signed out or
 * access withdrawn (401, 403), or this tab now showing a different
 * organisation than the session names (409 `organisation_context_changed`).
 * Anything else — a 5xx, a network failure — is asked again next time, from
 * the same cursor.
 */
export function agencyMessagePollingRefused(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 409;
}
