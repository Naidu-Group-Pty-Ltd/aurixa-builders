/**
 * BUILDER STOCK — THE DOCUMENTS A PROPERTY'S OWN ROW LINKS TO.
 *
 * A builder's stock list carries each property's brochure, floor plan and
 * siting as links in the property's own row — the same links the image
 * pipeline reads a photograph out of. A property page shows them as links,
 * named by the column the builder filed each one under, so a person looking
 * at the property can open the builder's own document rather than be told
 * about it.
 *
 * ATTRIBUTION IS THE ROW AND ONLY THE ROW, for the reason
 * `rowSourceBranches` gives: nothing is looked up by lot, estate or design, so
 * two products on one lot cannot reach each other's documents. The links are
 * read with `rowSourceBranchCandidates` — the function the pipeline itself
 * reads — over `unmappedWithRecoveredLinks`, so a sheet whose links only the
 * hyperlink recovery could see shows them too.
 *
 * WHAT A LINK IS CALLED IS THE BUILDER'S WORD. The kind below is read from the
 * column heading, because that is what the builder said the document is; the
 * URL says nothing about whether a PDF is a brochure or a floor plan.
 *
 * Pure: no IO. Loaded by the edge functions under Deno and by vitest.
 */
import {
  rowSourceBranchCandidates, unmappedWithRecoveredLinks,
} from './sourceBranches.pure.ts';

/** What the builder filed a link under. */
export type PropertyDocumentKind = 'brochure' | 'floor_plan' | 'site_plan' | 'estate' | 'other';

export interface PropertyDocumentLink {
  url: string;
  /** The column heading, less a trailing "URL"/"Link". */
  label: string;
  kind: PropertyDocumentKind;
}

/** A page lists a property's documents, not a sheet's whole link column. */
export const MAX_PROPERTY_DOCUMENT_LINKS = 12;

/**
 * Longest, most specific first: "Estate Brochure" is an estate document that
 * happens to contain the word brochure, and "Floor Plan" must not read as a
 * site plan because both end in "plan".
 */
const KIND_BY_HEADING: Array<[RegExp, PropertyDocumentKind]> = [
  [/\bestate\b|location\s*map/i, 'estate'],
  [/floor\s*-?\s*plans?\b/i, 'floor_plan'],
  [/\bsiting\b|site\s*plan|master\s*-?\s*plan|stage\s*plan|plan\s*of\s*sub/i, 'site_plan'],
  [/brochure|package|flyer|info(?:rmation)?\s*pack/i, 'brochure'],
];

export function propertyDocumentKind(heading: string): PropertyDocumentKind {
  for (const [pattern, kind] of KIND_BY_HEADING) {
    if (pattern.test(heading)) return kind;
  }
  return 'other';
}

function labelFor(column: string): string {
  const label = column.replace(/\s*(?:url|link)\s*$/i, '').trim();
  return label || column.trim() || 'Document';
}

/**
 * The links a stored `source_row` carries, in the pipeline's own order and
 * de-duplication (the first column to carry a URL keeps it).
 */
export function propertyDocumentLinks(
  sourceRow: Record<string, unknown> | null | undefined,
): PropertyDocumentLink[] {
  const row = (sourceRow ?? {}) as Record<string, unknown>;
  const unmapped = unmappedWithRecoveredLinks(
    (row.unmapped ?? null) as Record<string, string> | null, row);
  const links: PropertyDocumentLink[] = [];
  for (const branch of rowSourceBranchCandidates(unmapped)) {
    let parsed: URL;
    try {
      parsed = new URL(branch.url);
    } catch {
      continue;
    }
    // A link a person opens: never a scheme a browser would execute.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    links.push({
      url: branch.url,
      label: labelFor(branch.column),
      kind: propertyDocumentKind(branch.column),
    });
    if (links.length >= MAX_PROPERTY_DOCUMENT_LINKS) break;
  }
  return links;
}
