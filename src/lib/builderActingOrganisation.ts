/**
 * THE ORGANISATION THIS TAB BELIEVES IT IS ACTING AS.
 *
 * A module-level variable ON PURPOSE: it lives in this tab's own JavaScript
 * heap, so a second tab has its own copy. `localStorage` would be wrong here —
 * it is shared across tabs, so a stale tab would read the identity the NEW
 * login wrote, agree with the hijacked cookie, and the guard would pass, which
 * is precisely the defect it exists to stop.
 *
 * WHY IT EXISTS. `__Host-builder_session_token` is one cookie name per origin,
 * and the `__Host-` prefix pins it to Path=/ with no Domain — so a browser
 * holds exactly one builder session. Signing into a second builder account
 * REPLACES the first tab's token and tells that tab nothing: it keeps
 * rendering the previous organisation's name and stock while every request it
 * sends carries the new account's credential. REPORTED AND CONFIRMED
 * 12 SEPTEMBER 2026 — a stock list uploaded from a page headed with one
 * organisation was filed under a different one. The server was right at every
 * step; the page was lying about who it was.
 *
 * It is sent as `expected_organisation_id` so the server can REFUSE a write
 * whose organisation is not the one the operator was looking at. It may only
 * ever refuse — the scope itself still comes from the session, so a forged
 * value cannot widen anything.
 *
 * Its own module rather than a member of `builderPortal.ts` so that the many
 * suites which mock that module keep working unchanged; a mock that has to
 * grow every time an unrelated export appears is a mock that goes stale.
 */
let actingOrganisationId: string | null = null;

export function setActingOrganisation(organisationId: string | null): void {
  actingOrganisationId = organisationId;
}

export function actingOrganisation(): string | null {
  return actingOrganisationId;
}
