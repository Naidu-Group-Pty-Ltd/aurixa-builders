/**
 * How the portal's team collaboration reads refresh themselves.
 *
 * The app turns refetch-on-focus off globally, so a query that does not poll
 * never moves while its page stays open: a colleague's message did not appear
 * in an open project conversation, and the bell's count did not change, until
 * the page was reloaded. Polling is the transport's floor, exactly as it is
 * for the agency chat (`AGENCY_CONVERSATION_POLL_MS`).
 */
import { AGENCY_CONVERSATION_POLL_MS } from './builderAgency';

/** An open project conversation re-reads itself at the agency chat's cadence. */
export const TEAM_CONVERSATION_POLL_MS = AGENCY_CONVERSATION_POLL_MS;

/** The bell's unread counts: a summary, so gentler than an open conversation. */
export const UNREAD_COUNTS_POLL_MS = 30_000;

/**
 * Keep polling unless the answer says there is nothing to poll for: a refusal
 * (401/403) or a record that is gone (404). Anything else — a 5xx, a network
 * failure — is transient, and the next tick tries again.
 */
export function pollUnlessGone(state: { error?: unknown }, every: number): number | false {
  const error = state.error;
  if (error && typeof error === 'object') {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return false;
  }
  return every;
}
