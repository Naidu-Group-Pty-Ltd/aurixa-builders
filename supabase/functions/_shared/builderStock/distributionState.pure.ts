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
