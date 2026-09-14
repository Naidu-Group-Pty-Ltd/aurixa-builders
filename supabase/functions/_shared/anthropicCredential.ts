/**
 * Obtaining the credential `anthropicRoute.pure.ts` decided on.
 *
 * This is the half that touches the world: it reads the environment, and
 * where the deployment federates it exchanges a Mission Control identity
 * token for a short-lived, workspace-scoped Anthropic access token and keeps
 * it until it is nearly spent.
 *
 * ## Why there is a federated path at all
 *
 * Anthropic will not create an API key through its API — the Console is the
 * only place a key comes from — so the per-clone credential the other four
 * model vendors get cannot exist here. Workload Identity Federation is the
 * way around that: Mission Control is registered as an OIDC issuer, it signs
 * a short-lived assertion naming ONE clone, and Anthropic exchanges that for
 * an access token bound to that clone's own service account and workspace.
 * No `sk-ant-api…` string is ever minted, distributed or stored on a clone.
 *
 * The exchange is the only thing Mission Control is on the path of. Inference
 * itself goes clone → Anthropic directly, because model calls are the highest
 * volume vendor traffic in this product, they stream, and they run against a
 * ~150s edge ceiling — putting a broker in front of every report generation
 * would buy a new failure domain and nothing else.
 *
 * ## Four rules
 *
 * **A key present is always used.** Enforced in the pure module, restated
 * here because it is the rule that protects a tenant who supplied their own
 * credential from being billed by us anyway.
 *
 * **One exchange, however many callers.** A report generation fans out; an
 * unguarded refresh would run the exchange once per concurrent section, and
 * an identity token carrying a `jti` is accepted exactly once — so the
 * second and every later exchange would fail with `jti_reused` and the
 * failure would look like an outage. `inFlight` is that guard.
 *
 * **A refresh that fails does not discard a token that still works.** The
 * advisory refresh at expiry − 120s may fail silently and serve the cached
 * token; only past the mandatory point is the cache cleared. That is
 * `botocore`'s two-tier schedule and Anthropic's SDKs use it for the same
 * reason: a momentary failure at the token endpoint must not take inference
 * down with it.
 *
 * **Who refused is read from a header, never guessed from a body.** Mission
 * Control and Anthropic both answer 401 with similar JSON and send an
 * operator to opposite remedies, which is the lesson the verification broker
 * already paid for.
 */

import {
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_TOKEN_URL,
  type AnthropicCredential,
  type AnthropicRoute,
  anthropicRequestHeaders,
  describeAnthropicFailure,
  resolveAnthropicRoute,
} from './anthropicRoute.pure.ts';

export type { AnthropicCredential } from './anthropicRoute.pure.ts';

/** Mission Control's own refusals carry this; what it relays never does. */
const MISSION_CONTROL_REFUSAL_HEADER = 'x-mission-control-refusal';

/** Where a clone asks Mission Control to speak for it. */
export const IDENTITY_PATH = '/api/public/anthropic/identity';

/** Refresh once the token is this close to expiry, serving the cached one if it fails. */
const ADVISORY_REFRESH_MS = 120_000;

/** Past this, a failed exchange is an error rather than a cached answer. */
const MANDATORY_REFRESH_MS = 30_000;

const EXCHANGE_TIMEOUT_MS = 15_000;

export type CredentialResult =
  | { ok: true; credential: AnthropicCredential; via: 'api_key' | 'federated' }
  | { ok: false; why: string; end: 'unconfigured' | 'mission_control' | 'anthropic' };

interface CachedToken {
  value: string;
  workspaceId: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inFlight: Promise<CredentialResult> | null = null;

/** Test seam: forget any cached token. Never called in production. */
export function resetAnthropicCredentialCache(): void {
  cached = null;
  inFlight = null;
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // A function running without env permission is a configuration fault, not
    // a reason to throw out of a credential read.
    return undefined;
  }
}

/** How this deployment is configured to reach Anthropic. */
export function anthropicRoute(): AnthropicRoute {
  return resolveAnthropicRoute({
    apiKey: env('ANTHROPIC_API_KEY'),
    workspaceId: env('ANTHROPIC_WORKSPACE_ID'),
    missionControlUrl: env('MISSION_CONTROL_URL'),
    cloneApiKey: env('MISSION_CONTROL_CLONE_API_KEY'),
  });
}

/**
 * Whether this deployment can reach Anthropic at all.
 *
 * Configuration, never reachability — a caller that needs to KNOW should make
 * a call. It exists because several surfaces decide whether to offer a
 * model-backed feature, and they were each reading the key directly, which is
 * what made a federated deployment look like an unconfigured one.
 */
export function anthropicConfigured(): boolean {
  return anthropicRoute().via !== 'unconfigured';
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface IdentityGrant {
  assertion: string;
  organization_id: string;
  service_account_id: string;
  federation_rule_id: string;
  workspace_id: string;
}

async function requestIdentity(
  route: Extract<AnthropicRoute, { via: 'federated' }>,
): Promise<{ ok: true; grant: IdentityGrant } | { ok: false; why: string }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${route.missionControlUrl}${IDENTITY_PATH}`,
      {
        method: 'POST',
        headers: {
          'x-clone-api-key': route.cloneApiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ workspace_id: route.workspaceId }),
      },
      EXCHANGE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ok: false,
      why: `Mission Control could not be reached to obtain an Anthropic identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok) {
    const refusal = response.headers.get(MISSION_CONTROL_REFUSAL_HEADER);
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      why: refusal
        ? `Mission Control refused to issue an Anthropic identity for this deployment: ${refusal}`
        : `Mission Control answered ${response.status} when asked for an Anthropic identity${
          body ? `: ${body.slice(0, 400)}` : ''
        }`,
    };
  }

  let grant: IdentityGrant;
  try {
    grant = (await response.json()) as IdentityGrant;
  } catch {
    return { ok: false, why: 'Mission Control returned an unreadable Anthropic identity' };
  }

  if (
    !grant?.assertion || !grant.organization_id || !grant.service_account_id ||
    !grant.federation_rule_id || !grant.workspace_id
  ) {
    return {
      ok: false,
      why: 'Mission Control returned an incomplete Anthropic identity, so no token could be exchanged',
    };
  }

  return { ok: true, grant };
}

async function exchange(
  route: Extract<AnthropicRoute, { via: 'federated' }>,
  opts?: { readonly cache?: boolean },
): Promise<CredentialResult> {
  const identity = await requestIdentity(route);
  if (!identity.ok) return { ok: false, why: identity.why, end: 'mission_control' };

  const { grant } = identity;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      ANTHROPIC_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: grant.assertion,
          federation_rule_id: grant.federation_rule_id,
          organization_id: grant.organization_id,
          service_account_id: grant.service_account_id,
          workspace_id: grant.workspace_id,
        }),
      },
      EXCHANGE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ok: false,
      end: 'anthropic',
      why: `Anthropic's token endpoint could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      end: 'anthropic',
      why: `Anthropic refused the federated token exchange (${response.status})${
        body ? `: ${body.slice(0, 400)}` : ''
      }`,
    };
  }

  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = await response.json();
  } catch {
    return { ok: false, end: 'anthropic', why: 'Anthropic returned an unreadable token response' };
  }

  const token = (payload.access_token ?? '').trim();
  if (!token) {
    return { ok: false, end: 'anthropic', why: 'Anthropic returned no access token' };
  }

  /*
   * Trust the answer's own lifetime rather than the rule's configured one:
   * Anthropic bounds the minted token at twice the remaining life of the
   * assertion, so it is routinely SHORTER than the rule asks for, and a cache
   * that believed the rule would serve an expired token.
   */
  const lifetimeMs = Math.max(60, Number(payload.expires_in) || 0) * 1000;
  /*
   * A diagnostic exchange is deliberately not banked. `describeAnthropicReach`
   * asks for a FRESH chain, and writing its token here would hand inference a
   * credential obtained for a different purpose — and, worse, let a probe that
   * happened to run first mask a chain that had already broken.
   */
  if (opts?.cache !== false) {
    cached = { value: token, workspaceId: grant.workspace_id, expiresAt: Date.now() + lifetimeMs };
  }

  return {
    ok: true,
    via: 'federated',
    credential: { kind: 'access_token', value: token, workspaceId: grant.workspace_id },
  };
}

/**
 * The credential this request should spend, obtaining one if necessary.
 *
 * Never throws. A caller that cannot proceed renders `why`, which names the
 * end that failed rather than asserting the vendor is down.
 */
export async function resolveAnthropicCredential(): Promise<CredentialResult> {
  const route = anthropicRoute();

  if (route.via === 'unconfigured') {
    return { ok: false, why: route.why, end: 'unconfigured' };
  }

  if (route.via === 'api_key') {
    return {
      ok: true,
      via: 'api_key',
      credential: { kind: 'api_key', value: route.apiKey, workspaceId: route.workspaceId },
    };
  }

  const now = Date.now();

  if (cached && cached.workspaceId === route.workspaceId) {
    if (now < cached.expiresAt - ADVISORY_REFRESH_MS) {
      return {
        ok: true,
        via: 'federated',
        credential: { kind: 'access_token', value: cached.value, workspaceId: cached.workspaceId },
      };
    }

    /*
     * Inside the advisory window: try for a fresh one, but a failure here
     * serves the token we already hold. It is still valid for ~90 seconds,
     * and taking inference down for a momentary token-endpoint failure is the
     * worse outcome by a wide margin.
     */
    if (now < cached.expiresAt - MANDATORY_REFRESH_MS) {
      const servable = cached;
      const refreshed = await runExchange(route);
      if (refreshed.ok) return refreshed;
      return {
        ok: true,
        via: 'federated',
        credential: {
          kind: 'access_token',
          value: servable.value,
          workspaceId: servable.workspaceId,
        },
      };
    }

    // Too close to expiry to serve. Fall through and require a fresh one.
    cached = null;
  }

  return await runExchange(route);
}

/**
 * One exchange at a time.
 *
 * A fan-out (seventeen report sections, four enrichment chapters) would
 * otherwise run one exchange each, and an assertion carrying a `jti` is
 * single-use — so every exchange after the first would be refused
 * `jti_reused` and the whole batch would fail on what is really a success.
 */
function runExchange(route: Extract<AnthropicRoute, { via: 'federated' }>): Promise<CredentialResult> {
  if (inFlight) return inFlight;
  inFlight = exchange(route).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * What a reach probe found. Carries no credential value, ever.
 *
 * `route` is how the deployment is CONFIGURED and `ok` is what happened when
 * it was used — kept apart because they are the two readings this platform
 * keeps collapsing into one green light. A deployment can be configured
 * perfectly and reach nothing.
 */
export interface AnthropicReach {
  /** Before anything was attempted. */
  readonly route: AnthropicRoute['via'];
  /** A real call to Anthropic succeeded. */
  readonly ok: boolean;
  /** Which end refused, when one did. */
  readonly end: 'unconfigured' | 'mission_control' | 'anthropic' | 'workspace' | null;
  readonly why: string | null;
  /** The workspace the call was attributed to, or null where none is held. */
  readonly workspaceId: string | null;
  /** What was spent. Never the value it was spent with. */
  readonly credentialKind: AnthropicCredential['kind'] | null;
  /** How many models the vendor listed — the evidence the call was answered. */
  readonly modelCount: number | null;
  readonly probedAt: string;
}

/**
 * Can this deployment actually reach Anthropic, right now?
 *
 * ## Why it is a call and not a flag
 *
 * `anthropicConfigured()` reads the environment, which is the question
 * "is anything missing" — and the federated route has five moving parts no
 * environment variable can vouch for: this clone's Mission Control key, that
 * key's scope, Mission Control's signing key, whether Anthropic can fetch the
 * published key set, and whether the federation rule still matches this
 * clone's subject. Every one of those fails silently, at inference time, on a
 * report somebody is waiting for.
 *
 * ## What it costs
 *
 * Nothing. A federated exchange is not a billable call, and `GET /v1/models`
 * is metadata — no tokens are consumed, so a probe can be offered on a page an
 * operator refreshes. It is deliberately NOT a message: proving the credential
 * can complete a model call would cost money on every click.
 *
 * ## Why `freshCredential` exists
 *
 * A cached token outlives the chain that minted it by up to an hour, so a
 * probe that accepted one would answer green for an hour after federation
 * broke — the stale reading this replaces. An operator asking the question
 * wants the whole chain exercised, so the diagnostic path takes a fresh
 * credential that it neither reads from nor writes to the module cache.
 * Inference is left entirely alone, which is the point: a diagnostic must
 * never be able to disturb the thing it reports on.
 */
export async function describeAnthropicReach(
  opts?: { readonly freshCredential?: boolean },
): Promise<{ reach: AnthropicReach; models: unknown[] }> {
  const probedAt = new Date().toISOString();
  const route = anthropicRoute();

  const resolved = opts?.freshCredential && route.via === 'federated'
    ? await exchange(route, { cache: false })
    : await resolveAnthropicCredential();

  if (!resolved.ok) {
    return {
      reach: {
        route: route.via,
        ok: false,
        end: resolved.end,
        why: resolved.why,
        workspaceId: route.via === 'unconfigured' ? null : route.workspaceId,
        credentialKind: null,
        modelCount: null,
        probedAt,
      },
      models: [],
    };
  }

  const { credential } = resolved;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      ANTHROPIC_MODELS_URL,
      { headers: anthropicRequestHeaders(credential) },
      EXCHANGE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      reach: {
        route: route.via,
        ok: false,
        end: 'anthropic',
        why: `Anthropic could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        workspaceId: credential.workspaceId,
        credentialKind: credential.kind,
        modelCount: null,
        probedAt,
      },
      models: [],
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // A workspace the credential may not act in is a configuration fault with
    // its own remedy, and reading it as a generic vendor failure sends an
    // operator to wait out an outage that is not happening.
    const failure = describeAnthropicFailure({
      status: response.status,
      body,
      workspaceId: credential.workspaceId,
    });
    return {
      reach: {
        route: route.via,
        ok: false,
        end: failure.end,
        why: failure.message,
        workspaceId: credential.workspaceId,
        credentialKind: credential.kind,
        modelCount: null,
        probedAt,
      },
      models: [],
    };
  }

  let models: unknown[];
  try {
    const payload = (await response.json()) as { data?: unknown[] };
    models = Array.isArray(payload?.data) ? payload.data : [];
  } catch {
    return {
      reach: {
        route: route.via,
        ok: false,
        end: 'anthropic',
        why: 'Anthropic answered the model list with a body this deployment could not read',
        workspaceId: credential.workspaceId,
        credentialKind: credential.kind,
        modelCount: null,
        probedAt,
      },
      models: [],
    };
  }

  return {
    reach: {
      route: route.via,
      ok: true,
      end: null,
      why: null,
      workspaceId: credential.workspaceId,
      credentialKind: credential.kind,
      modelCount: models.length,
      probedAt,
    },
    models,
  };
}
