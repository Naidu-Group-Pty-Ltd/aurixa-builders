/**
 * Builder transaction domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderTransactions.ts` on the
 * edge side — keep the two in step, exactly as `src/lib/builderInventory.ts`
 * mirrors `_shared/builderInventory.ts`.
 *
 * DATA BOUNDARY: no type here carries a cost, margin, supplier price, contractor
 * price or commission. The purchaser is carried by name and contact only; no
 * client financial position is reachable from this module.
 */

export type BuilderTransactionType =
  | 'off_the_plan' | 'house_and_land' | 'established' | 'land_only'
  | 'build_only' | 'knockdown_rebuild' | 'other';

export type BuilderTransactionStatus =
  | 'lead' | 'reserved' | 'contract_issued' | 'contract_signed' | 'unconditional'
  | 'construction' | 'practical_completion' | 'settled' | 'cancelled' | 'lapsed';

export type BuilderTransactionPartyRole =
  | 'purchaser' | 'purchaser_solicitor' | 'vendor' | 'vendor_solicitor'
  | 'sales_agent' | 'broker' | 'guarantor' | 'other';

export interface BuilderTransaction {
  id: string;
  project_id: string;
  unit_id: string | null;
  organisation_id: string;
  client_id: string | null;
  transaction_reference: string | null;
  transaction_type: BuilderTransactionType;
  status: BuilderTransactionStatus;
  purchaser_name: string | null;
  purchaser_email: string | null;
  purchaser_phone: string | null;
  contract_price: number | null;
  deposit_amount: number | null;
  deposit_received: boolean;
  contract_issued_date: string | null;
  contract_signed_date: string | null;
  unconditional_date: string | null;
  sunset_date: string | null;
  estimated_settlement_date: string | null;
  actual_settlement_date: string | null;
  shared_summary: string | null;
  risk_flag: boolean;
  row_version: number;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only on the authenticated detail contract. */
  builder_notes?: string | null;
  risk_notes?: string | null;
}

export interface BuilderTransactionParty {
  id: string;
  transaction_id: string;
  role: BuilderTransactionPartyRole;
  name: string;
  organisation: string | null;
  email: string | null;
  phone: string | null;
  reference: string | null;
  is_primary_contact: boolean;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderTransactionHistoryEntry {
  id: string;
  from_status: BuilderTransactionStatus | null;
  to_status: BuilderTransactionStatus;
  changed_by_type: string;
  reason: string | null;
  created_at: string;
}

export interface BuilderPipelineStage {
  status: BuilderTransactionStatus;
  stage_key: string;
  stage_label: string;
  stage_order: number;
  is_terminal: boolean;
}

export interface BuilderPipelineColumn {
  stage_key: string;
  stage_label: string;
  stage_order: number;
  is_terminal: boolean;
  records: BuilderTransaction[];
}

/**
 * The case link as the Builder audience sees it: that a case exists and which
 * slot this transaction fills. Nothing from the Legal matter, the Finance file
 * or the client deal is carried.
 */
export interface BuilderCaseLink {
  id: string;
  case_id: string;
  builder_transaction_id: string | null;
  link_source: string;
  linked_at: string;
}

export const TRANSACTION_STATUS_ORDER: BuilderTransactionStatus[] = [
  'lead', 'reserved', 'contract_issued', 'contract_signed', 'unconditional',
  'construction', 'practical_completion', 'settled', 'cancelled', 'lapsed',
];

export const TRANSACTION_STATUS_LABELS: Record<BuilderTransactionStatus, string> = {
  lead: 'Lead',
  reserved: 'Reserved',
  contract_issued: 'Contract issued',
  contract_signed: 'Contract signed',
  unconditional: 'Unconditional',
  construction: 'Construction',
  practical_completion: 'Practical completion',
  settled: 'Settled',
  cancelled: 'Cancelled',
  lapsed: 'Lapsed',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const TRANSACTION_STATUS_CLASSES: Record<BuilderTransactionStatus, string> = {
  lead: 'border-border text-muted-foreground',
  reserved: 'border-accent/60 text-accent',
  contract_issued: 'border-primary/40 text-primary',
  contract_signed: 'border-primary/50 text-primary',
  unconditional: 'border-primary/60 text-primary',
  construction: 'border-primary/60 text-primary',
  practical_completion: 'border-accent/60 text-accent',
  settled: 'border-border text-muted-foreground',
  cancelled: 'border-destructive/60 text-destructive',
  lapsed: 'border-destructive/40 text-destructive',
};

export const TRANSACTION_TYPE_LABELS: Record<BuilderTransactionType, string> = {
  off_the_plan: 'Off the plan',
  house_and_land: 'House & land',
  established: 'Established',
  land_only: 'Land only',
  build_only: 'Build only',
  knockdown_rebuild: 'Knockdown rebuild',
  other: 'Other',
};

export const TRANSACTION_PARTY_ROLE_LABELS: Record<BuilderTransactionPartyRole, string> = {
  purchaser: 'Purchaser',
  purchaser_solicitor: "Purchaser's solicitor",
  vendor: 'Vendor',
  vendor_solicitor: "Vendor's solicitor",
  sales_agent: 'Sales agent',
  broker: 'Broker',
  guarantor: 'Guarantor',
  other: 'Other',
};

/**
 * Which transitions the portal offers. Mirrors
 * `builder_is_transaction_transition_allowed`; the database is the authority and
 * rejects anything this list gets wrong.
 */
export function allowedTransactionTransitions(
  from: BuilderTransactionStatus,
): BuilderTransactionStatus[] {
  const terminal: BuilderTransactionStatus[] = ['cancelled', 'lapsed'];
  switch (from) {
    case 'settled': case 'cancelled': case 'lapsed': return [];
    case 'lead': return ['reserved', 'contract_issued', ...terminal];
    case 'reserved': return ['contract_issued', 'lead', ...terminal];
    case 'contract_issued': return ['contract_signed', 'reserved', ...terminal];
    case 'contract_signed': return ['unconditional', 'contract_issued', ...terminal];
    case 'unconditional': return ['construction', 'practical_completion', 'settled', ...terminal];
    case 'construction': return ['practical_completion', 'unconditional', ...terminal];
    case 'practical_completion': return ['settled', 'construction', ...terminal];
    default: return [];
  }
}

export function formatTransactionDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-AU') : '—';
}

export function formatTransactionMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
  }).format(Number(value));
}

/** Days until a date, rendered the way the project list renders a countdown. */
export function sunsetCountdown(value: string | null | undefined): string | null {
  if (!value) return null;
  const target = new Date(value);
  if (!Number.isFinite(target.getTime())) return null;
  const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'Sunset today';
  return days > 0
    ? `Sunset in ${days} day${days === 1 ? '' : 's'}`
    : `Sunset passed ${Math.abs(days)} day${days === -1 ? '' : 's'} ago`;
}
