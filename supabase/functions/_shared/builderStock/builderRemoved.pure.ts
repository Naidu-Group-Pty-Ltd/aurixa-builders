/**
 * Builder stock — a property the BUILDER removed stays removed.
 *
 * An import revives an archived row it matches, and that rule has a real job:
 * a list replaced by a newer one archives what the newer one left out, and a
 * later list that supplies the property again brings it back. But "Remove" on
 * the Stock List archives a row too, and nothing told the importer the two
 * apart.
 *
 * MEASURED 30 SEPTEMBER 2026 (audit of the network project):
 *   • Lot 1037 Wollert Rise was removed by its builder on 20 September; a
 *     Google Sheet imported on the 24th matched it, revived it, and it was on
 *     the marketplace from the 25th until the 29th.
 *   • Mairandi removed 22 properties from their live Notion list on 29
 *     September. A "Read again" of that list — the only way the list's
 *     corrected addresses reach its live rows — would have brought all 22
 *     back: revived where a development-and-lot key matched, and INSERTED as
 *     new properties where only the Notion row id could, because archived rows
 *     are deliberately not anchor matches.
 *
 * THE RECORD OF THE DECISION IS THE ACTIVITY LOG. `archive_stock_item` writes
 * `builder_stock_item_archived` for the row, and nothing else does: lineage
 * archiving happens inside `publish_builder_stock_upload`, and deleting a
 * source is logged against the source. So a row is the builder's removal when
 * it is archived NOW and the builder archived it AFTER the importer last saw
 * it — a removal an import has since revived and something else re-archived is
 * not the builder's standing decision, and is left to the ordinary rule.
 *
 * DELETING THE STOCK LIST ENDS THE DECISION. A builder who deletes a list and
 * adds it again is starting that list over, and expects every property in it
 * back — Mairandi did exactly that on 30 September and got 19 of 41. So a
 * removal made BEFORE the builder deleted the list the row belonged to no
 * longer counts: the row is left to the ordinary rule. A removal made after
 * the list was deleted (impossible today, but not by construction) still
 * stands.
 *
 * Pure: no IO. The importer reads the log and the deleted lists and hands
 * them in.
 */

export interface RemovalCandidate {
  id: string;
  lifecycle_status: string | null;
  /** When an import last matched or created this row. */
  last_seen_at?: string | null;
  /** The stock list that supplied this row. */
  upload_id?: string | null;
}

export interface RemovalLogEntry {
  entity_id: string | null;
  created_at: string | null;
}

/** The action `archive_stock_item` logs, named once. */
export const BUILDER_REMOVED_ACTION = 'builder_stock_item_archived';

const time = (value: string | null | undefined): number => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/**
 * The ids of rows a builder removed and no import has touched since.
 *
 * A row with no `last_seen_at` counts as removed wherever the builder's entry
 * exists at all: nothing has re-supplied it that we can see, and keeping a
 * removal is the side that cannot put a withdrawn property back on sale.
 */
export function builderRemovedIds(
  rows: readonly RemovalCandidate[],
  log: readonly RemovalLogEntry[],
  /** Stock list id → when the builder deleted it. */
  deletedLists: ReadonlyMap<string, string | null> = new Map(),
): Set<string> {
  const latestRemoval = new Map<string, number>();
  for (const entry of log) {
    const id = entry.entity_id ? String(entry.entity_id) : '';
    const at = time(entry.created_at);
    if (!id || !Number.isFinite(at)) continue;
    latestRemoval.set(id, Math.max(latestRemoval.get(id) ?? -Infinity, at));
  }

  const removed = new Set<string>();
  for (const row of rows) {
    if (row.lifecycle_status !== 'archived') continue;
    const removedAt = latestRemoval.get(row.id);
    if (removedAt === undefined) continue;
    const listDeletedAt = row.upload_id ? time(deletedLists.get(String(row.upload_id))) : Number.NaN;
    if (Number.isFinite(listDeletedAt) && listDeletedAt >= removedAt) continue;
    const seenAt = time(row.last_seen_at);
    if (!Number.isFinite(seenAt) || removedAt >= seenAt) removed.add(row.id);
  }
  return removed;
}
