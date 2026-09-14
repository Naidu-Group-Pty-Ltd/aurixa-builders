/**
 * Builder stock — reading the package a stock row links to.
 *
 * A row of the live Notion list carries one link of its own: "Complete Package
 * Pack", a Google Drive folder. Forty-four of the forty-five rows without a
 * cover point at the SAME folder, so the link alone attributes nothing — it is
 * an estate's document library, not a property's photograph.
 *
 * What makes attribution deterministic is that the library NAMES its contents:
 *
 *     Tweed Heads/Tweed Heads Packages/Lot 43/Lot 43 - Stradbroke 180 - Property Package.pdf
 *
 * and the stock row is "Lot 43 — Tringa Street, Sandpiper Estate … [Stradbroke
 * 180]". The folder names the lot and the file names the lot AND the house
 * design, which together are exactly one stock row. That is the source stating
 * the relationship, not us inferring one from a resemblance.
 *
 * THE RULES THIS MODULE ENFORCES:
 *   • EXACTLY ONE, or nothing. One folder named for the lot, one file naming
 *     that lot and that design. Two candidates is not a near miss — it is the
 *     source declining to say, and the answer is no image.
 *   • NOTHING OUTSIDE THE LINKED FOLDER. Descent is bounded and downward only;
 *     no id is ever constructed, guessed or followed out of the tree the row
 *     itself pointed at.
 *
 * Pure: no imports, no IO, no clock.
 */

/** One entry of a public Drive folder listing. */
export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive's public surfaces, and nothing else may be fetched as a package. */
export function isGoogleDriveHost(host: string): boolean {
  const clean = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return clean === 'drive.google.com' || clean === 'docs.google.com'
    || clean === 'drive.usercontent.google.com';
}

/** The folder a link points at, when it points at one. */
export function driveFolderId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!isGoogleDriveHost(url.hostname)) return null;
    const match = /\/(?:drive\/(?:u\/\d+\/)?folders|drive\/folders)\/([A-Za-z0-9_-]{10,})/
      .exec(url.pathname);
    if (match) return match[1];
    if (/\/(?:drive|open)\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('id');
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The single file a link points at, for a row that links a document directly. */
export function driveFileId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!isGoogleDriveHost(url.hostname)) return null;
    const match = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
    if (match) return match[1];
    if (url.pathname === '/uc' || url.pathname === '/open') {
      const id = url.searchParams.get('id');
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

export const driveFolderUrl = (id: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

/**
 * The public download address for a file.
 *
 * `uc?export=download` is what a logged-out browser follows from a shared
 * link. Nothing authenticated is involved, and a file that is not actually
 * shared answers with a sign-in page — which the byte check downstream refuses
 * as "not an image", rather than storing somebody's login screen.
 */
export const driveDownloadUrl = (id: string): string =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

/**
 * Decode the listing a public folder page carries.
 *
 * A shared Drive folder renders client-side, but the response embeds the
 * listing as `window['_DRIVE_ivd']` — a hex-escaped JSON array, which is what
 * the page's own script parses. This reads that JSON. NO SCRIPT IS EXECUTED
 * and nothing is fetched here; a folder that is not public carries no listing
 * and yields an empty array, which is the correct answer for it.
 */
export function parseDriveFolderListing(html: string): DriveEntry[] {
  const match = /window\['_DRIVE_ivd'\]\s*=\s*'((?:[^'\\]|\\.)*)'/.exec(String(html ?? ''));
  if (!match) return [];

  const decoded = match[1]
    .replace(/\\x([0-9a-fA-F]{2})/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : [];

  const out: DriveEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id = typeof row[0] === 'string' ? row[0] : '';
    const name = typeof row[2] === 'string' ? row[2] : '';
    const mimeType = typeof row[3] === 'string' ? row[3] : '';
    if (!id || !name || !mimeType) continue;
    // `&` and friends survive the hex unescaping above.
    out.push({ id, name: name.replace(/\\u0026/g, '&'), mimeType });
  }
  return out;
}

/** Punctuation, case and spacing removed to one space, so "LOT 43" = "Lot 43". */
export function normaliseDriveName(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A design name with the TENURE wording taken out of it.
 *
 * The stock list writes how a house is HELD — "[Bishop 258 Dual Occ]" — inside
 * the same bracket it writes the design in. The builder never does: the file is
 * "Lot 51 - Bishop 258 - Property Package.pdf" and its own cover reads "Bishop
 * 258, Mira facade" over "Dual key home, 4 + 2". The design and its number are
 * the part BOTH sides state; the tenure is one side's vocabulary for the
 * other's, and the two spellings share not a single token.
 *
 * WHY IT IS SHARED RATHER THAN COPIED. This was applied when choosing WHICH
 * document in the lot folder is a property's, and not when asking whether that
 * document's cover names the property — so nineteen Sandpiper rows selected
 * exactly the right package, opened it, reached the right page, and refused it
 * because the page does not contain the letters "occ". Choosing a document and
 * recognising its cover are the same question about the same label, and
 * answering them with two different readings of it is what left a blank card in
 * front of the builder's own photograph.
 *
 * It removes wording and never adds any, so nothing it touches can begin to
 * match a design it did not already match.
 */
export function withoutTenureWording(design: string): string {
  return String(design ?? '').replace(/\b(dual\s*occ(?:upancy)?|dual\s*key)\b/gi, ' ');
}

/**
 * The lot and the house design a stock row names.
 *
 * Both come from the row's own label — "Lot 43 - Tringa Street, Sandpiper
 * Estate, Tweed Heads South NSW 2486 [Stradbroke 180]". The bracketed design
 * is what distinguishes seven rows that share one lot, so a row without one is
 * identified by its lot alone and will only match a folder holding a single
 * document.
 *
 * "Dual Occ" / "Dual Key" are dropped by `withoutTenureWording`, for the reason
 * recorded there.
 */
export function lotAndDesignFrom(label: string): { lot: string | null; design: string | null } {
  const text = String(label ?? '');
  const lot = /(?:^|[^a-z0-9])lot\s*([0-9]{1,6}[a-z]?)\b/i.exec(text)?.[1] ?? null;

  const bracketed = /\[([^\]]{1,60})\]/.exec(text)?.[1] ?? '';
  const design = /([a-z][a-z' -]{2,24}\s+\d{2,4})/i.exec(withoutTenureWording(bracketed))?.[1]
    ?? null;

  return {
    lot: lot ? lot.toLowerCase() : null,
    design: design ? normaliseDriveName(design) : null,
  };
}

/**
 * The one folder in this listing that is named for this lot.
 *
 * Equality on the normalised name, never containment: "Lot 5" must not match
 * "Lot 51". Two folders with the same name — the live library has three called
 * "Lot 53" — is an ambiguity the source has to resolve, not us.
 */
export function selectLotFolder(entries: DriveEntry[], lot: string): string | null {
  const wanted = `lot ${normaliseDriveName(lot)}`;
  const hits = entries.filter((entry) =>
    entry.mimeType === DRIVE_FOLDER_MIME && normaliseDriveName(entry.name) === wanted);
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * The one document in this listing that names this lot AND this design.
 *
 * Both halves are required when the row states both, because a lot folder
 * holds one package per design and picking any of them for a row that named
 * one would be a guess. A row with no design matches only when the folder
 * holds exactly one document naming the lot.
 */
/**
 * What KIND of document a builder's own filename says this is.
 *
 * A package library holds several documents about one property, and only one of
 * them is the property package. Lot 914 Covella's folder is exactly that:
 *
 *   LOT 914 • COVELLA • GREENBANK QLD.pdf              the package
 *   OTP_Land_Contract_P1_-_Rana_-_Lot_914_Covella.pdf  a contract
 *   Rental Appraisal_ Lot 914, Covella Estate ….pdf    an appraisal
 *
 * All three name Lot 914, so a rule that asks only "which files name this lot"
 * finds three and correctly refuses — and a real facade the builder supplied
 * stays off the card for want of a question nobody asked.
 *
 * THIS IS DOCUMENT KIND, NOT IMAGE CONTENT. It reads the name the builder gave
 * the FILE to decide what the file is for; it makes no judgement about any
 * picture, and nothing here can promote or demote an image. That distinction is
 * why naming these words is legitimate where naming marketing words never is:
 * a contract is a contract because its author called it one.
 *
 * IT ONLY EVER EXCLUDES. A document is a package candidate unless its name
 * declares it something else — so a builder who names a package
 * "LOT 914 • COVELLA • GREENBANK QLD.pdf", with no word for what it is,
 * remains a candidate. Requiring the word "package" instead would have thrown
 * that exact file away.
 */
export type DriveDocumentKind = 'package_candidate' | 'contract' | 'appraisal' | 'reference';

/**
 * Words that declare a document to be something other than a property package.
 *
 * Each is a document TYPE a builder library holds beside its packages, and each
 * appears in the live folders. Deliberately narrow: anything not matched stays
 * a candidate, so the cost of an omission here is the behaviour this already
 * had, and the cost of a wrong entry is a package refused rather than a wrong
 * picture shown.
 */
const NOT_A_PACKAGE: ReadonlyArray<readonly [DriveDocumentKind, RegExp]> = [
  ['contract', /\b(contract|otp|offer to purchase|sale of land|conveyanc)/],
  ['appraisal', /\b(appraisal|valuation|rental assessment)/],
  ['reference', /\b(inclusion|specification|price list|pricelist|stocklist|stock list|acoustic|soil|survey|covenant|disclosure|brochure pack|investment report)/],
];

/** The kind a document's own name declares. Candidates are the default. */
export function driveDocumentKind(name: string): DriveDocumentKind {
  const clean = normaliseDriveName(name);
  for (const [kind, pattern] of NOT_A_PACKAGE) {
    if (pattern.test(clean)) return kind;
  }
  return 'package_candidate';
}

export function selectPackageDocument(
  entries: DriveEntry[],
  key: { lot: string; design: string | null },
): DriveEntry | null {
  const lotToken = `lot ${normaliseDriveName(key.lot)}`;
  const documents = entries.filter((entry) =>
    entry.mimeType !== DRIVE_FOLDER_MIME && entry.mimeType === 'application/pdf');

  const named = documents.filter((entry) => {
    const name = ` ${normaliseDriveName(entry.name)} `;
    if (!name.includes(` ${lotToken} `)) return false;
    return key.design ? name.includes(` ${key.design} `) : true;
  });

  /*
   * NARROWED BY KIND, AND ONLY WHERE IT HELPS.
   *
   * The kind filter runs on the documents that already name this property, and
   * its answer is taken only when it leaves EXACTLY ONE. Leaving two is the
   * library still declining to say which is the package; leaving none means
   * every candidate declared itself something else, and inventing a package out
   * of a contract is precisely what this must not do. Both fall through to the
   * unfiltered count, which is the behaviour that shipped — so this can turn a
   * refusal into a selection and can never turn one selection into another.
   */
  const packages = named.filter((entry) => driveDocumentKind(entry.name) === 'package_candidate');
  if (named.length !== 1 && packages.length === 1) return packages[0];
  if (named.length === 1) return named[0];

  /*
   * ONE LIBRARY MARKS ITS PACKAGE BY SUFFIXING THE FAMILY'S OWN NAME.
   *
   * PRODUCTION, 29 AUGUST 2026, Lot 209 Satinwood Crescent. Its folder holds
   * three documents naming that exact property:
   *
   *     Lot 209, 44 Satinwood Crescent Donnybrook VIC .pdf            candidate
   *     Lot 209, 44 Satinwood Crescent Donnybrook VIC _Inclusions.pdf reference
   *     Lot 209, 44 Satinwood Crescent Donnybrook VIC _package.pdf    candidate
   *
   * `named` is 3 and `packages` is 2, so both tests above fail and the folder
   * was reported as naming NO document for the property. The card fell through
   * to a Street View of the street — with the builder's own package sitting one
   * link away, in a file whose name is the word `package`.
   *
   * WHY "CONTAINS THE WORD PACKAGE" IS THE WRONG RULE, and was written here
   * first. Covella's folder is
   *
   *     LOT 914 • COVELLA • GREENBANK QLD.pdf          <- this IS the package
   *     OTP_Land_Contract_..._Lot_914_Covella.pdf
   *     Rental Appraisal_ Lot 914, Covella Estate.pdf
   *
   * so THERE the package is the BARE-named file, and a second document called
   * "Property Package" beside it would be a different document rather than the
   * same one marked. Two libraries, opposite conventions; a filename-word rule
   * cannot tell them apart, and would have fixed Satinwood by breaking
   * Covella — which is what the two tests that pin the Covella shape caught.
   *
   * THE DISCRIMINATOR IS THE FAMILY, NOT THE WORD. Satinwood's package name is
   * another candidate's name PLUS the marker: strike `package` out and the two
   * are one document family, one member of which the builder has labelled.
   * Covella's two names are not each other with a marker added — `lot 914
   * covella estate` is not `lot 914 covella greenbank qld` — so nothing there
   * has been marked and the refusal stands untouched.
   *
   * STRICTLY ADDITIVE. Reached only after both earlier tests decline, so every
   * folder that already resolved to a document resolves to the SAME document
   * and only a refusal can become a selection. It still demands the document
   * name this exact lot, still refuses anything the kind table calls a
   * contract, an appraisal or a reference, and still refuses when two members
   * of a family are both marked.
   */
  const marked = packages.filter((entry) => {
    const tokens = normaliseDriveName(entry.name).split(' ');
    if (!tokens.includes('package')) return false;
    const base = tokens.filter((token) => token !== 'package').join(' ');
    return packages.some(
      (other) => other !== entry && normaliseDriveName(other.name) === base);
  });
  if (marked.length === 1) return marked[0];

  return null;
}

// ---------------------------------------------------------------------------
// The rest of the builder's own material
//
// PRODUCTION, 28 AUGUST 2026. Everything above reads PDFs, and the live library
// does not only hold PDFs. Lot 13 Hummock Rise links a folder containing
//
//     Display Home - 13 Hummock Rise Werribee/Property Photos/
//         Kaye_7341_HR.jpg  … 38 photographs
//
// and the marketplace showed a Street View of the road, because
// `selectPackageDocument` filters `mimeType === 'application/pdf'` and the
// photographs were never candidates at all. The same row also failed the other
// half of the rule: this builder names its files by STREET ADDRESS — "Package -
// 13 Hummock Rise Werribee (995).pdf" — and the selector requires the literal
// token "lot 13", which appears nowhere in the folder.
//
// NOTHING BELOW WEAKENS ATTRIBUTION. Identity still comes from the source
// naming the property; what changes is that a street address counts as the
// source naming it, and that a photograph counts as a candidate. Two candidates
// is still the source declining to say.
// ---------------------------------------------------------------------------

/** Image types the pipeline can already store and serve. */
export const PACKAGE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp',
]);

export function isPackageImage(entry: DriveEntry): boolean {
  return PACKAGE_IMAGE_MIMES.has(String(entry?.mimeType ?? '').toLowerCase());
}

/**
 * Names that declare a picture to be something other than the house.
 *
 * The same shape as `NOT_A_PACKAGE` and for the same reason: it reads the name
 * the BUILDER gave the file, and it only ever EXCLUDES. A photograph called
 * "Kaye_7341_HR.jpg" says nothing and stays a candidate; "Master Plan.jpg" and
 * "Aerial Photo 1.jpg" say what they are.
 *
 * Yamanto's folder is the case that matters: five images, every one of them an
 * aerial or a plan, and the correct answer for Lot 3 is still no picture.
 * A rule that admitted them would have put a site plan on a client's card.
 */
const NOT_A_PROPERTY_PHOTOGRAPH = new RegExp(
  '\\b(aerial|site\\s*plan|master\\s*plan|masterplan|stage\\s*plan|lot\\s*plan'
  + '|floor\\s*plan|floorplan|elevation\\s*plan|subdivision|survey|contour'
  + '|logo|letterhead|map|locality|clubhouse|club\\s*house|sales\\s*office'
  + '|display\\s*suite|estate\\s*marketing|community|amenit|signage|render\\s*board)'
  // "Lot Plans" and "Site Plans" are the same declaration in the plural, and a
  // trailing \b after "plan" refuses them. Production's Yamanto folder holds
  // exactly "Lot Plans.jpg".
  + 's?\\b',
);

/** Does this file name declare itself to be something other than the house? */
export function isNonFacadeImageName(name: string): boolean {
  return NOT_A_PROPERTY_PHOTOGRAPH.test(normaliseDriveName(name));
}

/**
 * The street number and street name a stock row states.
 *
 * "Lot 13 - Hummock Rise, Werribee, VIC - 3030" gives 13 / "hummock rise", and
 * the builder's "Display Home - 13 Hummock Rise Werribee" states both. This is
 * the SAME kind of evidence the lot token is — the source naming the property —
 * expressed the way this builder writes it.
 *
 * The number is required. An address with no street number identifies a street
 * and not a house, and this repository has already paid once for merging on a
 * street name alone.
 */
export function streetAddressFrom(label: string): { number: string; street: string } | null {
  const text = String(label ?? '');
  // Take the part after a leading "Lot N -" so the lot number is never read as
  // the street number, then the first "<number> <words>" that follows.
  const lotPrefix = /^\s*lot\s*([0-9]{1,6})[a-z]?\s*[-–—,]?\s*/i.exec(text);
  const withoutLot = lotPrefix ? text.slice(lotPrefix[0].length) : text;

  const numbered = /(?:^|[^0-9a-z])([0-9]{1,5})[a-z]?\s+([a-z][a-z' -]{2,40}?)\s*(?:,|$|\bvic\b|\bnsw\b|\bqld\b|\bsa\b|\bwa\b|\bnt\b|\btas\b|\bact\b)/i
    .exec(withoutLot);
  if (numbered) {
    const street = normaliseDriveName(numbered[2]);
    if (street.length >= 3) return { number: normaliseDriveName(numbered[1]), street };
  }

  /*
   * A HOUSE-AND-LAND ROW STATES ITS STREET NUMBER AS THE LOT NUMBER.
   *
   * "Lot 13 - Hummock Rise, Werribee" has no separate street number because on
   * a new estate there is not one yet: the lot IS the number, and the builder
   * writes the finished address the same way — "Display Home - 13 Hummock Rise
   * Werribee". Reading the row's own convention is what ties the two together;
   * without it the folder naming this exact house matches nothing.
   */
  if (lotPrefix) {
    const bare = /^\s*([a-z][a-z' -]{2,40}?)\s*(?:,|$|\bvic\b|\bnsw\b|\bqld\b|\bsa\b|\bwa\b|\bnt\b|\btas\b|\bact\b)/i
      .exec(withoutLot);
    const street = bare ? normaliseDriveName(bare[1]) : '';
    if (street.length >= 3) return { number: normaliseDriveName(lotPrefix[1]), street };
  }
  return null;
}

/**
 * Does this name state THIS property?
 *
 * Either the source's lot token, or the exact street number and street name
 * together. Both are the source naming the property; neither is a resemblance.
 */
export function namesThisProperty(
  name: string,
  key: { lot: string | null; street: { number: string; street: string } | null },
): boolean {
  const clean = ` ${normaliseDriveName(name)} `;
  if (key.lot && clean.includes(` lot ${normaliseDriveName(key.lot)} `)) return true;
  if (key.street) {
    const { number, street } = key.street;
    if (clean.includes(` ${number} ${street} `)) return true;
  }
  return false;
}

/** Metres² a file name states, for telling two variants of one lot apart. */
export function buildingSizeFrom(name: string): number | null {
  const match = /(\d{2,4})\s*(?:sqm|sq m|m2|m²)/i.exec(String(name ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The candidate whose stated size is this property's.
 *
 * PRODUCTION. Lot 1663 Ringer Street links a folder holding
 * "(178 SqM) Lot 1663, Ringer Street, Lara, VIC 3212.pdf" and
 * "(207 SqM) Lot 1663, …", both naming the lot, so the selector saw two and
 * correctly refused — while the row itself carries `building_size_sqm: 178`.
 * The source states which one it is; nothing was reading it.
 *
 * Exactly one match, or nothing: two candidates claiming the same size is the
 * source declining to say, exactly as before.
 */
export function selectByBuildingSize(
  entries: DriveEntry[],
  buildingSqm: number | null | undefined,
): DriveEntry | null {
  const wanted = Number(buildingSqm);
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  const hits = entries.filter((entry) => {
    const stated = buildingSizeFrom(entry.name);
    return stated !== null && Math.round(stated) === Math.round(wanted);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Drive's own downscaled rendition of a file, by id.
 *
 * PRODUCTION, 28 AUGUST 2026. Lot 13 Hummock Rise's package holds 38
 * photographs and every one of them is too big to store: sampled at 12.28,
 * 14.55, 14.01, 13.77, 14.70, 14.45, 16.28, 15.99, 13.84 and 13.25 MB against
 * a 10 MB `MAX_SOURCE_IMAGE_BYTES`. The builder photographed the house at full
 * resolution, which is the correct thing for a builder to do.
 *
 * THE SAME FILE, NOT A DIFFERENT PICTURE. `thumbnail?id=…` is Drive rendering
 * the file it was given; the id is the file's own, so provenance is unchanged
 * and no other photograph is substituted. It is preferred over decoding and
 * re-encoding 16 MB inside the worker because that is precisely the CPU spend
 * this repository has already been killed by twice, and a marketplace card is
 * displayed at a fraction of this width anyway.
 */
export function driveRenditionUrl(id: string, width: number): string {
  const clean = String(id ?? '').trim();
  const px = Math.max(320, Math.min(Math.trunc(width) || 1600, 4096));
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(clean)}&sz=w${px}`;
}

/** A file together with the folder path it was found under, root first. */
export interface ScopedEntry {
  entry: DriveEntry;
  /** Ancestor folder names, outermost first. Empty at the linked folder itself. */
  path: string[];
}

/** The package documents in this listing that name this property. */
export function namedPackageCandidates(
  entries: DriveEntry[],
  identity: {
    lot: string | null;
    street: { number: string; street: string } | null;
    /**
     * THE DESIGN IS NEVER DROPPED.
     *
     * Widening WHICH names count as this property must not widen which
     * documents count as this row. Seven Sandpiper rows share Lot 43, and
     * "Lot 43 - Bishop 258" names that lot exactly as truly as "Lot 43 -
     * Stradbroke 180" does — so a rule that asked only "does this name the
     * property" would hand a Stradbroke row the Bishop package.
     */
    design?: string | null;
  },
): DriveEntry[] {
  return entries.filter((entry) => {
    if (entry.mimeType !== 'application/pdf') return false;
    if (!namesThisProperty(entry.name, identity)) return false;
    if (driveDocumentKind(entry.name) !== 'package_candidate') return false;
    if (!identity.design) return true;
    return ` ${normaliseDriveName(entry.name)} `.includes(` ${identity.design} `);
  });
}

/**
 * The one document this property's own source names, where the lot token alone
 * could not decide.
 *
 * Two additions, both of them the SOURCE speaking rather than us inferring:
 * a street address counts as naming the property, and where several packages
 * name it the row's own building size picks between them. Everything else is
 * unchanged — one candidate or nothing.
 */
export function selectNamedDocument(
  entries: DriveEntry[],
  identity: {
    lot: string | null;
    street: { number: string; street: string } | null;
    design?: string | null;
  },
  buildingSqm?: number | null,
): DriveEntry | null {
  const candidates = namedPackageCandidates(entries, identity);
  if (candidates.length === 1) return candidates[0];
  return selectByBuildingSize(candidates, buildingSqm);
}

/**
 * The photograph the builder filed under this property.
 *
 * IDENTITY COMES FROM THE FOLDER, NOT THE FILE NAME. "Kaye_7341_HR.jpg" states
 * nothing about which house it is, and no filename rule could make it. What
 * states it is where the builder PUT it:
 *
 *     Display Home - 13 Hummock Rise Werribee/Property Photos/Kaye_7341_HR.jpg
 *
 * — an ancestor folder naming this exact property. That is the same class of
 * evidence as a document naming the lot, and it is why a shared library cannot
 * leak: Yamanto's five images sit at the root of a folder three lots share, no
 * ancestor names any one of them, and the answer stays no picture.
 *
 * The name is still read, but only to REJECT: an aerial, a site plan or a logo
 * is not a facade however confidently it is filed.
 */
export function selectPropertyPhotograph(
  scoped: ScopedEntry[],
  identity: { lot: string | null; street: { number: string; street: string } | null },
): ScopedEntry | null {
  const usable = scoped.filter(({ entry, path }) =>
    isPackageImage(entry)
    && !isNonFacadeImageName(entry.name)
    && !path.some((folder) => isNonFacadeImageName(folder))
    && (path.some((folder) => namesThisProperty(folder, identity))
      || namesThisProperty(entry.name, identity)));
  if (!usable.length) return null;

  /*
   * DETERMINISTIC, NOT CLEVER. Nothing here can tell a front elevation from a
   * side one — the builder's own numbering is a camera roll — so the choice is
   * the source's own order, stably. Guessing an angle from "7341" would be the
   * filename-hint mistake this repository has already made once.
   */
  return usable.slice().sort((a, b) =>
    a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id))[0];
}
