/**
 * Builder inventory domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderInventory.ts` on the
 * edge side — keep the two in step, exactly as `src/lib/builderProjects.ts`
 * mirrors `_shared/builderProjects.ts`.
 *
 * DATA BOUNDARY: no type here carries a build cost, margin, supplier price or
 * contractor price. The customer-facing list price is the only commercial
 * figure the inventory contract exposes.
 */

export type BuilderUnitType =
  | 'house' | 'townhouse' | 'apartment' | 'duplex' | 'land' | 'terrace' | 'other';

export type BuilderAvailabilityStatus =
  | 'available' | 'on_hold' | 'reserved' | 'contracted' | 'settled' | 'withdrawn';

export type BuilderReleaseStatus = 'unreleased' | 'coming_soon' | 'released' | 'sold_out';

export type BuilderStageStatus =
  | 'planned' | 'released' | 'under_construction' | 'completed' | 'on_hold' | 'cancelled';

export type BuilderLotStatus = 'planned' | 'registered' | 'titled' | 'settled' | 'withdrawn';

export type BuilderPriceBasis = 'fixed' | 'from' | 'indicative' | 'on_application';

export type BuilderReservationStatus =
  | 'active' | 'contracted' | 'cancelled' | 'expired' | 'lapsed';

export type BuilderAllocationType =
  | 'sales_channel' | 'display' | 'staff' | 'investor' | 'other';

export interface BuilderUnit {
  id: string;
  project_id: string;
  stage_id: string | null;
  building_id: string | null;
  lot_id: string | null;
  unit_number: string;
  unit_type: BuilderUnitType;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  internal_area_sqm: number | null;
  external_area_sqm: number | null;
  level_number: number | null;
  aspect: string | null;
  availability_status: BuilderAvailabilityStatus;
  release_status: BuilderReleaseStatus;
  released_at: string | null;
  estimated_completion_date: string | null;
  description: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
  /** Joined by the list endpoint from the current pricing row. */
  list_price?: number | null;
  price_basis?: BuilderPriceBasis | null;
}

export interface BuilderStage {
  id: string;
  project_id: string;
  name: string;
  stage_number: string | null;
  description: string | null;
  status: BuilderStageStatus;
  estimated_completion_date: string | null;
  actual_completion_date: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderBuilding {
  id: string;
  project_id: string;
  stage_id: string | null;
  name: string;
  building_code: string | null;
  level_count: number | null;
  status: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderLot {
  id: string;
  project_id: string;
  stage_id: string | null;
  lot_number: string;
  plan_number: string | null;
  land_area_sqm: number | null;
  frontage_m: number | null;
  titled: boolean;
  titled_at: string | null;
  status: BuilderLotStatus;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderUnitPrice {
  id: string;
  unit_id: string;
  list_price: number;
  price_basis: BuilderPriceBasis;
  effective_from: string;
  effective_to: string | null;
  is_current: boolean;
  reason: string | null;
  row_version: number;
  created_at: string;
}

export interface BuilderUnitHold {
  id: string;
  unit_id: string;
  organisation_id: string;
  held_by_builder_user_id: string | null;
  hold_reference: string | null;
  reason: string | null;
  expires_at: string;
  status: 'active' | 'released' | 'expired' | 'converted';
  released_at: string | null;
  released_reason: string | null;
  row_version: number;
  created_at: string;
}

export interface BuilderReservation {
  id: string;
  unit_id: string;
  organisation_id: string;
  reservation_reference: string | null;
  purchaser_name: string;
  purchaser_email: string | null;
  purchaser_phone: string | null;
  reserved_by_builder_user_id: string | null;
  reservation_fee: number | null;
  reserved_at: string;
  expires_at: string | null;
  status: BuilderReservationStatus;
  cancelled_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderAllocation {
  id: string;
  unit_id: string;
  allocated_to_organisation_id: string;
  allocation_type: BuilderAllocationType;
  reference: string | null;
  expires_at: string | null;
  status: 'active' | 'released' | 'expired';
  released_at: string | null;
  released_reason: string | null;
  row_version: number;
  created_at: string;
}

export interface BuilderUnitHistoryEntry {
  id: string;
  status_kind: 'availability' | 'release';
  from_status: string | null;
  to_status: string;
  changed_by_type: string;
  reason: string | null;
  created_at: string;
}

export const AVAILABILITY_STATUS_ORDER: BuilderAvailabilityStatus[] = [
  'available', 'on_hold', 'reserved', 'contracted', 'settled', 'withdrawn',
];

export const AVAILABILITY_STATUS_LABELS: Record<BuilderAvailabilityStatus, string> = {
  available: 'Available',
  on_hold: 'On hold',
  reserved: 'Reserved',
  contracted: 'Contracted',
  settled: 'Settled',
  withdrawn: 'Withdrawn',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const AVAILABILITY_STATUS_CLASSES: Record<BuilderAvailabilityStatus, string> = {
  available: 'border-primary/50 text-primary',
  on_hold: 'border-accent/60 text-accent',
  reserved: 'border-accent/60 text-accent',
  contracted: 'border-primary/60 text-primary',
  settled: 'border-border text-muted-foreground',
  withdrawn: 'border-destructive/50 text-destructive',
};

export const RELEASE_STATUS_ORDER: BuilderReleaseStatus[] = [
  'unreleased', 'coming_soon', 'released', 'sold_out',
];

export const RELEASE_STATUS_LABELS: Record<BuilderReleaseStatus, string> = {
  unreleased: 'Unreleased',
  coming_soon: 'Coming soon',
  released: 'Released',
  sold_out: 'Sold out',
};

export const RELEASE_STATUS_CLASSES: Record<BuilderReleaseStatus, string> = {
  unreleased: 'border-border text-muted-foreground',
  coming_soon: 'border-accent/60 text-accent',
  released: 'border-primary/50 text-primary',
  sold_out: 'border-border text-muted-foreground',
};

export const UNIT_TYPE_LABELS: Record<BuilderUnitType, string> = {
  house: 'House',
  townhouse: 'Townhouse',
  apartment: 'Apartment',
  duplex: 'Duplex',
  land: 'Land',
  terrace: 'Terrace',
  other: 'Other',
};

export const STAGE_STATUS_LABELS: Record<BuilderStageStatus, string> = {
  planned: 'Planned',
  released: 'Released',
  under_construction: 'Under construction',
  completed: 'Completed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};

export const LOT_STATUS_LABELS: Record<BuilderLotStatus, string> = {
  planned: 'Planned',
  registered: 'Registered',
  titled: 'Titled',
  settled: 'Settled',
  withdrawn: 'Withdrawn',
};

export const PRICE_BASIS_LABELS: Record<BuilderPriceBasis, string> = {
  fixed: 'Fixed',
  from: 'From',
  indicative: 'Indicative',
  on_application: 'On application',
};

export const RESERVATION_STATUS_LABELS: Record<BuilderReservationStatus, string> = {
  active: 'Active',
  contracted: 'Contracted',
  cancelled: 'Cancelled',
  expired: 'Expired',
  lapsed: 'Lapsed',
};

export const RESERVATION_STATUS_CLASSES: Record<BuilderReservationStatus, string> = {
  active: 'border-primary/50 text-primary',
  contracted: 'border-primary/60 text-primary',
  cancelled: 'border-destructive/50 text-destructive',
  expired: 'border-border text-muted-foreground',
  lapsed: 'border-border text-muted-foreground',
};

export const ALLOCATION_TYPE_LABELS: Record<BuilderAllocationType, string> = {
  sales_channel: 'Sales channel',
  display: 'Display',
  staff: 'Staff',
  investor: 'Investor',
  other: 'Other',
};

/**
 * Which availability transitions the portal offers. Mirrors
 * `builder_is_unit_availability_transition_allowed`; the database is the
 * authority and rejects anything this list gets wrong.
 */
export function allowedAvailabilityTransitions(
  from: BuilderAvailabilityStatus,
): BuilderAvailabilityStatus[] {
  switch (from) {
    case 'settled': return [];
    case 'available': return ['on_hold', 'reserved', 'withdrawn'];
    case 'on_hold': return ['available', 'reserved', 'withdrawn'];
    case 'reserved': return ['available', 'contracted', 'withdrawn'];
    case 'contracted': return ['settled', 'available'];
    case 'withdrawn': return ['available'];
    default: return [];
  }
}

/**
 * Mirrors `builder_transition_unit_release`, which allows any release status
 * other than the current one — the marketing state is not a one-way ladder.
 * Releasing additionally requires a current price, which the database enforces.
 */
export function allowedReleaseTransitions(from: BuilderReleaseStatus): BuilderReleaseStatus[] {
  return RELEASE_STATUS_ORDER.filter((status) => status !== from);
}

/** Mirrors `builder_is_reservation_transition_allowed`. */
export function allowedReservationTransitions(
  from: BuilderReservationStatus,
): BuilderReservationStatus[] {
  return from === 'active' ? ['contracted', 'cancelled', 'expired', 'lapsed'] : [];
}

export function formatUnitArea(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Number(value).toLocaleString('en-AU')} m²`;
}

export function formatListPrice(
  price: number | null | undefined, basis?: BuilderPriceBasis | null,
): string {
  if (basis === 'on_application') return 'On application';
  if (price === null || price === undefined) return 'Not priced';
  const formatted = new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
  }).format(Number(price));
  return basis === 'from' ? `From ${formatted}` : formatted;
}

export function formatUnitConfiguration(unit: BuilderUnit): string {
  const parts: string[] = [];
  if (unit.bedrooms !== null) parts.push(`${unit.bedrooms} bed`);
  if (unit.bathrooms !== null) parts.push(`${unit.bathrooms} bath`);
  if (unit.car_spaces !== null) parts.push(`${unit.car_spaces} car`);
  return parts.length ? parts.join(' · ') : 'Configuration not recorded';
}
