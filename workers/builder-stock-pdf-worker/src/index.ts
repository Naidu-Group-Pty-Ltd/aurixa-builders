/**
 * BUILDER STOCK — THE PDF WORKER'S FRONT DOOR.
 *
 * THREE JOBS, AND NOTHING ELSE: prove the caller holds the shared token,
 * refuse everything that is not the one endpoint, and hand the request to the
 * election lane. No election logic lives here; see `pdfElection.do.ts` for why
 * none lives there either.
 *
 * WHAT THIS WORKER IS NEVER TOLD. The wire carries one PDF and a small
 * context — a label, how the document came to be this property's, a design,
 * some estate names, a document name and its URL. No row id, no organisation
 * id, no upload id, no database credential. The worker computes and answers,
 * and cannot act on a property even in principle because it is never told
 * which property row it is looking at. That is a property of the contract in
 * `pdfElectionBoundary.pure.ts`, not a rule this file enforces, which is why
 * it holds.
 *
 * FAIL CLOSED, AND SAY SO. With no token configured the worker serves nothing
 * but a 503 — including on `/health`, whose whole purpose is to let a deploy
 * discover that state before any traffic is pointed at it. An unconfigured
 * worker that quietly accepted anonymous elections would be worse than one
 * that is down.
 */
import { ELECTION_LANE, PdfElection } from './pdfElection.do.ts';
import { PDF_ELECTION_PROTOCOL } from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';

export { PdfElection };

export interface Env {
  /** The same value the Supabase runtime holds as `BUILDER_STOCK_PDF_WORKER_TOKEN`. */
  BUILDER_STOCK_PDF_WORKER_TOKEN?: string;
  PDF_ELECTION: DurableObjectNamespace;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/**
 * COMPARED IN CONSTANT TIME, over digests rather than the secrets.
 *
 * `a === b` on two strings returns as soon as they differ, and the position it
 * returns at is a measurement of how much of the token an attacker has right.
 * Digesting both to a fixed 32 bytes first means the loop below always runs
 * the same number of iterations whatever was presented, including when the
 * presented token is a different length entirely — which a naive byte-wise
 * compare over the raw strings would leak on its own.
 */
async function tokensMatch(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /*
     * `/health` IS UNAUTHENTICATED AND DELIBERATELY DULL. It states the
     * service name, the protocol it speaks and whether a token is configured
     * — three facts a deploy needs before it points anything at this worker,
     * and none of which help an attacker. It never states the token, and it
     * never runs an election.
     */
    if (url.pathname === '/health') {
      return json({
        ok: Boolean(env.BUILDER_STOCK_PDF_WORKER_TOKEN),
        service: 'builder-stock-pdf-worker',
        protocol: PDF_ELECTION_PROTOCOL,
      }, env.BUILDER_STOCK_PDF_WORKER_TOKEN ? 200 : 503);
    }

    const expected = env.BUILDER_STOCK_PDF_WORKER_TOKEN ?? '';
    if (!expected) return json({ error: 'worker_token_not_configured' }, 503);

    const auth = request.headers.get('authorization') ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    if (!presented || !await tokensMatch(presented, expected)) {
      return json({ error: 'unauthorised' }, 401);
    }

    /*
     * AUTHENTICATION BEFORE ROUTING, on purpose. A 404 that is reachable
     * without a token turns this worker into a map of itself; an anonymous
     * caller learns only that it is a worker and that it wants a token.
     */
    if (url.pathname !== '/v1/elect' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404);
    }

    const stub = env.PDF_ELECTION.get(env.PDF_ELECTION.idFromName(ELECTION_LANE));
    return await stub.fetch(request);
  },
};
