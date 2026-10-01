/**
 * A WORKER THAT FAILS IS NEVER AN ANSWER ABOUT A PICTURE.
 *
 * The three calls that leave the edge for the heavy-work worker — the overlay
 * repair (`/v1/sanitize`), the Dropbox folder read (`/v1/folder`) and the PDF
 * cover election (`/v1/elect`) — are driven here through their REAL client
 * modules against a local server that fails in every way a worker has been
 * seen to fail: HTTP 500 and 503, a reset connection, no answer at all (the
 * client's own timeout fires), an answer that arrives after that timeout, a
 * body that is not the protocol, a success with no picture in it, and the
 * HTML page a host serves mid-deploy. Every one must come back OPERATIONAL —
 * `operational: true` from the repair, `unreachable` from the folder and the
 * election — which is the only shape the settler retries and never writes
 * down as "this source has no photograph".
 *
 * The CONTROLS are what make that meaningful: a genuine refusal from the same
 * server (the repair's own gate, the folder's `not_identified`) must come back
 * as the CONTENT answer it is, and a healthy answer must come back as a
 * picture. A classifier that called everything operational would pass the
 * fault half and fail these.
 *
 * The timeout is the client's own `AbortSignal.timeout`, shortened here so the
 * branch it guards runs in milliseconds rather than a minute; the code under
 * test is unchanged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLDER_PATH, SANITIZE_PATH, WORK_OUTCOME_HEADER, encodeWorkDocument,
} from '../../../supabase/functions/_shared/builderStock/heavyWorkWire.pure';

type Mode =
  | 'http500' | 'http503' | 'reset' | 'hang' | 'late' | 'malformed' | 'empty' | 'html'
  | 'content' | 'healthy';

const FAULTS: Mode[] = ['http500', 'http503', 'reset', 'hang', 'late', 'malformed', 'empty', 'html'];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let mode: Mode = 'healthy';
let hits = 0;
let server: Server;
const held: ServerResponse[] = [];

function answer(path: string, res: ServerResponse): void {
  const sanitize = path === SANITIZE_PATH;
  const folder = path === FOLDER_PATH;
  switch (mode) {
    case 'http500': res.writeHead(500).end('worker exploded'); return;
    case 'http503': res.writeHead(503).end('service unavailable'); return;
    case 'html':
      res.writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>Worker threw exception</title>'); return;
    case 'malformed':
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('not the protocol'); return;
    case 'empty':
      if (sanitize) {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({ ok: true, transformation: 'overlay_repair' }) }).end();
      } else if (folder) {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({
          status: 'recovered_photograph', photograph: { reference: 'x', contentType: 'image/png' } }) }).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('');
      }
      return;
    case 'content':
      if (sanitize) {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({
          ok: false, reason: 'background_too_detailed', transformation: null, model: null }) }).end();
      } else {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({
          status: 'not_identified', detail: 'No file in that folder names this property.' }) }).end();
      }
      return;
    case 'healthy':
    case 'late':
      if (sanitize) {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({
          ok: true, transformation: 'overlay_repair', model: null, width: 4, height: 3 }) }).end(Buffer.from(PNG));
      } else {
        res.writeHead(200, { [WORK_OUTCOME_HEADER]: encodeWorkDocument({
          status: 'recovered_photograph', photograph: { reference: 'facade.png', contentType: 'image/png' } }) })
          .end(Buffer.from(PNG));
      }
  }
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits += 1;
    req.resume();
    req.on('end', () => {
      if (mode === 'reset') { req.socket.destroy(); return; }
      if (mode === 'hang') { held.push(res); return; }
      if (mode === 'late') { setTimeout(() => answer(req.url ?? '', res), 400); return; }
      answer(req.url ?? '', res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.BUILDER_STOCK_PDF_WORKER_URL = `http://127.0.0.1:${port}`;
  process.env.BUILDER_STOCK_PDF_WORKER_TOKEN = 'fault-test-token';
  // `meteredFetch` reads its own credentials through `Deno.env`; with none set
  // it records nothing, which is exactly what a test wants.
  (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => process.env[name] } };
  // The client's own timeout, shortened: the branch is the same, the wait is not.
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(150));
});

afterAll(async () => {
  for (const res of held) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  delete process.env.BUILDER_STOCK_PDF_WORKER_URL;
  delete process.env.BUILDER_STOCK_PDF_WORKER_TOKEN;
});

beforeEach(() => { hits = 0; });

const loadClient = () => import('../../../supabase/functions/_shared/builderStock/heavyWorkClient');
const loadElection = () => import('../../../supabase/functions/_shared/builderStock/pdfElectionClient');

const folderContext = {
  url: 'https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&dl=0', label: 'Lot 1 Example Street', lot: '1',
  word: 'lot', design: null, fieldDesign: null, identityHints: [], confirmedLots: null, buildingSqm: null,
} as const;
const electionContext = {
  label: 'Lot 1 Example Street', identifiedBy: 'direct_link' as const, documentName: 'brochure.pdf',
  url: 'https://example.com/brochure.pdf',
};
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe('the overlay repair: a failing worker is operational, never a refusal', () => {
  it.each(FAULTS)('%s → operational, nothing said about the picture', async (fault) => {
    mode = fault;
    const { sanitizeWithCapacity } = await loadClient();
    const result = await sanitizeWithCapacity(PNG, { allowGenerative: false });
    expect(hits).toBeGreaterThan(0); // the worker really was asked
    expect(result.ok).toBe(false);
    expect((result as { operational?: boolean }).operational).toBe(true);
    expect((result as { bytes?: unknown }).bytes).toBeUndefined();
    expect((result as { clearance?: unknown }).clearance).toBeUndefined();
  });

  it('control: the worker\'s own gate refusal is a CONTENT answer, not operational', async () => {
    mode = 'content';
    const { sanitizeWithCapacity } = await loadClient();
    const result = await sanitizeWithCapacity(PNG, { allowGenerative: false });
    expect(result.ok).toBe(false);
    expect((result as { operational?: boolean }).operational).not.toBe(true);
    expect((result as { reason?: string }).reason).toBe('background_too_detailed');
  });

  it('control: a healthy worker returns the repaired picture', async () => {
    mode = 'healthy';
    const { sanitizeWithCapacity } = await loadClient();
    const result = await sanitizeWithCapacity(PNG, { allowGenerative: false });
    expect(result.ok).toBe(true);
    expect(Array.from((result as { bytes: Uint8Array }).bytes)).toEqual(Array.from(PNG));
  });
});

describe('the Dropbox folder read: a failing worker is unreachable, never "no photograph here"', () => {
  it.each(FAULTS)('%s → unreachable', async (fault) => {
    mode = fault;
    const { recoverDropboxFolderOnWorker, heavyWorkRoute } = await loadClient();
    const outcome = await recoverDropboxFolderOnWorker(folderContext as never, heavyWorkRoute()!);
    expect(hits).toBeGreaterThan(0);
    expect(outcome.status).toBe('unreachable');
    // Marked as OURS, so a retirement it causes is re-asked by a newer runtime.
    expect((outcome as { cause?: string }).cause).toBe('worker');
  });

  it('control: the folder\'s own "not identified" is the content answer it is', async () => {
    mode = 'content';
    const { recoverDropboxFolderOnWorker, heavyWorkRoute } = await loadClient();
    const outcome = await recoverDropboxFolderOnWorker(folderContext as never, heavyWorkRoute()!);
    expect(outcome.status).toBe('not_identified');
    expect((outcome as { cause?: string }).cause).toBeUndefined();
  });

  it('control: a healthy folder read returns the photograph', async () => {
    mode = 'healthy';
    const { recoverDropboxFolderOnWorker, heavyWorkRoute } = await loadClient();
    const outcome = await recoverDropboxFolderOnWorker(folderContext as never, heavyWorkRoute()!);
    expect(outcome.status).toBe('recovered_photograph');
  });
});

describe('the PDF cover election: a failing worker is unreachable, never a verdict on the document', () => {
  it.each(FAULTS)('%s → unreachable', async (fault) => {
    mode = fault;
    const { runElectionOnRoute } = await loadElection();
    const outcome = await runElectionOnRoute(PDF, async () => ({ ok: true, pages: [] }), electionContext,
      { kind: 'worker', endpoint: process.env.BUILDER_STOCK_PDF_WORKER_URL!, token: 'fault-test-token' });
    expect(hits).toBeGreaterThan(0);
    expect(outcome.status).toBe('unreachable');
    expect((outcome as { cause?: string }).cause).toBe('worker');
  });
});
