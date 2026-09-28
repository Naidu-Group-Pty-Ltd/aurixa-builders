import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module shared with the ops script
import { planResidueSweep } from '../../../scripts/ops/proofResidue.pure.mjs';

/**
 * The residue sweep removes a disowned file only when its path is one a proof
 * writes (`scripts/ops/proofResidue.pure.mjs`). Measured 28 Sep 2026: 112
 * files under organisations that no longer exist, every one a proof's. A real
 * builder whose organisation an operator deleted leaves files that pass the
 * database's tests too, and those must be kept.
 */
const ORG = '0f0f0f0f-1111-4222-8333-444444444444';
const ITEM = '1a1a1a1a-5555-4666-8777-888888888888';
const UPLOAD = '2b2b2b2b-9999-4aaa-8bbb-cccccccccccc';
const COPY = '3c3c3c3c-dddd-4eee-8fff-000000000000';
const LIST = 'builder-stock-lists';
const IMAGE = 'builder-stock-images';

const plan = (files: { bucket: string; name: string }[]) => planResidueSweep(files);
const kinds = (files: { bucket: string; name: string }[]) =>
  plan(files).remove.map((f: { kind: string }) => f.kind);

describe('what the sweep recognises as a proof\'s', () => {
  it('the copy of a smoke stock list', () => {
    expect(kinds([
      { bucket: LIST, name: `stock-lists/${ORG}/${UPLOAD}/smoke-stock.csv` },
      { bucket: LIST, name: `stock-lists/${ORG}/${UPLOAD}/smoke-stock-brochure.csv` },
    ])).toEqual(['smoke stock list', 'smoke stock list']);
  });

  it('a proof facade added through "Add picture"', () => {
    expect(kinds([
      { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/facade.png` },
      { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/facade.jpg` },
    ])).toEqual(['proof facade', 'proof facade']);
  });

  it('the product\'s sanitised copy, only beside a proof facade in the same folder', () => {
    const copy = { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/sanitized/v2/${COPY}.png` };
    expect(kinds([copy, { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/facade.jpg` }]))
      .toContain('sanitised copy of a proof facade');
    const alone = plan([copy]);
    expect(alone.remove).toEqual([]);
    expect(alone.keep).toHaveLength(1);
    const elsewhere = plan([copy, { bucket: IMAGE, name: `builder-supplied/${ORG}/${UPLOAD}/facade.jpg` }]);
    expect(elsewhere.keep.map((f: { name: string }) => f.name)).toEqual([copy.name]);
  });

  it('a picture read out of the smoke brochure', () => {
    expect(kinds([{ bucket: IMAGE,
      name: `${ORG}/${UPLOAD}/${ITEM}/lot-717-enzo-brochure.pdf-page1-FormXob.9f3a1c.jpg` }]))
      .toEqual(['picture read out of the smoke brochure']);
  });
});

describe('what the sweep keeps', () => {
  it('a real builder\'s own pictures and lists, however disowned', () => {
    const real = [
      { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/front-elevation.jpg` },
      { bucket: IMAGE, name: `${ORG}/${UPLOAD}/${ITEM}/photo-1.jpg` },
      { bucket: LIST, name: `stock-lists/${ORG}/${UPLOAD}/September stock.xlsx` },
      { bucket: IMAGE, name: `org/${ORG}/${ITEM}/facade.jpg` },
    ];
    const result = plan(real);
    expect(result.remove).toEqual([]);
    expect(result.keep).toHaveLength(real.length);
  });

  it('a proof\'s name in the wrong bucket, or a path that climbs', () => {
    const result = plan([
      { bucket: IMAGE, name: `stock-lists/${ORG}/${UPLOAD}/smoke-stock.csv` },
      { bucket: LIST, name: `builder-supplied/${ORG}/${ITEM}/facade.png` },
      { bucket: IMAGE, name: `builder-supplied/${ORG}/../${ITEM}/facade.png` },
      { bucket: IMAGE, name: `/builder-supplied/${ORG}/${ITEM}/facade.png` },
    ]);
    expect(result.remove).toEqual([]);
    expect(result.keep).toHaveLength(4);
  });

  it('names every file exactly once, and counts what it removes by kind', () => {
    const files = [
      { bucket: LIST, name: `stock-lists/${ORG}/${UPLOAD}/smoke-stock.csv` },
      { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/facade.png` },
      { bucket: IMAGE, name: `builder-supplied/${ORG}/${ITEM}/front-elevation.jpg` },
    ];
    const result = plan(files);
    expect(result.remove.length + result.keep.length).toBe(files.length);
    expect(result.byKind).toEqual({ 'smoke stock list': 1, 'proof facade': 1 });
  });
});
