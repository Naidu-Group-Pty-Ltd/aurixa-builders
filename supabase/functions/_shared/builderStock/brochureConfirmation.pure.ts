/**
 * BUILDER STOCK — WHEN A BUILDER MAY SAY "THAT BROCHURE IS MINE".
 *
 * "Brochure details don't match this property" refuses a brochure whose image
 * page states a lot other than the listing's, and it is right to: a cover that
 * states another lot is how another house reaches a client's card. It is also,
 * sometimes, wrong about the builder's own brochure — and the product cannot
 * tell which, while the person holding the sheet can. So a builder may confirm
 * the brochure is theirs, and the cover rule then counts the lot it states as
 * this listing's and keeps every other test it has (`pageStatesIdentity`).
 *
 * MEASURED 24 SEPTEMBER 2026, one stock list, two properties that look the
 * same on screen and are opposite cases:
 *
 *   Lot 1037 · Vanta 20 links its OWN brochure. Page 2 states "Lot 1037" and
 *   "Vanta 20"; the cover mistypes the lot as "Lot 1307". Confirming it puts
 *   this property's own photograph on this property's card.
 *
 *   Lot 1447 · Nex 20 links the SAME FILE as Lot 1744 · Cura 20B, and Lot
 *   1744 already shows that brochure's photograph. Its digits are swapped
 *   too. Confirming it would put Lot 1744's Cura 20B render on a Nex 20
 *   listing: the same picture on two cards, of a different house.
 *
 * So a transposition is a HINT for the builder and never evidence for the
 * product, and the one fact that settles the second case is checked before
 * the choice is offered and again when it is made: another listing in the
 * same stock list already uses that brochure's photograph for the lot the
 * brochure states (`brochureInUseByAnotherProperty`). A listing that merely
 * HAS that lot is a caution the builder is shown, not a refusal
 * (`statedLotListing`) — a typo can land on a real lot number.
 *
 * Pure: no IO, no clock. The rows it reads are passed in.
 */
import { driveFileId } from './drivePackage.pure.ts';
import {
  BRANCH_IMAGE_RECOVERED, classifyBranch, readBranchState,
} from './sourceBranches.pure.ts';

/**
 * The lot a finding's `states` names, as a confirmation records it.
 *
 * `statedOtherLotDesignation` writes `Lot <digits>` and nothing else, so that
 * is all this reads: anything it could not have written is not a lot a builder
 * can be asked to confirm.
 */
export function confirmedLotOf(states: unknown): string | null {
  if (typeof states !== 'string') return null;
  const match = /^lot\s+(\d{1,5})$/i.exec(states.trim());
  return match ? match[1] : null;
}

/**
 * Do two lot numbers use the same digits in a different order?
 *
 * The builder's screen says so as a possibility — it often is a typing error,
 * in the brochure or in the stock list — and never as a conclusion, because
 * the sibling whose brochure was linked on the wrong row is very often the
 * lot with the same digits too. Measured: both production mismatches were
 * transposed, and only one of them was the builder's own brochure.
 */
export function lotsShareDigits(listingLot: unknown, statedLot: unknown): boolean {
  if (typeof listingLot !== 'string' || typeof statedLot !== 'string') return false;
  const a = listingLot.trim();
  const b = statedLot.trim();
  if (!/^\d{2,5}$/.test(a) || !/^\d{2,5}$/.test(b)) return false;
  if (a === b || a.length !== b.length) return false;
  return [...a].sort().join('') === [...b].sort().join('');
}

/**
 * May a builder confirm the document behind this link?
 *
 * ONE DOCUMENT, LINKED ON THE ROW ITSELF. A folder is never confirmable: which
 * file inside it is read is chosen by the lot the LISTING states, so a
 * confirmation about "the brochure" in a folder is not about any one file.
 */
export function isConfirmableBranch(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  const kind = classifyBranch(url.trim());
  return kind === 'drive_file' || kind === 'document';
}

/** How a listing names itself on the builder's own screen: its lot and design. */
export function listingIdentity(row: {
  lot_number?: unknown; unit_number?: unknown; house_design?: unknown;
}): string {
  const unit = String(row.unit_number ?? '').trim();
  const lot = String(row.lot_number ?? '').trim();
  const designation = unit ? `Unit ${unit}` : lot ? `Lot ${lot}` : '';
  const design = String(row.house_design ?? '').trim();
  return [designation, design].filter(Boolean).join(' · ');
}

/** Another listing, as the builder's screen names it. */
export interface ListingReference {
  stock_item_id: string;
  identity: string;
}

/** A row of the organisation's stock, as the checks below read it. */
export interface StockRowForConfirmation {
  id?: unknown;
  lot_number?: unknown;
  unit_number?: unknown;
  house_design?: unknown;
  lifecycle_status?: unknown;
  suburb?: unknown;
  development_name?: unknown;
  source_provenance_result?: unknown;
}

const LIVE = new Set(['active', 'staged']);

function lotOf(value: unknown): string {
  return String(value ?? '').trim().replace(/^lot\s*/i, '');
}

function sameText(a: unknown, b: unknown): boolean {
  const x = String(a ?? '').trim().toLowerCase();
  return !!x && x === String(b ?? '').trim().toLowerCase();
}

/** Are these two links to one document? The Drive file behind them, or the URL. */
export function sameDocument(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const idA = driveFileId(a);
  return !!idA && idA === driveFileId(b);
}

/**
 * ANOTHER LISTING ALREADY USES THIS BROCHURE'S PHOTOGRAPH, FOR THE LOT IT
 * STATES — the one fact that makes a confirmation wrong rather than risky.
 *
 * All three must hold: the other listing is live, its lot is the lot this
 * brochure's image page states, and ITS stored answer for this very document
 * is a photograph delivered. A many-lot document another lot happens to use
 * is not this lot's brochure, and a listing that read the document and took
 * nothing from it has not claimed it.
 */
export function brochureInUseByAnotherProperty(
  rows: readonly StockRowForConfirmation[],
  input: { stockItemId: string; documentReference: string; statedLot: string },
): ListingReference | null {
  for (const row of rows ?? []) {
    if (!row || String(row.id ?? '') === input.stockItemId) continue;
    if (!LIVE.has(String(row.lifecycle_status ?? ''))) continue;
    if (lotOf(row.lot_number) !== input.statedLot) continue;
    const branches = readBranchState(row.source_provenance_result);
    for (const [reference, record] of Object.entries(branches)) {
      if (!sameDocument(reference, input.documentReference)) continue;
      if ((record as { result?: unknown } | null)?.result !== BRANCH_IMAGE_RECOVERED) continue;
      return { stock_item_id: String(row.id), identity: listingIdentity(row) };
    }
  }
  return null;
}

/**
 * A listing in the same estate or suburb whose lot is the one the brochure
 * states. Shown to the builder before they confirm, never used to refuse: a
 * typing error can land on a lot number that really exists.
 */
export function statedLotListing(
  rows: readonly StockRowForConfirmation[],
  input: { stockItemId: string; statedLot: string; suburb?: unknown; developmentName?: unknown },
): ListingReference | null {
  for (const row of rows ?? []) {
    if (!row || String(row.id ?? '') === input.stockItemId) continue;
    if (!LIVE.has(String(row.lifecycle_status ?? ''))) continue;
    if (lotOf(row.lot_number) !== input.statedLot) continue;
    if (!sameText(row.suburb, input.suburb) && !sameText(row.development_name, input.developmentName)) {
      continue;
    }
    return { stock_item_id: String(row.id), identity: listingIdentity(row) };
  }
  return null;
}
