/**
 * ===========================================================================
 * WHAT THE ACTIVITY FEED IS FOR, AND WHO DID IT.
 * ===========================================================================
 *
 * The page says what it is: "What has changed on the records you can reach."
 * Measured against production on 2 October 2026, it was neither.
 *
 * IT WAS MOSTLY NOT A CHANGE. `builder_project_viewed` is 474 of the 4,544
 * rows in the log — but the log is organisation-wide and the FEED is
 * per-user, and per user it is worse: across both users who have one, the
 * visible feed is 25 rows of `builder_project_viewed` and ONE row of
 * anything else. A reader opening the page to find out what happened was
 * shown a list of the times they had looked.
 *
 * AND IT WOULD NOT SAY WHO. The page's own header promises the rows carry
 * "who changed it", and every row rendered as the literal **"Portal user"**.
 * The name was never missing from the DATA — `builder_user_id` is set on all
 * 639 onboarding rows, all 474 view rows, all 304 upload rows, every
 * `builder_user` row in the log — it was missing from the READ:
 * `builder_visible_activity` selected `actor_type` and never joined the
 * person. One column, dropped in one function, and the whole feed spoke
 * anonymously.
 *
 * THE RULE IS WRITTEN ONCE, HERE, and the database is handed it rather than
 * keeping a second copy: two lists of what matters is how the page and the
 * feed come to disagree about what the page is showing.
 */

/**
 * Actions that record LOOKING, or a session, rather than a change to a record.
 *
 * Each is excluded for the same stated reason and not by taste: it would be
 * true of a reader who changed nothing. The counts are this log's, 2 October
 * 2026, and are what makes the case — `builder_onboarding_updated` and
 * `builder_terms_accepted` are 639 rows each across six users, which is a
 * value re-written on sight rather than an event anybody performed.
 *
 * NOTHING IS DELETED. The rows stay in `builder_portal_activity_log`, the
 * Command Centre's forensic record is untouched, and this list decides one
 * thing only: what the portal's own history page leads with.
 */
export const PASSIVE_BUILDER_ACTIVITY_ACTIONS: readonly string[] = [
  // Looking at a record is not changing it — 474 rows, and 25 of the 26 rows
  // in the two real per-user feeds.
  'builder_project_viewed',
  // A session is not a record.
  'builder_login',
  'builder_logout',
  'builder_active_organisation_selected',
  // A read receipt says somebody arrived, not that anything moved.
  'builder_conversation_read',
  'builder_notifications_read',
  // Settings a person keeps for themselves, re-written on sight: 639 and 639.
  'builder_onboarding_updated',
  'builder_terms_accepted',
  'builder_user_preferences_saved',
];

const PASSIVE = new Set(PASSIVE_BUILDER_ACTIVITY_ACTIONS);

/** Did this action CHANGE something the reader can reach? */
export function isSignificantBuilderActivity(action: unknown): boolean {
  const name = String(action ?? '').trim();
  return name.length > 0 && !PASSIVE.has(name);
}

/** The feed, with the looking taken out. Order is never changed. */
export function significantBuilderActivity<T extends { action?: unknown }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => isSignificantBuilderActivity(row.action));
}

export interface ActivityActor {
  actor_type?: unknown;
  actor_name?: unknown;
}

/**
 * WHO DID IT, IN WORDS A PERSON USES.
 *
 * The name the server recovered, where it recovered one. Otherwise a sentence
 * about WHO, never the database's word for a kind of account: "Portal user"
 * was what every row said, and it names nobody.
 *
 * `system` and `service_role` are the honest answer for work nobody asked
 * for — 149 activation fan-outs, 35 project openings, 30 status changes —
 * and they are NOT dressed up as a person.
 */
export function builderActivityActor(row: ActivityActor): string {
  const named = String(row.actor_name ?? '').trim();
  if (named) return named;
  switch (String(row.actor_type ?? '').trim()) {
    case 'system': return 'System';
    case 'service_role': return 'Automation';
    case 'command_user': return 'Aurixa Systems';
    case 'builder_user': return 'Someone in your organisation';
    default: return 'System';
  }
}
