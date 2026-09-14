/**
 * BUILDER STOCK — WHERE THE HEAVY ELECTION RUNS, AND WHY.
 *
 * ONE DECISION, IN ONE PLACE, SO IT CAN BE READ AND TESTED. The election
 * either runs in this process, or on `builder-stock-pdf-worker`, or it does
 * not run at all — and the third of those is a deliberate state, not an
 * oversight.
 *
 * THE MEASUREMENT THAT DECIDES IT. Per-execution platform telemetry, 8
 * September 2026: thirteen settler kills in one cold start, EVERY one
 * `reason: CPUTime` — successes ending at 1,828 ms of CPU or less, kills at
 * 2,031 ms or more, against a 2,000 ms limit — while memory peaked at 108 MB
 * of 256. Reading one heavy brochure and electing its image is indivisible and
 * costs about 2.4 s. It does not fit, and no scheduling rule makes it fit.
 *
 * SO UNDER THE NEW RUNTIME THERE IS NO IN-PROCESS FALLBACK FOR THE HEAVY PATH.
 * That is the rule this module exists to hold. Falling back to the in-process
 * election when the worker is missing or fails would simply re-run the thing
 * measured to die, spend the item's whole budget doing it, and re-create the
 * exact `CPUTime` failure this change is for. `no_capacity` is answered
 * instead, the caller reports it as `unreachable`, and the property is asked
 * again later — nothing is written down about the document.
 *
 * AND UNTIL THE RUNTIME IS BUMPED, NOTHING CHANGES AT ALL. Below
 * `WORKER_RUNTIME_VERSION` the answer is always `in_process`, which is exactly
 * what production does today: normal documents elect in the Edge function and
 * heavy ones fail as they already do. The worker cannot be reached, cannot be
 * accidentally depended on, and no behaviour moves until somebody deliberately
 * advances the runtime after the worker is deployed and proven.
 *
 * Pure: no env, no IO, no clock. The caller reads the environment and hands
 * the values in, so this rule is testable without one.
 */

/**
 * The runtime at which the election moves to the worker.
 *
 * `RUNTIME_VERSION` is 2 today, so every branch of this resolves to
 * `in_process` in production right now. Advancing it to 3 is a separate,
 * deliberate act that happens only after the worker is deployed, its bearer
 * configured, and both canary documents proven — and it is what re-arms the
 * fleet so the properties that failed reopen on their own.
 */
export const WORKER_RUNTIME_VERSION = 3;

export type ElectionRoute =
  /** Today's behaviour, byte for byte: the election runs here. */
  | { kind: 'in_process' }
  /** The election runs on the worker. A failure is operational, never a verdict. */
  | { kind: 'worker'; endpoint: string; token: string }
  /**
   * The heavy election has nowhere to run. The caller answers `unreachable`
   * and the property is asked again — it must NOT run the election here.
   */
  | { kind: 'no_capacity'; detail: string };

export function electionRoute(input: {
  runtimeVersion: number;
  /** `BUILDER_STOCK_PDF_WORKER_URL`, already read from the environment. */
  endpoint: string;
  /** `BUILDER_STOCK_PDF_WORKER_TOKEN`, already read from the environment. */
  token: string;
}): ElectionRoute {
  if (!Number.isFinite(input.runtimeVersion)
    || input.runtimeVersion < WORKER_RUNTIME_VERSION) {
    return { kind: 'in_process' };
  }
  /*
   * Quotes are stripped for the reason `inpaintOverlay` strips them: a secret
   * pasted into the dashboard with its quotes produces a bearer token that is
   * silently wrong, and the failure looks like an outage rather than a typo.
   */
  const endpoint = input.endpoint.trim().replace(/\/+$/, '');
  const token = input.token.trim().replace(/^["']+|["']+$/g, '');
  if (!endpoint || !token) {
    return {
      kind: 'no_capacity',
      detail: 'The document reader is not available on this deployment, so that '
        + 'package could not be read.',
    };
  }
  return { kind: 'worker', endpoint, token };
}
