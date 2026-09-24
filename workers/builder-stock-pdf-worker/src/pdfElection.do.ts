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
  ELECTION_CONTEXT_HEADER, MAX_DOCUMENT_BYTES,
  bytesToBase64, decodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';
import { electFromPdfBytes } from '../../../supabase/functions/_shared/builderStock/pdfElection.ts';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText.ts';

/*
 * WHERE THE LANE NAME LIVES NOW.
 *
 * It used to be a constant here — `ELECTION_LANE`, one object for the whole
 * deployment, so every election in the fleet queued behind the one before it.
 * The fleet has `ELECTION_LANE_COUNT` lanes now and the naming moved to
 * `electionLane.pure.ts`, which the front door imports to choose one.
 *
 * WHAT DID NOT CHANGE IS THE QUEUE BELOW. Sharding divides the fleet across
 * objects; it does not make any single object concurrent. Each one is still
 * strictly serial, one document resident at a time, for the reason the
 * promise chain states.
 *
 * THE MEMORY CLAIM THAT USED TO BE HERE IS NOT RESTATED, BECAUSE IT IS NOT
 * SETTLED. The old comment asserted that "a second lane would double the
 * resident documents without doubling the 128 MB an isolate gets" — i.e. that
 * lanes share one isolate's memory. Cloudflare documents 128 MB per isolate
 * AND colocates Durable Objects, and does not say plainly which applies to
 * two objects of one class under load. That is the same ambiguity
 * `wrangler.toml` already records for the CPU limit, and it answered it the
 * same way: by measurement rather than by reading. Until a canary has run
 * concurrent elections against separate lanes and been believed, the honest
 * statement is that the per-lane serial queue is the bound this file
 * guarantees, and the cross-lane bound is unproven.
 */

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
        confirmedLots: context.confirmedLots,
        documentName: context.documentName,
        url: context.url,
      });
      /*
       * IN THE PROTOCOL IT WAS ASKED IN, never simply the newest this worker
       * speaks. A settler built before protocol 3 asks under 2 and believes
       * only an answer in 2 — so answering in 3 would turn every election in
       * the deploy gap into a retry. See `electionProtocolFor`.
       */
      const protocol = context.protocol;
      if (outcome.status === 'recovered') {
        return json({
          protocol,
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
       *
       * `reason` is earned the same way and travels for the same reason. The
       * shared election attaches it only where it read the document to the
       * end and the refusal is a deterministic property of the bytes; the
       * client relays it only when it recognises the value. So a refusal
       * whose budget is shorter than the generic one can be produced by
       * nothing except an actual reading of an actual document — which is
       * what makes it safe for the budget to trust.
       */
      return json({
        protocol,
        status: outcome.status,
        reason: 'reason' in outcome ? outcome.reason : undefined,
        /*
         * `finding` travels on the same terms and for the opposite purpose:
         * `reason` shortens a retry budget, this shortens nothing and is
         * read by no decision anywhere. It says which KIND of finding an
         * inspection reached, so the builder's own screen can tell "this
         * brochure is for another property" from "this brochure carries no
         * photograph" without matching substrings of a sentence.
         */
        finding: 'finding' in outcome ? outcome.finding : undefined,
        findingEvidence: 'findingEvidence' in outcome ? outcome.findingEvidence : undefined,
        detail: 'detail' in outcome ? outcome.detail : undefined,
      });
    });
  }
}
