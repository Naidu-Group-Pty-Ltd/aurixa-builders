/**
 * Builder stock — what an assisted read is allowed to cost.
 *
 * US$10 per calendar month for `builder_stock_extraction`, covering the
 * primary model AND the fallback. This module is the arithmetic; the ceiling
 * itself is enforced in Postgres (`ai_budget_reserve`), because a ceiling that
 * two concurrent Edge Functions can each independently believe they fit under
 * is not a ceiling — see the migration's header.
 *
 * Pure: no network, no Deno, no database. Every number below is exercised by
 * the ordinary test suite rather than only by a deploy.
 *
 * MONEY IS AN INTEGER HERE. Costs are carried as micro-dollars (1e-6 USD) and
 * never as floats. A brochure's real cost is about 1,253 micros, the cap is
 * 10,000,000, and integer addition of those cannot drift the way repeated
 * float addition of $0.001253 does.
 */

/** The ceiling. One calendar month, this agent, both models. */
export const BUILDER_STOCK_MONTHLY_CAP_USD = 10;
export const BUILDER_STOCK_MONTHLY_CAP_MICROS = 10_000_000;

/** The one agent this budget governs. */
export const BUILDER_STOCK_AGENT_KEY = 'builder_stock_extraction';

export const usdToMicros = (usd: number): number => Math.ceil(usd * 1_000_000);
export const microsToUsd = (micros: number): number => micros / 1_000_000;

/**
 * Published OpenRouter rates, US$ per MILLION tokens, verified 20 Sep 2026.
 *
 * Used ONLY to size a reservation — the worst case a request could cost before
 * it is made. What is finally committed is the provider's own reported figure
 * (`usage.cost`), which OpenRouter returns on every response, so a stale entry
 * here makes a hold slightly wrong and the ledger still right.
 *
 * `gemini-3.8-flash` is on an introductory rate that DOUBLES on 1 Jan 2027
 * (to 1.50 / 7.50). The value below is the one in force; when it changes, a
 * reservation sized from the old number would under-hold, so this is the line
 * to revisit in December.
 */
export const OPENROUTER_MODEL_RATES: Record<string, { inputPerM: number; outputPerM: number }> = {
  'openai/gpt-5.6-luna': { inputPerM: 0.20, outputPerM: 1.20 },
  'google/gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75 },
};

/**
 * The chain a hold is sized against, primary first.
 *
 * It mirrors the seeded `agent_model_assignments` row. Stated here rather than
 * read from that table because the hold is taken BEFORE the router loads the
 * assignment, and a second read of the same configuration on the hot path is
 * how two copies of one decision drift. `builderStockOpenRouter.spec.ts`
 * asserts this list and the migration's chain are the same models.
 */
export const BUDGET_CHAIN: string[] = [
  'openai/gpt-5.6-luna',
  'google/gemini-3.8-flash',
];

/**
 * The rate to size a hold with when the model is not in the table.
 *
 * The most expensive rate we know of, NOT an average and NOT zero. An unknown
 * model must over-hold: under-holding is the only error that can breach the
 * ceiling, and a too-large hold merely refuses a call sooner, which is the
 * recoverable direction.
 */
export function rateFor(modelId: string): { inputPerM: number; outputPerM: number } {
  const known = OPENROUTER_MODEL_RATES[modelId];
  if (known) return known;
  const rates = Object.values(OPENROUTER_MODEL_RATES);
  return {
    inputPerM: Math.max(...rates.map((r) => r.inputPerM)),
    outputPerM: Math.max(...rates.map((r) => r.outputPerM)),
  };
}

/**
 * Tokens a payload will cost, estimated from its characters.
 *
 * Four characters to a token is the working ratio for English prose and JSON;
 * measured against the production brochure it is close enough for a hold
 * (LOT 315: 14,454 characters, ~3,614 tokens). Deliberately rounds UP.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(chars, 0) / 4);
}

/** Characters in a router message payload, including multimodal parts. */
export function messageChars(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') { total += content.length; continue; }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') total += text.length;
        // A base64 image is charged as tokens by the provider, not characters.
        // `imageTokens` below accounts for it; counting its base64 length here
        // would size a hold in the hundreds of thousands of tokens.
        const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
        if (typeof url === 'string' && url.startsWith('data:')) total += 0;
      }
    }
  }
  return total;
}

/** A vision part costs tokens even though it carries no characters. */
export const ASSUMED_TOKENS_PER_IMAGE = 1_500;

export function imageCount(messages: Array<{ content: unknown }>): number {
  let count = 0;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url') count += 1;
    }
  }
  return count;
}

/**
 * The most ONE attempt at this model could cost, in micros.
 *
 * Input is what we are about to send; output is the `maxTokens` ceiling, not
 * an expectation — a hold must survive a model that fills its entire output
 * allowance.
 */
export function attemptCeilingMicros(
  modelId: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const rate = rateFor(modelId);
  const usd = (inputTokens / 1_000_000) * rate.inputPerM
    + (maxOutputTokens / 1_000_000) * rate.outputPerM;
  return usdToMicros(usd);
}

/**
 * How many attempts a hold must cover.
 *
 * The seeded chain is primary + one fallback. It is stated here rather than
 * read from `agent_model_assignments` because the hold is taken BEFORE the
 * router loads the assignment, and a second read of that table on the hot path
 * is a second opinion about the same configuration.
 *
 * An operator who lengthens the chain makes this an UNDER-hold, so the ceiling
 * could be exceeded by at most one attempt before the next reserve sees it.
 * `settleMicrosFor` is what keeps the ledger honest in that case: it charges
 * every attempt that reached a provider, whether or not the hold anticipated
 * it, so the overshoot is recorded and the next call is refused.
 */
export const BUDGET_ASSUMED_CHAIN_ATTEMPTS = 2;

/** The hold for one whole request: every attempt the chain may make. */
export function reservationMicrosFor(args: {
  chain: string[];
  inputTokens: number;
  maxOutputTokens: number;
}): number {
  const chain = args.chain.length ? args.chain : Object.keys(OPENROUTER_MODEL_RATES);
  const attempts = Math.max(chain.length, BUDGET_ASSUMED_CHAIN_ATTEMPTS);
  // Pad a short chain with its most expensive member rather than assuming the
  // cheap one repeats.
  const padded = [...chain];
  while (padded.length < attempts) {
    padded.push(
      chain.reduce((worst, m) =>
        attemptCeilingMicros(m, args.inputTokens, args.maxOutputTokens)
        > attemptCeilingMicros(worst, args.inputTokens, args.maxOutputTokens) ? m : worst, chain[0]),
    );
  }
  return padded.reduce(
    (sum, m) => sum + attemptCeilingMicros(m, args.inputTokens, args.maxOutputTokens), 0);
}

/** One entry of the router's `attempts`, as far as the budget cares. */
export interface BudgetAttempt {
  route?: string;
  model_id?: string;
  ok?: boolean;
  status?: number;
  error?: string;
}

/**
 * Did this attempt actually reach a provider and therefore possibly cost money?
 *
 * `provider_not_configured` never left the process. A connection failure never
 * got an answer. Everything that came back with an HTTP status did reach a
 * provider — including a 422, which is the ROUTER'S OWN verdict on a response
 * the provider generated and charged for.
 */
export function attemptReachedProvider(attempt: BudgetAttempt): boolean {
  if (attempt.ok === true) return true;
  if (attempt.error === 'provider_not_configured') return false;
  if (attempt.error === 'deadline exceeded before attempt') return false;
  return typeof attempt.status === 'number';
}

/**
 * Did this attempt consume tokens, and therefore money?
 *
 * Reaching a provider is not the same as being charged by one. A 401, 402,
 * 403 or 429 is the provider DECLINING before it does any work — a rejected
 * key, an account out of credit, a forbidden model, a rate limit — and none of
 * them runs a single token through a model.
 *
 * Measured 20 September 2026: the first OpenRouter call answered 402 (no
 * credit on the account) and the whole hold, 43,277 micros, was committed for
 * a request that cost nothing. At that rate 231 refusals would have exhausted
 * a US$10 month without a token being spent — a ceiling consumed entirely by
 * being turned away.
 */
export function attemptWasBillable(attempt: BudgetAttempt): boolean {
  if (!attemptReachedProvider(attempt)) return false;
  const status = attempt.status;
  if (status === 401 || status === 402 || status === 403 || status === 429) return false;
  return true;
}

/**
 * What to commit once the request is over.
 *
 * The winning attempt's cost is the provider's own reported figure where there
 * is one. Every OTHER attempt that reached a provider consumed tokens we
 * cannot observe — the router keeps no body for a step it moved past — so each
 * is charged its ceiling. That over-counts slightly and it is the right
 * direction: the alternative is a chain that quietly burns two models' tokens
 * and books one.
 *
 * With no reported cost at all, the whole hold is committed: a call that may
 * have spent an unknown amount is never booked at zero.
 */
export function settleMicrosFor(args: {
  reservedMicros: number;
  reportedCostUsd: number | null;
  attempts: BudgetAttempt[];
  winningModelId: string | null;
  inputTokens: number;
  maxOutputTokens: number;
}): number {
  /*
   * BILLABLE, not merely reached. A provider that refused the request on
   * payment or credentials ran nothing and charged nothing, so it must not
   * consume the ceiling — see `attemptWasBillable`.
   */
  const reaching = args.attempts.filter(attemptWasBillable);
  if (!reaching.length) return 0;

  if (args.reportedCostUsd === null) return args.reservedMicros;

  let micros = usdToMicros(args.reportedCostUsd);
  let winnerSeen = false;
  for (const attempt of reaching) {
    const isWinner = !winnerSeen && (attempt.ok === true
      || (args.winningModelId !== null && attempt.model_id === args.winningModelId));
    if (isWinner) { winnerSeen = true; continue; }
    micros += attemptCeilingMicros(
      attempt.model_id ?? '', args.inputTokens, args.maxOutputTokens);
  }
  return Math.min(micros, args.reservedMicros);
}

/** OpenRouter reports the real cost on every response. Null when it did not. */
export function readReportedCostUsd(raw: unknown): number | null {
  const usage = (raw as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const cost = (usage as { cost?: unknown }).cost;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost;
  return null;
}

/** The calendar month a spend belongs to, UTC, as the table keys it. */
export function periodMonthKey(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}
