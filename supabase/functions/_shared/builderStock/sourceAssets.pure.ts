/**
 * Builder stock — the builder's OWN imagery, and how it stays tied to the
 * property it came from.
 *
 * Stage 1 of the three-stage enrichment is the only stage whose provenance is
 * the builder's document. It is also the only one that can be WRONG about
 * which property it depicts, because stages 2 and 3 start from an address we
 * already hold while this one starts from a picture sitting somewhere in a
 * file. So the rule this module exists to enforce:
 *
 *   AN IMAGE IS ATTRIBUTED BECAUSE THE SOURCE SAID SO, NEVER BECAUSE THE
 *   COUNTS LINED UP. A Notion row owns its cover; a spreadsheet drawing is
 *   anchored to a cell; a `<img>` sits inside one `<tr>`. Where the format
 *   states the relationship, that statement decides. Ordering is a fallback
 *   for formats that state nothing, and it is switched OFF the moment any
 *   image in the same document carries a real anchor — a render of lot 12
 *   shown against lot 40 is worse than showing nothing at all.
 *
 * ATTRIBUTION IS NOT ROLE. Everything above answers "whose picture is this?".
 * What the source presented the picture AS — its hero, its floorplan, its
 * estate map — is a second and equally necessary fact, and it travels with
 * every asset as `role`. See `sourceImageRole.pure.ts`.
 *
 * Pure: no IO and no clock. Loaded by the edge functions under Deno and by
 * `src/lib/__tests__` under vitest.
 */
import {
  isPrimaryRole, noPrimaryEvidence, roleFromAssetName, roleFromStructuralContainer,
  secondaryRole, type SourceImageRoleAssignment,
} from './sourceImageRole.pure.ts';

/**
 * The reserved column that carries a row's identity from the source into the
 * pipeline.
 *
 * A Notion collection becomes CSV before it is imported, and CSV has no room
 * for "this row was block 374cabf9…". Rather than inventing a second import
 * path that keeps the record map alive, the anchor travels as an ordinary
 * column: it survives the snapshot, it is visible in the stored object a
 * support question would be answered from, and `normaliseStockRow` lifts it
 * off the row instead of filing it under `unmapped`.
 */
export const SOURCE_ANCHOR_HEADER = 'npc_source_anchor';

/** Where a source-supplied asset was found. Recorded, never inferred. */
export type SourceAssetOrigin =
  | 'notion_page_cover'
  | 'notion_file_property'
  | 'notion_image_block'
  | 'notion_link_property'
  | 'stock_list_column'
  | 'html_row_image'
  | 'document_media';

/**
 * One builder-supplied asset, and the row it belongs to.
 *
 * `url` is what we will fetch; `reference` is what the source called it, and
 * is what the image row is keyed on so a re-import refreshes rather than
 * duplicates. The two differ for Notion, whose signed delivery URL changes on
 * every request while `attachment:<id>:<name>` does not.
 */
export interface SourceImageAsset {
  url: string;
  reference: string;
  origin: SourceAssetOrigin;
  /** `notion`, `uploaded_file`, `source_page`, `stock_list_column`. */
  provider: string;
  /** The page the asset was published on, when there is one. */
  pageUrl: string | null;
  /** Order within the row. 0 is the one the marketplace shows. */
  position: number;
  /**
   * May the plain link stand in when the bytes cannot be fetched?
   *
   * True for an ordinary published URL, which a browser can load even where a
   * server-side fetch was refused. FALSE for anything signed or expiring — a
   * Notion attachment resolves through a URL that is dead within the hour, and
   * recording it would put a broken image on a client's page later rather
   * than falling back honestly now.
   */
  linkFallback: boolean;
  /**
   * What the SOURCE presented this image as, and on what evidence.
   *
   * Required rather than optional: an asset whose role nobody stated is an
   * asset that cannot be a card's image, and making the producer say so is what
   * stops a new source type quietly inheriting "any picture will do".
   */
  role: SourceImageRoleAssignment;
}

/** Assets belonging to one row of the source, keyed by that row's anchor. */
export interface AnchoredAssets {
  anchor: string;
  assets: SourceImageAsset[];
}

/**
 * Settle the roles of the assets ONE row of a structured source carries.
 *
 * LEVEL 3, and the rule that makes it safe: a container designates a primary
 * only when, after everything the source NAMES as non-hero is set aside,
 * exactly one candidate is left. A Notion row whose cover is its only picture
 * has designated it; a table row holding three photographs and saying nothing
 * about them has designated nothing, and the answer to that is no primary.
 *
 * `preferred` is the asset the container itself puts first — a row cover, a
 * card's hero — which outranks its siblings where the source has one.
 */
export function settleRowAssetRoles(
  assets: SourceImageAsset[],
  container: { container: string; designation: string; preferredIndex?: number },
): SourceImageAsset[] {
  const all = assets ?? [];
  if (!all.length) return all;

  const named = all.map((asset) => roleFromAssetName(asset.reference));
  /**
   * WHAT THE SOURCE'S OWN FIELD SAYS THIS IS, when it says it is not a hero.
   *
   * An asset that arrived under a "Floorplan" or "Masterplan" field is the
   * source stating a role, exactly as a filename does — and the module header
   * has always promised that everything the source NAMES as non-hero is set
   * aside before anyone is designated. Only the filename half was enforced: a
   * lone floor plan under an explicit "Floor Plan" field was the row's only
   * candidate, so the container "designated" it and a plan drawing became a
   * card's primary image. Set aside here, it keeps the role the source gave
   * it and can never lead a card by being the last one standing.
   */
  const labelled = all.map((asset, index) => !named[index]
    && asset.role && asset.role.role !== 'unknown' && !isPrimaryRole(asset.role.role)
    ? asset.role : null);
  const candidates = all
    .map((asset, index) => ({ asset, index }))
    .filter(({ index }) => !named[index] && !labelled[index]);

  /**
   * LEVEL 1 OUTRANKS THE CONTAINER'S OWN PREFERENCE, and only here is the
   * difference visible. "The row's `Property Image` field names this file"
   * and "the row's cover slot holds this file" are both the source speaking,
   * but the first is the builder answering the exact question this function
   * exists to settle, and the second is where a picture happens to sit. The
   * Notion caller used to pass the page cover as `preferredIndex` whenever
   * the row had one, which inverted the documented hierarchy: a promotional
   * cover took the card and the clean facade the builder explicitly filed
   * was demoted to `property_secondary` — undisplayable, and never repaired
   * because nothing promotional was ever chosen.
   *
   * ONE explicit claim outranks; TWO contradict each other and outrank
   * nothing — the preferred structural designation (or ambiguity) stands,
   * because picking between equal explicit claims by position would be this
   * function guessing, which is the one thing it exists never to do.
   */
  const explicitPrimaries = candidates.filter(({ asset }) =>
    asset.role?.evidenceLevel === 1 && isPrimaryRole(asset.role?.role));

  const preferred = container.preferredIndex ?? -1;
  const chosen = explicitPrimaries.length === 1
    ? explicitPrimaries[0].index
    : candidates.some(({ index }) => index === preferred)
      ? preferred
      : candidates.length === 1 ? candidates[0].index : -1;

  return all.map((asset, index) => {
    if (named[index]) {
      return {
        ...asset,
        role: secondaryRole(named[index]!, `the source names this image "${asset.reference}"`),
      };
    }
    if (labelled[index]) {
      // The source named this one's job. That statement stands as recorded.
      return asset;
    }
    if (index === chosen) {
      /**
       * A field the source NAMED keeps its own evidence.
       *
       * "The row's `Facade` column says so" (LEVEL 1) is a stronger and more
       * checkable statement than "the row contains one picture" (LEVEL 3), and
       * relabelling it as the weaker one threw away the only part of the record
       * that names the column a reader would go and look at.
       */
      if (asset.role?.evidenceLevel === 1 && isPrimaryRole(asset.role.role)) return asset;
      return { ...asset, role: roleFromStructuralContainer(container) };
    }
    // A named-hero asset that lost is still property imagery, just not the one.
    if (isPrimaryRole(asset.role?.role)) {
      const explicitWinner = explicitPrimaries.length === 1
        && chosen === explicitPrimaries[0].index;
      return {
        ...asset,
        role: secondaryRole('property_secondary',
          explicitWinner
            ? 'the row\'s own property-image field designates the listing image, so this '
              + 'one is kept as additional property imagery'
            : 'the source carries several photographs on this row and does not say which is '
              + 'the property\'s listing image'),
      };
    }
    return {
      ...asset,
      role: noPrimaryEvidence(
        candidates.length > 1
          ? 'the source carries several photographs on this row and does not say which is '
            + 'the property\'s listing image'
          : 'the source does not present this image as the property\'s listing image'),
    };
  });
}

// ---------------------------------------------------------------------------
// What may be stored
// ---------------------------------------------------------------------------

/**
 * The bucket's own ceiling (`builder-stock-images` is capped at 10 MB) and its
 * own allow-list. Stated here so the fetcher refuses before the upload does,
 * with a reason a human can read.
 */
export const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;

/** A 1×1 tracking pixel is a valid PNG. It is not a photograph of a house. */
export const MIN_SOURCE_IMAGE_BYTES = 512;

/**
 * Raster formats the bucket accepts, and nothing else.
 *
 * SVG is absent DELIBERATELY and must not be added: it is a document that can
 * carry script and remote references, and the marketplace serves these bytes
 * back to a browser.
 */
export const ALLOWED_SOURCE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

const EXTENSION_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * What the BYTES are, ignoring what the server said they were.
 *
 * A declared content type is a claim by whoever served the file; the signature
 * is evidence. HTML served as `image/jpeg` — an error page, a login wall — is
 * the ordinary way a fetched "image" turns out not to be one, and it is
 * rejected here rather than stored and shown to a client.
 */
export function sniffImageContentType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export type SourceImageCheck =
  | { ok: true; contentType: string; extension: string }
  | { ok: false; reason: string };

/**
 * May these bytes become a marketplace image?
 *
 * Signature first, then size. Nothing here trusts the URL's extension or the
 * response's content type: both are attacker-controlled on a link a builder
 * pasted, and neither is evidence about the bytes.
 */
export function validateSourceImageBytes(bytes: Uint8Array): SourceImageCheck {
  if (!bytes.length) return { ok: false, reason: 'That address returned nothing.' };
  if (bytes.length > MAX_SOURCE_IMAGE_BYTES) {
    return { ok: false, reason: 'That image is larger than the 10 MB limit.' };
  }
  const contentType = sniffImageContentType(bytes);
  if (!contentType) {
    return { ok: false, reason: 'That file is not an image we can display.' };
  }
  if (!ALLOWED_SOURCE_IMAGE_TYPES.has(contentType)) {
    return { ok: false, reason: 'That image format cannot be stored.' };
  }
  if (bytes.length < MIN_SOURCE_IMAGE_BYTES) {
    return { ok: false, reason: 'That image is too small to be a property photograph.' };
  }
  return { ok: true, contentType, extension: EXTENSION_FOR_TYPE[contentType] };
}

/** Filenames that are an image, for a link we have not fetched yet. */
export function looksLikeImageUrl(rawUrl: string): boolean {
  const withoutQuery = String(rawUrl ?? '').split(/[?#]/)[0];
  return /\.(jpe?g|png|webp|gif)$/i.test(withoutQuery);
}

/**
 * Where the stored copy lives.
 *
 * Keyed by the source's own reference rather than by position, so re-running
 * an import overwrites the same object instead of accumulating one per run.
 */
export function sourceImageObjectPath(
  organisationId: string,
  stockItemId: string,
  reference: string,
  extension: string,
): string {
  const stem = String(reference)
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-80) || 'source-image';
  return `${organisationId}/items/${stockItemId}/source/${stem}.${extension}`;
}

/**
 * Settle the roles of the pictures found INSIDE a document, per property.
 *
 * The office formats all state containment and nothing more: a drawing is
 * anchored to a spreadsheet row, a `<w:drawing>` sits in a table row, a picture
 * is on a slide. That is LEVEL 3 — the container designating this property's
 * image — and it holds only while the container designates ONE. A property's
 * section carrying a facade, a floorplan and a kitchen has stated which is
 * which only insofar as it NAMED them; where it named nothing, three
 * photographs is a choice the document did not make, and this does not make it
 * either.
 *
 * `container` is how the record will describe the relationship to a person.
 */
export function settleContainerMediaRoles(input: {
  media: Array<{ name: string; anchor?: string | null }>;
  /** The property each picture reached, index-aligned. Null is unattributed. */
  stockItemIds: Array<string | null>;
  /**
   * Whether the SOURCE stated each relationship, index-aligned — the
   * `structural` half of the attribution that produced `stockItemIds`.
   *
   * REQUIRED, BECAUSE THIS MODULE'S CLAIM DEPENDS ON IT. The role written for
   * a lone unnamed picture says "the container in the builder's own document
   * designates this image as its property image" — LEVEL 3, enough to reach a
   * card. That sentence is only true of an attribution the source actually
   * stated; written over a positional guess it laundered the guess into a
   * container designation nothing ever made. An attribution the caller
   * cannot vouch for as structural gets no primary here, whatever else is
   * true of it.
   */
  structural: boolean[];
  container: string;
}): SourceImageRoleAssignment[] {
  const media = input.media ?? [];
  const named = media.map((entry) => roleFromAssetName(entry.name));

  const byProperty = new Map<string, number[]>();
  media.forEach((_, index) => {
    const itemId = input.stockItemIds[index];
    if (!itemId || named[index]) return;
    const bucket = byProperty.get(itemId) ?? [];
    bucket.push(index);
    byProperty.set(itemId, bucket);
  });

  const primaries = new Set<number>();
  for (const indexes of byProperty.values()) {
    if (indexes.length === 1 && input.structural[indexes[0]]) primaries.add(indexes[0]);
  }

  return media.map((entry, index) => {
    if (named[index]) {
      return secondaryRole(named[index]!, `the source names this image "${entry.name}"`);
    }
    if (primaries.has(index)) {
      return roleFromStructuralContainer({
        container: entry.anchor ? `${input.container} (${entry.anchor})` : input.container,
        designation: 'property image',
      });
    }
    if (!input.stockItemIds[index]) {
      return noPrimaryEvidence(
        'the source did not tie this image to a property, so it is kept against the '
        + 'upload and shown against nobody');
    }
    if (!input.structural[index]) {
      return noPrimaryEvidence(
        'the source did not state this relationship itself, so nothing may present '
        + 'the image as the property\'s designated picture');
    }
    return noPrimaryEvidence(
      'the source places several photographs against this property and does not say '
      + 'which is its listing image');
  });
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface MediaAttribution {
  /** Null means "kept against the upload", which is a complete state. */
  stockItemId: string | null;
  /** Written to `source_detail.reason`, so the audit record says why. */
  reason: string;
  /** True when the SOURCE stated the relationship. */
  structural: boolean;
}

/**
 * Decide which property each embedded image belongs to.
 *
 * `anchors[i]` is what the container said about image `i` — the sheet row its
 * drawing is anchored to, the table row it sits in, the slide it is on — or
 * null when the format said nothing. `itemIdByAnchor` is the same vocabulary,
 * built from the rows that were actually imported.
 *
 * ATTRIBUTION IS FROM STRUCTURE, NEVER FROM COUNTS OR ORDERING. This used to
 * carry a fallback that paired image `i` with property `i` whenever the two
 * lists happened to be the same length — and "happened" is the word: the
 * media list is capped at forty, skips oversize and non-raster parts
 * silently, and was sorted lexicographically (`image10` before `image2`), so
 * the count coincidence could be MANUFACTURED by a truncation and the pairing
 * order was not even the document's. One twelve-lot deck with unanchored
 * photographs was enough to put lot 10's render on lot 2's card, badged
 * "Builder supplied", with the correct answer sitting unused in every
 * anchor. The one thing positional pairing ever asserted — that the source
 * stated a relationship — is exactly what it cannot assert.
 *
 * THE ORDERING FALLBACK IS ALSO SWITCHED OFF BY THE PRESENCE OF ANCHORS, NOT
 * ONLY BY THEIR RESOLUTION. A document that anchors its images DOES state
 * relationships, even when none of its anchors matched an imported row (a
 * deck whose properties came from prose rather than a table, a drawing
 * anchored to the spacer row above its property): falling back to counting
 * there would contradict the very structure the document supplied.
 *
 * WHAT REMAINS is the one case containment itself decides: a document that
 * stated no relationships anywhere and holds exactly ONE property. Every
 * image in that file is contained by that property's own document — the same
 * kind of claim a slide or a table row states, at document granularity — so
 * it is `structural`, and `rowCount` exists so a CALLER whose one-item list
 * is a subset of a larger document (the repair, which lists only re-matched
 * rows) cannot present a twelve-row file as a one-property one.
 */
export function attributeDocumentMedia(input: {
  anchors: Array<string | null>;
  itemIdByAnchor: Record<string, string>;
  itemIdsInOrder: string[];
  /**
   * How many property rows the DOCUMENT stated, where the caller knows it.
   * Defaults to the attribution list's own length, which is exact for the
   * import (it lists every imported row) and conservative for nobody.
   */
  rowCount?: number;
}): MediaAttribution[] {
  const { anchors, itemIdByAnchor, itemIdsInOrder } = input;
  const rowCount = input.rowCount ?? itemIdsInOrder.length;

  const anyAnchor = anchors.some((anchor) => !!anchor);
  const oneProperty = !anyAnchor && itemIdsInOrder.length === 1 && rowCount === 1;

  return anchors.map((anchor) => {
    const anchored = anchor ? itemIdByAnchor[anchor] : undefined;
    if (anchored) {
      return {
        stockItemId: anchored,
        reason: `anchored to ${anchor} in the source document`,
        structural: true,
      };
    }
    if (oneProperty) {
      return {
        stockItemId: itemIdsInOrder[0],
        reason: 'contained by the one property this document imported',
        structural: true,
      };
    }
    return {
      stockItemId: null,
      reason: anyAnchor
        ? 'the source anchors its images and did not anchor this one; kept against the upload'
        : 'the format stated no relationships between its images and its properties; '
          + 'kept against the upload',
      structural: false,
    };
  });
}
