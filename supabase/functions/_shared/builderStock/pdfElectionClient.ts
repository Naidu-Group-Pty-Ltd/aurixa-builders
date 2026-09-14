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
  if (route.kind === 'in_process') {
    return await electFromPdfBytes(bytes, readPageTexts, context);
  }
  /*
   * NO SILENT FALLBACK. Under the worker runtime the in-process election is
   * the thing measured to exceed the CPU ceiling, so running it here when the
   * worker is missing or broken would re-create the exact failure this change
   * exists to fix — and would spend the whole item budget doing it. The
   * property is told nothing and asked again instead.
   */
  if (route.kind === 'no_capacity') return unreachable(route.detail);
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
