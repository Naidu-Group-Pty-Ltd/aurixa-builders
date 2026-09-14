/**
 * Builder stock — writing cropped SOURCE pixels back out as a PNG.
 *
 * Used for one thing: a photograph cut out of a builder's flattened brochure
 * page. The pixels written are the pixels the builder supplied, unchanged —
 * PNG because it is lossless, so nothing is re-compressed, re-sampled or
 * re-coloured on the way out. Every byte here came from the source raster.
 *
 * No dependency: `CompressionStream` is the platform's own deflate, and the
 * PNG container is a header, one IDAT and an IEND.
 */

/** Cut a rectangle of rows out of a decoded raster, full width. */
export function cropRows(
  pixels: Uint8Array,
  page: { width: number; height: number; components: number },
  band: { top: number; bottom: number },
): { pixels: Uint8Array; width: number; height: number } {
  const top = Math.max(0, Math.min(page.height, Math.floor(band.top)));
  const bottom = Math.max(top, Math.min(page.height, Math.ceil(band.bottom)));
  const rowBytes = page.width * page.components;
  return {
    pixels: pixels.subarray(top * rowBytes, bottom * rowBytes),
    width: page.width,
    height: bottom - top,
  };
}

/**
 * Encode 8-bit RGB or grey samples as a PNG.
 *
 * Filter type 0 on every scanline: no prediction, so the bytes in the file are
 * the bytes that came in. CMYK has no PNG colour type and is refused rather
 * than converted — a colour conversion is a change to the builder's pixels.
 *
 * DELIBERATELY UNTAGGED: no iCCP, no sRGB, no gAMA, no eXIf. Every raster in
 * this pipeline is decoded without colour management and measured, repaired
 * and re-encoded as the same untagged bytes, so the derivative is treated as
 * sRGB end-to-end exactly as its measurement was. A wide-gamut original will
 * render marginally differently as an untagged derivative than as its tagged
 * self — a uniform saturation shift, no geometry, no threshold moved — and
 * writing a profile here without honouring profiles at decode would claim a
 * fidelity the pipeline does not have.
 */
export async function encodePng(
  pixels: Uint8Array,
  input: { width: number; height: number; components: number },
): Promise<Uint8Array | null> {
  const { width, height, components } = input;
  if (width <= 0 || height <= 0) return null;
  if (components !== 1 && components !== 3 && components !== 4) return null;
  if (pixels.length < width * height * components) return null;

  const rowBytes = width * components;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  const deflated = await deflate(raw);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;                              // bit depth
  header[9] = components === 4 ? 6 : components === 3 ? 2 : 0; // RGBA / RGB / grey
  header[10] = 0; header[11] = 0; header[12] = 0;

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflated),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return await pump(new CompressionStream('deflate'), bytes);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const body = concat([name, data]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return concat([length, body, crc]);
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** `DecompressionStream` is the platform's own inflate — no dependency. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return await pump(new DecompressionStream('deflate'), bytes);
}

/**
 * Push bytes through a transform and collect the result.
 *
 * Written against the stream's own writer rather than `new Blob(…).stream()`:
 * `Blob` has no `stream()` under jsdom, and a compression path nothing can
 * test is a compression path that breaks quietly.
 *
 * Exported for `builderStockRasterPump.test.ts` alone: the failure it pins is
 * a property of THIS function's promise wiring, not of any caller.
 */
export async function pump(
  transform: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> },
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  // A `Uint8Array` reached here through a stream reader carries the wider
  // `ArrayBufferLike`; the stream's writer is typed for the narrow one.
  const written = writer.write(bytes as unknown as BufferSource);
  const closed = written.then(() => writer.close());
  /*
   * A DAMAGED STREAM MUST REJECT THIS FUNCTION, NOT THE ISOLATE.
   *
   * On truncated deflate data the transform errors, `reader.read()` below
   * throws, and this function unwinds BEFORE `await closed` ever attaches a
   * handler — leaving `closed` a rejected promise nobody is listening to.
   * An unhandled rejection tears down the whole isolate: the invocation ends
   * with no throw any caller can catch, no error is written anywhere, and a
   * package-recovery claim is left standing as if the worker had been killed.
   *
   * MEASURED, 5 SEPTEMBER 2026, Lot 58 Lumina Estate. Its 17.9 MB brochure
   * carries one truncated object stream; every inflate call site already
   * catches ("a stream we cannot inflate contributes nothing"), and none of
   * those catches ever ran, because the rejection that escaped was this
   * orphan rather than the one the loop throws. Four claims, four silent
   * deaths, no 546, no error, and the branch retired as unprocessable while
   * the same document elected its cover in under five seconds anywhere the
   * orphan was handled.
   *
   * The branch below marks `closed` handled the moment it exists. `await
   * closed` on the success path still observes a real close failure —
   * attaching a handler to a promise does not change what other awaiters
   * see — so nothing about the healthy path moves.
   */
  closed.catch(() => undefined);

  const chunks: Uint8Array[] = [];
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await closed;

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out as Uint8Array<ArrayBuffer>;
}

/** SHA-256 of exactly these bytes, for the provenance record. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
