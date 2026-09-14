/**
 * Recovery for stale-deployment chunk failures.
 *
 * Vite content-hashes every chunk, so `index.html` is the only file that maps
 * routes to hashes. When a browser (or CDN) holds a cached `index.html` from a
 * previous deploy, its dynamic imports point at hashes the host no longer
 * serves. The import rejects, `<Suspense>` never resolves, and the feature sits
 * on its loading fallback forever while the rest of the app — already in the
 * main bundle — keeps working.
 *
 * Reloading fetches a fresh `index.html` and the current hashes, which fixes it.
 * The reload has to be one-shot: if the chunk is genuinely missing (a bad
 * deploy), reloading on every failure would spin.
 */

const RELOAD_FLAG = 'npc.chunkReload.attempt';
/** A reload only counts as "recent" for this long; after that we may retry. */
const RELOAD_COOLDOWN_MS = 60_000;

/**
 * Errors browsers raise when a module or its preload cannot be fetched. The
 * wording differs per engine, so match on the shapes rather than one string.
 */
const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /'text\/html' is not a valid javascript mime type/i,
  /expected a javascript(-or-wasm)? module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /loading chunk \d+ failed/i,
  /loading css chunk/i,
  /chunkloaderror/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? '';
  if (name === 'ChunkLoadError') return true;
  const message = String((error as { message?: string }).message ?? error);
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

interface ReloadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): ReloadStorage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    // Private mode / blocked storage: fall back to "no record of a reload".
    return null;
  }
}

/**
 * True when a recovery reload already happened recently, so the caller should
 * surface an error instead of reloading again.
 */
export function hasRecentlyReloaded(now: number = Date.now()): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  const raw = storage.getItem(RELOAD_FLAG);
  if (!raw) return false;
  const stamp = Number(raw);
  if (!Number.isFinite(stamp)) return false;
  return now - stamp < RELOAD_COOLDOWN_MS;
}

export function markReloadAttempt(now: number = Date.now()): void {
  safeStorage()?.setItem(RELOAD_FLAG, String(now));
}

/**
 * Reload past the HTTP cache so a stale `index.html` cannot be served again.
 * A cache-busting query on the document is the only lever that reliably works
 * across browsers — `location.reload(true)` is long deprecated and ignored.
 */
export function reloadForFreshBuild(): void {
  markReloadAttempt();
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('_v', Date.now().toString(36));
  window.location.replace(url.toString());
}

/**
 * Strips the cache-busting parameter after a recovery reload so it does not
 * leak into links the user copies or into analytics.
 */
export function cleanReloadMarkerFromUrl(): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('_v')) return;
  url.searchParams.delete('_v');
  window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * Pulls the module URL out of a chunk-load error message.
 *
 * Every engine that raises these puts the absolute URL in the message
 * ("Failed to fetch dynamically imported module: https://…/assets/X-hash.js"),
 * which is the only handle we get — the rejected promise carries no request.
 */
export function extractChunkUrl(error: unknown): string | null {
  const message = String((error as { message?: string })?.message ?? error ?? '');
  const match = message.match(/https?:\/\/[^\s'")]+\.(?:m?js|css)/i);
  return match ? match[0] : null;
}

/**
 * Re-requests a failed chunk outside the module loader, bypassing the HTTP
 * cache and carrying cookies.
 *
 * This is what recovers the case the retry loop alone cannot: an edge/WAF that
 * answers one asset request with an HTML interstitial. The module loader caches
 * that failure for the URL, but a credentialed `cache: 'reload'` fetch both
 * revalidates and picks up whatever cookie the edge wanted to set — after which
 * a reload serves the real script.
 *
 * Resolves true only when the response is really JavaScript/CSS.
 */
export async function warmChunkUrl(url: string | null): Promise<boolean> {
  if (!url || typeof fetch !== 'function') return false;
  try {
    const response = await fetch(url, { cache: 'reload', credentials: 'include' });
    if (!response.ok) return false;
    const type = response.headers.get('content-type') ?? '';
    return !/text\/html/i.test(type);
  } catch {
    return false;
  }
}
