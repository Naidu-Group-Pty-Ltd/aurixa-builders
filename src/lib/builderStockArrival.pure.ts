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
 * WHERE A LIST THAT IS NOT YET LIVE HAS GOT TO.
 *
 * `arriving` — properties imported and photographs still being worked on.
 * `settled` — imported, nothing left in flight, and still not on the
 * marketplace: every photograph the engine will find has been found, so a
 * progress bar reading "44 of 44 photos ready" over it is finished work
 * presented as work in progress. What holds it is a LIST-level gate, and the
 * reader is owed its name (`publicationBlockers`) rather than a full bar.
 */
export type StockListPreparation =
  | ({ kind: 'arriving' } & ArrivingList)
  | { kind: 'settled'; total: number; ready: number }
  | null;

export function stockListPreparation(
  records: readonly ArrivalProgressRecord[],
): StockListPreparation {
  for (const record of records) {
    if (record.published === true) continue;
    const total = count(record.total);
    if (total <= 0) continue;
    // A photograph being prepared, or a linked file still being fetched.
    const working = count(record.working) + count(record.pending_assets);
    const ready = Math.min(count(record.photos_ready), total);
    /*
     * "PREPARING" IS A CLAIM ABOUT PHOTOGRAPHS, so it is made only while
     * photographs are actually outstanding. A list reading 44 of 44 with a
     * full bar and no explanation was the reported defect: every photograph
     * had been found and what held the list was a LIST-level gate, which the
     * settled reading hands to `publicationBlockers` to name.
     */
    return working > 0 && ready < total
      ? { kind: 'arriving', total, ready, working }
      : { kind: 'settled', total, ready };
  }
  return null;
}

/**
 * The upload that has properties, has not gone live, and still has
 * photographs being worked on — or null. A held list with nothing left in
 * progress is not "arriving": what holds it is named by the publication
 * blockers, and a spinner over it would promise a cutover that is not coming.
 */
export function arrivingList(records: readonly ArrivalProgressRecord[]): ArrivingList | null {
  const preparation = stockListPreparation(records);
  if (preparation?.kind !== 'arriving') return null;
  const { total, ready, working } = preparation;
  return { total, ready, working };
}

export function arrivingListTitle(list: ArrivingList): string {
  return `Preparing your stock list — ${list.ready} of ${list.total} photos ready`;
}

export const ARRIVING_LIST_BODY =
  'Your properties appear here together as soon as their photos are ready, usually within a few minutes. '
  + 'This page updates by itself, so there is no need to refresh or upload again.';

/**
 * How many placeholder plates to draw.
 *
 * ONLY BEFORE THERE ARE ROWS TO DRAW. A skeleton stands in for a row whose
 * identity is not known yet — the seconds between the file being read and its
 * properties existing. Once the staged rows exist they are what the page
 * shows: an anonymous grey rectangle where a builder's own lot and address
 * could be drawn is strictly less than the page already had, which is the
 * regression this rule now states. The caller passes `stagedRows`, and any
 * staged row at all means no skeletons.
 */
export function arrivingPlaceholderCount(list: ArrivingList, stagedRows = 0): number {
  if (count(stagedRows) > 0) return 0;
  return Math.max(1, Math.min(list.total, 4));
}

/** The settled list's heading: finished finding photographs, still not live. */
export function settledListTitle(list: { total: number; ready: number }): string {
  return `Your stock list is not on the marketplace yet — ${list.ready} of ${list.total} photos ready`;
}
