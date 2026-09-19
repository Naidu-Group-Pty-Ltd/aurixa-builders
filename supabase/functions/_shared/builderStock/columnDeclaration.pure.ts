/**
 * BUILDER STOCK — WHAT A STOCK LIST'S COLUMN HEADING DECLARES ITS LINKS TO BE.
 *
 * THE MEASUREMENT THAT MADE THIS NECESSARY. On 19 September 2026 the live
 * marketplace carried 46 cards and **13 of them led with a picture taken from
 * an estate-level column** — 8 from `Siting / Masterplan URL`, 4 from
 * `Estate Brochure / Location Map URL`, 1 from `Stage Plan / PlanOfSub URL`.
 * Those 12 estate-column leads came from **four files**; one file was the
 * lead picture on four different properties across two house designs. Every
 * one of them passed provenance, ownership, role and the marketplace overlay
 * measure, because not one of those four questions is "is this a photograph
 * of a house".
 *
 * WHY THE EXISTING GUARDS DID NOT CATCH IT, measured rather than assumed:
 *
 *   THE SHARED-LINK GUARD had never once fired — `sharedBranchLinks.pure.ts`
 *   records why — and was repaired four hours AFTER these pictures were
 *   stored. On this list it has since refused five branches in total.
 *
 *   THE FILE-NAME GUARD (`isNonFacadeImageName`) reads the name from the
 *   URL's last path segment. A Google Drive link is `…/file/d/<id>/view`, so
 *   the name it sees is `view`. It is structurally incapable of reading any
 *   Drive link, which is what every link on this list is.
 *
 * SO THE DECLARATION IS READ WHERE THE BUILDER ACTUALLY MADE IT. A column
 * headed `Siting / Masterplan` is the same evidence, from the same author, in
 * the same document, as a file named `Master Plan.jpg` — and this repository
 * already treats the second as a declaration. The vocabulary below is
 * `drivePackage.pure.ts`'s `NOT_A_PROPERTY_PHOTOGRAPH` plus the four words
 * that file lacks and this list needs: `estate`, `siting`, `location` and a
 * bare `plan`.
 *
 * THIS DOES NOT CONTRADICT `sourceBranches.pure.ts`. That module's rule —
 * "NOTHING HERE READS A COLUMN NAME" — is about which branches are WORKED:
 * keying discovery on a heading compiles one spreadsheet's structure into the
 * product, and the rule it replaced declined a property's five documents
 * because there were five. This is a different question asked later. The
 * branch is still enumerated, still recorded, still counted; what a heading
 * may do here is EXCLUDE its contents from being one property's photograph,
 * and it may never promote anything. An unrecognised heading admits nothing
 * that was not already admitted.
 *
 * IT IS FAIL-CLOSED ON THE ONE AXIS THAT CAN HURT. The dangerous direction is
 * admitting a masterplan as a house, so anything present and unreadable
 * refuses. An ABSENT heading is deliberately NOT a refusal, and that is a
 * decision rather than an oversight: `source_column` is written only by the
 * branch recovery, so an image with none did not come from a column at all —
 * it is an embedded asset or a picture a builder uploaded by hand, which is
 * the feature that exists to fix blank cards. Refusing those would empty the
 * cards this rule is meant to protect. Measured on the live list: all 46
 * leading images carry a heading, so nothing today rests on that branch.
 *
 * Pure: no IO, no clock, no network. Loaded by the edge functions under Deno
 * and by `src/lib` under vitest.
 */

/**
 * What a heading says about the pictures behind it.
 *
 * Three answers and not two, for the reason `marketplaceEligibility` needs
 * three: "the builder declared this collateral", "the builder declared
 * nothing either way" and "there is no declaration to read" are different
 * facts, and only the first two are about a column at all.
 */
export type ColumnDeclaration =
  /** The heading names the contents as something other than the house. */
  | 'collateral'
  /** A heading that says nothing about what the pictures are. */
  | 'undeclared'
  /** No heading at all — this image did not come from a column. */
  | 'absent';

/**
 * Headings that declare their contents to be something other than the house.
 *
 * DELIBERATELY A SUPERSET of `NOT_A_PROPERTY_PHOTOGRAPH`, not a reference to
 * it. That constant judges a FILE NAME the builder typed for one object; this
 * judges a COLUMN HEADING covering every row of a list, so it is the wider
 * net of the two and its extra words (`estate`, `siting`, `location`, a bare
 * `plan`) would be too wide for a file name — "Estate.jpg" as a file is a
 * picture somebody named badly, "Estate" as a column is a declaration about
 * forty-seven rows. A CI test asserts this covers every word that one has.
 *
 * A BARE `plan` IS INTENTIONAL and it is the widest token here. It admits
 * `Stage Plan`, `Plan of Subdivision`, `Plans`, `Site Plan` and every other
 * spelling a builder reaches for, and it refuses a column called `Plans &
 * Photos`. That is the fail-closed side of the one axis that can hurt: a
 * refused column costs a card its picture and the property keeps every other
 * branch; an admitted one puts a subdivision drawing in front of a buyer.
 */
export const COLLATERAL_COLUMN_TOKENS: readonly string[] = [
  // The four this rule adds, and the four the 13 live cards turned on.
  'estate', 'siting', 'location', 'plan',
  // And everything `NOT_A_PROPERTY_PHOTOGRAPH` already knows. A CI test reads
  // that module's source and fails if a word it has is missing here, because
  // the wider net must never be the narrower one.
  'aerial', 'site\\s*plan', 'master\\s*plan', 'masterplan', 'stage\\s*plan',
  'lot\\s*plan', 'floor\\s*plan', 'floorplan', 'elevation\\s*plan', 'planofsub',
  'subdivision', 'survey', 'contour', 'logo', 'letterhead', 'map', 'locality',
  'clubhouse', 'club\\s*house', 'sales\\s*office', 'display\\s*suite',
  'estate\\s*marketing', 'community', 'amenit', 'signage', 'render\\s*board',
];

/*
 * A LIST, NOT A LITERAL, so the migration that carries the same rule in SQL
 * can be compared against it by a test rather than by a reader. The plural is
 * the same declaration — production's own list writes "Stage Plan / PlanOfSub
 * URL", and a folder of "Lot Plans.jpg" — so `s?` closes every alternative.
 */
const COLUMN_DECLARES_COLLATERAL = new RegExp(
  `\\b(${COLLATERAL_COLUMN_TOKENS.join('|')})s?\\b`,
);

/**
 * A heading reduced to comparable words.
 *
 * The same normalisation `normaliseDriveName` applies, restated rather than
 * imported because that module is the Drive reader and this one must not
 * depend on it — `src/lib` loads this under vitest and that file reaches for
 * the whole package vocabulary. Punctuation becomes space, so
 * `Siting / Masterplan URL` and `siting-masterplan_url` are one heading.
 */
function normaliseHeading(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** What this heading declares. See `ColumnDeclaration`. */
export function readColumnDeclaration(heading: unknown): ColumnDeclaration {
  if (heading === null || heading === undefined) return 'absent';
  if (typeof heading !== 'string') {
    // Present and not readable as text. The builder wrote SOMETHING here and
    // this cannot say what, which is the case the fail-closed side is for.
    return 'collateral';
  }
  if (!heading.trim()) return 'absent';
  const words = normaliseHeading(heading);
  // A heading with characters in it that reduces to no words at all — "///",
  // "—" — is present and unreadable, never undeclared.
  if (!words) return 'collateral';
  return COLUMN_DECLARES_COLLATERAL.test(words) ? 'collateral' : 'undeclared';
}

/**
 * May a picture filed under this heading be one property's own photograph?
 *
 * The one predicate every caller asks. `absent` answers TRUE — see the header
 * for why that is a decision and not a gap.
 */
export function columnMaySupplyPrimaryImage(heading: unknown): boolean {
  return readColumnDeclaration(heading) !== 'collateral';
}

/**
 * The same question asked of a stored image's `source_detail`.
 *
 * ONE READER, because the display gate, the standing classifier, the client
 * mirror and the repair all have to agree about which key carries the
 * heading — and `source_column` is written in two places already. A detail
 * object that is not an object at all is treated as carrying no heading,
 * which lands on `absent`: an unreadable DETAIL is a statement about our
 * storage, never about the builder's document.
 */
export function storedColumnMaySupplyPrimaryImage(
  sourceDetail: Record<string, unknown> | null | undefined,
): boolean {
  if (!sourceDetail || typeof sourceDetail !== 'object') return true;
  return columnMaySupplyPrimaryImage(
    (sourceDetail as { source_column?: unknown }).source_column);
}

/**
 * What to record about a branch refused for its heading.
 *
 * A FINDING, NOT AN ERROR — the same distinction `takeLinkedPhotograph` draws.
 * Nothing failed: the builder filed a masterplan under a heading that says
 * masterplan, and the pipeline read them both correctly.
 */
export function columnCollateralRefusal(heading: unknown): string {
  const shown = String(heading ?? '').trim().slice(0, 80);
  return `The stock list files this link under "${shown}", which declares it to be `
    + 'estate or plan collateral rather than a photograph of this house.';
}
