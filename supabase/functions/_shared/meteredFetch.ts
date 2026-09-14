/**
 * `fetch`, with the vendor bill attached.
 *
 * WHY THIS EXISTS
 * ---------------
 * This deployment may be running on API keys it does not own: a workspace
 * provisioned by Mission Control boots with the prime's OpenAI, Resend, Domain
 * and Cotality keys forwarded into its Supabase project, and Mission Control
 * recharges what it spends on them. Only calls that reach `logApiUsage` are
 * metered at all — and 92 of this repo's edge functions called a billable
 * vendor without logging anything, so most spend was invisible.
 *
 * Instrumenting 92 files by hand meant 92 chances to attribute a call to the
 * wrong credential, and a rule ("remember to log") that decays the moment
 * somebody adds function 93. This wraps the thing they were already writing
 * instead: change `fetch(` to `meteredFetch(` and the call is metered, because
 * the URL already says which credential it spends.
 *
 * DESIGN CONSTRAINTS
 *   • Never changes the response. It returns exactly what `fetch` returned,
 *     with the body unread — a metering wrapper that consumed the stream would
 *     break every caller.
 *   • Never throws its own errors. A failure to meter must not fail the call
 *     that earns the revenue.
 *   • Never blocks. The log write is fire-and-forget.
 *   • Needs no Supabase client from the caller. It builds its own service-role
 *     client lazily from the env every edge function already has, so adding
 *     metering to a call site is one identifier, not a plumbing exercise.
 */
import { createClient } from "npm:@supabase/supabase-js@2.55.0";
import { logApiUsage } from "./logApiUsage.ts";
import {
  secretForUrl,
  serviceNameForSecret,
  isTokenPriced,
} from "./apiUsageBilling.pure.ts";

export type MeteredFetchOptions = {
  /**
   * Force the credential rather than inferring it from the host. Required for
   * the self-hosted sidecars — WeasyPrint, the PDF parser, the AML service —
   * whose URLs come from env and have no fixed hostname.
   */
  secretName?: string;
  /** What this call was for, e.g. "investment-report/section-3". */
  feature?: string;
  /** Model name for token-priced vendors, when the response won't carry it. */
  model?: string;
  /**
   * Units consumed, when the vendor doesn't report it in an OpenAI-shaped
   * body — Vapi call minutes, say, or a batch of 50 emails in one request.
   * Defaults to 1 for per-call vendors and to the response's token count for
   * token-priced ones.
   */
  quantity?: number;
  /** Extra context recorded against the usage row. */
  metadata?: Record<string, unknown>;
  /** Skip metering for this call — e.g. a health check that costs nothing. */
  skipMetering?: boolean;
  /**
   * Judge the outcome from the vendor's OWN body, for vendors that answer
   * HTTP 200 with the real verdict inside it.
   *
   * RF-7.2B.1B0-F3. `response.ok` is the default and stays the default for
   * every existing caller — this is opt-in per call site and changes nothing
   * that does not ask for it. It exists because Google Maps answers
   * `REQUEST_DENIED` with HTTP 200, which this wrapper recorded as a
   * *successful, billable* request: measured 2026-09-12, 24 of 24 refused
   * geocodes were logged `status: 'success'`, forwarded to Mission Control
   * with `quantity: 1`, and charged to the tenant for calls that returned
   * nothing — while every health surface read the vendor as perfectly well.
   * It is the same trap `resolveOneReportGeography` already records for the
   * ABS boundary server: a 200 plus an error body is transport, not success.
   *
   * Called with the parsed JSON of a CLONE, so the caller's stream is
   * untouched. Return `null` to fall back to the HTTP reading. A body that is
   * not JSON, or that cannot be cloned, also falls back rather than losing
   * the call.
   */
  judgeBody?: (body: unknown) => "success" | "error" | null;
};

let cachedClient: ReturnType<typeof createClient> | null = null;

function usageClient() {
  if (cachedClient) return cachedClient;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  cachedClient = createClient(url, key);
  return cachedClient;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Read token usage from a response without consuming the caller's body.
 *
 * `Response.clone()` is the only safe way to look: reading the original would
 * leave the caller with a used stream. Cloning buffers the body in memory, so
 * it is only done for token-priced vendors, where the token count is the whole
 * basis of the charge — for a per-call vendor there is nothing worth the copy.
 */
async function readTokenUsage(
  res: Response,
): Promise<{ prompt: number; completion: number; total: number; model?: string } | null> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return null;
  try {
    const body = await res.clone().json();
    // OpenAI shape, which Anthropic, Perplexity, OpenRouter and the Lovable
    // gateway all mirror closely enough. Anthropic names them differently.
    const usage = body?.usage;
    if (!usage) return null;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const total = Number(usage.total_tokens ?? prompt + completion);
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      prompt: Number.isFinite(prompt) ? prompt : 0,
      completion: Number.isFinite(completion) ? completion : 0,
      total,
      model: typeof body?.model === "string" ? body.model : undefined,
    };
  } catch {
    // A body that isn't JSON, or a stream that can't be cloned. Metering falls
    // back to a per-call record rather than losing the call entirely.
    return null;
  }
}

/**
 * Drop-in `fetch` that records what the call cost.
 *
 * Signature matches `fetch` so the swap is mechanical; the third argument is
 * the only addition, and every field on it is optional.
 */
export async function meteredFetch(
  input: string | URL | Request,
  init?: RequestInit,
  options: MeteredFetchOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (networkError) {
    // A call that never reached the vendor still costs us nothing, but the
    // failure is worth recording — a provider outage shows up as a cliff in
    // the error count rather than as silence.
    void recordUsage(urlOf(input), null, Date.now() - startedAt, "error", options);
    throw networkError;
  }

  void (async () => {
    let status: "success" | "error" = response.ok ? "success" : "error";
    // Only pay for the clone where a caller has said the body decides.
    if (options.judgeBody && response.ok) {
      try {
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("json")) {
          const verdict = options.judgeBody(await response.clone().json());
          if (verdict) status = verdict;
        }
      } catch {
        // Unparseable or unclonable: keep the HTTP reading rather than lose
        // the call. Metering must never throw and never drop a row.
      }
    }
    recordUsage(urlOf(input), response, Date.now() - startedAt, status, options);
  })();
  return response;
}

async function recordUsage(
  url: string,
  response: Response | null,
  elapsedMs: number,
  status: "success" | "error",
  options: MeteredFetchOptions,
): Promise<void> {
  try {
    if (options.skipMetering) return;

    const secretName = options.secretName ?? secretForUrl(url);
    // Not a metered vendor — esm.sh, the ABS, our own project. Nothing to bill.
    if (!secretName) return;

    const client = usageClient();
    if (!client) return;

    let quantity = options.quantity;
    let model = options.model;
    let promptTokens = 0;
    let completionTokens = 0;

    if (isTokenPriced(secretName) && response && status === "success") {
      const usage = await readTokenUsage(response);
      if (usage) {
        promptTokens = usage.prompt;
        completionTokens = usage.completion;
        quantity = quantity ?? usage.total;
        model = model ?? usage.model;
      }
    }

    // A token-priced call whose token count we could not read is recorded with
    // zero quantity rather than as one "request": billing it per call would
    // charge a per-token rate for a single unit, which is wrong by five orders
    // of magnitude. The forwarder drops zero-quantity token rows, so the call
    // shows up in the log for diagnosis and never on an invoice.
    const finalQuantity = quantity ?? (isTokenPriced(secretName) ? 0 : 1);

    await logApiUsage(client, {
      service_name: serviceNameForSecret(secretName),
      endpoint: options.feature ?? safePath(url),
      tokens_used: isTokenPriced(secretName) ? finalQuantity : 0,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      response_time_ms: elapsedMs,
      status,
      model_used: model,
      metadata: {
        ...(options.metadata ?? {}),
        // Wins over the service_name map on the forwarder, so a host resolved
        // here is billed to exactly this credential.
        secret_name: secretName,
        host: safeHost(url),
        ...(response ? { http_status: response.status } : {}),
        ...(isTokenPriced(secretName) ? {} : { request_count: finalQuantity }),
      },
    });
  } catch {
    // Metering must never break the call that earns the revenue.
  }
}

/** Path only — query strings on vendor URLs carry keys and client data. */
function safePath(url: string): string {
  try {
    return new URL(url).pathname.slice(0, 120);
  } catch {
    return "unknown";
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
