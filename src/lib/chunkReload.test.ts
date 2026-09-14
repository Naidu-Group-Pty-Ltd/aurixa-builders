import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanReloadMarkerFromUrl,
  hasRecentlyReloaded,
  isChunkLoadError,
  markReloadAttempt,
} from '@/lib/chunkReload';

describe('isChunkLoadError', () => {
  it('recognises the module-fetch failures browsers actually raise', () => {
    const messages = [
      'Failed to fetch dynamically imported module: https://app/assets/Listings-abc.js',
      'error loading dynamically imported module',
      "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of 'text/html'",
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/index-abc.css',
      'Loading chunk 42 failed.',
    ];
    for (const message of messages) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
  });

  it('recognises webpack-style ChunkLoadError by name', () => {
    const error = new Error('boom');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('does not swallow ordinary application errors', () => {
    expect(isChunkLoadError(new TypeError('listing.price is not a function'))).toBe(false);
    expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('reload bookkeeping', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('reports no recent reload on a fresh session', () => {
    expect(hasRecentlyReloaded()).toBe(false);
  });

  it('remembers a reload attempt within the cooldown', () => {
    const now = 1_000_000;
    markReloadAttempt(now);
    expect(hasRecentlyReloaded(now + 1_000)).toBe(true);
  });

  it('lets a later failure try again once the cooldown lapses', () => {
    const now = 1_000_000;
    markReloadAttempt(now);
    expect(hasRecentlyReloaded(now + 61_000)).toBe(false);
  });

  it('ignores a corrupted marker rather than blocking recovery', () => {
    sessionStorage.setItem('npc.chunkReload.attempt', 'not-a-number');
    expect(hasRecentlyReloaded()).toBe(false);
  });
});

describe('cleanReloadMarkerFromUrl', () => {
  it('removes the cache-busting parameter and keeps the rest of the query', () => {
    window.history.replaceState({}, '', '/listings?view=map&_v=abc123');
    cleanReloadMarkerFromUrl();
    expect(window.location.search).toBe('?view=map');
  });

  it('leaves a clean url untouched', () => {
    window.history.replaceState({}, '', '/listings?view=map');
    cleanReloadMarkerFromUrl();
    expect(window.location.search).toBe('?view=map');
  });
});
