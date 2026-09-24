/**
 * WHEN A BUILDER MAY CONFIRM A BROCHURE, AND WHEN THE PRODUCT MUST SAY NO.
 *
 * The confirmation exists for one real case and must refuse its look-alike.
 * Both were measured in production on 24 September 2026, in one stock list:
 *
 *   Lot 1037 · Vanta 20 links its OWN brochure. Page 2 states "Lot 1037" and
 *   "Vanta 20"; the cover mistypes the lot as "Lot 1307". Confirming it puts
 *   this property's own photograph on this property's card.
 *
 *   Lot 1447 · Nex 20 links the SAME FILE as Lot 1744 · Cura 20B, and Lot 1744
 *   already shows that brochure's photograph. The cover states "Lot 1744". The
 *   digits are transposed there too — and confirming it would put Lot 1744's
 *   Cura 20B render on a Nex 20 listing: the same picture on two cards, of a
 *   different house.
 *
 * So a transposition is a HINT for the builder and never evidence for the
 * product, and the one fact that settles the second case is checked before
 * the choice is offered: another property in the same stock list is already
 * using that brochure's photograph for the lot the brochure states.
 *
 * Every row below is invented; the shapes are production's.
 */
import { describe, expect, it } from 'vitest';

import {
  brochureInUseByAnotherProperty, confirmedLotOf, isConfirmableBranch, listingIdentity,
  lotsShareDigits, statedLotListing,
} from '../../../supabase/functions/_shared/builderStock/brochureConfirmation.pure';

describe('the lot a finding states, read for a confirmation', () => {
  it('reads the digits of the designation the election recorded', () => {
    expect(confirmedLotOf('Lot 2064')).toBe('2064');
    expect(confirmedLotOf('Lot 7')).toBe('7');
    expect(confirmedLotOf('  Lot 2064 ')).toBe('2064');
  });

  it('reads nothing it could not have written', () => {
    for (const states of ['', 'Lot', 'Lot 123456', 'Lot 20a4', 'Unit 5 Lot 6', '2064', null, 42, {}]) {
      expect(confirmedLotOf(states), JSON.stringify(states)).toBeNull();
    }
  });
});

describe('the transposition hint', () => {
  it('recognises the same digits in a different order', () => {
    expect(lotsShareDigits('2046', '2064')).toBe(true);
    expect(lotsShareDigits('1447', '1744')).toBe(true);
    expect(lotsShareDigits('1037', '1307')).toBe(true);
    expect(lotsShareDigits('12', '21')).toBe(true);
  });

  it('is silent where it would say nothing true', () => {
    expect(lotsShareDigits('2046', '2046')).toBe(false);
    expect(lotsShareDigits('2046', '2047')).toBe(false);
    expect(lotsShareDigits('2046', '20461')).toBe(false);
    expect(lotsShareDigits('7', '7')).toBe(false);
    expect(lotsShareDigits('', '')).toBe(false);
    expect(lotsShareDigits(null, '2064')).toBe(false);
  });
});

describe('which links a builder may confirm', () => {
  it('a link to ONE document on a row', () => {
    expect(isConfirmableBranch('https://drive.google.com/file/d/1Qx7brochureLot2046aB/view?usp=drive_link')).toBe(true);
    expect(isConfirmableBranch('https://www.dropbox.com/scl/fi/xyz/Lot-2046.pdf?rlkey=k&dl=0')).toBe(true);
  });

  it('never a folder, whose document is chosen by the lot the listing states', () => {
    expect(isConfirmableBranch('https://drive.google.com/drive/folders/1Fo1derOfLotBrochures9')).toBe(false);
  });

  it('never a picture or anything unreadable', () => {
    expect(isConfirmableBranch('https://example.com/facade.jpg')).toBe(false);
    expect(isConfirmableBranch('not a url')).toBe(false);
    expect(isConfirmableBranch('')).toBe(false);
  });
});

describe('a listing names itself by its lot and its design', () => {
  it('as the builder\'s own screen does', () => {
    expect(listingIdentity({ lot_number: '3185', house_design: 'Halo 24' })).toBe('Lot 3185 · Halo 24');
    expect(listingIdentity({ lot_number: '3185', house_design: null })).toBe('Lot 3185');
    expect(listingIdentity({ unit_number: '4', lot_number: null, house_design: 'Halo 24' }))
      .toBe('Unit 4 · Halo 24');
    expect(listingIdentity({ lot_number: null, house_design: null })).toBe('');
  });
});

// ---------------------------------------------------------------------------

const DOC = 'https://drive.google.com/file/d/brochure-3185/view?usp=drive_link';
const SAME_DOC_OTHER_LINK = 'https://drive.google.com/file/d/brochure-3185/view?usp=sharing';
const recovered = { result: 'image_recovered', provenance_version: 27, stored_reference: 'x' };
const refused = { result: 'no_deterministic_image', exhaustion: 'inspected', provenance_version: 27 };

const row = (over: Record<string, unknown>) => ({
  id: 'other',
  lot_number: '3185',
  unit_number: null,
  house_design: 'Halo 24',
  lifecycle_status: 'active',
  suburb: 'Wattlebank',
  development_name: 'Kestrel Rise',
  source_provenance_result: { branches: { [DOC]: recovered } },
  ...over,
});
const ASK = { stockItemId: 'mine', documentReference: DOC, statedLot: '3185' };

describe('a brochure another property already uses cannot be confirmed onto this one', () => {
  it('names the property whose lot the brochure states and whose photograph it already is', () => {
    expect(brochureInUseByAnotherProperty([row({})], ASK))
      .toEqual({ stock_item_id: 'other', identity: 'Lot 3185 · Halo 24' });
  });

  it('recognises the same Drive file behind a different share link', () => {
    const other = row({ source_provenance_result: { branches: { [SAME_DOC_OTHER_LINK]: recovered } } });
    expect(brochureInUseByAnotherProperty([other], ASK)?.stock_item_id).toBe('other');
  });

  it('is not about this property itself', () => {
    expect(brochureInUseByAnotherProperty([row({ id: 'mine' })], ASK)).toBeNull();
  });

  it('is not about a property the brochure does not name', () => {
    // Another lot uses the same file: a many-lot document, not this lot's brochure.
    expect(brochureInUseByAnotherProperty([row({ lot_number: '3186' })], ASK)).toBeNull();
  });

  it('is not about a property that did not take its photograph from it', () => {
    const read = row({ source_provenance_result: { branches: { [DOC]: refused } } });
    expect(brochureInUseByAnotherProperty([read], ASK)).toBeNull();
    const elsewhere = row({
      source_provenance_result: {
        branches: { 'https://drive.google.com/file/d/another/view': recovered },
      },
    });
    expect(brochureInUseByAnotherProperty([elsewhere], ASK)).toBeNull();
  });

  it('is not about a property that is no longer listed', () => {
    expect(brochureInUseByAnotherProperty([row({ lifecycle_status: 'archived' })], ASK)).toBeNull();
  });

  it('reads whatever shape the column holds without throwing', () => {
    for (const stored of [null, {}, { branches: null }, { branches: [] }, 'x']) {
      expect(brochureInUseByAnotherProperty([row({ source_provenance_result: stored })], ASK))
        .toBeNull();
    }
  });
});

describe('a listing with the lot the brochure states is a caution, not a refusal', () => {
  const MINE = { stockItemId: 'mine', statedLot: '3185', suburb: 'Wattlebank', developmentName: 'Kestrel Rise' };

  it('names it where it is in the same estate or suburb', () => {
    expect(statedLotListing([row({ source_provenance_result: null })], MINE))
      .toEqual({ stock_item_id: 'other', identity: 'Lot 3185 · Halo 24' });
    expect(statedLotListing([row({ suburb: 'Elsewhere' })], MINE)?.stock_item_id).toBe('other');
    expect(statedLotListing([row({ development_name: 'Other Estate' })], MINE)?.stock_item_id)
      .toBe('other');
  });

  it('says nothing about a lot of the same number somewhere else', () => {
    expect(statedLotListing([row({ suburb: 'Elsewhere', development_name: 'Other Estate' })], MINE))
      .toBeNull();
  });

  it('says nothing about this property, another lot, or an archived one', () => {
    expect(statedLotListing([row({ id: 'mine' })], MINE)).toBeNull();
    expect(statedLotListing([row({ lot_number: '3186' })], MINE)).toBeNull();
    expect(statedLotListing([row({ lifecycle_status: 'archived' })], MINE)).toBeNull();
  });
});
