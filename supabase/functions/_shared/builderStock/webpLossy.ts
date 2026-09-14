/**
 * Builder stock — reading a lossy WebP key frame (VP8).
 *
 * The companion to `webpLossless.ts`, and there for the same reason: display
 * eligibility decides by DECODING the picture, it fails closed, and Builder
 * Stock accepts WebP — so a format the product takes has to be one this can
 * read, or every card carrying one is permanently empty.
 *
 * WHAT IS AND IS NOT HERE. A WebP still image is a single VP8 KEY FRAME: intra
 * prediction only, no motion vectors, no reference frames, no inter modes. That
 * is the whole of what this implements, which is a small fraction of a video
 * decoder — and all of what a still image can contain, including the in-loop
 * deblocking filter.
 *
 * IT IS BIT-EXACT. Every fixture in the test suite decodes to libwebp's output
 * byte for byte, which is the only useful standard for a decoder: a picture that
 * is nearly right is a picture whose errors nobody can bound. Three things had
 * to be exactly right rather than approximately, and each is commented where it
 * lives — the studio-range colour conversion, the bilinear chroma upsampling,
 * and the top-right neighbour rule for 4x4 prediction.
 *
 * WHY IT IS WRITTEN RATHER THAN INSTALLED. This runs inside a Supabase edge
 * function. The vetted decoder for WebP is libwebp, which reaches JavaScript
 * only as a WebAssembly or asm.js build: a binary blob nobody reviewing this
 * repository can read, fetched at deploy time, for a module whose entire job is
 * to be a deterministic, bounded, auditable measurement. So the format is
 * implemented from RFC 6386, in the same shape as the PNG, JPEG and GIF readers
 * beside it, its ~3,000 constants are extracted from that specification rather
 * than typed out, and its output is checked against libwebp's own on real
 * files.
 *
 * NOTHING HERE MODIFIES THE SOURCE. The bytes handed in are read; the pixels
 * produced exist only to be measured.
 */
import {
  AC_QLOOKUP, BMODE_TREE, CAT_PROBS, COEFF_BANDS, COEFF_UPDATE_PROBS,
  DC_QLOOKUP, DEFAULT_COEFF_PROBS, KF_BMODE_PROBS, KF_UV_MODE_PROBS,
  KF_YMODE_PROBS, KF_YMODE_TREE, MB_SEGMENT_TREE, UV_MODE_TREE, ZIGZAG,
} from './vp8Tables.ts';
import type { WebpRaster } from './webpLossless.ts';

/*
 * A note on ordering, which is the one thing about the loop filter that is easy
 * to get wrong and hard to see: it runs over the FINISHED frame, never as each
 * macroblock completes. Intra prediction reads its neighbours unfiltered, so a
 * decoder that smooths as it goes predicts every later macroblock from pixels
 * the encoder never had, and the error compounds across the picture rather than
 * staying where it started.
 */


// ---------------------------------------------------------------------------
// The boolean (arithmetic) decoder — RFC 6386 section 7
// ---------------------------------------------------------------------------

class BoolDecoder {
  private range = 255;
  private value = 0;
  private bitCount = 0;
  private position: number;
  ok = true;

  constructor(private readonly bytes: Uint8Array, start: number,
    private readonly end: number) {
    this.position = start;
    this.value = (this.nextByte() << 8) | this.nextByte();
  }

  private nextByte(): number {
    if (this.position >= this.end) { this.ok = false; return 0; }
    return this.bytes[this.position++];
  }

  bit(probability: number): number {
    const split = 1 + (((this.range - 1) * probability) >> 8);
    const bigSplit = split << 8;
    let bit = 0;
    if (this.value >= bigSplit) {
      bit = 1;
      this.range -= split;
      this.value -= bigSplit;
    } else {
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.bitCount === 8) {
        this.bitCount = 0;
        this.value |= this.nextByte();
      }
    }
    return bit;
  }

  /** A uniform value, most-significant bit first. */
  literal(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | this.bit(128);
    return value;
  }

  /** Magnitude then sign, which is how the header states every delta. */
  signed(count: number): number {
    const magnitude = this.literal(count);
    return this.bit(128) ? -magnitude : magnitude;
  }

  /** A present-flag, then a signed value if it is set. */
  optionalSigned(count: number): number {
    return this.bit(128) ? this.signed(count) : 0;
  }

  /**
   * Walk a tree. A positive entry is the index of the next pair; a
   * non-positive entry is a leaf holding the negated value.
   */
  tree(tree: number[], probabilities: ArrayLike<number>, offset = 0): number {
    let index = 0;
    let node = tree[index + this.bit(probabilities[offset + (index >> 1)])];
    while (node > 0) {
      index = node;
      node = tree[index + this.bit(probabilities[offset + (index >> 1)])];
    }
    return -node;
  }
}

// ---------------------------------------------------------------------------
// Transforms — RFC 6386 section 14
// ---------------------------------------------------------------------------

const clamp255 = (value: number) => value < 0 ? 0 : value > 255 ? 255 : value;

/** The inverse Walsh-Hadamard that spreads the Y2 block over 16 Y blocks. */
function inverseWalsh(input: Int32Array, out: Int32Array): void {
  const temp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a1 = input[i] + input[12 + i];
    const b1 = input[4 + i] + input[8 + i];
    const c1 = input[4 + i] - input[8 + i];
    const d1 = input[i] - input[12 + i];
    temp[i] = a1 + b1;
    temp[4 + i] = c1 + d1;
    temp[8 + i] = a1 - b1;
    temp[12 + i] = d1 - c1;
  }
  for (let i = 0; i < 4; i++) {
    const row = i * 4;
    const a1 = temp[row] + temp[row + 3];
    const b1 = temp[row + 1] + temp[row + 2];
    const c1 = temp[row + 1] - temp[row + 2];
    const d1 = temp[row] - temp[row + 3];
    out[row] = (a1 + b1 + 3) >> 3;
    out[row + 1] = (c1 + d1 + 3) >> 3;
    out[row + 2] = (a1 - b1 + 3) >> 3;
    out[row + 3] = (d1 - c1 + 3) >> 3;
  }
}

const COS_PI_8_SQRT2_MINUS_1 = 20091;
const SIN_PI_8_SQRT2 = 35468;

/**
 * `(value * constant) >> 16` with the specification's semantics.
 *
 * `Math.floor`, not truncation, because C's `>>` on a signed value is an
 * arithmetic shift and rounds toward minus infinity — and NOT the `>>`
 * operator, because a dequantised coefficient times 35468 overflows the 32-bit
 * integer JavaScript's shift operators silently coerce to.
 */
const multiplyHigh = (value: number, constant: number) =>
  Math.floor((value * constant) / 65536);

/** The 4x4 inverse DCT in the exact integer form the specification fixes. */
function inverseDct(block: Int32Array, out: Int32Array): void {
  const temp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a1 = block[i] + block[8 + i];
    const b1 = block[i] - block[8 + i];
    const t1 = multiplyHigh(block[4 + i], SIN_PI_8_SQRT2);
    const t2 = block[12 + i] + multiplyHigh(block[12 + i], COS_PI_8_SQRT2_MINUS_1);
    const c1 = t1 - t2;
    const t3 = block[4 + i] + multiplyHigh(block[4 + i], COS_PI_8_SQRT2_MINUS_1);
    const t4 = multiplyHigh(block[12 + i], SIN_PI_8_SQRT2);
    const d1 = t3 + t4;
    temp[i] = a1 + d1;
    temp[12 + i] = a1 - d1;
    temp[4 + i] = b1 + c1;
    temp[8 + i] = b1 - c1;
  }
  for (let i = 0; i < 4; i++) {
    const row = i * 4;
    const a1 = temp[row] + temp[row + 2];
    const b1 = temp[row] - temp[row + 2];
    const t1 = multiplyHigh(temp[row + 1], SIN_PI_8_SQRT2);
    const t2 = temp[row + 3] + multiplyHigh(temp[row + 3], COS_PI_8_SQRT2_MINUS_1);
    const c1 = t1 - t2;
    const t3 = temp[row + 1] + multiplyHigh(temp[row + 1], COS_PI_8_SQRT2_MINUS_1);
    const t4 = multiplyHigh(temp[row + 3], SIN_PI_8_SQRT2);
    const d1 = t3 + t4;
    out[row] = (a1 + d1 + 4) >> 3;
    out[row + 3] = (a1 - d1 + 4) >> 3;
    out[row + 1] = (b1 + c1 + 4) >> 3;
    out[row + 2] = (b1 - c1 + 4) >> 3;
  }
}

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

const DC_PRED = 0;
const V_PRED = 1;
const H_PRED = 2;
const TM_PRED = 3;
const B_PRED = 4;

/**
 * A reconstructed plane with a one-pixel border above and to the left, and four
 * spare columns on the right.
 *
 * The border is not padding: the specification REQUIRES 127 above the frame and
 * 129 to its left, and prediction reads them like any other neighbour. Holding
 * them in the buffer keeps every predictor branch-free at the frame edge, where
 * a special case is exactly where a decoder like this goes wrong.
 */
class Plane {
  readonly stride: number;
  readonly data: Uint8Array;
  readonly origin: number;

  constructor(readonly width: number, readonly height: number) {
    this.stride = width + 8;
    this.data = new Uint8Array(this.stride * (height + 1) + 8);
    this.origin = this.stride + 1;
    // Left column 129 first, then the whole row above the frame 127 — in that
    // order, so the corner above-left of the frame ends up 127, which is what
    // the format says and the opposite of what the two rules alone imply.
    for (let y = 0; y < height; y++) this.data[this.origin + y * this.stride - 1] = 129;
    this.data.fill(127, this.origin - this.stride - 1,
      this.origin - this.stride + width + 4);
  }
}

/**
 * Extend a reconstructed row four pixels to the right by replicating its last
 * pixel.
 *
 * The rightmost macroblock's sub-blocks still ask for four "above-right"
 * samples, and the reference decoder answers with the last pixel of the row
 * above repeated. Doing it here keeps that rule in one place instead of in
 * every predictor.
 */
function extendRight(plane: Plane, y: number): void {
  const base = plane.origin + y * plane.stride;
  const last = plane.data[base + plane.width - 1];
  plane.data.fill(last, base + plane.width, base + plane.width + 4);
}

// ---------------------------------------------------------------------------
// Intra prediction
// ---------------------------------------------------------------------------

function predictWholeBlock(
  plane: Plane, x: number, y: number, size: number, mode: number,
  hasAbove: boolean, hasLeft: boolean,
): void {
  const { data, stride, origin } = plane;
  const base = origin + y * stride + x;

  if (mode === DC_PRED) {
    let sum = 0;
    let shift = size === 16 ? 3 : 2;
    if (hasAbove) {
      for (let i = 0; i < size; i++) sum += data[base - stride + i];
      shift += 1;
    }
    if (hasLeft) {
      for (let i = 0; i < size; i++) sum += data[base + i * stride - 1];
      shift += 1;
    }
    const value = (hasAbove || hasLeft) ? (sum + (1 << (shift - 1))) >> shift : 128;
    for (let row = 0; row < size; row++) {
      data.fill(value, base + row * stride, base + row * stride + size);
    }
    return;
  }

  if (mode === V_PRED) {
    for (let row = 0; row < size; row++) {
      for (let i = 0; i < size; i++) data[base + row * stride + i] = data[base - stride + i];
    }
    return;
  }

  if (mode === H_PRED) {
    for (let row = 0; row < size; row++) {
      data.fill(data[base + row * stride - 1],
        base + row * stride, base + row * stride + size);
    }
    return;
  }

  // TM_PRED — "true motion": propagate the second difference between the row
  // above and the column to the left. The only whole-block mode that reads
  // three neighbours rather than one.
  if (mode !== TM_PRED) return;
  const corner = data[base - stride - 1];
  for (let row = 0; row < size; row++) {
    const left = data[base + row * stride - 1];
    for (let i = 0; i < size; i++) {
      data[base + row * stride + i] = clamp255(left + data[base - stride + i] - corner);
    }
  }
}

const avg3 = (a: number, b: number, c: number) => (a + 2 * b + c + 2) >> 2;
const avg2 = (a: number, b: number) => (a + b + 1) >> 1;

/**
 * The ten 4x4 sub-block predictors, RFC 6386 section 12.3.
 *
 * `above` carries eight samples — four above and four above-RIGHT — because six
 * of the ten modes read past the block's own width. `left` carries four, and
 * `corner` is the sample diagonally above-left.
 */
function predictSubBlock(
  out: Int32Array, mode: number, above: Int32Array, left: Int32Array, corner: number,
): void {
  const put = (row: number, column: number, value: number) => {
    out[row * 4 + column] = value;
  };
  const a = above;
  const l = left;

  switch (mode) {
    case 0: { // B_DC_PRED
      const value = (a[0] + a[1] + a[2] + a[3] + l[0] + l[1] + l[2] + l[3] + 4) >> 3;
      out.fill(value, 0, 16);
      return;
    }
    case 1: // B_TM_PRED
      for (let row = 0; row < 4; row++) {
        for (let c = 0; c < 4; c++) put(row, c, clamp255(l[row] + a[c] - corner));
      }
      return;
    case 2: { // B_VE_PRED
      const values = [
        avg3(corner, a[0], a[1]), avg3(a[0], a[1], a[2]),
        avg3(a[1], a[2], a[3]), avg3(a[2], a[3], a[4]),
      ];
      for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) put(row, c, values[c]);
      return;
    }
    case 3: { // B_HE_PRED
      const values = [
        avg3(corner, l[0], l[1]), avg3(l[0], l[1], l[2]),
        avg3(l[1], l[2], l[3]), avg3(l[2], l[3], l[3]),
      ];
      for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) put(row, c, values[row]);
      return;
    }
    case 4: { // B_LD_PRED
      const d = [
        avg3(a[0], a[1], a[2]), avg3(a[1], a[2], a[3]), avg3(a[2], a[3], a[4]),
        avg3(a[3], a[4], a[5]), avg3(a[4], a[5], a[6]), avg3(a[5], a[6], a[7]),
        avg3(a[6], a[7], a[7]),
      ];
      for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) put(row, c, d[row + c]);
      return;
    }
    case 5: { // B_RD_PRED
      const d = [
        avg3(l[3], l[2], l[1]), avg3(l[2], l[1], l[0]), avg3(l[1], l[0], corner),
        avg3(l[0], corner, a[0]), avg3(corner, a[0], a[1]), avg3(a[0], a[1], a[2]),
        avg3(a[1], a[2], a[3]),
      ];
      for (let row = 0; row < 4; row++) for (let c = 0; c < 4; c++) put(row, c, d[c - row + 3]);
      return;
    }
    case 6: // B_VR_PRED
      put(3, 0, avg3(l[2], l[1], l[0]));
      put(2, 0, avg3(l[1], l[0], corner));
      put(3, 1, avg3(l[0], corner, a[0])); put(1, 0, avg3(l[0], corner, a[0]));
      put(2, 1, avg2(corner, a[0])); put(0, 0, avg2(corner, a[0]));
      put(3, 2, avg3(corner, a[0], a[1])); put(1, 1, avg3(corner, a[0], a[1]));
      put(2, 2, avg2(a[0], a[1])); put(0, 1, avg2(a[0], a[1]));
      put(3, 3, avg3(a[0], a[1], a[2])); put(1, 2, avg3(a[0], a[1], a[2]));
      put(2, 3, avg2(a[1], a[2])); put(0, 2, avg2(a[1], a[2]));
      put(1, 3, avg3(a[1], a[2], a[3]));
      put(0, 3, avg2(a[2], a[3]));
      return;
    case 7: // B_VL_PRED
      put(0, 0, avg2(a[0], a[1]));
      put(1, 0, avg3(a[0], a[1], a[2]));
      put(2, 0, avg2(a[1], a[2])); put(0, 1, avg2(a[1], a[2]));
      put(1, 1, avg3(a[1], a[2], a[3])); put(3, 0, avg3(a[1], a[2], a[3]));
      put(2, 1, avg2(a[2], a[3])); put(0, 2, avg2(a[2], a[3]));
      put(3, 1, avg3(a[2], a[3], a[4])); put(1, 2, avg3(a[2], a[3], a[4]));
      put(2, 2, avg2(a[3], a[4])); put(0, 3, avg2(a[3], a[4]));
      put(3, 2, avg3(a[3], a[4], a[5])); put(1, 3, avg3(a[3], a[4], a[5]));
      // The last two break the pattern, exactly as the specification notes.
      put(2, 3, avg3(a[4], a[5], a[6]));
      put(3, 3, avg3(a[5], a[6], a[7]));
      return;
    case 8: // B_HD_PRED
      put(3, 0, avg2(l[3], l[2]));
      put(3, 1, avg3(l[3], l[2], l[1]));
      put(2, 0, avg2(l[2], l[1])); put(3, 2, avg2(l[2], l[1]));
      put(2, 1, avg3(l[2], l[1], l[0])); put(3, 3, avg3(l[2], l[1], l[0]));
      put(2, 2, avg2(l[1], l[0])); put(1, 0, avg2(l[1], l[0]));
      put(2, 3, avg3(l[1], l[0], corner)); put(1, 1, avg3(l[1], l[0], corner));
      put(1, 2, avg2(l[0], corner)); put(0, 0, avg2(l[0], corner));
      put(1, 3, avg3(l[0], corner, a[0])); put(0, 1, avg3(l[0], corner, a[0]));
      put(0, 2, avg3(corner, a[0], a[1]));
      put(0, 3, avg3(a[0], a[1], a[2]));
      return;
    default: // 9 — B_HU_PRED
      put(0, 0, avg2(l[0], l[1]));
      put(0, 1, avg3(l[0], l[1], l[2]));
      put(0, 2, avg2(l[1], l[2])); put(1, 0, avg2(l[1], l[2]));
      put(0, 3, avg3(l[1], l[2], l[3])); put(1, 1, avg3(l[1], l[2], l[3]));
      put(1, 2, avg2(l[2], l[3])); put(2, 0, avg2(l[2], l[3]));
      put(1, 3, avg3(l[2], l[3], l[3])); put(2, 1, avg3(l[2], l[3], l[3]));
      put(2, 2, l[3]); put(2, 3, l[3]);
      put(3, 0, l[3]); put(3, 1, l[3]); put(3, 2, l[3]); put(3, 3, l[3]);
      return;
  }
}

// ---------------------------------------------------------------------------
// Coefficients
// ---------------------------------------------------------------------------

/** The escape categories' extra-bit probability tables, 3 to 6. */
const CAT_3456 = [CAT_PROBS[2], CAT_PROBS[3], CAT_PROBS[4], CAT_PROBS[5]];

/**
 * Read one 4x4 block's coefficients.
 *
 * Returns the index one past the last coefficient read, which is what the
 * caller turns into the next block's context. Written as the specification's
 * flat loop rather than as a tree walk because the ZERO token has to skip the
 * end-of-block branch on the following read, and expressing that through a
 * generic tree reader is where this goes subtly wrong.
 */
function readCoefficients(
  decoder: BoolDecoder, probabilities: Uint8Array, type: number, context: number,
  dcQuant: number, acQuant: number, first: number, out: Int32Array,
): number {
  let n = first;
  let ctx = context;
  // probabilities is flattened [4][8][3][11]
  const probAt = (band: number, c: number) => (((type * 8) + band) * 3 + c) * 11;
  let p = probAt(COEFF_BANDS[n], ctx);

  while (n < 16) {
    if (!decoder.bit(probabilities[p])) return n; // end of block
    while (!decoder.bit(probabilities[p + 1])) {  // a zero coefficient
      n += 1;
      if (n === 16) return 16;
      p = probAt(COEFF_BANDS[n], 0);
    }

    let value: number;
    if (!decoder.bit(probabilities[p + 2])) {
      value = 1;
      ctx = 1;
    } else {
      ctx = 2;
      if (!decoder.bit(probabilities[p + 3])) {
        value = !decoder.bit(probabilities[p + 4]) ? 2 : 3 + decoder.bit(probabilities[p + 5]);
      } else if (!decoder.bit(probabilities[p + 6])) {
        if (!decoder.bit(probabilities[p + 7])) {
          value = 5 + decoder.bit(CAT_PROBS[0][0]);
        } else {
          value = 7 + 2 * decoder.bit(CAT_PROBS[1][0]) + decoder.bit(CAT_PROBS[1][1]);
        }
      } else {
        const highBit = decoder.bit(probabilities[p + 8]);
        const lowBit = decoder.bit(probabilities[p + 9 + highBit]);
        const category = 2 * highBit + lowBit;
        let extra = 0;
        for (const probability of CAT_3456[category]) {
          extra += extra + decoder.bit(probability);
        }
        value = 3 + (8 << category) + extra;
      }
    }

    const signed = decoder.bit(128) ? -value : value;
    out[ZIGZAG[n]] = signed * (n === 0 ? dcQuant : acQuant);
    n += 1;
    if (n === 16) return 16;
    p = probAt(COEFF_BANDS[n], ctx);
  }
  return 16;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

interface Quantiser {
  y1dc: number; y1ac: number;
  y2dc: number; y2ac: number;
  uvdc: number; uvac: number;
}

/** The b-mode a whole-macroblock mode stands in as, for prediction context. */
const YMODE_AS_BMODE = [0, 2, 3, 1];

/**
 * Decode a VP8 chunk body (everything after the four-character code and its
 * length) into RGB.
 */
export function decodeVp8(
  body: Uint8Array, limits: { maxPixels: number },
): WebpRaster | null {
  if (body.length < 10) return null;

  const tag = body[0] | (body[1] << 8) | (body[2] << 16);
  const isKeyFrame = !(tag & 1);
  const showFrame = (tag >> 4) & 1;
  const firstPartitionSize = (tag >> 5) & 0x7ffff;
  // A still image is always a shown key frame. Anything else is a video
  // fragment that has no business being a property photograph.
  if (!isKeyFrame || !showFrame) return null;
  if (body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) return null;

  const width = (body[6] | (body[7] << 8)) & 0x3fff;
  const height = (body[8] | (body[9] << 8)) & 0x3fff;
  if (width <= 0 || height <= 0) return null;
  if (width * height > limits.maxPixels) return null;
  if (10 + firstPartitionSize > body.length) return null;

  const header = new BoolDecoder(body, 10, 10 + firstPartitionSize);

  header.literal(1); // colour space
  header.literal(1); // clamping type

  // ── segmentation ─────────────────────────────────────────────────────────
  const segmentQuantiser = [0, 0, 0, 0];
  const segmentFilter = [0, 0, 0, 0];
  const segmentProbabilities = [255, 255, 255];
  let segmentationEnabled = false;
  let updateSegmentMap = false;
  let absoluteSegmentQuantiser = false;
  if (header.bit(128)) {
    segmentationEnabled = true;
    updateSegmentMap = !!header.bit(128);
    const updateData = header.bit(128);
    if (updateData) {
      absoluteSegmentQuantiser = !!header.bit(128);
      for (let i = 0; i < 4; i++) segmentQuantiser[i] = header.optionalSigned(7);
      for (let i = 0; i < 4; i++) segmentFilter[i] = header.optionalSigned(6);
    }
    if (updateSegmentMap) {
      for (let i = 0; i < 3; i++) {
        segmentProbabilities[i] = header.bit(128) ? header.literal(8) : 255;
      }
    }
  }

  // ── loop filter ──────────────────────────────────────────────────────────
  const simpleFilter = !!header.literal(1);
  const filterLevel = header.literal(6);
  const sharpness = header.literal(3);
  // Only the INTRA reference delta and the B_PRED mode delta can apply to a key
  // frame; the other six describe inter prediction, which cannot occur here.
  let intraRefDelta = 0;
  let bPredModeDelta = 0;
  let deltasEnabled = false;
  if (header.bit(128)) {
    deltasEnabled = true;
    if (header.bit(128)) {
      for (let i = 0; i < 4; i++) {
        const value = header.optionalSigned(6);
        if (i === 0) intraRefDelta = value;
      }
      for (let i = 0; i < 4; i++) {
        const value = header.optionalSigned(6);
        if (i === 0) bPredModeDelta = value;
      }
    }
  }

  // ── partitions ───────────────────────────────────────────────────────────
  const partitionCount = 1 << header.literal(2);
  const partitionTableStart = 10 + firstPartitionSize;
  const partitionsStart = partitionTableStart + 3 * (partitionCount - 1);
  if (partitionsStart > body.length) return null;
  const partitions: BoolDecoder[] = [];
  let offset = partitionsStart;
  for (let i = 0; i < partitionCount; i++) {
    const size = i === partitionCount - 1
      ? body.length - offset
      : body[partitionTableStart + i * 3]
        | (body[partitionTableStart + i * 3 + 1] << 8)
        | (body[partitionTableStart + i * 3 + 2] << 16);
    if (size < 0 || offset + size > body.length) return null;
    partitions.push(new BoolDecoder(body, offset, offset + size));
    offset += size;
  }

  // ── quantisers ───────────────────────────────────────────────────────────
  const baseIndex = header.literal(7);
  const deltas = {
    y1dc: header.optionalSigned(4),
    y2dc: header.optionalSigned(4),
    y2ac: header.optionalSigned(4),
    uvdc: header.optionalSigned(4),
    uvac: header.optionalSigned(4),
  };
  const clampIndex = (value: number) => value < 0 ? 0 : value > 127 ? 127 : value;
  const quantiserFor = (index: number): Quantiser => ({
    y1dc: DC_QLOOKUP[clampIndex(index + deltas.y1dc)],
    y1ac: AC_QLOOKUP[clampIndex(index)],
    y2dc: DC_QLOOKUP[clampIndex(index + deltas.y2dc)] * 2,
    y2ac: Math.max(8, (AC_QLOOKUP[clampIndex(index + deltas.y2ac)] * 155 / 100) | 0),
    uvdc: Math.min(132, DC_QLOOKUP[clampIndex(index + deltas.uvdc)]),
    uvac: AC_QLOOKUP[clampIndex(index + deltas.uvac)],
  });
  const quantisers: Quantiser[] = [];
  for (let segment = 0; segment < 4; segment++) {
    const index = segmentationEnabled
      ? (absoluteSegmentQuantiser ? segmentQuantiser[segment] : baseIndex + segmentQuantiser[segment])
      : baseIndex;
    quantisers.push(quantiserFor(index));
  }

  header.literal(1); // refresh entropy probabilities — irrelevant for one frame

  // ── coefficient probabilities ────────────────────────────────────────────
  const probabilities = new Uint8Array(DEFAULT_COEFF_PROBS);
  for (let i = 0; i < 4 * 8 * 3 * 11; i++) {
    if (header.bit(COEFF_UPDATE_PROBS[i])) probabilities[i] = header.literal(8);
  }

  const skipEnabled = !!header.bit(128);
  const skipProbability = skipEnabled ? header.literal(8) : 0;
  if (!header.ok) return null;

  // ── macroblock modes, for the whole frame, from the first partition ──────
  const mbWidth = (width + 15) >> 4;
  const mbHeight = (height + 15) >> 4;
  const mbCount = mbWidth * mbHeight;

  const yModes = new Uint8Array(mbCount);
  const uvModes = new Uint8Array(mbCount);
  const segments = new Uint8Array(mbCount);
  const skips = new Uint8Array(mbCount);
  const subModes = new Uint8Array(mbCount * 16);
  // Sub-mode context rows. Above is per macroblock column; left is per row.
  const aboveSubModes = new Uint8Array(mbWidth * 4);
  const leftSubModes = new Uint8Array(4);

  for (let mbY = 0; mbY < mbHeight; mbY++) {
    leftSubModes.fill(0);
    for (let mbX = 0; mbX < mbWidth; mbX++) {
      const mb = mbY * mbWidth + mbX;
      if (segmentationEnabled && updateSegmentMap) {
        segments[mb] = header.tree(MB_SEGMENT_TREE, segmentProbabilities);
      }
      if (skipEnabled) skips[mb] = header.bit(skipProbability);

      const yMode = header.tree(KF_YMODE_TREE, KF_YMODE_PROBS);
      yModes[mb] = yMode;

      if (yMode === B_PRED) {
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const above = by === 0 ? aboveSubModes[mbX * 4 + bx] : subModes[mb * 16 + (by - 1) * 4 + bx];
            const left = bx === 0 ? leftSubModes[by] : subModes[mb * 16 + by * 4 + bx - 1];
            const mode = header.tree(BMODE_TREE, KF_BMODE_PROBS, (above * 10 + left) * 9);
            subModes[mb * 16 + by * 4 + bx] = mode;
            if (by === 3) aboveSubModes[mbX * 4 + bx] = mode;
            if (bx === 3) leftSubModes[by] = mode;
          }
        }
      } else {
        const equivalent = YMODE_AS_BMODE[yMode];
        subModes.fill(equivalent, mb * 16, mb * 16 + 16);
        for (let i = 0; i < 4; i++) {
          aboveSubModes[mbX * 4 + i] = equivalent;
          leftSubModes[i] = equivalent;
        }
      }

      uvModes[mb] = header.tree(UV_MODE_TREE, KF_UV_MODE_PROBS);
      if (!header.ok) return null;
    }
  }

  // ── reconstruction ───────────────────────────────────────────────────────
  const yPlane = new Plane(mbWidth * 16, mbHeight * 16);
  const uPlane = new Plane(mbWidth * 8, mbHeight * 8);
  const vPlane = new Plane(mbWidth * 8, mbHeight * 8);

  // Non-zero contexts: one bit per 4x4 column of the frame, plus the Y2 block.
  const aboveY = new Uint8Array(mbWidth * 4);
  const aboveU = new Uint8Array(mbWidth * 2);
  const aboveV = new Uint8Array(mbWidth * 2);
  const aboveY2 = new Uint8Array(mbWidth);
  const leftY = new Uint8Array(4);
  const leftU = new Uint8Array(2);
  const leftV = new Uint8Array(2);
  const leftY2 = new Uint8Array(1);

  /** Whether each macroblock ended up with any non-zero coefficient. */
  const hasCoefficients = new Uint8Array(mbCount);
  const coefficients = new Int32Array(25 * 16);
  const y2 = new Int32Array(16);
  const y2out = new Int32Array(16);
  const residual = new Int32Array(16);
  const above8 = new Int32Array(8);
  const left4 = new Int32Array(4);
  const predicted = new Int32Array(16);

  for (let mbY = 0; mbY < mbHeight; mbY++) {
    leftY.fill(0); leftU.fill(0); leftV.fill(0); leftY2[0] = 0;
    const tokens = partitions[mbY & (partitionCount - 1)];

    for (let mbX = 0; mbX < mbWidth; mbX++) {
      const mb = mbY * mbWidth + mbX;
      const quant = quantisers[segments[mb]];
      const yMode = yModes[mb];
      const hasY2 = yMode !== B_PRED;
      coefficients.fill(0);

      if (skips[mb]) {
        for (let i = 0; i < 4; i++) { aboveY[mbX * 4 + i] = 0; leftY[i] = 0; }
        for (let i = 0; i < 2; i++) {
          aboveU[mbX * 2 + i] = 0; leftU[i] = 0;
          aboveV[mbX * 2 + i] = 0; leftV[i] = 0;
        }
        if (hasY2) { aboveY2[mbX] = 0; leftY2[0] = 0; }
      } else {
        let first = 0;
        if (hasY2) {
          y2.fill(0);
          const context = aboveY2[mbX] + leftY2[0];
          const last = readCoefficients(tokens, probabilities, 1, context,
            quant.y2dc, quant.y2ac, 0, y2);
          const nonZero = last > 0 ? 1 : 0;
          aboveY2[mbX] = nonZero;
          leftY2[0] = nonZero;
          if (nonZero) hasCoefficients[mb] = 1;
          inverseWalsh(y2, y2out);
          for (let i = 0; i < 16; i++) coefficients[i * 16] = y2out[i];
          first = 1;
        }
        const yType = hasY2 ? 0 : 3;
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const block = by * 4 + bx;
            const context = aboveY[mbX * 4 + bx] + leftY[by];
            const last = readCoefficients(tokens, probabilities, yType, context,
              quant.y1dc, quant.y1ac, first, coefficients.subarray(block * 16, block * 16 + 16));
            const nonZero = last > first ? 1 : 0;
            if (nonZero) hasCoefficients[mb] = 1;
            aboveY[mbX * 4 + bx] = nonZero;
            leftY[by] = nonZero;
          }
        }
        for (let plane = 0; plane < 2; plane++) {
          const aboveContext = plane === 0 ? aboveU : aboveV;
          const leftContext = plane === 0 ? leftU : leftV;
          for (let by = 0; by < 2; by++) {
            for (let bx = 0; bx < 2; bx++) {
              const block = 16 + plane * 4 + by * 2 + bx;
              const context = aboveContext[mbX * 2 + bx] + leftContext[by];
              const last = readCoefficients(tokens, probabilities, 2, context,
                quant.uvdc, quant.uvac, 0,
                coefficients.subarray(block * 16, block * 16 + 16));
              const nonZero = last > 0 ? 1 : 0;
              if (nonZero) hasCoefficients[mb] = 1;
              aboveContext[mbX * 2 + bx] = nonZero;
              leftContext[by] = nonZero;
            }
          }
        }
        if (!tokens.ok) return null;
      }

      // ── luma ───────────────────────────────────────────────────────────
      const px = mbX * 16;
      const py = mbY * 16;
      if (hasY2) {
        predictWholeBlock(yPlane, px, py, 16, yMode, mbY > 0, mbX > 0);
        for (let block = 0; block < 16; block++) {
          const bx = (block & 3) * 4;
          const by = (block >> 2) * 4;
          inverseDct(coefficients.subarray(block * 16, block * 16 + 16), residual);
          addResidual(yPlane, px + bx, py + by, residual);
        }
      } else {
        for (let block = 0; block < 16; block++) {
          const bx = (block & 3) * 4;
          const by = (block >> 2) * 4;
          gatherNeighbours(yPlane, px + bx, py + by, block, above8, left4);
          const corner = yPlane.data[
            yPlane.origin + (py + by - 1) * yPlane.stride + (px + bx - 1)];
          predictSubBlock(predicted, subModes[mb * 16 + block], above8, left4, corner);
          inverseDct(coefficients.subarray(block * 16, block * 16 + 16), residual);
          for (let row = 0; row < 4; row++) {
            const base = yPlane.origin + (py + by + row) * yPlane.stride + px + bx;
            for (let c = 0; c < 4; c++) {
              yPlane.data[base + c] = clamp255(predicted[row * 4 + c] + residual[row * 4 + c]);
            }
          }
        }
      }

      // ── chroma ─────────────────────────────────────────────────────────
      const cx = mbX * 8;
      const cy = mbY * 8;
      for (const [plane, offsetBlock] of [[uPlane, 16], [vPlane, 20]] as const) {
        predictWholeBlock(plane, cx, cy, 8, uvModes[mb], mbY > 0, mbX > 0);
        for (let block = 0; block < 4; block++) {
          const bx = (block & 1) * 4;
          const by = (block >> 1) * 4;
          inverseDct(
            coefficients.subarray((offsetBlock + block) * 16, (offsetBlock + block) * 16 + 16),
            residual);
          addResidual(plane, cx + bx, cy + by, residual);
        }
      }
    }

    // Every reconstructed row is extended to the right so the next row's
    // rightmost macroblock has its four above-right samples. See `extendRight`.
    for (let row = 0; row < 16; row++) extendRight(yPlane, mbY * 16 + row);
    for (let row = 0; row < 8; row++) {
      extendRight(uPlane, mbY * 8 + row);
      extendRight(vPlane, mbY * 8 + row);
    }
  }

  /*
   * THE LOOP FILTER RUNS ONLY NOW, over the finished frame.
   *
   * That is not an optimisation, it is the rule: intra prediction reads its
   * neighbours UNFILTERED, so a decoder that smooths each macroblock as it
   * finishes predicts every subsequent one from the wrong pixels. Reconstructing
   * the whole frame first makes that impossible to get wrong.
   */
  if (filterLevel > 0) {
    applyLoopFilter({
      yPlane, uPlane, vPlane, mbWidth, mbHeight,
      simpleFilter, filterLevel, sharpness, deltasEnabled, intraRefDelta, bPredModeDelta,
      segmentationEnabled, absoluteSegmentFilter: absoluteSegmentQuantiser, segmentFilter,
      segments, yModes, hasCoefficients,
    });
  }

  return { width, height, pixels: yuvToRgb(yPlane, uPlane, vPlane, width, height),
    argb: new Uint32Array(0) };
}

/** Add a decoded 4x4 residual onto an already-predicted block. */
function addResidual(plane: Plane, x: number, y: number, residual: Int32Array): void {
  for (let row = 0; row < 4; row++) {
    const base = plane.origin + (y + row) * plane.stride + x;
    for (let c = 0; c < 4; c++) {
      plane.data[base + c] = clamp255(plane.data[base + c] + residual[row * 4 + c]);
    }
  }
}

/**
 * Collect a sub-block's eight above and four left samples.
 *
 * THE ONE RULE THAT IS NOT OBVIOUS: for the rightmost column of sub-blocks the
 * four above-right samples come from the row above the MACROBLOCK, for all four
 * sub-block rows — not from the sub-block reconstructed just above. That is what
 * the reference decoder does, and a picture decoded without it drifts one
 * sub-block column at a time.
 */
function gatherNeighbours(
  plane: Plane, x: number, y: number, block: number,
  above: Int32Array, left: Int32Array,
): void {
  const { data, stride, origin } = plane;
  const base = origin + y * stride + x;
  for (let i = 0; i < 4; i++) {
    above[i] = data[base - stride + i];
    left[i] = data[base + i * stride - 1];
  }
  const isRightColumn = (block & 3) === 3;
  if (isRightColumn) {
    // Row above the macroblock, four columns past its right edge.
    const macroblockTop = origin + (y - (block >> 2) * 4 - 1) * stride + x;
    for (let i = 0; i < 4; i++) above[4 + i] = data[macroblockTop + 4 + i];
  } else {
    for (let i = 0; i < 4; i++) above[4 + i] = data[base - stride + 4 + i];
  }
}

/**
 * YUV 4:2:0 to RGB, cropped to the frame's stated size.
 *
 * TWO THINGS HERE ARE NOT THE OBVIOUS CHOICE, and both were found by comparing
 * against the reference decoder rather than reasoned about.
 *
 * THE CONVERSION IS STUDIO-RANGE, in the reference decoder's own fixed point.
 * VP8 carries luma in 16..235, so the textbook full-range `R = Y + 1.402·Cr`
 * compresses the whole picture toward mid-grey — black arrives at 25 and white
 * at 235. That is a fifteen-level error everywhere, larger than the classifier's
 * own ink thresholds, so it is a wrong picture rather than a rounding
 * difference.
 *
 * THE CHROMA IS UPSAMPLED BILINEARLY, not by nearest neighbour. A chroma sample
 * sits at the CENTRE of its 2x2 luma block, so every output pixel is three
 * quarters of the way toward one sample and one quarter toward the next; taking
 * the nearest one instead puts a visible chroma step at every second column and
 * row. The weights, the two-stage rounding and the edge handling are the
 * reference's, so the arithmetic rounds the same way rather than nearly so.
 */
function yuvToRgb(
  yPlane: Plane, uPlane: Plane, vPlane: Plane, width: number, height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  const uvHeight = (height + 1) >> 1;

  /** One output row pair from one chroma row pair. `bottom` < 0 means none. */
  const emitPair = (top: number, bottom: number, jTop: number, jCur: number) => {
    const lastPair = (width - 1) >> 1;
    const uRow = (j: number) => uPlane.origin + j * uPlane.stride;
    const vRow = (j: number) => vPlane.origin + j * vPlane.stride;
    let topLeftU = uPlane.data[uRow(jTop)];
    let topLeftV = vPlane.data[vRow(jTop)];
    let leftU = uPlane.data[uRow(jCur)];
    let leftV = vPlane.data[vRow(jCur)];

    const near = (a: number, b: number) => (3 * a + b + 2) >> 2;
    emit(out, yPlane, width, top, 0, near(topLeftU, leftU), near(topLeftV, leftV));
    if (bottom >= 0) {
      emit(out, yPlane, width, bottom, 0, near(leftU, topLeftU), near(leftV, topLeftV));
    }

    for (let x = 1; x <= lastPair; x++) {
      const tU = uPlane.data[uRow(jTop) + x];
      const tV = vPlane.data[vRow(jTop) + x];
      const cU = uPlane.data[uRow(jCur) + x];
      const cV = vPlane.data[vRow(jCur) + x];
      const avgU = topLeftU + tU + leftU + cU + 8;
      const avgV = topLeftV + tV + leftV + cV + 8;
      const diag12U = (avgU + 2 * (tU + leftU)) >> 3;
      const diag12V = (avgV + 2 * (tV + leftV)) >> 3;
      const diag03U = (avgU + 2 * (topLeftU + cU)) >> 3;
      const diag03V = (avgV + 2 * (topLeftV + cV)) >> 3;

      emit(out, yPlane, width, top, 2 * x - 1,
        (diag12U + topLeftU) >> 1, (diag12V + topLeftV) >> 1);
      if (2 * x < width) {
        emit(out, yPlane, width, top, 2 * x, (diag03U + tU) >> 1, (diag03V + tV) >> 1);
      }
      if (bottom >= 0) {
        emit(out, yPlane, width, bottom, 2 * x - 1,
          (diag03U + leftU) >> 1, (diag03V + leftV) >> 1);
        if (2 * x < width) {
          emit(out, yPlane, width, bottom, 2 * x, (diag12U + cU) >> 1, (diag12V + cV) >> 1);
        }
      }
      topLeftU = tU; topLeftV = tV; leftU = cU; leftV = cV;
    }

    if (!(width & 1)) {
      emit(out, yPlane, width, top, width - 1,
        near(topLeftU, leftU), near(topLeftV, leftV));
      if (bottom >= 0) {
        emit(out, yPlane, width, bottom, width - 1,
          near(leftU, topLeftU), near(leftV, topLeftV));
      }
    }
  };

  // The first row has no chroma row above it, and mirrors its own.
  emitPair(0, -1, 0, 0);
  let k = 1;
  while (2 * k <= height - 1) {
    emitPair(2 * k - 1, 2 * k, k - 1, Math.min(k, uvHeight - 1));
    k += 1;
  }
  // An even-height picture ends on an unpaired row, which mirrors likewise.
  if (2 * k - 1 <= height - 1) {
    const j = Math.min(k - 1, uvHeight - 1);
    emitPair(2 * k - 1, -1, j, j);
  }
  return out;
}

/** One pixel: luma from the plane, chroma already interpolated. */
function emit(
  out: Uint8Array, yPlane: Plane, width: number, y: number, x: number,
  u: number, v: number,
): void {
  const luma = yPlane.data[yPlane.origin + y * yPlane.stride + x];
  const multiplyHi = (value: number, coefficient: number) => (value * coefficient) >> 8;
  const clip = (value: number) => value < 0 ? 0 : value > (255 << 6) ? 255 : value >> 6;
  const scaled = multiplyHi(luma, 19077);
  const at = (y * width + x) * 3;
  out[at] = clip(scaled + multiplyHi(v, 26149) - 14234);
  out[at + 1] = clip(scaled - multiplyHi(u, 6419) - multiplyHi(v, 13320) + 8708);
  out[at + 2] = clip(scaled + multiplyHi(u, 33050) - 17685);
}

// ---------------------------------------------------------------------------
// The in-loop deblocking filter — RFC 6386 section 15
// ---------------------------------------------------------------------------

/**
 * VP8 smooths the seams between the pieces it reconstructs a frame from.
 *
 * IT RUNS OVER THE FINISHED FRAME, NEVER DURING RECONSTRUCTION, because intra
 * prediction reads its neighbours unfiltered. A decoder that filters each
 * macroblock as it completes predicts every macroblock after it from pixels the
 * encoder never had, and the error compounds across the picture.
 *
 * Every strength here is derived rather than chosen: the per-macroblock level
 * comes from the frame level adjusted by the segment and by the two deltas a key
 * frame can carry, and the three limits come from that level and the frame's
 * sharpness. All of it is section 15.2's arithmetic, in signed-char space, with
 * clamping at exactly the points the specification clamps.
 */
interface LoopFilterInput {
  yPlane: Plane;
  uPlane: Plane;
  vPlane: Plane;
  mbWidth: number;
  mbHeight: number;
  simpleFilter: boolean;
  filterLevel: number;
  sharpness: number;
  deltasEnabled: boolean;
  intraRefDelta: number;
  bPredModeDelta: number;
  segmentationEnabled: boolean;
  absoluteSegmentFilter: boolean;
  segmentFilter: number[];
  segments: Uint8Array;
  yModes: Uint8Array;
  hasCoefficients: Uint8Array;
}

/** Clamp to a signed char, which is where VP8's filter arithmetic lives. */
const clampSigned = (value: number) => value < -128 ? -128 : value > 127 ? 127 : value;
const toSigned = (value: number) => value - 128;
const toUnsigned = (value: number) => clamp255(value + 128);

/**
 * The adjustment both filters share.
 *
 * Returns the value the wider filters need for their own second step.
 */
function commonAdjust(
  data: Uint8Array, p1: number, p0: number, q0: number, q1: number, useOuterTaps: boolean,
): number {
  const sp1 = toSigned(data[p1]);
  const sp0 = toSigned(data[p0]);
  const sq0 = toSigned(data[q0]);
  const sq1 = toSigned(data[q1]);
  const a = clampSigned(
    (useOuterTaps ? clampSigned(sp1 - sq1) : 0) + 3 * (sq0 - sp0));
  const f = clampSigned(a + 4) >> 3;
  const e = clampSigned(a + 3) >> 3;
  data[q0] = toUnsigned(sq0 - f);
  data[p0] = toUnsigned(sp0 + e);
  return f;
}

/** Is this edge smooth enough on both sides to be a coding artefact? */
function filterYes(
  data: Uint8Array, interior: number, edge: number,
  p3: number, p2: number, p1: number, p0: number,
  q0: number, q1: number, q2: number, q3: number,
): boolean {
  const abs = Math.abs;
  return (abs(data[p0] - data[q0]) * 2 + (abs(data[p1] - data[q1]) >> 1)) <= edge
    && abs(data[p3] - data[p2]) <= interior
    && abs(data[p2] - data[p1]) <= interior
    && abs(data[p1] - data[p0]) <= interior
    && abs(data[q3] - data[q2]) <= interior
    && abs(data[q2] - data[q1]) <= interior
    && abs(data[q1] - data[q0]) <= interior;
}

/** A high edge variance: a real edge in the picture, which must not be smoothed. */
function highEdgeVariance(
  data: Uint8Array, threshold: number, p1: number, p0: number, q0: number, q1: number,
): boolean {
  return Math.abs(data[p1] - data[p0]) > threshold
    || Math.abs(data[q1] - data[q0]) > threshold;
}

/** The narrow filter, used on the edges inside a macroblock. */
function subBlockFilter(
  data: Uint8Array, hevThreshold: number, interior: number, edge: number,
  p3: number, p2: number, p1: number, p0: number,
  q0: number, q1: number, q2: number, q3: number,
): void {
  if (!filterYes(data, interior, edge, p3, p2, p1, p0, q0, q1, q2, q3)) return;
  const hev = highEdgeVariance(data, hevThreshold, p1, p0, q0, q1);
  const a = (commonAdjust(data, p1, p0, q0, q1, hev) + 1) >> 1;
  if (!hev) {
    data[q1] = toUnsigned(toSigned(data[q1]) - a);
    data[p1] = toUnsigned(toSigned(data[p1]) + a);
  }
}

/** The wide filter, used on the edges between macroblocks. */
function macroblockFilter(
  data: Uint8Array, hevThreshold: number, interior: number, edge: number,
  p3: number, p2: number, p1: number, p0: number,
  q0: number, q1: number, q2: number, q3: number,
): void {
  if (!filterYes(data, interior, edge, p3, p2, p1, p0, q0, q1, q2, q3)) return;
  if (highEdgeVariance(data, hevThreshold, p1, p0, q0, q1)) {
    commonAdjust(data, p1, p0, q0, q1, true);
    return;
  }
  const sp2 = toSigned(data[p2]);
  const sp1 = toSigned(data[p1]);
  const sp0 = toSigned(data[p0]);
  const sq0 = toSigned(data[q0]);
  const sq1 = toSigned(data[q1]);
  const sq2 = toSigned(data[q2]);
  const w = clampSigned(clampSigned(sp1 - sq1) + 3 * (sq0 - sp0));
  let a = clampSigned((27 * w + 63) >> 7);
  data[q0] = toUnsigned(sq0 - a);
  data[p0] = toUnsigned(sp0 + a);
  a = clampSigned((18 * w + 63) >> 7);
  data[q1] = toUnsigned(sq1 - a);
  data[p1] = toUnsigned(sp1 + a);
  a = clampSigned((9 * w + 63) >> 7);
  data[q2] = toUnsigned(sq2 - a);
  data[p2] = toUnsigned(sp2 + a);
}

/** The simple filter: luma only, and only the two pixels either side. */
function simpleSegment(data: Uint8Array, edge: number,
  p1: number, p0: number, q0: number, q1: number): void {
  if ((Math.abs(data[p0] - data[q0]) * 2 + (Math.abs(data[p1] - data[q1]) >> 1)) <= edge) {
    commonAdjust(data, p1, p0, q0, q1, true);
  }
}

function applyLoopFilter(input: LoopFilterInput): void {
  const {
    yPlane, uPlane, vPlane, mbWidth, mbHeight, simpleFilter, sharpness,
    segments, yModes, hasCoefficients,
  } = input;

  for (let mbY = 0; mbY < mbHeight; mbY++) {
    for (let mbX = 0; mbX < mbWidth; mbX++) {
      const mb = mbY * mbWidth + mbX;

      // ── this macroblock's strength ─────────────────────────────────────
      let level = input.filterLevel;
      if (input.segmentationEnabled) {
        level = input.absoluteSegmentFilter
          ? input.segmentFilter[segments[mb]]
          : level + input.segmentFilter[segments[mb]];
      }
      if (input.deltasEnabled) {
        level += input.intraRefDelta;
        if (yModes[mb] === B_PRED) level += input.bPredModeDelta;
      }
      level = level < 0 ? 0 : level > 63 ? 63 : level;
      if (level === 0) continue;

      let interior = level;
      if (sharpness) {
        interior >>= sharpness > 4 ? 2 : 1;
        if (interior > 9 - sharpness) interior = 9 - sharpness;
      }
      if (!interior) interior = 1;
      // Key frames only; an inter frame uses a different pair of thresholds.
      const hevThreshold = level >= 40 ? 2 : level >= 15 ? 1 : 0;
      const macroblockEdge = (level + 2) * 2 + interior;
      const subBlockEdge = level * 2 + interior;

      // Interior edges are skipped for a macroblock that coded nothing and
      // predicts as a whole: there are no sub-block seams inside it.
      const filterInner = !!hasCoefficients[mb] || yModes[mb] === B_PRED;

      if (simpleFilter) {
        filterPlaneSimple(yPlane, mbX * 16, mbY * 16, 16, mbX > 0, mbY > 0,
          filterInner, macroblockEdge, subBlockEdge);
        continue;
      }

      filterPlane(yPlane, mbX * 16, mbY * 16, 16, mbX > 0, mbY > 0, filterInner,
        hevThreshold, interior, macroblockEdge, subBlockEdge);
      for (const plane of [uPlane, vPlane]) {
        filterPlane(plane, mbX * 8, mbY * 8, 8, mbX > 0, mbY > 0, filterInner,
          hevThreshold, interior, macroblockEdge, subBlockEdge);
      }
    }
  }
}

/**
 * Filter one macroblock of one plane: its left and top edges against its
 * neighbours, then its own interior seams.
 *
 * The order is the specification's and is load-bearing — each filtered edge is
 * an input to the next.
 */
function filterPlane(
  plane: Plane, x: number, y: number, size: number,
  hasLeft: boolean, hasAbove: boolean, filterInner: boolean,
  hevThreshold: number, interior: number, macroblockEdge: number, subBlockEdge: number,
): void {
  const { data, stride, origin } = plane;
  const base = origin + y * stride + x;

  if (hasLeft) {
    for (let row = 0; row < size; row++) {
      const at = base + row * stride;
      macroblockFilter(data, hevThreshold, interior, macroblockEdge,
        at - 4, at - 3, at - 2, at - 1, at, at + 1, at + 2, at + 3);
    }
  }
  if (filterInner) {
    for (let column = 4; column < size; column += 4) {
      for (let row = 0; row < size; row++) {
        const at = base + row * stride + column;
        subBlockFilter(data, hevThreshold, interior, subBlockEdge,
          at - 4, at - 3, at - 2, at - 1, at, at + 1, at + 2, at + 3);
      }
    }
  }
  if (hasAbove) {
    for (let column = 0; column < size; column++) {
      const at = base + column;
      macroblockFilter(data, hevThreshold, interior, macroblockEdge,
        at - 4 * stride, at - 3 * stride, at - 2 * stride, at - stride,
        at, at + stride, at + 2 * stride, at + 3 * stride);
    }
  }
  if (filterInner) {
    for (let row = 4; row < size; row += 4) {
      for (let column = 0; column < size; column++) {
        const at = base + row * stride + column;
        subBlockFilter(data, hevThreshold, interior, subBlockEdge,
          at - 4 * stride, at - 3 * stride, at - 2 * stride, at - stride,
          at, at + stride, at + 2 * stride, at + 3 * stride);
      }
    }
  }
}

/** The simple filter's version of the same walk. Luma only, by definition. */
function filterPlaneSimple(
  plane: Plane, x: number, y: number, size: number,
  hasLeft: boolean, hasAbove: boolean, filterInner: boolean,
  macroblockEdge: number, subBlockEdge: number,
): void {
  const { data, stride, origin } = plane;
  const base = origin + y * stride + x;
  if (hasLeft) {
    for (let row = 0; row < size; row++) {
      const at = base + row * stride;
      simpleSegment(data, macroblockEdge, at - 2, at - 1, at, at + 1);
    }
  }
  if (filterInner) {
    for (let column = 4; column < size; column += 4) {
      for (let row = 0; row < size; row++) {
        const at = base + row * stride + column;
        simpleSegment(data, subBlockEdge, at - 2, at - 1, at, at + 1);
      }
    }
  }
  if (hasAbove) {
    for (let column = 0; column < size; column++) {
      const at = base + column;
      simpleSegment(data, macroblockEdge, at - 2 * stride, at - stride, at, at + stride);
    }
  }
  if (filterInner) {
    for (let row = 4; row < size; row += 4) {
      for (let column = 0; column < size; column++) {
        const at = base + row * stride + column;
        simpleSegment(data, subBlockEdge, at - 2 * stride, at - stride, at, at + stride);
      }
    }
  }
}

export type { WebpRaster };
