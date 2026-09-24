/**
 * THE FIGURES A PAGE PRINTS AS PICTURES ARE READ ONCE PER HAND-OFF, BY AN
 * ISOLATE THAT NEVER PARSED THE DOCUMENT — and what they came to is recorded
 * whatever it was, so it is asked once and applied by whoever finishes.
 *
 * See `pdfFigures.pure.ts` for which figures, `readFigures.ts` for the read,
 * and the successor branch of `runImport.ts` for where it runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  figureVerdictOf, freshAttempt, openCheckpoint, readCheckpoint, withFigureVerdict,
  withPictureCrossing, withPictureHandover,
} from '../../../supabase/functions/_shared/builderStock/importCheckpoint.pure.ts';
import {
  EXPENSIVE_SPEND_CEILING_MS, FIGURE_ENGINE_MS, FIGURE_READ_MS, mayReadFigures,
} from '../../../supabase/functions/_shared/builderStock/importResumeBudget.pure.ts';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const SHA = 'e'.repeat(64);
const READ = { state: 'read' as const, buildingSizeSqm: '124.50', provedBy: ['squares' as const], page: 1 };

describe('the verdict rides in the checkpoint', () => {
  it('is recorded against the hand-off and comes back exactly as written', () => {
    const checkpoint = withFigureVerdict(withPictureHandover(openCheckpoint(SHA), 't'), READ);
    const stored = JSON.parse(JSON.stringify(checkpoint));
    expect(figureVerdictOf(readCheckpoint(stored, SHA))).toEqual(READ);
  });

  it('survives the crossings after it', () => {
    let checkpoint = withFigureVerdict(withPictureHandover(openCheckpoint(SHA), 't'), READ);
    checkpoint = withPictureCrossing(withPictureCrossing(checkpoint));
    expect(figureVerdictOf(checkpoint)).toEqual(READ);
  });

  it('is recorded only against a hand-off, because only a hand-off has figures', () => {
    const plain = openCheckpoint(SHA);
    expect(withFigureVerdict(plain, READ)).toBe(plain);
    expect(figureVerdictOf(plain)).toBeNull();
  });

  it('is dropped by a fresh attempt, with the hand-off it belonged to', () => {
    const checkpoint = withFigureVerdict(withPictureHandover(openCheckpoint(SHA), 't'), READ);
    expect(figureVerdictOf(freshAttempt(checkpoint))).toBeNull();
  });

  it('is not trusted in any other shape', () => {
    const stored = JSON.parse(JSON.stringify(withPictureHandover(openCheckpoint(SHA), 't')));
    stored.pictures.figures = { state: 'read', buildingSizeSqm: 'about 125', provedBy: ['squares'], page: 1 };
    const restored = readCheckpoint(stored, SHA);
    expect(restored?.pictures?.handover).toBe('t');
    expect(figureVerdictOf(restored)).toBeNull();
  });
});

describe('the ceiling a linked source reads its figures inside', () => {
  it('fits a first figure, engine and all, inside the ceiling, or reads none', () => {
    expect(mayReadFigures(null, 1)).toBe(true);
    expect(mayReadFigures({}, 0)).toBe(false);
    expect(mayReadFigures({ property_reader_ms: 1_000 }, 1)).toBe(true);
    // 1,900 spent + 700 engine + 500 figure is 3,100: past the ceiling.
    expect(mayReadFigures({ property_reader_ms: 1_900 }, 1)).toBe(false);
    expect(FIGURE_ENGINE_MS + FIGURE_READ_MS).toBeLessThan(EXPENSIVE_SPEND_CEILING_MS);
  });
});

describe('where the figures are read', () => {
  const run = read('supabase/functions/_shared/builderStock/runImport.ts');
  const successor = run.slice(run.indexOf('const handoverToken = input.resumed'), run.indexOf('let extraction;'));
  const parse = run.slice(run.indexOf('let extraction;'));

  it('in the successor for a stored document, which never parsed it', () => {
    expect(successor).toContain('const read = await readFigures(bytes, figures, outlines).catch(() => ({');
    // The parse path decides WHICH figures, and which blocks beside them.
    expect(parse).toContain('const figures = figuresToRead({');
    expect(parse).toContain('outlines: outlinesWithinRecognitionBudget(figures.length, outlinesToRead({');
  });

  it('in the reading isolate ONLY for a linked source, and only inside its ceiling', () => {
    // A linked source is re-fetched, no successor can reproduce it, and its
    // pictures have always been decoded inline; a stored one never is.
    const reads = parse.split('readFigures(').length - 1;
    expect(reads).toBe(1);
    const inline = parse.slice(parse.indexOf('let finishing = decided;'));
    expect(inline).toContain('const figuresHere = decided.figures.length + decided.outlines.length;');
    expect(inline).toContain(`if (!input.resumableFromStoredBytes && figuresHere
    && mayReadFigures(ledger, figuresHere)) {`);
    expect(inline.indexOf('readFigures(')).toBeGreaterThan(inline.indexOf('mayReadFigures(ledger'));
    expect(inline).toContain('return await finishDecided(finishing);');
  });

  it('before the kinds, once per hand-off, and handed on in a crossing of its own', () => {
    const figures = successor.indexOf('const read = await readFigures(bytes, figures, outlines).catch(() => ({');
    const guard = successor.indexOf(`if ((figures.length || outlines.length)
        && !figureVerdictOf(checkpoint) && mayCrossForPictures(checkpoint)) {`);
    const recorded = successor.indexOf('checkpoint = withFigureVerdict(withPictureCrossing(checkpoint), read.verdict);');
    const handedOn = successor.indexOf("reason: 'pictures_outstanding',", recorded);
    const kinds = successor.indexOf('const learning = await learnOutstandingKinds(supabase, {');
    expect(guard).toBeGreaterThan(-1);
    expect(figures).toBeGreaterThan(guard);
    expect(recorded).toBeGreaterThan(figures);
    expect(handedOn).toBeGreaterThan(recorded);
    expect(kinds).toBeGreaterThan(handedOn);
  });

  it('and applied by whichever isolate finishes the import', () => {
    expect(successor).toContain('finishDecided(decidedFromHandover(taken, figureVerdictOf(checkpoint)), {');
    const restore = run.slice(run.indexOf('function decidedFromHandover('), run.indexOf('export async function runStockImport('));
    expect(restore).toContain('const rows = withFigureApplied(decision.rows, figures);');
  });

  it('by slicing the recorded bytes and proving them, never by opening the document', () => {
    const reader = read('supabase/functions/_shared/builderStock/readFigures.ts');
    expect(reader).toContain('if (await sha256Hex(raw) !== figure.sha256) {');
    expect(reader).not.toMatch(/readPdfPage|recoverCompressedObjects|discoverPdfSourceAssets|readPdfPageTexts|readPdfTextLayout/);
  });

  it('and a block of type painted as shapes is DRAWN from what was handed over, never read out of the document', () => {
    const reader = read('supabase/functions/_shared/builderStock/readFigures.ts');
    expect(reader).toContain('const drawing = rasteriseOutlines(outlines[at]);');
    expect(reader).not.toMatch(/scanFilledPaths|outlineRegionsFrom|collectOutlinePaths/);
  });
});
