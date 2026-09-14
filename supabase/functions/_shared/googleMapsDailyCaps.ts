/**
 * The daily ceiling on paid Google Maps Platform requests, in one place.
 *
 * This is **not a second metering system**. It is the existing one —
 * `enforceGlobalDailyQuota` from `publicAbuseControls.ts`, backed by the
 * `security_consume_rate_limit` RPC — named once so that every billable caller
 * consumes the same allowance under the same vocabulary.
 *
 * ## The unit, measured rather than assumed
 *
 * The primitive's semantics were read off the deployed function:
 *
 *  * `security_consume_rate_limit` increments by **exactly one per call**
 *    (`count = limits.count + 1`), so **one unit is one outbound request**, and
 *    it must be consumed once immediately before each one. A caller that made
 *    several billable requests behind a single check would have a ceiling that
 *    under-counts the bill by that factor.
 *  * The allow test is `count <= p_max`: a ceiling of 250 admits the 250th
 *    request and refuses the 251st.
 *  * The window is **fixed, not calendar**. `window_start` is stamped on first
 *    use and reset only once it is older than the window, so "250/day" means
 *    250 per rolling 24h from first use — at least as conservative as a
 *    calendar day.
 *  * The key is `public:global:<scope>:daily`, regex-checked
 *    `^[a-z0-9:_./-]{1,200}$`. An invalid scope RAISES, which would turn a
 *    ceiling into a 500 on every request rather than a refusal.
 *
 * ## Scopes follow Google's BILLING SKUs, not its API families
 *
 * Places Nearby Search and Places Autocomplete are separate SKUs at separate
 * prices, and putting them in one bucket means a busy address field can spend
 * the allowance a report's amenity lookups need. One scope per billable SKU is
 * what makes each configured number mean something on its own.
 *
 * Geocoding is the opposite case and the rule is the same: **one SKU, one
 * budget.** Four call sites geocode (`location-intelligence-service`,
 * `resolve-listing-coordinates`, `parse-property-pdf`,
 * `builderStock/images.ts`) and Google bills them together, so they share
 * `google_geocoding`. A per-function bucket would make
 * `GOOGLE_GEOCODING_DAILY_LIMIT` mean "N times however many functions happen
 * to geocode", which is not a ceiling anybody can reason about.
 *
 * Circuit-breaker scopes are a **different axis** and are deliberately left
 * alone: `resolve-listing-coordinates` keeps `google_listing_geocoding` for
 * its breaker, because a breaker is about one caller's error rate while a
 * budget is about the account's spend.
 *
 * ## Fail closed — this is a spending boundary, not abuse control
 *
 * `consumeQuota` falls back to a **per-isolate** counter when the shared RPC
 * is unavailable, and flags it `degraded`. That trade-off is right for abuse
 * control (see `publicAbuseControls`' header: disabling a working feature is
 * the more expensive failure) and **wrong here**. Edge Functions scale
 * horizontally, so a per-isolate counter is not a product-wide ceiling — under
 * the exact fault the ceiling exists for, spend would be unbounded.
 *
 * So a degraded limiter **refuses the paid request**. The general abuse-control
 * behaviour for the rest of Aurixa is untouched; only this wrapper fails
 * closed.
 *
 * ## A ceiling may never invent a value
 *
 * Refusal is not a fallback. Every caller routes a refusal into the path it
 * already uses for a provider that did not answer, so the measured field
 * becomes unavailable and the report omits the claim. `rentalEvidence`'s rule
 * — absent is never zero — applied to spend: **cost safety must never create
 * false data.**
 */
import { enforceGlobalDailyQuota } from './publicAbuseControls.ts';

/** One scope per Google billable SKU. */
export const GOOGLE_CAP_SCOPES = {
  geocoding: 'google_geocoding',
  placesNearby: 'google_places_nearby',
  placesAutocomplete: 'google_places_autocomplete',
  distanceMatrix: 'google_distance_matrix',
  /**
   * Street View imagery. Metadata is FREE and is counted here with it — a
   * deliberate over-count, because the alternative is a second counter for a
   * SKU that costs nothing, and over-counting spend is the safe direction.
   */
  streetView: 'google_street_view',
  staticMaps: 'google_static_maps',
} as const;

export type GoogleCapKind = keyof typeof GOOGLE_CAP_SCOPES;

/**
 * Defaults chosen to stay under Google's monthly free usage thresholds with
 * room for month-boundary timing — **not** for throughput, and never as a step
 * towards a paid Maps plan. Ordinary pay-as-you-go with the application
 * refusing before the free allowance is spent.
 *
 * Places Nearby is the tightest because it is what actually limits report
 * throughput: one location enrichment is 1 geocode + 6 Nearby + 1 Distance
 * Matrix (the ledger's exact 6:1 ratio confirms it), so 150 admits ~25
 * enrichments a day against a corpus that created 32 reports in thirty.
 */
const CAP_DEFAULTS: Record<GoogleCapKind, number> = {
  geocoding: 250,
  placesNearby: 150,
  placesAutocomplete: 250,
  distanceMatrix: 250,
  streetView: 250,
  staticMaps: 250,
};

/**
 * The environment name per SKU.
 *
 * Every one of these is declared on the **existing** Google Maps Platform
 * integration card so an operator can see and set it. A runtime ceiling that
 * exists only in code is hidden configuration.
 */
const CAP_ENV: Record<GoogleCapKind, string> = {
  geocoding: 'GOOGLE_GEOCODING_DAILY_LIMIT',
  placesNearby: 'GOOGLE_PLACES_NEARBY_DAILY_LIMIT',
  placesAutocomplete: 'GOOGLE_PLACES_AUTOCOMPLETE_DAILY_LIMIT',
  distanceMatrix: 'GOOGLE_DISTANCE_MATRIX_DAILY_LIMIT',
  streetView: 'GOOGLE_STREET_VIEW_DAILY_LIMIT',
  staticMaps: 'GOOGLE_STATIC_MAPS_DAILY_LIMIT',
};

/**
 * `GOOGLE_PLACES_DAILY_LIMIT` was the single Places ceiling and its only
 * consumer was autocomplete. Splitting the SKUs must not silently discard a
 * value an operator has already set, so the old name still answers for
 * autocomplete when the new one is unset. Nearby has no legacy name because it
 * never had a ceiling at all.
 */
const CAP_ENV_LEGACY: Partial<Record<GoogleCapKind, string>> = {
  placesAutocomplete: 'GOOGLE_PLACES_DAILY_LIMIT',
};

/** Per-SKU kill switches, in the shape `killSwitchActive` already reads. */
const CAP_KILL_SWITCH: Record<GoogleCapKind, string> = {
  geocoding: 'GOOGLE_GEOCODING_KILL_SWITCH',
  placesNearby: 'GOOGLE_PLACES_KILL_SWITCH',
  placesAutocomplete: 'GOOGLE_PLACES_KILL_SWITCH',
  distanceMatrix: 'GOOGLE_DISTANCE_MATRIX_KILL_SWITCH',
  streetView: 'GOOGLE_STREET_VIEW_KILL_SWITCH',
  staticMaps: 'GOOGLE_STATIC_MAPS_KILL_SWITCH',
};

/** Every environment name this module reads, for the registry's declaration. */
export const GOOGLE_CAP_ENV_NAMES: readonly string[] = [
  ...Object.values(CAP_ENV),
  ...Object.values(CAP_ENV_LEGACY).filter((n): n is string => Boolean(n)),
  ...new Set(Object.values(CAP_KILL_SWITCH)),
];

/**
 * The configured ceiling, or the default.
 *
 * A value that is not a positive integer is the default rather than an error:
 * a typo must not uncap a paid provider, and must not disable a working
 * feature either.
 */
export function dailyCapFor(kind: GoogleCapKind, env: (k: string) => string | undefined): number {
  for (const name of [CAP_ENV[kind], CAP_ENV_LEGACY[kind]]) {
    if (!name) continue;
    const raw = Number(env(name));
    if (Number.isInteger(raw) && raw > 0) return raw;
  }
  return CAP_DEFAULTS[kind];
}

/**
 * Why a paid request was not made.
 *
 * Three distinct operational facts, kept distinct: somebody turned the
 * provider off; the day's allowance is spent; the shared limiter cannot be
 * reached so the ceiling cannot be enforced. They send an operator to three
 * different places. **None of them may be paraphrased into client-facing
 * prose** — a report says the measurement is unavailable and omits the claim;
 * the reason lives in logs.
 */
export type GoogleCapRefusal = 'kill_switch' | 'daily_cap' | 'limiter_unavailable';

export interface CapVerdict {
  ok: boolean;
  reason?: GoogleCapRefusal;
}

const ALLOWED: CapVerdict = { ok: true };

/**
 * What a caller may say OUT LOUD about a refusal.
 *
 * The three internal reasons are three different operational facts and stay
 * distinct in logs. Only one of them is "you have used your allowance for
 * today"; a provider somebody switched off and a shared counter that cannot be
 * reached are both **availability**, and reporting either as an exhausted quota
 * is simply untrue — it tells an operator to wait until tomorrow for a state
 * that waiting will not clear.
 *
 * `temporarily_unavailable` and `daily_quota_exceeded` are both existing codes
 * at these call sites; nothing new is introduced.
 */
export type GoogleCapClientStatus = 'daily_quota_exceeded' | 'temporarily_unavailable';

export function clientStatusFor(reason: GoogleCapRefusal | undefined): GoogleCapClientStatus {
  return reason === 'daily_cap' ? 'daily_quota_exceeded' : 'temporarily_unavailable';
}

/**
 * The HTTP reading of the same distinction.
 *
 * 429 says "you have asked too often, try later" and is true of an exhausted
 * allowance. 503 says "this is not available right now", which is what a
 * switched-off provider and an unreadable counter actually are. Owned here so
 * a caller never spells either literal and the two readings cannot drift apart.
 */
export function clientHttpStatusFor(reason: GoogleCapRefusal | undefined): 429 | 503 {
  return reason === 'daily_cap' ? 429 : 503;
}

/**
 * The same distinction as prose, for a status a person or a record will read.
 *
 * Neither sentence names a vendor, a configuration key, a limit or a piece of
 * infrastructure — a persisted `error_message` outlives the incident and is
 * read by people who were not there.
 */
export function clientMessageFor(reason: GoogleCapRefusal | undefined): string {
  return reason === 'daily_cap'
    ? 'The daily allowance for this kind of lookup has been used. It resets automatically.'
    : 'This lookup is temporarily unavailable.';
}

/**
 * Consume one unit of the daily allowance for ONE outbound Google request.
 *
 * Call it immediately before the request, once per request. A unit consumed
 * and then not spent is a ceiling that drifts below the bill; a request made
 * before consuming is a ceiling that concurrency can step over.
 */
export async function consumeGoogleDailyCap(
  supabase: unknown,
  kind: GoogleCapKind,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): Promise<CapVerdict> {
  // `publicAbuseControls`' `killSwitchActive` reads `Deno.env` itself, so it
  // would ignore the reader injected here — one function reading the
  // environment two ways. The predicate is three comparisons and is repeated
  // rather than reached for, so every value this module consults comes from
  // one place and the boundary can be exercised by a test.
  if (['1', 'true', 'TRUE'].includes(env(CAP_KILL_SWITCH[kind]) ?? '')) {
    return { ok: false, reason: 'kill_switch' };
  }
  const verdict = await enforceGlobalDailyQuota(
    supabase,
    GOOGLE_CAP_SCOPES[kind],
    dailyCapFor(kind, env),
  );
  // Checked BEFORE `ok`, and that order is the whole point: the per-isolate
  // fallback answers `ok: true` for the first N requests of every isolate, so
  // reading `ok` first would let a degraded limiter permit unbounded spend
  // while looking healthy.
  if ((verdict as { degraded?: boolean }).degraded) {
    return { ok: false, reason: 'limiter_unavailable' };
  }
  return verdict.ok ? ALLOWED : { ok: false, reason: 'daily_cap' };
}
