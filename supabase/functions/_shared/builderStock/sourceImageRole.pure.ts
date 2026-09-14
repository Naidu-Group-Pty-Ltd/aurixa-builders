/**
 * Builder stock — WHAT THE SOURCE SAID AN IMAGE IS.
 *
 * There are two separate facts about a Builder Stock image, and until now the
 * pipeline only ever established the first:
 *
 *   1. SOURCE PROVENANCE — "these exact bytes came out of the builder's own
 *      source." That is what `sourceImages.ts` and the hashes in
 *      `source_detail` prove, and they prove it well.
 *   2. IMAGE ROLE — "the builder's source presented THIS image as THIS
 *      property's primary/hero/listing image." Nothing established this at
 *      all, and a marketplace card needs it: a bedroom render, a floorplan, an
 *      estate masterplan and a colour-selection variant are every one of them
 *      genuine builder-supplied imagery, and not one of them is the picture a
 *      client should see first when asked to buy a house.
 *
 * The defect this module exists to end is the confusion of the two. Lot 537
 * Kirramingly Avenue showed a bedroom because the bedroom was a valid,
 * hash-provable, builder-supplied JPEG — which is a true statement about
 * provenance and says nothing whatever about role.
 *
 * SO: ONLY `primary_property` MAY BECOME A CARD'S IMAGE. `unknown` never can,
 * and neither can any of the named non-hero roles. Where the source does not
 * establish a hero, the property gets NO image — an empty frame is honest and
 * a bedroom labelled "Builder supplied" is not.
 *
 * WHAT MAY ESTABLISH THE ROLE, strongest first. Every format lands on one of
 * these, which is what makes this one architecture rather than one rule per
 * file type:
 *
 *   LEVEL 1 — an EXPLICIT property-image field. A spreadsheet column called
 *             "Facade", a Notion file property called "Property Image", a CSV
 *             `image_url`. The source named the field; the field says what the
 *             image is for.
 *   LEVEL 2 — a PROPERTY COVER / PACKAGE HERO. A page, slide or section that
 *             states this property's identity AND its package information and
 *             presents one prominent property image with them.
 *   LEVEL 3 — a STRUCTURAL PROPERTY CONTAINER designating one image: a Notion
 *             row's own page cover, an HTML property card's hero, a table
 *             row's image cell.
 *   LEVEL 4 — nothing of the above. Several pictures exist and the source does
 *             not say which is the property's. The answer is NO PRIMARY.
 *
 * Nothing here looks at pixels, sizes, encodings or file order. Those may
 * REJECT a candidate — a 1×1 pixel is not a photograph — but they may never
 * establish a role, because "largest JPEG" is a statement about a file and the
 * question is about a house.
 *
 * Pure: no imports, no IO, no clock. Loaded by the edge functions under Deno
 * and by `src/lib/__tests__` under vitest.
 */

/**
 * What the source presented an image AS.
 *
 * `unknown` is a real answer and the common one: most builder-supplied images
 * sit in a document that never says what they are, and saying so is better
 * than guessing.
 */
export type SourceImageRole =
  | 'primary_property'
  | 'property_secondary'
  | 'interior'
  | 'floorplan'
  | 'site_plan'
  | 'masterplan'
  | 'location_map'
  | 'materials'
  | 'logo_decorative'
  | 'unknown';

/** The ONE role a Builder Stock card may draw. */
export const PRIMARY_ROLE: SourceImageRole = 'primary_property';

/**
 * How strongly the source stated it. Null where nothing stated a hero.
 *
 * LOWER IS STRONGER — `comparePrimaryEvidence` sorts ascending and ranks null
 * last. 4 is the DESIGN level: the builder's own document names the house
 * design this row states, and does not name this lot. It is deliberately
 * weaker than 3, the package cover that names the property itself, so a
 * lot-specific image always takes the card back from a design render.
 */
export type PrimaryEvidenceLevel = 1 | 2 | 3 | 4 | null;

/**
 * The level a design-matched image carries.
 *
 * Named rather than written as a literal because two places have to agree
 * about it: the assignment that mints it and the rule that keeps it below a
 * lot match.
 */
export const DESIGN_EVIDENCE_LEVEL: PrimaryEvidenceLevel = 4;

/**
 * The role, and the source's own words for why.
 *
 * `evidence` is what the SOURCE said — a column name, a page's stated address
 * and price, a Notion property label. `reason` is why that made (or did not
 * make) this image the primary. Both are written to `source_detail` so the
 * answer to "why is this the picture?" is a fact somebody can check rather
 * than a heuristic somebody has to trust.
 */
export interface SourceImageRoleAssignment {
  role: SourceImageRole;
  evidenceLevel: PrimaryEvidenceLevel;
  evidence: string;
  reason: string;
}

/** May this role become `primary_image_id`? Exactly one may. */
export function isPrimaryRole(role: unknown): boolean {
  return role === PRIMARY_ROLE;
}

/** The role recorded against a stored image, or `unknown` when none is. */
export function readStoredRole(
  sourceDetail: Record<string, unknown> | null | undefined,
): SourceImageRole {
  const raw = (sourceDetail ?? {}).role;
  return ROLE_VALUES.has(raw as SourceImageRole) ? raw as SourceImageRole : 'unknown';
}

const ROLE_VALUES: ReadonlySet<SourceImageRole> = new Set<SourceImageRole>([
  'primary_property', 'property_secondary', 'interior', 'floorplan', 'site_plan',
  'masterplan', 'location_map', 'materials', 'logo_decorative', 'unknown',
]);

// ---------------------------------------------------------------------------
// The vocabulary a source names things with
// ---------------------------------------------------------------------------

/**
 * Words that say an image is NOT the property's hero, and what it is instead.
 *
 * Checked BEFORE the hero vocabulary and deliberately so: a column called
 * "Floorplan Image" contains the word "image", and reading it as a property
 * photograph is exactly the class of mistake this module exists to stop. The
 * longest phrases come first so "site plan" is not read as "plan".
 */
const NON_HERO_VOCABULARY: ReadonlyArray<readonly [RegExp, SourceImageRole]> = [
  [/\b(master\s*plan|masterplan|estate\s*plan|precinct\s*plan)\b/, 'masterplan'],
  [/\b(site\s*plan|siteplan|lot\s*plan|plan\s*of\s*subdivision|survey\s*plan)\b/, 'site_plan'],
  [/\b(floor\s*plan|floorplan|floor\s*layout|ground\s*floor|first\s*floor)\b/, 'floorplan'],
  [/\b(location\s*map|locality|location\s*plan|street\s*map|google\s*map|map)\b/, 'location_map'],
  [/\b(colour\s*(selection|scheme|palette)|color\s*(selection|scheme|palette)|material\s*board|materials?|palette|swatch|finishes|inclusions?)\b/, 'materials'],
  [/\b(logo|letterhead|banner|watermark|icon|qr|brandmark|background|texture)\b/, 'logo_decorative'],
  [
    /\b(interior|bedroom|bed\s*\d|kitchen|bathroom|ensuite|laundry|living|lounge|dining|alfresco|hallway|wardrobe|robe|pantry|study|garage\s*interior|internal)\b/,
    'interior',
  ],
  [/\b(estate|community|lifestyle|amenity|amenities|park|playground|display\s*village|aerial|streetscape)\b/, 'property_secondary'],
];

/**
 * Words that say a field or file IS the property's own listing image.
 *
 * `image` and `photo` are here on their own because a field named exactly that,
 * belonging to a property row, is the row's picture — that is what LEVEL 1
 * means. They are reached only after every non-hero pattern above has missed.
 */
const HERO_VOCABULARY: ReadonlyArray<RegExp> = [
  /\b(primary|hero|main|feature|featured|cover|listing|title)\s*(image|imagery|photo|photograph|picture|render|shot)\b/,
  /\b(property|house|home|dwelling|package|facade|elevation|frontage|streetfront)\s*(image|imagery|photo|photograph|picture|render|shot|view)?\b/,
  /\b(facade|facade\s*render|elevation|render|artist\s*impression|streetscape\s*render)\b/,
  /\b(image|imagery|photo|photograph|picture|render|thumbnail)\s*(url|link|src)?\b/,
];

function normalise(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    // A filename's separators are word breaks: `Lumi_Oak_Facade.png`.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * What a name the SOURCE chose says this image is, or null when it says
 * nothing.
 *
 * Used for a field/column/property label (where a hit is LEVEL 1 evidence) and
 * for a filename or caption (where a hit may only DEMOTE, never promote — see
 * `roleFromAssetName`). A builder's file naming is their own business and
 * `6.png` is a perfectly ordinary name for a facade render.
 */
export function roleFromSourceLabel(label: string | null | undefined): SourceImageRole | null {
  const text = normalise(label);
  if (!text) return null;
  for (const [pattern, role] of NON_HERO_VOCABULARY) {
    if (pattern.test(text)) return role;
  }
  for (const pattern of HERO_VOCABULARY) {
    if (pattern.test(text)) return PRIMARY_ROLE;
  }
  return null;
}

/**
 * What a FILENAME says, for demotion only.
 *
 * A file called `Masterplan.png` is not this property's hero however it reached
 * us, and that is worth acting on. The converse is not true: a file called
 * `Facade.png` sitting in a folder tells us nothing about which property it
 * belongs to or whether the source presented it as anybody's listing image, so
 * a hero word in a filename returns null rather than a promotion.
 */
export function roleFromAssetName(name: string | null | undefined): SourceImageRole | null {
  const text = normalise(name);
  if (!text) return null;
  for (const [pattern, role] of NON_HERO_VOCABULARY) {
    if (pattern.test(text)) return role;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The three levels, as assignments
// ---------------------------------------------------------------------------

/**
 * LEVEL 1 — the source named a field, and the field is the property's image.
 *
 * `fieldLabel` is the column heading, Notion property name or CSV header the
 * value sat under. Anything the vocabulary reads as non-hero comes back as that
 * role instead, so an explicit "Floorplan" column is explicitly a floorplan.
 */
export function roleFromExplicitField(
  fieldLabel: string | null | undefined,
): SourceImageRoleAssignment {
  const role = roleFromSourceLabel(fieldLabel);
  const label = String(fieldLabel ?? '').trim().slice(0, 120);
  if (role === PRIMARY_ROLE) {
    return {
      role: PRIMARY_ROLE,
      evidenceLevel: 1,
      evidence: `the source's own "${label}" field on this property's row`,
      reason: `the property row carries an explicit property-image field ("${label}")`,
    };
  }
  if (role) {
    return {
      role,
      evidenceLevel: null,
      evidence: `the source's own "${label}" field`,
      reason: `the source names this field "${label}", which is not the property's listing image`,
    };
  }
  return {
    role: 'unknown',
    evidenceLevel: null,
    evidence: label ? `an unnamed image under "${label}"` : 'no field name',
    reason: 'the source does not say what this image is for',
  };
}

/**
 * LEVEL 2 — a property cover/package page presented one prominent image with
 * this property's identity and package information.
 *
 * The caller has already established that the page names the property and
 * states its package facts, and that exactly one candidate image sat there;
 * this only words it. `where` names the page/slide/section 1-based, the way a
 * person counts.
 */
export function roleFromPropertyCover(input: {
  where: string;
  identity: string;
  packageFacts: string[];
}): SourceImageRoleAssignment {
  const facts = input.packageFacts.slice(0, 4).join(', ');
  return {
    role: PRIMARY_ROLE,
    evidenceLevel: 2,
    evidence: `${input.where} states "${input.identity}"${facts ? ` with ${facts}` : ''} `
      + 'and presents one prominent property image with them',
    reason: `single-property package cover contains this property's identity, its package `
      + `information (${facts}) and one prominent facade image`,
  };
}

/**
 * LEVEL 4 — the builder's document names the DESIGN this row states.
 *
 * WHAT THIS IS, SAID HONESTLY. Not a photograph of this lot, and the wording
 * never claims one: it is the builder's own imagery for the exact house design
 * the row says this lot is being sold with. Several lots that state the same
 * design may legitimately carry the same render, because they are the same
 * house — and that is the source's own statement, not an inference from a
 * shared URL or a spreadsheet row.
 *
 * WEAKEST ON PURPOSE. Every property-specific level outranks it, so a document
 * that names this lot always takes the card, and one arriving later takes it
 * back — `comparePrimaryEvidence` does that without this module's help.
 */
export function roleFromDesignCover(input: {
  where: string;
  design: string;
  packageFacts: string[];
}): SourceImageRoleAssignment {
  const facts = input.packageFacts.slice(0, 4).join(', ');
  return {
    role: PRIMARY_ROLE,
    evidenceLevel: DESIGN_EVIDENCE_LEVEL,
    evidence: `${input.where} presents the house design "${input.design}"`
      + `${facts ? ` with ${facts}` : ''}, which is the design this property states`,
    reason: 'builder-supplied imagery for the exact house design assigned to this '
      + 'property; the document names the design and not this lot, so a '
      + 'lot-specific image outranks it',
  };
}

/**
 * LEVEL 3 — a structural container designated this image.
 *
 * A Notion row's own `page_cover`, an HTML property card's hero, the image cell
 * of a property's table row. The container is the source SAYING which image
 * belongs to which property and which of them leads.
 */
/**
 * The builder handed us this picture FOR THIS PROPERTY.
 *
 * LEVEL 1, the same rung as a column that names the row's image, because it is
 * the same claim made more directly: the builder said "this is that
 * property's picture". Nothing was read, inferred or matched, so there is
 * nothing weaker about it than a spreadsheet field — and it must outrank
 * anything taken out of a document, or an override would not override.
 *
 * It is deliberately NOT a new level. A level is how strongly the SOURCE
 * stated the hero, and the builder is the source.
 */
export function roleFromBuilderProperty(input: {
  /** Who supplied it, in the terms the record already uses. */
  suppliedBy: 'builder' | 'staff';
  /** The property, as the operator saw it named. */
  property: string;
}): SourceImageRoleAssignment {
  const who = input.suppliedBy === 'staff'
    ? 'supplied on the builder\'s behalf'
    : 'supplied by the builder';
  return {
    role: PRIMARY_ROLE,
    evidenceLevel: 1,
    evidence: `${who} for ${input.property}`,
    reason: 'the builder attached this picture to this property directly, so it is '
      + 'this property\'s image without anything having to be read',
  };
}

export function roleFromStructuralContainer(input: {
  container: string;
  designation: string;
}): SourceImageRoleAssignment {
  return {
    role: PRIMARY_ROLE,
    evidenceLevel: 3,
    evidence: `${input.container} designates this image as its ${input.designation}`,
    reason: `the source's ${input.container} presents this image as the property's `
      + `${input.designation}`,
  };
}

/**
 * LEVEL 4 — the source carries imagery but does not say which is the property's.
 *
 * The whole point of naming this case is that it has an answer, and the answer
 * is no image rather than the best-looking candidate.
 */
export function noPrimaryEvidence(reason: string): SourceImageRoleAssignment {
  return { role: 'unknown', evidenceLevel: null, evidence: 'none', reason };
}

/** A discovered asset the source placed but did not designate as the hero. */
export function secondaryRole(
  role: SourceImageRole,
  reason: string,
): SourceImageRoleAssignment {
  return {
    role: isPrimaryRole(role) ? 'property_secondary' : role,
    evidenceLevel: null,
    evidence: 'none',
    reason,
  };
}

/**
 * How strongly the source stated the hero, read back off a stored image.
 *
 * `null` for an image written before levels existed, and for one whose role
 * was never established. A level is only ever meaningful ALONGSIDE
 * `primary_property`: it says how the source said so, never whether it did.
 */
export function readStoredEvidenceLevel(
  sourceDetail: Record<string, unknown> | null | undefined,
): PrimaryEvidenceLevel {
  const raw = (sourceDetail ?? {}).role_evidence_level;
  return raw === 1 || raw === 2 || raw === 3 || raw === 4 ? raw : null;
}

/**
 * Order two PROVEN primary candidates for the same property: best first.
 *
 * THIS DECIDES NOTHING ABOUT OWNERSHIP. Both inputs have already been proved
 * to be this property's, to have come out of the builder's own source, and to
 * carry `primary_property`. All that is left is which of them the source
 * designated most strongly, and that is the level:
 *
 *   1  an EXPLICIT property-image field — the source named a field for the
 *      property's picture and put this in it;
 *   2  a PROPERTY COVER / PACKAGE HERO — a page stating this property's
 *      identity presented this image with it;
 *   3  a STRUCTURAL CONTAINER designating one image — a row's page cover.
 *
 * WHY IT MATTERS, in the words of the case that produced it. A builder keeps a
 * marketing tile in the row's page-cover slot — the facade with "$25,000
 * Rebate", "VIC" and "LARA" set over it in coloured pills — and the clean
 * original in a field called "Property Image". Both are exact builder-supplied
 * bytes for that exact property; both are `primary_property`. Ordering them by
 * `position` picks whichever the reader happened to enumerate first, and the
 * marketing tile is as likely as not. Ordering them by what the SOURCE SAID
 * picks the field the builder made for the purpose.
 *
 * A level the source did not state sorts LAST rather than first: an image
 * written before levels existed must not outrank one whose evidence is
 * recorded. Ties fall through to the caller's stable ordering.
 */
export function comparePrimaryEvidence(
  a: PrimaryEvidenceLevel,
  b: PrimaryEvidenceLevel,
): number {
  const rank = (level: PrimaryEvidenceLevel) => level ?? 99;
  return rank(a) - rank(b);
}

/**
 * The `source_detail` keys a role assignment contributes.
 *
 * One shape for every format, because the re-audit and the display rule read it
 * without knowing which kind of source wrote it.
 */
export function roleDetail(assignment: SourceImageRoleAssignment): Record<string, unknown> {
  return {
    role: assignment.role,
    role_evidence: assignment.evidence,
    role_evidence_level: assignment.evidenceLevel,
    selection_reason: assignment.reason,
  };
}
