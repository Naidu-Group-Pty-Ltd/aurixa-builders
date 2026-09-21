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
 * one carries a clean facade render on page 1 (1280x720 or 1920x1080).
 *
 * SO THE VERDICT WAS FALSE, AND THAT IS WHAT THESE PIN. Whatever retired
 * those five, it was not a document with no photograph in it — the documents
 * have one. An `exhausted` that a builder's own file contradicts is the
 * failure this file exists to make impossible, and it is a property of the
 * classifier rather than of any one cause upstream of it.
 *
 * WHY THIS HEADER NO LONGER NAMES A CAUSE. It used to state that those five
 * brochures (11.33–20.42 MB) had been elected in-process under a bound taken
 * from the ingest cap and CPU-killed in the isolate. That attribution is
 * DISPROVEN and must not be restated: the PDF worker was deployed at
 * 02:55:28Z on 18 September and the Supabase runtime was pointed at it at
 * 02:55:56Z — both before the failing import — and all three of those
 * documents elect a correct facade at `primary_property` through the
 * deployed bundle in 1.3–1.9 s. In-process CPU kills are real and are
 * recorded elsewhere; they are not what happened to these five. The actual
 * first incorrect transition is under investigation and this header will
 * name it when it is proven, not before.
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
     * A single fault of ours is enough to refuse to call the row exhausted,
     * because we have not in fact seen everything the builder supplied.
     *
     * Deliberately NOT asserted to be the shape the five reported properties
     * were in: what their branch records actually hold has not been read yet,
     * and a test comment that names an unverified production cause is how a
     * disproven diagnosis outlives its correction.
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

  /*
   * ARCHIVED IS WITHDRAWN STOCK, AND REMEDIATION MUST NOT REACH IT.
   *
   * A builder archives a property to take it off the market. Retrying its
   * imagery would spend work on a row nobody can see, and — worse — a row the
   * revival path re-stages on its own terms when a new list re-supplies it.
   * The exclusion is a property of the constant rather than of any call site,
   * so it is asserted here once and holds at all four `.in()` filters.
   */
  it('archived stock is never reached by retry or by the image engine', () => {
    expect(PROCESSED_LIFECYCLE).not.toContain('archived');
    expect([...PROCESSED_LIFECYCLE].sort()).toEqual(['active', 'staged']);
    const code = fn();
    expect(code).not.toContain(".in('lifecycle_status', ['active', 'staged', 'archived']");
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
    expect(page).not.toContain('The rest of your list is unaffected');
  });

  it('it may only say the rest of the list is live where the list IS live', () => {
    /*
     * THIS ASSERTION USED TO BAN THE PREFIX "The rest of your list is",
     * because the one sentence starting that way — "…is unaffected" — was
     * false: five properties held all 47 staged and invisible.
     *
     * Since 19 Sep 2026 a FIRST stock list publishes the properties that
     * earned a photograph and holds the rest, so the same prefix now
     * introduces a sentence that is TRUE — for that case and only that case.
     * Banning the words would have forced the page to stay silent about the
     * thing that had just changed, so the rule is pinned instead of the
     * string: the false sentence stays banned by name, and every claim that
     * the rest of the list is live must be reached through `listIsLive`,
     * which is the server's own `published` and nothing inferred.
     */
    const page = readCode('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('const listIsLive = progressRecord?.published === true');
    for (const claim of [
      'The rest of your list is already on the marketplace',
      'The rest of your list is live',
    ]) {
      const at = page.indexOf(claim);
      expect(at).toBeGreaterThan(-1);
      // Each one sits inside a `listIsLive ? … : …`, so the alternative the
      // page draws when the list is NOT live is right there beside it.
      const guardAt = page.lastIndexOf('listIsLive', at);
      expect(guardAt).toBeGreaterThan(-1);
      expect(at - guardAt).toBeLessThan(400);
    }
  });

  it('a published upload that still owes a photograph keeps its banner', () => {
    /*
     * The record behind the banner was chosen with `!record.published`, and a
     * first publication makes that false while the builder still has work to
     * do — so the upload would have dropped out of the reading entirely: no
     * banner, no held section, no "Add picture", and a marketplace count
     * quietly short by one with nothing saying why.
     */
    const page = readCode('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('owesAPhotograph');
    expect(page).toContain('Number(record.photos_ready ?? 0) < Number(record.total)');
    // The held-items fetch answers to the same question, not to `published`.
    const heldAt = page.indexOf('const heldUploadId');
    const heldExpr = page.slice(heldAt, heldAt + 260);
    expect(heldExpr).toContain('owesAPhotograph(progressRecord)');
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
    /*
     * RENEGOTIATED 20 September 2026, because this was pinning the defect.
     *
     * The property worth holding is the one in the describe's own name: a
     * model that could not be reached is never written up as a finding about
     * the document. The three assertions that used to stand here pinned the
     * SENTENCE instead — and that sentence was itself the bug, telling the
     * uploader of a 6.8 MB PDF brochure that "its columns were not recognised"
     * and that "giving it column headings lets it import without assistance".
     *
     * The wording now belongs to `assistedReaderFailure.pure.ts` and is
     * exercised by `builderStockAssistedReader.spec.ts` against every source
     * kind. What is asserted here is the structural guarantee this file is
     * about: the failure is NAMED and returned, rather than thrown past the
     * handler into "That file could not be processed."
     */
    /*
     * RENEGOTIATED AGAIN, 21 September 2026, and the property got stronger.
     *
     * A model that could not be reached is no longer written up as a finding
     * about the document — it is no longer written up as an OUTCOME at all.
     * The import is decided by what the document supports, so the named
     * failure that used to be returned here is gone and `no_properties_found`
     * (a fact about the document) is what a document supporting no record
     * earns. `Lot 37 - Miami 190 - Property Package.pdf` is why: seven
     * readable pages written off as an AI-credit error.
     *
     * The reading is still COMPOSED — `assistedReaderFailure` still names
     * which of our failures happened — and it still travels to the operator's
     * log. It simply no longer speaks for the builder's file.
     */
    const code = readCode(`${SHARED}/runImport.ts`);
    expect(code).toContain('assistedReaderFailure({');
    expect(code).toContain('modelFailureFromRouterError(error)');
    // And it is never thrown past the handler into "could not be processed".
    expect(code).toContain("phase: 'assisted_extraction'");
    // The document's own outcome is what the import returns.
    expect(code).toMatch(/fail\('no_properties_found'/);
  });

  it('the model call is inside the guard, so no path can escape it', () => {
    const code = read(`${SHARED}/runImport.ts`);
    // The guard narrowed: see `assistedReaderPolicy.pure.ts`.
    const guardAt = code.indexOf('if (!disposition.consulted) {');
    const imagesAt = code.indexOf('extractStockRowsFromImages(');
    const textAt = code.indexOf('extractStockRowsFromText(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(imagesAt).toBeGreaterThan(guardAt);
    expect(textAt).toBeGreaterThan(guardAt);
  });
});
