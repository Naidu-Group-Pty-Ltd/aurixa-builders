/**
 * AN IMPORT THAT PARSED A PDF HANDS ITS PICTURES TO A SUCCESSOR, WHICH
 * ATTACHES THEM EXACTLY AS THE IMPORT WOULD HAVE.
 *
 * Production, 23 September 2026: `LOT 550 - ENZO 8.5 MODERN- BROCHURE
 * V002.pdf` was killed on `process_upload`, on "Read again" and in the
 * settler's re-read of the same bytes, each time after the reader finished,
 * inside the decode that settles the pictures' roles. The first fix sent the pictures to the image settler
 * instead, and the acceptance gate refused it: ten brochures with no
 * photograph, because the settler's repair re-reads a brochure without the
 * evidence the importer reads it with and matched none of their properties
 * (`stored 0, matched 0`, 151 times out of 151).
 *
 * So the IMPORT crosses: it decides the document where it read it, writes the
 * read and the decision down, and its successor runs the one tail every import
 * runs. This file pins what makes that the same import: the decision is bound
 * to the attempt that made it, a fresh attempt never adopts another's, the
 * crossings are bounded by a count that is a proof, and the parse isolate
 * stops before any picture is decoded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  IMPORT_HANDOVER_VERSION, composeImportHandover, readImportHandover,
  type ImportDecision,
} from '../../../supabase/functions/_shared/builderStock/importHandover.pure.ts';
import {
  MAX_IMPORT_CONTINUATIONS, MAX_PICTURE_CROSSINGS, crossingsSpent, freshAttempt,
  mayContinue, mayCrossForPictures, openCheckpoint, pictureHandover, readCheckpoint,
  storedPictureHandover, withContinuation, withPictureCrossing, withPictureHandover,
  withRecogniserUnavailable, withRecognisedPage,
} from '../../../supabase/functions/_shared/builderStock/importCheckpoint.pure.ts';
import { MAX_KIND_CANDIDATES } from '../../../supabase/functions/_shared/builderStock/documentRead.pure.ts';
import { IMPORT_STAGES, importWorkClassOf } from '../../../supabase/functions/_shared/builderStock/importStageLedger.pure.ts';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const SHA = 'c'.repeat(64);

function decision(overrides: Partial<ImportDecision> = {}): ImportDecision {
  return {
    strategy: 'pdf_deterministic_brochure',
    rows: [{ lot_number: '550', development_name: 'Fraser Rise' }],
    completedFields: [],
    detectedMime: 'application/pdf',
    classificationKind: 'pdf',
    linkDiscovery: { state: 'complete', method: 'native:pdf_deterministic_brochure' },
    warnings: [],
    imageryDeferred: null,
    deterministicReading: { status: 'read', reason: null, diagnostics: { fieldsRead: ['lot_number'] } },
    deterministicProvisionalCount: 0,
    deterministicUnaccounted: null,
    deterministicIgnored: ['FRASER RISE'],
    deterministicPlacement: ['p1'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe('the decision is bound to the attempt that made it', () => {
  it('comes back whole for the token its checkpoint names', () => {
    const stored = JSON.parse(JSON.stringify(composeImportHandover('token-1', decision())));
    expect(readImportHandover(stored, 'token-1')).toEqual(decision());
  });

  it('carries the figures a successor may read, and drops any it cannot trust', () => {
    const figure = {
      page: 1, objectNumber: 1899, width: 231, height: 166, start: 5000, end: 9000, flate: true,
      drawn: { x: 45.3, y: 79.9, width: 151.2, height: 108.6 }, sha256: 'f'.repeat(64),
    };
    const stored = JSON.parse(JSON.stringify(composeImportHandover('token-1', decision({
      figures: [figure, { ...figure, sha256: 'tampered' }],
    }))));
    expect(readImportHandover(stored, 'token-1')?.figures).toEqual([figure]);
  });

  it('is refused for any other token, a missing one, or a shape this build does not know', () => {
    const stored = composeImportHandover('token-1', decision());
    expect(readImportHandover(stored, 'token-2')).toBeNull();
    expect(readImportHandover(stored, null)).toBeNull();
    expect(readImportHandover({ ...stored, v: IMPORT_HANDOVER_VERSION + 1 }, 'token-1')).toBeNull();
    expect(readImportHandover(null, 'token-1')).toBeNull();
  });

  it('is refused where a value is not the type the tail reads', () => {
    const bad = (patch: Record<string, unknown>) =>
      readImportHandover(composeImportHandover('t', { ...decision(), ...patch } as ImportDecision), 't');
    expect(bad({ strategy: '' })).toBeNull();
    expect(bad({ rows: [1, 2] })).toBeNull();
    expect(bad({ completedFields: [3] })).toBeNull();
    expect(bad({ warnings: null })).toBeNull();
    expect(bad({ classificationKind: '' })).toBeNull();
    expect(bad({ linkDiscovery: null })).toBeNull();
    expect(bad({ deterministicProvisionalCount: -1 })).toBeNull();
    expect(bad({ deterministicIgnored: [1] })).toBeNull();
    // Absent lines are "none", which is what the tail already reads them as.
    expect(bad({ deterministicUnaccounted: undefined })?.deterministicUnaccounted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the checkpoint carries the hand-off, and a fresh attempt never adopts one', () => {
  it('survives the round trip through the row, beside the recognised pages', () => {
    let checkpoint = withRecognisedPage(openCheckpoint(SHA), 2, 'LOT 550');
    checkpoint = withPictureHandover(checkpoint, 'token-1');
    const stored = JSON.parse(JSON.stringify(checkpoint));
    const back = readCheckpoint(stored, SHA)!;
    expect(pictureHandover(back)).toBe('token-1');
    expect(back.pictures?.crossings).toBe(1);
    expect(back.ocr?.pages['2']).toBe('LOT 550');
  });

  it('a fresh attempt keeps the recognised pages and drops the hand-off', () => {
    let checkpoint = withRecognisedPage(openCheckpoint(SHA), 1, 'page one');
    checkpoint = withContinuation(withPictureHandover(checkpoint, 'stale'));
    const fresh = freshAttempt(checkpoint);
    expect(pictureHandover(fresh)).toBeNull();
    expect('pictures' in fresh).toBe(false);
    expect(fresh.continuations).toBe(0);
    expect(fresh.ocr?.pages['1']).toBe('page one');
  });

  it('a stored hand-off is named whatever document it described, so it can be put away', () => {
    const stored = JSON.parse(JSON.stringify(withPictureHandover(openCheckpoint(SHA), 'old')));
    // `readCheckpoint` refuses to describe a different document...
    expect(readCheckpoint(stored, 'd'.repeat(64))).toBeNull();
    // ...but what it handed on still has to be found to be discarded.
    expect(storedPictureHandover(stored)).toBe('old');
    expect(storedPictureHandover(null)).toBeNull();
    expect(storedPictureHandover({ pictures: { handover: 7 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the crossings are bounded by a proof, not a preference', () => {
  it('the bound is one hand-off, one reading of the figures, and one crossing per picture the role decision can read', () => {
    // The figures are read once per hand-off, in a crossing of their own, and
    // their verdict is recorded whatever it is (`pdfFigures.pure.ts`).
    expect(MAX_PICTURE_CROSSINGS).toBe(2 + MAX_KIND_CANDIDATES);
    // And that set is the decoder's own: named once, imported by both.
    const assess = read('supabase/functions/_shared/builderStock/assessSourceImage.ts');
    expect(assess).toContain('const MAX_VISION_DECODES = MAX_KIND_CANDIDATES;');
    expect(assess).not.toMatch(/const MAX_VISION_DECODES = \d/);
  });

  it('is counted apart from recognition, and a missing recogniser does not stop it', () => {
    let checkpoint = withRecogniserUnavailable(openCheckpoint(SHA));
    expect(mayContinue(checkpoint)).toBe(false);
    expect(mayCrossForPictures(checkpoint)).toBe(true);
    checkpoint = withPictureHandover(checkpoint, 't');
    for (let i = 1; i < MAX_PICTURE_CROSSINGS; i += 1) checkpoint = withPictureCrossing(checkpoint);
    expect(checkpoint.pictures?.crossings).toBe(MAX_PICTURE_CROSSINGS);
    expect(mayCrossForPictures(checkpoint)).toBe(false);
  });

  it('what an import reports as its crossings is both kinds together', () => {
    let checkpoint = withContinuation(withContinuation(openCheckpoint(SHA)));
    checkpoint = withPictureCrossing(withPictureHandover(checkpoint, 't'));
    expect(crossingsSpent(checkpoint)).toBe(4);
    expect(MAX_IMPORT_CONTINUATIONS).toBe(10);
  });

  it('a crossing on no hand-off is not invented', () => {
    expect(withPictureCrossing(openCheckpoint(SHA)).pictures).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('the parse isolate stops before any picture is decoded', () => {
  const run = read('supabase/functions/_shared/builderStock/runImport.ts');

  it('one tail, fed by the decision whichever isolate runs it', () => {
    const tail = run.slice(run.indexOf('const finishDecided = async'),
      run.indexOf('THE SUCCESSOR OF A PICTURE HAND-OFF READS NOTHING'));
    expect(tail).toContain('await importStockRecords(supabase, {');
    expect(tail).not.toMatch(/\bextraction\./);
    expect(tail).not.toMatch(/\bdetection\./);
    expect(tail).not.toMatch(/\bclassification\./);
    expect((run.match(/await importStockRecords\(/g) ?? [])).toHaveLength(1);
  });

  it('the hand-off is made after the reading is decided and before the tail runs', () => {
    const decided = run.indexOf('const decided: DecidedImport = {');
    const handOff = run.indexOf('const handed = await handPicturesOver(supabase, {');
    const tail = run.lastIndexOf('return await finishDecided(finishing);');
    expect(decided).toBeGreaterThan(-1);
    expect(handOff).toBeGreaterThan(decided);
    expect(tail).toBeGreaterThan(handOff);
    // Only where a successor can reproduce the run, and never past the bound.
    const guard = run.slice(run.lastIndexOf('if (input.resumableFromStoredBytes', handOff), handOff);
    expect(guard).toContain('picturesWorthHandingOver(');
    expect(guard).toContain('mayCrossForPictures(checkpoint)');
  });

  it('a hand-off is returned only once the checkpoint naming it has landed', () => {
    const block = run.slice(run.indexOf('const handed = await handPicturesOver(supabase, {'),
      run.lastIndexOf('return await finishDecided(finishing);'));
    expect(block).toContain('handedOn = await commitCheckpoint();');
    expect(block).toContain('await discardHandedOverPictures(supabase, { organisationId, uploadId: upload.id });');
    expect(block.indexOf('if (handedOn) {')).toBeGreaterThan(block.indexOf('handedOn = await commitCheckpoint();'));
  });

  it('the successor takes the read before any extraction, and only for its own token', () => {
    const successor = run.indexOf('const handoverToken = input.resumed && input.resumableFromStoredBytes');
    const extraction = run.indexOf('extraction = await extractAs(ocrMode);');
    expect(successor).toBeGreaterThan(-1);
    expect(extraction).toBeGreaterThan(successor);
    expect(run).toContain('? pictureHandover(checkpoint) : null;');
    expect(run).toContain('organisationId, uploadId: upload.id, documentSha256: sha, token: handoverToken,');
  });

  it('a successor that learns kinds hands on, and one that attaches puts the read away', () => {
    const branch = run.slice(run.indexOf('const handoverToken = input.resumed'),
      run.indexOf('let extraction;'));
    const learn = branch.indexOf("uploadId: upload.id, purpose: 'import', loaded: taken.loaded,");
    const handOn = branch.indexOf("reason: 'pictures_outstanding',", learn);
    const finish = branch.indexOf(
      'const finished = await finishDecided(decidedFromHandover(taken, figureVerdictOf(checkpoint)), {');
    const discard = branch.indexOf('await discardHandedOverPictures(supabase, { organisationId, uploadId: upload.id });');
    expect(learn).toBeGreaterThan(-1);
    expect(handOn).toBeGreaterThan(learn);
    expect(finish).toBeGreaterThan(handOn);
    expect(discard).toBeGreaterThan(finish);
  });

  it('a fresh attempt drops what an earlier one handed on', () => {
    expect(run).toContain('if (!input.resumed) checkpoint = freshAttempt(checkpoint);');
    expect(run).toContain('&& storedPictureHandover(input.storedCheckpoint)) {');
  });

  it('the hand-off stage is recorded, and costs nothing the budgets count as heavy', () => {
    expect(IMPORT_STAGES).toContain('document_handover');
    expect(importWorkClassOf('document_handover')).toBe('metadata');
  });
});

// ---------------------------------------------------------------------------
describe('the attach that runs in the successor decodes no kind it was handed', () => {
  it('a picture that arrives with its kind is not priced as a decode', () => {
    const assess = read('supabase/functions/_shared/builderStock/assessSourceImage.ts');
    const pricing = assess.slice(assess.indexOf('export function documentVisualKindsPixels'),
      assess.indexOf('export function visualKindCandidates'));
    expect(pricing).toContain('.filter((index) => media[index].visualKind === undefined)');
    const decoding = assess.slice(assess.indexOf('export async function documentVisualKinds('));
    expect(decoding).toContain('kinds[index] = entry.visualKind !== undefined');
  });
});

// ---------------------------------------------------------------------------
describe('the isolate that attaches decodes what a settler decode isolate may, no more', () => {
  it('the successor passes the settler\'s own allowance, and the inline path passes none', () => {
    const run = read('supabase/functions/_shared/builderStock/runImport.ts');
    expect(run).toContain(`const finished = await finishDecided(decidedFromHandover(taken, figureVerdictOf(checkpoint)), {
        eligibilityDecodes: DECODES_PER_INVOCATION,
      });`);
    expect(run).toContain('eligibilityDecodes: attach.eligibilityDecodes ?? null,');
    expect(run.lastIndexOf('return await finishDecided(finishing);')).toBeGreaterThan(-1);
  });

  it('past the allowance a picture is still stored, with no verdict rather than a guessed one', () => {
    const attach = read('supabase/functions/_shared/builderStock/importStock.ts');
    const body = attach.slice(attach.indexOf('export async function attachDocumentMedia('));
    // Counted only where a decode would happen, and exactly then.
    expect(body).toContain('if (!eligibilityDecodes(media.bytes, roles[index].role)) {');
    expect(body).toContain('if (eligibilityDecodesLeft <= 0) return {};');
    // The row is written either way: the upsert is not inside the allowance.
    const upsert = body.indexOf(".from('builder_stock_item_images').upsert({");
    const allowance = body.indexOf('if (eligibilityDecodesLeft <= 0) return {};');
    expect(upsert).toBeGreaterThan(-1);
    expect(allowance).toBeGreaterThan(upsert);
    const assess = read('supabase/functions/_shared/builderStock/assessSourceImage.ts');
    expect(assess).toContain('return isPrimaryRole(role) && !oversizedForInlineDecode(bytes);');
  });
});

// ---------------------------------------------------------------------------
describe('an import a successor finished is recorded like one the browser finished', () => {
  it('the continuation reports what it answered, after the row is written', () => {
    const cont = read('supabase/functions/_shared/builderStock/continueImport.ts');
    const written = cont.indexOf('.update(importOutcomeColumns(result, null))');
    const told = cont.indexOf('await told(result);', written);
    expect(written).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(written);
  });

  it('the portal writes the processing audit record for it, as the system', () => {
    const portal = read('supabase/functions/builder-portal-stock/index.ts');
    const branch = portal.slice(portal.indexOf("if (operation === 'continue_import') {"),
      portal.indexOf('const session = await resolveBuilderSession(supabase, req);'));
    expect(branch).toContain("action: 'builder_stock_upload_processed',");
    expect(branch).toContain("actorType: 'system',");
    expect(branch).toContain('continued: true,');
  });

  it('removing a stock list removes the reads of it too', () => {
    const portal = read('supabase/functions/builder-portal-stock/index.ts');
    expect(portal).toContain("for (const purpose of ['import', 'settle'] as const) {");
    expect(portal).toContain('await discardDocumentRead(supabase, {');
  });
});
