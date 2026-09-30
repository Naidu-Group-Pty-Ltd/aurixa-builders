import { describe, expect, it } from 'vitest';
import {
  heldPropertiesHeading, heldPropertiesNote, photoAttentionCopy,
} from '../builderStockPhotoAttention.pure';

/**
 * The owner's instruction, 30 September 2026: the photo-error wording on the
 * Stock List is "too much — it has to be short, concise and to the point".
 * These pin the SHORT form and the four facts it may not lose.
 */
describe('photoAttentionCopy', () => {
  const base = { failed: 0, needingUs: 0, needingBuilder: 0, mismatched: 0, listIsLive: false };

  it('says whose failure it is: ours', () => {
    const copy = photoAttentionCopy({ ...base, failed: 3, needingUs: 3 });
    expect(copy.title).toBe('3 properties need a photo');
    expect(copy.body).toBe('We couldn’t read their photos — our team is on it. '
      + 'Your list goes live once each has a photo — add them below.');
  });

  it('says whose failure it is: the documents', () => {
    const copy = photoAttentionCopy({ ...base, failed: 1, needingBuilder: 1, listIsLive: true });
    expect(copy.title).toBe('1 property needs a photo');
    expect(copy.body).toBe('Its documents don’t include a photo of the property. '
      + 'The rest of your list is live — add a photo below to publish it.');
    // A document we read that holds no photo is not ours to fix.
    expect(copy.body).not.toContain('our team');
  });

  it('says both where both are true, with the counts', () => {
    const copy = photoAttentionCopy({ ...base, failed: 19, needingUs: 3, needingBuilder: 16, listIsLive: true });
    expect(copy.body).toBe('3 couldn’t be read (our team is on it) and 16 have no usable photo in their documents. '
      + 'The rest of your list is live — add a photo below to publish these.');
  });

  it('names a brochure for another property as that, not as a brochure with no photo', () => {
    expect(photoAttentionCopy({ ...base, failed: 1, needingBuilder: 1, mismatched: 1 }).body)
      .toContain('Its linked brochure shows a different property.');
    expect(photoAttentionCopy({ ...base, failed: 4, needingBuilder: 4, mismatched: 4 }).body)
      .toContain('Their linked brochures show a different property.');
    expect(photoAttentionCopy({ ...base, failed: 5, needingBuilder: 5, mismatched: 2 }).body)
      .toContain('2 link another property’s brochure; 3 have no photo in their documents.');
  });

  it('only calls the rest of the list live where it is', () => {
    const held = photoAttentionCopy({ ...base, failed: 2, needingBuilder: 2 });
    expect(held.body).not.toMatch(/is live/);
    expect(held.body).toContain('Your list goes live once');
  });

  it('is short: a heading and at most two sentences, never the old paragraph', () => {
    const cases = [
      { ...base, failed: 19, needingUs: 3, needingBuilder: 16, mismatched: 2, listIsLive: true },
      { ...base, failed: 47, needingUs: 47 },
      { ...base, failed: 1, needingBuilder: 1, mismatched: 1 },
    ];
    for (const counts of cases) {
      const { title, body } = photoAttentionCopy(counts);
      expect(title.length).toBeLessThanOrEqual(40);
      expect(body.length).toBeLessThanOrEqual(170);
      expect(body.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
      expect(body).not.toMatch(/read in full|each one says what its documents contained|holding the rest/);
    }
  });
});

describe('the held-properties heading', () => {
  it('counts, and adds a line only where no banner said it already', () => {
    expect(heldPropertiesHeading(1)).toBe('1 property is waiting for a photo');
    expect(heldPropertiesHeading(3)).toBe('3 properties are waiting for a photo');
    expect(heldPropertiesNote(3, true, true)).toBeNull();
    expect(heldPropertiesNote(3, true, false)).toBe('Add a photo to put each one on the marketplace.');
    expect(heldPropertiesNote(1, false, false)).toBe('Your list goes live once it has a photo.');
  });
});
