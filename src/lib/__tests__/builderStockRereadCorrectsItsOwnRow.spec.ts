/**
 * `pdf:page1` IS NOT A PROPERTY.
 *
 * A brochure carries one property, so every single-property PDF this
 * deployment has imported anchors at `pdf:page1` — measured across all six
 * live rows, every one of them. The anchor index is organisation-wide, so
 * those six collapse onto ONE entry and "newest active row wins" hands a
 * re-read of Lot 27 the row for Lot 266. The identity guard then correctly
 * refuses to carry anything forward, and the import inserts a fresh row
 * instead of correcting the one the builder is looking at.
 *
 * MEASURED 21 SEPTEMBER 2026. Read again on `LOT 324 - NEX 20` reported
 * `imported: 1, updated: 0` and produced a SECOND row — carrying the
 * corrected `Watsons Reach Estate` and a land size of 371 — staged, where
 * nobody can see it, beside the original still serving `(Watsons Reach
 * Estate)` and no land size at all. From the outside that is a button that
 * does nothing. Lot 266 escaped it only by being the newest active row at
 * the moment it was re-read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const importStock = read('supabase/functions/_shared/builderStock/importStock.ts');
const repair = read(
  'supabase/migrations/20260921113000_a_reread_must_correct_its_own_row_not_fork_it.sql');

describe('an anchor identifies a row WITHIN a document', () => {
  it('indexes this upload\'s own rows separately', () => {
    expect(importStock).toContain('const byOwnAnchor = new Map<string, OwnAnchoredProperty>()');
    expect(importStock).toContain('if (item.upload_id === input.uploadId) {');
  });

  it('prefers an ACTIVE row over a staged fork of itself', () => {
    // Where this bug has already forked a property, the active row is the one
    // the marketplace is serving and the one holding its photograph.
    expect(importStock).toMatch(
      /item\.lifecycle_status === 'active' && held\.lifecycle !== 'active'/);
  });

  it('consults it BEFORE the organisation-wide anchor', () => {
    const own = importStock.indexOf('ownAnchored && ownLotHolds ? ownAnchored.id : undefined');
    const wide = importStock.indexOf('anchored && !anchorDifferences.length ? anchored.id');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(wide);
  });

  it('guards it on the LOT alone, and still guards it', () => {
    /*
     * The five-part guard asks whether a source row may have been RE-USED for
     * a different property — a statement about a CHANGED document. Here the
     * bytes are identical and only the reader has changed, so a development
     * that gained a name or a design that arrived from the filename are the
     * corrections being delivered, not evidence of a different property. The
     * lot is the identifier and it still has to hold.
     */
    expect(importStock).toMatch(
      /identityDifferences\(ownAnchored!\.identity, identity\)\.includes\('lot'\)/);
  });

  it('leaves every other key exactly where it was', () => {
    // Nothing here replaces the organisation-wide anchor, the reference or
    // the development-unit key; it is consulted first and falls through.
    expect(importStock).toContain('byReference.get(keys.reference)');
    expect(importStock).toContain('byDevelopmentUnit.get(developmentUnitMatchKey(');
    expect(importStock).toContain('anchored && !anchorDifferences.length ? anchored.id');
  });

  it('never reports a re-read of our own row as a replacement', () => {
    // It reported "the development, the lot and the house design changed" on
    // a builder's own summary, about a row that had not moved.
    expect(importStock).toMatch(
      /if \(anchored && anchorDifferences\.length && !\(ownAnchored && ownLotHolds\)\)/);
  });
});

describe('the rows already forked are repaired, not deleted', () => {
  it('matches a fork on its upload, its anchor AND its lot', () => {
    expect(repair).toContain('a.upload_id = f.upload_id');
    expect(repair).toContain("a.source_row->>'source_anchor'");
    expect(repair).toContain('lower(trim(a.lot_number))');
    expect(repair).toContain('a.created_at < f.created_at');
  });

  it('carries only what a parser owns, and only where the fork states it', () => {
    // `coalesce(fork, active)`: a fork that read LESS than the row it
    // duplicates must not blank a good value — the opposite failure, and the
    // one this whole day has been about.
    for (const column of ['development_name', 'land_size_sqm', 'building_size_sqm',
      'price', 'expected_completion', 'bedrooms']) {
      expect(repair).toContain(`coalesce(f.${column}, a.${column})`);
    }
  });

  it('never copies an identity column', () => {
    for (const column of ['lot_number', 'unit_number', 'external_reference']) {
      expect(repair).not.toContain(`coalesce(f.${column}, a.${column})`);
    }
  });

  it('archives the fork rather than deleting it', () => {
    expect(repair).toContain("SET lifecycle_status = 'archived'");
    expect(repair).not.toMatch(/\bDELETE\b/);
  });

  it('keeps the serving row\'s id, so its photograph stays with it', () => {
    // The same reason the importer patches a row rather than replacing it.
    expect(repair).toContain('WHERE a.id = fork.active_id');
  });
});
