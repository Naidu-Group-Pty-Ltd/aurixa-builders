/**
 * Builder stock — reading a whole table when the API will not give you one.
 *
 * WHAT HAPPENED. `enforceStrictPrimaryImages` asked PostgREST for an
 * organisation's images with `.limit(200000)` and treated the answer as the
 * whole set. PostgREST does not honour that number: the deployment caps a
 * response at `db-max-rows`, which is 1,000 here — declared in this repo's own
 * `supabase/config.toml` and measured against production on 1 September 2026,
 * where a request for 200,000 rows of an 18,519-row table answered
 * `content-range: 0-999/18519` with HTTP 200 and no error of any kind.
 *
 * The organisation held 1,926 image rows. The sweep saw 1,000. The other 926
 * did not read as "not yet loaded" — they read as ABSENT, so every property
 * whose photograph sat in that tail reached `chooseCardImage([])`, answered
 * "this property has no image", and had its `primary_image_id` CLEARED. All
 * eleven properties holding an eligible builder photograph had it at physical
 * position 1,125-1,781, all eleven past the cut, and all eleven were blank.
 * Live pointers fell from 27 to 6 in an hour while the per-item writer — which
 * asks for ONE property's images and is therefore never truncated — put them
 * back and the next sweep took them away again.
 *
 * TWO RULES, AND THEY ARE WHY THIS IS A MODULE RATHER THAN A `.range()` CALL.
 *
 * IT ADVANCES BY WHAT IT ACTUALLY RECEIVED, never by the page size it asked
 * for. A reader that stops when a page comes back shorter than requested is
 * correct only while it happens to know the server's cap; point the same code
 * at a deployment capped at 500 and it silently truncates at 500 — the same
 * defect wearing a page loop. Advancing by the row count and stopping only on
 * an EMPTY page costs one extra round trip and is right under any cap.
 *
 * A FAILED READ IS NEVER A PARTIAL ANSWER. The old call discarded `error`, so
 * a database fault arrived as `data: null` and read as an organisation with no
 * images — which, in the one caller that matters, is an instruction to blank
 * every card it owns. Anything short of the complete set comes back `failed`,
 * and callers that write from it must do nothing at all.
 *
 * THE ORDER MUST BE TOTAL. Paging is offset-based, so rows tied under the
 * caller's ordering may straddle a page boundary and be served twice or not at
 * all. Every caller orders by a unique column, or by its intended ordering with
 * a unique column appended as the tiebreaker.
 */

/** What a paged read answers. `rows` is complete, or `failed` is set. */
export interface PagedReadResult<T> {
  rows: T[];
  /** True when the set is INCOMPLETE for any reason. Never write from it. */
  failed: boolean;
  /** The database error, the cap that was hit, or null. */
  error: unknown;
}

/**
 * The page size to ask for. Matching the deployment's own cap means the common
 * case is one request per 1,000 rows and no request is wasted; correctness does
 * not depend on the two agreeing (see the header).
 */
export const PAGE_SIZE = 1000;

/**
 * A ceiling, so a runaway loop cannot page for ever against a table that is
 * being written to while it reads. Hitting it is a FAILURE rather than a
 * truncation, because a truncation that reports success is the whole defect.
 */
export const MAX_ROWS = 200_000;

/**
 * Read every row a query matches, a page at a time.
 *
 * `makeQuery` must return a FRESH builder each time it is called — a PostgREST
 * builder is single-use and carries the `.range()` of the last call — with the
 * select, the filters and a TOTAL order already applied.
 */
export async function readAllRows<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<
    { data: T[] | null; error: unknown }> },
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<PagedReadResult<T>> {
  const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE);
  const maxRows = Math.max(1, options.maxRows ?? MAX_ROWS);
  const rows: T[] = [];

  let offset = 0;
  while (offset < maxRows) {
    const to = Math.min(offset + pageSize, maxRows) - 1;
    const { data, error } = await makeQuery().range(offset, to);
    if (error) return { rows: [], failed: true, error };

    const page = (data ?? []) as T[];
    // An empty page is the ONLY terminator. A short one means the server's cap
    // is smaller than the page asked for, which is not the end of the rows.
    if (!page.length) return { rows, failed: false, error: null };

    rows.push(...page);
    offset += page.length;
  }

  return {
    rows: [],
    failed: true,
    error: new Error(`readAllRows: more than ${maxRows} rows matched; refusing to `
      + 'report a truncated set as complete'),
  };
}
