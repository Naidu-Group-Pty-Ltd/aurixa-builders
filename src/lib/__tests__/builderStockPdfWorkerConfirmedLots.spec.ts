/**
 * A CONFIRMED LOT CROSSES TO THE PDF WORKER, AND NOTHING ELSE CHANGES ON THE
 * WIRE.
 *
 * The cover rules run in `builder-stock-pdf-worker`, which deploys on its own
 * lane and on its own clock. So the lot a builder confirmed has to travel in
 * the election context — and the change that carries it must not cost a
 * single ordinary election anything during the minutes the two lanes
 * disagree:
 *
 *   an election with NO confirmation is still asked under protocol 2, which
 *   every deployed worker speaks, and a worker built now answers it in
 *   protocol 2, which every deployed settler accepts;
 *
 *   an election WITH one is asked under protocol 3, and a worker that cannot
 *   read protocol 3 refuses it — `unreachable`, a retry, never a verdict — so
 *   an old worker can never answer a confirmed question as if it had been
 *   asked the unconfirmed one.
 *
 * Held out: written before the change. Cases marked GUARD hold on both sides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELECTION_CONTEXT_HEADER, decodeElectionContext, encodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';
import { runElectionOnRoute } from '../../../supabase/functions/_shared/builderStock/pdfElectionClient';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText';
import { PdfElection } from '../../../workers/builder-stock-pdf-worker/src/pdfElection.do';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONTEXT = {
  label: 'Lot 2046, Brindabella Park',
  identifiedBy: 'direct_link' as const,
  design: 'Orion 22',
  identityHints: ['Kestrel Rise'],
  documentName: 'the linked document',
  url: 'https://drive.google.com/uc?export=download&id=fixture-2046',
};
const CONFIRMED = { ...CONTEXT, confirmedLots: ['2064'] };
const SOME_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ROUTE = { kind: 'worker' as const, endpoint: 'https://pdf.example.workers.dev', token: 'tok' };

describe('the settler asks, and believes only an answer to what it asked', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const reply = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const sent = () => decodeElectionContext(
    fetchMock.mock.calls[0][1].headers[ELECTION_CONTEXT_HEADER]) as any;
  const run = (context: unknown) => runElectionOnRoute(
    SOME_PDF, readPdfPageTextResult, context as any, ROUTE);

  it('GUARD — an ordinary election is asked and answered under protocol 2', async () => {
    fetchMock.mockResolvedValue(reply({ protocol: 2, status: 'not_identified', detail: 'read' }));
    const outcome = await run(CONTEXT);
    expect(sent().protocol).toBe(2);
    expect(outcome.status).toBe('not_identified');
  });

  it('GUARD — an ordinary election answered under another protocol is not believed', async () => {
    fetchMock.mockResolvedValue(reply({ protocol: 3, status: 'not_identified', detail: 'read' }));
    expect((await run(CONTEXT)).status).toBe('unreachable');
  });

  it('a confirmed election carries its lot under protocol 3', async () => {
    fetchMock.mockResolvedValue(reply({ protocol: 3, status: 'not_identified', detail: 'read' }));
    const outcome = await run(CONFIRMED);
    expect(sent().protocol).toBe(3);
    expect(sent().confirmedLots).toEqual(['2064']);
    expect(outcome.status).toBe('not_identified');
  });

  it('a confirmed election answered in the old protocol is not believed', async () => {
    // A worker that answered protocol 2 was asked, as far as it knows, the
    // UNCONFIRMED question. Its refusal is not an answer to this one.
    fetchMock.mockResolvedValue(reply({ protocol: 2, status: 'not_identified', detail: 'read' }));
    expect((await run(CONFIRMED)).status).toBe('unreachable');
  });
});

describe('the worker answers in the protocol it was asked in', () => {
  const lane = () => new PdfElection({} as never, {} as never);
  const ask = (context: unknown) => lane().fetch(new Request('https://do/v1/elect', {
    method: 'POST',
    body: SOME_PDF as unknown as BodyInit,
    headers: { [ELECTION_CONTEXT_HEADER]: encodeElectionContext(context as any) },
  }));

  it('GUARD — protocol 2 for an ordinary election', async () => {
    const res = await ask(CONTEXT);
    expect(res.status).toBe(200);
    expect((await res.json()).protocol).toBe(2);
  });

  it('protocol 3 for a confirmed one', async () => {
    const res = await ask(CONFIRMED);
    expect(res.status).toBe(200);
    expect((await res.json()).protocol).toBe(3);
  });
});
