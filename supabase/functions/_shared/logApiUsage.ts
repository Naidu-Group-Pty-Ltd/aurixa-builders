/**
 * Shared API Usage Logger
 * Logs external API consumption (tokens, cost, model) to api_usage_log table.
 * Fire-and-forget: errors are caught and logged, never thrown.
 *
 * BILLING: every row written here is also a billing event. This deployment may
 * be running on API keys it does not own — a workspace provisioned by Mission
 * Control boots with the prime's vendor keys forwarded into its Supabase
 * project — so the `report-api-usage` worker drains these rows into Mission
 * Control, which recharges calls made on a forwarded key and charges nothing
 * for a key the workspace supplied itself.
 *
 * Two consequences for call sites:
 *   • `service_name` must be one the map in `apiUsageBilling.pure.ts` knows, or
 *     the call is metered here and never billed. Add new vendors there.
 *   • A call site that knows exactly which credential it spent can say so with
 *     `metadata: { secret_name: "OPENROUTER_API_KEY" }`, which wins over the
 *     map. That is how a new vendor gets billed before the map learns about it.
 */

export interface ApiUsageEntry {
  service_name: string;          // e.g. 'openai', 'perplexity', 'gemini', 'vapi', 'twilio'
  endpoint?: string;             // e.g. '/v1/chat/completions'
  tokens_used?: number;          // total tokens
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_estimate_usd?: number;
  response_time_ms?: number;
  status?: 'success' | 'error';
  model_used?: string;           // e.g. 'gpt-4o-mini', 'sonar-pro'
  metadata?: Record<string, any>;
  user_id?: string;
}

// Rough cost estimates per 1K tokens (input / output)
const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'gpt-4o':           { input: 0.0025,  output: 0.01 },
  'gpt-4o-mini':      { input: 0.00015, output: 0.0006 },
  'gpt-4.1':          { input: 0.002,   output: 0.008 },
  'gpt-5.2':          { input: 0.003,   output: 0.012 },
  'whisper-1':        { input: 0.006,   output: 0 },
  'sonar':            { input: 0.001,   output: 0.001 },
  'sonar-pro':        { input: 0.003,   output: 0.015 },
  'gemini-2.5-pro':   { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-3-flash-preview': { input: 0.00015, output: 0.0006 },
  'text-embedding-3-small': { input: 0.00002, output: 0 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = COST_PER_1K[model];
  if (!rates) return 0;
  return (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;
}

/**
 * Log an API usage entry to the api_usage_log table.
 * This is fire-and-forget — it won't throw or block the caller.
 */
export async function logApiUsage(
  supabase: any,
  entry: ApiUsageEntry
): Promise<void> {
  try {
    const promptTokens = entry.prompt_tokens || 0;
    const completionTokens = entry.completion_tokens || 0;
    const totalTokens = entry.tokens_used || (promptTokens + completionTokens);
    const cost = entry.cost_estimate_usd ?? (entry.model_used ? estimateCost(entry.model_used, promptTokens, completionTokens) : 0);

    const { error } = await supabase
      .from('api_usage_log')
      .insert({
        service_name: entry.service_name,
        endpoint: entry.endpoint || null,
        tokens_used: totalTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_estimate_usd: Math.round(cost * 1000000) / 1000000, // 6 decimal places
        response_time_ms: entry.response_time_ms || null,
        status: entry.status || 'success',
        model_used: entry.model_used || null,
        metadata: entry.metadata || {},
        user_id: entry.user_id && entry.user_id !== 'service_role' ? entry.user_id : null,
      });

    if (error) {
      console.warn('[logApiUsage] Failed to log:', error.message);
    }
  } catch (err) {
    console.warn('[logApiUsage] Error (non-fatal):', err);
  }
}

/**
 * Helper: extract token usage from an OpenAI-style response object
 */
export function extractOpenAIUsage(responseJson: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = responseJson?.usage;
  return {
    prompt_tokens: usage?.prompt_tokens || 0,
    completion_tokens: usage?.completion_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
  };
}
