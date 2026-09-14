/**
 * Builder stock lists — the remaining document shapes, as pure string work.
 *
 * OpenDocument, PowerPoint, RTF, JSON and XML. Each returns the same two
 * things every other reader in this feature returns — a matrix per table and
 * the readable prose — so `extract.ts` can hand them to the SAME
 * `keyRowsByHeader` and the SAME model fallback a spreadsheet gets. There is
 * one import pipeline and these are entry points to it, not parallel ones.
 *
 * No dependencies. The container formats are unzipped by the JSZip
 * `extract.ts` already loads for .docx and .xlsx; what arrives here is the XML
 * inside, and reading XML with string work is the precedent `readDocx`
 * already set in that file.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith('#x')) {
      const code = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (token.startsWith('#')) {
      const code = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[token] ?? whole;
  });
}

/** All text inside a fragment, tags removed, whitespace collapsed. */
function textOf(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// OpenDocument — .ods and .odt
// ---------------------------------------------------------------------------

/**
 * `content.xml` from an ODS or ODT.
 *
 * Both use `<table:table>` for a grid, so one reader serves the spreadsheet
 * and the word-processor format alike. `table:number-columns-repeated` IS
 * expanded — OpenDocument uses it for ordinary runs of empty cells, so
 * ignoring it shifts every column after the first gap.
 */
export function readOpenDocument(contentXml: string): {
  tables: string[][][];
  /**
   * The same tables, each carrying the index of the `<table:table>` it came
   * from and, per row, the index of the `<table:table-row>` that produced it.
   *
   * Those indexes are the vocabulary an image anchor is written in, and they
   * are NOT the matrix's own indexes: empty rows and single-row tables are
   * dropped from the matrix, so counting positions in the output names the
   * wrong row of the input.
   */
  tableSections: Array<{ matrix: string[][]; tableIndex: number; rowIndexes: number[] }>;
  text: string;
} {
  const tables: string[][][] = [];
  const tableSections: Array<{ matrix: string[][]; tableIndex: number; rowIndexes: number[] }> = [];

  const tableFragments = contentXml.match(/<table:table\b[\s\S]*?<\/table:table>/g) ?? [];
  tableFragments.forEach((tableXml, tableIndex) => {
    const matrix: string[][] = [];
    const rowIndexes: number[] = [];
    const rowFragments = tableXml.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) ?? [];
    rowFragments.forEach((rowXml, rowIndex) => {
      const cells: string[] = [];
      // The attribute run is LAZY. Greedy, it swallows the `/` of a
      // self-closing cell, the `/>` alternative then fails, and the `>` branch
      // matches instead — so an empty repeated cell silently absorbs the NEXT
      // cell's text and repeats it.
      const cellPattern = /<table:table-cell\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g;
      let match: RegExpExecArray | null;
      while ((match = cellPattern.exec(rowXml)) !== null) {
        const attributes = match[1] ?? '';
        const value = match[2] === undefined ? '' : textOf(match[2]);
        const repeatRaw = /table:number-columns-repeated\s*=\s*"(\d+)"/.exec(attributes)?.[1];
        // Expanded even when the cell is EMPTY: a repeated blank is a run of
        // real column positions, and collapsing it shifts every column after
        // the gap onto the wrong heading. Capped because OpenDocument pads the
        // end of a row with a repeat of 1000; the trailing trim below then
        // removes whatever padding survives.
        const repeat = Math.min(Math.max(Number(repeatRaw ?? '1') || 1, 1), 200);
        for (let i = 0; i < repeat; i++) cells.push(value);
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) { matrix.push(cells); rowIndexes.push(rowIndex); }
    });
    if (matrix.length > 1) {
      tables.push(matrix);
      tableSections.push({ matrix, tableIndex, rowIndexes });
    }
  });

  const paragraphs = (contentXml.match(/<text:(?:p|h)\b[\s\S]*?<\/text:(?:p|h)>/g) ?? [])
    .map(textOf)
    .filter((line) => line.length > 0);

  return { tables, tableSections, text: paragraphs.join('\n') };
}

// ---------------------------------------------------------------------------
// PowerPoint — .pptx
// ---------------------------------------------------------------------------

/**
 * Slide XML, in slide order.
 *
 * A stock schedule on a slide is a DrawingML table (`<a:tbl>`); everything
 * else on the slide is text runs (`<a:t>`), which become the prose fallback.
 */
export function readPresentation(slideXml: string[]): {
  tables: string[][][];
  /** Each table with the slide it was drawn on — the anchor a picture on that
   *  same slide is recorded under. */
  tableSections: Array<{ matrix: string[][]; slideIndex: number }>;
  text: string;
} {
  const tables: string[][][] = [];
  const tableSections: Array<{ matrix: string[][]; slideIndex: number }> = [];
  const lines: string[] = [];

  slideXml.forEach((xml, slideIndex) => {
    for (const tableXml of xml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/g) ?? []) {
      const matrix: string[][] = [];
      for (const rowXml of tableXml.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? []) {
        const cells: string[] = [];
        for (const cellXml of rowXml.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) ?? []) {
          cells.push(
            (cellXml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
              .map((run) => decodeXmlEntities(run.replace(/<[^>]*>/g, '')))
              .join('')
              .replace(/\s+/g, ' ')
              .trim(),
          );
        }
        if (cells.length) matrix.push(cells);
      }
      if (matrix.length > 1) {
        tables.push(matrix);
        tableSections.push({ matrix, slideIndex });
      }
    }

    // One line per shape's paragraph, so a slide laid out as a list reads as
    // a list rather than as one run-on sentence.
    for (const paragraph of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const line = (paragraph.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
        .map((run) => decodeXmlEntities(run.replace(/<[^>]*>/g, '')))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) lines.push(line);
    }
  });

  return { tables, tableSections, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

/**
 * Strip RTF down to its text.
 *
 * `\cell` and `\row` become a tab and a newline, which is what makes an RTF
 * table readable by `parseDelimited` afterwards; every other control word is
 * dropped, and `\'hh` hex escapes are decoded.
 */
export function readRichText(rtf: string): string {
  // Groups that are metadata rather than content. Removed with brace
  // COUNTING, not a lazy regex: `{\\fonttbl{\\f0 Calibri;}{\\f1 Arial;}}` nests, and
  // stopping at the first `}` leaves the font names behind as body text.
  let out = removeRtfGroups(rtf, [
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'generator', 'pict',
    'object', 'themedata', 'datastore', 'listtable', 'listoverridetable',
    'rsidtbl', 'xmlnstbl',
  ]);

  out = out
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\cell\b/g, '\t')
    .replace(/\\(?:row|trowd)\b/g, '\n')
    .replace(/\\tab\b/g, '\t');

  // \'hh — a byte in the document's codepage. Latin-1 is the overwhelmingly
  // common case and a wrong accent is better than a lost line.
  out = out.replace(/\\'([0-9a-fA-F]{2})/g, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));

  // \uNNNN? — a Unicode code point followed by its fallback character.
  out = out.replace(/\\u(-?\d+)\s*\??/g, (_whole, code: string) => {
    const value = Number(code);
    const point = value < 0 ? value + 65536 : value;
    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
  });

  // Any remaining control word, then the escapes and braces.
  out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, ' ')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, ' ');

  return out
    .split('\n')
    .map((line) => line.replace(/[ \u00a0]+/g, ' ').replace(/ *\t */g, '\t').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Drop `{\\keyword …}` groups whole, however deeply they nest.
 *
 * Scans for the opening `{` of a named destination and walks forward counting
 * braces, honouring `\\{` and `\\}` escapes, so the slice removed is exactly the
 * group.
 */
function removeRtfGroups(rtf: string, keywords: string[]): string {
  // `{\fonttbl` and the ignorable form `{\*\fonttbl` — one backslash before
  // the keyword, not two.
  const opener = new RegExp(`\\{\\\\(?:\\*\\\\)?(?:${keywords.join('|')})\\b`, 'g');
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(rtf)) !== null) {
    if (match.index < cursor) continue;
    out += rtf.slice(cursor, match.index);

    let depth = 0;
    let index = match.index;
    for (; index < rtf.length; index++) {
      const char = rtf[index];
      if (char === '\\') { index++; continue; }
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) { index++; break; }
      }
    }
    cursor = index;
    opener.lastIndex = cursor;
  }

  return out + rtf.slice(cursor);
}

// ---------------------------------------------------------------------------
// JSON and XML
// ---------------------------------------------------------------------------

/**
 * A JSON or XML export, mapped onto rows.
 *
 * The common shapes are an array of objects, or an object with one array
 * property holding them. Both become rows keyed by their own field names,
 * which `normaliseStockRow` already understands — a `"suburb"` key needs no
 * special handling because the alias table already answers to it.
 *
 * Anything that is not row-shaped becomes text for the model, rather than
 * being forced into a table it is not.
 */
export function readStructured(
  raw: string,
  extension: string,
): { rows: Array<Record<string, unknown>>; text: string } {
  if (extension === 'xml') {
    const { rows, text } = readXml(raw);
    if (rows.length) return { rows, text: '' };
    return { rows: [], text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not valid JSON: hand the raw text to the model rather than failing, since
    // a JSON-ish export with a trailing comma still describes properties.
    return { rows: [], text: raw };
  }

  const rows = rowsFromJson(parsed);
  if (rows.length) return { rows, text: '' };
  return { rows: [], text: JSON.stringify(parsed, null, 2) };
}

function rowsFromJson(value: unknown): Array<Record<string, unknown>> {
  const isRow = (entry: unknown): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry);

  if (Array.isArray(value)) {
    const rows = value.filter(isRow).map(flattenRow);
    return rows.length ? rows : [];
  }

  if (isRow(value)) {
    // The largest array-of-objects property. A stock export usually nests the
    // list under `properties`, `items`, `stock` or `data`, and picking the
    // largest is more robust than a name list that will always be incomplete.
    let best: Array<Record<string, unknown>> = [];
    for (const entry of Object.values(value)) {
      if (!Array.isArray(entry)) continue;
      const rows = entry.filter(isRow).map(flattenRow);
      if (rows.length > best.length) best = rows;
    }
    if (best.length) return best;
    // A single object that itself looks like one property.
    const flat = flattenRow(value);
    return Object.keys(flat).length ? [flat] : [];
  }

  return [];
}

/**
 * One level of nesting flattened onto `parent_child` keys.
 *
 * `{"address": {"suburb": "Tarneit"}}` has to reach the normaliser as
 * something whose key mentions the suburb, or the value is silently dropped.
 */
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childValue === null || childValue === undefined) continue;
        if (typeof childValue === 'object') continue;
        // The child's own name first: "suburb" is recognised, "address_suburb"
        // is not, and the parent is only a disambiguator.
        if (!(childKey in out)) out[childKey] = childValue;
        out[`${key}_${childKey}`] = childValue;
      }
      continue;
    }
    if (Array.isArray(value)) {
      const scalars = value.filter((entry) => typeof entry !== 'object');
      if (scalars.length) out[key] = scalars.join(', ');
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * XML records.
 *
 * The repeated element is the row: whichever tag name occurs most often with
 * child elements is taken as the record, and its children become the columns.
 */
export function readXml(xml: string): { rows: Array<Record<string, unknown>>; text: string } {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Collect at EVERY level. A single left-to-right pass only ever sees the
  // document element — `<stock>` swallows the `<property>` rows inside it —
  // so each element's contents are scanned again.
  const counts = new Map<string, string[]>();
  const visit = (fragment: string, depth: number): void => {
    if (depth > 12) return;
    const pattern = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fragment)) !== null) {
      const [, name, inner] = match;
      // A record is an element that itself contains elements.
      if (!/<[A-Za-z_]/.test(inner)) continue;
      const bucket = counts.get(name) ?? [];
      bucket.push(inner);
      counts.set(name, bucket);
      visit(inner, depth + 1);
    }
  };
  visit(body, 0);

  let recordInners: string[] = [];
  for (const bucket of counts.values()) {
    if (bucket.length > recordInners.length) recordInners = bucket;
  }
  if (recordInners.length < 2) return { rows: [], text: textOf(body) };

  const rows: Array<Record<string, unknown>> = [];
  for (const inner of recordInners) {
    const row: Record<string, unknown> = {};
    const fieldPattern = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let field: RegExpExecArray | null;
    while ((field = fieldPattern.exec(inner)) !== null) {
      const [, name, value] = field;
      if (/<[A-Za-z_]/.test(value)) continue;
      const clean = textOf(value);
      if (clean) row[name] = clean;
    }
    if (Object.keys(row).length) rows.push(row);
  }

  return rows.length ? { rows, text: '' } : { rows: [], text: textOf(body) };
}
