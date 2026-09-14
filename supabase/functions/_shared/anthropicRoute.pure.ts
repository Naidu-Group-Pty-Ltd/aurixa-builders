/**
 * The one module that decides how a call reaches Anthropic.
 *
 * ## Why this exists
 *
 * Eight call sites in this repository named `api.anthropic.com` themselves and
 * read `ANTHROPIC_API_KEY` out of the environment inline, each with its own
 * copy of the endpoint constant and its own spelling of "not configured". That
 * was workable while there was exactly one way to reach the vendor. There are
 * now two, and a third fact — which workspace the call is attributed to —
 * that none of them carried.
 *
 * So this is the Airtable rule applied to the model vendor: **no function may
 * name `api.anthropic.com` itself**, and `anthropicRoute.spec.ts` asserts it
 * over every function that calls Anthropic. One module decides, every caller
 * obeys, and a change to how the credential is obtained is a change here
 * rather than in eight places that would drift.
 *
 * ## The attribution problem this opens the door to
 *
 * Every clone provisioned by Aurixa Mission Control runs on the prime's
 * forwarded `ANTHROPIC_API_KEY`, so Anthropic's own dashboard shows one
 * undifferentiated bill and the only per-tenant figure anywhere is the one
 * this platform computes for itself. Anthropic publishes no endpoint that
 * creates an API key — its own documentation says "you create API keys in the
 * Claude Console" — so the per-clone credential the other four model vendors
 * get cannot exist here.
 *
 * But a key is not the unit of attribution. A WORKSPACE is, and workspaces
 * ARE creatable through the Admin API. A key that is not bound to a single
 * workspace runs in whichever workspace each request names in the
 * `anthropic-workspace-id` header, and the usage and cost reports group by
 * `workspace_id`. So Mission Control creates one workspace per clone and
 * publishes its id as `ANTHROPIC_WORKSPACE_ID`, and this module puts it on
 * every request.
 *
 * ## Three rules
 *
 * **A key present is always used.** Federation is what happens when there is
 * no key, never something that overrides one. Three reasons, and each is
 * sufficient on its own: a key the TENANT supplied through their Integrations
 * page arrives under this same name and must win, because they are charged
 * nothing for it and minting past it puts Aurixa back on the hook; a cutover
 * that engages only once the key is actually withdrawn is explicit and
 * reversible, where one that engages the moment federation is configured
 * changes behaviour on a deployment nobody touched; and it is the precedence
 * Anthropic's own SDKs apply, so nothing here surprises somebody reading
 * their documentation.
 *
 * **The workspace header is sent only when we hold an id.** A key bound to a
 * single workspace needs no header and already attributes correctly. An id
 * that names a workspace the credential cannot act in is a 404, not a
 * fallback — which is why Mission Control publishes the name only where it
 * created the workspace AND the deployment is on a credential that can reach
 * it, and why `describeAnthropicFailure` names that case rather than letting
 * it read as an outage.
 *
 * **`unconfigured` is an answer, not an error.** A deployment with no way to
 * reach Anthropic is a real, ordinary state — it is every deployment whose
 * owner has not supplied a key and which Mission Control has not yet reached.
 * Callers render the reason; nothing here throws.
 *
 * Pure: no network, no `Deno.env`, no timers. `anthropicCredential.ts` is the
 * half that reads the environment and performs the token exchange.
 */

/** The only two endpoints any caller in this repository may reach. */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

/**
 * Where an identity token is exchanged for a short-lived, workspace-scoped
 * access token. Named here with the others so the spec has one file to guard.
 */
export const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

export const ANTHROPIC_VERSION = '2023-06-01';

/** The header that tells a multi-workspace credential which workspace to act in. */
export const ANTHROPIC_WORKSPACE_HEADER = 'anthropic-workspace-id';

/**
 * The header Anthropic sets on every answered request, naming the workspace
 * the credential actually resolved to. It is how attribution is VERIFIED
 * rather than assumed — a self-test reads it back and compares.
 */
export const ANTHROPIC_WORKSPACE_RESPONSE_HEADER = 'anthropic-workspace-id';

/** An Anthropic workspace id. Bounded, because it goes into a request header. */
export const ANTHROPIC_WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;

/**
 * What a caller was handed, and how to spend it.
 *
 * `api_key` is a static `sk-ant-api…` secret. `access_token` is the
 * short-lived `sk-ant-oat01-…` a federated exchange returns; it carries its
 * own expiry, which is why the caching lives in the server half and never
 * here.
 */
export type AnthropicCredential = {
  readonly kind: 'api_key' | 'access_token';
  readonly value: string;
  /** Null where the credential is already bound to one workspace. */
  readonly workspaceId: string | null;
};

/**
 * How this deployment reaches Anthropic, decided from configuration alone.
 *
 * `federated` carries what the exchange needs and NOT a credential, because
 * obtaining one is a network call — which is the whole reason the two halves
 * of this module are split.
 */
export type AnthropicRoute =
  | {
      readonly via: 'api_key';
      readonly apiKey: string;
      readonly workspaceId: string | null;
    }
  | {
      readonly via: 'federated';
      /** Mission Control's origin, already trimmed of any path. */
      readonly missionControlUrl: string;
      readonly cloneApiKey: string;
      readonly workspaceId: string;
    }
  | { readonly via: 'unconfigured'; readonly why: string };

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * A workspace id we are willing to put in a header, or null.
 *
 * Deliberately silent on a malformed value rather than throwing: the id is
 * configuration written by another system, and a deployment whose id is
 * unreadable should still reach Anthropic on its key exactly as it did
 * before. `anthropicWorkspaceIdRefusal` is how a surface that wants to REPORT
 * the malformed value asks the same question.
 */
export function readWorkspaceId(raw: string | null | undefined): string | null {
  const value = trimmed(raw);
  if (!value) return null;
  return ANTHROPIC_WORKSPACE_ID.test(value) ? value : null;
}

/** Why a configured workspace id was not used, or null when there is nothing to say. */
export function anthropicWorkspaceIdRefusal(raw: string | null | undefined): string | null {
  const value = trimmed(raw);
  if (!value) return null;
  if (ANTHROPIC_WORKSPACE_ID.test(value)) return null;
  return (
    `ANTHROPIC_WORKSPACE_ID is set to something that is not an Anthropic workspace id ` +
    `(they begin "wrkspc_"), so it was ignored and this deployment's Anthropic calls are ` +
    `attributed wherever its credential already pointed.`
  );
}

/**
 * Which route this deployment takes, from configuration alone.
 *
 * Nothing here reaches the network, so a `federated` answer is a statement
 * about configuration and never about reachability — the same distinction the
 * verification broker had to learn, where every readiness reading was green
 * on three tenants that had never completed a call.
 */
export function resolveAnthropicRoute(input: {
  apiKey: string | null | undefined;
  workspaceId: string | null | undefined;
  missionControlUrl: string | null | undefined;
  cloneApiKey: string | null | undefined;
}): AnthropicRoute {
  const apiKey = trimmed(input.apiKey);
  const workspaceId = readWorkspaceId(input.workspaceId);

  /*
   * Ordered first, and the order is the rule. A key in the environment is
   * either the tenant's own — charged at nothing, and replacing it would bill
   * Aurixa for calls the tenant believes are theirs — or the prime's fleet
   * key, which is what every clone runs on today. Either way it is what this
   * deployment is meant to spend, and federation may not reach past it.
   */
  if (apiKey) return { via: 'api_key', apiKey, workspaceId };

  const missionControlUrl = trimmed(input.missionControlUrl).replace(/\/+$/, '');
  const cloneApiKey = trimmed(input.cloneApiKey);

  if (missionControlUrl && cloneApiKey && workspaceId) {
    return { via: 'federated', missionControlUrl, cloneApiKey, workspaceId };
  }

  /*
   * Say which half is missing. "Not configured" sent an operator to the wrong
   * remedy every time it was reported, because a deployment that holds a
   * clone key and no workspace and one that holds neither need opposite
   * actions.
   */
  if (missionControlUrl && cloneApiKey && !workspaceId) {
    return {
      via: 'unconfigured',
      why:
        'this deployment can reach Mission Control but holds no ANTHROPIC_WORKSPACE_ID, ' +
        'so there is no workspace for its Anthropic calls to be attributed to',
    };
  }

  return {
    via: 'unconfigured',
    why:
      'Anthropic is not configured for this deployment: it needs either ANTHROPIC_API_KEY, ' +
      'or MISSION_CONTROL_URL, MISSION_CONTROL_CLONE_API_KEY and ANTHROPIC_WORKSPACE_ID to ' +
      'obtain a workspace-scoped token',
  };
}

/**
 * The headers every Anthropic request in this repository carries.
 *
 * `x-api-key` and `authorization: Bearer` are not interchangeable: a static
 * key goes in the former (the legacy header Anthropic still supports and
 * every call site here already used), and a federated access token in the
 * latter. Getting that wrong is a 401 that reads exactly like a bad key.
 */
export function anthropicRequestHeaders(
  credential: AnthropicCredential,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };

  if (credential.kind === 'access_token') headers.authorization = `Bearer ${credential.value}`;
  else headers['x-api-key'] = credential.value;

  if (credential.workspaceId) headers[ANTHROPIC_WORKSPACE_HEADER] = credential.workspaceId;

  return { ...headers, ...(extra ?? {}) };
}

/** The same headers, plus the JSON content type a POST body needs. */
export function anthropicJsonHeaders(
  credential: AnthropicCredential,
  extra?: Record<string, string>,
): Record<string, string> {
  return anthropicRequestHeaders(credential, { 'content-type': 'application/json', ...(extra ?? {}) });
}

export type AnthropicFailingEnd =
  /** The vendor answered, and refused. */
  | 'anthropic'
  /** The workspace this deployment names is not one its credential can act in. */
  | 'workspace'
  /** Mission Control refused or could not be reached. */
  | 'mission_control'
  /** Nothing was attempted, because there is no way to reach the vendor. */
  | 'unconfigured';

export interface AnthropicFailure {
  readonly end: AnthropicFailingEnd;
  readonly message: string;
}

/**
 * Which end failed, and what an operator should do about it.
 *
 * The case worth separating is a 404 naming a workspace. Anthropic answers
 * that identically whether the workspace does not exist or the credential
 * simply may not act in it, and both are configuration on OUR side — a
 * forwarded id that does not match the credential the deployment holds. Read
 * as a generic vendor failure it looks like an outage and somebody waits.
 */
export function describeAnthropicFailure(input: {
  status: number;
  body: string | null | undefined;
  workspaceId: string | null | undefined;
}): AnthropicFailure {
  const body = trimmed(input.body);
  const workspaceId = trimmed(input.workspaceId);

  if (input.status === 404 && workspaceId && body.toLowerCase().includes('workspace')) {
    return {
      end: 'workspace',
      message:
        `Anthropic does not recognise workspace ${workspaceId} for this deployment's credential. ` +
        'That is a configuration fault rather than an outage: the workspace was removed, or ' +
        'ANTHROPIC_WORKSPACE_ID names a workspace this credential may not act in.',
    };
  }

  if (input.status === 400 && workspaceId && body.includes(ANTHROPIC_WORKSPACE_HEADER)) {
    return {
      end: 'workspace',
      message:
        `Anthropic rejected the workspace header this deployment sent (${workspaceId}). ` +
        'ANTHROPIC_WORKSPACE_ID is set to a value it will not accept.',
    };
  }

  return {
    end: 'anthropic',
    message: body ? `Anthropic answered ${input.status}: ${body}` : `Anthropic answered ${input.status}`,
  };
}
