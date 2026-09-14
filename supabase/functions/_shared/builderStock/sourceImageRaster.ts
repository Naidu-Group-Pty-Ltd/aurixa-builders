/**
 * Builder stock — turning a stored image into something measurable.
 *
 * The marketplace has to answer one question about a picture it is about to
 * put on a client's card: is this a photograph of a house, or a marketing tile
 * with a status ribbon set across it? That question cannot be answered from
 * the filename, the column, the size or the hash — only from the pixels — so
 * something has to decode them.
 *
 * WHAT THIS IS NOT. It is not an image library and must never grow into one.
 * It produces ONE thing: a small RGB thumbnail, at most `TARGET_EDGE` on its
 * long side, for `marketingOverlay.pure.ts` to measure. Nothing it returns is
 * ever stored, served, or used to alter the image the builder supplied — the
 * source bytes are immutable and are uploaded exactly as they arrived.
 *
 * FOUR CONTAINERS, ALL OF WHAT BUILDER STOCK ACCEPTS:
 *
 *   PNG   colour types 0/2/3/4/6, 8- and 16-bit, interlaced or not.
 *   JPEG  baseline AND progressive — Huffman, dequantise, inverse DCT,
 *         upsample. An eighth-scale DC-only reading was tried first and is not
 *         enough: at one sample per 8×8 block a pill's own caption shreds it
 *         into fragments too small to measure, and the live Lot 13 tile read
 *         as carrying no graphic at all.
 *   GIF   the first frame, interlaced or not.
 *   WebP  both bitstreams, lossy and lossless, in `webp.ts` and its two
 *         companions.
 *
 * AND WHAT COMES BACK FOR ANYTHING ELSE IS NOT "CLEAN". A container this cannot
 * read returns `unsupported`, a file that breaks a decoder returns `failed`, and
 * the caller turns both into a `pending` verdict that shows NO image — see
 * `marketplaceEligibility.pure.ts`. This comment used to say the opposite: that
 * an unreadable image "keeps whatever eligibility it would have had". That was
 * true of an earlier design and is exactly the fail-open the display rule now
 * refuses, because an unreadable container must never be a way for a marketing
 * tile to walk past it.
 */

import { decodeWebp } from './webp.ts';
import { inflate } from './rasterPng.ts';

/**
 * The long side of the thumbnail everything is measured on.
 *
 * Large enough that overlay LETTERING survives as measurable shapes: a caption
 * set 55px tall on a 1200×600 tile lands at 18px here, and a builder's 10px
 * disclaimer lands at 3px. Reading text geometry at 200 could not tell those
 * apart.
 */
export const TARGET_EDGE = 400;

/** A tiny RGB image: three bytes per pixel, row-major, no padding. */
export interface Thumbnail {
  width: number;
  height: number;
  /** RGB triples. */
  pixels: Uint8Array;
  /** The full-resolution size, for the record. */
  sourceWidth: number;
  sourceHeight: number;
}

/** Bytes above this are not read at all: a measurement is not worth a stall. */
const MAX_DECODE_BYTES = 12 * 1024 * 1024;
/** And a ceiling on what is worth reconstructing in an edge worker. */
const MAX_DECODE_PIXELS = 40_000_000;

/**
 * A JPEG at least this long on its long side is decoded at BLOCK RESOLUTION
 * when the caller only wants the thumbnail.
 *
 * WHY. The most expensive decode this pipeline has met in production is the
 * hero of the Lumina lots' 17.9 MB brochures: one 3556×2000 baseline JPEG,
 * 8.5 MB, measured at 3.1 s to decode here — 0.9 s of entropy parsing,
 * 1.4 s of inverse DCT, 0.3 s reading seven million pixels back down to 400.
 * The worker that has to read it is killed at around three seconds of CPU,
 * so the document elected nothing, five times over, and the card stayed
 * blank. The parse cannot be skipped (a block's coefficients say where the
 * next block starts), but the reconstruction can stop at each block's DC
 * coefficient — which IS the block's average, i.e. exactly the sample an
 * 8×8 box filter takes. Measured on the same file: 3.1 s becomes ~0.9 s.
 *
 * WHY THE BOUND MAKES IT LOSSLESS. This module's contract is a thumbnail at
 * most `TARGET_EDGE` on its long side, produced by box-filtering the full
 * raster. For a source at least 8×`TARGET_EDGE` long, the DC reading is at
 * least `TARGET_EDGE` wide, so the thumbnail that comes out of it is the
 * same resolution the full decode would have produced, made of the same
 * block averages. The recorded objection to an eighth-scale reading — a
 * caption shredding into unmeasurable fragments on a 1200×600 tile, whose
 * eighth-scale reading is 150 px — is an objection to a SMALLER thumbnail,
 * and below this bound the full decode still runs, unchanged.
 *
 * JPEG only, deliberately: it is the one container whose decode has killed
 * a worker (the entropy stage dominates PNG's inflate), and the only one
 * measured doing so. `sourceWidth`/`sourceHeight` still report the true
 * dimensions, because the pixel floors in the election read them.
 */
const COARSE_DECODE_LONG_SIDE = TARGET_EDGE * 8;

/**
 * The pixel count a container's HEADER states, read without decoding.
 *
 * For the callers that must decide whether a decode is affordable before
 * paying for it — see `documentVisualKinds` and `eligibilityDetailFor` in
 * `assessSourceImage.ts`. Null when the container is unrecognised or the
 * header cannot be read (WebP included, undissected because no oversized
 * WebP has ever been measured in a builder document); null means "nothing
 * is known", and the caller decodes exactly as it did before this existed.
 */
export function imageHeaderPixels(bytes: Uint8Array): number | null {
  if (!bytes?.length) return null;
  if (isPng(bytes) && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(16) * view.getUint32(20) || null;
  }
  if (isGif(bytes)) {
    return ((bytes[6] | (bytes[7] << 8)) * (bytes[8] | (bytes[9] << 8))) || null;
  }
  if (!isJpeg(bytes)) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // Every SOF marker, baseline through progressive, carries the frame size.
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4
      && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= bytes.length) return null;
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      return width * height || null;
    }
    at += 2 + length;
  }
  return null;
}

/**
 * What came of trying to read an image.
 *
 * `unsupported` and `failed` are kept APART because the caller does different
 * things with them over time: an unsupported container may become supported
 * when this file grows, and the eligibility version is what brings those rows
 * back for another look. Neither is ever "clean" — see
 * `marketplaceEligibility.pure.ts`.
 */
export type DecodeResult =
  | { ok: true; thumbnail: Thumbnail }
  | { ok: false; reason: 'unsupported' | 'failed' };

/** The containers this can actually read, for the record and for the tests. */
export const DECODABLE_CONTAINERS: readonly string[] = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
];

/** Which decoder reads this container. One answer, used by both callers. */
async function decodeRaster(
  bytes: Uint8Array,
  allowCoarse = false,
): Promise<DecodedRaster | null> {
  return isPng(bytes)
    ? await decodePng(bytes)
    : isJpeg(bytes)
      ? decodeJpeg(bytes, allowCoarse)
      : isGif(bytes)
        ? await decodeGif(bytes)
        : decodeWebpRaster(bytes);
}

/**
 * The thumbnail's `sourceWidth`/`sourceHeight` must state the picture the
 * builder supplied, not the resolution it happened to be read at — the
 * election's pixel floors judge them. One place, both coarse-capable callers.
 */
function statedSource(thumbnail: Thumbnail, raster: DecodedRaster): Thumbnail {
  if (!raster.coarse) return thumbnail;
  return {
    ...thumbnail,
    sourceWidth: raster.trueWidth ?? thumbnail.sourceWidth,
    sourceHeight: raster.trueHeight ?? thumbnail.sourceHeight,
  };
}

export async function decodeThumbnailResult(bytes: Uint8Array): Promise<DecodeResult> {
  if (!bytes?.length) return { ok: false, reason: 'failed' };
  if (bytes.length > MAX_DECODE_BYTES) return { ok: false, reason: 'failed' };

  const supported = isPng(bytes) || isJpeg(bytes) || isGif(bytes) || isWebp(bytes);
  if (!supported) return { ok: false, reason: 'unsupported' };

  try {
    const raster = await decodeRaster(bytes, true);
    const thumbnail = raster && box(raster.width, raster.height, raster.read);
    return thumbnail
      ? { ok: true, thumbnail: statedSource(thumbnail, raster) }
      : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Decode a WebP and reduce it, through the same box filter as everything else.
 *
 * The container is resolved in `webp.ts`; both bitstreams come back as RGB, so
 * there is nothing format-specific left by the time it reaches here — which is
 * the point. A decoder that produced its own kind of thumbnail would be a
 * second downscaler, and every threshold in the classifier is fitted against
 * this one.
 */
function decodeWebpRaster(bytes: Uint8Array): DecodedRaster | null {
  const raster = decodeWebp(bytes, { maxPixels: MAX_DECODE_PIXELS });
  if (!raster) return null;
  const { width, height, pixels } = raster;
  return { width, height, read: (x, y) => {
    const at = (y * width + x) * 3;
    return [pixels[at], pixels[at + 1], pixels[at + 2]];
  } };
}

/**
 * The picture at the size the builder supplied it.
 *
 * For the sanitizer, which has to hand back a photograph a client will look at
 * — a 400px reduction of a 1200px render would be a visible downgrade dressed
 * up as a fix. It goes through the SAME decoder dispatch and the same `read`
 * the measurement uses, so the pixels a verdict was formed about and the pixels
 * that get repaired are the same pixels.
 */
export async function decodeFullRaster(bytes: Uint8Array): Promise<FullRaster | null> {
  if (!bytes?.length) return null;
  if (bytes.length > MAX_DECODE_BYTES) return null;
  if (!(isPng(bytes) || isJpeg(bytes) || isGif(bytes) || isWebp(bytes))) return null;
  try {
    const raster = await decodeRaster(bytes);
    return raster ? materialise(raster) : null;
  } catch {
    return null;
  }
}

/** The thumbnail alone, for callers that only need the pixels. */
export async function decodeThumbnail(bytes: Uint8Array): Promise<Thumbnail | null> {
  const result = await decodeThumbnailResult(bytes);
  return result.ok ? result.thumbnail : null;
}

/** Both readings of one picture, from ONE decode. */
export type DecodedBoth =
  | { ok: true; thumbnail: Thumbnail; full: () => FullRaster | null }
  | { ok: false; reason: 'unsupported' | 'failed' };

/**
 * Decode once, and hand back both the measurement thumbnail and the full-size
 * pixels.
 *
 * WHY THIS EXISTS. The repair needs both: the classifier and the mask builder
 * work on a 400px reduction, and the repair itself has to hand back a
 * photograph at the size the builder supplied. It got them by calling
 * `decodeThumbnailResult` and then `decodeFullRaster` on the SAME bytes — two
 * full decodes of one picture, and a pure-TypeScript JPEG decode of a
 * 1819x1223 render is the most expensive thing in the whole path.
 *
 * Measured in production on 4 September 2026: every repair attempt on Lot 1731
 * Hornsea Street died `CPU Time exceeded` — 02:17, 02:25, 02:31 and 02:42, four
 * for four — where the same picture had repaired in 13.4s the day before. The
 * work was over the invocation's allowance by a margin the second decode
 * accounts for on its own.
 *
 * NOTHING ABOUT THE PICTURE CHANGES. It is the same decoder through the same
 * dispatch, the same `box` reduction and the same `materialise`, so the pixels
 * a verdict is formed about and the pixels that get repaired are what they were
 * — they are simply not read out of the container twice.
 *
 * The full raster is a THUNK because the cheap paths never need it: a picture
 * the classifier clears, or one with no plate to remove, returns before any
 * full-size buffer is allocated, exactly as it did before.
 */
export async function decodeRasterBoth(bytes: Uint8Array): Promise<DecodedBoth> {
  if (!bytes?.length) return { ok: false, reason: 'failed' };
  if (bytes.length > MAX_DECODE_BYTES) return { ok: false, reason: 'failed' };
  if (!(isPng(bytes) || isJpeg(bytes) || isGif(bytes) || isWebp(bytes))) {
    return { ok: false, reason: 'unsupported' };
  }

  try {
    const raster = await decodeRaster(bytes, true);
    if (!raster) return { ok: false, reason: 'failed' };
    const thumbnail = box(raster.width, raster.height, raster.read);
    if (!thumbnail) return { ok: false, reason: 'failed' };
    /*
     * A COARSE reading has no full-size pixels to hand back — reconstructing
     * them is the cost the coarse decode exists to avoid, and handing back
     * the block-resolution raster as "full" would let a repair store a
     * 445-pixel rendition of a 3556-pixel photograph. `full()` answers null,
     * which is the answer an over-`MAX_DECODE_PIXELS` picture has always
     * given, and every caller already treats it as "this picture cannot be
     * repaired here" rather than as a verdict about the picture.
     */
    return {
      ok: true,
      thumbnail: statedSource(thumbnail, raster),
      full: () => raster.coarse ? null : materialise(raster),
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

const isPng = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
const isGif = (b: Uint8Array) =>
  b.length > 13 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
const isWebp = (b: Uint8Array) =>
  b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function decodePng(bytes: Uint8Array): Promise<DecodedRaster | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const body = offset + 8;
    if (body + length > bytes.length) break;

    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      depth = bytes[body + 8];
      colour = bytes[body + 9];
      interlace = bytes[body + 12];
    } else if (type === 'PLTE') {
      palette = bytes.slice(body, body + length);
    } else if (type === 'tRNS') {
      // Palette transparency: one alpha byte per palette entry. (For the
      // greyscale/truecolour forms tRNS names a single transparent COLOUR —
      // rare in anything a builder publishes, and ignoring it errs toward
      // showing the pixel's own value rather than inventing one.)
      transparency = bytes.slice(body, body + length);
    } else if (type === 'IDAT') {
      idat.push(bytes.slice(body, body + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = body + length + 4;
  }

  if (!width || !height) return null;
  if (interlace !== 0 && interlace !== 1) return null;
  if (depth !== 8 && depth !== 16) return null;
  const channels = CHANNELS[colour];
  if (!channels) return null;
  if (colour === 3 && !palette) return null;

  let total = 0;
  for (const part of idat) total += part.length;
  const stream = new Uint8Array(total);
  let at = 0;
  for (const part of idat) { stream.set(part, at); at += part.length; }

  const raw = await inflate(stream);
  const sampleBytes = depth === 16 ? 2 : 1;
  const bpp = channels * sampleBytes;
  const rowBytes = width * bpp;
  const image = new Uint8Array(rowBytes * height);

  /**
   * Adam7, when the file is interlaced.
   *
   * Seven sub-images, each filtered and unfiltered independently against its
   * OWN previous row, then scattered into the full picture. Treating an
   * interlaced file as a progressive one produces a sheared mess rather than
   * an error, so this is the difference between reading such an image and
   * silently measuring nonsense.
   */
  const passes = interlace === 1
    ? [
      { x: 0, y: 0, dx: 8, dy: 8 }, { x: 4, y: 0, dx: 8, dy: 8 },
      { x: 0, y: 4, dx: 4, dy: 8 }, { x: 2, y: 0, dx: 4, dy: 4 },
      { x: 0, y: 2, dx: 2, dy: 4 }, { x: 1, y: 0, dx: 2, dy: 2 },
      { x: 0, y: 1, dx: 1, dy: 2 },
    ]
    : [{ x: 0, y: 0, dx: 1, dy: 1 }];

  let cursor = 0;
  for (const pass of passes) {
    const passWidth = Math.ceil(Math.max(0, width - pass.x) / pass.dx);
    const passHeight = Math.ceil(Math.max(0, height - pass.y) / pass.dy);
    if (!passWidth || !passHeight) continue;
    const passRowBytes = passWidth * bpp;
    if (raw.length < cursor + (passRowBytes + 1) * passHeight) return null;

    const previous = new Uint8Array(passRowBytes);
    const current = new Uint8Array(passRowBytes);
    for (let row = 0; row < passHeight; row++) {
      const filter = raw[cursor];
      const src = cursor + 1;
      cursor += passRowBytes + 1;
      for (let i = 0; i < passRowBytes; i++) {
        const value = raw[src + i];
        const a = i >= bpp ? current[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        let out: number;
        switch (filter) {
          case 0: out = value; break;
          case 1: out = value + a; break;
          case 2: out = value + b; break;
          case 3: out = value + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: return null;
        }
        current[i] = out & 0xff;
      }
      // Scatter this pass's row into the picture it belongs to.
      const y = pass.y + row * pass.dy;
      for (let column = 0; column < passWidth; column++) {
        const x = pass.x + column * pass.dx;
        image.set(
          current.subarray(column * bpp, column * bpp + bpp),
          y * rowBytes + x * bpp);
      }
      previous.set(current);
    }
  }

  /*
   * ALPHA IS COMPOSITED ONTO WHITE, never dropped. The alpha sample used to
   * be read for its stride and then ignored, so a transparent background —
   * which most encoders store over black — decoded as a large flat BLACK
   * region: exactly the substrate the flat-colour detector convicts, on a
   * picture whose browser rendering (over the page) never showed it. White,
   * because white is what the marketplace card and the portal page paint
   * behind an image, and because it is what the WebP lossless path already
   * composites onto — one concept, one answer, whatever the container.
   */
  const over = (value: number, alpha: number): number =>
    alpha >= 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255);

  const read = (x: number, y: number): [number, number, number] => {
    const at = y * rowBytes + x * bpp;
    const s = (index: number) => image[at + index * sampleBytes];
    if (colour === 3) {
      const index = s(0);
      const entry = index * 3;
      const alpha = transparency && index < transparency.length ? transparency[index] : 255;
      return [
        over(palette![entry], alpha),
        over(palette![entry + 1], alpha),
        over(palette![entry + 2], alpha),
      ];
    }
    if (colour === 0) { const g = s(0); return [g, g, g]; }
    if (colour === 4) { const g = over(s(0), s(1)); return [g, g, g]; }
    if (colour === 6) {
      const alpha = s(3);
      return [over(s(0), alpha), over(s(1), alpha), over(s(2), alpha)];
    }
    return [s(0), s(1), s(2)];
  };

  return { width, height, read };
}

// ---------------------------------------------------------------------------
// JPEG — baseline and progressive
// ---------------------------------------------------------------------------

/** Zig-zag order: where each coefficient index lands in the 8×8 block. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Separable 8-point inverse DCT, rows then columns, straight from the maths. */
const COS = (() => {
  const table = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      table[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

function inverseDct(block: Int32Array, out: Uint8Array): void {
  const rows = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += COS[x * 8 + u] * block[y * 8 + u];
      rows[y * 8 + x] = sum / 2;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += COS[y * 8 + v] * rows[v * 8 + x];
      const value = Math.round(sum / 2) + 128;
      out[y * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

interface HuffTable { lookup: Map<number, number> }

/** `length|code` packed so one map serves every code length. */
function buildHuffman(counts: Uint8Array, symbols: Uint8Array): HuffTable {
  const lookup = new Map<number, number>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      lookup.set((length << 16) | code, symbols[k++]);
      code += 1;
    }
    code <<= 1;
  }
  return { lookup };
}

interface JpegComponent {
  id: number;
  h: number;
  v: number;
  quantiser: number;
  dcTable: number;
  acTable: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Every coefficient of every block, in natural (de-zig-zagged) order. */
  coefficients: Int16Array;
}

/**
 * Decode a JPEG.
 *
 * ONE implementation for both modes. A baseline file is a progressive file
 * with a single scan covering every coefficient, so the scan loop handles it
 * without a special case, and the picture is reconstructed once at the end
 * from the coefficients every scan contributed to. That is also the only way
 * progressive CAN be decoded: its scans each carry a slice of the same blocks.
 */
/**
 * The stored raster, turned the way the camera said to display it.
 *
 * A phone photograph is usually stored sideways with an EXIF orientation tag,
 * and every browser honours the tag — so the builder's ORIGINAL renders
 * upright while a derivative made from the stored pixels rendered rotated,
 * on the same grid. The classifier and the repair are internally consistent
 * either way (both read the same raster); what the tag changes is which
 * pixels a DERIVATIVE carries, because a derivative is served as its own
 * PNG with no EXIF to correct it. So the decode itself is oriented, once,
 * for measurement and repair alike.
 */
function orientRaster(raster: DecodedRaster, orientation: number): DecodedRaster {
  const { width, height, read } = raster;
  switch (orientation) {
    case 2: return { width, height, read: (x, y) => read(width - 1 - x, y) };
    case 3: return { width, height, read: (x, y) => read(width - 1 - x, height - 1 - y) };
    case 4: return { width, height, read: (x, y) => read(x, height - 1 - y) };
    case 5: return { width: height, height: width, read: (x, y) => read(y, x) };
    case 6: return { width: height, height: width, read: (x, y) => read(y, height - 1 - x) };
    case 7: return {
      width: height, height: width,
      read: (x, y) => read(width - 1 - y, height - 1 - x),
    };
    case 8: return { width: height, height: width, read: (x, y) => read(width - 1 - y, x) };
    default: return raster;
  }
}

/**
 * The EXIF orientation out of an APP1 segment, or 1 when it carries none.
 *
 * Only the one tag is read: a six-byte Exif marker, the TIFF byte order, and
 * a walk of IFD0's entries for tag 0x0112. Anything malformed reads as 1 —
 * an unreadable orientation is an image displayed as stored, which is what
 * every decode here did before this existed.
 */
function exifOrientation(bytes: Uint8Array, body: number, length: number): number {
  const end = body + length - 2;
  if (body + 14 > end) return 1;
  // 'Exif\0\0'
  if (bytes[body] !== 0x45 || bytes[body + 1] !== 0x78 || bytes[body + 2] !== 0x69
    || bytes[body + 3] !== 0x66 || bytes[body + 4] !== 0 || bytes[body + 5] !== 0) {
    return 1;
  }
  const tiff = body + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const u16 = (at: number) => little
    ? bytes[at] | (bytes[at + 1] << 8)
    : (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number) => little
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) !== 0x0112) continue;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function decodeJpeg(bytes: Uint8Array, allowCoarse = false): DecodedRaster | null {
  const dcTables: Record<number, HuffTable> = {};
  const acTables: Record<number, HuffTable> = {};
  const quantisers: Record<number, Int32Array> = {};
  let frame: {
    width: number; height: number; progressive: boolean;
    maxH: number; maxV: number; mcusX: number; mcusY: number;
    components: JpegComponent[];
  } | null = null;
  let restartInterval = 0;
  // 0 = not yet read; 1..8 once an APP1 answered (1 = display as stored).
  let orientation = 0;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break;
    if (offset + 4 > bytes.length) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const body = offset + 4;

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame) return null;
      const height = (bytes[body + 1] << 8) | bytes[body + 2];
      const width = (bytes[body + 3] << 8) | bytes[body + 4];
      const count = bytes[body + 5];
      if (!width || !height || !count) return null;
      if (width * height > MAX_DECODE_PIXELS) return null;

      const components: JpegComponent[] = [];
      for (let i = 0; i < count; i++) {
        const at = body + 6 + i * 3;
        components.push({
          id: bytes[at],
          h: bytes[at + 1] >> 4,
          v: bytes[at + 1] & 15,
          quantiser: bytes[at + 2],
          dcTable: 0, acTable: 0,
          blocksPerLine: 0, blocksPerColumn: 0,
          coefficients: new Int16Array(0),
        });
      }
      const maxH = Math.max(...components.map((c) => c.h));
      const maxV = Math.max(...components.map((c) => c.v));
      if (!maxH || !maxV) return null;
      const mcusX = Math.ceil(width / (8 * maxH));
      const mcusY = Math.ceil(height / (8 * maxV));
      for (const component of components) {
        component.blocksPerLine = mcusX * component.h;
        component.blocksPerColumn = mcusY * component.v;
        component.coefficients =
          new Int16Array(component.blocksPerLine * component.blocksPerColumn * 64);
      }
      frame = {
        width, height, progressive: marker === 0xc2,
        maxH, maxV, mcusX, mcusY, components,
      };
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
      // Arithmetic-coded, lossless and hierarchical modes are not implemented.
      return null;
    } else if (marker === 0xc4) {
      let at = body;
      while (at < body + length - 2) {
        const spec = bytes[at];
        const counts = bytes.slice(at + 1, at + 17);
        let total = 0;
        for (const value of counts) total += value;
        const symbols = bytes.slice(at + 17, at + 17 + total);
        const table = buildHuffman(counts, symbols);
        if (spec >> 4) acTables[spec & 15] = table;
        else dcTables[spec & 15] = table;
        at += 17 + total;
      }
    } else if (marker === 0xdb) {
      let at = body;
      while (at < body + length - 2) {
        const precision = bytes[at] >> 4;
        const id = bytes[at] & 15;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = precision
            ? (bytes[at + 1 + i * 2] << 8) | bytes[at + 2 + i * 2]
            : bytes[at + 1 + i];
        }
        quantisers[id] = table;
        at += 1 + (precision ? 128 : 64);
      }
    } else if (marker === 0xdd) {
      restartInterval = (bytes[body] << 8) | bytes[body + 1];
    } else if (marker === 0xe1) {
      // APP1 — EXIF, when it is. The first orientation wins; a later APP1
      // (XMP shares the marker) never overrides a tag already read.
      if (orientation === 0) orientation = exifOrientation(bytes, body, length);
    } else if (marker === 0xda) {
      if (!frame) return null;
      const count = bytes[body];
      const scan: JpegComponent[] = [];
      for (let i = 0; i < count; i++) {
        const id = bytes[body + 1 + i * 2];
        const tables = bytes[body + 2 + i * 2];
        const component = frame.components.find((c) => c.id === id);
        if (!component) return null;
        component.dcTable = tables >> 4;
        component.acTable = tables & 15;
        scan.push(component);
      }
      const spectralStart = bytes[body + 1 + count * 2];
      const spectralEnd = bytes[body + 2 + count * 2];
      const approximation = bytes[body + 3 + count * 2];

      const consumed = decodeScan(bytes, body + length - 2, frame, scan, {
        dcTables, acTables, restartInterval,
        spectralStart, spectralEnd,
        successiveHigh: approximation >> 4,
        successiveLow: approximation & 15,
      });
      if (consumed < 0) break;
      offset = consumed;
      continue;
    }
    offset = body + length - 2;
  }

  if (!frame) return null;
  const coarse = allowCoarse
    && Math.max(frame.width, frame.height) >= COARSE_DECODE_LONG_SIDE;
  const raster = reconstruct(frame, quantisers, coarse);
  if (!raster) return null;
  const oriented = orientation > 1 ? orientRaster(raster, orientation) : raster;
  if (!coarse) return oriented;
  // The camera's orientation turns the true dimensions exactly as it turned
  // the raster's, or `sourceWidth`/`sourceHeight` would state a sideways size.
  const swapped = orientation >= 5 && orientation <= 8;
  return {
    ...oriented,
    coarse: true,
    trueWidth: swapped ? frame.height : frame.width,
    trueHeight: swapped ? frame.width : frame.height,
  };
}

/**
 * One scan, which is a slice of the picture's coefficients.
 *
 * Returns where the entropy-coded data ended, so the marker loop can resume —
 * a scan's length is not in its header, it runs until the next marker.
 */
function decodeScan(
  bytes: Uint8Array,
  start: number,
  frame: NonNullable<ReturnType<typeof frameOf>>,
  scan: JpegComponent[],
  options: {
    dcTables: Record<number, HuffTable>;
    acTables: Record<number, HuffTable>;
    restartInterval: number;
    spectralStart: number;
    spectralEnd: number;
    successiveHigh: number;
    successiveLow: number;
  },
): number {
  let position = start;
  let bitBuffer = 0;
  let bitCount = 0;
  let eobRun = 0;

  const nextBit = (): number => {
    if (bitCount === 0) {
      if (position >= bytes.length) throw new Error('eof');
      let byte = bytes[position++];
      if (byte === 0xff) {
        const next = bytes[position];
        if (next === 0x00) position += 1;
        else throw new Error('marker');
      }
      bitBuffer = byte;
      bitCount = 8;
    }
    bitCount -= 1;
    return (bitBuffer >> bitCount) & 1;
  };

  const decodeSymbol = (table: HuffTable | undefined): number => {
    if (!table) throw new Error('table');
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | nextBit();
      const symbol = table.lookup.get((length << 16) | code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('huffman');
  };

  const receive = (size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i++) value = (value << 1) | nextBit();
    return value;
  };
  const extend = (value: number, size: number) =>
    size === 0 ? 0 : value < (1 << (size - 1)) ? value - (1 << size) + 1 : value;

  const predictions = new Int32Array(scan.length);
  const { spectralStart: ss, spectralEnd: se, successiveHigh: ah, successiveLow: al } = options;
  const progressive = frame.progressive;

  const decodeBlock = (component: JpegComponent, index: number, componentIndex: number) => {
    const at = index * 64;
    const coefficients = component.coefficients;

    if (!progressive) {
      const size = decodeSymbol(options.dcTables[component.dcTable]);
      predictions[componentIndex] += extend(receive(size), size);
      coefficients[at] = predictions[componentIndex];
      for (let k = 1; k < 64;) {
        const rs = decodeSymbol(options.acTables[component.acTable]);
        const run = rs >> 4;
        const magnitude = rs & 15;
        if (magnitude === 0) {
          if (run !== 15) break;
          k += 16;
          continue;
        }
        k += run;
        if (k > 63) break;
        coefficients[at + ZIGZAG[k]] = extend(receive(magnitude), magnitude);
        k += 1;
      }
      return;
    }

    if (ss === 0) {
      // The DC slice: first pass carries the value, later passes refine it.
      if (ah === 0) {
        const size = decodeSymbol(options.dcTables[component.dcTable]);
        predictions[componentIndex] += extend(receive(size), size);
        coefficients[at] = predictions[componentIndex] << al;
      } else if (nextBit()) {
        coefficients[at] |= 1 << al;
      }
      return;
    }

    // An AC slice, over the coefficients ss..se only.
    if (ah === 0) {
      if (eobRun > 0) { eobRun -= 1; return; }
      for (let k = ss; k <= se;) {
        const rs = decodeSymbol(options.acTables[component.acTable]);
        const run = rs >> 4;
        const magnitude = rs & 15;
        if (magnitude === 0) {
          if (run < 15) {
            eobRun = (1 << run) - 1;
            if (run) eobRun += receive(run);
            break;
          }
          k += 16;
          continue;
        }
        k += run;
        if (k > se) break;
        coefficients[at + ZIGZAG[k]] = extend(receive(magnitude), magnitude) * (1 << al);
        k += 1;
      }
      return;
    }

    // AC refinement: correction bits for what earlier scans already placed.
    const plus = 1 << al;
    const minus = -1 << al;
    let k = ss;
    if (eobRun > 0) {
      eobRun -= 1;
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k];
        if (coefficients[z] !== 0 && nextBit()) {
          if ((coefficients[z] & plus) === 0) {
            coefficients[z] += coefficients[z] >= 0 ? plus : minus;
          }
        }
      }
      return;
    }
    while (k <= se) {
      const rs = decodeSymbol(options.acTables[component.acTable]);
      let run = rs >> 4;
      const magnitude = rs & 15;
      let value = 0;
      if (magnitude === 0) {
        if (run < 15) {
          eobRun = (1 << run) - 1;
          if (run) eobRun += receive(run);
          break;
        }
      } else {
        value = nextBit() ? plus : minus;
      }
      while (k <= se) {
        const z = at + ZIGZAG[k];
        if (coefficients[z] !== 0) {
          if (nextBit() && (coefficients[z] & plus) === 0) {
            coefficients[z] += coefficients[z] >= 0 ? plus : minus;
          }
        } else {
          if (run === 0) {
            if (value !== 0) coefficients[z] = value;
            k += 1;
            break;
          }
          run -= 1;
        }
        k += 1;
      }
    }
    if (eobRun > 0) {
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k];
        if (coefficients[z] !== 0 && nextBit()) {
          if ((coefficients[z] & plus) === 0) {
            coefficients[z] += coefficients[z] >= 0 ? plus : minus;
          }
        }
      }
    }
  };

  const single = scan.length === 1;
  const totalUnits = single
    ? Math.ceil(scan[0].blocksPerLine / 1) * scan[0].blocksPerColumn
    : frame.mcusX * frame.mcusY;
  const interval = options.restartInterval || totalUnits;

  try {
    let unit = 0;
    while (unit < totalUnits) {
      const until = Math.min(totalUnits, unit + interval);
      predictions.fill(0);
      eobRun = 0;
      for (; unit < until; unit++) {
        if (single) {
          const component = scan[0];
          const perLine = component.blocksPerLine;
          const row = Math.floor(unit / perLine);
          const column = unit % perLine;
          if (row >= component.blocksPerColumn) break;
          decodeBlock(component, row * perLine + column, 0);
        } else {
          const mx = unit % frame.mcusX;
          const my = Math.floor(unit / frame.mcusX);
          for (let i = 0; i < scan.length; i++) {
            const component = scan[i];
            for (let by = 0; by < component.v; by++) {
              for (let bx = 0; bx < component.h; bx++) {
                const row = my * component.v + by;
                const column = mx * component.h + bx;
                decodeBlock(component, row * component.blocksPerLine + column, i);
              }
            }
          }
        }
      }
      // Step over the restart marker, if this scan uses them.
      bitCount = 0;
      if (unit < totalUnits) {
        while (position + 1 < bytes.length
          && !(bytes[position] === 0xff && bytes[position + 1] >= 0xd0
            && bytes[position + 1] <= 0xd7)) position += 1;
        if (position + 1 >= bytes.length) break;
        position += 2;
      }
    }
  } catch {
    // A truncated or malformed scan contributes what it managed. The picture
    // is still reconstructed: a partial reading of a marketing tile still
    // shows the tile.
  }

  // Walk to the next marker, which is where the caller resumes.
  while (position + 1 < bytes.length) {
    if (bytes[position] === 0xff && bytes[position + 1] !== 0x00
      && !(bytes[position + 1] >= 0xd0 && bytes[position + 1] <= 0xd7)) {
      return position;
    }
    position += 1;
  }
  return -1;
}

/** Only so `decodeScan` can name the frame's type without repeating it. */
function frameOf() {
  return null as unknown as {
    width: number; height: number; progressive: boolean;
    maxH: number; maxV: number; mcusX: number; mcusY: number;
    components: JpegComponent[];
  };
}

/** Dequantise, invert the DCT, and turn YCbCr into RGB. */
function reconstruct(
  frame: NonNullable<ReturnType<typeof frameOf>>,
  quantisers: Record<number, Int32Array>,
  coarse = false,
): DecodedRaster | null {
  /*
   * COARSE: one value per block, and that value is exact. A block whose AC
   * coefficients are ignored inverse-transforms to a flat field at its DC
   * level — `round(DC × quantiser / 8) + 128` pixel-for-pixel — which is the
   * block's average, i.e. the very sample an 8×8 box filter would take from
   * the full reconstruction. So the plane is built at block resolution, the
   * chroma mapping below works unchanged (a plane's `width` is simply its
   * blocks-per-line), and the 1,024-multiply IDCT per block is not run.
   */
  const block = new Int32Array(64);
  const spatial = new Uint8Array(64);
  const planes = frame.components.map((component) => {
    const width = coarse ? component.blocksPerLine : component.blocksPerLine * 8;
    const height = coarse ? component.blocksPerColumn : component.blocksPerColumn * 8;
    const data = new Uint8Array(width * height);
    const quantiser = quantisers[component.quantiser];
    if (coarse) {
      const dcQuantiser = quantiser ? quantiser[0] : 1;
      const blocks = component.blocksPerLine * component.blocksPerColumn;
      for (let at = 0; at < blocks; at++) {
        data[at] = clamp(
          Math.round(component.coefficients[at * 64] * dcQuantiser / 8) + 128);
      }
      return { width, height, data, h: component.h, v: component.v };
    }
    for (let row = 0; row < component.blocksPerColumn; row++) {
      for (let column = 0; column < component.blocksPerLine; column++) {
        const at = (row * component.blocksPerLine + column) * 64;
        for (let i = 0; i < 64; i++) {
          block[i] = component.coefficients[at + i] * (quantiser ? quantiser[i] : 1);
        }
        inverseDct(block, spatial);
        for (let y = 0; y < 8; y++) {
          data.set(
            spatial.subarray(y * 8, y * 8 + 8),
            (row * 8 + y) * width + column * 8);
        }
      }
    }
    return { width, height, data, h: component.h, v: component.v };
  });

  const sample = (index: number, x: number, y: number): number => {
    const plane = planes[index];
    const px = Math.min(plane.width - 1, Math.floor(x * plane.h / frame.maxH));
    const py = Math.min(plane.height - 1, Math.floor(y * plane.v / frame.maxV));
    return plane.data[py * plane.width + px];
  };

  const read = (x: number, y: number): [number, number, number] => {
    const luma = sample(0, x, y);
    if (planes.length < 3) return [luma, luma, luma];
    const cb = sample(1, x, y) - 128;
    const cr = sample(2, x, y) - 128;
    return [
      clamp(luma + 1.402 * cr),
      clamp(luma - 0.344136 * cb - 0.714136 * cr),
      clamp(luma + 1.772 * cb),
    ];
  };

  return coarse
    ? {
      width: Math.ceil(frame.width / 8),
      height: Math.ceil(frame.height / 8),
      read,
    }
    : { width: frame.width, height: frame.height, read };
}

const clamp = (value: number) => value < 0 ? 0 : value > 255 ? 255 : value;

// ---------------------------------------------------------------------------
// GIF — the first frame
// ---------------------------------------------------------------------------

/**
 * Decode a GIF's first frame.
 *
 * Only the first: a marketing tile that animates is still a marketing tile in
 * its opening frame, and measuring one frame answers the question. Interlaced
 * frames are handled, because a GIF saved for the web often is.
 */
async function decodeGif(bytes: Uint8Array): Promise<DecodedRaster | null> {
  if (bytes.length < 14) return null;
  const screenWidth = bytes[6] | (bytes[7] << 8);
  const screenHeight = bytes[8] | (bytes[9] << 8);
  if (!screenWidth || !screenHeight) return null;
  if (screenWidth * screenHeight > MAX_DECODE_PIXELS) return null;

  const packed = bytes[10];
  let offset = 13;
  let globalPalette: Uint8Array | null = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 7);
    globalPalette = bytes.slice(offset, offset + size * 3);
    offset += size * 3;
  }

  // Walk the blocks until the first image descriptor.
  let transparentIndex = -1;
  while (offset < bytes.length) {
    const introducer = bytes[offset];
    if (introducer === 0x3b) return null;            // trailer: no frame
    if (introducer === 0x21) {                        // an extension
      // The Graphic Control Extension carries the frame's transparency: a
      // flag and the palette index that means "show what is behind me". It
      // used to be skipped with the rest, so a transparent background drew
      // as whatever colour its index happened to name.
      if (bytes[offset + 1] === 0xf9 && bytes[offset + 2] >= 4
        && offset + 6 < bytes.length && (bytes[offset + 3] & 0x01)) {
        transparentIndex = bytes[offset + 6];
      }
      offset += 2;
      while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
      offset += 1;
      continue;
    }
    if (introducer !== 0x2c) return null;

    const left = bytes[offset + 1] | (bytes[offset + 2] << 8);
    const top = bytes[offset + 3] | (bytes[offset + 4] << 8);
    const frameWidth = bytes[offset + 5] | (bytes[offset + 6] << 8);
    const frameHeight = bytes[offset + 7] | (bytes[offset + 8] << 8);
    const flags = bytes[offset + 9];
    offset += 10;

    let palette = globalPalette;
    if (flags & 0x80) {
      const size = 2 << (flags & 7);
      palette = bytes.slice(offset, offset + size * 3);
      offset += size * 3;
    }
    if (!palette || !frameWidth || !frameHeight) return null;

    const minimumCodeSize = bytes[offset++];
    // Sub-blocks, concatenated.
    const parts: Uint8Array[] = [];
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (!size) break;
      parts.push(bytes.slice(offset, offset + size));
      offset += size;
    }
    let total = 0;
    for (const part of parts) total += part.length;
    const data = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { data.set(part, at); at += part.length; }

    const indices = lzwDecode(data, minimumCodeSize, frameWidth * frameHeight);
    if (!indices) return null;

    // The frame may be smaller than the screen, and may be interlaced. The
    // canvas is WHITE, and a transparent pixel stays white — the same answer
    // alpha gets in every other container here: what shows through a
    // transparent picture is the page it sits on, and the page is white.
    const canvas = new Uint8Array(screenWidth * screenHeight * 3).fill(255);
    const rows = flags & 0x40
      ? interlacedRowOrder(frameHeight)
      : Array.from({ length: frameHeight }, (_, i) => i);
    for (let source = 0; source < rows.length; source++) {
      const y = top + rows[source];
      if (y < 0 || y >= screenHeight) continue;
      for (let x = 0; x < frameWidth; x++) {
        const px = left + x;
        if (px < 0 || px >= screenWidth) continue;
        const index = indices[source * frameWidth + x];
        if (index === transparentIndex) continue;
        const entry = index * 3;
        const to = (y * screenWidth + px) * 3;
        canvas[to] = palette[entry] ?? 0;
        canvas[to + 1] = palette[entry + 1] ?? 0;
        canvas[to + 2] = palette[entry + 2] ?? 0;
      }
    }

    return { width: screenWidth, height: screenHeight, read: (x, y) => {
      const from = (y * screenWidth + x) * 3;
      return [canvas[from], canvas[from + 1], canvas[from + 2]];
    } };
  }
  return null;
}

/** GIF's four-pass interlace, as the row each source line lands on. */
function interlacedRowOrder(height: number): number[] {
  const order: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) order.push(y);
  }
  return order;
}

/** GIF's variable-width LZW, which is the only compression it has. */
function lzwDecode(
  data: Uint8Array,
  minimumCodeSize: number,
  expected: number,
): Uint8Array | null {
  if (minimumCodeSize < 2 || minimumCodeSize > 11) return null;
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(expected);
  let written = 0;

  // The dictionary, as a prefix/suffix pair per code — no string building.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  let codeSize = minimumCodeSize + 1;
  let next = endCode + 1;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;

  const reset = () => {
    codeSize = minimumCodeSize + 1;
    next = endCode + 1;
    previous = -1;
  };
  for (let i = 0; i < clearCode; i++) { prefix[i] = -1; suffix[i] = i; }

  while (written < expected) {
    while (bitCount < codeSize) {
      if (position >= data.length) return written ? out : null;
      bitBuffer |= data[position++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) { reset(); continue; }
    if (code === endCode) break;

    let current = code;
    let depth = 0;
    if (code >= next) {
      if (previous < 0) return null;
      // The one self-referential case LZW allows.
      stack[depth++] = suffix[firstOf(prefix, suffix, previous)];
      current = previous;
    }
    while (current >= 0 && depth < 4096) {
      stack[depth++] = suffix[current];
      current = prefix[current];
    }
    while (depth > 0 && written < expected) out[written++] = stack[--depth];

    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = suffix[firstOf(prefix, suffix, code >= next ? previous : code)];
      next += 1;
      if ((next & (next - 1)) === 0 && next < 4096 && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }

  return out;
}

/** The first byte a dictionary code expands to. */
function firstOf(prefix: Int32Array, suffix: Uint8Array, code: number): number {
  let current = code;
  let guard = 0;
  while (prefix[current] >= 0 && guard++ < 4096) current = prefix[current];
  return current;
}

// ---------------------------------------------------------------------------
// Downscale
// ---------------------------------------------------------------------------

/**
 * Box-filter down to `TARGET_EDGE` on the long side.
 *
 * Averaging rather than sampling, so a one-pixel line cannot masquerade as a
 * flat region and a dithered gradient cannot masquerade as texture.
 */
/**
 * A decoded picture, before anyone decides how big they want it.
 *
 * Every decoder below already reconstructs the FULL image and then reduces it —
 * `read(x, y)` is the full-resolution pixel. Returning that instead of the
 * reduction is what lets one caller measure a thumbnail and another rebuild the
 * picture at the size the builder supplied, off ONE decode and one set of
 * bytes. Two decoders would be two opinions about the same file.
 */
export interface DecodedRaster {
  width: number;
  height: number;
  read: (x: number, y: number) => [number, number, number];
  /**
   * Set when the raster is a block-resolution reading of a larger picture —
   * see `COARSE_DECODE_LONG_SIDE`. `width`/`height` are then the resolution
   * `read` answers at, and `trueWidth`/`trueHeight` are the picture's own.
   */
  coarse?: boolean;
  trueWidth?: number;
  trueHeight?: number;
}

/** The picture at the size it was supplied, as RGB triples. */
export interface FullRaster {
  width: number;
  height: number;
  /** RGB triples, row-major, no padding. */
  pixels: Uint8Array;
}

function materialise(raster: DecodedRaster): FullRaster | null {
  const { width, height, read } = raster;
  if (width <= 0 || height <= 0) return null;
  if (width * height > MAX_DECODE_PIXELS) return null;
  const pixels = new Uint8Array(width * height * 3);
  let at = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = read(x, y);
      pixels[at++] = r;
      pixels[at++] = g;
      pixels[at++] = b;
    }
  }
  return { width, height, pixels };
}

function box(
  width: number,
  height: number,
  read: (x: number, y: number) => [number, number, number],
): Thumbnail | null {
  if (width < 4 || height < 4) return null;
  const scale = Math.max(1, Math.max(width, height) / TARGET_EDGE);
  const outW = Math.max(1, Math.floor(width / scale));
  const outH = Math.max(1, Math.floor(height / scale));
  const pixels = new Uint8Array(outW * outH * 3);

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * height / outH);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * width / outW);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const [pr, pg, pb] = read(sx, sy);
          r += pr; g += pg; b += pb; n += 1;
        }
      }
      const at = (y * outW + x) * 3;
      pixels[at] = Math.round(r / n);
      pixels[at + 1] = Math.round(g / n);
      pixels[at + 2] = Math.round(b / n);
    }
  }

  return { width: outW, height: outH, pixels, sourceWidth: width, sourceHeight: height };
}
