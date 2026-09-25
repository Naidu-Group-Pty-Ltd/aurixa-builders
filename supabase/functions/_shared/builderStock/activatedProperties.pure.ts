/**
 * ACTIVATED PROPERTIES — THE BUILDER'S VIEW OF WHAT AN AGENCY ACTIVATED.
 *
 * There is no activation model here. The activation IS the row the signed
 * network sweep converges into `builder_stock_selection_announcements`; this
 * module only decides what of that row, and of the property it names, a
 * builder is shown on the Agencies page.
 *
 * WHAT CROSSES AND WHAT DOES NOT. The announcement carries two columns this
 * projection deliberately never reads:
 *
 *  * `remote_client_label` — a client label the Command Centre was allowed to
 *    send and, as its producer records, has never sent. Showing it would make
 *    the page a channel for client identity the day somebody starts sending
 *    it. The builder learns WHICH AGENCY activated a property, not for whom.
 *  * `remote_selection_ref` — the Command Centre's own selection id. It is the
 *    network's idempotency key, not something a person needs.
 *
 * What the builder does learn is the agency's self-disclosure (its name, its
 * workspace's directory name, and the outward contact of the person who
 * activated), the acknowledgement, and the property itself.
 *
 * THE ORGANISATION IS RE-CHECKED HERE, not trusted from the query. Every read
 * that feeds this is already pinned to the session's organisation; a row that
 * arrives anyway is dropped, and a property or photograph of another
 * organisation never decorates this one's activation.
 *
 * Pure: no IO.
 */

/** The announcement columns this view reads — and, by omission, the two it does not. */
export const ACTIVATED_PROPERTY_ANNOUNCEMENT_SELECT = `
  id, connection_id, stock_item_id, organisation_id, status,
  acknowledged_at, acknowledged_by_builder_user_id,
  agency_name, agency_contact, activation_project_id,
  created_at, updated_at
`;

/** The property facts an activation is shown with. */
export const ACTIVATED_PROPERTY_ITEM_SELECT = `
  id, organisation_id, lot_number, unit_number, address_line, suburb, state, postcode,
  development_name, project_name, external_reference, primary_image_id,
  house_design:source_row->>house_design
`;

export type ActivationStatus =
  | 'selected' | 'builder_acknowledged' | 'progressed' | 'completed' | 'withdrawn';

export interface ActivatedPropertyAgency {
  /** The agency's own name, as its activation disclosed it. */
  name: string | null;
  /** The connected workspace's directory name. */
  workspace_label: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface ActivatedPropertyFacts {
  lot_number: string | null;
  unit_number: string | null;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  development_name: string | null;
  house_design: string | null;
  external_reference: string | null;
}

export interface ActivatedProperty {
  id: string;
  connection_id: string;
  stock_item_id: string;
  status: ActivationStatus;
  activated_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  /** The builder colleague who acknowledged it — a name, never an id. */
  acknowledged_by_name: string | null;
  agency: ActivatedPropertyAgency;
  property: ActivatedPropertyFacts | null;
  /** The property's elected photograph row, or null. Drawn by the Stock List's own rule. */
  primary_image: Record<string, unknown> | null;
  /** The project the activation opened, and whether THIS user may open it. */
  project: { id: string; accessible: boolean } | null;
}

type Row = Record<string, unknown>;

const text = (value: unknown, max = 320): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned || null;
};

const STATUSES: readonly ActivationStatus[] = [
  'selected', 'builder_acknowledged', 'progressed', 'completed', 'withdrawn',
];

export function projectActivatedProperties(input: {
  organisationId: string;
  announcements: readonly Row[];
  items: readonly Row[];
  images: readonly Row[];
  workspaceLabelByConnection: ReadonlyMap<string, string | null>;
  acknowledgerNameById: ReadonlyMap<string, string | null>;
  accessibleProjectIds: ReadonlySet<string>;
}): ActivatedProperty[] {
  const items = new Map<string, Row>();
  for (const item of input.items) {
    if (item.organisation_id === input.organisationId) items.set(String(item.id), item);
  }
  const images = new Map<string, Row>();
  for (const image of input.images) images.set(String(image.id), image);

  const records: ActivatedProperty[] = [];
  for (const row of input.announcements) {
    if (row.organisation_id !== input.organisationId) continue;
    const status = String(row.status) as ActivationStatus;
    if (!STATUSES.includes(status)) continue;

    const item = items.get(String(row.stock_item_id)) ?? null;
    const imageRow = item?.primary_image_id ? images.get(String(item.primary_image_id)) ?? null : null;
    // A photograph belongs to the property it is filed under, or it is not shown.
    const image = imageRow && item && imageRow.stock_item_id === item.id ? imageRow : null;

    const contact = (row.agency_contact && typeof row.agency_contact === 'object'
      ? row.agency_contact : {}) as Row;
    const projectId = text(row.activation_project_id, 64);
    const acknowledgedBy = text(row.acknowledged_by_builder_user_id, 64);

    records.push({
      id: String(row.id),
      connection_id: String(row.connection_id),
      stock_item_id: String(row.stock_item_id),
      status,
      activated_at: String(row.created_at),
      updated_at: String(row.updated_at ?? row.created_at),
      acknowledged_at: text(row.acknowledged_at, 64),
      acknowledged_by_name: acknowledgedBy
        ? input.acknowledgerNameById.get(acknowledgedBy) ?? null
        : null,
      agency: {
        name: text(row.agency_name, 200),
        workspace_label: input.workspaceLabelByConnection.get(String(row.connection_id)) ?? null,
        contact_name: text(contact.contact_name, 200),
        contact_email: text(contact.contact_email, 320),
        contact_phone: text(contact.contact_phone, 60),
      },
      property: item ? {
        lot_number: text(item.lot_number, 40),
        unit_number: text(item.unit_number, 40),
        address_line: text(item.address_line, 200),
        suburb: text(item.suburb, 120),
        state: text(item.state, 20),
        postcode: text(item.postcode, 10),
        development_name: text(item.development_name, 200) ?? text(item.project_name, 200),
        house_design: text(item.house_design, 200),
        external_reference: text(item.external_reference, 120),
      } : null,
      primary_image: image ? { ...image } : null,
      project: projectId
        ? { id: projectId, accessible: input.accessibleProjectIds.has(projectId) }
        : null,
    });
  }

  // Newest activation first; the id settles a tie so the order never flickers.
  return records.sort((a, b) =>
    a.activated_at === b.activated_at
      ? (a.id < b.id ? 1 : -1)
      : (a.activated_at < b.activated_at ? 1 : -1));
}
