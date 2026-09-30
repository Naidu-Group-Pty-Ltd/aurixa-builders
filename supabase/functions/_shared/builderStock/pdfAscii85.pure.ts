/**
 * BUILDER STOCK — A PDF PICTURE WRAPPED IN ASCII85.
 *
 * MEASURED 30 SEPTEMBER 2026, Mairandi's Google Drive brochures. Nine
 * properties came out of their own builder's "Property Package" PDF with no
 * photograph, and every one of those PDFs draws its cover picture as
 *
 *     /Filter [/ASCII85Decode /DCTDecode]      (a JPEG)
 *     /Filter [/ASCII85Decode /FlateDecode]    (raw RGB samples)
 *
 * An exporter that writes a 7-bit-clean file wraps each binary stream in
 * ASCII85 first. The reader knew one wrapper — Flate — and took anything whose
 * FIRST filter was not Flate as already being the picture, so it looked at
 * ASCII text, found no JPEG signature, and reported the page as having no
 * decodable picture. The election then said the cover "could not be read on
 * this attempt", which is true, and which no retry could ever change.
 *
 * This module unwraps that one layer. Nothing is interpreted: the bytes
 * that come out are the bytes the next filter would have been handed.
 *
 * Pure: no IO, no clock.
 */

/** Which wrappers sit in front of the picture's own encoding. */
export function imageStreamFlags(filters: readonly string[]): { ascii85: boolean; flate: boolean } {
  const ascii85 = filters[0] === 'ASCII85Decode';
  const next = ascii85 ? filters[1] : filters[0];
  return { ascii85, flate: next === 'FlateDecode' };
}

/**
 * ASCII85 (PDF flavour): 5 characters -> 4 bytes, `z` for four zero bytes,
 * whitespace ignored, `~>` ends the data. Null on anything malformed, so a
 * broken stream is a stream we could not read rather than a wrong picture.
 */
export function decodeAscii85(input: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(Math.ceil(input.length * 4 / 5) + 8);
  let length = 0;
  const group: number[] = [];

  const flush = (count: number): boolean => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (i < count ? group[i] : 84);
    if (value > 0xffffffff) return false;
    const emitted = count - 1;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    for (let i = 0; i < emitted; i++) out[length++] = bytes[i];
    return true;
  };

  let at = 0;
  // The optional `<~` prefix.
  while (at < input.length && (input[at] === 0x20 || input[at] === 0x0a || input[at] === 0x0d || input[at] === 0x09)) at++;
  if (input[at] === 0x3c && input[at + 1] === 0x7e) at += 2;

  for (; at < input.length; at++) {
    const c = input[at];
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue;
    if (c === 0x7e) break; // `~>`
    if (c === 0x7a) { // `z`
      if (group.length) return null;
      out[length++] = 0; out[length++] = 0; out[length++] = 0; out[length++] = 0;
      continue;
    }
    if (c < 0x21 || c > 0x75) return null;
    group.push(c - 0x21);
    if (group.length === 5) {
      if (!flush(5)) return null;
      group.length = 0;
    }
  }
  if (group.length === 1) return null;
  if (group.length > 1) {
    const count = group.length;
    while (group.length < 5) group.push(84);
    if (!flush(count)) return null;
  }
  return out.slice(0, length);
}
