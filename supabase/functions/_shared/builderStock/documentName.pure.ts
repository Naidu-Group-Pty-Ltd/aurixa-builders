/**
 * ===========================================================================
 * WHAT THE DOCUMENT IS CALLED — AND WHAT IS MERELY A LABEL FOR ITS SOURCE.
 * ===========================================================================
 *
 * The deterministic PDF reader is handed a name, and it uses it as EVIDENCE:
 * `corroborateDesignFromFilename` will settle which field an unplaced page
 * line belongs to when every one of that line's words also appears in the
 * name. The rule is sound — two independent statements agreeing — and it
 * rests entirely on the name being the DOCUMENT'S OWN, something a person
 * attached to these bytes.
 *
 * `upload.original_filename` is not always that. It is whatever the transport
 * had to put in a list for a human to read, and the two transports mean
 * different things by it:
 *
 *     a file    →  `LOT 37 - HAVENWOOD 21 - PACKAGE.pdf`
 *                   the builder's own name for the document
 *     a URL     →  `alphahomes.com.au/…/LOT 37 - HAVENWOOD 21 - PACKAGE.pdf`
 *                   a display label: host, an ellipsis, a path segment
 *
 * MEASURED 22 SEPTEMBER 2026, by calling the corroborator with one unplaced
 * page line and three names for the same bytes:
 *
 *   `LOT 37 - HAVENWOOD 21 - PACKAGE.pdf`        → house_design "Havenwood 21"
 *   `alphahomes.com.au/…/LOT 37 - HAVENWOOD…`    → house_design "Havenwood 21"
 *   `alphahomes.com.au/download`                 → NOTHING
 *
 * The same bytes are a different document depending on how they arrived,
 * which is the one thing the import pipeline's own header promises is not
 * true. And the loss is the gentler half. The gain is worse:
 *
 *   `havenwood-homes.com.au/download`  with the page line `Havenwood`
 *                                                → house_design "Havenwood"
 *
 * Nothing in the document said that. A HOSTNAME said it. `nameTokens` splits
 * on every non-alphanumeric, so `havenwood-homes.com.au` contributes
 * `havenwood`, `homes`, `com`, `au` to the set the corroborator matches
 * against — and a builder's brand mark became a property field, which is
 * precisely the class this subsystem is built to refuse.
 *
 * SO THE TWO THINGS ARE SEPARATED, AND EACH TRANSPORT ANSWERS FOR ITS OWN.
 *
 * A document name is a name somebody gave THESE BYTES. A file has one by
 * construction. A URL has one when the server sent a `Content-Disposition`
 * filename, and otherwise when its own path ends in a segment carrying a file
 * extension — `/brochures/lot-37.pdf` names a document; `/download?id=9f2a`
 * names an endpoint. Where neither is true the answer is **null**, and null
 * is the honest answer: the reader then corroborates nothing, exactly as it
 * does for a file a builder saved as `download.pdf`.
 *
 * THREE RULES.
 *
 *   • A HOSTNAME IS NEVER A DOCUMENT NAME. It is the publisher, and the
 *     publisher talking about itself is the thing `organisationName` already
 *     exists to discount. This is the rule the measurement above is about.
 *   • ABSENT IS NEVER INVENTED. `snapshotFileName` falls back to the hostname
 *     and then to the literal `stock-list`, which is right for naming a
 *     stored object and wrong for evidence — so this does not reuse it.
 *   • A DISPLAY LABEL IS NEVER EVIDENCE. Nothing here may be derived from
 *     `stockSourceDisplayName`, whose whole job is to be legible in a list.
 */

/** A path segment is a document name only when it carries a file extension. */
const NAMED_FILE = /^[^/\\]+\.[A-Za-z0-9]{1,8}$/;

/**
 * The filename a server stated for its own body, or null.
 *
 * Handles both spellings RFC 6266 admits: the plain `filename=` parameter and
 * the extended `filename*=UTF-8''…` form, which is percent-encoded and wins
 * where both are present because it is the one that can carry non-ASCII.
 */
export function filenameFromContentDisposition(
  header: string | null | undefined,
): string | null {
  const raw = String(header ?? '');
  if (!raw) return null;

  const extended = raw.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended) {
    const value = extended[1].trim().replace(/^["']|["']$/g, '');
    // `UTF-8''name` — the charset and an empty language tag, then the name.
    const parts = value.split("'");
    const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
    try {
      const decoded = decodeURIComponent(encoded).trim();
      if (decoded) return basename(decoded);
    } catch { /* a malformed parameter is no name at all */ }
  }

  const plain = raw.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  if (plain) {
    const value = (plain[2] ?? plain[1] ?? '').trim().replace(/^["']|["']$/g, '');
    if (value) return basename(value);
  }
  return null;
}

/**
 * A server may state a path; only its last segment is a name. This also
 * prevents a header from smuggling a directory into anything downstream.
 */
function basename(value: string): string {
  const segments = String(value).split(/[/\\]/).filter(Boolean);
  return (segments.length ? segments[segments.length - 1] : '').trim();
}

/**
 * WHAT IS THIS DOCUMENT CALLED, as far as the transport can honestly say?
 *
 * Returns the name, or null where nothing named it. Never a hostname, never a
 * stem this module made up, never a display label.
 */
export function sourceDocumentName(input: {
  finalUrl: string;
  contentDisposition?: string | null;
}): string | null {
  const stated = filenameFromContentDisposition(input.contentDisposition);
  if (stated) return stated;

  let last = '';
  try {
    const url = new URL(input.finalUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    last = segments.length ? decodeURIComponent(segments[segments.length - 1]).trim() : '';
  } catch {
    return null;
  }
  // A bare path, a directory, or an endpoint with its name in the query
  // string: the URL did not name a document, and saying it did is inventing.
  if (!last || !NAMED_FILE.test(last)) return null;
  return last;
}
