/**
 * Whether one Builder Portal navigation entry is drawn.
 *
 * Presentation only — every request behind an entry is re-authorised on the
 * server. An entry that names a `permission` is drawn only for a user whose
 * server-resolved matrix already grants `view` on that key, so a door is not
 * offered to somebody the page behind it would refuse. Entries without one
 * are exactly as visible as they always were.
 */
export interface BuilderNavVisibilityItem {
  to: string;
  label: string;
  /** The organisation permission key this destination is read under. */
  permission?: string;
  complianceGated?: boolean;
}

export function builderNavItemVisible(
  item: BuilderNavVisibilityItem,
  context: {
    can: (permissionKey: string, level: 'view' | 'edit' | 'delete') => boolean;
    showCompliance: boolean;
  },
): boolean {
  if (item.complianceGated && !context.showCompliance) return false;
  if (item.permission && !context.can(item.permission, 'view')) return false;
  return true;
}
