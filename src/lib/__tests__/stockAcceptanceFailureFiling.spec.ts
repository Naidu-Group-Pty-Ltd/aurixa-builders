/**
 * THE ACCEPTANCE GATE'S OWN RULES — pinned, because a gate that cannot fail
 * is a gate nobody can see is broken.
 *
 * THE DEFECTS THESE PIN, found 25 September 2026 while validating #108.
 *
 * 1. A named limit absorbed everything. `fail()` filed every failure of a
 *    fixture carrying a `known_limit` as a named limit, so thirteen of the
 *    corpus's seventy-nine documents could not fail the gate at all — among
 *    them the fixture that proves two organisations' identical lots stay
 *    apart, and the three whose whole subject is a forbid check. The
 *    harness's own comment said the opposite ("a fixture that starts
 *    producing a wrong value fails whatever is written here"), and
 *    `docs/builder-portal/52` §18 had already watched two fixtures produce 0
 *    properties behind their named limits.
 *
 * 2. A forbidden word was looked for in the whole record's JSON, timestamps
 *    and ids included, so the footer's `1300` was found in a `created_at` of
 *    `…16.413007…` and the gate's named limits went from 15 to 16 on the
 *    wall clock.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileFailure,
  forbiddenWordText,
  staleLimits,
} from '../../../scripts/stock-acceptance/failureFiling.pure';

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

const LIMITED = {
  known_limit: 'the synthetic facade at this seed carries the largest flat region',
  limit_covers: ['photograph', '2.house_design'],
};

describe('what a named limit may absorb', () => {
  it('a wrong value, a leak or a broken transport fails the gate whatever the fixture declares', () => {
    expect(fileFailure(LIMITED)).toBe('fails');
    expect(fileFailure(LIMITED, null)).toBe('fails');
  });

  it('a shortfall the limit names is reported, and never fails the gate', () => {
    expect(fileFailure(LIMITED, 'photograph')).toBe('limits');
    expect(fileFailure(LIMITED, '2.house_design')).toBe('limits');
  });

  it('a shortfall the limit does not name fails: a limit hides nothing it did not declare', () => {
    expect(fileFailure(LIMITED, '0.price')).toBe('fails');
    expect(fileFailure(LIMITED, '0.house_design')).toBe('fails');
    // A label with nothing declared under it is a note, and absorbs nothing.
    expect(fileFailure({ known_limit: 'this release sheet carries no photograph at all' },
      'photograph')).toBe('fails');
    expect(fileFailure({ known_limit: 'x', limit_covers: [] }, 'photograph')).toBe('fails');
  });

  it('a fixture with no named limit fails on everything', () => {
    expect(fileFailure({}, 'photograph')).toBe('fails');
    expect(fileFailure({ limit_covers: ['photograph'] }, 'photograph')).toBe('fails');
  });

  it('a declared shortfall that no longer falls short is named, so the limit is removed', () => {
    expect(staleLimits(LIMITED, new Set(['photograph']))).toEqual(['2.house_design']);
    expect(staleLimits(LIMITED, new Set(['photograph', '2.house_design']))).toEqual([]);
    expect(staleLimits({}, new Set())).toEqual([]);
  });
});

describe('where a forbidden word is looked for', () => {
  /*
   * The record the gate read on 25 September 2026, trimmed to the columns that
   * matter here: `heldout-shared-footer`'s second property, whose `created_at`
   * put `1300` in the gate's report. Every id in it is the acceptance
   * database's own, and the property is the corpus's invented DUNMORE GREEN.
   */
  const RECORD = {
    id: 'a9e9ceec-a584-4f5a-bf99-6a559bc5c7e7',
    organisation_id: '21a58527-cae7-411a-8143-f4a06e2e40be',
    upload_id: 'a8510a5d-48d9-4ac7-8840-9bc32c6a1e76',
    lot_number: '2204',
    land_size_sqm: 364,
    building_size_sqm: 209,
    price: 733000,
    enriched_at: '2026-09-25T02:21:16.992+00:00',
    source_row: { price: 733000, lot_number: '2204', house_design: 'Juniper 21', unmapped: {} },
    created_at: '2026-09-25T02:21:16.413007+00:00',
    updated_at: '2026-09-25T02:21:17.008212+00:00',
  };

  it('is not found in what the product minted: ids and timestamps', () => {
    const text = forbiddenWordText(RECORD);
    for (const word of ['DUNMORE PTY', 'ACN', '1300']) expect(text).not.toContain(word);
    expect(forbiddenWordText({ ...RECORD, id: 'a1300b2c-0000-4000-8000-000000000000' }))
      .not.toContain('1300');
  });

  it('is not found in a column name', () => {
    expect(forbiddenWordText({ lot_number: '2204' })).not.toContain('LOT');
  });

  it('is found wherever a document could have put it', () => {
    expect(forbiddenWordText({ ...RECORD, price: 1300555140 })).toContain('1300');
    expect(forbiddenWordText({ ...RECORD, description: 'Dunmore Pty Ltd' })).toContain('DUNMORE PTY');
    expect(forbiddenWordText({
      ...RECORD,
      source_row: { ...RECORD.source_row, unmapped: { Enquiries: 'Sales enquiries 1300 555 140' } },
    })).toContain('1300');
    expect(forbiddenWordText({ ...RECORD, image_urls: ['ACN 000 111 222'] })).toContain('ACN');
    // A date a document states is not a timestamp the product minted.
    expect(forbiddenWordText({ expected_completion: '2027-03-01' })).toContain('2027-03-01');
  });
});

describe('the harness files through these rules', () => {
  const harness = read('scripts/stock-acceptance/harness.ts');

  it('decides every failure with fileFailure, and names a shortfall in exactly two places', () => {
    expect(harness).toContain("from './failureFiling.pure.ts'");
    expect(harness).toMatch(/fileFailure\(entry\.expect, shortfall\)/);
    // A row's field left absent, and a card with no photograph. A third place
    // is a decision about what a named limit may hide, made here, in review.
    expect(harness.match(/\bfallShort\(entry,/g)).toHaveLength(2);
    expect(harness).toContain("fallShort(entry, `${i}.${key}`, said)");
    expect(harness).toContain("fallShort(entry, 'photograph',");
    expect(harness).toMatch(/staleLimits\(entry\.expect,/);
  });

  it('never looks for a forbidden word in the record as JSON', () => {
    expect(harness).toContain('forbiddenWordText(it)');
    expect(harness).not.toMatch(/JSON\.stringify\(it\)\.toUpperCase\(\)/);
  });
});

describe('the corpus declares what each named limit covers', () => {
  const corpus = read('scripts/stock-acceptance/make-corpus.py');

  it('every known_limit states its limit_covers, even when that is nothing', () => {
    const limits = corpus.match(/^\s*known_limit='/gm) ?? [];
    const covers = corpus.match(/^\s*limit_covers=\[/gm) ?? [];
    expect(limits.length).toBe(13);
    expect(covers.length).toBe(limits.length);
  });
});
