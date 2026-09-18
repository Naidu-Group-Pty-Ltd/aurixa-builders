/**
 * BUILDER STOCK — CALLING THE PDF WORKER, AND THE ONE RULE THAT MATTERS.
 *
 * A BOUNDARY FAILURE IS NEVER A FINDING ABOUT A BUILDER'S DOCUMENT.
 *
 * `not_identified` is a VERDICT: it is banked, and `negativeProvenanceStillStands`
 * then suppresses that source until a version bump. `unreachable` records
 * nothing, retries on its own budget, and retires as a fact about our access.
 * So everything that can go wrong on this side of the wire — the worker being
 * unreachable, refusing, timing out, being killed by Cloudflare for CPU or
 * memory, or answering something that is not a result — is `unreachable`, and
 * this module is written so that it CANNOT construct `not_identified` at all.
 * The only way that value is ever produced here is by relaying one the worker
 * itself returned, having actually read the document.
 *
 * This mirrors `inpaintOverlay`'s existing boundary to the other Builder Stock
 * worker, where a configured-but-broken worker and an absent one are both
 * operational and neither is ever written down as a verdict about a picture.
 *
 * NOTHING HERE PERSISTS ANYTHING. Every write — the image, provenance, work
 * stage, settlement, availability — stays in the Supabase path exactly where
 * it already is. This sends bytes and returns an answer.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';
import { readPdfPageTextResult } from './pdfText.ts';
import { electFromPdfBytes, type ElectionContext } from './pdfElection.ts';
import { electionRoute, type ElectionRoute } from './pdfElectionRoute.pure.ts';
import {
  ELECTION_CONTEXT_HEADER, ELECTION_TIMEOUT_MS, MAX_DOCUMENT_BYTES,
  PDF_ELECTION_PROTOCOL, base64ToBytes, encodeElectionContext,
} from './pdfElectionBoundary.pure.ts';
import type { PackageOutcome } from './packageImages.ts';
import { TELEMETRY_PREFIX, pdfTelemetry } from './importTelemetry.pure.ts';

/** Env read the way the rest of Builder Stock reads it. */
function env(name: string): string {
  try {
    const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno;
    if (deno?.env?.get) return String(deno.env.get(name) ?? '');
    const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return String(node?.env?.[name] ?? '');
  } catch {
    return '';
  }
}

/** Everything this module can produce on its own. Never `not_identified`. */
const unreachable = (detail: string): PackageOutcome => ({ status: 'unreachable', detail });

/**
 * THE IN-PROCESS FALLBACK IS GONE, AND SIZE NO LONGER DECIDES ANYTHING HERE.
 *
 * Two bounds stood in this place and both were wrong in the same way — they
 * answered "which compute runs this document?" with a number of bytes. 6 MB
 * starved real brochures; 25 MB (taken from the INGEST cap, which answers only
 * "does Aurixa support this source?") admitted documents nothing had timed;
 * a 10.5 MB line taken from two production samples was no better in kind.
 *
 * `runtimeVersion.pure.ts` and `pdfElectionRoute.pure.ts` have both said the
 * rule plainly since the runtime advanced: "the election runs on the worker or
 * it does not run at all — there is deliberately no in-process fallback,
 * because falling back would re-run the thing measured to die". This module
 * did the opposite, and a spec that asserted `electionRoute` answers
 * `no_capacity` passed the whole time, because it pinned the DECISION while
 * this file ignored it.
 *
 * SO THE SIZE TEST IS DELETED RATHER THAN RETUNED. A missing or unreachable
 * worker is an operational fact: `unreachable`, retried on the item's own
 * bounded budget, naming the two secrets that fix it — for a 1 MB document and
 * a 24 MB one alike. The product's 25 MB limit still decides what may be
 * uploaded (`MAX_STOCK_FILE_BYTES`, `MAX_SOURCE_BYTES`) and 32 MB is still the
 * wire's own headroom (`MAX_DOCUMENT_BYTES`); neither is consulted to choose a
 * runtime, and nothing in this file may grow a third number that does.
 *
 * PROVEN BEFORE REMOVAL, on the three brochures carried by the five stock
 * items that were wrongly retired: the built worker bundle elected Lot 801's
 * 13.2 MB in 1,884 ms, Lot 809's 11.3 MB in 1,308 ms and Lot 810's 20.4 MB in
 * 1,311 ms, each a facade render of the right house at `primary_property`.
 * The worker reads these documents; this process never needed to.
 *
 * WHAT THIS REMOVAL IS NOT. It is not the fix for those five items, and this
 * comment must never be read as one. The worker was deployed at 02:55:28Z on
 * 18 September and the Supabase runtime was pointed at it at 02:55:56Z, both
 * BEFORE the import that retired them — so `electionRoute` answered `worker`
 * for that run and no in-process election was reachable. The bound removed
 * here was wrong in kind and would have bitten a deployment that lost its
 * worker secrets; it is not what happened here. The first incorrect
 * transition on those five rows is a separate, open question.
 */

/**
 * Run the election, wherever this deployment runs it.
 *
 * THE ONE ENTRY POINT, so "where does the heavy election run" is answered in a
 * single place rather than at each call site.
 *
 * An INJECTED reader always stays in this process. That is a fact about the
 * CALLER, decided before any worker is contacted: `recoverPackageImage` wraps
 * a test's reader in a new closure, so identity against the production reader
 * distinguishes the two exactly. It is not a failure path and can never mask
 * one — a test that hands over page texts is exercising election semantics,
 * not the boundary, and its bytes are never the multi-megabyte documents this
 * boundary exists for.
 */
export async function runElection(
  bytes: Uint8Array,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  context: ElectionContext,
): Promise<PackageOutcome> {
  if (readPageTexts !== readPdfPageTextResult) {
    return await electFromPdfBytes(bytes, readPageTexts, context);
  }
  const route = electionRoute({
    runtimeVersion: RUNTIME_VERSION,
    endpoint: env('BUILDER_STOCK_PDF_WORKER_URL'),
    token: env('BUILDER_STOCK_PDF_WORKER_TOKEN'),
  });
  return await runElectionOnRoute(bytes, readPageTexts, context, route);
}

/** Split out so a test can drive every route without touching the environment. */
export async function runElectionOnRoute(
  bytes: Uint8Array,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  context: ElectionContext,
  route: ElectionRoute,
): Promise<PackageOutcome> {
  const startedAt = Date.now();
  const outcome = await electOnRoute(bytes, readPageTexts, context, route);
  /*
   * ONE LINE PER ELECTION, SAYING WHOSE ANSWER IT IS.
   *
   * `document_verdict` is the field the last incident turned on: an operator
   * reading "no image" cannot otherwise tell a document that carries none from
   * a worker we never reached. It is TRUE only for `not_identified` and a
   * `recovered`, both of which mean the bytes were actually read — and this
   * module cannot construct `not_identified` at all, so a true reading here is
   * always the worker's own. Best-effort; a line is never worth an election.
   */
  try {
    console.info(`${TELEMETRY_PREFIX} pdf election`, pdfTelemetry({
      documentName: context.documentName,
      documentUrl: context.url,
      byteSize: bytes.length,
      route: route.kind,
      outcome: outcome.status,
      documentVerdict: outcome.status !== 'unreachable',
      role: outcome.status === 'recovered' || outcome.status === 'recovered_photograph'
        ? String((outcome as { image?: { role?: unknown } }).image?.role ?? '') || null
        : null,
      durationMs: Date.now() - startedAt,
      detail: outcome.status === 'unreachable' || outcome.status === 'not_identified'
        ? (outcome as { detail?: string }).detail ?? null
        : null,
    }));
  } catch { /* the election is the deliverable */ }
  return outcome;
}

async function electOnRoute(
  bytes: Uint8Array,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  context: ElectionContext,
  route: ElectionRoute,
): Promise<PackageOutcome> {
  /*
   * BELOW THE WORKER RUNTIME ONLY — which production is not, and cannot become
   * by accident: `RUNTIME_VERSION` is a constant past `WORKER_RUNTIME_VERSION`,
   * so `electionRoute` cannot return this to a production caller. It exists so
   * a deployment pinned to an older runtime keeps its old behaviour exactly.
   */
  if (route.kind === 'in_process') {
    return await electFromPdfBytes(bytes, readPageTexts, context);
  }
  /*
   * NO FALLBACK, AT ANY SIZE. A worker this deployment has not been given is
   * an operational fact about us, so it is `unreachable`: nothing is written
   * down about the document, the item retries on its own bounded budget, and
   * the refusal names the two secrets that end it. Electing here instead is
   * precisely the CPU failure the worker exists to end, and doing it only for
   * documents under some number of bytes is the same mistake with a smaller
   * blast radius.
   */
  if (route.kind === 'no_capacity') {
    console.error('[builderStock] pdf election worker unconfigured '
      + '(BUILDER_STOCK_PDF_WORKER_URL / BUILDER_STOCK_PDF_WORKER_TOKEN); '
      + `refusing ${bytes.length} bytes rather than electing in-process`);
    return unreachable(`${route.detail} Configure BUILDER_STOCK_PDF_WORKER_URL `
      + 'and BUILDER_STOCK_PDF_WORKER_TOKEN so this document can be read.');
  }
  return await electViaWorker(bytes, context, route.endpoint, route.token);
}

async function electViaWorker(
  bytes: Uint8Array,
  context: ElectionContext,
  endpoint: string,
  token: string,
): Promise<PackageOutcome> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
    return unreachable(`That document is ${bytes.length} bytes, which is outside `
      + 'what the document reader accepts.');
  }

  let response: Response;
  try {
    response = await meteredFetch(`${endpoint}/v1/elect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/pdf',
        [ELECTION_CONTEXT_HEADER]: encodeElectionContext(context),
      },
      /*
       * NOT COPIED. A `.slice()` here would duplicate a 14 MB brochure in the
       * isolate with the least room for it, which is the resource this whole
       * change is about.
       */
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(ELECTION_TIMEOUT_MS),
    }, {
      secretName: 'BUILDER_STOCK_PDF_WORKER_TOKEN',
      feature: 'builder-stock/pdf-election',
      metadata: { purpose: 'package_cover_election' },
    });
  } catch (error) {
    return unreachable('That document could not be read just now '
      + `(${String(error).slice(0, 120)}).`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return unreachable(`The document reader refused the request (${response.status}) `
      + `${body.slice(0, 160)}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return unreachable('The document reader returned something that was not a result.');
  }
  if (Number(body.protocol) !== PDF_ELECTION_PROTOCOL) {
    return unreachable('The document reader answered a protocol this deployment '
      + 'does not speak.');
  }

  /*
   * RELAYED, NEVER INVENTED. `not_identified` may only ever reach a caller
   * because the worker ran the shared election over the real bytes and said
   * so. Anything this side cannot make sense of is `unreachable`.
   */
  if (body.status === 'not_identified' || body.status === 'unreachable') {
    return {
      status: body.status,
      detail: typeof body.detail === 'string' ? body.detail : 'That document could not be read.',
    };
  }
  if (body.status !== 'recovered') {
    return unreachable('The document reader returned an outcome this deployment '
      + 'does not recognise.');
  }

  const image = body.image as Record<string, unknown> | undefined;
  if (!image || typeof image.bytes !== 'string' || typeof image.contentType !== 'string'
    || typeof image.reference !== 'string' || !image.provenance || !image.role) {
    return unreachable('The document reader returned a result with no usable image.');
  }
  /*
   * THE ANSWER MUST BE ABOUT THE DOCUMENT WE SENT.
   *
   * The election builds its reference as `${documentName}#page…`, and the
   * document name is something THIS side supplied. Checking the prefix costs
   * nothing and makes a whole class of confusion impossible: an answer that
   * somehow described another document could otherwise be stored as this
   * property's provenance, which is the one failure this pipeline exists to
   * prevent. A mismatch is operational, like everything else here.
   */
  if (!image.reference.startsWith(`${context.documentName}#page`)) {
    return unreachable('The document reader answered about a different document.');
  }
  let imageBytes: Uint8Array;
  try {
    imageBytes = base64ToBytes(image.bytes);
  } catch {
    return unreachable('The elected image could not be decoded from the reader\'s answer.');
  }
  if (!imageBytes.length) {
    return unreachable('The document reader returned an empty image.');
  }
  return {
    status: 'recovered',
    image: {
      bytes: imageBytes,
      contentType: image.contentType,
      reference: image.reference,
      documentName: context.documentName,
      documentUrl: context.url,
      provenance: image.provenance,
      role: image.role,
    },
  } as PackageOutcome;
}
