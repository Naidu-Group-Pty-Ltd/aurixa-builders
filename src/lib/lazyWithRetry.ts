import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  extractChunkUrl,
  hasRecentlyReloaded,
  isChunkLoadError,
  reloadForFreshBuild,
  warmChunkUrl,
} from '@/lib/chunkReload';

type Importer<T> = () => Promise<{ default: T }>;

const RETRY_DELAYS_MS = [250, 900];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Loads a lazy chunk, tolerating the two ways it realistically fails.
 *
 * 1. A flaky network drops the request — retried with a short backoff.
 * 2. The page is running a stale `index.html` whose chunk hashes the host no
 *    longer serves — no amount of retrying helps, so we reload once to pick up
 *    the current build. Guarded so a genuinely broken deploy cannot spin.
 */
export async function loadChunkWithRetry<T>(importer: Importer<T>): Promise<{ default: T }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const loaded = await importer();
      // A *resolved* import can still be nothing: Vite's preload helper
      // swallows the rejection when a `vite:preloadError` listener calls
      // `preventDefault()`, and the promise then fulfils with `undefined`.
      // React.lazy reads `.default` off that and the whole page dies with
      // "Cannot read properties of undefined (reading 'default')". Treat it as
      // the chunk failure it actually is so the retry/reload path handles it.
      if (!loaded || (loaded as { default?: unknown }).default === undefined) {
        throw new Error('Failed to fetch dynamically imported module (empty module record)');
      }
      return loaded;
    } catch (error) {
      lastError = error;
      if (!isChunkLoadError(error)) throw error;
      if (attempt < RETRY_DELAYS_MS.length) {
        // Re-request the asset outside the module loader before retrying. The
        // loader caches a failure per URL, so a plain retry of the same import
        // can only repeat it; a credentialed no-cache fetch revalidates and
        // clears an edge interstitial (and picks up the cookie it wanted to
        // set), which is the failure mode where the file is served fine to
        // everything except the import that just asked for it.
        await warmChunkUrl(extractChunkUrl(error));
        await wait(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  if (!hasRecentlyReloaded()) {
    console.warn('[chunk] Stale build detected — reloading to fetch the current assets.');
    reloadForFreshBuild();
    // Park the promise: the navigation is already underway, and resolving or
    // rejecting here would flash an error boundary on the way out.
    return new Promise<{ default: T }>(() => undefined);
  }

  console.error('[chunk] Chunk still unavailable after a recovery reload.', lastError);
  throw lastError;
}

/**
 * Drop-in replacement for `React.lazy` that survives a redeploy.
 *
 * `React.lazy` caches the rejected promise, so once a chunk import fails the
 * component can never recover — even after the network comes back. Retrying
 * inside the importer keeps recovery inside the same promise.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  importer: Importer<T>,
): LazyExoticComponent<T> {
  // The prime bounds `T` at `ComponentType<never>` and compiles without
  // `strict`, which never checks the bound against `React.lazy`'s own
  // `ComponentType<any>` constraint. Under strict the two are incompatible
  // (class statics make props invariant), so the network bound matches
  // React's — every call site is a default-export page either way.
  return lazy(() => loadChunkWithRetry(importer));
}
