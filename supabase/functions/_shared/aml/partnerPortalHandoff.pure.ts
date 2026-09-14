/**
 * "Open it in your portal" — the handoff from an emailed link to a portal.
 *
 * ── What this is for ──────────────────────────────────────────────────
 * A partner receives a one-time Passport link by email. If they also hold a
 * portal account, the link is not the only place that record lives: it is on
 * their own AML/CTF Compliance page, signed in, permanently. But nothing
 * told them so, and nothing took them there — so a partner with a portal
 * account still filed an email in case they needed to read it again.
 *
 * This decides two things and nothing else: WHERE that page is for a given
 * partner, and WHETHER offering it would work. Both are facts the server
 * already holds. It performs nothing, authorises nothing, and is never the
 * reason a partner may read anything — `get_partner_compliance_workspace`
 * re-derives the organisation from the portal session and re-checks every
 * rule when they arrive.
 *
 * Three rules carry it.
 *
 * **A door that refuses is worse than no door.** The offer appears only when
 * the surface is enabled AND the organisation has an active membership
 * somebody could sign in with. Sending a partner to a page that answers
 * "your account is not enrolled" is a worse experience than the link they
 * already have, and it looks like the product is broken rather than
 * unconfigured.
 *
 * **A deep link is a destination, never a credential.** The path carries a
 * `partner_case_link_id`, which identifies a matter and grants nothing: the
 * portal session decides what may be read, and a link id belonging to
 * another organisation resolves to "not found" for the signed-in partner.
 * The Passport token must never appear in a portal URL — a bearer token in a
 * browser address bar survives in history, referrers and screenshots.
 *
 * **There is no Developer Portal.** Developer-type organisations are served
 * by the Builder surface, and that mapping lives here rather than being
 * re-derived at each call site — the absence of a standalone portal must
 * fail into "the Builder page" and never into a route that 404s.
 */

export type HandoffPortalType = "finance" | "builder" | "developer" | "solicitor_conveyancer";

export interface PortalRoute {
  /** The portal surface that serves this organisation type. */
  surface: "finance" | "builder" | "solicitor_conveyancer";
  /** The compliance page's path. */
  path: string;
  /** Where an unauthenticated visitor is sent, and returned from. */
  loginPath: string;
  /** What the partner calls it. */
  label: string;
}

export const PORTAL_ROUTES: Record<HandoffPortalType, PortalRoute> = {
  finance: {
    surface: "finance",
    path: "/finance/compliance",
    loginPath: "/finance/login",
    label: "Finance Portal",
  },
  builder: {
    surface: "builder",
    path: "/builder/compliance",
    loginPath: "/builder/login",
    label: "Builder / Developer Portal",
  },
  /* One shared portal. A developer organisation is served by the Builder
     surface — there is no `/developer` route to send anybody to. */
  developer: {
    surface: "builder",
    path: "/builder/compliance",
    loginPath: "/builder/login",
    label: "Builder / Developer Portal",
  },
  solicitor_conveyancer: {
    surface: "solicitor_conveyancer",
    path: "/solicitor/compliance",
    loginPath: "/solicitor/login",
    label: "Solicitor & Conveyancer Portal",
  },
};

/** The per-surface flag that must be on for the page to exist. */
export const SURFACE_FLAG: Record<PortalRoute["surface"], string> = {
  finance: "aml_partner_workspace_finance",
  builder: "aml_partner_workspace_builder",
  solicitor_conveyancer: "aml_partner_workspace_solicitor",
};

export interface HandoffFacts {
  /** The arrangement's organisation type. `other` and unknown mean no portal. */
  partnerOrgType: string | null;
  /** The matter to open. Omitted when the grant predates partner links. */
  partnerCaseLinkId?: string | null;
  /** Master + surface + `aml_partner_passport_view`, resolved by the caller. */
  surfaceEnabled: boolean;
  /** At least one ACTIVE membership exists for this organisation. */
  hasActiveMembership: boolean;
}

export interface PortalHandoff {
  /** Whether to offer it at all. */
  available: boolean;
  portalType: HandoffPortalType | null;
  label: string | null;
  /** Relative path including the matter, or null when unavailable. */
  path: string | null;
  /** Absolute URL, when the caller supplied an origin. */
  url?: string | null;
  /**
   * Why it is not offered. Internal — for the Command Centre and the logs,
   * never rendered to a partner: "your organisation has no enrolled portal
   * account" is our configuration, not their business.
   */
  reason: "no_portal" | "surface_disabled" | "not_enrolled" | null;
}

export function portalHandoff(facts: HandoffFacts, origin?: string | null): PortalHandoff {
  const type = (facts.partnerOrgType ?? "") as HandoffPortalType;
  const route = PORTAL_ROUTES[type];
  if (!route) {
    // `other` is a real and common answer: a partner outside every portal
    // reads the Passport from the link, which is why the link exists.
    return { available: false, portalType: null, label: null, path: null, url: null, reason: "no_portal" };
  }
  const base = { portalType: type, label: route.label };
  if (!facts.surfaceEnabled) {
    return { ...base, available: false, path: null, url: null, reason: "surface_disabled" as const };
  }
  if (!facts.hasActiveMembership) {
    return { ...base, available: false, path: null, url: null, reason: "not_enrolled" as const };
  }
  /* The matter, as an identifier and never as an authority. Omitted rather
     than faked when the grant predates partner links — the page then selects
     the organisation's only active matter, or asks. */
  const path = facts.partnerCaseLinkId
    ? `${route.path}?matter=${encodeURIComponent(facts.partnerCaseLinkId)}`
    : route.path;
  return {
    ...base,
    available: true,
    path,
    url: origin ? `${origin.replace(/\/+$/, "")}${path}` : null,
    reason: null,
  };
}

/**
 * Where an unauthenticated visitor is sent, and how they come back.
 *
 * The portals disagreed about this and two of them lost the destination:
 * the Builder guard recorded `location.pathname` and dropped the query
 * string, then its login ignored the record entirely and always landed on
 * the dashboard; the Solicitor guard recorded nothing at all. So a deep link
 * into a compliance page became "you are now signed in, somewhere else" —
 * which is indistinguishable from a broken link.
 *
 * One rule, one implementation: the destination is `pathname + search`, it is
 * carried through the login, and it is only ever an internal path.
 */
export function returnToPath(pathname: string, search: string): string {
  return `${pathname}${search ?? ""}`;
}

/**
 * A destination is honoured only when it is a path on THIS origin.
 *
 * An open redirect on a login page is a phishing primitive: a partner who
 * has just typed their password is exactly the person you can send anywhere.
 * Anything absolute, protocol-relative, or not starting with a single `/` is
 * refused and the caller's default is used instead.
 */
export function safeReturnTo(candidate: unknown, fallback: string): string {
  if (typeof candidate !== "string") return fallback;
  const value = candidate.trim();
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;          // protocol-relative
  if (value.startsWith("/\\")) return fallback;         // backslash smuggling
  // Control characters and whitespace never appear in a route we issued.
  if (/[\u0000-\u0020\u007f]/.test(value)) return fallback;
  return value;
}
