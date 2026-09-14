/**
 * Builder stock — recovering the render out of a row's OWN package document.
 *
 * The last place a builder-supplied photograph can be, once a row has no cover
 * and no file property: the "Complete Package Pack" link the row itself
 * carries. On the live list that is a Google Drive folder shared by 44 rows —
 * so the link attributes nothing, and everything here is about what the
 * library NAMES:
 *
 *   the row      Lot 43 — Tringa Street, Sandpiper Estate … [Stradbroke 180]
 *   the folder   …/Tweed Heads Packages/Lot 43/
 *   the document Lot 43 - Stradbroke 180 - Property Package.pdf
 *   the image    page 1
 *
 * Each step must resolve to EXACTLY ONE candidate or the whole attempt is
 * abandoned. Nothing is ranked, nothing is scored, and there is no "closest
 * match" — an ambiguity is the source declining to say which property a
 * picture belongs to, and the honest answer to that is the existing fallback.
 *
 * SECURITY. Every retrieval goes through `fetchStockSource`: the existing SSRF
 * guard on the original URL and on every redirect hop, http(s) only, 25 MB
 * ceiling, per-hop and total timeouts, and no cookie, Authorization header,
 * Supabase key, builder session or Google credential of any kind — a folder
 * that is not shared publicly simply answers with a page that carries no
 * listing. Descent is bounded and downward only: no id is constructed or
 * followed outside the tree the row pointed at.
 */
import {
  driveDownloadUrl, driveFileId, driveFolderId, driveFolderUrl, driveRenditionUrl,
  isGoogleDriveHost,
  lotAndDesignFrom, parseDriveFolderListing, selectLotFolder, selectPackageDocument,
  selectNamedDocument, selectPropertyPhotograph, streetAddressFrom,
  type ScopedEntry,
  DRIVE_FOLDER_MIME, type DriveEntry,
} from './drivePackage.pure.ts';
import { type PdfPhotoProvenance } from './pdfSourcePhoto.ts';
import { runElection } from './pdfElectionClient.ts';
import { classifyBranch, sharedLinkFileUrl } from './sourceBranches.pure.ts';
import { readPdfPageTextResult } from './pdfText.ts';
import { MAX_SOURCE_IMAGE_BYTES, sniffImageContentType } from './sourceAssets.pure.ts';
import { PRIMARY_ROLE, type SourceImageRoleAssignment } from './sourceImageRole.pure.ts';

/** Folder listings one repair run may read. Shared and cached across rows. */
const MAX_LISTINGS_PER_RUN = 40;
/** How far below the linked folder a lot folder may be looked for. */
const MAX_DEPTH = 3;

export interface PackageFetcher {
  (url: string): Promise<{ bytes: Uint8Array; finalUrl: string }>;
}

/** The production fetcher, imported lazily so this module stays testable. */
const guardedFetch: PackageFetcher = async (url: string) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

/** Reads a folder at most once per run, whoever asks for it. */
export class DriveListingCache {
  private readonly entries = new Map<string, DriveEntry[]>();
  private reads = 0;

  constructor(private readonly fetchPackage: PackageFetcher) {}

  get listings(): number { return this.reads; }

  async list(folderId: string): Promise<DriveEntry[]> {
    const cached = this.entries.get(folderId);
    if (cached) return cached;
    if (this.reads >= MAX_LISTINGS_PER_RUN) return [];

    this.reads += 1;
    try {
      const { bytes } = await this.fetchPackage(driveFolderUrl(folderId));
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const listing = parseDriveFolderListing(html);
      this.entries.set(folderId, listing);
      return listing;
    } catch {
      // A folder that will not load is a folder we have nothing to say about.
      this.entries.set(folderId, []);
      return [];
    }
  }
}

export interface RecoveredPackageImage {
  bytes: Uint8Array;
  contentType: string;
  /** Names the document and the page, so the row records where it came from. */
  reference: string;
  /** The Drive file the image was taken out of. */
  documentName: string;
  documentUrl: string;
  /**
   * Everything needed to prove this picture came out of this document —
   * which page, which object, how big it was, what it hashes to, and whether
   * anything was done to it.
   */
  provenance: PdfPhotoProvenance;
  /** What the package presented this image as, and on what evidence. */
  role: SourceImageRoleAssignment;
}

/**
 * A photograph the builder FILED under this property, taken as it stands.
 *
 * Deliberately not a `RecoveredPackageImage`: that type's provenance is a PDF
 * page, an object number and a crop, and a JPEG sitting in a folder has none of
 * those. Recording a page number of 1 for a file that has no pages would make
 * the audit row say something untrue about where the picture came from, so this
 * carries what is actually known — the file, and the folders that attribute it.
 */
export interface RecoveredPackagePhotograph {
  bytes: Uint8Array;
  contentType: string;
  reference: string;
  fileName: string;
  fileUrl: string;
  /** Ancestor folders, outermost first. This is the attribution. */
  folderPath: string[];
  role: SourceImageRoleAssignment;
}

export type PackageOutcome =
  | { status: 'recovered'; image: RecoveredPackageImage }
  /** A photograph filed under this property, used as the file stands. */
  | { status: 'recovered_photograph'; photograph: RecoveredPackagePhotograph }
  /** The link was read and stated nothing that identifies this property. */
  | { status: 'not_identified'; detail: string }
  /** The link could not be read at all without credentials. */
  | { status: 'unreachable'; detail: string };

/**
 * How long one branch's recovery may run before it is answered for.
 *
 * WHY A DEADLINE AT ALL, MEASURED 6 SEPTEMBER 2026. Lot 709 Verve's brochure
 * elects in seconds through this exact pipeline on the same bytes, and in
 * production the claim that started it died ~85 seconds in with no error, no
 * kill status and no verdict — the isolate was simply shut down mid-item, and
 * the standing attempt read as a destroyed worker. Every step in here is
 * individually bounded (the fetch at 30 s total, the parse in single-digit
 * seconds) and the SUM was not: a dynamic import that never settles, a
 * response that stalls between chunks, a stream that neither ends nor errors
 * — any of them holds the awaiting item past the tick budget, and what kills
 * the worker then writes nothing down.
 *
 * 75 seconds: past every legitimate completion this pipeline has measured
 * (the heaviest live document finishes in under ten), inside the ~90-second
 * item budget, so the answer is written by US rather than by the reaper.
 *
 * A DEADLINE IS AN `unreachable`, NEVER AN INSPECTION. The document was not
 * read to the end, so nothing may be banked against it — `unreachable`
 * records nothing, retries on its own budget, and retires as a fact about
 * our access. The racer's loser keeps running to no effect: this function
 * writes nothing anywhere, so a late completion is a discarded value.
 */
export const RECOVERY_DEADLINE_MS = 75_000;

async function withRecoveryDeadline(
  work: Promise<PackageOutcome>,
  ms: number,
): Promise<PackageOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<PackageOutcome>((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'unreachable',
      detail: `The package could not be read inside ${Math.round(ms / 1000)} seconds, `
        + 'so this attempt records nothing about the document.',
    }), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find, fetch and extract the one image a row's own package document leads with.
 *
 * `label` is the row's own name — it carries both the lot and the house
 * design, and both have to appear on the document before it is accepted.
 *
 * The whole of it runs under `withRecoveryDeadline`, so a step that hangs
 * becomes an answer the caller can record instead of a worker the platform
 * reaps mid-claim.
 */
export async function recoverPackageImage(
  input: Parameters<typeof recoverPackageImageInner>[0],
  deps: Parameters<typeof recoverPackageImageInner>[1] & { deadlineMs?: number } = {},
): Promise<PackageOutcome> {
  return await withRecoveryDeadline(
    recoverPackageImageInner(input, deps),
    deps.deadlineMs ?? RECOVERY_DEADLINE_MS,
  );
}

async function recoverPackageImageInner(
  input: {
    packageUrl: string;
    label: string;
    /** The row's own building size, for telling two variants of one lot apart. */
    buildingSqm?: number | null;
    /**
     * The row's own house design, from the canonical `house_design` field.
     *
     * STRUCTURED, not parsed back out of `label`, for the reason `buildingSqm`
     * is: a discriminator the row states is a fact, and re-deriving it from a
     * display string is how the two come to disagree. A spreadsheet row carries
     * no bracketed design for `lotAndDesignFrom` to find, which is why the one
     * document that names the house was refused for not naming the lot.
     */
    design?: string | null;
    /**
     * The row's other identity names — its estate (`development_name`), its
     * project — for the cover rule's corroboration test alone. The display
     * label omits the estate whenever the row has a lot and a suburb, and the
     * builder's own cover corroborates by the estate at least as often as by
     * the suburb. See `pageStatesIdentity`, test 4.
     */
    identityHints?: string[] | null;
  },
  deps: {
    fetchPackage?: PackageFetcher;
    cache?: DriveListingCache;
    /**
     * How the package's prose is read, page by page.
     *
     * Injected for the same reason the fetcher is: the production reader
     * dynamically imports pdf.js from a CDN, which an offline test runner
     * cannot reach, and a rule nothing can exercise is a rule that drifts.
     */
    readPageTexts?: (bytes: Uint8Array) => Promise<string[]>;
  } = {},
): Promise<PackageOutcome> {
  const fetchPackage = deps.fetchPackage ?? guardedFetch;
  const cache = deps.cache ?? new DriveListingCache(fetchPackage);
  /*
   * An INJECTED reader is authoritative — a test that hands over page texts has
   * read them by definition. The production reader is the one that can fail to
   * load at all, so only it carries the distinction below.
   */
  const readPageTexts = deps.readPageTexts
    ? async (bytes: Uint8Array) => ({ ok: true as const, pages: await deps.readPageTexts!(bytes) })
    : readPdfPageTextResult;

  let host: string;
  try {
    host = new URL(input.packageUrl).hostname;
  } catch {
    return { status: 'not_identified', detail: 'The package link is not a web address.' };
  }

  const labelParts = lotAndDesignFrom(input.label);
  const lot = labelParts.lot;
  /*
   * The label's bracketed design where the label carries one, and the row's own
   * canonical `house_design` otherwise. A spreadsheet row has no brackets, so
   * before this the design was simply absent for every such row.
   */
  const design = labelParts.design ?? (String(input.design ?? '').trim() || null);

  if (!isGoogleDriveHost(host)) {
    /*
     * NOT DRIVE IS NOT UNREADABLE, and refusing here was banked as knowledge.
     *
     * PRODUCTION, 1 SEPTEMBER 2026. All thirteen brochures on the live stock
     * list are Dropbox shared links — `…/Lot-709-Verve.pdf?rlkey=…&dl=0` —
     * and every one was answered "That package is not on a source we can
     * read" before anything was fetched, then recorded as a finished
     * `no_deterministic_image`. Thirteen properties whose builder filed a
     * correct brochure were told their package named no image, and the
     * fallback ladder offered other companies' houses instead. Measured the
     * same day: each of those links serves the actual PDF (5–8 MB, `%PDF-`)
     * once asked for the file rather than the viewer, via the `dl=1`
     * parameter Dropbox itself publishes (`sharedLinkFileUrl`).
     *
     * So a link whose URL names a DOCUMENT is fetched and read exactly as a
     * Drive direct link is — same guarded fetcher, same PDF gate, same
     * cover-identification rules, and `direct_link` evidence, because a row
     * pointing at a file is not the file naming the property. Everything
     * else keeps the refusal: a bare page, a portal, a folder on a host with
     * no listing this pipeline can parse is still not a source we can read,
     * and saying so remains a finding rather than an error.
     */
    if (classifyBranch(input.packageUrl) === 'document') {
      return await extractFromDocument(
        fetchPackage, readPageTexts, sharedLinkFileUrl(input.packageUrl),
        documentNameFromUrl(input.packageUrl), input.label, 'direct_link', design,
        input.identityHints);
    }
    return { status: 'not_identified', detail: 'That package is not on a source we can read.' };
  }

  // A link straight to one document: the row named the file itself.
  const directFileId = driveFileId(input.packageUrl);
  if (directFileId) {
    return await extractFromDocument(
      fetchPackage, readPageTexts, driveDownloadUrl(directFileId), 'the linked document',
      input.label, 'direct_link', design, input.identityHints);
  }

  const rootId = driveFolderId(input.packageUrl);
  if (!rootId) {
    return { status: 'not_identified', detail: 'That package link names neither a folder nor a file.' };
  }
  if (!lot) {
    return { status: 'not_identified', detail: 'This property does not name a lot to look for.' };
  }

  const root = await cache.list(rootId);
  if (!root.length) {
    return { status: 'unreachable', detail: 'That package folder is not readable without signing in.' };
  }

  const lotFolderId = await findLotFolder(cache, root, lot);
  const entries = lotFolderId ? await cache.list(lotFolderId) : root;
  /*
   * A LIBRARY THAT FILES BY SUBJECT RATHER THAN BY LOT.
   *
   * Sandpiper's library keeps one folder per lot, which is what `findLotFolder`
   * looks for. Four live rows link a library that does the opposite: the folder
   * IS the property, and inside it are "Package", "Rental Appraisal" and "Area
   * Profile - Investment Report" — one folder per KIND of document. There is no
   * lot folder to find, the root holds only an estate-wide inclusions list, and
   * the property's own package sits one level down.
   *
   * So when no lot folder was found, the whole bounded subtree the search has
   * already read is offered to the same selector. It is not a wider search:
   * `findLotFolder` walked exactly these entries to conclude there was no lot
   * folder, so this costs no further listing, reaches nothing outside the folder
   * the row itself linked, and asks the identical question — one document, this
   * lot, this design, and of a kind that can be a package. Two candidates is
   * still the source declining to say, and the answer is still no image.
   */
  let document = selectPackageDocument(entries, { lot, design })
    ?? (lotFolderId
      ? null
      : selectPackageDocument(await subtreeEntries(cache, root), { lot, design }));

  /*
   * THE REST OF WHAT THE BUILDER ACTUALLY SENT.
   *
   * Everything above asks one question — which PDF names this lot and this
   * design — and on the live list it is the right question for nineteen rows
   * and the wrong one for four. Lot 1663 Ringer Street links two packages that
   * both name the lot, "(178 SqM)" and "(207 SqM)", so the count was two and
   * the answer was nothing, while the row itself says `building_size_sqm: 178`.
   * Lot 13 Hummock Rise links a folder whose every file is named by STREET
   * ADDRESS and whose "Property Photos" folder holds thirty-eight photographs
   * of the house; the lot token appears nowhere, and the card showed a Street
   * View of the road.
   *
   * These run ONLY where the rules above returned nothing, so no selection that
   * works today can change. Each is still the source naming the property, and
   * each still refuses on ambiguity.
   */
  const identity = { lot, street: streetAddressFrom(input.label), design };
  let photograph: ScopedEntry | null = null;
  if (!document) {
    const scope = lotFolderId ? entries : await subtreeEntries(cache, root);
    document = selectNamedDocument(scope, identity, input.buildingSqm);
    if (!document) {
      photograph = selectPropertyPhotograph(await scopedSubtree(cache, root), identity);
    }
  }

  if (photograph) {
    return await takePhotographAsFiled(fetchPackage, photograph);
  }

  if (!document) {
    return {
      status: 'not_identified',
      detail: lotFolderId
        ? 'No single document in that lot folder names this property.'
        : 'That folder names no document for this exact property.',
    };
  }

  return await extractFromDocument(
    fetchPackage, readPageTexts, driveDownloadUrl(document.id), document.name, input.label,
    'folder_structure', design, input.identityHints);
}

/**
 * Every entry inside THIS linked folder, to the same bounded depth the lot
 * search uses.
 *
 * DESCENT FROM THIS ROOT, NEVER A READ OF THE CACHE. The cache is shared by
 * every row in a run — that is what keeps forty-four rows pointing at one
 * library to a handful of requests — so taking "everything read so far" from it
 * would pull in folders belonging to OTHER properties. Two Cloverton rows are
 * exactly that: each links its own folder, each folder holds one document
 * naming its own lot, and reading the cache flat made the two look like two
 * candidates for one property and produced no image for either.
 *
 * So it walks down from this root and no further, exactly as `findLotFolder`
 * does. Every listing it asks for was asked for by that search first, so the
 * cache answers all of them and this costs no request.
 */
/**
 * Every entry inside the linked folder WITH the folders it sits under.
 *
 * `subtreeEntries` flattens, which is all a document selector needs — a file
 * that names the lot names it wherever it is. A photograph does not name
 * anything, so where the builder filed it IS its attribution, and the path has
 * to survive the walk. Same bound, same cache, same tree.
 */
async function scopedSubtree(
  cache: DriveListingCache,
  root: DriveEntry[],
): Promise<ScopedEntry[]> {
  const out: ScopedEntry[] = root.map((entry) => ({ entry, path: [] }));
  let level: ScopedEntry[] = out.slice();
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const folders = level.filter(({ entry }) => entry.mimeType === DRIVE_FOLDER_MIME);
    if (!folders.length) break;
    const next: ScopedEntry[] = [];
    for (const { entry, path } of folders) {
      for (const child of await cache.list(entry.id)) {
        next.push({ entry: child, path: [...path, entry.name] });
      }
    }
    out.push(...next);
    level = next;
  }
  return out;
}

async function subtreeEntries(
  cache: DriveListingCache,
  root: DriveEntry[],
): Promise<DriveEntry[]> {
  const all = [...root];
  let level = root;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const children = level
      .filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
      .map((entry) => entry.id);
    if (!children.length) break;
    const next: DriveEntry[] = [];
    for (const id of children) next.push(...await cache.list(id));
    all.push(...next);
    level = next;
  }
  return all;
}

/**
 * The one folder named for this lot, searched downward from the linked folder.
 *
 * Breadth-first and bounded: a library keeps its per-lot folders under a
 * "Packages" folder, and finding it is a descent inside the tree the row
 * linked — never a step outside it.
 */
async function findLotFolder(
  cache: DriveListingCache,
  root: DriveEntry[],
  lot: string,
): Promise<string | null> {
  let level = root;
  let levelIds: string[] = [];

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const hit = selectLotFolder(level, lot);
    if (hit) return hit;

    const children = level
      .filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
      .map((entry) => entry.id);
    if (!children.length) return null;

    const next: DriveEntry[] = [];
    levelIds = children;
    for (const id of levelIds) {
      next.push(...await cache.list(id));
    }
    level = next;
  }
  return null;
}

/**
 * Take the property's photograph out of one document.
 *
 * The finding and the downloading are this module's; everything that happens
 * to the bytes afterwards is `pdfSourcePhoto.ts`, which a directly uploaded
 * PDF goes through as well. One implementation, so a brochure reached through
 * a link and a brochure uploaded through the portal cannot disagree about
 * which picture is the property.
 */
/**
 * Take a photograph the builder filed under this property, exactly as it is.
 *
 * NO EXTRACTION AND NO INTERPRETATION. The bytes are the builder's own file;
 * nothing is cropped, re-encoded or classified here. The role is stated at
 * evidence level 3 because the ATTRIBUTION is structural — an ancestor folder
 * names this property — and not because anything looked at the picture.
 */
async function takePhotographAsFiled(
  fetchPackage: PackageFetcher,
  found: ScopedEntry,
): Promise<PackageOutcome> {
  const url = driveDownloadUrl(found.entry.id);
  let fetched: { bytes: Uint8Array; finalUrl: string };
  try {
    fetched = await fetchPackage(url);
  } catch {
    return { status: 'unreachable', detail: 'That photograph could not be downloaded.' };
  }
  if (!fetched?.bytes?.length) {
    return { status: 'unreachable', detail: 'That photograph came back empty.' };
  }

  /*
   * A BUILDER PHOTOGRAPHS AT FULL RESOLUTION, AND THE STORE HAS A CEILING.
   *
   * PRODUCTION, 28 AUGUST 2026. This function found exactly the right file —
   * "Display Home - 13 Hummock Rise Werribee/Property Photos/Kaye_7341_HR.jpg" —
   * downloaded a perfectly valid 12.28 MB JPEG, and `storeSourceImageBytes`
   * refused it against the 10 MB `MAX_SOURCE_IMAGE_BYTES`. The run logged "The
   * recovered photograph could not be stored", wrote no row, and the card fell
   * all the way to a Street View of the road. Every one of that folder's 38
   * photographs is 12-16 MB, so trying the next one is no answer at all.
   *
   * Drive will render the SAME FILE smaller, by its own id, for the cost of one
   * request. That is preferred over decoding and re-encoding 16 MB in here:
   * the worker has been killed for less, and a marketplace card is displayed at
   * a fraction of this width. If the rendition cannot be had, the original is
   * carried through unchanged and refused exactly as it is today — this can
   * rescue a photograph and can never lose one.
   */
  if (fetched.bytes.length > MAX_SOURCE_IMAGE_BYTES) {
    try {
      const smaller = await fetchPackage(driveRenditionUrl(found.entry.id, 1600));
      if (smaller?.bytes?.length && smaller.bytes.length <= MAX_SOURCE_IMAGE_BYTES) {
        fetched = smaller;
      }
    } catch {
      // Keep the original and let the store speak for itself.
    }
  }

  const where = [...found.path, found.entry.name].join('/');
  return {
    status: 'recovered_photograph',
    photograph: {
      bytes: fetched.bytes,
      contentType: found.entry.mimeType,
      reference: where,
      fileName: found.entry.name,
      fileUrl: url,
      folderPath: found.path,
      role: {
        role: PRIMARY_ROLE,
        evidenceLevel: 3,
        evidence: where,
        reason: 'The builder filed this photograph in a folder naming this property.',
      },
    },
  };
}

/** What the builder named the file, read from the link's own path. */
function documentNameFromUrl(rawUrl: string): string {
  try {
    const last = new URL(rawUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    const name = decodeURIComponent(last).trim();
    return name || 'the linked document';
  } catch {
    return 'the linked document';
  }
}

async function extractFromDocument(
  fetchPackage: PackageFetcher,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  /**
   * The document's own address — a Drive download URL, or the FILE form of a
   * shared link on an ordinary host. Built by the caller, because which host
   * publishes which download parameter is the caller's knowledge, not this
   * function's.
   */
  url: string,
  documentName: string,
  /** The property this package is supposed to be about. */
  label: string,
  /**
   * HOW THIS DOCUMENT CAME TO BE THIS PROPERTY'S.
   *
   * `folder_structure` means the builder's own library tied it to exactly one
   * stock row before anything was downloaded: one folder named for the lot, one
   * PDF in it naming that lot and that design, and `selectPackageDocument`
   * returning null for anything other than exactly one. That tie is what
   * licenses the structural cover below.
   *
   * `direct_link` means the row linked a file rather than a folder, so nothing
   * has been established about WHICH property the document is about except that
   * the row pointed at it — and on the live list one folder is shared by
   * forty-four rows, so pointing is not naming. Those documents must state
   * their property in text like everything else.
   */
  identifiedBy: 'folder_structure' | 'direct_link',
  /** The row's stated house design, for the design fallback. See
   * `findDesignCoverPages`. */
  design?: string | null,
  /** The row's other identity names, for the cover rule's corroboration
   * test alone. See `pageStatesIdentity`. */
  identityHints?: readonly string[] | null,
): Promise<PackageOutcome> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchPackage(url));
  } catch (error) {
    return {
      status: 'unreachable',
      detail: String((error as { safeMessage?: string })?.safeMessage ?? 'That document could not be retrieved.'),
    };
  }

  /**
   * NOT A PDF IS TWO DIFFERENT FACTS, AND CALLING BOTH `unreachable` STARVED
   * THE BRANCHES BEHIND THEM.
   *
   * A share that really does need a login answers with a sign-in page, and
   * `unreachable` is right for that: nothing was learned, nothing is written
   * down, and the same link may read perfectly well tomorrow.
   *
   * A link to an IMAGE is not that. It downloaded, it is exactly what the
   * builder filed, and there is nothing to come back for. But an `unreachable`
   * branch records no verdict, so `openBranches` returns it again next tick and
   * `openNow[0]` picks it again — for ever, with every branch behind it never
   * once tried.
   *
   * PRODUCTION, 31 AUGUST 2026. Upload `43ffa452` reopened 80 properties with
   * recovered links. Forty-nine of them stopped dead with `progressed: false`
   * in ~2.4 seconds a tick, having answered their `Brochure V002` and `Estate
   * Brochure` branches and never once reached the two behind them, because the
   * next open branch was a `Siting  / Masterplan` link — Lot 117's is a 169 KB
   * JPEG, Lot 607's a 29 KB WebP, both HTTP 200 — reported as "not publicly
   * downloadable" on every one of ten attempts.
   *
   * So an image answers `not_identified`, which is a finding and is banked: the
   * link was read, and a siting plan or masterplan filed as a bare image is not
   * a package document and states no cover page for this property. It is NOT
   * taken as the property's photograph — that is `takePhotographAsFiled`, and
   * what licenses it is a folder named for the lot. A `direct_link` establishes
   * nothing about WHICH property a file is about (one folder on the live list
   * is shared by forty-four rows), so promoting a pointed-at image would be
   * attribution by row position under another name.
   */
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-'
    && sniffImageContentType(bytes)) {
    return {
      status: 'not_identified',
      detail: 'That link is an image rather than a package document, so it presents no '
        + 'page as this property\'s package cover.',
    };
  }
  // A share that actually needs a login answers with a sign-in page.
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    return { status: 'unreachable', detail: 'That document is not publicly downloadable.' };
  }

  /**
   * The SAME rule a directly uploaded PDF goes through: the package's own cover
   * page — the one stating this property's identity with its package
   * information — and the one picture presented with them. A package reached
   * through a link and the same package uploaded through the portal must not be
   * able to disagree about which picture is the property.
   */
  /**
   * A DOCUMENT WE COULD NOT READ IS NOT A DOCUMENT THAT SAYS NOTHING.
   *
   * The cover page is found by matching the property's own label against each
   * page's prose, so with no prose no page can be recognised and the selector
   * returns nothing — indistinguishable, from here, from a brochure that
   * genuinely does not present this property. The reader loads pdf.js from a CDN
   * at call time and used to answer an empty array when that import did not
   * resolve, which is how 44 Sandpiper Estate properties came to be told their
   * packages named no image for them: not one of those documents had been read.
   *
   * So a reader that failed is `unreachable` — operational, retried, and never
   * recorded as a finding — and only a document that was actually read may
   * answer `not_identified`.
   */
  /*
   * AND THE HEAVY HALF IS ONE NAMED UNIT NOW.
   *
   * Everything above is cheap and stays here: the fetch and its guarded
   * fetcher, the `%PDF-` sniff, and the rule that a link to an IMAGE is not a
   * package document. What follows — the text read and the election over the
   * same bytes, inside one decode slot — is the one indivisible unit measured
   * to exceed an Edge Function's 2,000 ms CPU limit, and it is
   * `electFromPdfBytes`.
   *
   * The lift changed no behaviour: the same code, the same slot, the same
   * winners. What it buys is that the unit can be RUN where there is CPU for
   * it — see `electionRoute` for which of the two happens and why.
   */
  return await runElection(bytes, readPageTexts, {
    label, identifiedBy, design, identityHints, documentName, url,
  });
}
