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
import { sanitizeSourceImage } from '../../../supabase/functions/_shared/builderStock/sanitizeImage.ts';
import { recoverFromDropboxFolder } from '../../../supabase/functions/_shared/builderStock/packageImages.ts';
import {
  isDropboxFolderLink, sharedLinkFileUrl,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure.ts';
import {
  FOLDER_PATH, HEAVY_WORK_TIMEOUT_MS, HERO_PATH, MAX_SANITIZE_BYTES, SANITIZE_PATH,
  WORK_CONTEXT_HEADER, WORK_OUTCOME_HEADER, decodeWorkDocument, encodeWorkDocument,
  isDropboxFetchHost, readFolderWorkContext, readHeroWorkContext, readSanitizeWorkContext,
} from '../../../supabase/functions/_shared/builderStock/heavyWorkWire.pure.ts';
import { planHeroFromBytes } from '../../../supabase/functions/_shared/builderStock/heroPlanning.ts';
import { readBrochureFigureEvidence } from '../../../supabase/functions/_shared/builderStock/brochureFigures.ts';

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
    const path = new URL(request.url).pathname;
    if (path === SANITIZE_PATH) return await this.sanitize(request);
    if (path === FOLDER_PATH) return await this.folder(request);
    if (path === HERO_PATH) return await this.hero(request);
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

    /*
     * A FIGURES READING, in the same lane and under the same one-at-a-time
     * queue as an election, because it parses the same document. It answers
     * with the product's reading of the text and the pictures worth
     * recognising, and decodes none of them. See `brochureFigures.ts`.
     */
    if (context.purpose === 'figures') {
      return await this.queue(async () => {
        const read = await readBrochureFigureEvidence(bytes, { design: context.design });
        return read.ok
          ? json({ protocol: context.protocol, status: 'figures', evidence: read.evidence })
          : json({ protocol: context.protocol, status: 'unreadable', reason: read.reason });
      });
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

  /*
   * THE OVERLAY REPAIR, deterministic route only. No model key lives here and
   * none is wanted: where the arithmetic's own gates refuse, the edge asks the
   * model itself, exactly as before. The answer is the shared repair's, as it
   * stands — this method only moves it onto the wire.
   */
  async sanitize(request: Request): Promise<Response> {
    const context = readSanitizeWorkContext(
      decodeWorkDocument(request.headers.get(WORK_CONTEXT_HEADER)));
    if (!context) return json({ error: 'bad_context' }, 400);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SANITIZE_BYTES) {
      return json({ error: 'bad_picture', bytes: bytes.length }, 413);
    }
    return await this.queue(async () => {
      const result = await sanitizeSourceImage(bytes, {
        allowGenerative: false,
        ...(context.repairRegion ? { repairRegion: context.repairRegion } : {}),
      });
      const meta: Record<string, unknown> = { ...result };
      let body: Uint8Array | null = null;
      if (result.ok) {
        delete meta.bytes;
        body = result.bytes;
      } else if (result.rejected) {
        meta.rejected = { width: result.rejected.width, height: result.rejected.height };
        body = result.rejected.bytes;
      }
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          [WORK_OUTCOME_HEADER]: encodeWorkDocument(meta),
        },
      });
    });
  }

  /*
   * A DROPBOX SHARED FOLDER, read by the shared `recoverFromDropboxFolder`.
   *
   * Three things are this file's and nothing else is. The stream: an HTTPS
   * fetch that follows redirects by hand and refuses any hop off Dropbox's own
   * hosts. The fetcher: refused outright, because the only document this
   * reading may open is one it found inside the zip. And the page reader: the
   * shared one, wrapped, so an election found here runs in this object rather
   * than calling back out to the worker it is already in.
   */
  /*
   * THE HERO PLAN — presentation only. The served picture in, its framing plan
   * out (`heroPlanning.ts`), queued like every heavy job so a decode never
   * runs beside a brochure. Nothing is stored here and nothing is fetched:
   * the caller sends the bytes and keeps the answer.
   */
  async hero(request: Request): Promise<Response> {
    const context = readHeroWorkContext(decodeWorkDocument(request.headers.get(WORK_CONTEXT_HEADER)));
    if (!context) return json({ error: 'bad_context' }, 400);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SANITIZE_BYTES) {
      return json({ error: 'bad_picture', bytes: bytes.length }, 413);
    }
    return await this.queue(async () => {
      const result = await planHeroFromBytes(bytes, { proof: context.proof === true });
      const meta: Record<string, unknown> = result.ok
        ? { ok: true, plan: result.plan, tile: result.tile ? { width: result.tile.width, height: result.tile.height } : null }
        : { ...result };
      const body = result.ok && result.tile ? result.tile.pixels : null;
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', [WORK_OUTCOME_HEADER]: encodeWorkDocument(meta) },
      });
    });
  }

  async folder(request: Request): Promise<Response> {
    const context = readFolderWorkContext(
      decodeWorkDocument(request.headers.get(WORK_CONTEXT_HEADER)));
    if (!context || !isDropboxFolderLink(context.url)) return json({ error: 'bad_context' }, 400);
    return await this.queue(async () => {
      const outcome = await recoverFromDropboxFolder(context, {
        stream: (url: string) => dropboxStream(url),
        fetchPackage: async () => {
          throw new Error('this reading opens only what the folder holds');
        },
        readPageTexts: (bytes: Uint8Array) => readPdfPageTextResult(bytes),
      });
      const meta: Record<string, unknown> = { ...outcome };
      let body: Uint8Array | null = null;
      if (outcome.status === 'recovered') {
        const { bytes, ...rest } = outcome.image;
        meta.image = rest;
        body = bytes;
      } else if (outcome.status === 'recovered_photograph') {
        const { bytes, ...rest } = outcome.photograph;
        meta.photograph = rest;
        body = bytes;
      }
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          [WORK_OUTCOME_HEADER]: encodeWorkDocument(meta),
        },
      });
    });
  }
}

/** The folder's zip, as it arrives, from Dropbox's own hosts and nowhere else. */
async function* dropboxStream(startUrl: string): AsyncGenerator<Uint8Array> {
  let current = sharedLinkFileUrl(startUrl);
  let response: Response | null = null;
  const signal = AbortSignal.timeout(HEAVY_WORK_TIMEOUT_MS);
  for (let hop = 0; hop <= 5; hop++) {
    if (!isDropboxFetchHost(current)) throw new Error('that link leaves Dropbox');
    response = await fetch(current, {
      redirect: 'manual', signal,
      headers: { 'User-Agent': 'NPC-BuilderStock/1.0', Accept: '*/*' },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      try { await response.body?.cancel(); } catch { /* nothing held */ }
      current = new URL(location, current).toString();
      response = null;
      continue;
    }
    break;
  }
  if (!response) throw new Error('that link redirected too many times');
  if (!response.ok || !response.body) throw new Error(`that folder answered HTTP ${response.status}`);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
}
