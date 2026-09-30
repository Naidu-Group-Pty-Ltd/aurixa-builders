import { describe, expect, it } from 'vitest';
import {
  coerceAvailability, coercePropertyType, fieldForHeader,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { normaliseStockSourceUrl } from '../../../supabase/functions/_shared/builderStock/urlSource.pure';
import { googleSheetsRef } from '../../../supabase/functions/_shared/builderStock/googleSheetsSource.pure';
import { hyperlinkTargetOf } from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';

/**
 * The stock-upload audit of 30 September 2026, pinned. Each case is a value
 * read off a live stock list on the network, and each was being read wrong.
 */
describe('availability: negation first, whole words', () => {
  it('never offers for sale what the builder has not released', () => {
    for (const status of ['Unreleased', 'Not Released', 'Not yet released', 'Inactive', 'Not current']) {
      expect(coerceAvailability(status), status).toBe('on_hold');
    }
  });

  it('reads "Not Sold" as for sale, and a completed build as not yet settled', () => {
    expect(coerceAvailability('Not Sold')).toBe('available');
    expect(coerceAvailability('Completed - Available')).toBe('available');
    expect(coerceAvailability('Completed')).toBe('unknown');
  });

  it('recognises the words the sheets actually use', () => {
    expect(coerceAvailability('Hold')).toBe('on_hold');
    expect(coerceAvailability('ONH NK - 20/09/2026')).toBe('on_hold');
    expect(coerceAvailability('Contract Signed')).toBe('contracted');
  });

  it('reads every word it always read the same way', () => {
    expect(coerceAvailability('Available')).toBe('available');
    expect(coerceAvailability('Sold')).toBe('sold');
    expect(coerceAvailability('Unavailable')).toBe('sold');
    expect(coerceAvailability('Under Offer')).toBe('on_hold');
    expect(coerceAvailability('EOI')).toBe('reserved');
    expect(coerceAvailability('Settled')).toBe('settled');
    expect(coerceAvailability('Released')).toBe('available');
    expect(coerceAvailability('Withdrawn')).toBe('withdrawn');
    expect(coerceAvailability(null)).toBe('unknown');
  });
});

describe('when the land titles', () => {
  it('maps the headings the lists use for it', () => {
    for (const heading of ['Registration', 'Title Date', 'Est. Title Date', 'Land Registration', 'Settlement Date']) {
      expect(fieldForHeader(heading), heading).toBe('expected_completion');
    }
  });

  it('never takes a bare "Title", which may be the row’s name', () => {
    expect(fieldForHeader('Title')).not.toBe('expected_completion');
  });
});

describe('a linked Google Sheets tab', () => {
  it('keeps the tab named in the fragment', () => {
    const normalised = normaliseStockSourceUrl(
      'https://docs.google.com/spreadsheets/d/1bPh8W2Bujp8DHpNknSv6h0LkiVnsxrIqN66PpvWfI4c/edit#gid=1140012797');
    expect(normalised.ok).toBe(true);
    const ref = googleSheetsRef(normalised.ok ? normalised.url : null);
    expect(ref?.gid).toBe('1140012797');
  });

  it('prefers the tab on screen over the one the link was first shared with', () => {
    const normalised = normaliseStockSourceUrl(
      'https://docs.google.com/spreadsheets/d/1bPh8W2Bujp8DHpNknSv6h0LkiVnsxrIqN66PpvWfI4c/edit?gid=0#gid=1140012797');
    expect(googleSheetsRef(normalised.ok ? normalised.url : null)?.gid).toBe('1140012797');
  });

  it('leaves every other address’s fragment dropped, as before', () => {
    const normalised = normaliseStockSourceUrl('https://example.com/list.csv#gid=5');
    expect(normalised.ok && normalised.url).toBe('https://example.com/list.csv');
  });
});

describe('a workbook’s hyperlink', () => {
  it('is unescaped, so its query survives', () => {
    expect(hyperlinkTargetOf({ link: 'https://drive.google.com/open?id=1AbC&amp;usp=sharing' }))
      .toBe('https://drive.google.com/open?id=1AbC&usp=sharing');
    expect(hyperlinkTargetOf({ link: 'https://example.com/a?x=1&#38;y=2' })).toBe('https://example.com/a?x=1&y=2');
  });
});

describe('property type: whole words', () => {
  it('does not call a warehouse a house', () => {
    expect(coercePropertyType('Warehouse')).toBe('other');
    expect(coercePropertyType('Industrial')).toBe('other');
  });

  it('reads titled land as land, and every house as it always did', () => {
    expect(coercePropertyType('Titled Land')).toBe('land');
    expect(coercePropertyType('House')).toBe('house');
    expect(coercePropertyType('Display Home')).toBe('house');
    expect(coercePropertyType('House & Land')).toBe('house_and_land');
    expect(coercePropertyType('Townhouse')).toBe('townhouse');
  });
});
