/**
 * BUILDER STOCK — THE HEAVY ELECTION, WHERE THERE IS CPU FOR IT.
 *
 * WHY THIS OBJECT EXISTS AT ALL. Per-execution Supabase telemetry, 8 September
 * 2026: a thirteen-property cold start killed the settler thirteen times and
 * every kill was `reason: CPUTime` — successful executions ending at 1,828 ms
 * of CPU or less, killed ones at 2,031 ms or more, against a 2,000 ms limit —
 * while memory peaked at 108 MB of 256. Reading one heavy brochure and
 * electing its image is indivisible and costs about 2.4 s. It does not fit,
 * and no scheduling rule makes it fit. So the work MOVED. This is where it
 * moved to, and it is the whole of the change: nothing about which image wins
 * is decided here.
 *
 * THERE IS ONE ELECTION, AND IT IS NOT IN THIS FILE. `electFromPdfBytes` and
 * `readPdfPageTextResult` are imported from `supabase/functions/_shared`, the
 * same modules the Supabase path runs, bundled into this Worker rather than
 * re-expressed in it. How PDF text is read, which image is elected, what
 * counts as evidence, how roles are assigned and what provenance means are
 * defined once, over there. A second implementation would drift, and the
 * drift would be invisible: two deployments would attach different pictures
 * to the same house and both would look right.
 *
 * WHAT THIS FILE IS THEREFORE ALLOWED TO CONTAIN: a queue, a size check, and
 * the translation of an outcome into the wire shape. That is all it contains.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  ELECTION_CONTEXT_HEADER, MAX_DOCUMENT_BYTES, PDF_ELECTION_PROTOCOL,
  bytesToBase64, decodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';
import { electFromPdfBytes } from '../../../supabase/functions/_shared/builderStock/pdfElection.ts';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText.ts';

/**
 * ONE LANE FOR THE WHOLE DEPLOYMENT.
 *
 * Every request is routed to the object with this name, so every election in
 * the fleet queues behind the one before it. That is deliberate and it is the
 * memory bound: a second lane would double the resident documents without
 * doubling the 128 MB an isolate gets.
 */
export const ELECTION_LANE = 'builder-stock-pdf-election';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

export class PdfElection extends DurableObject {
  /*
   * ONE DOCUMENT AT A TIME, AND THE OBJECT'S OWN THREADING IS NOT ENOUGH.
   *
   * A Durable Object runs one JavaScript callback at a time, but it still
   * INTERLEAVES at every `await` — so two elections entering together would
   * both be resident, each holding a multi-megabyte document and its decoded
   * pages, in one 128 MB isolate. Memory is the ceiling that does not move
   * with the plan, and the measurement that shaped this whole change found
   * five concurrent reads peaking at 429 MB.
   *
   * This is the same promise-chain lane `withPdfDecodeSlot` uses on the
   * Supabase side: each request waits for the one before it to finish, so the
   * object's memory holds one election's worth of work at a time. It is kept
   * here rather than in the shared election because the shared election
   * already has its own slot and taking a slot twice in one stack is a
   * deadlock rather than a bound.
   */
  #lane: Promise<unknown> = Promise.resolve();

  queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lane.then(work, work);
    this.#lane = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }

  override async fetch(request: Request): Promise<Response> {
    /*
     * NEVER GUESSED. An election run against the wrong property's label puts
     * another house on a client's card. `decodeElectionContext` refuses
     * anything it cannot vouch for, and a refusal is a 400 the client reports
     * as operational — not an election over a default.
     */
    const context = decodeElectionContext(request.headers.get(ELECTION_CONTEXT_HEADER));
    if (!context) return json({ error: 'bad_context' }, 400);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
      return json({ error: 'bad_document', bytes: bytes.length }, 413);
    }

    return await this.queue(async () => {
      const outcome = await electFromPdfBytes(bytes, readPdfPageTextResult, {
        label: context.label,
        identifiedBy: context.identifiedBy,
        design: context.design,
        identityHints: context.identityHints,
        documentName: context.documentName,
        url: context.url,
      });
      if (outcome.status === 'recovered') {
        return json({
          protocol: PDF_ELECTION_PROTOCOL,
          status: 'recovered',
          image: {
            bytes: bytesToBase64(outcome.image.bytes),
            contentType: outcome.image.contentType,
            reference: outcome.image.reference,
            provenance: outcome.image.provenance,
            role: outcome.image.role,
          },
        });
      }
      /*
       * `not_identified` reaches the client ONLY from here, and only because
       * the shared election read the real bytes and said so. The client is
       * written so that it cannot construct that value itself; this is the
       * one place it is ever earned.
       */
      return json({
        protocol: PDF_ELECTION_PROTOCOL,
        status: outcome.status,
        detail: 'detail' in outcome ? outcome.detail : undefined,
      });
    });
  }
}
