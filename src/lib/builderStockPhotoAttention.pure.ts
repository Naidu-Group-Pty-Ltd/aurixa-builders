/**
 * The Stock List's photo-problem copy, short.
 *
 * WHY THIS EXISTS. The banner above a builder's held properties grew one
 * clause per incident — each true, each added for a reason — until a single
 * reading ran to a heading, four sentences and a second heading restating it:
 * "3 could not be read from the stock list and our team has been alerted. The
 * other 16 were read in full and the documents name no photograph of that
 * property — those are yours to correct, and each one says what its documents
 * contained. The rest of your list is already on the marketplace. These are
 * the only ones not on it — adding a picture to each one below puts it there
 * too." The owner's instruction (30 September 2026): short, concise, to the
 * point.
 *
 * WHAT MUST SURVIVE THE CUT, because each was a defect once:
 *   • WHOSE failure it is. "Our team is on it" is a promise, true only of a
 *     document we could not read, never of one we read that holds no photo.
 *   • A brochure for another property is not a brochure with no photo in it.
 *   • Whether the rest of the list is live. "Holding the rest back" is true of
 *     an unpublished list and false of a published one.
 *   • The one act that always works: add a photo.
 *
 * Every figure is the caller's, taken from the server's own classification;
 * nothing here counts or decides.
 */

export interface PhotoAttentionCounts {
  /** Properties whose photo is owed (the upload's `failed`). */
  failed: number;
  /** Of those, the ones we could not read. */
  needingUs: number;
  /** Of those, the ones read in full that hold no usable photo. */
  needingBuilder: number;
  /** Of `needingBuilder`, the ones whose brochure names another property. */
  mismatched: number;
  /** Whether the rest of this list is already on the marketplace. */
  listIsLive: boolean;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The banner: a heading and at most two short sentences. */
export function photoAttentionCopy(counts: PhotoAttentionCounts): { title: string; body: string } {
  const failed = Math.max(0, counts.failed);
  const ours = Math.max(0, counts.needingUs);
  const theirs = Math.max(0, counts.needingBuilder);
  const mismatched = Math.min(Math.max(0, counts.mismatched), theirs);
  const one = failed === 1;

  const title = `${failed} ${plural(failed, 'property needs', 'properties need')} a photo`;

  let cause: string;
  if (ours > 0 && theirs > 0) {
    cause = `${ours} couldn’t be read (our team is on it) and ${theirs} `
      + `${plural(theirs, 'has', 'have')} no usable photo in ${plural(theirs, 'its', 'their')} documents.`;
  } else if (ours > 0) {
    cause = one
      ? 'We couldn’t read its photo — our team is on it.'
      : 'We couldn’t read their photos — our team is on it.';
  } else if (mismatched > 0 && mismatched >= theirs) {
    cause = theirs === 1
      ? 'Its linked brochure shows a different property.'
      : 'Their linked brochures show a different property.';
  } else if (mismatched > 0) {
    cause = `${mismatched} ${plural(mismatched, 'links', 'link')} another property’s brochure; `
      + `${theirs - mismatched} ${plural(theirs - mismatched, 'has', 'have')} no photo in ${plural(theirs - mismatched, 'its', 'their')} documents.`;
  } else {
    cause = one
      ? 'Its documents don’t include a photo of the property.'
      : 'Their documents don’t include a photo of the property.';
  }

  const next = counts.listIsLive
    ? `The rest of your list is live — add a photo below to publish ${plural(failed, 'it', 'these')}.`
    : `Your list goes live once ${plural(failed, 'it has', 'each has')} a photo — add ${plural(failed, 'one', 'them')} below.`;

  return { title, body: `${cause} ${next}` };
}

/** The heading over the properties still waiting for a photo. */
export function heldPropertiesHeading(count: number): string {
  return `${count} ${plural(count, 'property is', 'properties are')} waiting for a photo`;
}

/**
 * The one line under that heading, where no banner above has said it
 * already. Null where the banner is showing: the same fact twice is how a
 * screen gets long.
 */
export function heldPropertiesNote(count: number, listIsLive: boolean, bannerShown: boolean): string | null {
  if (bannerShown) return null;
  return listIsLive
    ? `Add a photo to put ${plural(count, 'it', 'each one')} on the marketplace.`
    : `Your list goes live once ${plural(count, 'it has', 'each has')} a photo.`;
}
