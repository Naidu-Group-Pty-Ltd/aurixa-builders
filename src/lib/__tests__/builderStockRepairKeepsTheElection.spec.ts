/**
 * ===========================================================================
 * A REPAIR MAY NOT REACH A DIFFERENT CONCLUSION FROM THE IMPORT.
 * ===========================================================================
 *
 * ## What happened
 *
 * MEASURED 22 September 2026, on a one-page document carrying two property
 * cards, each with a facade and a floor plan drawn in its own column
 * (`CARRINGTON - TWO PACKAGES.pdf`). The import was completely correct:
 *
 *     after import   lot 19  primary=set   #4 role=primary_property eligible
 *                    lot 24  primary=set   #5 role=primary_property eligible
 *
 * The first settler tick then ran the `source` stage, which re-reads the
 * document through `repairSourceImagesForUpload`, and left this:
 *
 *     first tick     lot 19  primary=null  #4 role=unknown  eligibility gone
 *                    lot 24  primary=null  #5 role=unknown  eligibility gone
 *
 * and the ladder walked on to `fallback`, answered *"supplied evidence
 * no_evidence: this row names no source this pipeline can open"*, and stamped
 * both properties `failed` — about a document whose own pages name both
 * photographs perfectly well. Neither card ever showed a picture.
 *
 * ## Why
 *
 * `attachDocumentMedia` takes an optional `paginated` argument. With it, the
 * roles are settled by `assignPdfMediaRolesPerProperty`, which reads the
 * property's own cover page: does the page state this property's identity,
 * does it state package facts, which of the pictures on it does the document
 * draw largest. Without it, they are settled by `settleContainerMediaRoles`,
 * which is right for a spreadsheet or a Notion row and has no page to read —
 * so it designates a primary only where a property has EXACTLY ONE attributed
 * picture, because a container that hands you two has not said which is the
 * listing image.
 *
 * `repairPdfUpload` — the branch for a PDF whose rows could not be re-read —
 * has passed `paginated` since it was written, under a comment saying in so
 * many words that "a repair cannot reach a different conclusion about which
 * picture is this property's than the upload that created it did". The OTHER
 * repair branch, the one every ordinary PDF takes because its rows DO re-read,
 * passed nothing. And the upsert replaces `source_detail` wholesale, so the
 * wrong helper did not merely fail to elect — it ERASED the election and the
 * eligibility verdict beside it.
 *
 * ## Why it was invisible until now
 *
 * `settleContainerMediaRoles` gets the one-picture case right, and until a
 * page could be divided into regions a PDF property had at most one
 * attributed picture: a second picture on the page belonged to the page, and
 * a page anchor two properties claim is attributed to neither. A floor plan
 * beside a facade inside one property's own column — an ordinary brochure — is
 * all it takes, and region attribution is what made it ordinary.
 *
 * So this is not a defect the segmentation work introduced. It is one the
 * segmentation work made reachable, and it was always reachable by a
 * single-property document drawing two pictures the election could separate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  settleContainerMediaRoles,
} from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';
import {
  assignPdfMediaRolesPerProperty,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SHARED = 'supabase/functions/_shared/builderStock';
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

describe('the two role helpers answer different questions', () => {
  const media = [
    { name: 'page1:Im0#4', placement: { page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.24 } },
    { name: 'page1:Im1#6', placement: { page: 1, name: 'Im1', placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.07 } },
  ];
  const itemId = '11111111-1111-4111-8111-111111111111';

  it('gives a property with two pictures no primary, where nothing can read a page', () => {
    /*
     * AND IT IS RIGHT TO. A spreadsheet row holding two images has not said
     * which one is the listing image, and designating one would be the guess
     * this whole path exists to prevent. The defect was never this helper's.
     */
    const roles = settleContainerMediaRoles({
      media: media.map((m) => ({ name: m.name, anchor: 'pdf:page1#r0' })),
      stockItemIds: [itemId, itemId],
      structural: [true, true],
      container: "the container in the builder's own document",
    });
    expect(roles.map((r) => r.role)).toEqual(['unknown', 'unknown']);
  });

  it('elects the property\'s own picture, where a page can be read', () => {
    const roles = assignPdfMediaRolesPerProperty({
      media,
      stockItemIds: [itemId, itemId],
      labelByItemId: new Map([[itemId, 'Lot 19 Verity 19']]),
      identityHintsByItemId: new Map([[itemId, ['Carrington Gardens']]]),
      designByItemId: new Map([[itemId, 'Verity 19']]),
      soleProperty: false,
      // The property's own REGION, which is what its page is once the page
      // has been divided. Two package facts and no other lot named.
      pageTexts: ['Lot 19\nHome Design Verity 19\nLand Size 336m2\n'
        + 'Build Size 196m2\nPrice $671,000'],
      pageOrderAuthoritative: true,
      visualKinds: ['photo', 'floorplan'],
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).not.toBe('primary_property');
  });
});

describe('both repair branches judge a paginated source by its pages', () => {
  /*
   * PINNED AT THE SOURCE, because the branch is inside an Edge module whose
   * imports do not resolve in Node — the same way this repository already
   * pins an Edge handler it cannot run here. The property is not what the
   * branch computes; it is that BOTH calls hand the page evidence over.
   */
  const source = read(`${SHARED}/repairSourceImages.ts`);

  const attachCalls = source.split('await attachDocumentMedia(').slice(1);

  it('has exactly two places that attach a document\'s media', () => {
    expect(attachCalls).toHaveLength(2);
  });

  for (const [index, call] of attachCalls.entries()) {
    it(`passes the page evidence at attach site ${index}`, () => {
      const body = call.slice(0, 3400);
      expect(body).toContain('labelByItemId');
      expect(body).toContain('identityHintsByItemId');
      expect(body).toContain('designByItemId');
      expect(body).toContain('pageTexts');
      expect(body).toContain('pageOrderAuthoritative');
    });
  }

  it('substitutes a divided page\'s region for the page, as the import does', () => {
    // One implementation, imported by both, so the import and the repair
    // cannot come to disagree about what "this property's page" means.
    expect(source).toContain('regionPageViews(pdfRegions, pageTexts, itemIdByAnchor)');
    expect(source).toContain("import { attachDocumentMedia, regionPageViews } from './importStock.ts';");
    expect(read(`${SHARED}/importStock.ts`)).toContain('export function regionPageViews(');
  });

  it('records the identity of every matched row, not only the narrowed one', () => {
    /*
     * ABOVE THE `onlyItemId` NARROWING, for the reason the anchor map already
     * answers to: the role decision is made over the whole document, and a
     * per-item settlement that saw only its own row would answer a different
     * question from the import that wrote it.
     */
    const loop = source.slice(source.indexOf('labelByItemId.set(itemId'));
    const narrowing = loop.indexOf('if (input.onlyItemId && itemId !== input.onlyItemId) continue;');
    expect(narrowing).toBeGreaterThan(0);
    expect(loop.slice(0, narrowing)).toContain('designByItemId.set(itemId');
  });
});
