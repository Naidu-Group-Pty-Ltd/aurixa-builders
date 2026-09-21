/**
 * A PICTURE THE DOCUMENT SUPPLIED IS NOT "NO SOURCE AT ALL".
 *
 * A branch is a URL found ON the row, so a property whose photograph came out
 * of the PDF its builder uploaded names no branch — and `readSuppliedEvidence`
 * therefore answered `no_evidence`, "this row names no source this pipeline
 * can open", about a row holding a stored, attributed, `primary_property`
 * image of its own house. Under the invariant that answer is TERMINAL: the
 * property is stamped `failed`, a person is paged, and the eligibility and
 * sanitization stages that decide whether the picture may be shown never run.
 *
 * MEASURED 21 SEPTEMBER 2026 on `LOT 48 - EMBER - FLYER.pdf`. The cover
 * election had designated the flyer's own facade render — `role:
 * primary_property`, evidence level 2, "visible page 1 states 'Lot 48, 35
 * Cockrell Rd, Mernda' with a package price, a land or build size and
 * presents one prominent property image with them" — and the display gate
 * answered `overlay_uncertain` over one faint text line at 4.5% of the
 * height. That is `pending`, not a refusal; the overlay repair exists for
 * exactly it. The source stage read zero branches, declared no evidence, and
 * stamped the property `failed` before the repair could run. Card blank,
 * upload unpublished, and the picture sitting in the bucket the whole time.
 *
 * Every builder whose render carries a line of fine print lands here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeSuppliedEvidence, fallbackMayRun, readSuppliedEvidence,
} from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';

const base = {
  branches: [] as never[],
  stored: null,
  provenanceVersion: 26,
  sourceAnchor: 'pdf:page1',
};

describe('a row whose own document supplied the picture', () => {
  it('reads as held, never as no evidence', () => {
    const reading = readSuppliedEvidence({ ...base, heldSourceImages: 1 });
    expect(reading.state).toBe('held');
    expect(describeSuppliedEvidence(reading)).not.toContain('no source');
  });

  /*
   * `found` means DISPLAYABLE. That distinction was paid for on 2026-09-15,
   * measured live within the hour the invariant shipped: a ready row the
   * classifier had refused read as "the builder's picture is on this card"
   * and settled six properties with NULL primaries while their brochures went
   * unread. A held picture has not been cleared and must not claim to be.
   */
  it('is not found, because found means displayable', () => {
    expect(readSuppliedEvidence({ ...base, heldSourceImages: 1 }).state)
      .not.toBe('found');
  });

  it('still answers found once the picture is servable', () => {
    expect(readSuppliedEvidence({
      ...base, heldSourceImages: 1, builderImageAccepted: true,
    }).state).toBe('found');
  });

  /*
   * #2305's rule, verbatim: the paid ladder may not be bought against a card
   * that is about to receive the builder's own photograph.
   */
  it('never lets the fallback ladder run against it', () => {
    expect(fallbackMayRun('held')).toBe(false);
  });

  it('still says no evidence where the row holds nothing at all', () => {
    expect(readSuppliedEvidence({ ...base, heldSourceImages: 0 }).state)
      .toBe('no_evidence');
    expect(readSuppliedEvidence(base).state).toBe('no_evidence');
  });

  /*
   * Asked only where the row names NO branch, so no row that names a source
   * changes its reading by a single field.
   */
  it('changes nothing for a row that names a source', () => {
    const withBranch = {
      ...base,
      branches: [{ url: 'https://example.test/a.pdf', column: 'Brochure' }] as any,
    };
    expect(readSuppliedEvidence({ ...withBranch, heldSourceImages: 3 }))
      .toEqual(readSuppliedEvidence(withBranch));
  });
});

describe('the settler counts and routes it', () => {
  const settler = readFileSync(join(process.cwd(),
    'supabase/functions/_shared/builderStock/settleItemImages.ts'), 'utf8');

  /*
   * A stored floor plan is not a card image and never becomes one, so
   * counting it would hide a property that genuinely needs a person — which
   * is what `no_evidence` is for.
   */
  it('counts only a designated picture that is not servable yet', () => {
    expect(settler).toMatch(
      /isPrimaryRole\(readStoredRole\(row\?\.source_detail\)\)\s*\n?\s*&& !servableStoredImage\(row\)/);
  });

  /*
   * The source stage discovered the picture; `eligibility` judges it and
   * `sanitization` repairs an `overlay_uncertain`. So it advances the ladder
   * rather than looping back to `source` or dropping to `failed`.
   */
  it('advances the ladder rather than looping or failing', () => {
    expect(settler).toMatch(
      /evidence\.state === 'held'[\s\S]{0,900}settlement\.nextStage = NEXT_STAGE\[stage\]/);
    expect(settler).not.toMatch(
      /evidence\.state === 'held'[\s\S]{0,900}settlement\.failed = true/);
  });
});
