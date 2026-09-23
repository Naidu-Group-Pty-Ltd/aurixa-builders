/**
 * WHERE A BUILDER SAYS A PROPERTY IS.
 *
 * `Lot 101 - PICO - BROCHURE v002.pdf` names its lot and its estate and no
 * street, suburb, state or postcode, so no marketplace could place it. The
 * builder states the address in the card's "Complete the schedule", beside
 * their figures, and this holds the five things that make that real:
 *
 *   1. what is accepted — one set of rules, the same as the columns';
 *   2. the overlay — the builder's part replaces the document's, and the
 *      document's reading is kept beside it;
 *   3. the ORDER of the two overlays, because the figures' one rewrites
 *      `manual_stats` and would erase the address from the builder's own card;
 *   4. the save — a request that does not mention the address keeps it;
 *   5. the migration — the constraint admits the four parts and still refuses
 *      everything else, and the composer changes in exactly two places.
 *
 * `scripts/ops/probe-stated-location-payload.mjs` puts the same questions to
 * the real constraint and the real composer in the acceptance database.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STATED_LOCATION_FIELDS, STATED_LOCATION_SPECS, STATED_STATES,
  applyStatedLocation, parseStatedLocation, readStatedLocation, statedLocationFields,
} from '../../../supabase/functions/_shared/builderStock/statedLocation.pure';
import {
  applyManualStats, applyManualStatsToAll,
} from '../../../supabase/functions/_shared/builderStock/manualStats.pure';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('what a builder may state', () => {
  it('accepts an address and stores it the way the columns spell it', () => {
    const { location, errors } = parseStatedLocation({
      address_line: '  Lot 101   Sample Crescent ', suburb: 'Sample  Rise',
      state: 'Victoria', postcode: ' 3999 ',
    });
    expect(errors).toEqual([]);
    expect(location).toEqual({
      address_line: 'Lot 101 Sample Crescent', suburb: 'Sample Rise', state: 'VIC', postcode: '3999',
    });
    expect(parseStatedLocation({ state: 'nsw' }).location.state).toBe('NSW');
  });

  it('reads an empty, null or absent part as not stated — which is how a correction is taken back', () => {
    expect(parseStatedLocation({ address_line: '', suburb: null, state: '   ' })).toEqual({ location: {}, errors: [] });
    expect(parseStatedLocation(undefined)).toEqual({ location: {}, errors: [] });
  });

  it('keeps the punctuation an address is written with', () => {
    for (const address of ['13/15 Rose Street', "Unit 2, 4-6 O'Connor Place", 'Lot 1 (Stage 3) Sample Road']) {
      expect(parseStatedLocation({ address_line: address }).location.address_line).toBe(address);
    }
    for (const suburb of ["O'Connor", 'Tweed Heads South', 'St. Kilda', 'Sample-Rise']) {
      expect(parseStatedLocation({ suburb }).location.suburb).toBe(suburb);
    }
  });

  it('REFUSES what would place the property somewhere else, and names the part', () => {
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ suburb: 'Sample Rise 3999' }, 'suburb', /no numbers/],
      [{ suburb: 'X' }, 'suburb', /between 2 and 60/],
      [{ state: 'Victorian' }, 'state', /one of ACT, NSW, NT, QLD, SA, TAS, VIC or WA/],
      [{ postcode: '399' }, 'postcode', /four digits/],
      [{ postcode: '3999a' }, 'postcode', /four digits/],
      [{ address_line: 'Lo' }, 'address_line', /between 3 and 120/],
      [{ address_line: '1234' }, 'address_line', /letters, numbers/],
      [{ address_line: 'Lot 1 <b>Sample</b>' }, 'address_line', /letters, numbers/],
      [{ suburb: { name: 'Sample Rise' } }, 'suburb', /must be text/],
    ];
    for (const [input, field, message] of cases) {
      const { location, errors } = parseStatedLocation(input);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe(field);
      expect(errors[0].message).toMatch(message);
      // Nothing is half-stored: one refused part refuses the statement.
      expect(location).toEqual({});
    }
  });

  it('never cleans a refused value into one nobody typed', () => {
    // A long address is refused, not cut to 120 characters.
    const long = `Lot 1 ${'Sample '.repeat(20)}Road`;
    expect(parseStatedLocation({ address_line: long }).errors[0].message).toMatch(/between 3 and 120/);
  });
});

describe('reading a statement back', () => {
  it('takes the four parts out of manual_stats.values and ignores the figures', () => {
    expect(readStatedLocation({
      values: { bedrooms: 4, suburb: 'Sample Rise', state: 'VIC' }, recorded_at: null, recorded_by: null,
    })).toEqual({ suburb: 'Sample Rise', state: 'VIC' });
  });

  it('drops a stored part that would be refused on the way in', () => {
    expect(readStatedLocation({ values: { state: 'XX', postcode: 3999, suburb: 'Sample Rise' } }))
      .toEqual({ suburb: 'Sample Rise' });
    expect(readStatedLocation({ values: { bedrooms: 4 } })).toBeNull();
    expect(readStatedLocation(null)).toBeNull();
  });
});

describe('the overlay', () => {
  const document = {
    id: 'lot-101', lot_number: '101', development_name: 'Watsons Reach Estate',
    address_line: null, suburb: null, state: null, postcode: null, land_size_sqm: null,
  };

  it('lays the builder’s parts over the document’s and keeps what the document said', () => {
    const row = applyStatedLocation({
      ...document,
      manual_stats: { values: { suburb: 'Sample Rise', state: 'VIC' }, recorded_at: null, recorded_by: null },
    });
    expect(row.suburb).toBe('Sample Rise');
    expect(row.state).toBe('VIC');
    expect((row as Record<string, unknown>).stated_suburb).toBeNull();
    // A part the builder did not state is the document's, untouched.
    expect(row.postcode).toBeNull();
    expect('stated_postcode' in row).toBe(false);
    expect((row as Record<string, unknown>).manual_location).toEqual({ suburb: 'Sample Rise', state: 'VIC' });
  });

  it('keeps a document’s street where the builder stated only the suburb', () => {
    const row = applyStatedLocation({
      ...document, address_line: 'Lot 101 Document Street', suburb: 'Document Vale',
      manual_stats: { values: { suburb: 'Sample Rise' } },
    });
    expect(row.address_line).toBe('Lot 101 Document Street');
    expect(row.suburb).toBe('Sample Rise');
    expect((row as Record<string, unknown>).stated_suburb).toBe('Document Vale');
  });

  it('says nothing was stated where nothing was', () => {
    expect((applyStatedLocation({ ...document, manual_stats: null }) as Record<string, unknown>).manual_location)
      .toBeNull();
  });

  it('must run BEFORE the figures’ overlay, which rewrites manual_stats to the figures alone', () => {
    const stored = {
      ...document,
      manual_stats: { values: { land_size_sqm: 312, suburb: 'Sample Rise', state: 'VIC' }, recorded_at: null, recorded_by: null },
    };
    const [decorated] = applyManualStatsToAll([stored].map(applyStatedLocation));
    expect(decorated.suburb).toBe('Sample Rise');
    expect(decorated.land_size_sqm).toBe(312);
    expect(statedLocationFields(decorated)).toEqual(['suburb', 'state']);

    // The other way round, the address is gone from the builder's own card
    // while it is still stored — which is why the order is pinned below.
    const wrong = applyStatedLocation(applyManualStats(stored));
    expect(wrong.suburb).toBeNull();
  });

  it('is applied in that order where the builder portal reads its stock', () => {
    const source = read('supabase/functions/builder-portal-stock/index.ts');
    expect(source).toContain('items = applyManualStatsToAll(items.map(applyStatedLocation));');
    expect(source).not.toMatch(/items = applyManualStatsToAll\(items\);/);
  });
});

describe('saving the statement', () => {
  const source = read('supabase/functions/builder-portal-stock/index.ts');
  const op = source.slice(source.indexOf("if (operation === 'set_manual_stats')"),
    source.indexOf("if (operation === 'archive_stock_item')"));

  it('keeps an address the request does not mention, and figures likewise', () => {
    // A tab opened before the deploy sends figures alone; its silence must not
    // erase an address somebody else stated.
    expect(op).toContain('body.location === undefined');
    expect(op).toContain('readStatedLocation(item.manual_stats)');
    expect(op).toContain('body.stats === undefined');
    expect(op).toContain('readManualStats(item.manual_stats)');
  });

  it('stores the figures and the place as one statement, and every part cleared withdraws it', () => {
    expect(op).toContain('const values = { ...(figures.stats?.values ?? {}), ...place.location };');
    expect(op).toMatch(/const stats = Object\.keys\(values\)\.length\s*\?\s*\{ values, recorded_at: recordedAt, recorded_by: me\.id \}\s*: null;/);
    expect(op).toContain('.update({ manual_stats: stats })');
  });

  it('refuses rather than cleans, with the part named', () => {
    expect(op).toContain('const errors = [...figures.errors, ...place.errors];');
    expect(op).toContain("code: 'invalid_stat', fields: errors }, 400);");
  });
});

describe('the one set of rules is the columns’ own', () => {
  const baseline = read('supabase/migrations/00000000000000_network_baseline.sql');

  it('states exactly the eight the state column admits', () => {
    const check = /builder_stock_items_state_check CHECK \(\(\(state IS NULL\) OR \(state = ANY \(ARRAY\[([^\]]+)\]/.exec(baseline)![1];
    const column = [...check.matchAll(/'([A-Z]+)'::text/g)].map((m) => m[1]).sort();
    expect([...STATED_STATES].sort()).toEqual(column);
  });

  it('requires a postcode the postcode column would accept', () => {
    expect(baseline).toContain("builder_stock_items_postcode_check CHECK (((postcode IS NULL) OR (postcode ~ '^[0-9]{4}$'::text)))");
    expect(parseStatedLocation({ postcode: '0800' }).location.postcode).toBe('0800');
  });

  it('lists the four parts in address order, and never the lot', () => {
    expect(STATED_LOCATION_FIELDS).toEqual(['address_line', 'suburb', 'state', 'postcode']);
    expect(STATED_LOCATION_FIELDS).not.toContain('lot_number');
  });
});

describe('the migration', () => {
  const BEFORE = 'supabase/migrations/20260923140000_a_builders_stated_figures_reach_the_marketplace.sql';
  const AFTER = 'supabase/migrations/20260923160000_a_builder_can_state_where_a_property_is.sql';
  const after = read(AFTER);

  const composer = (sql: string) => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload');
    const end = sql.indexOf('END $function$;', start) + 'END $function$;'.length;
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start, end);
  };

  it('changes the composer in exactly two places: the address columns and when manual_stats is sent', () => {
    const was = composer(read(BEFORE));
    const now = composer(after);
    const undo = now
      .replace(
        `    'address_line', COALESCE(v_i.manual_stats->'values'->>'address_line', v_i.address_line),
    'suburb',       COALESCE(v_i.manual_stats->'values'->>'suburb',       v_i.suburb),
    'state',        COALESCE(v_i.manual_stats->'values'->>'state',        v_i.state),
    'postcode',     COALESCE(v_i.manual_stats->'values'->>'postcode',     v_i.postcode),
`,
        `    'address_line', v_i.address_line,
    'suburb', v_i.suburb,
    'state', v_i.state,
    'postcode', v_i.postcode,
`)
      .replace(
        `    'manual_stats', CASE WHEN NOT COALESCE(v_i.manual_stats->'values' ?| ARRAY[
        'bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm'], false)
      THEN NULL ELSE`,
        `    'manual_stats', CASE WHEN v_i.manual_stats IS NULL THEN NULL ELSE`);
    expect(undo).not.toBe(now);
    expect(undo).toBe(was);
  });

  it('never lets an address part into the manual_stats a clone reads', () => {
    const block = composer(after).slice(composer(after).indexOf("'manual_stats', CASE"),
      composer(after).indexOf("'item_created_at'"));
    for (const field of STATED_LOCATION_FIELDS) expect(block).not.toContain(`'${field}'`);
  });

  it('asserts key PRESENCE before any dereference, then admits the four parts with the columns’ rules', () => {
    const check = after.slice(after.indexOf('ADD CONSTRAINT builder_stock_items_manual_stats_shape'),
      after.indexOf('CREATE OR REPLACE FUNCTION'));
    const presence = check.indexOf("manual_stats ? 'values'");
    expect(presence).toBeGreaterThan(-1);
    expect(presence).toBeLessThan(check.indexOf("manual_stats -> 'values' ->"));
    for (const field of STATED_LOCATION_FIELDS) {
      expect(check).toContain(`jsonb_typeof(manual_stats -> 'values' -> '${field}') = 'string'`);
    }
    const bounded = (field: string) => {
      const spec = STATED_LOCATION_SPECS.find((entry) => entry.field === field)!;
      return `char_length(manual_stats -> 'values' ->> '${field}') BETWEEN ${field === 'address_line' ? 3 : 2} AND ${spec.maxLength}`;
    };
    expect(check).toContain(bounded('address_line'));
    expect(check).toContain(bounded('suburb'));
    expect(check).toContain("(manual_stats -> 'values' ->> 'postcode') ~ '^[0-9]{4}$'");
    const states = /->> 'state'\)\s*= ANY \(ARRAY\[([^\]]+)\]/.exec(check)![1];
    expect([...states.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]).sort()).toEqual([...STATED_STATES].sort());
  });

  it('is proved against a real database in the acceptance run, not only read', () => {
    expect(read('scripts/stock-acceptance/run.sh')).toContain('node scripts/ops/probe-stated-location-payload.mjs');
  });
});

describe('the figures’ module is untouched', () => {
  it('is still byte-identical to the copy every clone runs', () => {
    /*
     * A clone overlays figures with its own copy of `manualStats.pure.ts`,
     * which was byte-identical to this one when the address was added
     * (measured 23 Sep 2026, against the clone repository's main). The
     * address was put in a module of its own precisely so this one would not
     * move; a change here is a change the clones do not have.
     */
    const digest = createHash('sha256')
      .update(read('supabase/functions/_shared/builderStock/manualStats.pure.ts')).digest('hex');
    expect(digest).toBe('07fa96bce331186a93d7340c1c5a6a543982bf02c5c030fb23e9a7eb1ae2a160');
  });
});
