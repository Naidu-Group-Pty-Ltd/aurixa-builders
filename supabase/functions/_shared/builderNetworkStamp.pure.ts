/**
 * The polling stamp — network edition of the clone's four-scalar shape
 * (extraction plan §6).
 *
 * A stamp answers WHETHER anything changed for one connection; the monotonic
 * `source_version` beside it answers WHAT to fetch. Two rules were earned on
 * the clone and carry verbatim:
 *
 *  * **A null previous stamp is not a change.** The first comparison after a
 *    worker restart has nothing stored; treating that as "changed" resyncs
 *    every connection on every restart, which is a stampede wearing a
 *    freshness costume.
 *
 *  * **The stamp is stored WITH its scope, and the scope is the
 *    connection.** A global stamp says "something, somewhere" — every
 *    consumer then walks everything, which is the thing the stamp exists to
 *    avoid.
 *
 * Pure and Deno-free so the same module serves the edge worker and the
 * vitest suite.
 */

export interface ConnectionStamp {
  /** Rows in scope for this connection. */
  count: number;
  /** ISO timestamp of the newest row, or null where there are none. */
  latest: string | null;
  /** Items waiting on the OTHER side's decision. */
  pendingRequests: number;
  /** Items needing a human on THIS side. */
  attention: number;
}

/** Humans poll at 20 s; the server reconciles at 5 min. */
export const HUMAN_POLL_SECONDS = 20;
export const SERVER_RECONCILE_SECONDS = 300;

/** The storage key: the scope travels with the stamp, never beside it. */
export function stampKey(side: 'inbound' | 'outbound', connectionId: string): string {
  return `builder_network:${side}:${connectionId}`;
}

/**
 * Whether a fresh reading differs from the stored one.
 *
 * `previous === null` is NOT a change (see the module header). Every scalar
 * is compared exactly — a stamp is a fingerprint, not a heuristic.
 */
export function stampsDiffer(
  previous: ConnectionStamp | null | undefined,
  current: ConnectionStamp,
): boolean {
  if (previous === null || previous === undefined) return false;
  return previous.count !== current.count
    || previous.latest !== current.latest
    || previous.pendingRequests !== current.pendingRequests
    || previous.attention !== current.attention;
}

/** Normalise a reading into a stamp; absent numbers are 0, absent time null. */
export function buildStamp(reading: Partial<ConnectionStamp>): ConnectionStamp {
  return {
    count: reading.count ?? 0,
    latest: reading.latest ?? null,
    pendingRequests: reading.pendingRequests ?? 0,
    attention: reading.attention ?? 0,
  };
}
