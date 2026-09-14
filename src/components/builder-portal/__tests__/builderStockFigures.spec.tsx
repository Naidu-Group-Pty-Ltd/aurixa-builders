import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuilderStockFiguresButton } from '@/components/builder-portal/BuilderStockFigures';
import type { BuilderStockItem } from '@/lib/builderStock';

/**
 * STATING THE FIGURES A STOCK LIST DID NOT.
 *
 * Lot 324 imported with bedrooms, bathrooms, car spaces and home size empty
 * because its brochure is a dual-key home — two self-contained dwellings, two
 * sets of figures — and the extraction refused to collapse them into one
 * number rather than inventing it. This is the surface that lets the builder
 * say what their document could not.
 */

const mutate = vi.fn();
vi.mock('@/lib/builderStockQueries', () => ({
  useSetBuilderStockManualStats: () => ({ mutate, isPending: false }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const item = (over: Partial<BuilderStockItem> = {}) => ({
  id: 'item-1',
  address_line: 'Lot 324 Dapple Avenue',
  lot_number: '324',
  development_name: 'Palomino Estate',
  suburb: 'Armstrong Creek', state: 'VIC', postcode: '3217',
  bedrooms: null, bathrooms: null, car_spaces: null,
  building_size_sqm: null, land_size_sqm: 350,
  manual_stats: null,
  ...over,
} as unknown as BuilderStockItem);

function draw(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /schedule/i }));
const boxFor = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => { mutate.mockReset(); });

describe('the control on the plate', () => {
  it('offers to COMPLETE where the stock list left a figure empty', () => {
    draw(<BuilderStockFiguresButton item={item()} />);
    expect(screen.getByRole('button', { name: /Complete the schedule/i })).toBeTruthy();
  });

  it('offers to UPDATE where the stock list stated everything', () => {
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 4, bathrooms: 3, car_spaces: 2, building_size_sqm: 174,
    })} />);
    expect(screen.getByRole('button', { name: /Update the schedule/i })).toBeTruthy();
  });
});

/**
 * PROMINENCE TRACKS WHAT IS OWED.
 *
 * This control shipped as 144x15px of 10px annotation type with no border, no
 * ground and no padding — measured in Chromium, not guessed — and was reported
 * as not visible enough. It is the ONLY way to fill the em dashes in the
 * schedule above it, so on a property that is missing a figure it is now a
 * filled control; where nothing is owed it stays outlined, because a single
 * loud treatment would stamp a solid block on every already-complete card down
 * a sheet.
 *
 * The attribute is what the stylesheet keys on, so it is the thing worth
 * pinning: the CSS can be retuned without touching this test, but the STATE
 * must keep tracking `missing`.
 */
describe('the control’s weight follows what is outstanding', () => {
  it('is marked outstanding while a figure is missing', () => {
    draw(<BuilderStockFiguresButton item={item()} />);
    expect(screen.getByRole('button', { name: /Complete the schedule/i })
      .getAttribute('data-figures')).toBe('outstanding');
  });

  it('is marked stated once the stock list covers every figure', () => {
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 4, bathrooms: 3, car_spaces: 2, building_size_sqm: 174,
    })} />);
    expect(screen.getByRole('button', { name: /Update the schedule/i })
      .getAttribute('data-figures')).toBe('stated');
  });

  it('counts a stated ZERO as covered, so a studio is not nagged for ever', () => {
    // `0` is falsy; a truthiness reading here would mark a complete studio
    // "outstanding" on every visit and never stop.
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 0, bathrooms: 1, car_spaces: 0, building_size_sqm: 52,
    })} />);
    expect(screen.getByRole('button', { name: /Update the schedule/i })
      .getAttribute('data-figures')).toBe('stated');
  });
});

describe('the dialog shows what the document said', () => {
  it('names the stock list’s own reading under each field', () => {
    draw(<BuilderStockFiguresButton item={item({ bedrooms: 4, land_size_sqm: 350 })} />);
    open();
    // A builder disagreeing with their own file should see the reading they
    // are replacing before they type over it.
    expect(screen.getByText(/Stock list: 4/)).toBeTruthy();
    expect(screen.getByText(/Stock list: 350 m²/)).toBeTruthy();
  });

  it('says the file was silent, rather than leaving a bare empty field', () => {
    // "Not in your stock list" separates a document that did not say from a
    // product that lost the number — the whole reason Lot 324 was reported.
    draw(<BuilderStockFiguresButton item={item()} />);
    open();
    expect(screen.getAllByText('Not specified').length).toBe(4);
  });

  it('reads a document value from `stated_*` once a builder has overridden it', () => {
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 3, stated_bedrooms: 4,
      manual_stats: { values: { bedrooms: 3 }, recorded_at: null, recorded_by: null },
    })} />);
    open();
    // The row now CARRIES 3 because the server overlaid it. The document said
    // 4, and that is what the builder is shown underneath.
    expect(screen.getByText(/Stock list: 4/)).toBeTruthy();
    expect(boxFor(/^Bedrooms/).value).toBe('3');
  });
});

describe('what the boxes are seeded with', () => {
  it('seeds ONLY what the builder previously stated, never the document’s value', () => {
    /*
     * Seeding from the effective value would silently promote every figure the
     * stock list supplied into a manual override the first time anybody opened
     * this box — the whole list would become hand-entered and stop tracking
     * the builder's own file.
     */
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 4, bathrooms: 3, car_spaces: 2, building_size_sqm: 174,
    })} />);
    open();
    for (const label of [/^Bedrooms/, /^Bathrooms/, /^Car spaces/, /^Home/]) {
      expect(boxFor(label).value).toBe('');
    }
  });

  it('seeds the figures the builder did state', () => {
    draw(<BuilderStockFiguresButton item={item({
      bedrooms: 4, bathrooms: 3,
      manual_stats: { values: { bedrooms: 4, bathrooms: 3 }, recorded_at: null, recorded_by: null },
    })} />);
    open();
    expect(boxFor(/^Bedrooms/).value).toBe('4');
    expect(boxFor(/^Bathrooms/).value).toBe('3');
  });
});

describe('saving', () => {
  it('sends a typed figure, and null for a box left empty', () => {
    draw(<BuilderStockFiguresButton item={item()} />);
    open();
    fireEvent.change(boxFor(/^Bedrooms/), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [payload] = mutate.mock.calls[0];
    expect(payload.stockItemId).toBe('item-1');
    expect(payload.stats.bedrooms).toBe(4);
    // An empty box withdraws the correction and gives the document back.
    expect(payload.stats.bathrooms).toBeNull();
  });

  it('sends ZERO as a figure, because a townhouse may have no car space', () => {
    // The one that a truthiness bug would silently turn into "not stated".
    draw(<BuilderStockFiguresButton item={item()} />);
    open();
    fireEvent.change(boxFor(/^Car spaces/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/i }));
    expect(mutate.mock.calls[0][0].stats.car_spaces).toBe(0);
  });

  it('cannot be saved until something changes', () => {
    draw(<BuilderStockFiguresButton item={item()} />);
    open();
    const save = screen.getByRole('button', { name: /Save schedule/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(boxFor(/^Bedrooms/), { target: { value: '4' } });
    expect((screen.getByRole('button', { name: /Save schedule/i }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('shows the server’s own refusal, which names the field', () => {
    mutate.mockImplementation((_input, handlers) => {
      handlers.onError(new Error('Bedrooms must be between 0 and 99.'));
    });
    draw(<BuilderStockFiguresButton item={item()} />);
    open();
    fireEvent.change(boxFor(/^Bedrooms/), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/i }));
    // The server REFUSES rather than clamping, so its message is worth
    // showing verbatim instead of "something went wrong".
    expect(within(screen.getByRole('alert')).getByText(/between 0 and 99/)).toBeTruthy();
  });
});
