import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reloadForFreshBuild = vi.hoisted(() => vi.fn());

vi.mock('@/lib/chunkReload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chunkReload')>();
  return { ...actual, reloadForFreshBuild };
});

const { loadChunkWithRetry } = await import('@/lib/lazyWithRetry');
const { markReloadAttempt } = await import('@/lib/chunkReload');

const chunkError = () =>
  new Error('Failed to fetch dynamically imported module: /assets/ListingsMapView-abc.js');

describe('loadChunkWithRetry', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reloadForFreshBuild.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the module when the import succeeds', async () => {
    const importer = vi.fn().mockResolvedValue({ default: 'Component' });
    await expect(loadChunkWithRetry(importer)).resolves.toEqual({ default: 'Component' });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('rides out a transient chunk failure', async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue({ default: 'Component' });

    await expect(loadChunkWithRetry(importer)).resolves.toEqual({ default: 'Component' });
    expect(importer).toHaveBeenCalledTimes(2);
    expect(reloadForFreshBuild).not.toHaveBeenCalled();
  });

  it('does not retry or reload for an ordinary module error', async () => {
    // A component that throws at import time is a real bug — reloading would
    // just hide it behind a refresh loop.
    const boom = new TypeError('Cannot read properties of undefined');
    const importer = vi.fn().mockRejectedValue(boom);

    await expect(loadChunkWithRetry(importer)).rejects.toThrow(boom);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(reloadForFreshBuild).not.toHaveBeenCalled();
  });

  it('reloads once when the chunk is gone for good', async () => {
    const importer = vi.fn().mockRejectedValue(chunkError());

    let settled = false;
    void loadChunkWithRetry(importer).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // The backoff runs for ~1.15s before giving up, so allow for it.
    await vi.waitFor(() => expect(reloadForFreshBuild).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });

    expect(importer).toHaveBeenCalledTimes(3); // initial + two backoff retries
    // The promise stays pending so no error boundary flashes mid-navigation.
    expect(settled).toBe(false);
  });

  it('surfaces the failure instead of reloading again', async () => {
    markReloadAttempt();
    const importer = vi.fn().mockRejectedValue(chunkError());

    await expect(loadChunkWithRetry(importer)).rejects.toThrow(
      /Failed to fetch dynamically imported module/,
    );
    expect(reloadForFreshBuild).not.toHaveBeenCalled();
  });
});
