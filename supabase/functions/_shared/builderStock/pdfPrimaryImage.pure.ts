/**
 * Builder stock — WHICH page of a PDF is the property's cover, and which
 * picture on it is the hero.
 *
 * This is LEVEL 2 of `sourceImageRole.pure.ts` for a paginated document, and it
 * is the half the pipeline never had. `pdfPageImages.pure.ts` finds every
 * picture a page draws and rejects the ones that cannot be photographs;
 * everything after that used to be "the largest one, on the first page that has
 * one", which is a statement about rasters and never about the property.
 *
 * WHAT IT COST. The live Lot 537 Kirramingly Avenue contract has, on the page a
 * person opens first, the lot and street, the estate, the house design, the
 * fixed contract price, the land and build sizes, and one large facade render.
 * On its third page it has "INCLUSIONS" and a bedroom. The old rule reached the
 * third page and took the bedroom, because the bedroom is 2202×1229 and the
 * page draws it across the full bleed. Both pictures are the builder's; only
 * one of them is what this property looks like from the street.
 *
 * THE RULE, AND IT ONLY EVER ANSWERS FROM THE DOCUMENT'S OWN WORDS:
 *
 *   1. A page is a PROPERTY COVER when it states the property's IDENTITY — the
 *      lot, address or reference the row was imported under — together with its
 *      PACKAGE INFORMATION: a price, a configuration, a land or build size, a
 *      contract or package heading. Identity alone is not enough (a floorplan
 *      page repeats the lot) and package facts alone are not enough (an
 *      inclusions page quotes prices).
 *   2. The hero is the ONE candidate picture on that page which the page does
 *      not draw more than once and which no other page of the document also
 *      draws. Repetition is the document telling us a picture is furniture — a
 *      bleed wash, a banner, a letterhead — and furniture is never one
 *      property's listing image.
 *   3. Anything else — no cover page, no surviving candidate, or two of them —
 *      is NO PRIMARY. Not the biggest, not the first, not the most detailed.
 *
 * Nothing here reads a page NUMBER as meaningful. Page one is not privileged;
 * the cover of a package is wherever the package puts it, and a document whose
 * page order we could not establish is refused outright rather than counted.
 *
 * Pure: no imports beyond the role vocabulary and the label reading it shares
 * with `drivePackage.pure.ts`, no IO, no clock.
 */
import { mayLeadCard, type VisualKind } from './sourceImageVision.pure.ts';
import { withoutTenureWording } from './drivePackage.pure.ts';
import {
  noPrimaryEvidence, roleFromAssetName, roleFromDesignCover, roleFromPropertyCover,
  secondaryRole,
  type SourceImageRoleAssignment,
} from './sourceImageRole.pure.ts';

/** What made a page the property's cover. Recorded, never inferred. */
export interface PropertyCoverEvidence {
  /** 1-based, the way a person counts pages. */
  page: number;
  /** The property identity the page stated. */
  identity: string;
  /** The package facts it stated alongside. */
  packageFacts: string[];
  /**
   * Design covers only: the page designates some lot (any lot). A specimen
   * page and the design's own page are both evidence about the design, but
   * they are not equal — see `resolveDesignCover`.
   */
  lotDesignated?: boolean;
}

/**
 * Package information a property's own cover states.
 *
 * Each is a fact about the DEAL rather than about the building, which is what
 * separates a package cover from a floorplan page that repeats the lot number
 * and from a gallery page that repeats the address.
 */
const PACKAGE_FACTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a package price', /(?:\$|aud\s*)\s?\d{1,3}(?:[, ]\d{3})+(?:\.\d{2})?/i],
  ['a contract or package heading', /\b(fixed\s*price\s*contract|price\s*contract|house\s*(?:and|&|\+)\s*land|package|single\s*contract|two\s*part\s*contract|turnkey|build\s*contract|hia\s*contract)\b/i],
  ['a land or build size', /\b(land\s*size|build\s*size|lot\s*size|house\s*size|floor\s*area|\d{2,4}\s*m\s*2|\d{2,4}\s*sqm)\b/i],
  ['a bedroom/bathroom/car configuration', /\b\d\s*(bed|bedroom|bath|bathroom|car|garage)s?\b/i],
  ['a title or completion date', /\b(title\s*reg|titled|registration|est(?:imated)?\.?\s*completion|handover)\b/i],
  ['a lot dimension', /\b(lot\s*width|lot\s*length|frontage)\b/i],
];

/** Tokens of a label, in order, punctuation and case removed. */
function tokenise(value: string): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

/**
 * How much of the property's label a page must repeat to be naming it.
 *
 * The same set-matching `pdfRowAnchors.pure.ts` uses and for the same reason: a
 * PDF breaks lines wherever the layout did, so "Lot 537 Kirramingly Avenue,
 * Donnybrook" arrives as three fragments. Requiring several tokens keeps
 * "Lot 5" from matching every page that mentions a five.
 */
const MIN_IDENTITY_TOKENS = 2;
const MAX_IDENTITY_TOKENS = 8;

/**
 * The lot or unit numbers a piece of text designates.
 *
 * "Lot 51", "LOT 914", "Unit 3" — the word and the number that follows it. This
 * is the one token in a property's label that DISCRIMINATES: an estate's
 * documents all repeat the estate, the suburb and the state, and only the lot
 * number says which house.
 */
function lotDesignations(value: string): string[] {
  const tokens = tokenise(value);
  const found: string[] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] !== 'lot' && tokens[index] !== 'unit') continue;
    const next = tokens[index + 1];
    if (/^\d{1,5}$/.test(next)) found.push(next);
  }
  return found;
}

/**
 * A lot designation as a PAGE actually typesets it: the first digit token
 * after "Lot"/"Unit", and the whole run of digit tokens fused back together.
 *
 * WHY THE FUSED READING EXISTS. A PDF's text layer breaks a number wherever
 * the exporter placed its glyph runs, and the lot number itself is not
 * exempt. Measured live, 2 September 2026, on the Watsons Reach list: the
 * supplied brochure for lot 103 extracts as "2 1 Lot 10 3 Watsons Reach
 * Estate" — the page a person reads says "Lot 103", the token stream says
 * "Lot 10" then "3", and the strict reading refused the builder's own
 * document as being about some other lot. The sibling brochure for lot 102
 * survived only because its digits happened to land in one run. How an
 * exporter SPLIT a number is typography, not evidence about the property.
 *
 * WHY BOTH READINGS TRAVEL, AND HOW THEY ARE SPENT. A run counts as OUR lot
 * when either reading matches the label's lot, and as ANOTHER lot only when
 * neither does — so "Lot 104" still contradicts lot 103 (strict 104, fused
 * 1042-with-a-trailing-bath-count, neither ours), while "Lot 10 3" stops
 * reading as a foreign lot 10 on lot 103's own document. The deliberate
 * trade-off: a page genuinely about lot 10 whose next token is a bare "3"
 * (say a bedroom count) would read as lot 103's too — but this test only
 * ever CONFIRMS a document the row itself supplied, the corroboration,
 * package-fact and single-hero tests still stand behind it, and refusing
 * every brochure whose number the exporter split is the measured, recurring
 * loss. The label side stays strict: labels are our own strings, and nothing
 * splits them.
 */
interface LotReading { strict: string; fused: string }

function lotDesignationReadings(value: string): LotReading[] {
  const tokens = tokenise(value);
  const found: LotReading[] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] !== 'lot' && tokens[index] !== 'unit') continue;
    const first = tokens[index + 1];
    if (!/^\d{1,5}$/.test(first)) continue;
    let fused = first;
    for (let next = index + 2; next < tokens.length; next++) {
      if (!/^\d{1,5}$/.test(tokens[next])) break;
      if (fused.length + tokens[next].length > 5) break;
      fused += tokens[next];
    }
    found.push({ strict: first, fused });
  }
  return found;
}

/**
 * The design or product a label names in brackets — "[Miami 190]".
 *
 * The SECOND discriminator, and on the live list it is the only one that
 * separates seven stock rows from each other: Lot 51 carries Miami 190, Miami
 * 196, Stradbroke 180, Stradbroke 197, Bishop 258, Bravo 217 and Echo 236, all
 * at the same address and the same lot. A rule that ignored it would let one
 * design's cover be served for another design's row.
 */
function designTokens(label: string): string[] {
  const bracketed = String(label ?? '').match(/\[([^\]]{1,60})\]/g) ?? [];
  /*
   * READ THE SAME WAY THE DOCUMENT WAS CHOSEN. `lotAndDesignFrom` drops the
   * tenure wording the stock list puts in this bracket, because the builder's
   * own file and its own cover never carry it — so requiring it here refused
   * the very document that reading had just selected. See
   * `withoutTenureWording`.
   */
  return bracketed.flatMap((part) => tokenise(withoutTenureWording(part)));
}

/**
 * Does this page state that it is about THIS property?
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. The rule used to be "every one of
 * the label's first eight tokens appears on the page", and it is the reason
 * twenty-five live properties show no photograph. The label comes from the
 * stock list — "Lot 51 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW
 * 2486 [Miami 190]" — and the builder's own package cover for that exact
 * property says "Lot 51, Sandpiper Estate, Tweed Heads NSW · Miami 190,
 * Spectral façade". It names the lot, the estate, the suburb, the state and the
 * design. It does not name the STREET, and it writes "Tweed Heads" where the
 * list writes "Tweed Heads South". So `tringa` and `street` are missing, the
 * conjunction fails, and a page that could not identify the property more
 * plainly is refused.
 *
 * Demanding every token is not strictness, it is a demand that two independent
 * documents word an address identically — which nothing makes them do. What
 * actually needs to hold is that the page IDENTIFIES this property and
 * CONTRADICTS nothing about it, and those are the four tests below:
 *
 *   1  THE LOT IS STATED. The label's lot or unit number must appear on the
 *      page as a lot or unit designation. This is the discriminator; without it
 *      there is no identification at all.
 *
 *   2  NO OTHER LOT IS STATED. Every lot the page designates must be this
 *      property's. A page naming Lot 52 is not Lot 51's cover however much of
 *      the rest it shares, and this is what makes relaxing (1)'s neighbours
 *      safe rather than sloppy.
 *
 *   3  THE DESIGN IS STATED, when the label names one. Seven rows share Lot 51
 *      and differ only here, so this is the difference between attributing a
 *      picture and guessing.
 *
 *   4  SOMETHING ELSE CORROBORATES. At least one further label token — the
 *      estate, the suburb, the street where the document does name it — must
 *      appear, so a bare "Lot 51" on an unrelated page cannot qualify.
 *
 *      THE CORROBORATION POOL IS THE ROW'S IDENTITY, NOT THE LABEL'S SUBSET
 *      OF IT. The label is a short display string, and `stockRecordLabel`
 *      includes the estate only when the row has nothing else to show — so a
 *      label can read "Lot 102, Diggers Rest" for a row whose own
 *      `development_name` is "Watsons Reach". Measured live, 2 September
 *      2026: that row's supplied brochure states "Lot 102 Watsons Reach
 *      Estate" beside its package price, which is how house-and-land
 *      marketing writes identity — the estate, not the suburb — and this
 *      test refused it for not saying "Diggers Rest". A builder's own
 *      brochure, fetched and read, became a blank card. So the caller passes
 *      the row's remaining identity names as HINTS, and a hint token counts
 *      as corroboration exactly as a label token does. Hints are spent on
 *      this test and nowhere else: they cannot substitute for the lot,
 *      cannot excuse a page naming another lot, and never touch the
 *      full-conjunction path below — every page accepted without hints is
 *      still accepted, and no test gets weaker than it was.
 *
 * A label with no lot or unit number keeps the OLD conjunction exactly, because
 * for those rows the tokens are all there is and there is no discriminator to
 * lean on. Nothing about this is a similarity score: every test is a statement
 * the document either makes or does not make.
 */
function pageStatesIdentity(
  pageText: string,
  label: string,
  identityHints: readonly string[] = [],
  /**
   * Did the whole document produce exactly ONE property?
   *
   * Rule 2 below refuses a page that names any lot other than ours, and for a
   * document listing MANY properties that is right: two lots on one page is
   * the document declining to say whose page it is, and a guess becomes
   * somebody else's house on a client's card.
   *
   * With exactly one property there is no other property IN THIS DOCUMENT to
   * mis-attribute to, so a second lot number is context rather than a
   * competitor. MEASURED 11 SEPTEMBER 2026 on `LOT 27 - ZIMI - FLYER.pdf`: a
   * single-property flyer whose page 1 reads "Lot 27" beside "LOT 32, 33, 34"
   * — neighbouring lots on the estate's own site plan. Rule 2 fired, the page
   * was refused as a cover, and the flyer's render never reached the card.
   *
   * Same principle, same document shape, as the sole-property branch of
   * `anchorPdfRowsToPages`.
   */
  soleProperty = false,
): boolean {
  const labelTokens = tokenise(label);
  if (labelTokens.length < MIN_IDENTITY_TOKENS) return false;

  const haystack = ` ${tokenise(pageText).join(' ')} `;
  const states = (token: string) => haystack.includes(` ${token} `);

  const labelLots = lotDesignations(label);
  if (!labelLots.length) {
    // No discriminator of its own. The old rule, unchanged.
    return labelTokens.slice(0, MAX_IDENTITY_TOKENS).every(states);
  }

  // 1 — the lot is stated, as a lot. A number the exporter split into runs
  // is read whole as well as strictly — see `lotDesignationReadings`.
  const pageLotReadings = lotDesignationReadings(pageText);
  const readsAsOurs = (reading: LotReading) =>
    labelLots.includes(reading.strict) || labelLots.includes(reading.fused);
  if (!pageLotReadings.some(readsAsOurs)) return false;

  // 2 — and no other lot is: a run is another lot only when NEITHER of its
  // readings is ours. Waived for a sole-property document — see the parameter.
  if (!soleProperty && pageLotReadings.some((reading) => !readsAsOurs(reading))) return false;

  // 3 — the design, when the label names one.
  const design = designTokens(label);
  if (design.length && !design.every(states)) return false;

  /*
   * 4 — and at least one corroborating token that is not the lot itself.
   *
   * WHEN THE LABEL HAS NOTHING ELSE, the lot designation IS the whole of its
   * identity and there is nothing to corroborate with. A row whose source gave
   * it only "Lot 7" is accepted on the lot alone — exactly as the previous rule
   * accepted it, since its every token was then the lot too. Requiring
   * corroboration a label cannot supply would refuse those rows for being
   * sparsely described, which is not evidence about the document.
   */
  const corroborating = labelTokens.filter((token) =>
    token !== 'lot' && token !== 'unit' && !labelLots.includes(token)
    && !design.includes(token));
  if (!corroborating.length) return true;
  if (corroborating.some(states)) return true;
  // The row's other identity names — the estate, the project — filtered the
  // same way, so a hint can never be the lot wearing a different hat.
  return identityHints
    .flatMap((hint) => tokenise(hint))
    .filter((token) =>
      token !== 'lot' && token !== 'unit' && !labelLots.includes(token)
      && !design.includes(token))
    .some(states);
}

/** The package facts a page states, in the order they are defined above. */
export function packageFactsOn(pageText: string): string[] {
  const text = String(pageText ?? '');
  const found: string[] = [];
  for (const [name, pattern] of PACKAGE_FACTS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/** How many package facts a cover must state. One is a coincidence. */
const MIN_PACKAGE_FACTS = 2;

/**
 * The page (or pages) that present this property as a package.
 *
 * `pageTexts[i]` is the text of visible page `i + 1`. More than one match is
 * returned rather than resolved, because which of them is the COVER is a
 * separate question with its own rule — see `resolvePropertyCover`.
 */
export function findPropertyCoverPages(
  pageTexts: string[],
  label: string | null | undefined,
  identityHints: readonly string[] = [],
  /** See `pageStatesIdentity` — waives the other-lot veto for a lone property. */
  soleProperty = false,
): PropertyCoverEvidence[] {
  const identity = String(label ?? '').trim();
  if (!identity) return [];

  const covers: PropertyCoverEvidence[] = [];
  (pageTexts ?? []).forEach((text, index) => {
    if (!pageStatesIdentity(text ?? '', identity, identityHints, soleProperty)) return;
    const packageFacts = packageFactsOn(text ?? '');
    if (packageFacts.length < MIN_PACKAGE_FACTS) return;
    covers.push({ page: index + 1, identity, packageFacts });
  });
  return covers;
}

/**
 * Which of several qualifying pages is the property's COVER.
 *
 * WHY THIS IS NOT A REFUSAL. The old rule was "exactly one qualifying page or
 * no image", and it was written against the fear that a document covering two
 * PROPERTIES would hand one property's photograph to the other. That fear is
 * already answered upstream and not here: `pageStatesIdentity` requires the
 * page to state THIS lot and refuses any page that states another one, so a
 * page belonging to a different property can never reach this function. Every
 * cover passed in names the same property.
 *
 * So the ambiguity left is not "whose house is this" — it is "which page of
 * this property's own package leads", and refusing that threw away the
 * document entirely.
 *
 * MEASURED, 1 SEPTEMBER 2026. A builder package is a cover page and a floor
 * plan, and both repeat the lot header and the price block, so both qualify.
 * On ten real brochures from the live stock list, five were refused for
 * exactly this and every one of them had its facade render on page 1 and its
 * floor plan on page 2. The rule below recovered all five, changed nothing on
 * the one that already worked, and each recovered image was inspected and is
 * the house.
 *
 * THE RULE: the page that states the MOST of the package is the cover. A
 * cover carries the price, the heading, the land or build size and the
 * bed/bath/car line; a floor plan repeats the header and little else. It is
 * evidence about the page rather than its position, so a document that opens
 * with its floor plan is read correctly too.
 *
 * A STRICT TIE IS STILL NO IMAGE. Two pages stating equally much have not
 * said which leads, and the posture of this whole module is that a blank card
 * beats a guess.
 */
export function resolvePropertyCover(
  covers: readonly PropertyCoverEvidence[],
): PropertyCoverEvidence | null {
  const all = covers ?? [];
  if (all.length <= 1) return all[0] ?? null;

  const most = Math.max(...all.map((cover) => cover.packageFacts.length));
  const leaders = all.filter((cover) => cover.packageFacts.length === most);
  return leaders.length === 1 ? leaders[0] : null;
}

/**
 * Generic words a design name shares with every other design name.
 *
 * Explicit, and deliberately not a similarity score: a design has to carry a
 * token that belongs to IT, and "Single Storey" carries none.
 */
const GENERIC_DESIGN_WORDS: ReadonlySet<string> = new Set([
  'single', 'double', 'storey', 'story', 'house', 'home', 'homes', 'design',
  'designs', 'classic', 'standard', 'basic', 'premium', 'deluxe', 'series',
  'range', 'collection', 'plan', 'plans', 'type', 'option', 'options',
  'facade', 'facades', 'elevation', 'package', 'packages', 'lot', 'unit',
]);

/**
 * Is this design name distinctive enough to identify a document by itself?
 *
 * THREE TESTS, ALL EXPLICIT. A design has to be at least two tokens, carry a
 * word rather than only digits, and carry something that is not shared by
 * every design in the catalogue.
 *
 *   "Elara 18"       elara + 18, `elara` is a word and is not generic.   YES
 *   "18"             one token, no word at all.                          no
 *   "Classic"        one token.                                          no
 *   "Single Storey"  two tokens, both words, both generic.               no
 *
 * The cost of refusing is a blank card, which is this module's whole posture:
 * a design that cannot name itself must not be allowed to name a photograph.
 */
export function designIdentityIsDistinctive(design: string | null | undefined): boolean {
  const tokens = tokenise(String(design ?? ''));
  if (tokens.length < 2) return false;
  if (!tokens.some((token) => /^[a-z]{3,}$/.test(token))) return false;
  return tokens.some((token) => !GENERIC_DESIGN_WORDS.has(token));
}

/**
 * The page (or pages) presenting THIS DESIGN as a package.
 *
 * WHY THIS EXISTS. A builder sells fourteen designs across eighty-nine lots and
 * files one brochure per design, linked from every row that sells it. That
 * brochure names the design and never the lot, so `findPropertyCoverPages`
 * refuses it — correctly, because it is not evidence about a lot. It IS
 * evidence about a design, and the row states which design it bought.
 *
 * FOUR TESTS, AND EACH REFUSES RATHER THAN GUESSES:
 *
 *   1  THE DESIGN IDENTIFIES ITSELF, WITHOUT BORROWING FROM A LOT. Every token
 *      of the row's stated design appears on the page as a whole token.
 *      "Elara 18" against an "Elara 21" page fails on `21`, which is what
 *      keeps one design's render off another design's row. The number in a
 *      lot designation is BLANKED before the test, because it is the one
 *      place a page types a number that says nothing about the design:
 *      "Lot 5 · Enzo 10" must not satisfy the `5` of "Enzo 10.5".
 *
 *   2  THE PAGE IS A PACKAGE PAGE. The same `MIN_PACKAGE_FACTS` a property
 *      cover must clear. A design token in a footer, a specification table or
 *      an index is not a design's cover.
 *
 *   3  A LOT DESIGNATION IS RECORDED, NOT REFUSED. This test used to refuse
 *      any page naming a lot, on the argument that such a page is some
 *      property's own package page and taking it for a different lot would be
 *      attribution by coincidence. Measured on 6 September 2026, that argument
 *      does not hold once test 1 has passed: Lot 1004 Five Farms links a
 *      per-design brochure whose page 1 states every token of "Enzo 10.5"
 *      with three package facts — and designates Lot 1002, the specimen lot
 *      the builder first typeset the design for. The page names the design
 *      ITSELF, so the attribution is by declaration, exactly as it is for a
 *      lot-less design page; the specimen lot's pricing is an irrelevant fact
 *      about a different deal, and nothing here reads it. What the designation
 *      still means is a PREFERENCE — see `resolveDesignCover`.
 *
 *   4  EXACTLY ONE PAGE, resolved by the caller through `resolveDesignCover`.
 *      This is what stops a range catalogue: its generic cover states no
 *      design and clears no facts, and if two pages of equal standing both
 *      present the design the document has not said which is its render.
 */
export function findDesignCoverPages(
  pageTexts: string[],
  design: string | null | undefined,
): PropertyCoverEvidence[] {
  const identity = String(design ?? '').trim();
  if (!designIdentityIsDistinctive(identity)) return [];

  const wanted = tokenise(identity);
  const covers: PropertyCoverEvidence[] = [];
  (pageTexts ?? []).forEach((text, index) => {
    const page = String(text ?? '');
    const tokens = tokenise(page);
    // 1 — the design states itself, every token of it, with the number of any
    // lot designation blanked so a lot cannot lend a token to the design.
    const lotBlind = tokens.filter((token, at) =>
      !(at > 0
        && (tokens[at - 1] === 'lot' || tokens[at - 1] === 'unit')
        && /^\d{1,5}$/.test(token)));
    const haystack = ` ${lotBlind.join(' ')} `;
    if (!wanted.every((token) => haystack.includes(` ${token} `))) return;
    // 2 — and it presents a package rather than mentioning a name.
    const packageFacts = packageFactsOn(page);
    if (packageFacts.length < MIN_PACKAGE_FACTS) return;
    covers.push({
      page: index + 1, identity, packageFacts,
      // 3 — whether it is also some lot's own page, for `resolveDesignCover`.
      lotDesignated: lotDesignations(page).length > 0,
    });
  });
  return covers;
}

/**
 * Which of several qualifying pages is the DESIGN's cover.
 *
 * A page presenting the design with no lot on it is the design's own page; a
 * page presenting the design as some lot's package is a SPECIMEN. Both are
 * declarations about the design, but they are not interchangeable evidence:
 * the brochure for Lot 502 Mambourin presents "Enzo 8.5" twice — page 1 is
 * the design cover with its render, page 2 is Lot 502's own floor-plan page
 * repeating the design header — and reading those two pages as an unresolved
 * tie is how a document that states its render perfectly well answered no
 * image.
 *
 * THE RULE: lot-less pages outrank lot-designating ones, and within the rank
 * that speaks it is still exactly one page or nothing. A catalogue presenting
 * the design on two specimen lots has not said which page is the render; a
 * document with one design cover and any number of per-lot echoes has.
 */
export function resolveDesignCover(
  covers: readonly PropertyCoverEvidence[],
): PropertyCoverEvidence | null {
  const all = covers ?? [];
  const designOwn = all.filter((cover) => !cover.lotDesignated);
  const ranked = designOwn.length ? designOwn : all;
  return ranked.length === 1 ? ranked[0] : null;
}

// ---------------------------------------------------------------------------
// Which picture on that page is the hero
// ---------------------------------------------------------------------------

/** A candidate picture, reduced to what this decision is allowed to see. */
export interface CoverCandidate {
  /** Identifies the raster within the document. */
  key: string;
  /** How many times the cover page draws it. */
  placementsOnPage: number;
  /** How many pages of the document draw it at all. */
  pagesDrawnOn: number;
  /**
   * How much of its page the document gives it, 0..1, or null where the
   * reader could not measure it. This is the cover's own statement of
   * emphasis — see `selectCoverHero`.
   */
  pageAreaShare?: number | null;
  /**
   * What the picture IS, by its pixels — `photo`, `floorplan`, `graphic` — or
   * null where nothing could be established.
   *
   * The one fact here that the document cannot state and cannot be wrong
   * about. Everything else on this candidate is the page's own emphasis, and
   * a brochure that leads with its floor plan states the plan exactly as
   * emphatically as one that leads with the house. See
   * `sourceImageVision.pure.ts`.
   */
  visualKind?: VisualKind | null;
}

/**
 * How much larger than the next photograph a cover's hero has to be drawn
 * before the page counts as having named it. Twice: a difference a reader
 * sees at a glance, and one no incidental inset reaches.
 */
export const DOMINANT_COVER_RATIO = 2;

export type CoverHeroOutcome =
  | { kind: 'hero'; key: string; reason: string }
  | { kind: 'none'; reason: string };

/**
 * The one picture on a property's cover page that is its hero.
 *
 * REPETITION IS THE ONLY THING THAT ELIMINATES, and it eliminates by what the
 * document did rather than by what the picture looks like. A raster the cover
 * draws twice, or that a second page also draws, is the design's furniture: on
 * the Lot 537 cover that is the grey faceted wash, placed three times, which
 * every size and encoding rule admits and which is bigger on the page than the
 * facade it sits behind.
 *
 * What survives has to be exactly one. Two surviving photographs on a cover is
 * a page presenting a choice, and this does not make choices — see LEVEL 4.
 */
export function selectCoverHero(candidates: CoverCandidate[]): CoverHeroOutcome {
  const all = candidates ?? [];
  if (!all.length) {
    return { kind: 'none', reason: 'the property cover page presents no photograph' };
  }

  /*
   * A PLAN IS NOT A PICTURE OF THE HOUSE, HOWEVER LARGE THE PAGE DRAWS IT.
   *
   * This is the one test above that is about the PICTURE rather than the
   * page, and it is here because the page cannot answer it. On the Palomino
   * Vanta 23 brochure the floor plan is unique on its page and drawn well
   * over twice the size of anything else, so every rule below correctly
   * concluded the cover had named it — and two live cards led with a green
   * line drawing badged "Builder supplied".
   *
   * Excluded rather than demoted, because this function returns one hero or
   * none: ranking a plan last would still elect it on a page that offers
   * nothing else, which is the defect. A card with no picture is a state this
   * marketplace already handles and says out loud; a card leading with a
   * floor plan is one it cannot.
   *
   * An UNCLASSIFIED candidate is kept. Absent evidence is not evidence, and
   * a decoder that could not read a builder's raster must not be able to
   * withhold their photograph.
   */
  const depictions = all.filter((candidate) => mayLeadCard(candidate.visualKind));
  if (!depictions.length) {
    return {
      kind: 'none',
      reason: 'every picture on the property cover is a plan or a graphic rather than a '
        + 'photograph of the property',
    };
  }

  const unique = depictions.filter(
    (candidate) => candidate.placementsOnPage <= 1 && candidate.pagesDrawnOn <= 1,
  );
  if (unique.length === 1) {
    const dropped = depictions.length - unique.length;
    return {
      kind: 'hero',
      key: unique[0].key,
      reason: dropped
        ? `the only photograph the property cover presents once; ${dropped} other `
          + 'raster(s) on that page are repeated artwork the document reuses'
        : 'the only photograph the property cover presents',
    };
  }
  if (!unique.length) {
    return {
      kind: 'none',
      reason: 'every photograph on the property cover is artwork the document repeats, '
        + 'so none of them is this property\'s own image',
    };
  }
  /*
   * A COVER STATES ITS HERO BY HOW LARGE IT DRAWS IT.
   *
   * Refusing every multi-photograph cover was right while the only question
   * was ownership — a page presenting a choice has not said which picture is
   * the property's. But a cover that gives one photograph several times the
   * page of any other HAS said, in the one language a page has. Measured on a
   * builder's own single-property brochure uploaded as a stock list (LOT 1731,
   * Austin Estate): the facade render covers 47.5% of page 1 and the only
   * other photograph 14.2%, and the property was told its own brochure
   * presents no cover image.
   *
   * The test is the DOCUMENT'S, not the picture's: twice the page of the next
   * largest, measured from the same placement geometry the size floors
   * already use. Two photographs of comparable size are still a choice, and
   * still answer no image. Where the reader could not measure a candidate,
   * nothing is inferred — the refusal stands.
   */
  const measured = unique
    .map((candidate) => ({ candidate, area: Number(candidate.pageAreaShare ?? NaN) }))
    .filter((entry) => Number.isFinite(entry.area) && entry.area > 0)
    .sort((a, b) => b.area - a.area);

  if (measured.length === unique.length && measured.length > 1
    && measured[0].area >= measured[1].area * DOMINANT_COVER_RATIO) {
    return {
      kind: 'hero',
      key: measured[0].candidate.key,
      reason: `the photograph the property cover draws largest, at `
        + `${Math.round(measured[0].area * 100)}% of the page against `
        + `${Math.round(measured[1].area * 100)}% for the next`,
    };
  }

  return {
    kind: 'none',
    reason: `the property cover presents ${unique.length} photographs at comparable size `
      + 'and does not say which is the property\'s, so none is used',
  };
}

// ---------------------------------------------------------------------------
// The one decision, for every caller
// ---------------------------------------------------------------------------

/** One discovered picture, reduced to what the source said about where it sits. */
export interface PdfMediaPlacement {
  /** 1-based, the page a person sees. */
  page: number;
  /** The resource/file name the document gave it, when it gave one. */
  name: string | null;
  /** How many times its own page draws it. */
  placementsOnPage: number;
  /** How many pages of the document draw it. */
  pagesDrawnOn: number;
  /** How much of its page the document gives it, 0..1, where measurable. */
  pageAreaShare?: number | null;
}

/**
 * The role of EVERY picture found in one PDF, index-aligned with the input.
 *
 * ONE implementation, three callers — a PDF uploaded straight into the portal,
 * the same PDF re-read by a repair, and a package PDF reached through a stock
 * row's own link. They must not be able to disagree about which picture is a
 * property's hero, which is exactly the class of drift that produced two
 * competing brochure readers in the first place.
 *
 * At most ONE assignment comes back as `primary_property`, and only when the
 * document said so.
 */
/**
 * THE PAGES WORTH DECODING, decided from the text alone.
 *
 * WHY THIS EXISTS. `discoverPdfSourceAssets` materialises every raster it finds
 * on up to twelve pages, and materialising means decoding — a 13.2 MB brochure
 * of 5334x3334 JPEGs is twelve pages of that before anything has been decided.
 * The edge worker does not survive it: `CPU Time exceeded`, `Memory limit
 * exceeded`, no throw, no `finally`, no response. Measured in production on 2
 * September 2026, the live Luxton list: Lot 516 (10.6 MB, 19 pages) and Lot
 * 6706 (13.2 MB, 23 pages) both sat at `attempts: 2`, one tick from being
 * retired as documents that name no image — while their cover pages hold a
 * 2000x1250 render that reads in under six seconds once it is the only thing
 * decoded.
 *
 * WHICH IS THE POINT: which page can be this property's cover is decided by
 * TEXT, and text costs nothing. So the expensive step is told where to look
 * instead of looking everywhere and being killed before it can be asked.
 *
 * IT IS A SUPERSET, AND THAT IS THE SAFETY PROPERTY. It returns every page
 * `assignPdfMediaRoles` could possibly choose — every qualifying property
 * cover, the structural tie, and every design cover — rather than the one it
 * WILL choose, because narrowing to the winner would make this a second
 * implementation of the choice and the two would drift. Scoping can therefore
 * never remove a page the role assignment would have used; it can only remove
 * pages that could never have won.
 *
 * AN EMPTY ANSWER MEANS "NO OPINION", never "no pages". A document whose text
 * names no cover at all gets the unscoped walk it has always had, so its
 * diagnostics — and the flattened-page path that reads a brochure exported as
 * images — are untouched.
 */
export function coverSearchPages(input: {
  label: string | null | undefined;
  pageTexts: string[];
  design?: string | null;
  structuralCoverPage?: number | null;
  /** The row's other identity names. See `pageStatesIdentity`, test 4. */
  identityHints?: readonly string[] | null;
}): number[] {
  const pages = new Set<number>();
  for (const cover of findPropertyCoverPages(
    input.pageTexts ?? [], input.label, input.identityHints ?? [],
  )) {
    pages.add(cover.page);
  }
  for (const cover of findDesignCoverPages(input.pageTexts ?? [], input.design ?? null)) {
    pages.add(cover.page);
  }
  if (Number.isInteger(input.structuralCoverPage)
    && (input.structuralCoverPage as number) > 0) {
    pages.add(input.structuralCoverPage as number);
  }
  return [...pages].sort((a, b) => a - b);
}

export function assignPdfMediaRoles(input: {
  label: string | null | undefined;
  pageTexts: string[];
  pageOrderAuthoritative: boolean;
  media: PdfMediaPlacement[];
  /**
   * What each picture IS, index-aligned with `media`, where the caller was
   * able to look. Absent or null entries mean nothing was established and the
   * candidate is judged exactly as it was before this existed.
   */
  visualKinds?: Array<VisualKind | null>;
  /**
   * THE DOCUMENT IS ALREADY KNOWN TO BE THIS PROPERTY'S, AND IT CANNOT SAY SO.
   *
   * Set only where the containing document was tied to exactly one stock row by
   * the builder's OWN structure — one folder named for the lot, one PDF in it
   * naming that lot and that design, `selectPackageDocument`'s exactly-one-or-
   * nothing — and where the document's pages then yielded no extractable text
   * whatsoever.
   *
   * That combination is a real document in the live library:
   * "LOT 914 • COVELLA • GREENBANK QLD.pdf" is three pages of designed brochure
   * exported as images, whose first page carries the lot, the estate, the price,
   * both sizes and the facade render, all drawn rather than set. Nothing on that
   * page can be read, so `findPropertyCoverPages` can never designate it — and
   * the property has a photograph the source names perfectly well.
   *
   * WHAT THIS IS NOT. It is emphatically not "a PDF with no text, so use page
   * one": that rule would attribute the first picture in any unreadable
   * document to whichever property happened to be asking. The attribution here
   * does not come from the page at all — it was already made, by name, before a
   * byte was downloaded — and this only supplies the page number that
   * attribution implies. Where the folder named two candidate documents, or
   * none, there is no tie and nothing reaches this.
   *
   * AND IT STILL HAS TO BE A COVER. `selectCoverHero` runs unchanged below, so
   * a first page presenting no photograph, or presenting several, or presenting
   * only artwork the document repeats elsewhere, yields nothing exactly as it
   * would for a page whose text was read. A floorplan or a masterplan on page 1
   * is not promoted by this; it is refused by the same rule that refuses it
   * today.
   */
  structuralCoverPage?: number | null;
  /**
   * The house design this row states, from the canonical `house_design` field.
   *
   * Consulted ONLY where the property-specific paths above found nothing, so a
   * document naming this lot always decides first and a design render can
   * never displace one. Absent or indistinct, and the design path never runs.
   */
  design?: string | null;
  /** The row's other identity names. See `pageStatesIdentity`, test 4. */
  identityHints?: readonly string[] | null;
  /**
   * The document produced exactly ONE property. See `pageStatesIdentity`.
   */
  soleProperty?: boolean;
}): SourceImageRoleAssignment[] {
  const media = input.media ?? [];
  const covers = input.pageOrderAuthoritative
    ? findPropertyCoverPages(input.pageTexts ?? [], input.label, input.identityHints ?? [],
      input.soleProperty === true)
    : [];
  const structural = input.pageOrderAuthoritative
    && Number.isInteger(input.structuralCoverPage)
    && (input.structuralCoverPage as number) > 0
    && !covers.length
    // Only where NOTHING could be read. A document whose text was read and did
    // not name this property has answered the question, and this must not
    // overrule it.
    && (input.pageTexts ?? []).every((text) => !String(text ?? '').trim())
    ? {
      page: input.structuralCoverPage as number,
      identity: String(input.label ?? ''),
      packageFacts: ['the builder\'s own folder names this document for this property'],
    }
    : null;
  /*
   * THE DESIGN, AND ONLY WHERE THE PROPERTY ITSELF ELECTED NOTHING.
   *
   * Ordered, not merged: a property cover is consulted first, then the
   * structural tie, and the design page speaks only when the rungs above
   * produced no HERO. So this can turn a blank into a render and can never
   * turn a lot-specific render into a design one.
   *
   * "Elected nothing" rather than the earlier "found nothing", and that word
   * is the fix, measured on 6 September 2026: Lot 502 Mambourin's brochure
   * designates page 2 — Lot 502's own floor-plan page, two package facts, no
   * photograph on it — as the property cover, and the old gate then refused
   * to look at page 1, where the same document presents "Enzo 8.5" as a
   * design cover with four facts and the render. A page that provably
   * presents no photograph has answered its own question; it must not also
   * answer the design's. The lot's page still wins whenever it CAN elect,
   * which is what keeps attribution lot-first.
   */
  const designCovers = input.pageOrderAuthoritative
    ? findDesignCoverPages(input.pageTexts ?? [], input.design)
    : [];
  const designCover = resolveDesignCover(designCovers);

  const electOn = (cover: PropertyCoverEvidence) => selectCoverHero(media
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.page === cover.page)
    .map(({ entry, index }) => ({
      key: String(index),
      placementsOnPage: entry.placementsOnPage,
      pagesDrawnOn: entry.pagesDrawnOn,
      pageAreaShare: entry.pageAreaShare ?? null,
      visualKind: input.visualKinds?.[index] ?? null,
    })));

  const propertyChoice = resolvePropertyCover(covers) ?? structural;
  let cover = propertyChoice;
  let outcome = cover ? electOn(cover) : null;
  let designElected = false;
  if (outcome?.kind !== 'hero' && designCover
    && designCover.page !== propertyChoice?.page) {
    const designOutcome = electOn(designCover);
    if (designOutcome.kind === 'hero') {
      cover = designCover;
      outcome = designOutcome;
      designElected = true;
    } else if (!propertyChoice) {
      // No property page was ever in play, so the design page was the only
      // one consulted and its refusal is the honest one to record.
      cover = designCover;
      outcome = designOutcome;
    }
  }

  const heroIndex = outcome?.kind === 'hero' ? Number(outcome.key) : -1;

  // Why nothing is primary, said once and in the source's own terms, so the
  // stored record explains itself without anybody re-running the import.
  const refusal = !input.pageOrderAuthoritative
    ? 'the document\'s own page order could not be established, so no page can be read as '
      + 'this property\'s cover'
    : !(input.pageTexts ?? []).length
      ? 'the document\'s text could not be read, so no page can be read as this property\'s cover'
      : !String(input.label ?? '').trim()
        ? 'the property has no label for a page to state, so no page can be read as its cover'
        : covers.length > 1 && !resolvePropertyCover(covers)
          ? `${covers.length} pages present this property as a package and state equally `
            + 'much of it, so the document does not say which is its cover'
          : outcome?.kind === 'none'
            ? outcome.reason
            : !covers.length
              ? 'no page states this property\'s identity together with its package '
                + 'information' + coverSays(input.pageTexts)
              : 'the source does not designate a primary image for this property';

  return media.map((entry, index) => {
    /**
     * A name the builder chose may DEMOTE and never promote. `Masterplan.png`
     * is not a house whatever page it sits on; `6.png` is a perfectly ordinary
     * name for a facade render, so a hero word in a filename proves nothing
     * about which property it belongs to or what the source presented it as.
     */
    const named = roleFromAssetName(entry.name);
    if (named) {
      return secondaryRole(named, `the source names this image "${entry.name}"`);
    }
    if (index === heroIndex && cover) {
      // The design path never claims the property named it. See
      // `roleFromDesignCover`.
      if (designElected) {
        return roleFromDesignCover({
          where: `visible page ${cover.page}`,
          design: cover.identity,
          packageFacts: cover.packageFacts,
        });
      }
      return roleFromPropertyCover({
        where: `visible page ${cover.page}`,
        identity: cover.identity,
        packageFacts: cover.packageFacts,
      });
    }
    return noPrimaryEvidence(refusal);
  });
}

/**
 * The same decision for a document that produced SEVERAL properties.
 *
 * Each property is judged against the pages attributed to it and against its
 * own label, so a stock PDF listing twelve lots resolves twelve covers rather
 * than one — and a picture the document tied to nobody stays tied to nobody.
 *
 * Index-aligned with `media`, like everything else on this path, because the
 * caller writes one storage row per entry and a misalignment here would put one
 * property's evidence on another property's picture.
 */
export function assignPdfMediaRolesPerProperty(input: {
  media: Array<{ name: string; placement?: PdfMediaPlacement | null }>;
  /** The property each picture reached, index-aligned. Null is unattributed. */
  stockItemIds: Array<string | null>;
  labelByItemId: Map<string, string>;
  /** Each property's other identity names. See `pageStatesIdentity`, test 4. */
  identityHintsByItemId?: Map<string, readonly string[]>;
  /**
   * Each property's own house design, for the design-cover fallback — the rung
   * that accepts the document naming the HOUSE where none names the LOT. The
   * linked-document path has passed it since that rung existed; this one did
   * not, so an uploaded package could never reach it.
   */
  designByItemId?: Map<string, string | null>;
  /** The document produced exactly ONE property. See `pageStatesIdentity`. */
  soleProperty?: boolean;
  pageTexts: string[];
  pageOrderAuthoritative: boolean;
  /** What each picture IS, index-aligned with `media`. See `assignPdfMediaRoles`. */
  visualKinds?: Array<VisualKind | null>;
}): SourceImageRoleAssignment[] {
  const media = input.media ?? [];
  const out: SourceImageRoleAssignment[] = media.map(() => noPrimaryEvidence(
    'the source did not tie this image to a property, so it is kept against the upload '
    + 'and shown against nobody'));

  const byProperty = new Map<string, number[]>();
  media.forEach((_, index) => {
    const itemId = input.stockItemIds[index];
    if (!itemId) return;
    const bucket = byProperty.get(itemId) ?? [];
    bucket.push(index);
    byProperty.set(itemId, bucket);
  });

  for (const [itemId, indexes] of byProperty) {
    const assignments = assignPdfMediaRoles({
      label: input.labelByItemId.get(itemId) ?? null,
      identityHints: input.identityHintsByItemId?.get(itemId) ?? [],
      design: input.designByItemId?.get(itemId) ?? null,
      soleProperty: input.soleProperty === true,
      pageTexts: input.pageTexts,
      pageOrderAuthoritative: input.pageOrderAuthoritative,
      media: indexes.map((index) => media[index].placement ?? {
        // A picture with no placement was not read by the page reader, so
        // nothing is known about where the document put it.
        page: 0, name: media[index].name, placementsOnPage: 2, pagesDrawnOn: 2,
      }),
      // Re-indexed with the media, so a per-property slice keeps each
      // picture's own verdict rather than the document's position.
      visualKinds: indexes.map((index) => input.visualKinds?.[index] ?? null),
    });
    indexes.forEach((index, position) => { out[index] = assignments[position]; });
  }
  return out;
}

/**
 * The most identifying-looking few lines of a cover, for a refusal to quote.
 *
 * Lines that carry a lot, a street, an estate or a design code are what tell
 * one package from another, so those are preferred; failing that the first
 * substantial lines, so the note still says something. Bounded hard, because
 * this lands in a status line rather than a log, and stripped of control
 * characters because it is somebody else's file.
 */
export function coverIdentityQuote(pageText: string | null | undefined): string {
  const lines = String(pageText ?? '')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 3 && line.length <= 90);
  if (!lines.length) return '';
  /*
   * NO WORD BOUNDARY BEFORE `lot`. Text pulled out of a designed PDF arrives
   * with its runs glued together — the live cover's line is literally
   * `PACKAGE PRICELot 1307 Fuchsia Street,` — so a `\b` here matches nothing
   * on exactly the documents this exists for. A stray `ballot 5` costs a
   * less apt quote and never a decision.
   */
  const IDENTIFYING =
    /(?:lot|unit)\s*\.?\s*\d|\d+\s*(?:street|road|drive|avenue|way|court|crescent|parade|boulevard)|estate\b/i;
  const picked = lines.filter((line) => IDENTIFYING.test(line)).slice(0, 2);
  const chosen = picked.length ? picked : lines.slice(0, 2);
  const quote = chosen.join(' — ');
  return quote.length > 120 ? `${quote.slice(0, 117).trimEnd()}…` : quote;
}

/**
 * " — its first page reads “…”", or nothing.
 *
 * WHY THE REFUSAL QUOTES THE DOCUMENT. "No page states this property's
 * identity" is correct and useless on its own: it cannot tell a builder
 * whether their brochure has no photograph in it or is simply about a
 * different property, so the only move it leaves them is to upload the same
 * file again. Measured: that is exactly what happened, twice, to the same
 * 10 MB package — the row reads `Lot 1037 Fuchsia Street`, taken from the
 * file's NAME, while the document's own cover states a different lot. Seeing
 * the two side by side is a thirty-second correction.
 *
 * A QUOTE, NEVER A CONCLUSION. It reports what the first page reads and draws
 * no inference about which property the document belongs to — asserting that
 * would be a second identity judgement made with less evidence than the one
 * that just declined.
 */
function coverSays(pageTexts: readonly string[] | undefined): string {
  const quote = coverIdentityQuote((pageTexts ?? [])[0]);
  return quote ? ` — its first page reads “${quote}”` : '';
}
