/**
 * Browser mirror of the portal handoff rules.
 *
 * The implementation lives in `supabase/functions/_shared/aml/` — the same
 * file the edge function executes — so the destination the server advertises
 * and the route the portals actually serve cannot drift. The browser never
 * decides whether a handoff is AVAILABLE: that arrives on the server's
 * response.
 */
export {
  PORTAL_ROUTES,
  SURFACE_FLAG,
  portalHandoff,
  returnToPath,
  safeReturnTo,
  type HandoffFacts,
  type HandoffPortalType,
  type PortalHandoff,
  type PortalRoute,
} from "../../../supabase/functions/_shared/aml/partnerPortalHandoff.pure";
