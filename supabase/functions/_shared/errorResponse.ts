/**
 * Opaque 5xx bodies, with the detail kept where it belongs: the logs.
 *
 * ## Why
 *
 * 329 catch blocks across 275 edge functions returned the caught error straight
 * to the caller — `error.message`, `String(err)`, in one case `err.stack`.
 *
 * A Postgres error message is not a sentence, it is schema. `null value in
 * column "password_hash" of relation "custom_users" violates not-null
 * constraint` names a table, a column and a constraint; `permission denied for
 * table client_income_sources` confirms a table exists and is guarded. Repeated
 * across a few hundred endpoints that is a free map of the database, readable by
 * anyone who can provoke a 500 — and provoking one is usually as easy as sending
 * a malformed body. The same applies to fetch failures naming internal hosts and
 * to stack traces naming file paths.
 *
 * The fix is not to swallow the error. It is to move it: the caller gets an
 * opaque body and a correlation id, the log gets everything, and support can
 * still join the two. An opaque error nobody can trace is a worse product than a
 * leaky one, so the correlation id is the whole point of this module.
 *
 * ## Use
 *
 * ```ts
 * } catch (error) {
 *   return new Response(
 *     JSON.stringify(internalError(error, 'send-email-reply')),
 *     { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
 *   );
 * }
 * ```
 *
 * With sibling fields the caller relies on, spread it last so it wins:
 *
 * ```ts
 * return json({ success: false, ...internalError(error, 'bulk-generate') }, 500);
 * ```
 *
 * ## Not for 4xx
 *
 * `_shared/requestSecurity.ts`'s `securityJsonError` already covers deliberate
 * denials (400/401/403/413/429/503) and its status union has no 500 — that
 * omission is the reason this module exists rather than an extra arm on that
 * one. And a 4xx a user is meant to act on must stay legible: a password
 * strength failure, a validation message, "that file is too large". Those are
 * answers, not leaks. This module is only for the case where something broke and
 * the caller has no business knowing what.
 */

/** What a caller sees when something breaks. Nothing about the internals. */
export interface InternalErrorBody {
  error: string;
  code: 'internal_error';
  correlation_id: string;
}

/** Everything a caught value might be, flattened for the log — never returned. */
function describe(err: unknown): string {
  if (err instanceof Error) {
    // `cause` routinely carries the useful half of a wrapped driver error.
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause === undefined ? '' : ` | cause: ${describe(cause)}`;
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}${causeText}`;
  }
  if (typeof err === 'object' && err !== null) {
    // Supabase/PostgREST errors are plain objects: { message, code, details, hint }.
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Log `err` in full against a correlation id and return the body to send back.
 *
 * `context` should identify the endpoint or operation — it is what someone greps
 * for when a user quotes a correlation id.
 *
 * Logging is deliberately a side effect of building the body. Two calls would
 * mean two things to remember, and the one that gets forgotten under deadline is
 * always the log, which turns this module from a fix into an outage with no
 * evidence.
 */
export function internalError(
  err: unknown,
  context: string,
  correlationId: string = crypto.randomUUID(),
): InternalErrorBody {
  console.error(`[${context}] internal_error correlation_id=${correlationId}`, describe(err));
  return {
    error: 'Internal error',
    code: 'internal_error',
    correlation_id: correlationId,
  };
}

/**
 * The whole 500 response, for call sites that build one directly.
 *
 * `headers` takes the function's own CORS headers; the content type is added
 * here so it cannot be forgotten. `Cache-Control: no-store` matches
 * `securityJsonError` — a correlation id is per-request and must never be
 * served from a cache to somebody else.
 */
export function internalErrorResponse(
  err: unknown,
  context: string,
  headers: Record<string, string> = {},
  correlationId: string = crypto.randomUUID(),
): Response {
  return new Response(JSON.stringify(internalError(err, context, correlationId)), {
    status: 500,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * An error whose message was WRITTEN for the caller to read.
 *
 * ## Why this exists
 *
 * The opacity above is right for a caught driver error and wrong for a
 * sentence somebody composed on purpose. `email-copilot` had already been
 * fixed once to explain a failed model call — "the AI provider rejected this
 * deployment's credential", "the account has no remaining balance" — and the
 * operator still saw **"Internal error"**, because the handler threw that
 * sentence and the outer catch flattened every throw into an opaque body.
 * The diagnosis was written, logged, and then discarded one stack frame
 * before it reached the person who needed it.
 *
 * So the distinction is carried by the error's TYPE rather than guessed from
 * its text: an error is safe to show only when the code that raised it says
 * so. Nothing else changes — an unrecognised throw is still opaque, which is
 * what keeps a Postgres message off the screen.
 *
 * ## The rule for its message
 *
 * The message must be authored, never interpolated from an upstream body. A
 * provider's error payload can name a model, an organisation or an internal
 * host, so it belongs in the log with the correlation id like everything
 * else. State what failed and what the operator can do about it.
 */
export class OperatorFacingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'OperatorFacingError';
    this.status = options.status ?? 502;
    this.code = options.code ?? 'upstream_failed';
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isOperatorFacingError(err: unknown): err is OperatorFacingError {
  return err instanceof OperatorFacingError;
}

/**
 * The 5xx response for a caught value: the authored sentence when there is
 * one, an opaque body otherwise.
 *
 * Both paths log in full against a correlation id — an operator-facing
 * message is a summary for a toast, not a substitute for the evidence.
 */
export function failureResponse(
  err: unknown,
  context: string,
  headers: Record<string, string> = {},
): Response {
  if (isOperatorFacingError(err)) {
    const correlationId = crypto.randomUUID();
    console.error(`[${context}] ${err.code} correlation_id=${correlationId}`, describe(err));
    return new Response(
      JSON.stringify({ error: err.message, code: err.code, correlation_id: correlationId }),
      {
        status: err.status,
        headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      },
    );
  }
  return internalErrorResponse(err, context, headers);
}
