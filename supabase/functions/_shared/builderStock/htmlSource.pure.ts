/**
 * Builder stock lists — reading a web page.
 *
 * Turns fetched HTML into the two things the existing pipeline already
 * consumes: a matrix per `<table>`, and the page's readable prose. Nothing
 * else. `extract.ts` then keys the matrices with the same
 * `keyRowsByHeader` a spreadsheet goes through, and the prose falls to the
 * same model-assisted path a brochure does.
 *
 * NO DOM LIBRARY AND NO SCRIPT EXECUTION. This is string work over the markup,
 * the way `readDocx` in `extract.ts` already reads WordprocessingML — which
 * matters twice over here: the page is hostile input from an address a builder
 * typed, and a parser that could run its scripts would be an obvious way to
 * turn a stock-list import into code execution. Adding a DOM dependency to
 * claim otherwise would also make this module unloadable by the unit tests.
 *
 * Pure: no imports, no IO, no clock.
 */

/** Elements whose content is never part of a stock list. */
const CHROME_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'video', 'audio',
];

/**
 * Wrappers that are page furniture wherever they appear. Matched on the class
 * or id, because that is the only signal markup gives — a cookie banner is a
 * `<div>` like everything else.
 */
const CHROME_ATTRIBUTE_HINTS = [
  'cookie', 'consent', 'gdpr', 'newsletter', 'subscribe', 'breadcrumb',
  'navbar', 'nav-bar', 'navigation', 'menu', 'sidebar', 'site-header',
  'site-footer', 'social', 'share-bar', 'advert', 'advertisement',
  'banner', 'popup', 'modal', 'skip-link',
];

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', times: '×', sup2: '²', deg: '°', pound: '£',
  euro: '€', dollar: '$', trade: '™', reg: '®', copy: '©',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith('#x')) {
      const code = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    if (token.startsWith('#')) {
      const code = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[token] ?? whole;
  });
}

/** Strip every tag from a fragment and collapse the whitespace. */
export function stripTags(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove scripts, styles and identifiable page chrome before anything reads it. */
export function stripChrome(html: string): string {
  let out = html;

  // Comments first: a commented-out block must not contribute rows.
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    // Unclosed <script src=…> and friends.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }

  // Containers whose class or id names them as furniture. Only `<div>`,
  // `<section>` and `<ul>` are considered, and only when the hint is in the
  // opening tag — a heuristic that must never eat a table, so `<table>` is
  // deliberately not in the list.
  out = out.replace(
    /<(div|section|ul)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    (whole, _tag, attributes: string, _inner) => {
      const haystack = String(attributes).toLowerCase();
      if (!/\b(class|id|role|data-testid)\s*=/.test(haystack)) return whole;
      if (/<table\b/i.test(whole)) return whole;
      return CHROME_ATTRIBUTE_HINTS.some((hint) => haystack.includes(hint)) ? ' ' : whole;
    },
  );

  return out;
}

/**
 * Every `<table>` in the document, as a matrix of cell text.
 *
 * `rowspan`/`colspan` are not expanded: a stock schedule that merges cells is
 * better read as prose by the model than reconstructed wrongly here, and
 * `keyRowsByHeader` will simply not find a header in a ragged matrix.
 */
export function extractHtmlTables(html: string): string[][][] {
  return extractHtmlTableSections(html, 'https://example.invalid/').map((table) => table.matrix);
}

/**
 * A table read as rows AND as the imagery each row contains.
 *
 * `rowImageUrls[i]` are the `<img>` sources found inside the same `<tr>` that
 * produced `matrix[i]`. That containment is the source stating a relationship:
 * a stock table with a photograph column puts the photograph in the row it
 * belongs to, and discarding it — which is what stripping the markup to text
 * did — throws away an attribution nothing downstream can reconstruct.
 */
export function extractHtmlTableSections(
  html: string,
  baseUrl: string,
): Array<{ matrix: string[][]; rowImageUrls: string[][] }> {
  const cleaned = stripChrome(html);
  const tables: Array<{ matrix: string[][]; rowImageUrls: string[][] }> = [];

  for (const tableHtml of cleaned.match(/<table\b[\s\S]*?<\/table>/gi) ?? []) {
    const matrix: string[][] = [];
    const rowImageUrls: string[][] = [];
    for (const rowHtml of tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const cells: string[] = [];
      for (const cellHtml of rowHtml.match(/<(t[hd])\b[^>]*>[\s\S]*?<\/\1>/gi) ?? []) {
        cells.push(stripTags(cellHtml));
      }
      if (!cells.length) continue;
      matrix.push(cells);
      rowImageUrls.push(imageUrlsIn(rowHtml, baseUrl));
    }
    if (matrix.length > 1) tables.push({ matrix, rowImageUrls });
  }
  return tables;
}

/**
 * The page's readable text, one line per block element.
 *
 * Used only when no table produced rows — the model then reads it under the
 * same "never invent a value" schema a brochure gets.
 */
export function extractReadableText(html: string, maxChars = 120_000): string {
  const cleaned = stripChrome(html);

  const withBreaks = cleaned
    // A cell boundary is a value boundary; without this a Notion-style table
    // row collapses into one unreadable run.
    .replace(/<\/(td|th)>/gi, ' \t')
    .replace(/<\/(tr|p|div|section|article|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  return decodeHtmlEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, maxChars);
}

/** The `<title>`, for labelling the source in the builder's history. */
export function extractHtmlTitle(html: string): string | null {
  const explicit = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const fromTitle = explicit ? stripTags(explicit[1]) : '';
  if (fromTitle) return fromTitle.slice(0, 200);

  const ogTitle = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)
    ?? /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i.exec(html);
  if (ogTitle) {
    const value = stripTags(ogTitle[1]);
    if (value) return value.slice(0, 200);
  }

  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const fromHeading = heading ? stripTags(heading[1]) : '';
  return fromHeading ? fromHeading.slice(0, 200) : null;
}

/**
 * Absolute image URLs the page carries, in document order.
 *
 * Returned for provenance only. `importStock.ts` decides whether any of them
 * can be attributed to a property — for a web page the answer is usually no,
 * and they are kept against the source rather than pinned to the wrong lot.
 */
export function extractHtmlImageUrls(html: string, baseUrl: string, limit = 20): string[] {
  return imageUrlsIn(stripChrome(html), baseUrl, limit);
}

/**
 * Absolute `<img>` sources inside ONE fragment — a row, a card, a whole page.
 *
 * Scoped rather than global on purpose: which fragment is passed in IS the
 * attribution, so this must never widen its own search.
 */
export function imageUrlsIn(fragment: string, baseUrl: string, limit = 20): string[] {
  const cleaned = fragment;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const tag of cleaned.match(/<img\b[^>]*>/gi) ?? []) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    let absolute: string;
    try {
      absolute = new URL(decodeHtmlEntities(src.trim()), baseUrl).toString();
    } catch {
      continue;
    }
    // Only http(s). A data: URI is bytes we did not fetch and cannot attribute.
    if (!/^https?:\/\//i.test(absolute)) continue;
    if (absolute.length > 1500 || seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

/**
 * Signals that a Notion URL did not give us the page BECAUSE WE MAY NOT HAVE
 * IT. A private Notion page does not 401 over HTTP — it returns 200 with a
 * request-access shell — so these are the words that shell says.
 *
 * They are the only evidence of an access restriction this module recognises.
 * "Short" is not on the list and must never be added to it: see the note on
 * `assessNotionReadability`.
 */
const NOTION_GATE_MARKERS = [
  'you need access',
  'request access',
  'log in to notion',
  'login to notion',
  'sign up for notion',
  'this content does not exist',
  'this page does not exist',
  'the page you are looking for',
  'page not found',
];

/** Accessibility and extraction are different questions. This answers the first. */
export type NotionAccessState =
  /** An explicit gate. The page said we may not read it. */
  | 'gated'
  /** Readable prose came back. Whether it is a stock list is a later question. */
  | 'content'
  /** 200, no gate, no content: Notion's ordinary client-rendering shell. */
  | 'shell';

export interface NotionReadability {
  /**
   * True ONLY when an explicit access marker was found. This is the single
   * input allowed to produce a "not publicly accessible" answer, and it is
   * evidence rather than inference.
   */
  gated: boolean;
  /** Which marker matched, for the server-side diagnostics. */
  marker: string | null;
  /**
   * True when the response was reachable and carried neither a gate nor any
   * readable text — which is what EVERY public Notion page looks like, because
   * the content arrives afterwards. Not a permission problem.
   */
  clientRendered: boolean;
  state: NotionAccessState;
  textLength: number;
}

/**
 * Is this Notion response an access gate, real content, or the shell?
 *
 * WHAT THIS DELIBERATELY NO LONGER DOES. It used to answer `gated: true` for
 * any response yielding under 40 characters of text. Every published Notion
 * page yields under 40 characters of text — the first HTML response is a 19 KB
 * rendering shell whose `<title>` is the word "Notion" — so that rule reported
 * "this page is not publicly accessible" about pages that were, in fact,
 * shared to the whole web. Telling a builder to change a sharing setting that
 * is already correct is worse than telling them nothing.
 *
 * Markers are matched against the CHROME-STRIPPED text, so a script tag that
 * happens to contain the string "request access" cannot gate a page.
 */
export function assessNotionReadability(html: string, extractedText: string): NotionReadability {
  const text = extractedText.trim();
  const haystack = `${text}\n${stripTags(stripChrome(html)).slice(0, 40_000)}`.toLowerCase();

  for (const marker of NOTION_GATE_MARKERS) {
    if (haystack.includes(marker)) {
      return { gated: true, marker, clientRendered: false, state: 'gated', textLength: text.length };
    }
  }

  // No gate. Either the page gave us prose, or it gave us its shell — and the
  // shell is the ordinary case, not a refusal.
  const clientRendered = text.length < 40;
  return {
    gated: false,
    marker: null,
    clientRendered,
    state: clientRendered ? 'shell' : 'content',
    textLength: text.length,
  };
}

/**
 * Notion renders a table as a grid of `<div>`s with `notion-table-*` classes
 * rather than a `<table>`, so the generic table reader finds nothing on a page
 * that visibly has one. This recovers those grids.
 *
 * Deliberately narrow: it keys off Notion's own class names, and returns
 * nothing when they are absent rather than guessing at arbitrary `<div>` grids.
 */
export function extractNotionGridTables(html: string): string[][][] {
  const cleaned = stripChrome(html);

  // Rows are found across the whole document and grouped, rather than by first
  // locating a container: Notion nests those containers several deep and a
  // lazy regex over nested `<div>`s closes at the wrong `</div>` every time.
  const rows: string[][] = [];
  for (const rowHtml of sliceElementsByClass(cleaned, /notion-(?:table-row|collection-item|simple-table-row)\b/i)) {
    const cells = sliceElementsByClass(rowHtml, /notion-(?:table-cell|collection-cell|simple-table-cell)\b/i)
      .map(stripTags);
    if (cells.length) rows.push(cells);
  }

  if (rows.length < 2) return [];
  return [rows];
}

/**
 * Inner HTML of every `<div>` whose class matches, with nesting handled.
 *
 * Walks the tag stream counting depth, so a container that holds other
 * `<div>`s closes where it actually closes. Nested matches are skipped —
 * a row inside a row is the outer row's content, not a second row.
 */
export function sliceElementsByClass(html: string, classPattern: RegExp): string[] {
  const out: string[] = [];
  const tagPattern = /<(\/?)(div)\b([^>]*)>/gi;

  let match: RegExpExecArray | null;
  let capturing = false;
  let depth = 0;
  let startIndex = 0;

  while ((match = tagPattern.exec(html)) !== null) {
    const closing = match[1] === '/';
    const attributes = match[3] ?? '';
    const selfClosing = /\/\s*$/.test(attributes);

    if (capturing) {
      if (closing) {
        depth--;
        if (depth === 0) {
          out.push(html.slice(startIndex, match.index));
          capturing = false;
        }
      } else if (!selfClosing) {
        depth++;
      }
      continue;
    }

    if (closing || selfClosing) continue;
    const classValue = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? '';
    if (!classPattern.test(classValue)) continue;

    capturing = true;
    depth = 1;
    startIndex = tagPattern.lastIndex;
  }

  return out;
}

/**
 * Everything a page yields, in one call.
 *
 * Notion's own grid markup is tried alongside real `<table>` elements so a
 * Notion page and an ordinary web page come out of here in the same shape.
 */
export function readHtmlSource(html: string, baseUrl: string): {
  tables: string[][][];
  /** The same tables, each carrying the imagery its own rows contain. */
  tableSections: Array<{ matrix: string[][]; rowImageUrls: string[][] }>;
  text: string;
  title: string | null;
  imageUrls: string[];
} {
  const tableSections = [
    ...extractHtmlTableSections(html, baseUrl),
    ...extractNotionGridTables(html).map((matrix) => ({
      matrix,
      rowImageUrls: matrix.map(() => [] as string[]),
    })),
  ];
  return {
    tables: tableSections.map((table) => table.matrix),
    tableSections,
    text: extractReadableText(html),
    title: extractHtmlTitle(html),
    imageUrls: extractHtmlImageUrls(html, baseUrl),
  };
}
