import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseStockRow, statedPrice } from '../../../supabase/functions/_shared/builderStock/normalise.pure.ts';
import { keyRowsByHeader, parseDelimited } from '../../../supabase/functions/_shared/builderStock/table.pure.ts';

/**
 * A PRICE CELL STATES BOTH PRICE COLUMNS, INCLUDING WHICH ONE IS NOW EMPTY.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, phase
 * `stock-tier0-lifecycle`): lot 104 was listed at "POA"; the builder's revised
 * list priced it at "$799,000". The revision stored `price` 799000 and KEPT
 * `price_display` "POA", because the re-import patch wrote the two columns one
 * at a time and treats an empty column as "the list did not say". Both portals
 * print the display text in preference to the figure, so the builder's Stock
 * List and the Command Centre marketplace went on advertising "POA" for a
 * property its builder had just priced.
 *
 * Both columns are read from ONE cell (`coercePrice`): a figure fills `price`,
 * words fill `price_display`, a figure with words fills both. So when the cell
 * says anything it decides both — and a blank cell still erases nothing.
 */
const SHEET = resolve(__dirname, '../../../scripts/ops/fixtures/tier0');
const lot = (file: string, lotNumber: string) => {
  const keyed = keyRowsByHeader(parseDelimited(readFileSync(`${SHEET}/${file}`, 'utf8')))!;
  const row = (keyed.rows as Array<Record<string, unknown>>).find((r) => String(r.Lot) === lotNumber)!;
  return normaliseStockRow(row)!;
};

describe('the price a stock list row states', () => {
  it('clears the "POA" a revised list replaced with a figure (the measured defect)', () => {
    expect(lot('csv-v1.csv', '104')).toMatchObject({ price: null, price_display: 'POA' });
    expect(statedPrice(lot('csv-v2.csv', '104'))).toEqual({ price: 799000, price_display: null });
  });

  it('clears a figure the revised list replaced with words', () => {
    expect(statedPrice({ price: null, price_display: 'Price on application' }))
      .toEqual({ price: null, price_display: 'Price on application' });
  });

  it('keeps a figure and the words written beside it together', () => {
    expect(statedPrice({ price: 749900, price_display: '$749,900 *' }))
      .toEqual({ price: 749900, price_display: '$749,900 *' });
  });

  it('says nothing for a blank cell, so a blank erases nothing', () => {
    expect(statedPrice({ price: null, price_display: null })).toBeNull();
  });

  it('is what the re-import patch writes both price columns from', () => {
    const importer = readFileSync(resolve(__dirname,
      '../../../supabase/functions/_shared/builderStock/importStock.ts'), 'utf8');
    const patch = importer.slice(importer.indexOf('function writablePatch('),
      importer.indexOf('async function buildInventoryIndex('));
    expect(patch).toContain('statedPrice(record)');
    expect(patch).toMatch(/patch\.price = priced\.price;\s*patch\.price_display = priced\.price_display;/);
  });
});
