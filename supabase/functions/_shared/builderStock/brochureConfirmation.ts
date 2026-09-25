/**
 * BUILDER STOCK — A BUILDER'S "THAT BROCHURE IS MINE", READ AND WRITTEN.
 *
 * The rules are `brochureConfirmation.pure.ts`; the act is two SQL functions
 * (`20260924120000_a_builder_may_say_a_brochure_is_theirs.sql`) that lock the
 * property and check the stored refusal in the same statement as they write.
 * This module is the seam between them and everything that reads a
 * confirmation: the settler, the fallback accounting, the card's picture and
 * the builder's own screen.
 *
 * THREE RULES CARRY IT.
 *
 *   A READ THAT FAILED IS NOT A PROPERTY NOBODY CONFIRMED. "None" reopens
 *   every answer a confirmation produced and takes its picture down, so a
 *   failed read is reported as a failure and the caller stops, exactly as a
 *   failed read of the organisation's stock stops a repair. The one exception
 *   is a table that does not exist yet — deployment skew, in which no
 *   confirmation can have been made, so "none" is simply true.
 *
 *   AN IMAGE REACHED UNDER A CONFIRMATION STANDS ONLY WHILE IT DOES. Undo
 *   takes the picture down in its own transaction; a slower worker that
 *   stores one after the undo is refused by the card's picture chooser
 *   (`standingUnderConfirmations`) and taken down by the next settler run
 *   (`withdrawImagesOfLapsedConfirmations`).
 *
 *   THE PRODUCT'S DECISIVE CHECK RUNS AT THE ACT. Another live listing already
 *   using the brochure's photograph for the lot it states is re-read from the
 *   database when the builder confirms, not trusted from the page they
 *   clicked on. It never refuses the builder the photograph (the owner's
 *   rule); it refuses to proceed until the builder has been TOLD, because the
 *   page's reading can miss it — a read that failed, or a listing that took
 *   the photograph after the page loaded.
 */
import {
  brochureInUseByAnotherProperty, confirmedLotOf, inUseAcknowledged, isConfirmableBranch,
  listingIdentity, type ListingReference, type StockRowForConfirmation,
} from './brochureConfirmation.pure.ts';
import {
  IDENTITY_CONFIRMATION_KEY, type IdentityConfirmationRef,
} from './negativeProvenance.pure.ts';
import type { IdentityConfirmationsByBranch } from './sourceBranches.pure.ts';
import { readAllRows } from './pagedRead.ts';

export const IDENTITY_CONFIRMATIONS_TABLE = 'builder_stock_identity_confirmations';

/** A confirmation that stands, as every reader here needs it. */
export interface StandingConfirmation {
  id: string;
  stock_item_id: string;
  document_reference: string;
  confirmed_lot: string;
  confirmed_by_name: string;
  confirmed_at: string;
}

export type StandingConfirmationsRead =
  | { ok: true; rows: StandingConfirmation[] }
  | { ok: false; error: string };

/**
 * Is this "the table is not there"?
 *
 * The codes are the ones observed on the wire, not the ones the database
 * raises: PostgREST refuses a relation missing from its schema cache before
 * any statement is planned, and answers `PGRST205`. `42P01` is kept for a
 * caller that reaches Postgres directly. Anything else is a live fault.
 */
export function isMissingConfirmationsTable(error: unknown): boolean {
  if (!error) return false;
  const record = error as { code?: unknown; message?: unknown };
  const code = String(record.code ?? '');
  if (code === 'PGRST205' || code === '42P01') return true;
  const message = String(record.message ?? '').toLowerCase();
  return message.includes(IDENTITY_CONFIRMATIONS_TABLE)
    && (message.includes('schema cache') || message.includes('does not exist'));
}

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error ?? 'unknown').slice(0, 200);
}

/**
 * The confirmations that stand for an organisation, or for some of its
 * properties. Paged, because a truncated read would read as confirmations
 * nobody made — see `pagedRead.ts`.
 */
export async function readStandingConfirmations(
  db: any,
  input: { organisationId: string; stockItemIds?: readonly string[] | null },
): Promise<StandingConfirmationsRead> {
  const ids = input.stockItemIds ? [...new Set(input.stockItemIds.filter(Boolean))] : null;
  if (ids && !ids.length) return { ok: true, rows: [] };
  const read = await readAllRows<StandingConfirmation>(() => {
    let query = db
      .from(IDENTITY_CONFIRMATIONS_TABLE)
      .select('id, stock_item_id, document_reference, confirmed_lot, confirmed_by_name, confirmed_at')
      .eq('organisation_id', input.organisationId)
      .is('withdrawn_at', null);
    if (ids) query = query.in('stock_item_id', ids);
    return query.order('confirmed_at', { ascending: true }).order('id', { ascending: true });
  });
  if (read.failed) {
    if (isMissingConfirmationsTable(read.error)) return { ok: true, rows: [] };
    return { ok: false, error: errorText(read.error) };
  }
  return { ok: true, rows: read.rows };
}

/** Standing confirmations, grouped the way the settler asks: by property, then link. */
export function confirmationsByItem(
  rows: readonly StandingConfirmation[],
): Map<string, Map<string, IdentityConfirmationRef>> {
  const byItem = new Map<string, Map<string, IdentityConfirmationRef>>();
  for (const row of rows ?? []) {
    const lot = String(row?.confirmed_lot ?? '');
    if (!row?.id || !row.stock_item_id || !row.document_reference || !/^\d{1,5}$/.test(lot)) continue;
    const byBranch = byItem.get(row.stock_item_id) ?? new Map<string, IdentityConfirmationRef>();
    byBranch.set(row.document_reference, { id: String(row.id), lot });
    byItem.set(row.stock_item_id, byBranch);
  }
  return byItem;
}

const NO_CONFIRMATIONS: IdentityConfirmationsByBranch = new Map();

/** One property's confirmations, keyed by link. Empty where there are none. */
export function confirmationsForItem(
  byItem: ReadonlyMap<string, ReadonlyMap<string, IdentityConfirmationRef>> | null | undefined,
  itemId: string,
): IdentityConfirmationsByBranch {
  return byItem?.get(itemId) ?? NO_CONFIRMATIONS;
}

/** The confirmation an image says it was reached under, if it says one. */
export function imageConfirmationStamp(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const stamp = (detail as Record<string, unknown>)[IDENTITY_CONFIRMATION_KEY] as
    { id?: unknown } | null | undefined;
  const id = stamp && typeof stamp === 'object' ? String(stamp.id ?? '').trim() : '';
  return id || null;
}

/**
 * THE IMAGES A CARD MAY STILL BE DRAWN FROM, where a confirmation is involved.
 *
 * Every image carrying no stamp is returned untouched and costs no query, so
 * for every property nobody confirmed this is the identity function. Where one
 * does carry a stamp, it stays only while that confirmation stands.
 *
 * A READ THAT FAILED DECIDES NOTHING. `unknown` tells the caller it could not
 * be checked, and the card choosers leave the card exactly as it is: keeping
 * a stamped image could show a house the builder has since said is not this
 * one, and dropping it would take a confirmed picture off the card over a
 * transient fault. The next successful read settles it either way.
 */
export async function standingUnderConfirmations<T extends { source_detail?: unknown }>(
  db: any,
  stockItemId: string,
  rows: readonly T[],
): Promise<{ rows: T[]; unknown: boolean }> {
  if (!rows.some((row) => imageConfirmationStamp(row?.source_detail))) {
    return { rows: [...rows], unknown: false };
  }
  let standing: Set<string>;
  try {
    const { data, error } = await db
      .from(IDENTITY_CONFIRMATIONS_TABLE)
      .select('id')
      .eq('stock_item_id', stockItemId)
      .is('withdrawn_at', null);
    if (error && !isMissingConfirmationsTable(error)) return { rows: [...rows], unknown: true };
    standing = new Set(((error ? [] : data ?? []) as Array<{ id?: unknown }>)
      .map((row) => String(row.id)));
  } catch {
    return { rows: [...rows], unknown: true };
  }
  return { rows: keepStanding(rows, standing), unknown: false };
}

/** The images whose stamp, if they carry one, names a confirmation that stands. */
export function keepStanding<T extends { source_detail?: unknown }>(
  rows: readonly T[],
  standingIds: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => {
    const stamp = imageConfirmationStamp(row?.source_detail);
    return !stamp || standingIds.has(stamp);
  });
}

export const LAPSED_CONFIRMATION_IMAGE_REASON = 'The builder undid their confirmation that this '
  + 'brochure is this property\'s, so the image taken from it is not shown.';

/**
 * TAKE DOWN WHAT A LAPSED CONFIRMATION LEFT BEHIND.
 *
 * Undo does this in its own transaction for everything that existed when it
 * ran. What it cannot see is an image a slower worker stored afterwards, under
 * the confirmation it read at the start of its run — so every settler run does
 * this for the properties it works, against the confirmations it read.
 *
 * Only images carrying a stamp are touched, and only where the stamp names a
 * confirmation that is not standing. Returns how many were taken down; a
 * failure is reported to the caller and never thrown.
 */
export async function withdrawImagesOfLapsedConfirmations(
  db: any,
  input: {
    organisationId: string;
    /** The properties this run works; null for the whole organisation. */
    stockItemIds: readonly string[] | null;
    standing: ReadonlyMap<string, ReadonlyMap<string, IdentityConfirmationRef>>;
  },
): Promise<{ withdrawnFrom: string[]; failed: boolean }> {
  const ids = input.stockItemIds ? [...new Set(input.stockItemIds.filter(Boolean))] : null;
  if (ids && !ids.length) return { withdrawnFrom: [], failed: false };
  let query = db
    .from('builder_stock_item_images')
    .select('id, stock_item_id, source_detail')
    .eq('organisation_id', input.organisationId)
    .neq('processing_status', 'unavailable')
    .not(`source_detail->${IDENTITY_CONFIRMATION_KEY}`, 'is', null);
  if (ids) query = query.in('stock_item_id', ids);
  const { data, error } = await query;
  if (error) return { withdrawnFrom: [], failed: true };
  const withdrawnFrom = new Set<string>();
  let failed = false;
  for (const row of (data ?? []) as Array<{ id: string; stock_item_id: string; source_detail: unknown }>) {
    const stamp = imageConfirmationStamp(row.source_detail);
    if (!stamp) continue;
    const standing = [...(input.standing.get(row.stock_item_id)?.values() ?? [])]
      .some((confirmation) => confirmation.id === stamp);
    if (standing) continue;
    const { error: writeError } = await db
      .from('builder_stock_item_images')
      .update({ processing_status: 'unavailable', error_message: LAPSED_CONFIRMATION_IMAGE_REASON })
      .eq('id', row.id)
      .eq('stock_item_id', row.stock_item_id);
    if (writeError) failed = true;
    else withdrawnFrom.add(String(row.stock_item_id));
  }
  return { withdrawnFrom: [...withdrawnFrom], failed };
}

// ---------------------------------------------------------------------------
// The other listings a confirmation has to be checked against
// ---------------------------------------------------------------------------

/*
 * `house_design` IS NOT A COLUMN: it is read out of the stored row, under the
 * alias the portal's own projection uses (`projection.pure.ts`).
 */
const SIBLING_COLUMNS = 'id, lot_number, unit_number, house_design:source_row->>house_design, '
  + 'lifecycle_status, suburb, development_name';

function lotDigits(value: unknown): string {
  return String(value ?? '').trim().replace(/^lot\s*/i, '');
}

/**
 * The organisation's live listings whose lot is one of these, with the stored
 * answers the in-use check reads. Two reads: the cheap columns of every live
 * listing, then the stored answers of the few whose lot matched — an
 * organisation's whole provenance is not fetched to compare three numbers.
 * Null where either read failed.
 */
export async function readListingsWithLots(
  db: any,
  input: { organisationId: string; lots: readonly string[] },
): Promise<StockRowForConfirmation[] | null> {
  const lots = new Set(input.lots.filter((lot) => /^\d{1,5}$/.test(lot)));
  if (!lots.size) return [];
  const live = await readAllRows<StockRowForConfirmation & { id: string }>(() => db
    .from('builder_stock_items')
    .select(SIBLING_COLUMNS)
    .eq('organisation_id', input.organisationId)
    .in('lifecycle_status', ['active', 'staged'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }));
  if (live.failed) return null;
  const candidates = live.rows.filter((row) => lots.has(lotDigits(row.lot_number)));
  if (!candidates.length) return [];
  const { data, error } = await db
    .from('builder_stock_items')
    .select('id, source_provenance_result')
    .eq('organisation_id', input.organisationId)
    .in('id', candidates.map((row) => row.id));
  if (error) return null;
  const provenance = new Map<string, unknown>(
    ((data ?? []) as Array<{ id: string; source_provenance_result: unknown }>)
      .map((row) => [String(row.id), row.source_provenance_result]));
  return candidates.map((row) => ({
    ...row, source_provenance_result: provenance.get(String(row.id)) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The two acts
// ---------------------------------------------------------------------------

export type BrochureConfirmationRefusal =
  | 'invalid' | 'not_found' | 'busy' | 'finding_changed' | 'not_confirmable'
  | 'in_use_unacknowledged' | 'unavailable';

export type ConfirmBrochureOutcome =
  | { ok: true; id: string; already: boolean }
  | {
    ok: false; code: BrochureConfirmationRefusal; message: string;
    /** `in_use_unacknowledged` only: the listing the builder has to be told about. */
    in_use_by?: ListingReference;
  };

export type UndoBrochureOutcome =
  | { ok: true; id: string; imagesWithdrawn: number }
  | { ok: false; code: 'invalid' | 'not_found' | 'busy' | 'unavailable'; message: string };

/** What each refusal says to the builder. One sentence each, no mechanism. */
export const BROCHURE_CONFIRMATION_REFUSALS: Record<BrochureConfirmationRefusal, string> = {
  invalid: 'That brochure could not be confirmed. Reload the page and try again.',
  not_found: 'That property is no longer in your stock list. Reload the page and try again.',
  busy: 'This property’s pictures are being worked on right now. Try again in a minute.',
  finding_changed: 'This brochure has been read again since the page was loaded. Reload the '
    + 'page to see what it says now.',
  not_confirmable: 'Only a link to a single brochure can be confirmed. Link the brochure itself '
    + 'rather than a folder.',
  in_use_unacknowledged: 'Another listing in your stock list already shows this image. If you '
    + 'continue, both listings will show it.',
  unavailable: 'That could not be saved just now. Try again in a minute.',
};

function refused(
  code: BrochureConfirmationRefusal,
  extra: { in_use_by?: ListingReference } = {},
): ConfirmBrochureOutcome {
  return { ok: false, code, message: BROCHURE_CONFIRMATION_REFUSALS[code], ...extra };
}

/**
 * CONFIRM that a brochure is this property's.
 *
 * The page's reading is never authority: the link and the lot it sends are
 * lookup keys, and the SQL function re-reads the stored refusal under the
 * link and refuses unless it is still the mismatch stating that lot.
 */
export async function confirmBrochureImage(
  db: any,
  input: {
    organisationId: string;
    stockItemId: string;
    documentReference: string;
    states: string;
    actor: { id: string | null; name: string };
    /**
     * The listing the builder was shown as already using this brochure
     * (`in_use_by.stock_item_id`), or null where they were shown none.
     */
    acknowledgedInUse?: string | null;
  },
): Promise<ConfirmBrochureOutcome> {
  const lot = confirmedLotOf(input.states);
  const reference = String(input.documentReference ?? '');
  const name = String(input.actor?.name ?? '').trim() || 'A builder';
  if (!lot || !reference || reference.length > 2048 || !input.stockItemId) return refused('invalid');
  if (!isConfirmableBranch(reference)) return refused('not_confirmable');

  const { data: item, error: itemError } = await db
    .from('builder_stock_items')
    .select(`${SIBLING_COLUMNS}, source_provenance_result`)
    .eq('id', input.stockItemId)
    .eq('organisation_id', input.organisationId)
    .maybeSingle();
  if (itemError) return refused('unavailable');
  if (!item || !['active', 'staged'].includes(String(item.lifecycle_status ?? ''))) {
    return refused('not_found');
  }

  /*
   * A BROCHURE ANOTHER LISTING ALREADY SHOWS IS NOT REFUSED. #106 refused it
   * (`brochure_in_use`); the owner's rule is that a builder who wants the
   * photograph in the brochure they linked may use it. What IS required is
   * that they were told: the listings are re-read here, and where one shows
   * this brochure's photograph and the builder was not shown THAT listing,
   * the act names it and asks again rather than saving. A read that failed
   * cannot say, so it saves nothing either.
   */
  const listings = await readListingsWithLots(db, {
    organisationId: input.organisationId, lots: [lot],
  });
  if (!listings) return refused('unavailable');
  const inUseBy = brochureInUseByAnotherProperty(listings, {
    stockItemId: input.stockItemId, documentReference: reference, statedLot: lot,
  });
  if (!inUseAcknowledged(inUseBy, input.acknowledgedInUse)) {
    return refused('in_use_unacknowledged', { in_use_by: inUseBy! });
  }

  const record = ((item.source_provenance_result as { branches?: Record<string, unknown> } | null)
    ?.branches ?? {})[reference] as { finding_evidence?: { quote?: unknown } } | undefined;
  const { data, error } = await db.rpc('builder_stock_confirm_brochure_image', {
    p_organisation_id: input.organisationId,
    p_stock_item_id: input.stockItemId,
    p_document_reference: reference,
    p_confirmed_lot: lot,
    p_confirmed_by: input.actor?.id ?? null,
    p_confirmed_by_name: name.slice(0, 160),
    p_listing_identity: listingIdentity(item).slice(0, 200) || null,
    p_finding_quote: String(record?.finding_evidence?.quote ?? '').slice(0, 400) || null,
  });
  if (error) return refused('unavailable');
  const answer = (data ?? {}) as { ok?: unknown; id?: unknown; already?: unknown; code?: unknown };
  if (answer.ok === true && answer.id) {
    return { ok: true, id: String(answer.id), already: answer.already === true };
  }
  const code = String(answer.code ?? '') as BrochureConfirmationRefusal;
  return refused(code in BROCHURE_CONFIRMATION_REFUSALS ? code : 'unavailable');
}

/**
 * UNDO a confirmation. Its images come down in the same transaction; the card
 * is then re-chosen from what may still be shown, so a property that had a
 * picture before the confirmation gets it back without waiting for a sweep.
 */
export async function undoBrochureImage(
  db: any,
  input: {
    organisationId: string;
    stockItemId: string;
    confirmationId: string;
    actor: { id: string | null; name: string };
  },
): Promise<UndoBrochureOutcome> {
  const name = String(input.actor?.name ?? '').trim() || 'A builder';
  if (!input.stockItemId || !/^[0-9a-f-]{36}$/i.test(String(input.confirmationId ?? ''))) {
    return { ok: false, code: 'invalid', message: BROCHURE_CONFIRMATION_REFUSALS.invalid };
  }
  const { data, error } = await db.rpc('builder_stock_undo_brochure_image', {
    p_organisation_id: input.organisationId,
    p_stock_item_id: input.stockItemId,
    p_confirmation_id: input.confirmationId,
    p_withdrawn_by: input.actor?.id ?? null,
    p_withdrawn_by_name: name.slice(0, 160),
  });
  if (error) return { ok: false, code: 'unavailable', message: BROCHURE_CONFIRMATION_REFUSALS.unavailable };
  const answer = (data ?? {}) as { ok?: unknown; id?: unknown; images_withdrawn?: unknown; code?: unknown };
  if (answer.ok !== true) {
    const code = (['invalid', 'not_found', 'busy'] as const)
      .find((known) => known === answer.code) ?? 'unavailable';
    return { ok: false, code, message: BROCHURE_CONFIRMATION_REFUSALS[code] };
  }
  try {
    // Lazily, because the card's picture chooser reads this module.
    const { chooseAndStorePrimaryImage } = await import('./primaryImage.ts');
    await chooseAndStorePrimaryImage(db, input.stockItemId);
  } catch {
    // The confirmation is withdrawn and its picture is down either way; the
    // settler, requeued by the undo, re-chooses the card on its next run.
  }
  return { ok: true, id: String(answer.id), imagesWithdrawn: Number(answer.images_withdrawn ?? 0) || 0 };
}

