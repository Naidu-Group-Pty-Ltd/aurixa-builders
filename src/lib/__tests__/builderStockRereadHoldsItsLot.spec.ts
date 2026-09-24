/**
 * THE GUARD THAT STOPS A RE-READ FORKING WAS KEYED ON THE FIELD A RE-READ
 * CORRECTS.
 *
 * `stockPropertyIdentity().lot` is a DESIGNATION — `unit_number ?? lot_number`
 * — which is right for matching a property across documents and is the wrong
 * question for a re-read of the same page of the same file.
 *
 * MEASURED 21 SEPTEMBER 2026, on the first source the reader sweep touched.
 * `LOT 48 - EMBER - FLYER.pdf` had imported with `unit_number` read off its
 * floor plan's area schedule — `115.30m 12.41sq` — and the corrected reader
 * declines that value by shape, so the re-read stated no unit at all. Both
 * readings say lot 48, both came off page 1 of the same file, and the bytes
 * had not changed. `identity.lot` went from `115.30m 12.41sq` to `48`, the
 * guard said "different property", every other key missed (the flyer names no
 * estate and carries no reference), and the import INSERTED a second row —
 * `4a0ca961` at 12:47:05 beside `584c8186` from 12:02:32.
 *
 * The correction losing to the document it corrects, and the rows a re-read
 * most needs to fix are exactly the ones whose designation was wrong.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  identityDifferences, ownRowKey, ownRowKeyHasLot, reReadHoldsSameProperty,
  stockPropertyIdentity, suburbsDisagree,
} from '../../../supabase/functions/_shared/builderStock/stockIdentity.pure';

/** The row as it stood, from production. */
const LOT_48_BEFORE = {
  external_reference: null,
  lot_number: '48',
  unit_number: '115.30m 12.41sq',
  development_name: null,
  project_name: null,
  address_line: '35 Cockrell Rd',
  suburb: 'Mernda',
  building_size_sqm: 148,
  house_design: null,
};

/** The same page, read by the corrected reader. */
const LOT_48_AFTER = {
  external_reference: null,
  lot_number: '48',
  unit_number: null,
  development_name: null,
  project_name: null,
  address_line: '35 Cockrell Rd',
  suburb: 'Mernda',
  building_size_sqm: 148,
  house_design: 'Ember',
};

describe('the Lot 48 fork', () => {
  it('is exactly reproduced by the ordinary designation rule', () => {
    // The precondition, stated rather than assumed: this is why it forked.
    const before = stockPropertyIdentity(LOT_48_BEFORE);
    const after = stockPropertyIdentity(LOT_48_AFTER);
    expect(before.lot).toBe('115 30m 12 41sq');
    expect(after.lot).toBe('48');
    expect(identityDifferences(before, after)).toContain('lot');
  });

  it('holds the same property once the lot number is asked directly', () => {
    expect(reReadHoldsSameProperty(LOT_48_BEFORE, LOT_48_AFTER)).toBe(true);
  });

  it('holds in both directions, because a re-read may also ADD a unit', () => {
    expect(reReadHoldsSameProperty(LOT_48_AFTER, LOT_48_BEFORE)).toBe(true);
  });
});

describe('what it still refuses', () => {
  it('refuses a different lot', () => {
    expect(reReadHoldsSameProperty(
      { ...LOT_48_AFTER, lot_number: '48' },
      { ...LOT_48_AFTER, lot_number: '49' },
    )).toBe(false);
  });

  /*
   * A page offering `Lot 48 Unit 1` and `Lot 48 Unit 2` is a dual-key home
   * stating two dwellings. Merging them would destroy one.
   */
  it('refuses two dwellings that both state a unit on one lot', () => {
    expect(reReadHoldsSameProperty(
      { ...LOT_48_AFTER, unit_number: '1' },
      { ...LOT_48_AFTER, unit_number: '2' },
    )).toBe(false);
  });

  it('refuses where neither side states a lot number', () => {
    expect(reReadHoldsSameProperty(
      { ...LOT_48_AFTER, lot_number: null, unit_number: '12A' },
      { ...LOT_48_AFTER, lot_number: null, unit_number: '14B' },
    )).toBe(false);
  });

  /*
   * It may only ever ADMIT a match the ordinary rule refuses. Where the
   * ordinary rule already says yes — a thinner read, an absence on one side —
   * nothing changes.
   */
  it('agrees with the ordinary rule wherever the ordinary rule agrees', () => {
    const thinner = { ...LOT_48_BEFORE, house_design: null, building_size_sqm: null };
    expect(identityDifferences(
      stockPropertyIdentity(LOT_48_BEFORE), stockPropertyIdentity(thinner),
    )).toEqual([]);
    expect(reReadHoldsSameProperty(LOT_48_BEFORE, thinner)).toBe(true);
  });
});

describe('the import asks it, and claims the row once', () => {
  const importStock = readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/importStock.ts'), 'utf8');

  it('guards the own-anchor rung with the re-read question', () => {
    expect(importStock).toMatch(
      /ownLotHolds = Boolean\(ownAnchored\)\s*\n?\s*&& reReadHoldsSameProperty\(ownAnchored!\.fields, record\)/);
  });

  it('no longer decides it from the collapsed identity', () => {
    expect(importStock).not.toMatch(
      /ownLotHolds[\s\S]{0,120}identityDifferences\(ownAnchored/);
  });

  /*
   * The index holds ONE row per anchor, so two records off one page that both
   * reached this rung would both write to it and the second would silently
   * overwrite the first.
   */
  it('claims an own-anchor row at most once per run', () => {
    expect(importStock).toContain('claimedOwnAnchors.add(keys.anchor as string)');
    expect(importStock).toMatch(/!claimedOwnAnchors\.has\(keys\.anchor as string\)/);
  });
});

/**
 * A ROW WITH NO LOT STILL HAS A KEY WITHIN ITS OWN UPLOAD.
 *
 * MEASURED 24 SEPTEMBER 2026 on the acceptance gate: `TOWNHOUSE 3` over
 * `18 Swift Street` — no picture, no estate, no lot — read one property, and a
 * re-read of the same bytes inserted a second. Nothing could find the row: a
 * PDF record is anchored only through a picture, and this key stood on the
 * lot alone.
 */
describe('the key a re-read finds its own row by', () => {
  it('is exactly the lot key it always was wherever a lot is stated', () => {
    expect(ownRowKey({ lot_number: '12' })).toBe('12');
    expect(ownRowKey({ lot_number: 'Lot 12A ', unit_number: '3' })).toBe('lot 12a//3');
    expect(ownRowKey({ lot_number: '12', address_line: '18 Swift Street' })).toBe('12');
    expect(ownRowKeyHasLot('12')).toBe(true);
    expect(ownRowKeyHasLot('12//3')).toBe(true);
  });

  it('keys a unit at its street, and a street alone, where no lot is stated', () => {
    expect(ownRowKey({ unit_number: '3', address_line: '18  Swift Street' })).toBe('//3@18 swift street');
    expect(ownRowKey({ unit_number: '5', address_line: '5/12 Kestrel Street' })).toBe('//5@5/12 kestrel street');
    expect(ownRowKey({ unit_number: '5' })).toBe('//5');
    expect(ownRowKey({ address_line: '12A Kestrel Street' })).toBe('@12a kestrel street');
    expect(ownRowKeyHasLot('//3@18 swift street')).toBe(false);
    expect(ownRowKeyHasLot('@12a kestrel street')).toBe(false);
  });

  it('has nothing to key where the row states no lot, no unit and no street', () => {
    expect(ownRowKey({})).toBeNull();
    expect(ownRowKey({ lot_number: '  ', unit_number: '', address_line: ' ' })).toBeNull();
  });

  it('holds two stated suburbs apart, and never an absent one', () => {
    expect(suburbsDisagree({ suburb: 'Box Hill' }, { suburb: 'Leppington' })).toBe(true);
    expect(suburbsDisagree({ suburb: 'Box  Hill' }, { suburb: 'box hill' })).toBe(false);
    expect(suburbsDisagree({ suburb: null }, { suburb: 'Box Hill' })).toBe(false);
  });

  it('is what the import indexes and looks up by, with the suburb guard where no lot stands', () => {
    const importStock = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/builderStock/importStock.ts'), 'utf8');
    expect(importStock).toContain('const ownLotKey = ownRowKey;');
    expect(importStock).toMatch(
      /ownRowKeyHasLot\(lotKey as string\) \|\| !suburbsDisagree\(ownLotRow!\.fields, record\)/);
  });
});

/**
 * AND A REFUSAL THAT SAYS WHICH KIND IT WAS.
 *
 * "No page states this property's identity together with its package
 * information" is four different findings, and a fifth — too few package
 * facts — wearing one sentence. On `LOT 48 - EMBER - FLYER.pdf` that one
 * sentence was identical before and after the reader was corrected, across
 * two completely different labels, and narrowing it by hand cost a deploy
 * cycle and was still not settled. The rule is this repository's own: a
 * failure says which kind it was.
 *
 * `coverIdentityRefusal` re-states `pageStatesIdentity`'s four tests in order
 * and decides nothing: a page it calls acceptable is one that function
 * accepts, which is what these cases pin.
 */
describe('a cover refusal names the test that refused', () => {
  const PAGE = [
    'HAVENWOOD', 'Lot 48', 'LOT 46, 47, 48, 49,',
    '$810,000', '35 Cockrell Rd,', 'Mernda VIC 3754', 'EMBER 16 MOD 2', '148 m2',
  ].join('\n');

  it('names the other lot a multi-property document may not ignore', async () => {
    const { coverIdentityRefusal } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(coverIdentityRefusal(PAGE, 'Lot 48, 35 Cockrell Rd, Mernda', [], false))
      .toBe('the page states another lot');
  });

  it('says nothing where a sole-property document waives it', async () => {
    const { coverIdentityRefusal } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(coverIdentityRefusal(PAGE, 'Lot 48, 35 Cockrell Rd, Mernda', [], true))
      .toBeNull();
  });

  it('names a lot the page never states', async () => {
    const { coverIdentityRefusal } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(coverIdentityRefusal(PAGE, 'Lot 91, 35 Cockrell Rd, Mernda', [], true))
      .toBe('the page does not state this lot');
  });

  it('names an absent corroboration', async () => {
    const { coverIdentityRefusal } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    expect(coverIdentityRefusal(PAGE, 'Lot 48, 9 Nowhere Street, Elsewhere', [], true))
      .toBe('nothing on the page corroborates the lot');
  });

  /*
   * It may never disagree with the function it describes. `findPropertyCoverPages`
   * is the authority; this only says why it answered as it did.
   */
  it('agrees with the election it explains', async () => {
    const { coverIdentityRefusal, findPropertyCoverPages } = await import(
      '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure');
    for (const sole of [false, true]) {
      for (const label of [
        'Lot 48, 35 Cockrell Rd, Mernda', 'Lot 91, 35 Cockrell Rd, Mernda',
        'Lot 48, 9 Nowhere Street, Elsewhere', 'Lot 48',
      ]) {
        const accepted = coverIdentityRefusal(PAGE, label, [], sole) === null;
        const elected = findPropertyCoverPages([PAGE], label, [], sole).length > 0;
        // A page it accepts either elects, or fails only on package facts.
        expect(elected ? accepted : true).toBe(true);
      }
    }
  });
});
