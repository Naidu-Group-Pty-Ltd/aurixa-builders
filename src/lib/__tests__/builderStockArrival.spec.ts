import { describe, expect, it } from 'vitest';
import {
  ARRIVING_LIST_BODY, arrivingList, arrivingListTitle, arrivingPlaceholderCount,
  stockListPreparation,
} from '../builderStockArrival.pure';

describe('a stock list that is still arriving is said while it arrives', () => {
  it('the 1 October 2026 window: 44 imported, none live, photographs being prepared', () => {
    const list = arrivingList([{ total: 44, photos_ready: 12, working: 32, failed: 0, published: false }]);
    expect(list).toEqual({ total: 44, ready: 12, working: 32 });
    expect(arrivingListTitle(list!)).toBe('Preparing your stock list — 12 of 44 photos ready');
  });

  it('a linked file still being fetched counts as arriving before any photograph is', () => {
    expect(arrivingList([{ total: 10, photos_ready: 0, working: 0, pending_assets: 3, published: false }]))
      .toEqual({ total: 10, ready: 0, working: 3 });
  });

  it('a live list, an empty upload and a held list with nothing in progress are not arriving', () => {
    expect(arrivingList([{ total: 44, photos_ready: 40, working: 4, published: true }])).toBeNull();
    expect(arrivingList([{ total: 0, working: 0, published: false }])).toBeNull();
    // Held by failures or a list-level gate: the blockers name it, no spinner.
    expect(arrivingList([{ total: 47, photos_ready: 42, failed: 5, working: 0, published: false }])).toBeNull();
    expect(arrivingList([])).toBeNull();
  });

  it('the newest arriving upload is the one read, and junk never reads as progress', () => {
    expect(arrivingList([
      { total: 44, photos_ready: 44, working: 0, published: true },
      { total: 5, photos_ready: 'x', working: '2', published: false },
    ])).toEqual({ total: 5, ready: 0, working: 2 });
    /*
     * A COUNT NEVER EXCEEDS THE LIST. Nine ready of three is clamped to three,
     * which is then every photograph the list has — so the reading is
     * `settled`, and asked through `arrivingList` it is correctly null. The
     * clamp is asserted where it now shows: a bar reading "9 of 3" was the
     * defect, and inventing a fourth property to be still working on is the
     * one this must not swap it for.
     */
    expect(stockListPreparation([{ total: 3, photos_ready: 9, working: 1, published: false }]))
      .toEqual({ kind: 'settled', total: 3, ready: 3 });
    expect(arrivingList([{ total: 3, photos_ready: 9, working: 1, published: false }])).toBeNull();
  });

  it('it tells the builder it updates by itself, and draws a bounded number of placeholders', () => {
    expect(ARRIVING_LIST_BODY).toMatch(/no need to refresh/);
    expect(arrivingPlaceholderCount({ total: 44, ready: 0, working: 44 })).toBe(4);
    expect(arrivingPlaceholderCount({ total: 2, ready: 0, working: 2 })).toBe(2);
  });
});

describe('the stock list page draws it', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../../pages/builder/BuilderStockList.tsx'), 'utf8') as string;

  it('the banner leads with the arriving list, and placeholders replace the empty message while it arrives', () => {
    /*
     * RENEGOTIATED 2 OCTOBER 2026, and the reason is the regression this spec
     * could not see. It pinned `!records.length && incoming` as the whole
     * placeholder rule, which is true of a list with no LIVE rows — and a
     * list being prepared has none, so a real 44-property import drew four
     * grey rectangles over 44 staged rows the page already held. The
     * placeholder count is now the authority (`arrivingPlaceholderCount`
     * answers 0 once any staged row exists) and it is asserted by rendering
     * in `builderStockStagedVisibility.spec.tsx`. What is kept here is the
     * ORDERING property, which only the source can state.
     */
    expect(page).toContain('const preparation = stockListPreparation(progressRecords);');
    expect(page).toContain('{arrivingListTitle(incoming)}');
    const placeholders = page.indexOf('!records.length && incoming && placeholderCount > 0 ?');
    const empty = page.indexOf("'Nothing is on the marketplace yet'");
    expect(placeholders).toBeGreaterThan(0);
    expect(placeholders).toBeLessThan(empty);
  });

  it('a property still being worked on is not asked for a picture', () => {
    expect(page).toMatch(/heldWithoutPhoto = heldItems\.filter\([\s\S]*?!== 'working'\)\);/);
  });
});
