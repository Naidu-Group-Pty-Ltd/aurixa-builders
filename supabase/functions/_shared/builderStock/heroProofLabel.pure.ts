/**
 * A 5×7 bitmap typeface for the hero proof sheet's labels — so what a row
 * shows is written INSIDE the PNG and nothing beside it has to be stored (the
 * image bucket accepts images only). Upper case, digits and the handful of
 * marks a label uses; anything else draws as a space. Pure.
 */
const GLYPHS: Record<string, number[]> = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  ':': [0, 12, 12, 0, 12, 12, 0], _: [0, 0, 0, 0, 0, 0, 31], '-': [0, 0, 0, 31, 0, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8], '.': [0, 0, 0, 0, 0, 12, 12], '#': [10, 10, 31, 10, 31, 10, 10],
  '%': [24, 25, 2, 4, 8, 19, 3], '/': [0, 1, 2, 4, 8, 16, 0], '=': [0, 0, 31, 0, 31, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
};

/** Width in pixels of `text` at `scale`. */
export function labelWidth(text: string, scale = 2): number {
  return text.length * 6 * scale;
}

/** Draw `text` into an RGB buffer `outW` wide at (x, y); clipped to the buffer. */
export function drawLabel(
  out: Uint8Array, outW: number, x: number, y: number, text: string,
  colour: [number, number, number], scale = 2,
): void {
  const outH = Math.floor(out.length / 3 / outW);
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let row = 0; row < 7; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          if (!(glyph[row] & (1 << (4 - col)))) continue;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              const px = cx + col * scale + dx, py = y + row * scale + dy;
              if (px < 0 || py < 0 || px >= outW || py >= outH) continue;
              out.set(colour, (py * outW + px) * 3);
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

/** Every character `drawLabel` can draw — a label is checked against it. */
export const LABEL_ALPHABET = new Set([...Object.keys(GLYPHS), ' ']);
