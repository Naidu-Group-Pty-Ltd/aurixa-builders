/**
 * Builder stock — the photograph inside a FLATTENED brochure page.
 *
 * Some builders export their package as page pictures: one raster covering the
 * whole A4, with the property's render sitting inside it above the price and
 * the inclusions. Refusing those loses a real builder-supplied photograph —
 * the Covella package is exactly this — and serving the whole page instead
 * puts a document on a client's card.
 *
 * So the photograph is CUT OUT of the page, and the only pixels that leave
 * here are pixels the builder supplied. Nothing is generated, extended,
 * in-painted, re-drawn, up-scaled or re-styled; the result is a rectangular
 * sub-image of the page, and the rectangle is recorded so the crop can be
 * checked against the original.
 *
 * HOW THE RECTANGLE IS FOUND, AND WHY IT IS NOT A GUESS. A brochure page is
 * flat colour with things laid on it. Read row by row:
 *
 *   • a row is FLAT when the colours across it collapse to one or two — that
 *     is background, a rule, or a margin;
 *   • a run of non-flat rows is a BAND — a photograph, a text block, a price
 *     panel, a table;
 *   • a photograph is the band that is COLOURFUL: hundreds of distinct colours
 *     where type and line art have a handful, because that is what
 *     photographic content is;
 *   • it must span the page's width and occupy a real share of its height.
 *
 * And the decisive rule: EXACTLY ONE band may qualify. Two colourful bands
 * means the page is showing more than one picture and nothing here can say
 * which is the property — so nothing is attached, and the card shows no image.
 *
 * Pure: no imports, no IO, no clock.
 */

export interface FlattenedPhotoBand {
  /** Rows of the source raster, top inclusive, bottom exclusive. */
  top: number;
  bottom: number;
  /** What made it qualify, recorded on the image's provenance. */
  distinctColours: number;
  heightShare: number;
  widthShare: number;
}

/** Sampled columns per row. Enough to characterise a row, cheap over 3,500. */
const COLUMN_SAMPLES = 64;
/** Rows are examined every Nth row; a photograph is thousands of rows tall. */
const ROW_STEP = 4;
/** A row of one or two colours is background. */
const MAX_FLAT_COLOURS = 2;
/** Below this a band is a caption, a rule or a strip. */
const MIN_HEIGHT_SHARE = 0.12;
/** A photograph that fills the page IS the page — nothing was isolated. */
const MAX_HEIGHT_SHARE = 0.75;
/** Type and line art quantise to a handful of colours; photographs do not. */
const MIN_DISTINCT_COLOURS = 64;
/**
 * The photograph runs across the layout, not down one column of it.
 *
 * Not 1.0 and not 0.9: a full-bleed render still leaves a margin of flat page
 * at each edge, and on the live Covella package that margin is a sixth of the
 * sampled columns. Below three quarters is a panel or a column of type.
 */
const MIN_WIDTH_SHARE = 0.75;

/**
 * The one photographic band of a flattened page, or null.
 *
 * `pixels` is the decoded raster, `components` bytes per pixel (3 for RGB,
 * 1 for grey, 4 for CMYK). Null is returned for anything this cannot settle,
 * and null means no image is attached at all.
 */
export function isolatePhotographBand(
  pixels: Uint8Array,
  page: { width: number; height: number; components: number },
): FlattenedPhotoBand | null {
  const { width, height, components } = page;
  if (width < 200 || height < 200 || components < 1 || components > 4) return null;
  if (pixels.length < width * height * components) return null;

  const columns: number[] = [];
  for (let i = 0; i < COLUMN_SAMPLES; i++) {
    columns.push(Math.round((i * (width - 1)) / (COLUMN_SAMPLES - 1)));
  }

  /** The row's colours, quantised to 4 bits a channel. */
  const rowColours = (y: number): Set<number> => {
    const seen = new Set<number>();
    const rowStart = y * width * components;
    for (const x of columns) {
      const offset = rowStart + x * components;
      const r = pixels[offset] >> 4;
      const g = components > 1 ? pixels[offset + 1] >> 4 : r;
      const b = components > 2 ? pixels[offset + 2] >> 4 : r;
      seen.add((r << 8) | (g << 4) | b);
    }
    return seen;
  };

  // Rows, sampled, marked flat or not.
  const sampled: Array<{ y: number; flat: boolean }> = [];
  for (let y = 0; y < height; y += ROW_STEP) {
    sampled.push({ y, flat: rowColours(y).size <= MAX_FLAT_COLOURS });
  }

  // Runs of non-flat rows.
  const bands: Array<{ top: number; bottom: number }> = [];
  let start: number | null = null;
  for (const row of sampled) {
    if (!row.flat && start === null) start = row.y;
    if (row.flat && start !== null) { bands.push({ top: start, bottom: row.y }); start = null; }
  }
  if (start !== null) bands.push({ top: start, bottom: height });

  const qualifying: FlattenedPhotoBand[] = [];
  for (const band of bands) {
    const heightShare = (band.bottom - band.top) / height;
    if (heightShare < MIN_HEIGHT_SHARE || heightShare > MAX_HEIGHT_SHARE) continue;

    const colours = new Set<number>();
    let nonFlatColumns = 0;
    const rows: number[] = [];
    for (let y = band.top; y < band.bottom; y += ROW_STEP * 4) rows.push(y);
    if (!rows.length) continue;
    for (const y of rows) for (const colour of rowColours(y)) colours.add(colour);

    // Does it run across the page? A column counts when it is not the same
    // colour all the way down the band.
    for (const x of columns) {
      const seen = new Set<number>();
      for (const y of rows) {
        const offset = (y * width + x) * components;
        const r = pixels[offset] >> 4;
        const g = components > 1 ? pixels[offset + 1] >> 4 : r;
        const b = components > 2 ? pixels[offset + 2] >> 4 : r;
        seen.add((r << 8) | (g << 4) | b);
        if (seen.size > 1) break;
      }
      if (seen.size > 1) nonFlatColumns += 1;
    }
    const widthShare = nonFlatColumns / columns.length;

    if (colours.size < MIN_DISTINCT_COLOURS) continue;
    if (widthShare < MIN_WIDTH_SHARE) continue;

    qualifying.push({
      top: band.top,
      bottom: band.bottom,
      distinctColours: colours.size,
      heightShare,
      widthShare,
    });
  }

  // Exactly one, or nothing. Two photographs on a page is the page declining
  // to say which one is the property.
  return qualifying.length === 1 ? qualifying[0] : null;
}
