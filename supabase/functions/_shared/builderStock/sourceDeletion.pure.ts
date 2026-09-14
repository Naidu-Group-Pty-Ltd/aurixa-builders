/**
 * Builder stock lists — what "delete this stock list" actually means.
 *
 * A builder deleting a source means: *this source should no longer supply
 * active stock*. It does not mean "erase the history", and it certainly does
 * not mean "undo a selection an adviser already made for a buyer".
 *
 * So the rule is stated here, once, as a predicate:
 *
 *   A stock item is deactivated when the deleted upload is the one CURRENTLY
 *   supplying it — `upload_id` — and never because it merely happens to have
 *   come from it originally.
 *
 * The distinction is the whole of requirement (4): a property first imported
 * from March's list and re-supplied by April's has `first_upload_id` = March
 * and `upload_id` = April. Deleting March must leave it alone, because April
 * is still offering it. Deleting April must deactivate it, because nothing is.
 *
 * Pure: no imports, no IO, no clock.
 */

export interface DeletableStockItem {
  id: string;
  /** The upload that last wrote this row. */
  upload_id: string | null;
  /** The upload that first created it. Never a reason to deactivate. */
  first_upload_id?: string | null;
  lifecycle_status?: string | null;
}

/**
 * True when deleting `uploadId` should archive this item.
 *
 * Already-archived items are excluded so a second delete is a no-op rather
 * than a rewrite, and an item whose current source is a DIFFERENT upload is
 * never touched however it started life.
 */
export function shouldArchiveOnSourceDelete(
  item: DeletableStockItem,
  uploadId: string,
): boolean {
  if (!uploadId) return false;
  if (item.lifecycle_status === 'archived') return false;
  return item.upload_id === uploadId;
}

/** The ids to archive, for a page of the organisation's stock. */
export function itemsToArchiveOnSourceDelete(
  items: DeletableStockItem[],
  uploadId: string,
): string[] {
  return items.filter((item) => shouldArchiveOnSourceDelete(item, uploadId)).map((item) => item.id);
}

export interface SourceDeletionSummary {
  /** Stock the deleted source was currently supplying. Now archived. */
  archived: number;
  /** Stock that came from this source but has since been re-supplied. Kept. */
  retainedBecauseResupplied: number;
  /**
   * Live client selections against the archived stock. NOT removed — reported
   * so the confirmation can say what the builder is about to affect.
   */
  affectedSelections: number;
}

/**
 * What the builder is told about a deletion — before it, or after it.
 *
 * Deliberately counts rather than lists: the builder is entitled to know that
 * advisers have selected some of this stock, and to nothing else about those
 * selections.
 *
 * THE RETAINED COUNT IS THE HALF THAT MATTERS, and it had no caller. This
 * function was written for the confirmation and nothing ever called it; the
 * toast that reports the outcome was composed inline and said ONLY how many
 * properties were archived. So a builder deleting a list whose stock a newer
 * list still supplies was told
 *
 *     "Stock list deleted — 0 properties were removed from the marketplace."
 *
 * while thirteen properties stayed on the page with no explanation offered.
 * Measured on the live deployment: Kopi Jantan's thirteen active properties
 * are supplied by one list and were first imported by another, so deleting
 * the older one archives nothing and retains all thirteen. That is the rule
 * working exactly as designed and reading, to the person who pressed the
 * button, as a delete that did not happen.
 *
 * `tense` exists so one rule serves both surfaces rather than the outcome
 * message being written a second time somewhere else — which is how it came
 * to disagree in the first place.
 */
export function describeSourceDeletion(
  summary: SourceDeletionSummary,
  tense: 'future' | 'past' = 'future',
): string {
  const past = tense === 'past';
  const removed = past ? 'was removed' : 'will be removed';
  const removedPlural = past ? 'were removed' : 'will be removed';
  const stays = past ? 'stayed' : 'stays';
  const stayPlural = past ? 'stayed' : 'stay';

  const parts: string[] = [];
  parts.push(summary.archived === 1
    ? `1 property ${removed} from the marketplace`
    : `${summary.archived} properties ${removedPlural} from the marketplace`);
  if (summary.retainedBecauseResupplied > 0) {
    parts.push(summary.retainedBecauseResupplied === 1
      ? `1 property ${stays} because a newer stock list supplies it`
      : `${summary.retainedBecauseResupplied} properties ${stayPlural} because a newer stock list supplies them`);
  }
  if (summary.affectedSelections > 0) {
    parts.push(summary.affectedSelections === 1
      ? '1 property has already been selected for a buyer and its record is kept'
      : `${summary.affectedSelections} of them have already been selected for a buyer and those records are kept`);
  }
  return `${parts.join('. ')}.`;
}
