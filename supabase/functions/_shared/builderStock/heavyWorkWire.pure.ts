/**
 * BUILDER STOCK — THE TWO HEAVY JOBS THE PDF WORKER NOW DOES AS WELL.
 *
 * WHY. Measured 30 September 2026 on ten Mairandi industrial units and three
 * display homes, all of whose photographs the builder DID supply:
 *
 *   - the overlay repair of one 2010 × 1507 facade — a builder's badge over
 *     2.6% of the frame — succeeds deterministically and passes the display
 *     gate, and costs 2,794 ms of CPU. The edge allows 2,000. The settler's
 *     own log reads `CPU Time exceeded` the moment each repair started, the
 *     claim stamp then kept every later sweep off the row, and the property
 *     was stamped as holding "an image that is not a photograph of this
 *     property" — ten times over, about a photograph of that property.
 *
 *   - a Dropbox shared folder can only be read as one 237 MB zip. Streaming it
 *     is cheap by the standard of a machine (722 ms of CPU on a CI runner) and
 *     too dear for an edge isolate that must also do the rest of its claim:
 *     four `runtime_termination: cpu` kills in five minutes on one property.
 *
 * Neither job fits and no scheduling makes it fit, which is exactly why the
 * PDF election moved to the Cloudflare worker on 8 September. These two move
 * there too, through the same front door, token and lanes. What they decide
 * does not move: the worker bundles the SAME `sanitizeSourceImage` and the
 * SAME `recoverFromDropboxFolder` the edge runs, so there is one repair and
 * one folder reading, executed where there is CPU for them.
 *
 * WHAT CROSSES THE WIRE. Bytes travel as the raw body in both directions —
 * base64 of a 4 MB PNG is CPU the edge does not have. Everything else is a
 * small JSON document in a header, UTF-8 then base64url, so a folder name in
 * any script survives it.
 *
 * Pure: no IO.
 */

export const SANITIZE_PATH = '/v1/sanitize';
export const FOLDER_PATH = '/v1/folder';
/**
 * The Marketplace Hero Standard's plan: the served picture in, its plan out
 * (`heroPlanning.ts`). Decoding is the expensive half and has killed edge
 * isolates before, so it runs here beside the repair, on the same token and
 * lanes. The answer is a plan in the outcome header and, only when a proof
 * was asked for, a raw RGB tile as the body.
 */
export const HERO_PATH = '/v1/hero';

/** The request's small context. */
export const WORK_CONTEXT_HEADER = 'x-work-context';
/** The answer's small document; the body carries the bytes, if any. */
export const WORK_OUTCOME_HEADER = 'x-work-outcome';

/** A repair and a folder read each finish in seconds; this is the ceiling. */
export const HEAVY_WORK_TIMEOUT_MS = 60_000;
/** The largest picture sent for repair. Matches the store's own ceiling. */
export const MAX_SANITIZE_BYTES = 16 * 1024 * 1024;

export function encodeWorkDocument(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeWorkDocument(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string' || !raw || raw.length > 64 * 1024) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * THE ONLY HOSTS THE WORKER WILL FETCH FROM, AND ONLY OVER HTTPS.
 *
 * The worker sits outside every network this product owns, and it is handed a
 * URL out of a builder's spreadsheet. An allow-list of the one vendor this
 * endpoint exists for is stricter than any "is this address public" test, and
 * it is checked on every redirect hop, not just the first.
 */
export function isDropboxFetchHost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    return host === 'dropbox.com' || host === 'www.dropbox.com'
      || host === 'dl.dropboxusercontent.com'
      || host.endsWith('.dl.dropboxusercontent.com');
  } catch {
    return false;
  }
}

export interface RepairBox { left: number; top: number; right: number; bottom: number }

/** What the edge sends with a picture to repair. */
export interface SanitizeWorkContext {
  repairRegion?: RepairBox | RepairBox[];
}

const isFraction = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isBox = (value: unknown): value is RepairBox => {
  const box = value as Record<string, unknown> | null;
  return !!box && typeof box === 'object'
    && isFraction(box.left) && isFraction(box.top)
    && isFraction(box.right) && isFraction(box.bottom);
};

/** Never guessed: anything malformed is refused, never read as "no region". */
export function readSanitizeWorkContext(raw: unknown): SanitizeWorkContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const region = (raw as { repairRegion?: unknown }).repairRegion;
  if (region === undefined || region === null) return {};
  if (isBox(region)) return { repairRegion: region };
  if (Array.isArray(region) && region.length > 0 && region.length <= 16 && region.every(isBox)) {
    return { repairRegion: region };
  }
  return null;
}

/** What the edge sends to have a Dropbox folder read for one property. */
export interface FolderWorkContext {
  url: string;
  label: string;
  lot: string | null;
  word: 'lot' | 'unit';
  design: string | null;
  fieldDesign: string | null;
  identityHints: string[];
  confirmedLots: string[] | null;
  buildingSqm: number | null;
}

const shortText = (value: unknown, max = 500): value is string =>
  typeof value === 'string' && value.length <= max;
const textOrNull = (value: unknown, max = 500): string | null | undefined =>
  value === null || value === undefined ? null : shortText(value, max) ? value : undefined;

export function readFolderWorkContext(raw: unknown): FolderWorkContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!shortText(c.url, 2048) || !shortText(c.label)) return null;
  const lot = textOrNull(c.lot, 40);
  const design = textOrNull(c.design, 200);
  const fieldDesign = textOrNull(c.fieldDesign, 200);
  if (lot === undefined || design === undefined || fieldDesign === undefined) return null;
  if (c.word !== 'lot' && c.word !== 'unit') return null;
  const hints = Array.isArray(c.identityHints) ? c.identityHints : [];
  if (hints.length > 32 || !hints.every((hint) => shortText(hint, 300))) return null;
  let confirmedLots: string[] | null = null;
  if (Array.isArray(c.confirmedLots)) {
    if (c.confirmedLots.length > 8 || !c.confirmedLots.every((lotValue) => shortText(lotValue, 40))) {
      return null;
    }
    confirmedLots = c.confirmedLots as string[];
  } else if (c.confirmedLots !== null && c.confirmedLots !== undefined) {
    return null;
  }
  const sqm = c.buildingSqm;
  const buildingSqm = typeof sqm === 'number' && Number.isFinite(sqm) && sqm > 0 ? sqm : null;
  return {
    url: c.url, label: c.label, lot, word: c.word, design, fieldDesign,
    identityHints: hints as string[], confirmedLots, buildingSqm,
  };
}

/**
 * What a hero request may ask, and nothing else: a proof tile, the fit rescue
 * (v3), or the decoded thumbnail itself for a proof composed by the network.
 * A tile and a thumbnail are both the one body an answer carries, so asking
 * for both is refused.
 */
export interface HeroWorkContext { proof?: boolean; rescue?: boolean; thumbnail?: boolean }

export function readHeroWorkContext(raw: unknown): HeroWorkContext | null {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: HeroWorkContext = {};
  for (const key of Object.keys(raw as object)) {
    if (key !== 'proof' && key !== 'rescue' && key !== 'thumbnail') return null;
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== 'boolean') return null;
    if (value) out[key] = true;
  }
  if (out.proof && out.thumbnail) return null;
  return out;
}
