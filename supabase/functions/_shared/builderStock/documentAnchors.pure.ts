/**
 * Builder stock — where an embedded image sits in the document that carried it.
 *
 * Every office format states the relationship between a picture and a row; the
 * import used to read none of them and fall back to counting. A spreadsheet
 * anchors a drawing to a cell. WordprocessingML puts a `<w:drawing>` inside a
 * `<w:tc>` inside a `<w:tr>`. A presentation puts the picture and the schedule
 * on one slide. OpenDocument puts a `<draw:frame>` inside a `<table:table-row>`.
 *
 * This module reads those statements out of the XML and nothing else. It never
 * decides WHICH property an image belongs to — that is
 * `sourceAssets.pure.ts` — it only reports what the container said.
 *
 * String work over XML, the precedent `readDocx` and `readOpenDocument` set.
 * Pure: no imports, no IO, no clock.
 */

/** `rId7` → the part it points at, verbatim from a `.rels` part. */
export function parseRelationships(relsXml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/gi) ?? []) {
    const id = /\bId\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (!id || !target) continue;
    // An external relationship points outside the container; there are no
    // bytes here to attribute.
    if (/TargetMode\s*=\s*"External"/i.test(tag)) continue;
    out[id] = target;
  }
  return out;
}

/**
 * Resolve a relationship target against the part that declared it.
 *
 * `xl/worksheets/_rels/sheet1.xml.rels` declaring `../drawings/drawing1.xml`
 * means `xl/drawings/drawing1.xml`, and getting this wrong silently produces
 * an empty anchor map rather than an error.
 */
export function resolveOoxmlPath(ownerPart: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const segments = ownerPart.split('/').slice(0, -1);
  // `_rels` is a sibling directory of the part it describes.
  if (segments[segments.length - 1] === '_rels') segments.pop();
  for (const piece of target.split('/')) {
    if (piece === '.' || piece === '') continue;
    if (piece === '..') { segments.pop(); continue; }
    segments.push(piece);
  }
  return segments.join('/');
}

/** The `.rels` part that describes a given part. */
export function relsPathFor(part: string): string {
  const segments = part.split('/');
  const name = segments.pop() ?? '';
  return [...segments, '_rels', `${name}.rels`].join('/');
}

/** Sheets in workbook order, with the relationship that names their part. */
export function parseWorkbookSheets(workbookXml: string): Array<{ name: string; rid: string }> {
  const out: Array<{ name: string; rid: string }> = [];
  for (const tag of workbookXml.match(/<sheet\b[^>]*\/?>/gi) ?? []) {
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    const rid = /\br:id\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (name && rid) out.push({ name, rid });
  }
  return out;
}

/**
 * Which row each drawing is anchored to.
 *
 * `<xdr:from><xdr:row>` is 0-based over the sheet's own rows, which is why
 * `extract.ts` reads the sheet WITH its blank rows: drop them and every anchor
 * below the first gap names the wrong property.
 */
export function parseDrawingAnchors(drawingXml: string): Array<{ rid: string; row: number }> {
  const out: Array<{ rid: string; row: number }> = [];
  const anchorPattern = /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(drawingXml)) !== null) {
    const fragment = match[0];
    const from = /<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<\/xdr:from>/.exec(fragment);
    const rid = /<a:blip\b[^>]*r:embed\s*=\s*"([^"]+)"/.exec(fragment)?.[1];
    if (!rid || !from) continue;
    out.push({ rid, row: Number(from[1]) });
  }
  return out;
}

/** Image relationships inside each `<w:tr>`, by table and row index. */
export function parseDocxTableImages(
  documentXml: string,
): Array<{ rid: string; table: number; row: number }> {
  const out: Array<{ rid: string; table: number; row: number }> = [];
  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
  tables.forEach((tableXml, tableIndex) => {
    const rows = tableXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? [];
    rows.forEach((rowXml, rowIndex) => {
      for (const tag of rowXml.match(/<a:blip\b[^>]*>|<v:imagedata\b[^>]*>/g) ?? []) {
        const rid = /r:(?:embed|id|link)\s*=\s*"([^"]+)"/.exec(tag)?.[1];
        if (rid) out.push({ rid, table: tableIndex, row: rowIndex });
      }
    });
  });
  return out;
}

/** Image parts referenced by each `<table:table-row>` of an OpenDocument. */
export function parseOdfTableImages(
  contentXml: string,
): Array<{ href: string; table: number; row: number }> {
  const out: Array<{ href: string; table: number; row: number }> = [];
  const tables = contentXml.match(/<table:table\b[\s\S]*?<\/table:table>/g) ?? [];
  tables.forEach((tableXml, tableIndex) => {
    const rows = tableXml.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) ?? [];
    rows.forEach((rowXml, rowIndex) => {
      for (const tag of rowXml.match(/<draw:image\b[^>]*>/g) ?? []) {
        const href = /xlink:href\s*=\s*"([^"]+)"/.exec(tag)?.[1];
        if (href) out.push({ href: href.replace(/^\.?\//, ''), table: tableIndex, row: rowIndex });
      }
    });
  });
  return out;
}

/** Image relationships used by one slide. */
export function parseSlideImages(slideXml: string): string[] {
  const out: string[] = [];
  for (const tag of slideXml.match(/<a:blip\b[^>]*>/g) ?? []) {
    const rid = /r:(?:embed|link)\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    if (rid) out.push(rid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The anchor vocabulary
//
// One string per (source, row). Media anchors and row anchors are minted by
// the SAME functions so the two halves cannot drift into dialects that never
// match.
// ---------------------------------------------------------------------------

export const sheetRowAnchor = (sheetName: string, row: number): string =>
  `sheet:${sheetName}#${row}`;

export const docxRowAnchor = (table: number, row: number): string =>
  `docx:tbl${table}#${row}`;

export const odfRowAnchor = (table: number, row: number): string =>
  `odf:tbl${table}#${row}`;

export const slideAnchor = (slide: number): string => `slide:${slide}`;

export const htmlRowAnchor = (table: number, row: number): string =>
  `html:tbl${table}#${row}`;
