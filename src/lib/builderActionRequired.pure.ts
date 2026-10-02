/**
 * WHAT NEEDS THIS BUILDER'S ACTION.
 *
 * The dashboard carried a card headed "Project delivery attention". Two things
 * were wrong with it and only one was the wording.
 *
 * The wording: this portal is not a project-delivery console. A builder lists
 * stock, answers the agencies that activate it, and keeps their own projects
 * current — "project delivery" is vocabulary from the module the portal was
 * extracted from, and it told a reader nothing about what to do.
 *
 * The contents: it was three rows of `builder_workspace_summary` — open
 * defects, overdue tasks, unread messages — which on 2 October 2026 read 0, 0,
 * 0 for every user in the database, while the states a builder genuinely has
 * to act on were counted nowhere: an activation waiting to be acknowledged,
 * and a property the marketplace is holding back because its photograph could
 * not be found. Open defects could never appear at all, because Construction
 * is withdrawn from this portal and the row's own door led to a notice.
 *
 * ## The rule
 *
 * An item is listed only where the product ALREADY holds a state that this
 * user can act on, and every item names the act, the count, and where the act
 * is performed. Nothing here invents a rule, infers urgency or counts a record
 * twice, and an informational event — a notification, somebody else's change —
 * is not an action and is not listed.
 *
 * Scope comes entirely from the reads: every figure is organisation-scoped by
 * the session, so this module holds no organisation, user or record id, and a
 * count of zero is "nothing you can reach", not "nothing exists". An item
 * whose destination is a withdrawn section is dropped rather than drawn,
 * exactly as the dashboard's figures are, so re-offering a section brings its
 * item back without a second edit.
 */
import { isWithdrawnBuilderPath } from './builderHiddenSections.pure';

export interface ActionRequiredItem {
  key: string;
  /** What is outstanding, in the portal's own words. */
  label: string;
  /** Why it needs this person, said once. */
  detail: string;
  count: number;
  /** Where the act is performed — never a page that merely mentions it. */
  to: string;
}

/**
 * The facts the surfaces already read. Every field is optional because a
 * deployment mid-migration, a failed read or an older server answers some of
 * them and not others, and a missing fact must drop its row rather than
 * invent a zero that reads as "nothing to do".
 */
export interface ActionRequiredFacts {
  /** `builder_workspace_summary`: tasks past their due date on reachable records. */
  overdueTasks?: number | null;
  /** `builder_workspace_summary`: messages the reader has not opened. */
  unreadMessages?: number | null;
  /** Activations announced and not yet acknowledged by this organisation. */
  activationsAwaitingAcknowledgement?: number | null;
  /** Properties whose photograph the pipeline has exhausted; a builder supplies one. */
  propertiesNeedingAPicture?: number | null;
}

/*
 * A JOIN REQUEST IS DELIBERATELY NOT HERE. It is a real outstanding act, and
 * it is an OWNER's or administrator's: `builderListJoinRequests` refuses
 * anybody else, so feeding it from a surface every member opens would put a
 * refused request on every dashboard load and a row most readers could not
 * act on. It keeps its own card, where the permission is already resolved.
 */

const count = (value: number | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The outstanding acts, most immediate first. An act someone else must perform
 * is not in it, and neither is a figure that is merely non-zero: each row below
 * corresponds to a control this portal offers the reader.
 */
export function actionRequiredItems(facts: ActionRequiredFacts): ActionRequiredItem[] {
  const activations = count(facts.activationsAwaitingAcknowledgement);
  const pictures = count(facts.propertiesNeedingAPicture);
  const overdue = count(facts.overdueTasks);
  const unread = count(facts.unreadMessages);

  return [
    {
      key: 'activations',
      label: `${activations} ${plural(activations, 'activation', 'activations')} to acknowledge`,
      detail: 'An agency activated your property for a client and is waiting on you.',
      count: activations,
      to: '/builder/stock',
    },
    {
      key: 'pictures',
      label: `${pictures} ${plural(pictures, 'property', 'properties')} waiting for a picture`,
      detail: 'These are held off the marketplace until a photograph is added.',
      count: pictures,
      to: '/builder/stock',
    },
    {
      key: 'overdue-tasks',
      label: `${overdue} overdue ${plural(overdue, 'task', 'tasks')}`,
      detail: 'Past the date they were due on records you can reach.',
      count: overdue,
      to: '/builder/tasks',
    },
    {
      key: 'unread-messages',
      label: `${unread} unread ${plural(unread, 'message', 'messages')}`,
      detail: 'An agency has written to you about a property they activated.',
      count: unread,
      to: '/builder/messages',
    },
  ].filter((item) => item.count > 0 && !isWithdrawnBuilderPath(item.to));
}

export const ACTION_REQUIRED_TITLE = 'Action required';
export const ACTION_REQUIRED_DESCRIPTION =
  'Items that need your attention across this workspace.';
export const ACTION_REQUIRED_EMPTY = 'Nothing needs your attention right now.';
