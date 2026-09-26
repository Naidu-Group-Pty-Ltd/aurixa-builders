import { useEffect, useState } from 'react';
import { buildFreshness, entryScriptOf } from '@/lib/buildFreshness.pure';

/** How often an open tab asks whether a newer build is being served. */
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** The entry script this page was started from, read from the live document. */
function loadedEntry(): string | null {
  if (typeof document === 'undefined') return null;
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return script?.getAttribute('src') ?? null;
}

/**
 * True once the site serves a newer build than the one this tab is running.
 * Asked when the tab regains focus and every five minutes while it is open;
 * a failed check changes nothing. See `buildFreshness.pure.ts`.
 */
export function useNewerBuildAvailable(): boolean {
  const [newer, setNewer] = useState(false);

  useEffect(() => {
    const loaded = loadedEntry();
    // A development server has no hashed entry: there is nothing to compare.
    if (!loaded) return undefined;
    let cancelled = false;

    const check = async () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      try {
        const response = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
        if (!response.ok) return;
        const served = entryScriptOf(await response.text());
        if (!cancelled && buildFreshness(loaded, served) === 'newer_available') setNewer(true);
      } catch {
        // Offline, or a network hiccup: say nothing rather than something false.
      }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return newer;
}
