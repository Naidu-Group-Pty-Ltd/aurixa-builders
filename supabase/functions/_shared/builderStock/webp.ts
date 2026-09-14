/**
 * Builder stock — the WebP container, and which decoder a file needs.
 *
 * A `.webp` is a RIFF file that can hold any of three quite different things,
 * and the extension says nothing about which:
 *
 *   VP8    a lossy key frame                        → `webpLossy.ts`
 *   VP8L   a lossless bitstream                     → `webpLossless.ts`
 *   VP8X   an extended file, which WRAPS one of the
 *          above and may add alpha, colour profile,
 *          metadata, or an animation
 *
 * This walks the chunk list, finds the image, and hands it to the right
 * decoder. It never guesses: a container it cannot resolve returns null, which
 * the caller turns into a `pending` verdict and an empty card, because "we
 * could not read this" and "we read it and it was clean" must stay different
 * answers.
 *
 * AN ANIMATION IS READ AS ITS FIRST FRAME. A builder's listing picture is not
 * an animation, but nothing stops one arriving, and the first frame is the one
 * a person sees. Later frames are not decoded: they cannot make the first frame
 * a different picture, and a frame budget is a way for a crafted file to spend
 * a worker's wall clock.
 *
 * ALPHA DIVERGES BETWEEN THE TWO BITSTREAMS, AND HONESTLY SO. The LOSSLESS
 * path decodes its alpha and composites it onto white (`webpLossless.ts`).
 * The LOSSY path does NOT: the `ALPH` chunk beside a VP8 frame is its own
 * independently-compressed plane, it is never read, and the pixels used are
 * whatever the VP8 stream stored under the transparency — this docstring
 * used to claim white compositing for both, which was true of neither the
 * code nor the pixels. A transparent lossy WebP is rare in anything a
 * builder publishes; when one arrives, its background decodes as the
 * encoder's understorey (commonly black), the same failure the PNG path had
 * until its alpha was composited — and decoding ALPH (a filtered,
 * optionally VP8L-compressed second plane) is a project, not a patch. Known,
 * disclosed, and deliberately not guessed at.
 */
import { decodeVp8l, type WebpRaster } from './webpLossless.ts';
import { decodeVp8 } from './webpLossy.ts';

const RIFF = 0x46464952; // 'RIFF', little-endian
const WEBP = 0x50424557; // 'WEBP'

/** A chunk as it sits in the file. */
interface Chunk {
  tag: string;
  start: number;
  end: number;
}

function readChunks(bytes: Uint8Array, from: number, to: number): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let offset = from;
  // A file with thousands of chunks is not a photograph; the ceiling stops a
  // crafted one spending the worker's budget in the parser.
  while (offset + 8 <= to && chunks.length < 64) {
    const tag = String.fromCharCode(
      bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (size < 0 || end > to) break;
    chunks.push({ tag, start, end });
    // Chunks are padded to an even length; the padding byte is not counted in
    // the size, and a reader that forgets it desynchronises on the next chunk.
    offset = end + (size & 1);
  }
  return chunks;
}

/** Is this a WebP at all? Cheap enough to ask before anything else. */
export function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === RIFF && view.getUint32(8, true) === WEBP;
}

export interface WebpLimits {
  maxPixels: number;
}

/**
 * Decode a WebP file to RGB, or return null if nothing here can.
 *
 * Never throws: a caller deciding whether to show a picture must be able to
 * treat "unreadable" as an answer rather than an exception, and the difference
 * between a corrupt file and a crashing decoder is not one a card should show.
 */
export function decodeWebp(bytes: Uint8Array, limits: WebpLimits): WebpRaster | null {
  try {
    if (!isWebp(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The RIFF size counts everything after itself; a file may carry trailing
    // bytes, and a truncated one may claim more than it has.
    const declared = view.getUint32(4, true) + 8;
    const end = Math.min(bytes.length, declared > 8 ? declared : bytes.length);

    const chunks = readChunks(bytes, 12, end);
    if (!chunks.length) return null;

    // A simple file: one image chunk, nothing else that matters.
    const simple = chunks.find((chunk) => chunk.tag === 'VP8 ' || chunk.tag === 'VP8L');
    const extended = chunks.find((chunk) => chunk.tag === 'VP8X');

    if (extended && !simple) {
      // An animation: the frames live inside ANMF chunks, each of which holds
      // its own image chunk after a 16-byte frame header.
      const frame = chunks.find((chunk) => chunk.tag === 'ANMF');
      if (!frame) return null;
      const inner = readChunks(bytes, frame.start + 16, frame.end)
        .find((chunk) => chunk.tag === 'VP8 ' || chunk.tag === 'VP8L');
      if (!inner) return null;
      return decodeChunk(bytes, inner, limits);
    }

    if (!simple) return null;
    return decodeChunk(bytes, simple, limits);
  } catch {
    return null;
  }
}

function decodeChunk(bytes: Uint8Array, chunk: Chunk, limits: WebpLimits): WebpRaster | null {
  const body = bytes.subarray(chunk.start, chunk.end);
  return chunk.tag === 'VP8L' ? decodeVp8l(body, limits) : decodeVp8(body, limits);
}

export type { WebpRaster };
