/**
 * Builder Portal — the Agencies area.
 *
 * An agency here is a connected Command Centre workspace. What a builder knows
 * of one comes entirely from its activations of their stock, read by
 * `list_activated_properties`; this module shapes that for the two tabs.
 *
 * THE MESSAGES SHELL HAS NO TRANSPORT YET. A conversation is keyed by the
 * connection and the property — the relationship it will belong to once
 * messaging is carried over the network — and every thread here is empty and
 * says so (`transport: 'not_connected'`). Nothing is invented to fill it.
 */
import type {
  ActivatedProperty,
  ActivatedPropertyAgency,
  ActivatedPropertyFacts,
  ActivationStatus,
} from '../../supabase/functions/_shared/builderStock/activatedProperties.pure';

export type { ActivatedProperty, ActivatedPropertyAgency, ActivatedPropertyFacts, ActivationStatus };

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
  /** Empty until messaging is carried over the network. Never invented. */
  messages: readonly never[];
  transport: 'not_connected';
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
      messages: [] as const,
      transport: 'not_connected' as const,
    }))
    .sort((a, b) =>
      a.activation.activated_at === b.activation.activated_at
        ? (a.key < b.key ? -1 : 1)
        : (a.activation.activated_at < b.activation.activated_at ? 1 : -1));
}
