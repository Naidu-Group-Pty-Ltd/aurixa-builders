/**
 * WAIT FOR THE NEW BEARER TO BE THE LIVE ONE, NOT MERELY FOR A BEARER TO EXIST.
 *
 * MEASURED, DEPLOY RUN 35204922096. `wrangler secret put` returned at 09:24:54
 * and the canary started 0.8 s later. What it got back, in this order:
 *
 *   09:24:55.020  POST /v1/nope            401   (expected 404)
 *   09:24:55.277  POST /v1/elect, bad ctx   400   (expected 400 — accepted)
 *   09:24:55.312  POST /v1/elect, empty     401   (expected 413)
 *   09:24:55.345  POST /v1/elect, brochure  401   (expected 200)
 *   09:25:09.628  POST /v1/elect, 8.6 MB    200   (accepted, 789 ms)
 *
 * The same bearer, accepted and rejected within 300 ms of itself, then
 * accepted consistently once ~14 s had passed. That is a secret still
 * propagating across isolates: this worker already held a DIFFERENT value for
 * `BUILDER_STOCK_PDF_WORKER_TOKEN` from its 8 September deployment, so an
 * isolate that had not yet seen the new value did not answer 503
 * (`worker_token_not_configured`) — it compared against the OLD value and
 * answered 401, which is indistinguishable from a genuinely wrong token.
 *
 * WHY `/health` COULD NOT HAVE CAUGHT THIS. It is unauthenticated by design
 * and reports `Boolean(env.BUILDER_STOCK_PDF_WORKER_TOKEN)`. An isolate
 * holding the OLD secret answers it 200, truthfully: a token IS configured.
 * The question the deploy actually needs answered is a different one — is the
 * token I just set the one being compared against — and only an authenticated
 * request can answer it.
 *
 * SO THE PROBE IS AUTHENTICATED AND COSTS NOTHING: `POST /v1/nope` with the
 * new bearer. The front door authenticates BEFORE it routes, so 404 is
 * reachable only by a caller whose token matched, and no election runs.
 *
 *   404 → the new token is live on the isolate that served this request
 *   401 → not yet; the streak resets
 *   503 → no token at all yet; the streak resets
 *   other → reported and retried, because an unexplained answer is not a pass
 *
 * WHAT THIS DOES NOT PROMISE. One probe speaks for one isolate. Requiring a
 * STREAK of consecutive successes, spaced out, makes it progressively less
 * likely that a stale isolate is still serving — it does not prove none is.
 * That is why this gate does not replace the canary's assertions: it only
 * stops the canary being run into a race it would report as a real failure.
 * A 401 the canary sees after this gate has passed is a genuine defect.
 *
 * AUTHENTICATION IS NOT WEAKENED ANYWHERE. Nothing here changes what the
 * worker accepts; it changes only when we start asking.
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const base = String(arg('--url', '')).replace(/\/+$/, '');
const token = process.env.BUILDER_STOCK_PDF_WORKER_TOKEN ?? '';
const needed = Number(arg('--streak', '3'));
const timeoutMs = Number(arg('--timeout-ms', '180000')) ;
const gapMs = Number(arg('--gap-ms', '2000'));

if (!base) {
  console.error('[await-token] no --url given; nothing to wait for.');
  process.exit(1);
}
if (!token) {
  console.error('[await-token] BUILDER_STOCK_PDF_WORKER_TOKEN is not set in this '
    + 'environment, so the probe cannot be authenticated. Refusing to report a '
    + 'deployment ready on the strength of an unauthenticated check.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
let streak = 0;
let attempts = 0;
let firstAccepted = null;

while (Date.now() - startedAt < timeoutMs) {
  attempts += 1;
  let status = 0;
  let detail = '';
  try {
    const res = await fetch(`${base}/v1/nope`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    if (status !== 404) detail = (await res.text().catch(() => '')).slice(0, 120);
  } catch (error) {
    detail = String(error).slice(0, 120);
  }

  const elapsed = Date.now() - startedAt;
  if (status === 404) {
    streak += 1;
    if (firstAccepted === null) firstAccepted = elapsed;
    console.log(`[await-token] attempt ${attempts} @${elapsed}ms: 404 — the new token is `
      + `live here (${streak}/${needed})`);
    if (streak >= needed) {
      console.log(`[await-token] READY after ${attempts} probes, ${elapsed} ms; first `
        + `acceptance at ${firstAccepted} ms.`);
      process.exit(0);
    }
  } else {
    if (streak) {
      console.log(`[await-token] attempt ${attempts} @${elapsed}ms: ${status} — streak reset `
        + 'after a stale isolate answered; still propagating.');
    } else {
      console.log(`[await-token] attempt ${attempts} @${elapsed}ms: ${status || 'no answer'} `
        + `${detail}`);
    }
    streak = 0;
  }
  await sleep(gapMs);
}

console.error(`[await-token] NOT READY after ${attempts} probes over ${timeoutMs} ms. The `
  + 'bearer just written is still not the one this worker compares against. That is not a '
  + 'race any more — it is a failure, and the canary must not be run into it.');
process.exit(1);
