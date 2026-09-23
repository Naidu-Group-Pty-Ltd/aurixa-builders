/**
 * A PDF IS READ IN ONE ISOLATE AND ITS PICTURES ARE DECODED IN ANOTHER.
 *
 * Production, 23 September 2026: `LOT 550 - ENZO 8.5 MODERN- BROCHURE
 * V002.pdf` was killed on the portal, on "Read again" and in the settler's
 * re-read of the same bytes, each time after the reader finished and inside
 * the pictures' decode; on the 22nd the settler had been killed twelve times
 * the same way. A settler
 * invocation that parsed the same document and decoded nothing survived. So
 * the read is carried across the boundary instead of being repeated beside a
 * decode, and this file pins what makes that safe: the read restores to
 * exactly what the parse produced, a stale or damaged read is refused whole,
 * the kinds are learned in budgeted batches and never twice, and each claim is
 * classed by what it actually does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DOCUMENT_READ_VERSION, KIND_DECODE_BUDGET_MS, MAX_DOCUMENT_READ_MEDIA,
  composeDocumentRead, currentManifest, documentReadPhase, documentReadPicturePath,
  knownKinds, kindsOutstanding, planKindDecodes, restoreDocumentRead, worthCarrying,
  type DocumentReadSource,
} from '../../../supabase/functions/_shared/builderStock/documentRead.pure.ts';
import {
  DECODES_PER_INVOCATION, DOCUMENTS_PER_INVOCATION, classifyClaim, mayTakeClaim,
  mayTakeStage, newAllowance, refusalForClaim, spendClaim, spendStage,
} from '../../../supabase/functions/_shared/builderStock/workAllowance.pure.ts';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const ORG = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const DOC = 'a'.repeat(64);
const VERSIONS = { readerVersion: 13, provenanceVersion: 26 };
const digest = (n: number) => n.toString(16).padStart(64, '0');
// The extractor's placement carries more than the kind decision reads.
const HERO_PLACEMENT = { page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1 };

function source(): DocumentReadSource {
  return {
    rows: [{ lot_number: '550', address_line: '22 Wattlebird Way', price: 685000 }],
    rowAssets: [],
    pageTexts: ['LOT 550 ENZO 8.5', 'Inclusions'],
    pdfRegions: undefined,
    pageOrderAuthoritative: true,
    media: [
      {
        name: 'page1:Im0#2030', bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg',
        anchor: 'pdf:page1', placement: HERO_PLACEMENT,
        provenance: { page: 1, method: 'embedded_raster', objectNumber: 2030 },
      },
      {
        name: 'page2:Im1#2044', bytes: new Uint8Array([5, 6, 7]), contentType: 'image/png',
        anchor: null,
      },
    ],
  };
}

function composed() {
  const result = composeDocumentRead({
    organisationId: ORG, uploadId: UPLOAD, purpose: 'settle', documentSha256: DOC,
    versions: VERSIONS, source: source(), digests: [digest(1), digest(2)], kindCandidates: [0],
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

// ---------------------------------------------------------------------------
describe('a read restores to exactly what the parse produced', () => {
  it('every field the repair reads comes back as it went in', () => {
    const { manifest, blobs } = composed();
    const json = JSON.parse(JSON.stringify(manifest));
    const restored = restoreDocumentRead({
      manifest: json,
      bytesByIndex: new Map(blobs.map((blob, index) => [index, blob.bytes])),
      digestsByIndex: new Map([[0, digest(1)], [1, digest(2)]]),
      known: new Map(),
    });
    const original = source();
    expect(restored).not.toBeNull();
    expect(restored!.rows).toEqual(original.rows);
    expect(restored!.rowAssets).toEqual(original.rowAssets);
    expect(restored!.pageTexts).toEqual(original.pageTexts);
    expect(restored!.pdfRegions).toBeUndefined();
    expect(restored!.pageOrderAuthoritative).toBe(true);
    expect(restored!.media.map((m) => [m.name, m.contentType, [...m.bytes]]))
      .toEqual(original.media.map((m) => [m.name, m.contentType, [...m.bytes]]));
  });

  it('an optional field is present exactly where the extractor set it', () => {
    // `anchor: null` is a statement ("the container named no row"); an absent
    // placement is silence. The two must not come back swapped.
    const { manifest, blobs } = composed();
    const restored = restoreDocumentRead({
      manifest: JSON.parse(JSON.stringify(manifest)),
      bytesByIndex: new Map(blobs.map((blob, index) => [index, blob.bytes])),
      digestsByIndex: new Map([[0, digest(1)], [1, digest(2)]]),
      known: new Map(),
    })!;
    expect(restored.media[0].anchor).toBe('pdf:page1');
    expect(restored.media[0].placement).toEqual(source().media[0].placement);
    expect('anchor' in restored.media[1]).toBe(true);
    expect(restored.media[1].anchor).toBeNull();
    expect('placement' in restored.media[1]).toBe(false);
    expect('provenance' in restored.media[1]).toBe(false);
  });

  it('a known kind travels with its picture; an unknown one is left undecided', () => {
    const { manifest, blobs } = composed();
    const restored = restoreDocumentRead({
      manifest,
      bytesByIndex: new Map(blobs.map((blob, index) => [index, blob.bytes])),
      digestsByIndex: new Map([[0, digest(1)], [1, digest(2)]]),
      known: new Map([[0, 'photo']]),
    })!;
    expect(restored.media[0].visualKind).toBe('photo');
    expect('visualKind' in restored.media[1]).toBe(false);
  });

  it('the pictures are kept inside the upload\'s own prefix, keyed by purpose and document', () => {
    expect(documentReadPicturePath(ORG, UPLOAD, 'settle', DOC, 3))
      .toBe(`stock-lists/${ORG}/${UPLOAD}/document-read/settle/${DOC}/3`);
    expect(documentReadPicturePath(ORG, UPLOAD, 'import', DOC, 3))
      .toBe(`stock-lists/${ORG}/${UPLOAD}/document-read/import/${DOC}/3`);
    expect(composed().blobs.map((blob) => blob.path))
      .toEqual([0, 1].map((index) => documentReadPicturePath(ORG, UPLOAD, 'settle', DOC, index)));
  });
});

// ---------------------------------------------------------------------------
describe('a read that is damaged or stale is refused whole', () => {
  const restoreWith = (bytes: Map<number, Uint8Array>, digests: Map<number, string>) =>
    restoreDocumentRead({
      manifest: composed().manifest, bytesByIndex: bytes, digestsByIndex: digests, known: new Map(),
    });

  it('a missing picture, a truncated one or a different one refuses the read', () => {
    const { blobs } = composed();
    const good = new Map(blobs.map((blob, index) => [index, blob.bytes]));
    const digests = new Map([[0, digest(1)], [1, digest(2)]]);
    expect(restoreWith(good, digests)).not.toBeNull();
    expect(restoreWith(new Map([[0, blobs[0].bytes]]), digests)).toBeNull();
    expect(restoreWith(new Map([[0, blobs[0].bytes], [1, new Uint8Array([5, 6])]]), digests)).toBeNull();
    expect(restoreWith(good, new Map([[0, digest(1)], [1, digest(9)]]))).toBeNull();
  });

  it('a read of other bytes, another reader or another extractor is no read', () => {
    const row = { document_sha256: DOC, manifest: composed().manifest };
    expect(currentManifest(row, DOC, VERSIONS, 'settle')).not.toBeNull();
    expect(currentManifest(row, 'b'.repeat(64), VERSIONS, 'settle')).toBeNull();
    expect(currentManifest(row, DOC, { ...VERSIONS, readerVersion: 14 }, 'settle')).toBeNull();
    expect(currentManifest(row, DOC, { ...VERSIONS, provenanceVersion: 27 }, 'settle')).toBeNull();
    expect(currentManifest({ ...row, manifest: { ...row.manifest, v: DOCUMENT_READ_VERSION + 1 } },
      DOC, VERSIONS, 'settle')).toBeNull();
    expect(currentManifest(null, DOC, VERSIONS, 'settle')).toBeNull();
    expect(currentManifest(row, null, VERSIONS, 'settle')).toBeNull();
  });

  it('the settler\'s read is never served as the importer\'s, nor the reverse', () => {
    // The importer reads the same bytes with evidence the settler's repair is
    // never handed, so the two are different readings of one document.
    const row = { document_sha256: DOC, manifest: composed().manifest };
    expect(currentManifest(row, DOC, VERSIONS, 'import')).toBeNull();
    const imported = composeDocumentRead({
      organisationId: ORG, uploadId: UPLOAD, purpose: 'import', documentSha256: DOC,
      versions: VERSIONS, source: source(), digests: [digest(1), digest(2)], kindCandidates: [0],
    });
    if (!imported.ok) throw new Error(imported.reason);
    const importRow = { document_sha256: DOC, manifest: imported.manifest };
    expect(currentManifest(importRow, DOC, VERSIONS, 'import')).not.toBeNull();
    expect(currentManifest(importRow, DOC, VERSIONS, 'settle')).toBeNull();
  });

  it('only a paginated document with pictures is worth carrying', () => {
    expect(worthCarrying(source())).toBe(true);
    expect(worthCarrying({ ...source(), pageTexts: [] })).toBe(false);
    expect(worthCarrying({ ...source(), media: [] })).toBe(false);
  });

  it('past its bounds a read is not written, and the caller does what it always did', () => {
    const many = { ...source(), media: Array.from({ length: MAX_DOCUMENT_READ_MEDIA + 1 },
      (_, index) => ({ name: `p${index}`, bytes: new Uint8Array([index]), contentType: 'image/png' })) };
    const refused = composeDocumentRead({
      organisationId: ORG, uploadId: UPLOAD, purpose: 'settle', documentSha256: DOC,
      versions: VERSIONS, source: many, digests: many.media.map((_, index) => digest(index + 1)),
      kindCandidates: [],
    });
    expect(refused.ok).toBe(false);
    const undigested = composeDocumentRead({
      organisationId: ORG, uploadId: UPLOAD, purpose: 'settle', documentSha256: 'not-a-digest',
      versions: VERSIONS, source: source(), digests: [digest(1), digest(2)], kindCandidates: [0],
    });
    expect(undigested.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the kinds are learned in budgeted batches, and never twice', () => {
  it('a stored answer of "nothing is known" is an answer, and junk is not one', () => {
    const known = knownKinds({ 0: 'photo', 1: null, 2: 'floorplan', 3: 'banana', x: 'photo' });
    expect([...known.entries()]).toEqual([[0, 'photo'], [1, null], [2, 'floorplan']]);
  });

  it('only candidates still unanswered are owed', () => {
    const manifest = { kindCandidates: [0, 2, 5] };
    expect(kindsOutstanding(manifest, new Map([[2, null]]))).toEqual([0, 5]);
    expect(kindsOutstanding(manifest, new Map([[0, 'photo'], [2, null], [5, 'graphic']]))).toEqual([]);
  });

  it('a batch always advances, and then takes only what fits', () => {
    // LOT 550's hero is 1920x1080 = 2.07 MP, about 912 ms at the production rate.
    const estimate = (index: number) => [912, 400, 300, 5_000][index] ?? 0;
    expect(planKindDecodes([0, 1, 2], estimate, KIND_DECODE_BUDGET_MS)).toEqual([0]);
    expect(planKindDecodes([1, 2], estimate, KIND_DECODE_BUDGET_MS)).toEqual([1, 2]);
    // A single picture larger than the whole budget is still decoded — alone.
    expect(planKindDecodes([3, 1], estimate, KIND_DECODE_BUDGET_MS)).toEqual([3]);
    expect(planKindDecodes([], estimate, KIND_DECODE_BUDGET_MS)).toEqual([]);
  });

  it('where the read stands decides what the next claim is', () => {
    const manifest = composed().manifest;
    expect(documentReadPhase(null, new Map())).toBe('read');
    expect(documentReadPhase(manifest, new Map())).toBe('kinds');
    expect(documentReadPhase(manifest, new Map([[0, null]]))).toBe('attach');
  });

  it('the merge that records a batch cannot erase another batch, nor reach the other read', () => {
    const migration = read(
      'supabase/migrations/20260923100000_a_pdf_is_read_in_one_isolate_and_its_pictures_decoded_in_another.sql');
    expect(migration).toContain('SET visual_kinds = visual_kinds || p_kinds');
    expect(migration).toContain('AND purpose = p_purpose');
    expect(migration).toContain('AND document_sha256 = p_document_sha256;');
    expect(migration).toContain('PRIMARY KEY (upload_id, purpose)');
    expect(migration).toContain("CHECK (purpose IN ('import', 'settle'))");
  });
});

// ---------------------------------------------------------------------------
describe('each claim is classed by what it actually does', () => {
  it('reading a PDF is a whole document allowance; working from its read is a whole decode one', () => {
    const readClaim = classifyClaim('source', { phase: 'read', kindsKnown: 0, pdf: true });
    const kindsClaim = classifyClaim('source', { phase: 'kinds', kindsKnown: 1, pdf: true });
    const attachClaim = classifyClaim('source', { phase: 'attach', kindsKnown: 2, pdf: true });
    expect(readClaim).toMatchObject({ workClass: 'document', weight: DOCUMENTS_PER_INVOCATION });
    expect(kindsClaim).toMatchObject({ workClass: 'decode', weight: DECODES_PER_INVOCATION });
    expect(attachClaim).toMatchObject({ workClass: 'decode', weight: DECODES_PER_INVOCATION });
  });

  it('an isolate that parsed the PDF may not then take its pictures, and the reverse', () => {
    const readClaim = classifyClaim('source', { phase: 'read', kindsKnown: 0, pdf: true });
    const attachClaim = classifyClaim('source', { phase: 'attach', kindsKnown: 1, pdf: true });
    const afterRead = spendClaim(readClaim, newAllowance());
    expect(mayTakeClaim(attachClaim, afterRead)).toBe(false);
    expect(refusalForClaim(attachClaim, afterRead)).toContain('may not also decode');
    const afterAttach = spendClaim(attachClaim, newAllowance());
    expect(mayTakeClaim(readClaim, afterAttach)).toBe(false);
    // Nor a second heavy decode claim, nor even an eligibility decode after it.
    expect(mayTakeClaim(attachClaim, afterAttach)).toBe(false);
    expect(mayTakeStage('eligibility', afterAttach)).toBe(false);
    // A heavy claim needs its whole allowance free, not merely some of it.
    expect(mayTakeClaim(attachClaim, spendStage('eligibility', newAllowance()))).toBe(false);
  });

  it('successive claims that each made progress are told apart', () => {
    const keys = new Set([
      classifyClaim('source', { phase: 'read', kindsKnown: 0, pdf: true }).key,
      classifyClaim('source', { phase: 'kinds', kindsKnown: 0, pdf: true }).key,
      classifyClaim('source', { phase: 'kinds', kindsKnown: 3, pdf: true }).key,
      classifyClaim('source', { phase: 'attach', kindsKnown: 5, pdf: true }).key,
    ]);
    expect(keys.size).toBe(4);
  });

  it('every other stage, and a source nobody could class, is exactly what it was', () => {
    for (const stage of ['eligibility', 'sanitization', 'fallback', 'source']) {
      const spent = newAllowance();
      const before = mayTakeStage(stage, spent);
      expect(mayTakeClaim(classifyClaim(stage), spent)).toBe(before);
    }
    expect(classifyClaim('source')).toMatchObject({ workClass: 'document', weight: 1, key: 'source' });
    // A non-PDF read keeps the single document weight it always had.
    expect(classifyClaim('source', { phase: 'read', kindsKnown: 0, pdf: false }).weight).toBe(1);
  });

  it('the settler classes the claim before it runs it, and keys stalls on the class', () => {
    const settler = read('supabase/functions/builder-stock-image-settler/index.ts');
    expect(settler).toContain('let claimedClass = await resolveClaimClass(supabase, claimed);');
    expect(settler).toContain('spendClaim(claimedClass, allowance);');
    expect(settler).toContain('workedThisInvocation.add(`${claimed.id}:${claimedClass.key}`);');
    expect(settler).toContain('if (workedThisInvocation.has(`${candidate.id}:${candidateClass.key}`)) {');
    expect(settler).toContain('const allowanceSpent = !mayTakeClaim(candidateClass, allowance);');
    expect(settler).not.toContain('spendStage(');
  });

  it('the source stage asks for the split, and reports a stop as progress', () => {
    const settle = read('supabase/functions/_shared/builderStock/settleItemImages.ts');
    expect(settle).toContain("documentRead: 'split',");
    expect(settle).toContain("|| repair.documentRead === 'written' || repair.documentRead === 'kinds';");
  });

  it('a parse that writes the read stops before any picture is decoded', () => {
    const repair = read('supabase/functions/_shared/builderStock/repairSourceImages.ts');
    const written = repair.indexOf("return { ...outcome, incomplete: true, documentRead: 'written' };");
    const firstAttach = repair.indexOf('await attachDocumentMedia(');
    expect(written).toBeGreaterThan(-1);
    expect(firstAttach).toBeGreaterThan(written);
  });

  it('the settler only ever reads and writes its OWN read', () => {
    const repair = read('supabase/functions/_shared/builderStock/repairSourceImages.ts');
    const purposes = [...repair.matchAll(/purpose: '(import|settle)'/g)].map((m) => m[1]);
    expect(purposes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(purposes)).toEqual(new Set(['settle']));
    const classing = read('supabase/functions/_shared/builderStock/documentRead.ts');
    expect(classing).toContain("uploadId, purpose: 'settle', documentSha256: upload.file_sha256 ?? null,");
  });

  it('a source that is not a PDF is classed exactly as it always was, with no read asked for', () => {
    const classing = read('supabase/functions/_shared/builderStock/documentRead.ts');
    const body = classing.slice(classing.indexOf('export async function resolveClaimClass'));
    const notPdf = body.indexOf('if (!pdf) return classifyClaim(stage);');
    const asked = body.indexOf('documentReadPhaseFor(db, {');
    expect(notPdf).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(notPdf);
  });
});
