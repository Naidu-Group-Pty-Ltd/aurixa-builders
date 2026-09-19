/**
 * WHICH LANE AN ELECTION QUEUES IN — pinned.
 *
 * Every `/v1/elect` request used to be routed to one Durable Object named by a
 * constant, so every heavy brochure in the fleet queued behind the one before
 * it. A six-wide import did not go six-wide; it went one-wide at the worker.
 *
 * THE QUEUE IS NOT WHAT WENT. Each object is still strictly serial — one
 * document resident at a time — because the reason for that is memory and
 * memory did not change. What changed is that there are four objects instead
 * of one, so the fleet is divided rather than funnelled.
 *
 * WHAT THIS FILE HOLDS. That the key is derived from what the wire ALREADY
 * carries, that it is deterministic, that it is bounded, that it actually
 * spreads, and that the two things the old single lane was relied upon for —
 * a serial queue per object, and authentication before anything else — are
 * both still true.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ELECTION_LANE_COUNT, ELECTION_LANE_PREFIX, electionLaneName, electionShardKey,
  laneForShardKey,
} from '../../../workers/builder-stock-pdf-worker/src/electionLane.pure';
import {
  decodeElectionContext, encodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';

const WORKER = 'workers/builder-stock-pdf-worker/src';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const laneOf = (context: { label: string; url: string }) =>
  laneForShardKey(electionShardKey(context));

describe('the sharding key comes from what the wire already carries', () => {
  /**
   * THE BOUNDARY CONTRACT IS UNCHANGED, which is the point. Nothing was added
   * to `WireElectionContext` for sharding — no organisation id, no property
   * id, no upload id, no row id — so the worker still cannot say which
   * property row it is looking at.
   */
  it('reads only fields that already cross, through the boundary’s own decoder', () => {
    const context = {
      label: 'Lot 717 — Enzo 10.5 Modern',
      identifiedBy: 'folder_structure' as const,
      design: 'Enzo 10.5',
      identityHints: ['Watsons Reach'],
      documentName: 'LOT 717 - BROCHURE V002.pdf',
      url: 'https://drive.google.com/uc?export=download&id=abc',
    };
    const decoded = decodeElectionContext(encodeElectionContext(context));
    expect(decoded).not.toBeNull();
    expect(electionShardKey(decoded)).toBe(`${context.label}\n${context.url}`);
  });

  it('adds no tenant identifier to the wire', () => {
    const source = read(`${WORKER}/electionLane.pure.ts`);
    for (const forbidden of [
      'organisation_id', 'organisationId', 'upload_id', 'uploadId',
      'property_id', 'propertyId', 'stock_item_id', 'stockItemId', 'tenant',
    ]) {
      expect(
        source.includes(forbidden),
        `${forbidden} reached the lane chooser — sharding must not widen the boundary`,
      ).toBe(false);
    }
  });
});

describe('the lane a key resolves to', () => {
  const identity = (n: number) => ({
    label: `Lot ${700 + n} — Enzo 10.5 Modern`,
    url: `https://drive.google.com/uc?export=download&id=file-${n}`,
  });

  it('is the same every time for the same key', () => {
    for (let n = 0; n < 50; n += 1) {
      const first = laneOf(identity(n));
      for (let again = 0; again < 5; again += 1) {
        expect(laneOf(identity(n))).toBe(first);
      }
    }
  });

  it('survives the round trip through the wire unchanged', () => {
    const context = {
      label: 'Lot 6706 — Aspect 28',
      identifiedBy: 'direct_link' as const,
      documentName: 'the linked document',
      url: 'https://drive.google.com/uc?export=download&id=1rE8rvWHNN1KDtJvO',
    };
    const decoded = decodeElectionContext(encodeElectionContext(context));
    expect(laneForShardKey(electionShardKey(decoded))).toBe(laneOf(context));
  });

  it.each([
    ['an ordinary identity', identity(1)],
    ['an empty label', { label: '', url: 'https://example.com/a.pdf' }],
    ['an empty url', { label: 'Lot 9', url: '' }],
    ['both empty', { label: '', url: '' }],
    ['an em-dash and accents', { label: 'Lot 5 — Café Réal', url: 'https://x/é.pdf' }],
    ['a very long label', { label: 'L'.repeat(4000), url: 'https://x/b.pdf' }],
  ])('is always an integer in 0..%s', (_name, context) => {
    const lane = laneOf(context as { label: string; url: string });
    expect(Number.isInteger(lane)).toBe(true);
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lane).toBeLessThan(ELECTION_LANE_COUNT);
  });

  it('is 0 when the request carries no readable context', () => {
    expect(laneForShardKey(electionShardKey(null))).toBe(0);
    expect(laneForShardKey(electionShardKey(undefined))).toBe(0);
    expect(laneForShardKey(electionShardKey(decodeElectionContext('not-base64!!')))).toBe(0);
    expect(laneForShardKey(null)).toBe(0);
    expect(laneForShardKey('')).toBe(0);
  });
});

describe('the spread, which is the whole reason for the change', () => {
  it('puts a representative set of documents across more than one lane', () => {
    const lanes = new Set<number>();
    for (let n = 0; n < 40; n += 1) {
      lanes.add(laneOf({
        label: `Lot ${700 + n} — Enzo 10.5 Modern`,
        url: `https://drive.google.com/uc?export=download&id=file-${n}`,
      }));
    }
    expect(lanes.size).toBeGreaterThan(1);
    // Not merely "more than one": a real import must reach every lane, or the
    // fleet is narrower than it was configured to be.
    expect(lanes.size).toBe(ELECTION_LANE_COUNT);
  });

  /**
   * THE CASE `url` ALONE WOULD HAVE COLLAPSED. The live list has one folder
   * shared by forty-four rows, and `documentNameFromUrl` answers `'the linked
   * document'` for anything it cannot read a filename out of — so a key built
   * from the document alone would put forty-four different properties in one
   * lane. The label is in the key precisely for this.
   */
  it('spreads many properties that share one document', () => {
    const shared = 'https://drive.google.com/uc?export=download&id=one-shared-folder-file';
    const lanes = new Set<number>();
    for (let n = 0; n < 44; n += 1) {
      lanes.add(laneOf({ label: `Lot ${1000 + n} Wollert Rise`, url: shared }));
    }
    expect(lanes.size).toBeGreaterThan(1);
  });

  it('keeps one property reading one document in one lane', () => {
    const one = { label: 'Lot 717 — Enzo', url: 'https://drive.google.com/uc?id=x' };
    expect(new Set([laneOf(one), laneOf({ ...one })]).size).toBe(1);
  });
});

describe('the lane name', () => {
  it('carries the number and nothing else', () => {
    for (let lane = 0; lane < ELECTION_LANE_COUNT; lane += 1) {
      expect(electionLaneName(lane)).toBe(`${ELECTION_LANE_PREFIX}-${lane}`);
    }
  });

  /**
   * A name built from the key would put a customer's property label into
   * Cloudflare's object namespace — the boundary rule broken as
   * infrastructure metadata rather than as a payload.
   */
  it('never contains the key it was chosen by', () => {
    const context = { label: 'Lot 717 — Enzo 10.5 Modern', url: 'https://drive.google.com/uc?id=abc' };
    const name = electionLaneName(laneOf(context));
    expect(name).not.toContain(context.label);
    expect(name).not.toContain(context.url);
    expect(name).not.toContain('drive.google.com');
    expect(name).toMatch(new RegExp(`^${ELECTION_LANE_PREFIX}-\\d$`));
  });

  it('is bounded whatever number it is handed', () => {
    for (const lane of [-1, -97, 4, 5, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(electionLaneName(lane)).toMatch(
        new RegExp(`^${ELECTION_LANE_PREFIX}-[0-${ELECTION_LANE_COUNT - 1}]$`));
    }
  });
});

describe('what sharding did not change', () => {
  /**
   * EACH OBJECT IS STILL SERIAL. Sharding divides the fleet across objects; it
   * does not make any one of them concurrent. A Durable Object runs one
   * callback at a time but INTERLEAVES at every `await`, so without this chain
   * two elections entering one object would both be resident — which is the
   * 429 MB measurement that shaped the original lane.
   */
  it('keeps the per-object promise queue', () => {
    const source = read(`${WORKER}/pdfElection.do.ts`);
    expect(source).toContain('#lane: Promise<unknown> = Promise.resolve()');
    expect(source).toMatch(/queue<T>\(work: \(\) => Promise<T>\): Promise<T>/);
    expect(source).toContain('const run = this.#lane.then(work, work);');
    expect(source).toContain('this.#lane = run.then(');
    expect(source).toContain('return await this.queue(');
  });

  /**
   * THE FRONT DOOR STILL DOES NOT TOUCH THE BODY. The document is the raw
   * request body — up to `MAX_DOCUMENT_BYTES`, 32 MB — and reading, parsing or
   * cloning it to pick a queue would duplicate it in the isolate with the
   * least room for it. The behavioural proof is in
   * `builderStockPdfWorker.spec.ts` ("hands the document to the lane unread");
   * this refuses the call in source, so it cannot come back by a route that
   * still happens to pass that test.
   */
  it('reads no body in the front door', () => {
    const source = read(`${WORKER}/index.ts`);
    const handler = source.slice(source.indexOf('async fetch(request: Request'));
    for (const consumer of [
      'request.text(', 'request.json(', 'request.arrayBuffer(', 'request.blob(',
      'request.formData(', 'request.clone(', 'request.bytes(',
    ]) {
      expect(
        handler.includes(consumer),
        `the front door calls ${consumer}) — the lane is chosen from a header, `
        + 'and the body is a multi-megabyte document that must pass through untouched',
      ).toBe(false);
    }
  });

  /**
   * AUTHENTICATION BEFORE ROUTING. Asserted on source ORDER as well as on
   * behaviour, because "it returns 401" is also true of a front door that
   * picked a lane first and threw the answer away.
   */
  it('authenticates before it chooses a lane', () => {
    const source = read(`${WORKER}/index.ts`);
    const unauthorised = source.indexOf("error: 'unauthorised'");
    const chooses = source.indexOf('laneForShardKey(');
    const routes = source.indexOf('PDF_ELECTION.get(');
    expect(unauthorised).toBeGreaterThan(0);
    expect(chooses).toBeGreaterThan(unauthorised);
    expect(routes).toBeGreaterThan(unauthorised);
  });

  it('asks for exactly one lane per request', () => {
    const source = read(`${WORKER}/index.ts`);
    expect((source.match(/PDF_ELECTION\.get\(/g) ?? [])).toHaveLength(1);
    expect((source.match(/idFromName\(/g) ?? [])).toHaveLength(1);
  });
});
