/**
 * Builder stock lists — WHY the assisted reader did not answer.
 *
 * `llmRouter` already knows: it records one `attempts` entry per model in the
 * chain, each carrying the route, the model id, an HTTP status and an error
 * string it has ALREADY made safe (`safeAttemptError` collapses a provider's
 * body down to `provider_timeout` / `provider_not_configured` /
 * `provider_http_NNN`, so no vendor text and no credential can travel in one).
 * It then throws an `LLMError` carrying that array.
 *
 * And every caller threw the array away. Measured 20 September 2026 on project
 * htfluofznhxeumblwbww: three brochure imports failed within five seconds of
 * being started, and all the row kept was the sentence
 * `[llmRouter] All 2 models failed for agent_key=builder_stock_extraction`.
 * Two models failed — nothing recorded WHICH failure it was, so a missing
 * credential, a provider outage, a timeout and a model answering with
 * unparseable arguments were one indistinguishable event, reported to the
 * builder as a fact about their document.
 *
 * This module is the one place that reads those attempts. It is pure: no
 * network, no Deno, no `npm:` specifier — so the classification a production
 * import depends on is exercised by the ordinary test suite rather than only
 * by a deploy.
 *
 * THE RULE IT EXISTS FOR: a failure of ours is never reported as a finding
 * about the document. `model_success_no_properties` is deliberately NOT a
 * member of this type — a model that answered properly and found nothing is
 * not a failure at all, it is an empty `items` array, and it stays on the
 * ordinary `no_properties_found` path.
 */

/**
 * The four ways the assisted reader can fail to produce an answer.
 *
 * Distinct because they send an operator to four different remedies and a
 * builder to two different expectations (wait and retry, or nothing they can
 * do). Collapsing them is what produced the one blanket sentence this
 * replaces.
 */
export type ModelExtractionFailureCode =
  /** No model in the chain answered: unconfigured credential, 4xx, 5xx, 404. */
  | 'model_unavailable'
  /** Every attempt ran out of clock — ours or the provider's. */
  | 'model_timeout'
  /** A model answered, and the answer was not the shape the schema demands. */
  | 'model_invalid_response'
  /** A model answered without calling the tool it was required to call. */
  | 'model_missing_tool_call'
  /**
   * The monthly reading allowance is spent, or its accounting could not be
   * reached. NOTHING was called — this is decided before any provider is
   * touched, and it is the one failure here that is not about a model at all.
   */
  | 'model_budget_exhausted';

/** One entry of `llmRouter`'s `attempts`. Structural, so the router owns it. */
export interface RouterAttempt {
  route?: string;
  model_id?: string;
  ok?: boolean;
  status?: number;
  error?: string;
}

/**
 * What one attempt amounts to. Named separately from the failure code because
 * a chain's attempts need not agree — a first model that times out and a
 * second whose credential is missing is an infrastructure failure, not a
 * timeout, and only per-attempt categories can say so.
 */
export type AttemptCategory =
  | 'ok'
  | 'timeout'
  | 'unconfigured'
  | 'refused'
  | 'unavailable'
  | 'missing_tool_call'
  | 'invalid_arguments'
  | 'unknown';

/**
 * The two error strings `llmRouter` writes ITSELF when a provider answered but
 * the answer was unusable. They are not provider text — the router composes
 * them from `requiredToolName` — which is what makes reading them here safe
 * and deterministic rather than the "string-match a random error message"
 * this codebase has been burned by before.
 *
 * `routerFailureVocabulary.spec.ts` reads `llmRouter.ts` and fails when either
 * prefix stops matching, because two copies of one vocabulary in two files is
 * exactly how the two ends drift.
 */
export const ROUTER_MISSING_TOOL_PREFIX = 'required tool call missing';
export const ROUTER_INVALID_ARGUMENTS_PREFIX = 'required tool arguments invalid';

/** Statuses the router uses for "the provider answered, the answer was not usable". */
const UNUSABLE_ANSWER_STATUS = 422;

/**
 * Categorise one attempt from the router's own structured fields.
 *
 * Reads `error` only for the two prefixes above (the router's own words) and
 * for the deadline note it writes when a budget is spent before an attempt
 * starts. A provider's body never reaches here: `safeAttemptError` has already
 * reduced it to one of a closed set of tokens.
 */
export function categoriseAttempt(attempt: RouterAttempt): AttemptCategory {
  const error = typeof attempt.error === 'string' ? attempt.error : '';
  const status = typeof attempt.status === 'number' ? attempt.status : undefined;

  /*
   * A SUCCESSFUL attempt is a real category.
   *
   * `callLLM` only throws once every step failed, so a transport failure's
   * attempts never include one of these — but the array returned ALONGSIDE a
   * successful call does, and `unusableAnswerFailure` summarises exactly that
   * array. Without this the winning model was categorised `unavailable` (it
   * carries status 200 and no error), so the one line naming which model
   * produced an unusable answer named it as an outage instead.
   */
  if (attempt.ok === true) return 'ok';

  if (status === UNUSABLE_ANSWER_STATUS) {
    if (error.startsWith(ROUTER_MISSING_TOOL_PREFIX)) return 'missing_tool_call';
    if (error.startsWith(ROUTER_INVALID_ARGUMENTS_PREFIX)) return 'invalid_arguments';
    return 'invalid_arguments';
  }
  // The router's own note when the caller's wall clock is spent before a
  // fallback is even started. It is a timeout in every sense that matters to
  // the person waiting.
  if (error === 'deadline exceeded before attempt') return 'timeout';
  if (error === 'provider_timeout' || status === 504) return 'timeout';
  if (error === 'provider_not_configured') return 'unconfigured';
  if (status === 401 || status === 402 || status === 403 || status === 429) return 'refused';
  if (status !== undefined) return 'unavailable';
  if (error) return 'unknown';
  return 'unknown';
}

export interface ModelFailureDiagnosis {
  code: ModelExtractionFailureCode;
  /** How many models were tried. */
  attemptCount: number;
  /** One category per attempt, in chain order. */
  categories: AttemptCategory[];
  /**
   * A safe, structured line for `error_detail` and the server log. Carries
   * routes, model ids and categories — configuration, never a credential and
   * never a provider's response body.
   */
  diagnosis: string;
}

/**
 * Reduce a chain's attempts to one failure code.
 *
 * Precedence is deliberate and is about what the OPERATOR should do:
 *
 *  - every attempt produced an unusable answer → the models are reachable and
 *    the contract is wrong, which is ours to fix, not something to wait out;
 *  - every attempt ran out of clock → a budget/latency problem;
 *  - anything else, including a MIXTURE → `model_unavailable`, the retryable
 *    infrastructure reading. A mixture is not a timeout: reporting it as one
 *    would tell a builder to wait for something waiting will not fix.
 */
export function classifyModelFailure(
  attempts: RouterAttempt[] | undefined,
  fallback: ModelExtractionFailureCode = 'model_unavailable',
): ModelFailureDiagnosis {
  /*
   * TRANSPORT ONLY. This reduces what the CHAIN did, so it must be handed the
   * attempts of a chain that failed — `callLLM` throwing. For an answer that
   * arrived and was unusable, use `unusableAnswerFailure`: the attempts there
   * describe a SUCCESSFUL call and say nothing about the shape of its answer.
   */
  const list = Array.isArray(attempts) ? attempts : [];
  const categories = list.map(categoriseAttempt);

  // No attempts recorded at all — the chain never started (an assignment that
  // could not be read, a disabled agent). Nothing was asked of any model, so
  // the honest reading is that the reader was unavailable.
  let code: ModelExtractionFailureCode = fallback;
  if (categories.length > 0) {
    const every = (...wanted: AttemptCategory[]) =>
      categories.every((entry) => wanted.includes(entry));
    if (every('missing_tool_call')) code = 'model_missing_tool_call';
    else if (every('missing_tool_call', 'invalid_arguments')) code = 'model_invalid_response';
    else if (every('timeout')) code = 'model_timeout';
    else code = 'model_unavailable';
  }

  return {
    code,
    attemptCount: list.length,
    categories,
    diagnosis: summariseAttempts(list, categories),
  };
}

/**
 * The safe line recorded on the row and in the log.
 *
 * Route and model id are this deployment's own configuration and are what an
 * operator needs to act; the category is the router's already-sanitised
 * reading. Nothing else is copied — in particular no `error` string is passed
 * through verbatim, because the two the router composes carry a tool name and
 * the rest are tokens the category already names.
 */
export function summariseAttempts(
  attempts: RouterAttempt[],
  categories: AttemptCategory[] = attempts.map(categoriseAttempt),
): string {
  if (!attempts.length) return 'no model attempt was made';
  return attempts
    .map((attempt, index) => {
      const route = typeof attempt.route === 'string' && attempt.route ? attempt.route : 'unknown';
      const model = typeof attempt.model_id === 'string' && attempt.model_id
        ? attempt.model_id
        : 'unknown';
      const status = typeof attempt.status === 'number' ? ` ${attempt.status}` : '';
      return `${route}/${model}: ${categories[index] ?? 'unknown'}${status}`;
    })
    .join('; ');
}

/**
 * A model ANSWERED, and the answer was not usable.
 *
 * The caller has already decided which kind — it is the one that looked at the
 * payload — so that verdict stands, and the attempts are kept only to name
 * WHICH model produced it.
 *
 * This is a separate function because folding it into `classifyModelFailure`
 * was a live defect, not a tidiness point. That reducer reads the attempt
 * array and only falls back to its parameter when the array is EMPTY — and the
 * array returned beside a successful call is not empty, it holds the winning
 * attempt. So `model_missing_tool_call` and `model_invalid_response` were both
 * reduced to `model_unavailable`, which `assistedReaderFailure` marks
 * RETRYABLE: a model answering with `{}` on every attempt would have told the
 * builder to "try again shortly", for ever.
 *
 * It is reachable, not theoretical. `requireValidToolArguments` in the router
 * only proves the arguments PARSE; nothing there checks that `items` is an
 * array, so a well-formed `{}` passes the whole chain and arrives here.
 */
export function unusableAnswerFailure(
  attempts: RouterAttempt[] | undefined,
  code: ModelExtractionFailureCode,
): StockModelExtractionError {
  const list = Array.isArray(attempts) ? attempts : [];
  const categories = list.map(categoriseAttempt);
  return new StockModelExtractionError({
    code,
    attemptCount: list.length,
    categories,
    diagnosis: summariseAttempts(list, categories),
  });
}

/**
 * The monthly ceiling refused this read, so no provider was called.
 *
 * Carries no attempts, because there were none — which is the point. The
 * diagnosis states the ceiling's own arithmetic in micro-dollars so an
 * operator can see how far over the request was without reading any
 * builder's document.
 *
 * `unavailable` (the budget's accounting could not be reached) resolves to the
 * SAME refusal as `exhausted`, deliberately: a hard cap whose bookkeeping is
 * down must not be treated as a cap of infinity.
 */
export function budgetExhaustedFailure(args: {
  reason: 'exhausted' | 'unavailable';
  remainingMicros: number;
  requiredMicros: number;
  detail?: string;
}): StockModelExtractionError {
  const detail = args.detail ? `; ${args.detail}` : '';
  return new StockModelExtractionError({
    code: 'model_budget_exhausted',
    attemptCount: 0,
    categories: [],
    diagnosis: `budget ${args.reason}: needed ${args.requiredMicros} micros, `
      + `${args.remainingMicros} remaining this month${detail}`,
  });
}

/**
 * The assisted reader did not produce an answer, and this says which kind of
 * not-an-answer it was.
 *
 * Carries the diagnosis rather than a message: what a BUILDER is shown is
 * decided by `assistedReaderFailure.pure.ts`, which also knows what kind of
 * document was being read. Keeping the two apart is what stops a PDF brochure
 * being told about spreadsheet column headings.
 */
export class StockModelExtractionError extends Error {
  readonly code: ModelExtractionFailureCode;
  readonly attemptCount: number;
  readonly categories: AttemptCategory[];
  /** Safe. Recorded on the row and logged; never returned to a caller. */
  readonly diagnosis: string;

  constructor(diagnosis: ModelFailureDiagnosis) {
    super(`${diagnosis.code}: ${diagnosis.diagnosis}`);
    this.name = 'StockModelExtractionError';
    this.code = diagnosis.code;
    this.attemptCount = diagnosis.attemptCount;
    this.categories = diagnosis.categories;
    this.diagnosis = diagnosis.diagnosis;
  }
}

/**
 * Build the error for a throw that came out of `callLLM`.
 *
 * An `LLMError` carries `attempts`; anything else (a network fault escaping
 * the router, a bug) carries none, and classifies as `model_unavailable` —
 * retryable, which is the safe side for a builder holding a document we have
 * not managed to read.
 */
export function modelFailureFromRouterError(error: unknown): StockModelExtractionError {
  const attempts = (error as { attempts?: RouterAttempt[] })?.attempts;
  return new StockModelExtractionError(classifyModelFailure(attempts));
}
