/**
 * A COLUMN THAT SAYS MASTERPLAN MAY NOT SUPPLY A CARD'S PHOTOGRAPH.
 *
 * WHAT THIS PINS, and why each piece needs pinning:
 *
 *   THE VOCABULARY, TOKEN BY TOKEN. Three of the four production headings
 *   carry two or three collateral words each — `Siting / Masterplan URL` says
 *   both siting and masterplan — so a test that names the real headings
 *   proves only that SOMETHING matched. Deleting `siting` from the rule was
 *   measured to change no verdict such a test makes. Every token this rule
 *   ADDS therefore gets a heading only that token catches.
 *
 *   BOTH DISPLAY GATES. The server's `primaryImage.ts` and the client mirror
 *   in `src/lib/builderStock.ts` decide which picture leads a card, and this
 *   repository has already shipped them disagreeing once.
 *
 *   `classifyPrimaryImageStanding`, which is a DIFFERENT question from
 *   displayability and the one the repair loop skips a property on. If a
 *   masterplan still counts as `ready` there, the thirteen estate-led
 *   properties stay settled for ever while the gate refuses to draw them —
 *   a blank card nothing ever goes and fixes.
 *
 *   THAT THERE IS NO SECOND COPY OF THE RULE. The reprocess that sends the
 *   affected properties back for their brochure IMPORTS this module rather
 *   than restating it in SQL — the first attempt was a migration carrying the
 *   vocabulary again, and two copies is how two copies drift. A migration was
 *   also the wrong vehicle for a different reason worth keeping written down:
 *   the deploy lane applies migrations BEFORE it ships the functions, so a
 *   reprocess migration resets those rows while the OLD code is still live,
 *   and the old repair — which still counts a masterplan as a ready image —
 *   re-settles every one of them before the rule arrives.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLATERAL_COLUMN_TOKENS, columnCollateralRefusal, columnMaySupplyPrimaryImage,
  readColumnDeclaration, storedColumnMaySupplyPrimaryImage,
} from '../../../supabase/functions/_shared/builderStock/columnDeclaration.pure';
import {
  classifyPrimaryImageStanding,
  isDisplayableSourceImage as serverIsDisplayable,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { isDisplayableSourceImage as clientIsDisplayable } from '../builderStock';

const repoRoot = join(__dirname, '../../..');
const DRIVE_PACKAGE = join(repoRoot, 'supabase/functions/_shared/builderStock',
  'drivePackage.pure.ts');
const REPROCESS = join(repoRoot, 'scripts/ops/stock-collateral-reprocess.ts');

/** A stored image that passes every OTHER condition, filed under `column`. */
const imageFiledUnder = (column: string | null | undefined) => ({
  id: 'img-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  storage_path: 'o/1.jpg',
  storage_bucket: 'builder-stock-images',
  external_url: null,
  position: 0,
  source_detail: {
    role: 'primary_property',
    role_evidence_level: 1,
    provenance_version: 26,
    marketplace_display_eligible: true,
    marketplace_eligibility_state: 'eligible',
    ...(column === undefined ? {} : { source_column: column }),
  },
});

describe('what a stock list column heading declares', () => {
  it('reads three answers, because absent and undeclared are different facts', () => {
    expect(readColumnDeclaration('Siting / Masterplan URL')).toBe('collateral');
    expect(readColumnDeclaration('Brochure URL')).toBe('undeclared');
    expect(readColumnDeclaration(null)).toBe('absent');
    expect(readColumnDeclaration(undefined)).toBe('absent');
    expect(readColumnDeclaration('   ')).toBe('absent');
  });

  it('fails closed on a heading that is present and unreadable', () => {
    // Somebody wrote SOMETHING here and this cannot say what. The dangerous
    // direction is admitting a masterplan as a house.
    expect(readColumnDeclaration('///')).toBe('collateral');
    expect(readColumnDeclaration('—')).toBe('collateral');
    expect(readColumnDeclaration(42 as unknown)).toBe('collateral');
    expect(readColumnDeclaration({} as unknown)).toBe('collateral');
  });

  it('treats an ABSENT heading as permitted, which is a decision and not a gap', () => {
    // `source_column` is written only by the branch recovery, so an image
    // with none did not come from a column at all — it is an embedded asset
    // or a picture a builder uploaded by hand. Refusing those would empty
    // the cards this rule exists to protect.
    expect(columnMaySupplyPrimaryImage(null)).toBe(true);
    expect(storedColumnMaySupplyPrimaryImage({ role: 'primary_property' })).toBe(true);
    expect(storedColumnMaySupplyPrimaryImage(null)).toBe(true);
    expect(storedColumnMaySupplyPrimaryImage(undefined)).toBe(true);
  });

  /*
   * ONE HEADING PER TOKEN THIS RULE ADDS, each isolating exactly one, because
   * the production headings overlap and a test built on them survives the
   * deletion of any single word.
   */
  it.each([
    ['estate', 'Estate Overview'],
    ['siting', 'Siting Diagram'],
    ['location', 'Location Guide'],
    ['plan', 'Plan Set'],
  ])('refuses on `%s` alone — heading %j', (_token, heading) => {
    expect(readColumnDeclaration(heading)).toBe('collateral');
  });

  it('refuses every heading the live list actually carries', () => {
    for (const heading of [
      'Siting / Masterplan URL',
      'Estate Brochure / Location Map URL',
      'Stage Plan / PlanOfSub URL',
      // and the spellings a builder reaches for instead
      'Plan of Subdivision', 'Lot Plans', 'Site Plan', 'Aerial Shot', 'Masterplan',
    ]) {
      expect(readColumnDeclaration(heading)).toBe('collateral');
    }
  });

  it('admits the headings the marketplace is actually built on', () => {
    for (const heading of [
      'Brochure URL', 'Brochure V002', 'Facade Photo', 'Property Images',
      'Photos', 'Image URL', 'Render', 'House Photo',
    ]) {
      expect(readColumnDeclaration(heading)).toBe('undeclared');
    }
  });

  it('names the heading in its refusal, and calls it a finding rather than a fault', () => {
    const sentence = columnCollateralRefusal('Siting / Masterplan URL');
    expect(sentence).toContain('Siting / Masterplan URL');
    expect(sentence).toMatch(/declares it to be/i);
    expect(sentence).not.toMatch(/error|failed|could not/i);
  });
});

describe('the gates that decide which picture leads a card', () => {
  it('the server refuses a picture filed under a collateral column', () => {
    expect(serverIsDisplayable(imageFiledUnder('Brochure URL'))).toBe(true);
    expect(serverIsDisplayable(imageFiledUnder('Siting / Masterplan URL'))).toBe(false);
    expect(serverIsDisplayable(imageFiledUnder('Estate Brochure / Location Map URL'))).toBe(false);
    expect(serverIsDisplayable(imageFiledUnder('Stage Plan / PlanOfSub URL'))).toBe(false);
  });

  it('the client mirror answers identically, on every heading', () => {
    for (const heading of [
      'Brochure URL', 'Siting / Masterplan URL', 'Estate Brochure / Location Map URL',
      'Stage Plan / PlanOfSub URL', 'Facade Photo', '///',
    ]) {
      const image = imageFiledUnder(heading);
      expect([heading, clientIsDisplayable(image as never)])
        .toEqual([heading, serverIsDisplayable(image)]);
    }
    // And an image that never came from a column at all is admitted by both.
    const uploaded = imageFiledUnder(undefined);
    expect(clientIsDisplayable(uploaded as never)).toBe(true);
    expect(serverIsDisplayable(uploaded)).toBe(true);
  });

  it('a collateral picture is not `ready` either, or nothing ever re-reads the brochure', () => {
    // THE ONE THAT KEEPS THE REPAIR HONEST. `ready` is what the source repair
    // skips a property on. If a masterplan counted here, the display gate
    // would refuse to draw it and nothing would ever go and find better.
    expect(classifyPrimaryImageStanding([imageFiledUnder('Brochure URL')], 26).ready).toBe(true);
    expect(classifyPrimaryImageStanding(
      [imageFiledUnder('Siting / Masterplan URL')], 26).ready).toBe(false);
    // A property holding both is ready on the brochure, and the collateral
    // row neither adds nor takes anything away.
    expect(classifyPrimaryImageStanding(
      [imageFiledUnder('Siting / Masterplan URL'), imageFiledUnder('Brochure URL')],
      26).ready).toBe(true);
  });
});

describe('the reprocess that sends the affected properties back', () => {
  const source = () => readFileSync(REPROCESS, 'utf8');

  it('imports the rule rather than restating it', () => {
    // The first attempt was a migration carrying the vocabulary again in SQL.
    // One rule, one implementation: what this reprocesses and what the
    // marketplace refuses cannot become two standards.
    expect(source()).toMatch(/from '\.\.\/\.\.\/supabase\/functions\/_shared\/builderStock\/columnDeclaration\.pure\.ts'/);
    expect(source()).toMatch(/columnMaySupplyPrimaryImage/);
    // And it must not have grown its own copy of the vocabulary.
    for (const token of ['siting', 'masterplan', 'planofsub', 'subdivision']) {
      expect(source().toLowerCase().split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')
          && !line.trim().startsWith('/*'))
        .join('\n'))
        .not.toMatch(new RegExp(`'[^']*${token}[^']*'`, 'i'));
    }
  });

  it('resets the work state and writes nothing else', () => {
    const sql = source();
    expect(sql).toMatch(/image_work_stage\s*=\s*'source'/);
    // The picture is the audit trail of what was shown. Deleting evidence to
    // change a screen is not a repair.
    expect(sql).not.toMatch(/delete\s+from/i);
    // And nothing may leave the marketplace to fix a card.
    const setClauses = [...sql.matchAll(/\bset\b([\s\S]*?)\n\s*where\b/gi)]
      .map((match) => match[1]);
    expect(setClauses.length).toBeGreaterThan(0);
    for (const clause of setClauses) {
      expect(clause).not.toMatch(/lifecycle_status\s*=/i);
      expect(clause).not.toMatch(/primary_image_id\s*=/i);
      expect(clause).not.toMatch(/source_provenance_result\s*=/i);
    }
  });

  it('is a dry run until somebody says otherwise', () => {
    expect(source()).toMatch(/--apply/);
    expect(source()).toMatch(/DRY RUN/);
  });
});
