/**
 * Builder stock — taking the property's photograph out of a PDF.
 *
 * ONE implementation, two callers. A package PDF reached through a Notion
 * row's own Drive link and a PDF a builder uploads straight into the portal
 * are the same problem once the bytes are in hand: which raster on which page
 * is the property, and can we prove it came from here. `packageImages.ts`
 * still owns finding and downloading a linked document; this owns everything
 * that happens to the bytes afterwards.
 *
 * It exists because the direct-upload path had NO answer at all. `extract.ts`
 * read a PDF's text and then warned the builder that its pictures were not
 * read and that imagery of the location would stand in for them — which
 * stopped being true the moment imagery of the location stopped being
 * displayable. A builder uploading their own brochure got a property with no
 * picture and a message promising one that could never appear. The sentence
 * itself is quoted, and forbidden, in `builderStockPdfSourceImages.test.ts`.
 *
 * WHAT IS TAKEN, AND WHAT IS REFUSED. Two ways, in order, and no third:
 *
 *   1. THE EMBEDDED ASSET. The page's own drawing instructions say where each
 *      picture is placed and how large it appears; every raster that could be a
 *      photograph is taken, byte for byte as the builder stored it.
 *   2. THE FLATTENED PAGE. When the whole page is one raster, the photograph
 *      is cut out of it — cropped, never generated — and re-encoded losslessly.
 *
 * Anything else returns nothing, and nothing means the card shows no image.
 *
 * WHICH OF THEM IS THE PROPERTY'S IMAGE IS NOT DECIDED HERE. It used to be —
 * "the largest photographic raster on the page, on the first page that has
 * one" — and that is a statement about rasters. It is why the live Lot 537
 * contract's card showed a bedroom: the bedroom is a large, detailed,
 * well-proportioned JPEG drawn across a full bleed, and a facade render half
 * its size on the package cover is not. The role a picture plays comes from
 * the document's own words, in `pdfPrimaryImage.pure.ts`.
 */
import {
  flattenedPageImageFrom, objectStreamSlices, pageOrderIsAuthoritative,
  parseImagePlacements, parseObjectStream, qualifyingPhotographsFrom, readPdfPage,
  resolveDrawnForms, resolveDrawnImages, selectPropertyPhotographFrom, widgetBaseMatrix,
  IDENTITY,
  type DrawnImage, type Matrix, type PdfScope, type PdfWidget,
} from './pdfPageImages.pure.ts';
import { documentVisualKinds } from './assessSourceImage.ts';
import { withPdfDecodeSlot } from './pdfDecodeSlot.pure.ts';
import {
  assignPdfMediaRoles, coverSearchPages, type PdfMediaPlacement,
} from './pdfPrimaryImage.pure.ts';
import { isolatePhotographBand } from './pdfFlattenedPhoto.pure.ts';
import { cropRows, encodePng, inflate, sha256Hex } from './rasterPng.ts';
import { validateSourceImageBytes } from './sourceAssets.pure.ts';
import {
  isPrimaryRole, noPrimaryEvidence, type SourceImageRoleAssignment,
} from './sourceImageRole.pure.ts';

/** Everything needed to prove a picture came out of a particular document. */
export interface PdfPhotoProvenance {
  /** 1-based, the way a person counts pages. */
  page: number;
  /** `embedded_raster` copies the asset out untouched; `page_crop` cuts a
   *  rectangle of the builder's own pixels out of a flattened page. */
  method: 'embedded_raster' | 'page_crop';
  objectNumber: number | null;
  resourceName: string | null;
  sourceWidth: number;
  sourceHeight: number;
  /** Hash of the bytes as they sit in the builder's document. */
  sourceSha256: string;
  /** Hash of what we stored. Equal to the above unless a crop happened. */
  storedSha256: string;
  crop: {
    top: number; bottom: number; left: number; right: number;
    pageWidth: number; pageHeight: number;
    distinctColours: number;
  } | null;
  /** Share of the page the picture covers, when the layout stated it. */
  pageAreaShare: number | null;
  /** What the transformation was, when there was one. */
  transformation: string | null;
}

export interface PdfPhoto {
  bytes: Uint8Array;
  contentType: string;
  provenance: PdfPhotoProvenance;
}

/** Pages a single document may be searched through for its lead photograph. */
const MAX_PAGES_SEARCHED = 12;
/** Form streams one page may have inflated. A cost guard, not a rule. */
const MAX_FORMS_PER_PAGE = 48;

/**
 * Every picture the page draws, wherever it is drawn FROM.
 *
 * A page rarely holds its own images. Every serious exporter emits the whole
 * layout as one form XObject and puts the pictures in the form's resources, so
 * a reader that stops at the page's own `/XObject` sees an empty brochure —
 * which is exactly what the live Donnybrook contract looked like. This
 * descends: each form's stream is inflated, interpreted under the matrix that
 * drew it, and its own pictures reported in PAGE coordinates.
 *
 * Names stay scoped to the resources that drew them, so `/X0` in one form and
 * `/X0` in another remain two different pictures.
 *
 * AND A PAGE SHOWS ITS WIDGETS TOO. A form field's appearance is not named by
 * the content stream and is not in the page's `/Resources` — it hangs off
 * `/Annots` — so a brochure filled from a template put its facade render
 * somewhere no reader here looked. `widgets` carries the visible ones and each
 * is descended exactly as a drawn form is, under the matrix that maps its
 * appearance onto the rectangle the page shows it in. See `PdfWidget`.
 */
async function collectDrawnImages(
  bytes: Uint8Array,
  scope: PdfScope,
  content: string,
  base: Matrix,
  depth: number,
  budget = { forms: 0 },
  widgets: readonly PdfWidget[] = [],
): Promise<DrawnImage[]> {
  const placements = parseImagePlacements(content, base);
  const out: DrawnImage[] = resolveDrawnImages(scope, placements);

  for (const widget of widgets) {
    if (budget.forms >= MAX_FORMS_PER_PAGE) break;
    budget.forms += 1;
    const raw = bytes.slice(widget.form.start, widget.form.end);
    let text: string;
    try {
      text = new TextDecoder('latin1').decode(widget.form.flate ? await inflate(raw) : raw);
    } catch {
      continue; // an appearance we cannot inflate simply contributes nothing
    }
    out.push(...await collectDrawnImages(
      bytes, widget.form, text, widgetBaseMatrix(widget), depth + 1, budget));
  }

  if (depth >= 4) return out;

  for (const { form, base: formBase } of resolveDrawnForms(scope, placements)) {
    if (budget.forms >= MAX_FORMS_PER_PAGE) break;
    budget.forms += 1;
    const raw = bytes.slice(form.start, form.end);
    let text: string;
    try {
      text = new TextDecoder('latin1').decode(form.flate ? await inflate(raw) : raw);
    } catch {
      continue; // a form we cannot inflate simply contributes nothing
    }
    out.push(...await collectDrawnImages(bytes, form, text, formBase, depth + 1, budget));
  }
  return out;
}

export interface RecoveredObjects {
  /** `objectNumber -> header`, for the objects the streams gave up. */
  objects: Map<number, string>;
  /**
   * How many of this document's object streams could NOT be read.
   *
   * Reported rather than swallowed because it is the difference between a
   * document that says nothing and a document we did not finish reading, and
   * `electFromPdfBytes` banks a permanent verdict on that distinction. A
   * stream still contributes nothing when it fails — a partially readable PDF
   * is worth reading — but the caller is now told it was partial.
   */
  unreadStreams: number;
}

/**
 * The objects a document hides inside compressed object streams.
 *
 * Read ONCE per document and handed to every page read, because a PDF 1.5+
 * writer puts the page tree itself in one and a reader that cannot see it
 * cannot put the pages in order. See `objectStreamSlices` for what that cost.
 *
 * A stream we cannot inflate contributes nothing rather than failing the
 * document: a partially readable PDF is still worth reading.
 */
export async function recoverCompressedObjects(
  bytes: Uint8Array,
): Promise<RecoveredObjects> {
  const recovered = new Map<number, string>();
  let unreadStreams = 0;
  let slices: ReturnType<typeof objectStreamSlices>;
  try {
    slices = objectStreamSlices(bytes);
  } catch {
    return { objects: recovered, unreadStreams };
  }

  for (const slice of slices) {
    const raw = bytes.slice(slice.start, slice.end);
    let text: string;
    try {
      text = new TextDecoder('latin1').decode(slice.flate ? await inflate(raw) : raw);
    } catch {
      unreadStreams += 1;
      continue;
    }
    /*
     * THE LAST GENERATION OF AN OBJECT IS THE LIVE ONE. An incrementally
     * updated PDF appends each revision after the one it replaces, so when
     * two object streams both carry object N, the LATER text is what the
     * document's xref would serve and the earlier is history. This used to
     * keep the FIRST — measured live, 2 September 2026, on the Watsons Reach
     * lot 102 brochure (five generations, twenty-one object streams): the
     * stale generation of the page dictionary mapped its images to the
     * TEMPLATE's sample artwork — another design's floor plan, labelled
     * LOT 414 — while the newest generation, never read, mapped the real
     * 1920x1080 facade render. The raw byte scan already lets the last
     * occurrence win; the recovered path has to agree, or which generation a
     * page gets depends on where the writer happened to put it.
     */
    for (const [number, header] of parseObjectStream(text, slice)) {
      recovered.set(number, header);
    }
  }
  return { objects: recovered, unreadStreams };
}

/**
 * The photograph ONE page of a PDF presents, or null.
 *
 * `pageIndex` is zero-based; the provenance reports the page 1-based.
 */
export async function extractPdfPagePhoto(
  bytes: Uint8Array,
  pageIndex: number,
  recovered: ReadonlyMap<number, string> = new Map(),
): Promise<PdfPhoto | null> {
  const page = readPdfPage(bytes, pageIndex, recovered);
  if (!page) return null;

  // The page's drawing instructions, inflated where the document compressed
  // them. Without them nothing can be said about what the page leads with.
  let content = '';
  for (const slice of page.contents) {
    const raw = bytes.slice(slice.start, slice.end);
    try {
      const decoded = slice.flate ? await inflate(raw) : raw;
      content += new TextDecoder('latin1').decode(decoded);
    } catch {
      /* an unreadable content stream simply contributes nothing */
    }
  }
  const drawn = await collectDrawnImages(
    bytes, page, content, IDENTITY, 0, { forms: 0 }, page.widgets);

  // (1) The photograph the layout leads with.
  const chosen = selectPropertyPhotographFrom(drawn, page.width, page.height);
  if (chosen) {
    const picture = await pictureFromStream(bytes, {
      start: chosen.image.start,
      end: chosen.image.end,
      flate: chosen.image.filters[0] === 'FlateDecode',
      width: chosen.image.width,
      height: chosen.image.height,
    });
    if (picture) {
      return {
        bytes: picture.bytes,
        contentType: picture.contentType,
        provenance: {
          page: pageIndex + 1,
          method: 'embedded_raster',
          objectNumber: chosen.image.objectNumber,
          resourceName: chosen.image.name,
          sourceWidth: chosen.image.width,
          sourceHeight: chosen.image.height,
          sourceSha256: picture.sourceSha256,
          storedSha256: picture.storedSha256,
          crop: null,
          pageAreaShare: Number(chosen.pageAreaShare.toFixed(4)),
          transformation: picture.transformation,
        },
      };
    }
  }

  // (2) A flattened page: cut the photograph out of the builder's own pixels.
  const flattened = flattenedPageImageFrom(drawn, page.width, page.height);
  if (!flattened) return null;

  /**
   * No guessing at the colour space. Cropping RGB bytes as if they were CMYK
   * shears the picture into stripes, and a plausible-looking wrong image is
   * exactly what this whole path exists to prevent.
   */
  const components = flattened.image.components;
  if (components !== 1 && components !== 3) return null;

  const pixels = await inflate(bytes.slice(flattened.image.start, flattened.image.end))
    .catch(() => null);
  if (!pixels) return null;

  const band = isolatePhotographBand(pixels, {
    width: flattened.image.width,
    height: flattened.image.height,
    components,
  });
  if (!band) return null;

  const cropped = cropRows(pixels,
    { width: flattened.image.width, height: flattened.image.height, components }, band);
  const png = await encodePng(cropped.pixels, {
    width: cropped.width, height: cropped.height, components,
  });
  if (!png) return null;

  const check = validateSourceImageBytes(png);
  if (check.ok !== true) return null;

  return {
    bytes: png,
    contentType: check.contentType,
    provenance: {
      page: pageIndex + 1,
      method: 'page_crop',
      objectNumber: flattened.image.objectNumber,
      resourceName: flattened.image.name,
      sourceWidth: flattened.image.width,
      sourceHeight: flattened.image.height,
      // The page as the builder stored it, and the rectangle taken out of it.
      sourceSha256: await sha256Hex(pixels),
      storedSha256: await sha256Hex(png),
      crop: {
        top: band.top,
        bottom: band.bottom,
        left: 0,
        right: flattened.image.width,
        pageWidth: flattened.image.width,
        pageHeight: flattened.image.height,
        distinctColours: band.distinctColours,
      },
      pageAreaShare: null,
      // Stated rather than hidden: the pixels are the builder's, the container
      // is ours, and the crop rectangle above reproduces it.
      transformation: 'cropped to the isolated photograph and re-encoded '
        + 'losslessly as PNG; no pixel values changed',
    },
  };
}

/**
 * The photograph a document presents, and the page it presents it on.
 *
 * DISCOVERY ONLY, and it must not be read as "the property's image". It is the
 * first page presenting a photograph, which is a fact about the file. What that
 * picture is FOR is settled by `selectPdfPropertyPrimary`; this is retained for
 * the flattened-page path and for callers that need to know a document has any
 * photograph in it at all.
 */
export async function extractExactSourcePhotoFromPdf(
  bytes: Uint8Array,
  options: { maxPages?: number } = {},
): Promise<PdfPhoto | null> {
  const { objects: recovered } = await recoverCompressedObjects(bytes);
  const limit = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES_SEARCHED, MAX_PAGES_SEARCHED));
  for (let index = 0; index < limit; index++) {
    const photo = await extractPdfPagePhoto(bytes, index, recovered);
    if (photo) return photo;
  }
  return null;
}

/**
 * The photograph EACH page presents, for a document that may hold several
 * properties.
 *
 * One entry per page that presents exactly one photograph; a page that
 * presents none is absent rather than null, because the caller attributes by
 * page number and an absent page attributes nothing.
 */
export async function extractPdfPhotosByPage(
  bytes: Uint8Array,
  options: {
    maxPages?: number;
    /**
     * The 1-based pages the caller actually wants, where it knows.
     *
     * WHY THIS EXISTS. The OCR path asks for a PAGE COUNT and then throws away
     * every page its plan did not want — measured 22 September 2026 on
     * `stress-many-images`: 4,408 ms spent rasterising SEVEN pages, of which
     * the plan wanted a subset, in a stage that is one of only two expensive
     * stages in the whole importer. Decompressing a page nobody will read is
     * the cheapest CPU in this pipeline to stop spending.
     *
     * Absent means "the first `maxPages`", which is exactly today's
     * behaviour — so no other caller changes.
     */
    pages?: readonly number[] | null;
  } = {},
): Promise<Array<{ page: number; photo: PdfPhoto }>> {
  const { objects: recovered } = await recoverCompressedObjects(bytes);
  const limit = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES_SEARCHED, MAX_PAGES_SEARCHED));
  const wanted = options.pages?.length
    ? new Set(options.pages.filter((page) => Number.isFinite(page) && page > 0))
    : null;
  const out: Array<{ page: number; photo: PdfPhoto }> = [];
  for (let index = 0; index < limit; index++) {
    if (wanted && !wanted.has(index + 1)) continue;
    const photo = await extractPdfPagePhoto(bytes, index, recovered);
    if (photo) out.push({ page: index + 1, photo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Asset discovery, and the role the SOURCE gave each asset
// ---------------------------------------------------------------------------

/** One picture the builder's document contains, and where it sits in it. */
export interface PdfSourceAsset {
  /** 1-based, the page a person sees when they open the file. */
  page: number;
  /** Identifies the raster within the document: object number and name. */
  key: string;
  bytes: Uint8Array;
  contentType: string;
  provenance: PdfPhotoProvenance;
  /** How the document placed it — the input the role decision reads. */
  placement: PdfMediaPlacement;
  /** What the source presented it as. Assigned only where a label is known. */
  role: SourceImageRoleAssignment;
}

interface RawCandidate {
  page: number;
  key: string;
  objectNumber: number | null;
  resourceName: string | null;
  width: number;
  height: number;
  start: number;
  end: number;
  flate: boolean;
  pageAreaShare: number;
  placementsOnPage: number;
  /** See `PdfMediaPlacement.drawn`. Null where the spaces cannot be compared. */
  drawn: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Every picture the document draws that could be a photograph, page by page,
 * in the document's OWN page order.
 *
 * Repetition is counted across the whole document, not just within a page,
 * because that is how a letterhead, a footer banner and a bleed wash announce
 * themselves — the same raster on page after page. Those are dropped here: a
 * rejection, not a selection, and the only kind of judgement a raster's
 * placement is entitled to make.
 */
async function discoverCandidates(
  bytes: Uint8Array,
  recovered: ReadonlyMap<number, string>,
  limit: number,
): Promise<{ kept: RawCandidate[]; pagesDrawnOn: Map<string, number> }> {
  const perPage: RawCandidate[] = [];
  const pagesDrawnOn = new Map<string, number>();

  for (let index = 0; index < limit; index++) {
    const page = readPdfPage(bytes, index, recovered);
    if (!page) break;

    let content = '';
    for (const slice of page.contents) {
      const raw = bytes.slice(slice.start, slice.end);
      try {
        content += new TextDecoder('latin1').decode(slice.flate ? await inflate(raw) : raw);
      } catch {
        /* an unreadable content stream simply contributes nothing */
      }
    }
    const drawn = await collectDrawnImages(
      bytes, page, content, IDENTITY, 0, { forms: 0 }, page.widgets);

    /*
     * Can a rectangle from this page's content stream be compared with a run
     * of text pdf.js read off the same page? Only where the box starts at the
     * origin and the page is not turned. See `PdfMediaPlacement.drawn`.
     */
    const comparable = page.origin.x === 0 && page.origin.y === 0 && page.rotate === 0;
    for (const candidate of qualifyingPhotographsFrom(drawn, page.width, page.height)) {
      const key = `${candidate.image.objectNumber}:${candidate.image.name}`;
      pagesDrawnOn.set(key, (pagesDrawnOn.get(key) ?? 0) + 1);
      perPage.push({
        drawn: comparable
          ? {
            x: candidate.placement.drawn.x, y: candidate.placement.drawn.y,
            width: candidate.placement.drawn.width,
            height: candidate.placement.drawn.height,
          }
          : null,
        page: index + 1,
        key,
        objectNumber: candidate.image.objectNumber,
        resourceName: candidate.image.name,
        width: candidate.image.width,
        height: candidate.image.height,
        start: candidate.image.start,
        end: candidate.image.end,
        flate: candidate.image.filters[0] === 'FlateDecode',
        pageAreaShare: candidate.pageAreaShare,
        placementsOnPage: candidate.placements,
      });
    }
  }

  const kept = perPage.filter((candidate) =>
    candidate.placementsOnPage <= 1 && (pagesDrawnOn.get(candidate.key) ?? 0) <= 1);
  return { kept, pagesDrawnOn };
}

/**
 * The picture an image XObject's stream holds, as a file.
 *
 * TWO WAYS A PDF CARRIES A PHOTOGRAPH, AND ONLY ONE OF THEM IS A FILE. A JPEG
 * placed in a document is stored as the JPEG — `/DCTDecode`, copy the bytes out
 * and you have the picture. A picture an exporter re-samples is stored as raw
 * pixels under `/FlateDecode`: inflating it yields SAMPLES, not a JPEG, not a
 * PNG, and nothing that reads image headers will recognise it.
 *
 * Only the first was handled here, and the second is not a rare shape — it is
 * how Lot 60434 Cloverton's package carries its facade. The document holds two
 * rasters: a 3508x4961 JPEG floor plan, which came out, and a 2400x1400 raw
 * render of the house, which did not. The page held one candidate, so the
 * flattened-page path did not apply either, and a card sat blank in front of a
 * clean builder photograph.
 *
 * SO RAW SAMPLES ARE WRAPPED, USING THE SAME ENCODER THE FLATTENED PATH USES.
 * `encodePng` is lossless, the crop path already stores its output, and the
 * hashes below record both sides of it: `sourceSha256` is what the document
 * holds, `storedSha256` is what we wrote, and the transformation is stated.
 *
 * NO COLOUR SPACE IS GUESSED. The component count is DERIVED — the inflated
 * length must divide the pixel count exactly, into one component or three.
 * CMYK, 16-bit and every predictor-filtered or subsampled layout fail that
 * division and are refused, because cropping or re-encoding samples under the
 * wrong interpretation produces a plausible-looking wrong picture, which is the
 * one outcome this whole module exists to prevent.
 */
async function pictureFromStream(
  bytes: Uint8Array,
  stream: { start: number; end: number; flate: boolean; width: number; height: number },
): Promise<{
  bytes: Uint8Array; contentType: string;
  sourceSha256: string; storedSha256: string; transformation: string | null;
} | null> {
  const raw = bytes.slice(stream.start, stream.end);
  const asset = stream.flate ? await inflate(raw).catch(() => null) : raw;
  if (!asset) return null;

  const direct = validateSourceImageBytes(asset);
  if (direct.ok === true) {
    const hash = await sha256Hex(asset);
    // Nothing was done to the bytes, so the two hashes are one hash.
    return {
      bytes: asset, contentType: direct.contentType,
      sourceSha256: hash, storedSha256: hash, transformation: null,
    };
  }
  if (!stream.flate) return null;

  const pixels = stream.width * stream.height;
  if (pixels <= 0 || asset.length % pixels !== 0) return null;
  const components = asset.length / pixels;
  if (components !== 1 && components !== 3) return null;

  const png = await encodePng(asset, {
    width: stream.width, height: stream.height, components,
  });
  if (!png) return null;
  const check = validateSourceImageBytes(png);
  if (check.ok !== true) return null;

  return {
    bytes: png,
    contentType: check.contentType,
    sourceSha256: await sha256Hex(asset),
    storedSha256: await sha256Hex(png),
    transformation: 'the document\'s own image samples re-encoded losslessly as PNG; '
      + 'no pixel values changed',
  };
}

async function materialise(
  bytes: Uint8Array,
  candidate: RawCandidate,
): Promise<{ bytes: Uint8Array; contentType: string; provenance: PdfPhotoProvenance } | null> {
  const picture = await pictureFromStream(bytes, candidate);
  if (!picture) return null;

  return {
    bytes: picture.bytes,
    contentType: picture.contentType,
    provenance: {
      page: candidate.page,
      method: 'embedded_raster',
      objectNumber: candidate.objectNumber,
      resourceName: candidate.resourceName,
      sourceWidth: candidate.width,
      sourceHeight: candidate.height,
      sourceSha256: picture.sourceSha256,
      storedSha256: picture.storedSha256,
      crop: null,
      pageAreaShare: Number(candidate.pageAreaShare.toFixed(4)),
      transformation: picture.transformation,
    },
  };
}

/**
 * Every builder-supplied picture in the document, each carrying the role the
 * SOURCE gave it — and, where the source designated one, the property's
 * primary image.
 *
 * `pageTexts[i]` is the text of visible page `i + 1` and `label` is the
 * property the document is about. Both are required for a primary: without the
 * text there is nothing to read a cover page out of, and without a label there
 * is no identity for a page to state. Absent either, every asset comes back
 * classified and none of them is primary — which is a correct outcome and the
 * one this whole module exists to make possible.
 *
 * THE PAGE ORDER HAS TO BE THE DOCUMENT'S OWN. Where the catalogue could not be
 * followed, "page 3" is the third-lowest object number rather than the third
 * page, and a rule that reads a page as a property's cover would be reading the
 * wrong page. That case yields no primary rather than a guess.
 */
export async function selectPdfPropertyPrimary(
  bytes: Uint8Array,
  options: {
    label?: string | null;
    pageTexts?: string[];
    maxPages?: number;
    /**
     * The page the CONTAINING DOCUMENT's own identification implies is this
     * property's cover, for a document that yielded no text at all.
     *
     * Passed only by a caller that tied the document to exactly one stock row
     * from the builder's folder structure before downloading it. See
     * `assignPdfMediaRoles`.
     */
    structuralCoverPage?: number | null;
    /**
     * The house design this row states, from the canonical `house_design`
     * field. Used only where no page named the property itself.
     */
    design?: string | null;
    /**
     * The row's other identity names — the estate, the project — for the
     * cover rule's corroboration test alone. See `pageStatesIdentity`.
     */
    identityHints?: readonly string[] | null;
  } = {},
): Promise<PdfPrimarySelection> {
  /*
   * THE WHOLE ELECTION HOLDS THE DECODE SLOT, discovery and classification
   * both — see `pdfDecodeSlot.pure.ts` for the five-way 546 this bounds. The
   * internal discovery call below goes to the unwrapped body, because a slot
   * taken twice by one caller is a deadlock, not a bound.
   */
  return withPdfDecodeSlot(() => selectPdfPropertyPrimaryHoldingSlot(bytes, options));
}

/**
 * WHY THE SELECTION SAYS WHICH PAGES IT LOOKED AT.
 *
 * A null `primary` has two opposite meanings and the caller could not tell
 * them apart: "no page of this document can be this property's cover" is
 * KNOWLEDGE about the document, and "a cover page was identified and nothing
 * could be decoded from it" is a fact about US. Banking the second as the
 * first retires a property permanently on a run that failed — which is what
 * happened to five properties on 18 September 2026, each of whose brochures
 * elects a facade on page 1 when the decode succeeds.
 *
 * `coverPages` is what `coverSearchPages` returned, so an empty list is the
 * document's own answer and a non-empty one with no decoded asset is ours.
 */
export interface PdfPrimarySelection {
  assets: PdfSourceAsset[];
  primary: PdfSourceAsset | null;
  /** The pages `coverSearchPages` named. Empty is the document's own answer. */
  coverPages: number[];
  pageOrderAuthoritative: boolean;
  /**
   * Object streams that could not be inflated.
   *
   * Carried up to the election because `pageOrderAuthoritative: false` has two
   * opposite causes and the caller cannot otherwise tell them apart: a
   * document whose catalogue genuinely names no page tree, and one whose page
   * tree sits in a stream we failed to read. The second is ours.
   */
  objectStreamsUnread: number;
}

/**
 * POSITIVE EVIDENCE THAT THE COVER'S RASTERS WERE ACTUALLY LOOKED AT.
 *
 * WHY THIS IS A NAMED PREDICATE AND NOT AN INLINE TEST. `coverPages.length > 0`
 * looks like it means "the cover was inspected" and does not: the interface
 * above says in as many words that a non-empty list with no decoded asset is
 * OURS. The two facts sit one field apart and read almost the same, so the
 * rule is stated once, here, beside the contract it reads — and every caller
 * that needs "did we really look?" asks this rather than assembling its own
 * answer out of the parts.
 *
 * IT IS THE EXACT NEGATION OF THE TWO OPERATIONAL RULES `pdfElection.ts`
 * ALREADY DRAWS, and it must stay that way:
 *
 *   `coverPages.length && !assets.length` — pages named, nothing decoded. A
 *   starved or failed raster step. Ours.
 *
 *   `coverPages.length && !pageOrderAuthoritative && objectStreamsUnread > 0`
 *   — a page tree we could not decompress. Ours.
 *
 * So this answers true only when a page WAS named, a raster from one of those
 * named pages WAS materialised, and no stream of the document went unread.
 * Anything less is a fact about this reading rather than about the document,
 * and a caller shortening a retry budget on it would be retiring a brochure
 * because we ran out of CPU.
 *
 * AN ASSET ON A PAGE THAT IS NOT A COVER PAGE DOES NOT COUNT. The decode is
 * scoped to the searched pages, so in practice they coincide; requiring the
 * page explicitly costs nothing and keeps the predicate true to its name if
 * that scoping ever widens.
 *
 * Pure: no IO, no clock. Reads the selection and nothing else.
 */
export function coverRastersInspected(selection: {
  assets: readonly { page?: number }[];
  coverPages: readonly number[];
  pageOrderAuthoritative: boolean;
  objectStreamsUnread: number;
}): boolean {
  const covers = selection?.coverPages ?? [];
  if (!covers.length) return false;
  if (!selection.pageOrderAuthoritative && Number(selection.objectStreamsUnread) > 0) {
    return false;
  }
  return (selection.assets ?? []).some(
    (asset) => typeof asset?.page === 'number' && covers.includes(asset.page));
}

/**
 * The election with the slot ALREADY HELD by the caller.
 *
 * Exported for `extractFromDocument`, which takes the slot once around the
 * whole heavy path — the text read as well as the election — so the two
 * stages of reading one document cannot be interleaved with another
 * document's. Taking the slot twice in one call stack is a deadlock, not a
 * bound, which is the entire reason this variant is separate from the
 * wrapper above.
 */
export async function selectPdfPropertyPrimaryHoldingSlot(
  bytes: Uint8Array,
  options: {
    label?: string | null;
    pageTexts?: string[];
    maxPages?: number;
    structuralCoverPage?: number | null;
    design?: string | null;
    identityHints?: readonly string[] | null;
  },
): Promise<PdfPrimarySelection> {
  /*
   * THE EXPENSIVE STEP IS TOLD WHERE TO LOOK.
   *
   * Which page can be this property's cover is decidable from the text, which
   * is already in hand and costs nothing; decoding a page's rasters is what
   * kills the worker on a heavy brochure. So the pages are chosen first and
   * only those are materialised. `coverSearchPages` returns a SUPERSET of what
   * `assignPdfMediaRoles` could choose (see its header), so this cannot remove
   * a page the decision would have used — and an empty answer means "no
   * opinion", which leaves the unscoped walk exactly as it was.
   */
  const searchPages = coverSearchPages({
    label: options.label ?? null,
    pageTexts: options.pageTexts ?? [],
    design: options.design ?? null,
    structuralCoverPage: options.structuralCoverPage ?? null,
    identityHints: options.identityHints ?? [],
  });
  /*
   * NO CANDIDATE PAGE MEANS NO ELECTION, SO NOTHING IS DECODED.
   *
   * `coverSearchPages` is a SUPERSET of every page `assignPdfMediaRoles` can
   * designate — the property covers, the design covers and the structural
   * page all come from it — so an empty answer here decides the outcome
   * before a byte of raster is touched: no page can be the cover, no picture
   * can be primary, and the caller records exactly the refusal it records
   * today.
   *
   * WHAT RUNNING ON ANYWAY COST, MEASURED 6 SEPTEMBER 2026. "EMPTY MEANS
   * EVERY PAGE" is the right reading for discovery's own callers, but through
   * THIS path it sent a document nothing could elect into a full-document
   * walk — materialising rasters, flattening pages, classifying pixels — and
   * on Lot 709 Verve's 13-page brochure that was ~2.6 s of the ~2.9 s total,
   * spent producing assets whose only fate was the refusal already decided
   * above. The worker died inside that waste on every attempt, faster than
   * any wall-clock deadline could answer for it, and the branch burned its
   * whole budget without one honest verdict. The same document now refuses
   * in ~0.3 s.
   */
  if (!searchPages.length) {
    const recovered = await recoverCompressedObjects(bytes);
    return {
      assets: [],
      primary: null,
      // The DOCUMENT's answer: no page of it can be this property's cover.
      coverPages: [],
      pageOrderAuthoritative: pageOrderIsAuthoritative(bytes, recovered.objects),
      objectStreamsUnread: recovered.unreadStreams,
    };
  }
  const found = await discoverPdfSourceAssetsHoldingSlot(bytes, {
    maxPages: options.maxPages,
    pages: searchPages,
  });

  /*
   * WHAT EACH PICTURE IS, before the election — and it has to be read HERE as
   * well as on the import path.
   *
   * "The same decision over the same inputs" is only true if both sides supply
   * the same inputs. When the visual gate was added it was wired into the
   * import alone, so a re-derivation re-elected exactly what it had elected
   * before: lots 109 and 115 Palomino came back out of the v14 reopen still
   * pointing at `page1:Im3`, the floor plan. This is the path a reopen runs
   * through, so this is the path that has to look.
   */
  const visualKinds = await documentVisualKinds(found.assets);

  // The SAME decision an upload and a repair make, over the same inputs.
  const roles = assignPdfMediaRoles({
    label: options.label ?? null,
    design: options.design ?? null,
    identityHints: options.identityHints ?? [],
    pageTexts: options.pageTexts ?? [],
    pageOrderAuthoritative: found.pageOrderAuthoritative,
    media: found.assets.map((asset) => asset.placement),
    visualKinds,
    structuralCoverPage: options.structuralCoverPage ?? null,
  });

  let primary: PdfSourceAsset | null = null;
  const assets = found.assets.map((asset, index) => {
    const settled = { ...asset, role: roles[index] };
    if (isPrimaryRole(settled.role.role)) primary = settled;
    return settled;
  });

  return {
    assets, primary, coverPages: searchPages,
    pageOrderAuthoritative: found.pageOrderAuthoritative,
    objectStreamsUnread: found.objectStreamsUnread,
  };
}

/** What `discoverPdfSourceAssets` read out of one document. */
export interface PdfSourceDiscovery {
  assets: PdfSourceAsset[];
  pageOrderAuthoritative: boolean;
  /** Object streams this document carries that could not be inflated. */
  objectStreamsUnread: number;
}

/**
 * Every builder-supplied picture in the document, with NO role assigned.
 *
 * Discovery is separated from attribution because they happen at different
 * moments: a PDF's pictures are read at extraction time, and which property the
 * document is about is only known once its prose has been read into rows. The
 * `placement` each asset carries is what lets the role be settled later without
 * the bytes being read a second time.
 */
export async function discoverPdfSourceAssets(
  bytes: Uint8Array,
  options: {
    maxPages?: number;
    /**
     * The pages worth DECODING, from `coverSearchPages`.
     *
     * Candidate discovery still walks the document — it reads drawing
     * instructions and is cheap — so `placementsOnPage` is counted over the
     * whole page exactly as before. What is scoped is `materialise`, which
     * decodes pixels, and the flattened-page crop, which rasterises one.
     *
     * EMPTY OR ABSENT MEANS EVERY PAGE. A caller with no opinion gets the walk
     * it has always had.
     */
    pages?: readonly number[];
  } = {},
): Promise<PdfSourceDiscovery> {
  // Same bound as the election: one document's buffers at a time per isolate.
  return withPdfDecodeSlot(() => discoverPdfSourceAssetsHoldingSlot(bytes, options));
}

async function discoverPdfSourceAssetsHoldingSlot(
  bytes: Uint8Array,
  options: {
    maxPages?: number;
    pages?: readonly number[];
  } = {},
): Promise<PdfSourceDiscovery> {
  const recovered = await recoverCompressedObjects(bytes);
  const authoritative = pageOrderIsAuthoritative(bytes, recovered.objects);
  const limit = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES_SEARCHED, MAX_PAGES_SEARCHED));
  const { kept } = await discoverCandidates(bytes, recovered.objects, limit);
  const only = options.pages?.length ? new Set(options.pages) : null;

  const assets: PdfSourceAsset[] = [];
  for (const candidate of kept) {
    if (only && !only.has(candidate.page)) continue;
    const made = await materialise(bytes, candidate);
    if (!made) continue;
    assets.push({
      ...made,
      page: candidate.page,
      key: candidate.key,
      placement: {
        page: candidate.page,
        name: candidate.resourceName,
        placementsOnPage: candidate.placementsOnPage,
        pagesDrawnOn: 1,
        // The cover's own statement of emphasis, carried to the role decision.
        pageAreaShare: candidate.pageAreaShare,
        // And where it sits, for the one question a page number cannot answer:
        // which of the properties on this page is it a picture of.
        drawn: candidate.drawn,
      },
      role: noPrimaryEvidence('the role of this image has not been settled yet'),
    });
  }

  /*
   * AND THE PAGES THAT ARE ONE PICTURE EACH.
   *
   * `discoverCandidates` reads a page's drawing instructions and takes the
   * rasters placed on it, which is right for a laid-out document and finds
   * NOTHING in a brochure exported as page images: there is no facade object to
   * take, because the facade, the type and the price panel are one 2480x3506
   * bitmap. "LOT 914 • COVELLA • GREENBANK QLD.pdf" is three such pages, and it
   * is the reason `pdfFlattenedPhoto.pure.ts` exists — a module written for this
   * exact document that nothing on this path could reach, because only the
   * legacy single-photo function called it.
   *
   * So a page that yielded no embedded candidate is offered to the flattened
   * path, which cuts the photograph out of the builder's own pixels and refuses
   * unless EXACTLY ONE band qualifies. Pages that yielded a candidate are left
   * alone: where the document placed its pictures properly, those pictures are
   * the answer and a crop of the whole page would be a worse one.
   */
  const pagesWithAssets = new Set(assets.map((asset) => asset.page));
  for (let index = 0; index < limit; index++) {
    const page = index + 1;
    if (only && !only.has(page)) continue;
    if (pagesWithAssets.has(page)) continue;
    const cut = await extractPdfPagePhoto(bytes, index, recovered.objects);
    if (!cut || cut.provenance.method !== 'page_crop') continue;
    assets.push({
      page,
      key: `page${page}:crop`,
      bytes: cut.bytes,
      contentType: cut.contentType,
      provenance: cut.provenance,
      placement: {
        page,
        name: cut.provenance.resourceName,
        // A crop is by construction the only thing taken from its page, and it
        // exists on no other, so it can never be the repeated artwork
        // `selectCoverHero` eliminates.
        placementsOnPage: 1,
        pagesDrawnOn: 1,
      },
      role: noPrimaryEvidence('the role of this image has not been settled yet'),
    });
  }

  return {
    assets,
    pageOrderAuthoritative: authoritative,
    objectStreamsUnread: recovered.unreadStreams,
  };
}
