/**
 * A STOCK LIST THAT IS STILL ARRIVING, SAID WHILE IT ARRIVES.
 *
 * A new stock list is held off the marketplace until its photographs are
 * ready, and then goes live in one cutover. The page's progress banner was
 * keyed on rows ALREADY live (`countWorkingImages` over the list it draws) or
 * on a file still being read. Neither is true in between: on 1 October 2026 a
 * builder replaced a 41-property list with a 44-property one, the file was
 * read in 13 seconds, and for the next four minutes and eleven seconds the
 * page drew an empty list headed "Nothing is on the marketplace yet" with no
 * sign that anything was happening, while 44 photographs were being prepared.
 *
 * The database already counts that upload (`image_progress`: `total`,
 * `photos_ready`, `working`, `published`). This reads it, and nothing else.
 */
export interface ArrivalProgressRecord {
  total: unknown;
  photos_ready?: unknown;
  working?: unknown;
  failed?: unknown;
  published?: unknown;
  pending_assets?: unknown;
}

export interface ArrivingList {
  total: number;
  ready: number;
  working: number;
}

const count = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * The upload that has properties, has not gone live, and still has
 * photographs being worked on — or null. A held list with nothing left in
 * progress is not "arriving": what holds it is named by the publication
 * blockers, and a spinner over it would promise a cutover that is not coming.
 */
export function arrivingList(records: readonly ArrivalProgressRecord[]): ArrivingList | null {
  for (const record of records) {
    if (record.published === true) continue;
    const total = count(record.total);
    // A photograph being prepared, or a linked file still being fetched.
    const working = count(record.working) + count(record.pending_assets);
    if (total <= 0 || working <= 0) continue;
    return { total, ready: Math.min(count(record.photos_ready), total), working };
  }
  return null;
}

export function arrivingListTitle(list: ArrivingList): string {
  return `Preparing your stock list — ${list.ready} of ${list.total} photos ready`;
}

export const ARRIVING_LIST_BODY =
  'Your properties appear here together as soon as their photos are ready, usually within a few minutes. '
  + 'This page updates by itself, so there is no need to refresh or upload again.';

/** How many placeholder plates to draw while nothing is live yet. */
export function arrivingPlaceholderCount(list: ArrivingList): number {
  return Math.max(1, Math.min(list.total, 4));
}
