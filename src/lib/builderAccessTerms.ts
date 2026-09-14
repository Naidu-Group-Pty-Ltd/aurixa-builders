/**
 * User-facing vocabulary for the record the database calls a *membership*.
 *
 * The stored concept does not change. `builder_organisation_memberships`,
 * `membership_role`, `membership_id`, `upsert_membership`,
 * `revoke_membership`, `delete_membership`, `get_membership_permissions` and
 * every request and response field keep their names — this module never
 * touches them. What administrators and portal users *read* is "organisation
 * access", because that is what the record actually controls: which company
 * workspace a portal user may enter, and with what authority.
 *
 * Everything here is presentation. Nothing reaches the network, resolves a
 * permission or decides anything; it maps stored values to words. Shared by the
 * Builder Portal and the Command Centre admin surface so the two cannot drift,
 * the same way `builderWorkspace.ts` shares its domain constants.
 */

/**
 * Display labels for the stored `membership_role` values. The keys are the
 * values the server stores and resolves permissions against; only the right
 * side is presentation, and changing it grants nothing.
 */
export const ACCESS_ROLE_LABELS: Record<string, string> = {
  owner: 'Organisation Owner',
  administrator: 'Organisation Administrator',
  manager: 'Manager',
  member: 'Standard User',
  read_only: 'Read Only',
};

/**
 * The role catalogue in the order it is offered, most authority first. The
 * `value` is the stored role and must match the server's catalogue exactly.
 */
export const ACCESS_ROLE_OPTIONS = [
  { value: 'owner', label: ACCESS_ROLE_LABELS.owner },
  { value: 'administrator', label: ACCESS_ROLE_LABELS.administrator },
  { value: 'manager', label: ACCESS_ROLE_LABELS.manager },
  { value: 'member', label: ACCESS_ROLE_LABELS.member },
  { value: 'read_only', label: ACCESS_ROLE_LABELS.read_only },
] as const;

/**
 * A stored role as a reader should see it. An unmapped role falls back to the
 * humanised stored value rather than being hidden, so a role added server-side
 * still renders truthfully instead of disappearing.
 */
export function accessRoleLabel(role: string | null | undefined): string {
  if (!role) return 'No access role';
  return ACCESS_ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

/**
 * Two server messages are known, safe and about organisation access. They are
 * translated into the portal's vocabulary; everything else is shown exactly as
 * the server wrote it.
 *
 * This is a lookup, not a rewriter: no pattern matching over arbitrary error
 * text, no change to any error code, and no change to what the server sends.
 */
const KNOWN_ACCESS_MESSAGES: Record<string, string> = {
  'Grant this user an organisation membership before inviting them.':
    'Grant this user organisation access before inviting them.',
  'You do not have an active organisation membership. Please contact your administrator.':
    'You do not have active organisation access. Please contact your administrator.',
};

/** Returns the translation when the message is one of the two recognised ones. */
export function accessErrorMessage(message: string | null | undefined): string {
  if (!message) return '';
  return KNOWN_ACCESS_MESSAGES[message.trim()] ?? message;
}
