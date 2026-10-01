/**
 * BUILDER STOCK — WHAT IS HOLDING A STOCK LIST OFF THE MARKETPLACE, BY NAME.
 *
 * MEASURED 30 SEPTEMBER 2026. A list of 41 properties, every one settled with
 * its own ready builder photograph, never went live, and the page said "goes
 * live once every property in it has a photo" — over 41 photographs. The gate
 * holding it was list-level (`source_manifest_state = 'failed'`), and nothing
 * the builder could see named it, because the publish function's refusal and
 * the page's copy only ever described the PER-PROPERTY gates.
 *
 * So every gate in `builder_stock_publication_readiness` has a name here, and
 * a sentence for the builder that says whose problem it is. The readiness
 * function stays the only authority on whether a list publishes; this module
 * only describes its answer. `READINESS_GATES` maps each term of that
 * function's `ready` expression to a blocker, and a spec reads the function's
 * latest definition and fails if a term ever appears that this cannot name —
 * a hidden blocker cannot ship again.
 *
 * Pure: no IO.
 */

export type PublicationBlocker =
  | 'no_properties'
  | 'photos_in_progress'
  | 'properties_failed'
  | 'photos_missing'
  | 'source_files_pending'
  | 'source_listing_failed';

/**
 * Each term of the readiness function's `ready` conjunction, as it is
 * written there, and the blocker it is. Read by the contract spec.
 */
export const READINESS_GATES: Readonly<Record<string, PublicationBlocker>> = {
  'c.total > 0': 'no_properties',
  'c.open_work = 0': 'photos_in_progress',
  'c.failed_items = 0': 'properties_failed',
  'c.missing_primary = 0': 'photos_missing',
  'g.assets_settled': 'source_files_pending',
  'g.manifest_ok': 'source_listing_failed',
};

/** What the page knows about one upload — `builder_stock_image_progress`. */
export interface PublicationReading {
  total: number;
  photosReady: number;
  failed: number;
  working: number;
  manifestState: string | null;
  /** Source files linked by this list that no worker has answered yet. */
  pendingAssets?: number | null;
  published: boolean;
}

/**
 * Everything holding this list back, in the order a builder should read it.
 * Empty where nothing is — including a list that is already live.
 */
export function publicationBlockers(reading: PublicationReading): PublicationBlocker[] {
  if (reading.published) return [];
  const total = Math.max(0, Number(reading.total) || 0);
  const ready = Math.max(0, Number(reading.photosReady) || 0);
  const failed = Math.max(0, Number(reading.failed) || 0);
  const working = Math.max(0, Number(reading.working) || 0);
  const blockers: PublicationBlocker[] = [];
  if (total === 0) return ['no_properties'];
  if (working > 0) blockers.push('photos_in_progress');
  if (failed > 0) blockers.push('properties_failed');
  if (ready < total && working === 0 && failed < total - ready) blockers.push('photos_missing');
  if ((Number(reading.pendingAssets) || 0) > 0) blockers.push('source_files_pending');
  if (reading.manifestState === 'failed') blockers.push('source_listing_failed');
  return blockers;
}

/**
 * The sentence a builder reads. Where the cause is OURS it says so and says
 * what happens next; it never tells a builder their photographs are missing
 * when what is missing is our record of their source.
 */
export function describePublicationBlocker(
  blocker: PublicationBlocker,
  reading: PublicationReading,
): string {
  const total = Math.max(0, Number(reading.total) || 0);
  const missing = Math.max(0, total - (Number(reading.photosReady) || 0) - (Number(reading.failed) || 0));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (blocker) {
    case 'no_properties':
      return 'This stock list has no properties in it yet.';
    case 'photos_in_progress':
      return `${plural(Number(reading.working) || 0, 'property is', 'properties are')} still `
        + 'having their photos prepared. This list goes live automatically when they finish.';
    case 'properties_failed':
      return `${plural(Number(reading.failed) || 0, 'property needs', 'properties need')} a `
        + 'photo from you before this list can go live — add a picture to each one below.';
    case 'photos_missing':
      return `${plural(missing, 'property is', 'properties are')} still waiting for a photo.`;
    case 'source_files_pending':
      return 'Some of the files this list links to are still being read. It goes live '
        + 'automatically when they finish.';
    case 'source_listing_failed':
      return 'This list links to more photos and documents than we can read in one pass, so we '
        + 'could not confirm all of them. This is a limit on our side, not a problem with your '
        + 'list — our team has been alerted.';
  }
}
