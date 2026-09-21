/**
 * BUILDER PORTAL — WHO ANSWERED, THE PLATFORM OR THE FUNCTION.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE SECOND TIME.
 *
 * `invokeBuilderFunction` already carries the rule that a request which never
 * produced a response did not necessarily fail: an edge worker killed on its
 * resource limit commits everything it had already written, emits no body and
 * no CORS headers, and `fetch` rejects with "Failed to fetch" — a statement
 * about the tab, not about the server. That was written after 27 AUGUST 2026,
 * when a stock import was killed AFTER committing the upload and every
 * property in it, the portal announced a failure, and the builder reasonably
 * imported the same list again.
 *
 * The rule was right and it was installed on one door only. A worker kill does
 * not always reach the browser as a rejected `fetch`: the platform can answer
 * FOR the dead worker, and then the browser has an ordinary `Response` with a
 * status code and no body of the function's own.
 *
 * MEASURED, 21 SEPTEMBER 2026. Two POSTs to `builder-portal-stock` answered
 * **546** — `function_logs` carries `CPU Time exceeded` against both. On the
 * second, upload `5511d2e2` (a 9.5 MB brochure) had already written its
 * property, its nine images and its own telemetry line reading
 * `outcome: "imported", properties_imported: 1`; the kill landed NINE
 * MILLISECONDS after that line, while the run was writing its final counters.
 * Because 546 is a real status, the answer took the `!response.ok` branch,
 * became `HTTP 546` with no code, and the page drew the destructive
 * "The stock list could not be imported" over a property that had imported.
 * Exactly the 27 August failure, through the other door.
 *
 * SO THE SHAPE OF THE ANSWER DECIDES, NEVER THE DIGIT ALONE. Two conditions,
 * and both are required:
 *
 *   - the status is one the PLATFORM emits on behalf of a worker it killed or
 *     could not reach, and
 *   - the body carries nothing this function wrote.
 *
 * The second is what keeps it honest. A handler that answers 503 with its own
 * `{ error, code }` has spoken for itself and is reported as it asked to be;
 * only a silence wearing a status code is read as undetermined. This is the
 * same rule `classifyServiceAnswer` applies to a render host's front door:
 * the host's error page is not the engine's answer.
 *
 * UNDETERMINED IS NOT SUCCESS. It is the refusal to state either outcome, and
 * the caller's job is to send the reader to the record — which is the one
 * place that knows.
 *
 * Pure: no IO, no clock, no network.
 */

/**
 * The statuses the platform emits when no function answered.
 *
 * 546 is the Supabase edge runtime's WORKER_LIMIT — the worker exceeded its
 * memory or CPU allowance and was killed mid-request. The two gateway codes
 * are here for the same reason and not by analogy: a 502 and a 504 with no
 * body are the front door reporting that it never got an answer to relay.
 *
 * Deliberately NOT here: 500. A 500 is overwhelmingly this product's own
 * handler failing and saying so, and admitting it would turn every genuine
 * server error into "we do not know", which is worse than a plain refusal.
 */
export const PLATFORM_SILENCE_STATUSES: readonly number[] = [546, 502, 504];

/**
 * Did the function itself say anything?
 *
 * A body is the function's own when it parsed and carries either of the two
 * fields every handler here answers with. Anything else — null from a failed
 * parse, an empty object, the platform's own HTML — is not this function
 * speaking.
 */
export function bodyIsFunctionsOwn(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return typeof record.error === 'string' && record.error.length > 0
    || typeof record.code === 'string' && record.code.length > 0;
}

/**
 * Is this non-ok answer the platform standing in for a worker that never
 * reported back?
 */
export function isPlatformSilence(status: number, body: unknown): boolean {
  if (!PLATFORM_SILENCE_STATUSES.includes(status)) return false;
  return !bodyIsFunctionsOwn(body);
}

/**
 * What a caller is told when the platform answered and the function did not.
 *
 * The same sentence the rejected-`fetch` path uses, because it describes the
 * same event and two wordings for one state is how one of them comes to
 * promise something the other does not.
 */
export const UNDETERMINED_ANSWER_MESSAGE =
  'The server did not answer this request, so whether it completed is '
  + 'unknown. Refresh before trying again.';

/** The code every undetermined answer carries, whichever door it came through. */
export const UNDETERMINED_ANSWER_CODE = 'transport_failed';
