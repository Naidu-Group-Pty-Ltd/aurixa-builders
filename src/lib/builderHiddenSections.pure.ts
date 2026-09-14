/**
 * SECTIONS WITHDRAWN FROM THE BUILDER / DEVELOPER PORTAL.
 *
 * Five sections are not offered to builders: Inventory, Transactions,
 * Pipeline, Construction and Documents. This is the one place that says so.
 *
 * ## Why a list and not five edits
 *
 * A section is reachable from more places than its sidebar entry, and every
 * one of them is a separate file: the nav array, the route table, the
 * dashboard's schedule figures, the delivery-attention list, and the
 * onboarding tour's step anchors. Removing the entry alone leaves four
 * working doors and a tour that points at an element the page no longer
 * draws — which is how "hidden" comes to mean "hidden from the sidebar".
 *
 * So the set is named once and every surface asks it. Re-offering a section
 * is deleting one line here.
 *
 * ## Hiding is not deleting
 *
 * The pages, their queries and their edge functions are untouched, and the
 * routes stay DECLARED — a withdrawn path resolves, inside the portal's own
 * chrome, to a notice saying the section is not part of this portal. A route
 * that stops existing sends a bookmark to the dashboard with no explanation,
 * which reads as a broken link rather than a decision.
 *
 * ## What this is NOT
 *
 * It is presentation and routing, not authorisation. The builder portal's
 * edge functions still enforce exactly what they enforced before, and
 * nothing here is a security boundary — a withheld section is withheld
 * because it is not offered, not because the data would otherwise leak. If
 * these sections must become genuinely inaccessible, that belongs in the
 * server's permission matrix, not in a client-side list.
 */

export interface WithdrawnBuilderSection {
  /** The section's own key — matches the tour's `data-tour` anchor. */
  key: string;
  /** The path prefix it owns, without a trailing slash. */
  path: string;
  /** What it was called, for the notice and for tests. */
  label: string;
}

/**
 * The withdrawn set. A path prefix rather than an exact path, because each
 * of these owns children — `construction/:id/delivery` and
 * `inventory/:unitId` are inside the section, not beside it.
 */
export const WITHDRAWN_BUILDER_SECTIONS: readonly WithdrawnBuilderSection[] = [
  { key: 'inventory', path: '/builder/inventory', label: 'Inventory' },
  { key: 'transactions', path: '/builder/transactions', label: 'Transactions' },
  { key: 'pipeline', path: '/builder/pipeline', label: 'Pipeline' },
  { key: 'construction', path: '/builder/construction', label: 'Construction' },
  { key: 'documents', path: '/builder/documents', label: 'Documents' },
] as const;

/** Just the keys — what the tour filters its steps by. */
export const WITHDRAWN_BUILDER_SECTION_KEYS: readonly string[] =
  WITHDRAWN_BUILDER_SECTIONS.map((section) => section.key);

/**
 * Whether a path sits inside a withdrawn section.
 *
 * Prefix matching is deliberate and bounded: the prefix must be followed by
 * the end of the path or a `/`, so `/builder/documents` and
 * `/builder/documents/3` both match while a hypothetical
 * `/builder/documentsomething` does not. Getting that wrong in the other
 * direction — a bare `startsWith` — would withdraw a sibling section that
 * merely shares an opening.
 */
export function isWithdrawnBuilderPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return WITHDRAWN_BUILDER_SECTIONS.some(
    ({ path }) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** The section a path belongs to, or null where it belongs to none. */
export function withdrawnSectionForPath(
  pathname: string | null | undefined,
): WithdrawnBuilderSection | null {
  if (!pathname) return null;
  return (
    WITHDRAWN_BUILDER_SECTIONS.find(
      ({ path }) => pathname === path || pathname.startsWith(`${path}/`),
    ) ?? null
  );
}
