/**
 * WHAT A BUILDER IS TOLD ABOUT WHERE THEIR STOCK GOES.
 *
 * The portal's stock list carried one sentence — "These are what the Command
 * Centre sees" — under every builder's properties, unconditionally. For three
 * organisations in a row it was false: they had no authorised connection to
 * any workspace, so the Command Centre saw none of it, and the page said
 * otherwise with complete confidence.
 *
 * The state is the SERVER'S (`builder_network_sync_state`), never computed
 * here from whatever the page happens to hold, and an unreadable state is its
 * own reading: `unknown` says nothing rather than repeating the claim that
 * was wrong. That is the rule this platform has paid for elsewhere — "we
 * could not check" is not "you do not have it", and it is not "you do" either.
 */

export type BuilderDistributionState =
  | 'synced'
  | 'syncing'
  | 'no_authorised_connection'
  | 'awaiting_connection'
  | 'delivery_failed'
  | 'organisation_inactive'
  | 'unknown';

export interface BuilderDistribution {
  state: BuilderDistributionState;
  authorisedDestinations: number;
  activeStockCount: number;
  eventsQueued: number;
  lastDeliveredAt: string | null;
}

const STATES: ReadonlySet<string> = new Set<BuilderDistributionState>([
  'synced', 'syncing', 'no_authorised_connection', 'awaiting_connection',
  'delivery_failed', 'organisation_inactive', 'unknown',
]);

/** A word this build does not know is `unknown`, never a guess at the nearest. */
export function distributionStateOf(value: unknown): BuilderDistributionState {
  const word = String(value ?? '').trim();
  return STATES.has(word) ? word as BuilderDistributionState : 'unknown';
}

export interface DistributionReading {
  /** Short, for a badge. */
  label: string;
  /** One sentence, for the line under a heading. */
  detail: string;
  /** Whether this is a state somebody has to do something about. */
  attention: boolean;
}

/**
 * Deliberately says what is TRUE of the record rather than what the builder
 * should feel about it, and never promises a destination that does not exist.
 */
export function describeDistribution(
  distribution: BuilderDistribution | null | undefined,
): DistributionReading {
  const state = distribution ? distributionStateOf(distribution.state) : 'unknown';
  const destinations = distribution?.authorisedDestinations ?? 0;
  const plural = destinations === 1 ? 'workspace' : 'workspaces';

  switch (state) {
    case 'synced':
      return {
        label: 'Shared',
        detail: destinations > 0
          ? `Shared with ${destinations} ${plural}. These are the properties they see.`
          : 'These are the properties your connected workspaces see.',
        attention: false,
      };
    case 'syncing':
      return {
        label: 'Sending',
        detail: `Sending your latest changes to ${destinations} ${plural}.`,
        attention: false,
      };
    case 'no_authorised_connection':
      return {
        label: 'Not shared yet',
        detail: 'Your properties are saved, but no workspace is authorised to '
          + 'receive them yet, so none of them are visible outside this portal.',
        attention: true,
      };
    case 'awaiting_connection':
      return {
        label: 'Not shared yet',
        detail: 'No workspace is authorised to receive your stock yet.',
        attention: true,
      };
    case 'delivery_failed':
      return {
        label: 'Delivery failed',
        detail: 'Some changes could not be delivered to a connected workspace. '
          + 'Your properties are safe here while that is resolved.',
        attention: true,
      };
    case 'organisation_inactive':
      return {
        label: 'Not active',
        detail: 'This organisation is not active on the builders network, so its '
          + 'properties are not shared.',
        attention: true,
      };
    default:
      return {
        label: 'Sharing status unavailable',
        detail: 'Properties imported from your stock lists.',
        attention: false,
      };
  }
}

/**
 * THE PROJECTION THIS READING IS BUILT FROM, AND THE ONE PLACE IT IS SPELLED.
 *
 * A single string literal rather than a concatenation: supabase-js parses the
 * select list at the TYPE level, and a `string` it cannot parse degrades the
 * whole row to `GenericStringError` — which is what the strict Deno check
 * caught. A `const` literal keeps the parse, and `readSyncStateRow` below
 * makes the shape a fact rather than a promise.
 */
export const BUILDER_SYNC_STATE_SELECT =
  'sync_state, authorised_destinations, active_stock_count, events_queued, last_delivered_at';

/** One row of `builder_network_sync_state`, as this reader needs it. */
export interface BuilderSyncStateRow {
  sync_state: string | null;
  authorised_destinations: number | null;
  active_stock_count: number | null;
  events_queued: number | null;
  last_delivered_at: string | null;
}

function countOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * Read a row the database returned into the reading the page renders.
 *
 * Deliberately takes `unknown` and checks, rather than trusting a client
 * generic: this deployment maintains no generated `Database` type, so a cast
 * would be an assertion nobody verified. Anything that is not an object is
 * `null`, which the caller renders as `unknown` — never as "no destinations",
 * because "we could not read it" and "you have none" send a builder to
 * opposite conclusions.
 */
export function readSyncStateRow(value: unknown): BuilderDistribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<BuilderSyncStateRow>;
  if (row.sync_state === undefined) return null;
  const delivered = row.last_delivered_at;
  return {
    state: distributionStateOf(row.sync_state),
    authorisedDestinations: countOf(row.authorised_destinations),
    activeStockCount: countOf(row.active_stock_count),
    eventsQueued: countOf(row.events_queued),
    lastDeliveredAt: typeof delivered === 'string' && delivered ? delivered : null,
  };
}
