/**
 * THE HEAVY PDF ELECTION, FROM THE EDGE'S SIDE OF THE WIRE AND THE WORKER'S.
 *
 * WHY THIS FILE EXISTS. The election already moved off the Supabase edge —
 * `RUNTIME_VERSION` is past `WORKER_RUNTIME_VERSION`, so every heavy document
 * is routed to a worker — and until now NOTHING in this repository tested the
 * boundary that carries it, the rule that chooses the route, or the worker
 * that answers. The worker itself was deployed from a working tree that was
 * never committed, which is the same problem stated as a fact about git.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD. `not_identified` is a VERDICT —
 * it is banked, and `negativeProvenanceStillStands` then suppresses that
 * source until a version bump. `unreachable` records nothing and retries. So
 * every way the wire can go wrong must be `unreachable`, and the client must
 * be INCAPABLE of producing `not_identified` on its own. That is asserted
 * below one failure at a time, because a single missed path is a builder's
 * document permanently written off on the strength of a network error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ELECTION_CONTEXT_HEADER, ELECTION_TIMEOUT_MS, MAX_DOCUMENT_BYTES,
  PDF_ELECTION_PROTOCOL, base64ToBytes, bytesToBase64,
  decodeElectionContext, encodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';
import {
  WORKER_RUNTIME_VERSION, electionRoute,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionRoute.pure';
import { RUNTIME_VERSION } from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';
import { runElectionOnRoute } from '../../../supabase/functions/_shared/builderStock/pdfElectionClient';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText';
import workerEntry, { type Env } from '../../../workers/builder-stock-pdf-worker/src/index';
import { ELECTION_LANE, PdfElection } from '../../../workers/builder-stock-pdf-worker/src/pdfElection.do';

const CONTEXT = {
  label: 'Lot 717 — Enzo 10.5 Modern',
  identifiedBy: 'folder_structure' as const,
  design: 'Enzo 10.5',
  identityHints: ['Watsons Reach', 'Lot 717'],
  documentName: 'LOT 717 - ENZO 10.5 MODERN - BROCHURE V002.pdf',
  url: 'https://drive.google.com/file/d/abc/view',
};

/** Any non-empty body; the route under test never looks inside it. */
const SOME_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

/** The election reader, by identity — the client branches on exactly this. */
const PRODUCTION_READER = readPdfPageTextResult;

describe('the wire between the settler and the PDF worker', () => {
  it('carries a context through base64 and back unchanged', () => {
    const decoded = decodeElectionContext(encodeElectionContext(CONTEXT));
    expect(decoded).toEqual({ protocol: PDF_ELECTION_PROTOCOL, ...CONTEXT });
  });

  /**
   * `btoa` is Latin-1 and THROWS on an em-dash. A builder's label carries
   * em-dashes and accented estate names as a matter of course, so this is the
   * ordinary case rather than an edge one.
   */
  it('carries labels that btoa alone would throw on', () => {
    const context = { ...CONTEXT, label: 'Lot 9 — Estée · Côte d’Azur — 日本' };
    const decoded = decodeElectionContext(encodeElectionContext(context));
    expect(decoded?.label).toBe(context.label);
  });

  it('refuses a context it cannot vouch for rather than defaulting one', () => {
    expect(decodeElectionContext(null)).toBeNull();
    expect(decodeElectionContext('')).toBeNull();
    expect(decodeElectionContext('not base64 at all !!')).toBeNull();
    expect(decodeElectionContext(btoa('{"not":"a context"}'))).toBeNull();
    // A protocol this deployment does not speak. Encoded the same UTF-8 way
    // the real encoder does, because `btoa` throws on this label's em-dash —
    // which is the whole reason the encoder does not use it.
    const future = bytesToBase64(new TextEncoder().encode(
      JSON.stringify({ ...CONTEXT, protocol: PDF_ELECTION_PROTOCOL + 1 })));
    expect(decodeElectionContext(future)).toBeNull();
    // The label is the property. Without it nothing may be elected.
    const unlabelled = bytesToBase64(new TextEncoder().encode(
      JSON.stringify({ ...CONTEXT, protocol: PDF_ELECTION_PROTOCOL, label: '' })));
    expect(decodeElectionContext(unlabelled)).toBeNull();
    // `identifiedBy` decides whether a structural cover is licensed at all.
    const unattributed = bytesToBase64(new TextEncoder().encode(
      JSON.stringify({ ...CONTEXT, protocol: PDF_ELECTION_PROTOCOL, identifiedBy: 'vibes' })));
    expect(decodeElectionContext(unattributed)).toBeNull();
  });

  /**
   * `String.fromCharCode(...bytes)` blows the call stack somewhere in the low
   * hundreds of thousands, and Lot 6706's elected render is 2,637,765 bytes.
   * The chunked encoder is the fix; this is the size that proves it.
   */
  it('base64-encodes an elected image far past the argument-spread limit', () => {
    const big = new Uint8Array(3_000_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const round = base64ToBytes(bytesToBase64(big));
    expect(round.length).toBe(big.length);
    expect(round[0]).toBe(big[0]);
    expect(round[1_500_001]).toBe(big[1_500_001]);
    expect(round[big.length - 1]).toBe(big[big.length - 1]);
  });

  it('keeps the wait inside the branch deadline', () => {
    // 75 s is RECOVERY_DEADLINE_MS. If this ever exceeded it the worker, not
    // the branch, would decide an item's fate.
    expect(ELECTION_TIMEOUT_MS).toBeLessThan(75_000);
    expect(MAX_DOCUMENT_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('where the heavy election runs', () => {
  const WORKER = { endpoint: 'https://pdf.example.workers.dev', token: 'tok' };

  it('stays in process below the worker runtime', () => {
    expect(electionRoute({ runtimeVersion: WORKER_RUNTIME_VERSION - 1, ...WORKER }))
      .toEqual({ kind: 'in_process' });
  });

  it('goes to the worker when the runtime has advanced and both secrets are set', () => {
    expect(electionRoute({ runtimeVersion: WORKER_RUNTIME_VERSION, ...WORKER }))
      .toEqual({ kind: 'worker', endpoint: WORKER.endpoint, token: 'tok' });
  });

  it('strips the trailing slash and the quotes a console paste leaves behind', () => {
    const route = electionRoute({
      runtimeVersion: WORKER_RUNTIME_VERSION,
      endpoint: '  https://pdf.example.workers.dev//  ',
      token: '  "tok"  ',
    });
    expect(route).toEqual({ kind: 'worker', endpoint: WORKER.endpoint, token: 'tok' });
  });

  it('answers no_capacity — never in_process — when a secret is missing', () => {
    for (const missing of [{ endpoint: '', token: 'tok' }, { endpoint: WORKER.endpoint, token: '' }]) {
      const route = electionRoute({ runtimeVersion: WORKER_RUNTIME_VERSION, ...missing });
      expect(route.kind).toBe('no_capacity');
    }
  });

  /**
   * THE FACT THAT MADE THIS WHOLE WORKER NECESSARY, PINNED.
   *
   * The shipped runtime is past the version at which the election moves, so a
   * deployment with no worker configured has already left the in-process path
   * behind. If someone lowers `RUNTIME_VERSION` this fails, which is the point:
   * the two numbers are a contract, not a coincidence.
   */
  it('has already advanced past the version that moves the election', () => {
    expect(RUNTIME_VERSION).toBeGreaterThanOrEqual(WORKER_RUNTIME_VERSION);
  });
});

describe('the client cannot invent a verdict about a builder’s document', () => {
  const ROUTE = {
    kind: 'worker' as const,
    endpoint: 'https://pdf.example.workers.dev',
    token: 'tok',
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  const run = () => runElectionOnRoute(SOME_PDF, PRODUCTION_READER, CONTEXT, ROUTE);

  it('sends the document as the raw body with the context in its header', async () => {
    fetchMock.mockResolvedValue(reply({ protocol: PDF_ELECTION_PROTOCOL, status: 'not_identified', detail: 'x' }));
    await run();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://pdf.example.workers.dev/v1/elect');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['content-type']).toBe('application/pdf');
    expect(init.body).toBe(SOME_PDF);
    const carried = decodeElectionContext(init.headers[ELECTION_CONTEXT_HEADER]);
    expect(carried?.label).toBe(CONTEXT.label);
    // Nothing that could identify a row may cross.
    const wire = JSON.stringify(carried);
    for (const forbidden of ['organisation', 'upload_id', 'stock_item', 'service_role']) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it.each([
    ['the worker cannot be reached', () => fetchMock.mockRejectedValue(new Error('boom'))],
    ['the worker refuses', () => fetchMock.mockResolvedValue(reply({ error: 'unauthorised' }, 401))],
    ['the worker is unconfigured', () => fetchMock.mockResolvedValue(reply({ error: 'worker_token_not_configured' }, 503))],
    ['the answer is not JSON', () => fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 200 }))],
    ['the answer speaks another protocol', () => fetchMock.mockResolvedValue(
      reply({ protocol: PDF_ELECTION_PROTOCOL + 1, status: 'not_identified', detail: 'x' }))],
    ['the answer is an outcome we do not know', () => fetchMock.mockResolvedValue(
      reply({ protocol: PDF_ELECTION_PROTOCOL, status: 'elected_probably' }))],
    ['the answer has no usable image', () => fetchMock.mockResolvedValue(
      reply({ protocol: PDF_ELECTION_PROTOCOL, status: 'recovered', image: { bytes: 'AA==' } }))],
    ['the image will not decode', () => fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL, status: 'recovered',
      image: {
        bytes: '!!!not base64!!!', contentType: 'image/png',
        reference: `${CONTEXT.documentName}#page1:Im0`, provenance: { page: 1 }, role: { role: 'primary' },
      },
    }))],
    ['the image is empty', () => fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL, status: 'recovered',
      image: {
        bytes: '', contentType: 'image/png',
        reference: `${CONTEXT.documentName}#page1:Im0`, provenance: { page: 1 }, role: { role: 'primary' },
      },
    }))],
    ['the answer is about a different document', () => fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL, status: 'recovered',
      image: {
        bytes: bytesToBase64(new Uint8Array([1, 2, 3])), contentType: 'image/png',
        reference: 'SOMEBODY ELSE.pdf#page1:Im0', provenance: { page: 1 }, role: { role: 'primary' },
      },
    }))],
  ])('is unreachable, never not_identified, when %s', async (_name, arrange) => {
    arrange();
    const outcome = await run();
    expect(outcome.status).toBe('unreachable');
  });

  it('relays not_identified only because the worker read the document and said so', async () => {
    fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL,
      status: 'not_identified',
      detail: 'That document does not present a page as this property’s package cover.',
    }));
    const outcome = await run();
    expect(outcome.status).toBe('not_identified');
    expect('detail' in outcome && outcome.detail).toContain('package cover');
  });

  it('returns the elected image with the provenance the worker proved', async () => {
    const pixels = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 99, 99]);
    fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL,
      status: 'recovered',
      image: {
        bytes: bytesToBase64(pixels),
        contentType: 'image/png',
        reference: `${CONTEXT.documentName}#page1:Im0`,
        provenance: { page: 1, method: 'embedded_raster', sourceSha256: 'abc', storedSha256: 'abc' },
        role: { role: 'primary', evidence: 'cover' },
      },
    }));
    const outcome = await run();
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') throw new Error('unreachable');
    expect(Array.from(outcome.image.bytes)).toEqual(Array.from(pixels));
    expect(outcome.image.documentName).toBe(CONTEXT.documentName);
    expect(outcome.image.documentUrl).toBe(CONTEXT.url);
    expect(outcome.image.provenance).toMatchObject({ page: 1, method: 'embedded_raster' });
  });

  it('refuses a document outside the wire’s bounds without calling the worker', async () => {
    const empty = await runElectionOnRoute(new Uint8Array(0), PRODUCTION_READER, CONTEXT, ROUTE);
    expect(empty.status).toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the worker’s front door', () => {
  const TOKEN = 'a-shared-secret-value';
  const call = (path: string, init: RequestInit = {}, env: Partial<Env> = {}) =>
    workerEntry.fetch(
      new Request(`https://pdf.example.workers.dev${path}`, init),
      { BUILDER_STOCK_PDF_WORKER_TOKEN: TOKEN, PDF_ELECTION: {} as never, ...env } as Env,
    );

  it('reports itself unhealthy, and serves nothing, until a token is configured', async () => {
    const health = await call('/health', {}, { BUILDER_STOCK_PDF_WORKER_TOKEN: undefined });
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, service: 'builder-stock-pdf-worker' });

    const elect = await call('/v1/elect', { method: 'POST' }, { BUILDER_STOCK_PDF_WORKER_TOKEN: undefined });
    expect(elect.status).toBe(503);
    expect(await elect.json()).toMatchObject({ error: 'worker_token_not_configured' });
  });

  it('states the protocol it speaks, so a deploy can refuse a mismatch', async () => {
    const health = await call('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, protocol: PDF_ELECTION_PROTOCOL });
  });

  it('never states the token', async () => {
    const body = await (await call('/health')).text();
    expect(body).not.toContain(TOKEN);
  });

  it.each([
    ['no authorization header at all', {}],
    ['a bearer that is not the token', { authorization: `Bearer ${TOKEN}x` }],
    ['a prefix of the token', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['the token without the scheme', { authorization: TOKEN }],
    ['an empty bearer', { authorization: 'Bearer ' }],
  ])('refuses %s', async (_name, headers) => {
    const res = await call('/v1/elect', { method: 'POST', headers: headers as HeadersInit });
    expect(res.status).toBe(401);
  });

  it('accepts the scheme however it is cased', async () => {
    const seen: string[] = [];
    const res = await call('/v1/elect', {
      method: 'POST',
      headers: { authorization: `BeArEr ${TOKEN}` },
    }, {
      PDF_ELECTION: {
        idFromName: (name: string) => { seen.push(name); return name; },
        get: () => ({ fetch: async () => new Response('{"ok":true}', { status: 200 }) }),
      } as never,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([ELECTION_LANE]);
  });

  /**
   * ROUTING AFTER AUTHENTICATION. An anonymous 404 would map the worker for
   * whoever asked; an anonymous caller learns only that it wants a token.
   */
  it('answers 401 rather than 404 for an unknown path without a token', async () => {
    const res = await call('/v1/whatever', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['an unknown path', '/v1/whatever', 'POST'],
    ['the right path with the wrong method', '/v1/elect', 'GET'],
  ])('answers 404 for %s once authenticated', async (_name, path, method) => {
    const res = await call(path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it('routes every election to one lane, so one document is resident at a time', async () => {
    const names: string[] = [];
    await call('/v1/elect', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, {
      PDF_ELECTION: {
        idFromName: (name: string) => { names.push(name); return name; },
        get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
      } as never,
    });
    expect(names).toEqual([ELECTION_LANE]);
  });
});

describe('the election lane', () => {
  const lane = () => new PdfElection({} as never, {} as never);
  const request = (body: BodyInit | null, context: string | null) => new Request(
    'https://do/v1/elect',
    { method: 'POST', body, headers: context ? { [ELECTION_CONTEXT_HEADER]: context } : {} },
  );

  it('refuses a context it cannot vouch for rather than electing a default', async () => {
    const res = await lane().fetch(request(SOME_PDF, 'rubbish'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_context' });
  });

  it.each([
    ['an empty document', new Uint8Array(0)],
    ['a document past the wire’s ceiling', new Uint8Array(MAX_DOCUMENT_BYTES + 1)],
  ])('refuses %s before any decoding begins', async (_name, bytes) => {
    const res = await lane().fetch(request(bytes as unknown as BodyInit, encodeElectionContext(CONTEXT)));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'bad_document' });
  });

  /**
   * The lane is the memory bound. Two elections entering together would both
   * be resident — each holding a multi-megabyte document and its decoded
   * pages — in one 128 MB isolate.
   */
  it('runs one election at a time, in order, even when they arrive together', async () => {
    const object = lane();
    const order: string[] = [];
    const settle: Array<() => void> = [];
    const work = (name: string) => () => new Promise<string>((resolve) => {
      order.push(`start:${name}`);
      settle.push(() => { order.push(`end:${name}`); resolve(name); });
    });
    const a = object.queue(work('a'));
    const b = object.queue(work('b'));
    await Promise.resolve();
    expect(order).toEqual(['start:a']);
    settle[0]();
    await a;
    await Promise.resolve();
    settle[1]();
    await b;
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('releases the lane when an election throws, so one failure cannot wedge it', async () => {
    const object = lane();
    const failed = object.queue(async () => { throw new Error('decode died'); });
    await expect(failed).rejects.toThrow('decode died');
    await expect(object.queue(async () => 'still works')).resolves.toBe('still works');
  });
});
