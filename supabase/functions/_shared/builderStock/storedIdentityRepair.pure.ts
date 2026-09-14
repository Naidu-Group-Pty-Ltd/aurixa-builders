/**
 * BUILDER STOCK — WHAT WAS ALREADY WRITTEN DOWN STILL HAS TO RECOVER.
 *
 * Improving the header alias table fixes the NEXT import. It does nothing for
 * the properties already in the table — and asking a builder to upload their
 * list again to pick up a mapping improvement is asking them to fix this
 * product's record-keeping by hand, which is a rule this repository has
 * settled twice already.
 *
 * Every source stores its own row on the property, so the repair is the same
 * question asked again: re-read the raw columns the import could not place,
 * map them through the CURRENT alias table, and fill what is still empty.
 * Source-agnostic by construction — a Notion row, a CSV row and a spreadsheet
 * row all arrive here as the same stored record.
 *
 * IT ONLY EVER FILLS, AND IT SYNTHESISES NOTHING. A field the import resolved
 * is never rewritten, because the builder's own value wins over anything
 * derived; and every value it writes came out of a column the builder
 * supplied. A repair that could overwrite would be a second, quieter importer.
 *
 * Pure: no IO, no clock, no network.
 */
import { fieldForHeader } from './normalise.pure.ts';
import type { ComposableIdentity } from './canonicalIdentity.pure.ts';

/** The identity fields a stored row may be repaired into. */
const REPAIRABLE = ['suburb', 'state', 'postcode', 'address_line',
  'development_name', 'project_name'] as const;

export interface StoredIdentityRepair {
  patch: Partial<ComposableIdentity>;
  /** Which fields were recovered. Diagnostics, never a rule. */
  recovered: string[];
}

export function repairStoredIdentity(
  item: Partial<ComposableIdentity>,
  /** The record the import persisted, including the columns it could not map. */
  sourceRow: Record<string, unknown> | null | undefined,
): StoredIdentityRepair {
  const patch: Partial<ComposableIdentity> = {};
  const recovered: string[] = [];

  const unmapped = (sourceRow ?? {}).unmapped;
  if (!unmapped || typeof unmapped !== 'object' || Array.isArray(unmapped)) {
    return { patch, recovered };
  }

  for (const [header, value] of Object.entries(unmapped as Record<string, unknown>)) {
    const field = fieldForHeader(header);
    if (!field || !(REPAIRABLE as readonly string[]).includes(field)) continue;
    // Only where the import left it empty. Never over the builder's own value.
    if (clean((item as Record<string, unknown>)[field] as string | null)) continue;
    if (clean((patch as Record<string, unknown>)[field] as string | null)) continue;
    const text = clean(String(value ?? ''));
    if (!text) continue;
    (patch as Record<string, unknown>)[field] = text;
    recovered.push(field);
  }

  return { patch, recovered };
}

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}
