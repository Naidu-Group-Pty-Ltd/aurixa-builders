import { describe, expect, it } from 'vitest';
import {
  ARRIVING_LIST_BODY, arrivingList, arrivingListTitle, arrivingPlaceholderCount,
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
    expect(arrivingList([{ total: 3, photos_ready: 9, working: 1, published: false }])!.ready).toBe(3);
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
    expect(page).toContain('const incoming = arrivingList(progressRecords);');
    expect(page).toContain('{arrivingListTitle(incoming)}');
    const placeholders = page.indexOf('!records.length && incoming ?');
    const empty = page.indexOf("'Nothing is on the marketplace yet'");
    expect(placeholders).toBeGreaterThan(0);
    expect(placeholders).toBeLessThan(empty);
  });

  it('a property still being worked on is not asked for a picture', () => {
    expect(page).toMatch(/heldWithoutPhoto = heldItems\.filter\([\s\S]*?!== 'working'\)\);/);
  });
});
