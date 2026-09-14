/**
 * Which credential a model call spent, and how many tokens it spent — pure.
 *
 * WHY THIS EXISTS
 * ---------------
 * `api_usage_log` is a billing ledger: Mission Control drains it and recharges
 * the tenant for calls made on a forwarded key. Two rules from
 * `docs/integrations/API_USAGE_METERING.md` shape everything here:
 *
 *   - a `service_name` the map does not know is **metered and never billed**;
 *   - a `service_name` that resolves to the WRONG credential bills the wrong
 *     tenant, which is worse than not billing at all.
 *
 * So the mapping from a call to a credential is never guessed. `llmRouter`
 * chooses a provider from `(route, modelId)` with a hardcoded set of rules, and
 * this module mirrors those rules exactly — with a CI test that fails if the two
 * drift. An unrecognised model family returns `null` rather than a plausible
 * guess: the caller then logs nothing and warns, which is visible and fixable,
 * where a wrong row is neither.
 *
 * WHAT WAS UNBILLED BEFORE THIS
 * -----------------------------
 * Measured across `supabase/functions` at the time of writing: 25 edge functions
 * call `callLLM`/`callLLMRaw`, and **19 of them never logged the call**. Six log
 * adjacently to their own call and must not be logged twice; the rest —
 * including `report-qa`, `parse-template-document` and `vapi-call-webhook`,
 * whose only `logApiUsage` calls are for embeddings or a different vendor
 * entirely — were spending a forwarded key for free.
 *
 * Pure: no imports, no Deno globals, no I/O. Loaded by the edge runtime and by
 * the repo's vitest suite alike.
 */

/** Routes `llmRouter` can dispatch to. Mirrors its own `LLMRoute`. */
export type LlmUsageRoute = 'gateway' | 'native' | 'openrouter';

export interface LlmCredentialBinding {
  /** `api_usage_log.service_name` — must be a key `apiUsageBilling.pure.ts` knows. */
  serviceName: string;
  /**
   * The `Deno.env.get` name whose key the call consumed. Passed as
   * `metadata.secret_name`, which wins over the service-name map — the exact
   * answer beats the derived one.
   */
  secretName: string;
}

/**
 * Native-route model prefixes, in the order `llmRouter.callRoute` tests them.
 *
 * ORDER MATTERS and is asserted in CI: `o` matches `o1`/`o3` but would also
 * swallow `openrouter/...` style ids if it ran before more specific prefixes,
 * so this list is kept identical to the router's `if` chain rather than sorted
 * or de-duplicated for tidiness.
 */
const NATIVE_PREFIXES: ReadonlyArray<{ prefixes: readonly string[]; binding: LlmCredentialBinding }> = [
  { prefixes: ['gpt-', 'o', 'chatgpt'], binding: { serviceName: 'openai', secretName: 'OPENAI_API_KEY' } },
  { prefixes: ['claude-'], binding: { serviceName: 'anthropic', secretName: 'ANTHROPIC_API_KEY' } },
  { prefixes: ['gemini-'], binding: { serviceName: 'gemini', secretName: 'GEMINI_API_KEY' } },
  { prefixes: ['sonar'], binding: { serviceName: 'perplexity', secretName: 'PERPLEXITY_API_KEY' } },
];

const GATEWAY_BINDING: LlmCredentialBinding = { serviceName: 'lovable-ai-gateway', secretName: 'LOVABLE_API_KEY' };
const OPENROUTER_BINDING: LlmCredentialBinding = { serviceName: 'openrouter', secretName: 'OPENROUTER_API_KEY' };

/**
 * The credential a `(route, modelId)` pair spends, or null when the model
 * family is one this module has not been taught.
 *
 * Null is a deliberate outcome, not an oversight path: billing a row we cannot
 * justify is the failure this whole module exists to avoid.
 */
export function resolveLlmCredential(
  route: string | null | undefined,
  modelId: string | null | undefined,
): LlmCredentialBinding | null {
  if (route === 'gateway') return GATEWAY_BINDING;
  if (route === 'openrouter') return OPENROUTER_BINDING;
  if (route !== 'native') return null;
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!model) return null;
  for (const entry of NATIVE_PREFIXES) {
    if (entry.prefixes.some((p) => model.startsWith(p))) return entry.binding;
  }
  return null;
}

/**
 * `claudeReconstruct` talks to the Anthropic Messages API directly and never
 * goes through the router, so it has no route to resolve — it is always this.
 */
export const CLAUDE_RECONSTRUCT_BINDING: LlmCredentialBinding = {
  serviceName: 'anthropic',
  secretName: 'ANTHROPIC_API_KEY',
};

export interface LlmUsageTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Token counts off a provider response, in either shape the codebase sees.
 *
 * OpenAI-compatible responses report `prompt_tokens` / `completion_tokens`;
 * Anthropic reports `input_tokens` / `output_tokens`, and `toOpenAIShape` passes
 * that object through untouched rather than translating it — so both live here.
 *
 * Cached-prompt tokens count towards the prompt total. They are billed at a
 * different RATE, which is the rate card's job, but they were consumed and a
 * ledger that omits them under-reports a real cost.
 *
 * Returns null when there is no usable usage object, so a caller can log the
 * call without inventing a quantity.
 */
export function extractUsageTokens(raw: unknown): LlmUsageTokens | null {
  const usage = (raw as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = count(usage.prompt_tokens)
    || (count(usage.input_tokens)
      + count(usage.cache_creation_input_tokens)
      + count(usage.cache_read_input_tokens));
  const completionTokens = count(usage.completion_tokens) || count(usage.output_tokens);
  const reported = count(usage.total_tokens);
  const totalTokens = reported || promptTokens + completionTokens;

  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/** The model id a provider echoed back, when it did. Falls back to the requested one. */
export function resolveModelUsed(raw: unknown, requested: string | null | undefined): string {
  const echoed = (raw as { model?: unknown } | null | undefined)?.model;
  if (typeof echoed === 'string' && echoed.trim()) return echoed.trim();
  return typeof requested === 'string' ? requested : '';
}
