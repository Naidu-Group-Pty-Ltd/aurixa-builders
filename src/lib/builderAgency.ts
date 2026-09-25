/**
 * Builder Portal — the Agencies area.
 *
 * An agency here is a connected Command Centre workspace. What a builder knows
 * of one comes entirely from its activations of their stock, read by
 * `list_activated_properties`; this module shapes that for the two tabs.
 *
 * A conversation is keyed by the connection and the property, the relationship
 * the network carries it over. The thread list is built from the
 * organisation's own activations; each thread's messages are read by
 * `get_agency_conversation`, polled while it is open. Nothing is invented to
 * fill a thread.
 */
import type {
  ActivatedProperty,
  ActivatedPropertyAgency,
  ActivatedPropertyFacts,
  ActivationStatus,
} from '../../supabase/functions/_shared/builderStock/activatedProperties.pure';

import type {
  AgencyDeliveryState,
  AgencyMessageView,
} from '../../supabase/functions/_shared/builderStock/agencyMessages.pure';

export type { ActivatedProperty, ActivatedPropertyAgency, ActivatedPropertyFacts, ActivationStatus };
export type { AgencyDeliveryState, AgencyMessageView };

/** A conversation as the Messages tab reads it. */
export interface AgencyConversation {
  conversation_id: string | null;
  /** False once the agency has withdrawn the activation: history stays, writing stops. */
  open: boolean;
  can_send: boolean;
  messages: AgencyMessageView[];
}

/**
 * The key that makes a send idempotent. Minted once per message the person
 * writes and reused for every retry of that same send, so a lost response or a
 * double click can never create a second message.
 */
export function newClientMessageId(): string {
  return crypto.randomUUID();
}

const OUTBOUND_LABELS: Record<AgencyDeliveryState, string> = {
  queued: 'Sending',
  delivered: 'Delivered',
  failed: 'Not delivered',
};

/**
 * `confirmation_timeout` is not a refusal: the message reached the other side
 * and no receipt came back in time, so the other side may well hold it. It is
 * named as unconfirmed, never as "not delivered".
 */
export function outboundStateLabel(state: AgencyDeliveryState, failureReason?: string | null): string {
  if (state === 'failed' && failureReason === 'confirmation_timeout') return 'Not confirmed';
  return OUTBOUND_LABELS[state];
}

/** How often an open conversation re-reads itself. Polling is the transport's floor. */
export const AGENCY_CONVERSATION_POLL_MS = 10_000;

/**
 * An open conversation is re-read every few seconds; a closed one (withdrawn
 * activation, revoked connection) is history and is not re-read at all. Before
 * the first answer it polls, because it cannot yet know.
 */
export function agencyConversationPollInterval(data: { open?: boolean } | undefined): number | false {
  return data?.open === false ? false : AGENCY_CONVERSATION_POLL_MS;
}

/**
 * Every page of a paginated list, in order, bounded so that a server claiming
 * a million pages cannot keep the browser asking.
 */
export async function collectEveryPage<T>(
  fetchPage: (page: number) => Promise<{ records: T[]; pagination: { total_pages: number } }>,
  maxPages = 40,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { records, pagination } = await fetchPage(page);
    all.push(...records);
    if (page >= pagination.total_pages || records.length === 0) break;
  }
  return all;
}

export const AGENCIES_PATH = '/builder/agencies';
export const AGENCY_TABS = ['activations', 'messages'] as const;
export type AgencyTab = typeof AGENCY_TABS[number];

export function agencyTabFrom(value: string | undefined): AgencyTab {
  return (AGENCY_TABS as readonly string[]).includes(value ?? '')
    ? value as AgencyTab
    : 'activations';
}

/** The agency as a person reads it: its own name, else its workspace's. */
export function agencyLabel(agency: ActivatedPropertyAgency): string {
  return agency.name || agency.workspace_label || 'A connected agency';
}

/** "Lot 101, 1 Example Street" — the property as the Stock List names it. */
export function activatedPropertyTitle(property: ActivatedPropertyFacts | null): string {
  if (!property) return 'Property no longer in your stock list';
  const parts = [
    property.lot_number ? `Lot ${property.lot_number}` : '',
    property.unit_number ? `Unit ${property.unit_number}` : '',
    property.address_line ?? '',
  ].map((part) => part.trim()).filter(Boolean);
  return parts.join(', ') || property.development_name || 'Untitled property';
}

export function activatedPropertyLocality(property: ActivatedPropertyFacts | null): string {
  if (!property) return '';
  return [property.development_name, property.suburb, property.state, property.postcode]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(' · ');
}

export interface AgencyThread {
  key: string;
  connection_id: string;
  stock_item_id: string;
  agency: ActivatedPropertyAgency;
  property: ActivatedPropertyFacts | null;
  /** The latest activation of this property by this agency. */
  activation: ActivatedProperty;
}

export function agencyThreadKey(a: { connection_id: string; stock_item_id: string }): string {
  return `${a.connection_id}:${a.stock_item_id}`;
}

/**
 * One conversation per agency and property. The input is already the
 * organisation's own activations, so nothing another builder holds can
 * appear; a repeated activation of the same property by the same agency is
 * the same conversation, represented by its latest activation.
 */
export function agencyThreadsFrom(records: readonly ActivatedProperty[]): AgencyThread[] {
  const latest = new Map<string, ActivatedProperty>();
  for (const record of records) {
    const key = agencyThreadKey(record);
    const held = latest.get(key);
    if (!held || record.activated_at > held.activated_at
      || (record.activated_at === held.activated_at && record.id > held.id)) {
      latest.set(key, record);
    }
  }
  return Array.from(latest.entries())
    .map(([key, activation]) => ({
      key,
      connection_id: activation.connection_id,
      stock_item_id: activation.stock_item_id,
      agency: activation.agency,
      property: activation.property,
      activation,
    }))
    .sort((a, b) =>
      a.activation.activated_at === b.activation.activated_at
        ? (a.key < b.key ? -1 : 1)
        : (a.activation.activated_at < b.activation.activated_at ? 1 : -1));
}
