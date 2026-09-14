/**
 * NETWORK EDITION — partner compliance-surface availability, failing closed.
 *
 * The prime's edition asks the server (`aml-reliance`,
 * `get_partner_surface_availability`) whether this portal's compliance page
 * exists and whether the Compliance Passport is served onto it — through
 * `invokeSecureFunction`, which is a per-clone credential path the network
 * frontend must not carry.
 *
 * The network holds no AML workspace of its own yet: compliance reads arrive
 * with the E4 settlement (extraction plan §4), where the network BROKERS the
 * read to the clone that owns the case rather than holding AML tables itself.
 * When that lands, this module is where the brokered availability read goes —
 * same exported surface, a real transport behind it.
 *
 * Until then every reading is the prime's own UNKNOWN shape: `enabled` false,
 * `unknown` true, `loading` false (nothing is in flight, so nothing may spin
 * forever). The rules this preserves are the prime's, learned the hard way:
 *
 *   - Fail closed for NAVIGATION: an entry is a claim that a page will open,
 *     so a door that cannot be verified is not drawn.
 *   - "We could not check" is not "you do not have it": `unknown` stays a
 *     distinct answer, so no surface renders "not enabled" as a fact.
 *   - Pages never gate on this — the server refuses in its own words. That
 *     rule needs no code here; it is why returning `enabled: false` cannot
 *     hide a page, only a nav entry.
 */

export type WorkspaceSurfaceKey = "finance" | "builder" | "solicitor";

export interface SurfaceAvailability {
  /** The compliance page exists at all. */
  compliancePage: boolean;
  /** The Compliance Passport document is served onto it. */
  passportView: boolean;
  /** True when no reading could be obtained — safe, but not KNOWN. */
  unknown: boolean;
}

const UNKNOWN: SurfaceAvailability = {
  compliancePage: false, passportView: false, unknown: true,
};

function useAvailability(_surface: WorkspaceSurfaceKey): {
  loading: boolean; availability: SurfaceAvailability;
} {
  // No transport exists yet, so the answer is immediate and honest:
  // not loading, not known. See the module header for where the real
  // brokered read lands.
  return { loading: false, availability: UNKNOWN };
}

/**
 * Does this portal have a compliance page at all?
 *
 * `enabled` is the gate for a NAVIGATION entry — an entry that leads nowhere
 * is worse than none. A PAGE should not gate on it: the server refuses the
 * workspace operations on its own and says so in its own words.
 */
export function usePartnerWorkspaceEnabled(surface: WorkspaceSurfaceKey): {
  loading: boolean; enabled: boolean; unknown: boolean;
} {
  const { loading, availability } = useAvailability(surface);
  return { loading, enabled: availability.compliancePage, unknown: availability.unknown };
}

/**
 * Whether ANY partner portal serves the Compliance Passport. `null` when it
 * could not be told — which, with no transport, is always. Neither is the
 * same as "off", and a caller says nothing rather than something false.
 */
export function useAnyPartnerWorkspaceEnabled(): { loading: boolean; enabled: boolean | null } {
  const builder = useAvailability("builder");
  if (builder.loading) return { loading: true, enabled: null };
  return { loading: false, enabled: null };
}

/** `aml_partner_passport_view`, for one surface. */
export function usePassportViewInPortalEnabled(surface: WorkspaceSurfaceKey = "builder"): {
  loading: boolean; enabled: boolean;
} {
  const { loading, availability } = useAvailability(surface);
  return { loading, enabled: availability.passportView };
}
