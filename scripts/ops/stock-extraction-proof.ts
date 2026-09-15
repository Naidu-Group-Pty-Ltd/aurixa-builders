/**
 * BUILDER STOCK — EXTRACTION PROVEN END TO END, PAST THE OLD COUNT CEILING.
 *
 * The scale harness proves the ORCHESTRATION by inserting rows; this proves
 * the EXTRACTION: a real .xlsx container, built part by part the way Excel
 * builds one, with MORE THAN 150 embedded images each anchored to its own
 * property row, pushed through the very code production runs —
 * `classifyStockFile` → `extractStockFile` → `readSpreadsheetAnchors` →
 * `readZipMedia` — and required to come out COMPLETE:
 *
 *   • every row parsed, every image enumerated, none truncated;
 *   • every image carrying the SAME `sheet:<name>#<row>` anchor its property
 *     row carries, minted by the same functions, one to one;
 *   • the enumeration record on every entry reading discovered = kept,
 *     truncated = false, with no truncation warning.
 *
 * And the safeguards must still be there: a second container whose "images"
 * decompress past `MAX_MEDIA_TOTAL_BYTES` — the only shape that can, since a
 * legitimate ≤25 MB container stores its photographs already compressed —
 * must come out LOUDLY truncated, exactly as the publication gate expects.
 *
 * Read-only, network only for the pinned deps the extractor itself imports.
 * Run: deno run -A --config supabase/functions/deno.json scripts/ops/stock-extraction-proof.ts
 */
import { extractStockFile } from '../../supabase/functions/_shared/builderStock/extract.ts';
import { classifyStockFile } from '../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';
import { sheetRowAnchor } from '../../supabase/functions/_shared/builderStock/documentAnchors.pure.ts';
import { SOURCE_ANCHOR_HEADER } from '../../supabase/functions/_shared/builderStock/sourceAssets.pure.ts';

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// --- A tiny, real PNG per property, each one distinct ------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number): Uint8Array =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, body: Uint8Array): Uint8Array => {
  const typed = new Uint8Array(4 + body.length);
  typed.set(new TextEncoder().encode(type), 0);
  typed.set(body, 4);
  const out = new Uint8Array(4 + typed.length + 4);
  out.set(be32(body.length), 0);
  out.set(typed, 4);
  out.set(be32(crc32(typed)), 4 + typed.length);
  return out;
};
/** A valid 1×1 greyscale PNG carrying `i` in a private chunk, so no two share bytes. */
function tinyPng(i: number): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  // zlib-wrapped raw deflate of the two bytes [filter 0, pixel 0].
  const idat = chunk('IDAT', new Uint8Array([
    0x78, 0x01, 0x01, 0x02, 0x00, 0xfd, 0xff, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  ]));
  const marker = chunk('prVt', new TextEncoder().encode(`fixture-image-${i}`));
  const iend = chunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(
    signature.length + ihdr.length + idat.length + marker.length + iend.length);
  let at = 0;
  for (const part of [signature, ihdr, idat, marker, iend]) { out.set(part, at); at += part.length; }
  return out;
}

// --- The workbook, built the way the anchor reader reads one -----------------

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function buildWorkbook(input: {
  sheetName: string;
  rows: Array<{ address: string; suburb: string; price: number }>;
  /** Bytes for image k (1-based); anchored to data row k. */
  imageBytes: (k: number) => Uint8Array;
  imageCount: number;
}): Promise<Uint8Array> {
  const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1') as unknown as {
    default: new () => {
      file(path: string, content: string | Uint8Array): void;
      generateAsync(options: Record<string, unknown>): Promise<Uint8Array>;
    };
  };
  const zip = new JSZip();
  const n = input.rows.length;

  zip.file('[Content_Types].xml', `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`);
  zip.file('_rels/.rels', `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `${XML}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${esc(input.sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);

  const cell = (ref: string, value: string | number) => typeof value === 'number'
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
  const rowsXml = [
    `<row r="1">${cell('A1', 'Address')}${cell('B1', 'Suburb')}${cell('C1', 'Price')}${cell('D1', 'Bedrooms')}</row>`,
    ...input.rows.map((row, index) => {
      const r = index + 2;
      return `<row r="${r}">${cell(`A${r}`, row.address)}${cell(`B${r}`, row.suburb)}${cell(`C${r}`, row.price)}${cell(`D${r}`, 3)}</row>`;
    }),
  ].join('\n');
  zip.file('xl/worksheets/sheet1.xml', `${XML}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:D${n + 1}"/>
  <sheetData>
${rowsXml}
  </sheetData>
  <drawing r:id="rId1"/>
</worksheet>`);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);

  // One anchored picture per data row: data row k (1-based) sits on the
  // sheet's 0-based row k, exactly the index `sheetRowAnchor` is minted from.
  const anchors: string[] = [];
  const drawingRels: string[] = [];
  for (let k = 1; k <= input.imageCount; k++) {
    anchors.push(`  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${k}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="914400" cy="914400"/>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="${k}" name="Facade ${k}"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId${k}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:oneCellAnchor>`);
    drawingRels.push(`  <Relationship Id="rId${k}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${k}.png"/>`);
    zip.file(`xl/media/image${k}.png`, input.imageBytes(k));
  }
  zip.file('xl/drawings/drawing1.xml', `${XML}
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors.join('\n')}
</xdr:wsDr>`);
  zip.file('xl/drawings/_rels/drawing1.xml.rels', `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${drawingRels.join('\n')}
</Relationships>`);

  return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) as Uint8Array;
}

// --- Fixture 1: 160 rows, 160 row-anchored photographs, complete or bust -----

const N = 160;
const SHEET = 'Stock';
console.log(`building a real .xlsx with ${N} rows and ${N} row-anchored images …`);
const workbook = await buildWorkbook({
  sheetName: SHEET,
  rows: Array.from({ length: N }, (_unused, index) => ({
    address: `${index + 1} Proof Street`, suburb: 'Truganina', price: 500000 + index,
  })),
  imageBytes: tinyPng,
  imageCount: N,
});
console.log(`container: ${workbook.length} bytes\n`);

const classification = classifyStockFile('extraction-proof.xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
check('the container classifies as a spreadsheet', classification.kind === 'spreadsheet',
  `kind=${classification.kind}`);

const extraction = await extractStockFile(workbook, 'extraction-proof.xlsx', classification);

check(`all ${N} property rows parse`, extraction.rows.length === N
  && extraction.strategy === 'spreadsheet_table',
  `rows=${extraction.rows.length}, strategy=${extraction.strategy}`);

check(`all ${N} embedded images enumerate — past the removed 150 ceiling`,
  extraction.media.length === N, `media=${extraction.media.length}`);

const enumerations = extraction.media.map((entry) => entry.enumeration);
check('every entry records a complete enumeration (discovered = kept, untruncated)',
  extraction.media.length > 0 && enumerations.every((record) =>
    record === undefined
    || (record.discovered === N && record.kept === N && record.truncated === false)),
  enumerations[0] ? JSON.stringify(enumerations[0]) : 'no enumeration record (nothing skipped)');

check('no truncation warning was raised',
  !extraction.warnings.some((warning) => /Only \d+ of \d+ images/.test(warning)),
  extraction.warnings.join(' | ').slice(0, 120) || 'no warnings');

const rowAnchors = extraction.rows.map((row) => String(row[SOURCE_ANCHOR_HEADER] ?? ''));
const mediaAnchors = extraction.media.map((entry) => entry.anchor);
check('row anchors are the minted sheet:<name>#<row> strings',
  rowAnchors.length === N && rowAnchors.every((anchor, index) =>
    anchor === sheetRowAnchor(SHEET, index + 1)),
  `first=${rowAnchors[0]}, last=${rowAnchors[N - 1]}`);
check(`every image is attributed to its own row — ${N} distinct anchors, media[i] ↔ rows[i]`,
  new Set(mediaAnchors).size === N && mediaAnchors.every((anchor, index) =>
    anchor === rowAnchors[index]),
  `first=${mediaAnchors[0]}, last=${mediaAnchors[N - 1]}`);

check('every image kept its own bytes (no dedupe, no substitution)',
  new Set(extraction.media.map((entry) =>
    new TextDecoder('latin1').decode(entry.bytes))).size === N
  && extraction.media.every((entry) => entry.contentType === 'image/png'));

// --- Fixture 2: the byte safeguard still refuses, loudly ---------------------

console.log('\nbuilding the decompression-bomb control (12 parts × 4 MB > 40 MB budget) …');
const bombPart = new Uint8Array(4 * 1024 * 1024); // zeros: deflates to ~4 KB, inflates to 4 MB
const bomb = await buildWorkbook({
  sheetName: SHEET,
  rows: Array.from({ length: 12 }, (_unused, index) => ({
    address: `${index + 1} Bomb Street`, suburb: 'Truganina', price: 1,
  })),
  imageBytes: () => bombPart,
  imageCount: 12,
});
console.log(`container: ${bomb.length} bytes on disk, 48 MB decompressed\n`);

const bombed = await extractStockFile(bomb, 'bomb-proof.xlsx', classification);
const bombRecord = bombed.media[0]?.enumeration;
check('a container decompressing past the byte budget is truncated LOUDLY, never silently',
  bombed.media.length < 12
  && bombed.media.every((entry) => entry.enumeration?.truncated === true)
  && bombed.warnings.some((warning) => /Only \d+ of 12 images/.test(warning)),
  `kept=${bombed.media.length}/12, record=${JSON.stringify(bombRecord ?? null)}`);

// -----------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length} failure(s) — extraction is NOT proven.`);
  Deno.exit(1);
}
console.log(`\nExtraction proof passed: ${N} row-attributed embedded images enumerate completely `
  + 'through the production extractor, and the byte safeguards still refuse a bomb loudly.');
