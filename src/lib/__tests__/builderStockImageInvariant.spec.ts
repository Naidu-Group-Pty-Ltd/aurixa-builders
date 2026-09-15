/**
 * THE SOURCE-PHOTOGRAPH INVARIANT, PINNED.
 *
 * Every Builder Stock property visible outside the builder's own portal
 * carries a READY photograph from the builder's own source; a property
 * without one is OWED WORK or FAILED-with-a-person-paged, never a blank
 * published card and never somebody else's imagery. These tests pin the
 * decisions at their source so a future edit that quietly reintroduces the
 * 2026-09-15 failure class — external substitutes, error-becomes-"no photo",
 * silent truncation, cron-serial throughput, hour-scale orchestration
 * backoff — has to change a named test to do it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FAILED_WORK_STAGE, STOCK_IMAGE_PROGRESS_LABEL, countWorkingImages, stockImageProgress,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  classifyBranch, rowSourceBranchCandidates, rowSourceBranches,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const MIGRATION = 'supabase/migrations/20260915200000_stock_image_invariant.sql';
const SHARED = 'supabase/functions/_shared/builderStock';

describe('external imagery is never a Builder Stock substitute', () => {
  it('rankImage refuses a verified web photograph the rank it used to hold', () => {
    const code = read(`${SHARED}/imagePriority.pure.ts`);
    expect(code).toContain('if (isVerifiedWebImage(image)) return null;');
    expect(code).not.toContain("rank: 3, provenance: 'web_sourced'");
  });

  it('nextImageStage no longer has a path to a paid rung', () => {
    const code = read(`${SHARED}/imagePriority.pure.ts`);
    const fn = code.slice(code.indexOf('export function nextImageStage'));
    expect(fn).not.toContain("return 'web_search'");
    expect(fn).not.toContain("return 'street_view'");
  });

  it('the settler no longer runs the external ladder on its empty-queue exit', () => {
    const code = read('supabase/functions/builder-stock-image-settler/index.ts');
    expect(code).not.toContain('await settleFallbackImages(');
  });

  it('the browser draws no Street View the server refused to rank', () => {
    const code = read('src/lib/builderStock.ts');
    const fn = code.slice(
      code.indexOf('export function primaryStockImage'),
      code.indexOf('export function', code.indexOf('export function primaryStockImage') + 10));
    expect(fn).not.toContain('isStreetViewImage');
    expect(fn).not.toContain('isVerifiedWebImage');
  });
});

describe('our failure is never "no photograph exists"', () => {
  it('a retryable source failure retries with a counted failure instead of settling blank', () => {
    const code = read(`${SHARED}/settleItemImages.ts`);
    const router = code.slice(code.indexOf("stage === 'fallback'"));
    expect(router).toContain("evidence.state === 'retryable_failure'");
    const retryBranch = router.slice(router.indexOf("evidence.state === 'retryable_failure'"));
    expect(retryBranch.slice(0, 300)).toContain('settlement.failed = true');
    expect(retryBranch.slice(0, 300)).toContain("settlement.nextStage = 'source'");
  });

  it('a source read that failed marks a real failure and stays at source', () => {
    const code = read(`${SHARED}/settleItemImages.ts`);
    expect(code).toContain('if (repair.error) {');
    const block = code.slice(code.indexOf('if (repair.error) {'));
    expect(block.slice(0, 400)).toContain('settlement.failed = true');
  });

  it('genuine exhaustion is the terminal failed stage, visibly, never a blank settled card', () => {
    const code = read(`${SHARED}/settleItemImages.ts`);
    const router = code.slice(code.indexOf("stage === 'fallback'"));
    expect(router).toContain("settlement.nextStage = 'failed'");
  });

  it('a failed folder listing throws instead of caching an empty folder', () => {
    const code = read(`${SHARED}/packageImages.ts`);
    const cache = code.slice(
      code.indexOf('class DriveListingCache'), code.indexOf('export interface RecoveredPackageImage'));
    expect(cache).not.toContain('this.entries.set(folderId, []);');
    expect(cache).toContain('throw new Error');
  });

  it('the terminal failed stage reads as needs-attention, never as an endless spinner', () => {
    expect(stockImageProgress({ hasImage: false, sourceDocuments: 2, workStage: FAILED_WORK_STAGE }))
      .toBe('attention');
    expect(countWorkingImages([
      { hasImage: false, sourceDocuments: 2, workStage: FAILED_WORK_STAGE },
      { hasImage: false, sourceDocuments: 2, workStage: 'source' },
    ])).toBe(1);
    expect(STOCK_IMAGE_PROGRESS_LABEL.attention).toContain('attention');
  });
});

describe('the row-linked photograph is the property’s photograph', () => {
  it('a URL with an image extension classifies as a direct image branch', () => {
    expect(classifyBranch('https://example.com/lot9/facade.jpg')).toBe('direct_image');
    expect(classifyBranch('https://example.com/lot9/pack.pdf')).toBe('document');
  });

  it('recoverPackageImage routes direct images to ingestion instead of refusal', () => {
    const code = read(`${SHARED}/packageImages.ts`);
    expect(code).toContain("classifyBranch(input.packageUrl) === 'direct_image'");
    expect(code).toContain('takeLinkedPhotograph');
    expect(code).toContain('acceptLinkedImageBytes');
  });

  it('a Drive link that answers image bytes is accepted, not banked as a failed package', () => {
    const code = read(`${SHARED}/packageImages.ts`);
    const imageBranch = code.slice(code.indexOf('&& sniffImageContentType(bytes))'));
    // The acceptance must sit INSIDE the image-sniff branch, ahead of the
    // legacy refusal it replaces for exclusive links.
    const accept = imageBranch.indexOf('acceptLinkedImageBytes');
    const refusal = imageBranch.indexOf('image rather than a package document');
    expect(accept).toBeGreaterThan(-1);
    expect(accept).toBeLessThan(refusal);
  });

  it('a link shared across rows stays estate collateral — never forty houses’ photo', () => {
    const code = read(`${SHARED}/packageImages.ts`);
    expect(code).toContain('linkSharedWithOtherRows');
    expect(code).toContain('also serves other rows');
    const repair = read(`${SHARED}/repairSourceImages.ts`);
    expect(repair).toContain('branchRowCounts');
  });

  it('unsupported URLs are recorded in evidence rather than silently dropped', () => {
    const unmapped = {
      Brochure: 'https://example.com/download?id=abc123',
      Photo: 'https://example.com/facade.png',
    };
    const candidates = rowSourceBranchCandidates(unmapped);
    expect(candidates.map((b) => b.kind).sort()).toEqual(['direct_image', 'unsupported']);
    expect(rowSourceBranches(unmapped)).toHaveLength(1);
  });
});

describe('publication requires 100% builder-source photo coverage', () => {
  const migration = read(MIGRATION);

  it('readiness counts missing builder-source primaries and failed items', () => {
    expect(migration).toContain('missing_primary');
    expect(migration).toContain("im.source_stage = 'uploaded_document'");
    expect(migration).toContain("im.verification_status = 'source_supplied'");
    expect(migration).toContain("im.processing_status = 'ready'");
    expect(migration).toContain("c.failed_items = 0");
    expect(migration).toContain('c.missing_primary = 0');
  });

  it('client visibility is one universal predicate, enforced at the publications boundary', () => {
    expect(migration).toContain('builder_stock_item_client_visible');
    expect(migration).toContain('builder_stock_publications_require_source_image');
    expect(migration).toContain('STOCK_ITEM_NOT_CLIENT_VISIBLE');
  });

  it('the claim writes no punitive backoff; failure backoff is bounded at five minutes', () => {
    const claim = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.claim_builder_stock_image_work'),
      migration.indexOf('builder_stock_failure_backoff'));
    expect(claim).not.toContain('power(2');
    expect(migration).toContain("30 * power(2, least(greatest(coalesce(p_failures, 1), 1) - 1, 4))::integer, 300");
    expect(migration).toContain('p_failed boolean DEFAULT false');
  });

  it('the watchdog reopens settled-blank served properties and closes archived strands', () => {
    expect(migration).toContain('builder_stock_image_watchdog');
    expect(migration).toContain("c.image_work_stage = 'settled'");
    expect(migration).toContain('c.primary_image_id IS NULL');
    expect(migration).toContain("lifecycle_status = 'archived'");
  });

  it('dispatch fan-out exists and the import kicks it', () => {
    expect(migration).toContain('builder_stock_dispatch_image_workers');
    expect(migration).toContain('builder_stock_kick_image_work');
    expect(read(`${SHARED}/runImport.ts`)).toContain('builder_stock_kick_image_work');
  });

  it('the stage vocabulary carries the terminal failed state', () => {
    expect(migration).toContain("'source', 'eligibility', 'sanitization', 'fallback', 'settled', 'failed'");
  });

  it('the manifest is written at import and truncation blocks publication as a failure', () => {
    expect(migration).toContain('builder_stock_source_assets');
    const imports = read(`${SHARED}/importStock.ts`);
    expect(imports).toContain('writeUploadSourceManifest');
    expect(imports).toContain('builder_stock_source_enumeration_failed');
  });
});

describe('the versions that reopen the wrongly-retired branches', () => {
  it('provenance 25 (direct-image capability) and runtime 4 (bounded fallback, honest listings)', () => {
    expect(PROVENANCE_VERSION).toBe(25);
    expect(RUNTIME_VERSION).toBe(4);
    const migration = read(MIGRATION);
    expect(migration).toContain('set_builder_stock_source_images_target(25)');
    expect(migration).toContain('image_runtime_version');
  });

  it('the settler reports real failures to the completion RPC', () => {
    const code = read('supabase/functions/builder-stock-image-settler/index.ts');
    expect(code).toContain('failed: settlement.failed === true');
    const claimModule = read(`${SHARED}/itemWorkClaim.ts`);
    expect(claimModule).toContain('p_failed');
  });

  it('the frontend tells the truth: aggregate progress and an honest failure line', () => {
    const page = read('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('Processing property photos');
    expect(page).toContain('of ${photosTotal} ready');
    expect(page).toContain('photos need attention');
    expect(page).toContain('unprocessedDocuments: item.source_documents_unprocessed');
  });
});
