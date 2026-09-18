/**
 * A FAILURE ON OUR SIDE IS NEVER RECORDED AS A FINDING ABOUT THE BUILDER'S
 * DOCUMENTS — pinned.
 *
 * THE DEFECT THESE PIN. Measured 18 September 2026, project
 * htfluofznhxeumblwbww, import of the VG master stock list: five of 47
 * properties were routed `supplied_evidence: exhausted` — "all builder
 * sources were read and none names an image for this property" — and moved to
 * the terminal `failed` stage, which holds the whole list staged and
 * invisible. Their brochures were then downloaded and opened by hand: every
 * one carries a clean facade render on page 1 (1280x720 or 1920x1080). What
 * had actually happened is that those five brochures are 11.33–20.42 MB, were
 * elected IN-PROCESS under a bound taken from the ingest cap rather than from
 * any measurement, and the isolate was CPU-killed. Nothing was learned, and
 * the system wrote down that the builder had supplied nothing.
 *
 * `exhausted` and `operational` are the two words that must never be
 * confused: one is a statement about a document, the other about us. Only the
 * first may retire a property, because only the first is true.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSuppliedEvidence,
  fallbackMayRun,
  type SuppliedEvidenceInput,
} from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';
import {
  BRANCH_IMAGE_RECOVERED, type RowSourceBranch,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  NO_DETERMINISTIC_IMAGE,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';
import {
  PROCESSED_LIFECYCLE,
} from '../../../supabase/functions/_shared/builderStock/stockLifecycle.pure';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SHARED = 'supabase/functions/_shared/builderStock';

/**
 * The file with its block comments removed.
 *
 * A "this must not come back" assertion has to read the CODE, not the prose
 * around it. This repository records the defect it fixed in the comment above
 * the fix — which is the practice worth keeping — so scanning the raw file
 * makes every such comment trip its own guard, and the only way to pass would
 * be to delete the explanation.
 */
const readCode = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const BROCHURE = 'https://drive.google.com/file/d/brochure/view';
const MASTERPLAN = 'https://drive.google.com/file/d/masterplan/view';

const branch = (url: string, column: string): RowSourceBranch =>
  ({ url, column, kind: 'document' as RowSourceBranch['kind'] });

/** A branch record for a document that was opened and names no image. */
const inspectedRecord = (url: string) => ({
  result: NO_DETERMINISTIC_IMAGE,
  provenance_version: PROVENANCE_VERSION,
  package_reference: url,
  source_anchor: null,
  detail: 'read, names nothing',
  exhaustion: 'inspected',
  checked_at: new Date().toISOString(),
});

/** The same, but the discriminator says the retirement was OURS. */
const operationalRecord = (url: string) => ({
  ...inspectedRecord(url),
  exhaustion: 'operational',
  detail: 'the document reader had no capacity',
});

/** A branch that handed over an image (which the role gate may still refuse). */
const recoveredRecord = (url: string) => ({
  result: BRANCH_IMAGE_RECOVERED,
  provenance_version: PROVENANCE_VERSION,
  package_reference: url,
  source_anchor: null,
  checked_at: new Date().toISOString(),
});

const evidenceFor = (
  records: Record<string, unknown>,
  branches: RowSourceBranch[],
  overrides: Partial<SuppliedEvidenceInput> = {},
) => readSuppliedEvidence({
  branches,
  stored: { branches: records },
  provenanceVersion: PROVENANCE_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  sourceAnchor: null,
  builderImageAccepted: false,
  linkDiscovery: { state: 'complete', method: 'native:test' },
  ...overrides,
});

describe('the two words are never confused', () => {
  it('one operational branch withholds the verdict, however many were read', () => {
    /*
     * This is the case the five properties were in: the brochure could not be
     * read, the other three were. A single fault of ours is enough to refuse
     * to call the row exhausted — because we have not in fact seen everything
     * the builder supplied.
     */
    const reading = evidenceFor({
      [BROCHURE]: operationalRecord(BROCHURE),
      [MASTERPLAN]: inspectedRecord(MASTERPLAN),
    }, [branch(BROCHURE, 'Brochure'), branch(MASTERPLAN, 'Siting / Masterplan')]);

    expect(reading.state).toBe('retryable_failure');
    expect(reading.operational).toBe(1);
    expect(reading.detail).toContain('fault on our side');
  });

  it('a retryable failure may never buy the online fallback', () => {
    // `exhausted` admits the ladder; "we could not look" must not, or an
    // outage becomes a Street View on a builder's card.
    expect(fallbackMayRun('retryable_failure')).toBe(false);
    expect(fallbackMayRun('exhausted')).toBe(true);
  });

  it('only a genuinely read document retires the row', () => {
    const reading = evidenceFor({
      [BROCHURE]: inspectedRecord(BROCHURE),
      [MASTERPLAN]: inspectedRecord(MASTERPLAN),
    }, [branch(BROCHURE, 'Brochure'), branch(MASTERPLAN, 'Siting / Masterplan')]);

    expect(reading.state).toBe('exhausted');
    expect(reading.operational).toBe(0);
  });
});

describe('the exhausted sentence says which kind of nothing it was', () => {
  /*
   * A branch that HANDED OVER an image the role gate then refused — a
   * masterplan, a location map, an agency lockup — is finished knowledge, so
   * it stays `inspected`. But telling a builder their documents "name no
   * image" when one of them handed over a site plan is a sentence they can
   * neither act on nor recognise.
   */
  it('names collateral where a branch delivered an image nobody could use', () => {
    const reading = evidenceFor({
      [BROCHURE]: inspectedRecord(BROCHURE),
      [MASTERPLAN]: recoveredRecord(MASTERPLAN),
    }, [branch(BROCHURE, 'Brochure'), branch(MASTERPLAN, 'Siting / Masterplan')]);

    expect(reading.state).toBe('exhausted');
    expect(reading.detail).toContain('not a photograph of this property');
    expect(reading.detail).not.toContain('none names an image');
  });

  it('keeps the plain sentence where nothing was delivered at all', () => {
    const reading = evidenceFor({
      [BROCHURE]: inspectedRecord(BROCHURE),
    }, [branch(BROCHURE, 'Brochure')]);

    expect(reading.state).toBe('exhausted');
    expect(reading.detail).toContain('none names an image');
  });

  it('an accepted builder picture still settles the question before anything else', () => {
    const reading = evidenceFor({}, [branch(BROCHURE, 'Brochure')], {
      builderImageAccepted: true,
    });
    expect(reading.state).toBe('found');
  });
});

describe('the builder can reach the properties that are holding their list', () => {
  /*
   * A stock list publishes in one cutover once every property carries a
   * builder-source photograph, so a property that cannot get one holds the
   * whole list staged. The server has always accepted a builder-supplied
   * picture for a staged row; what was missing was any way to SEE one.
   */
  const fn = () => readCode('supabase/functions/builder-portal-stock/index.ts');

  it('"Retry image lookup" covers both processed lifecycles, not just the published one', () => {
    const code = fn();
    expect(PROCESSED_LIFECYCLE).toContain('staged');
    // The filter that made the control a no-op on exactly the rows that
    // needed it: every one of 47 held properties was staged, none active.
    expect(code).not.toContain(".eq('lifecycle_status', 'active')");
    expect(code).toContain(".in('lifecycle_status', PROCESSED_LIFECYCLE)");
  });

  it('the stock read validates the lifecycle it is asked for, and can serve staged', () => {
    const code = fn();
    // An unrecognised string used to reach `.eq()` and return zero rows,
    // which reads exactly like a builder with no stock.
    expect(code).toContain("requestedLifecycle === 'staged'");
    expect(code).toContain('const lifecycle: StockLifecycle');
    expect(code).toContain('.eq(\'lifecycle_status\', lifecycle)');
  });

  it('the page fetches the held properties and offers them for a picture', () => {
    const page = readCode('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('useBuilderStockHeldItems');
    expect(page).toContain('heldWithoutPhoto');
    expect(page).toContain('waiting to go live');
    // The sentence that told a builder the rest of their list was fine while
    // five properties held all 47 of them invisible.
    expect(page).not.toContain('The rest of your list is');
  });

  it('the held section survives an empty marketplace, which is when it is needed', () => {
    /*
     * The explanatory banners used to live inside the `records.length` branch,
     * so a list holding every one of its properties drew none of them and
     * reported "No stock has been uploaded yet".
     */
    const page = read('src/pages/builder/BuilderStockList.tsx');
    const heldAt = page.indexOf('WAITING TO GO LIVE');
    const emptyBranchAt = page.indexOf('!records.length ?');
    expect(heldAt).toBeGreaterThan(-1);
    expect(emptyBranchAt).toBeGreaterThan(-1);
    expect(heldAt).toBeLessThan(emptyBranchAt);
    expect(page).toContain('Nothing is on the marketplace yet');
  });
});

describe('an unreachable model is not a verdict on the document', () => {
  it('the import names the failure instead of throwing past the handler', () => {
    const code = readCode(`${SHARED}/runImport.ts`);
    expect(code).toContain("code: 'assisted_reader_unavailable'");
    expect(code).toContain('the assisted reader could not be reached');
    // What the builder used to be shown for a credential nobody had set.
    expect(code).toContain('We could not finish reading that page.');
  });

  it('the model call is inside the guard, so no path can escape it', () => {
    const code = read(`${SHARED}/runImport.ts`);
    const guardAt = code.indexOf('  try {\n    if (!rows.length');
    const imagesAt = code.indexOf('extractStockRowsFromImages(');
    const textAt = code.indexOf('extractStockRowsFromText(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(imagesAt).toBeGreaterThan(guardAt);
    expect(textAt).toBeGreaterThan(guardAt);
  });
});
