/**
 * Whether the page in this tab is still the build the site serves.
 *
 * A single-page app keeps running the JavaScript it loaded, however many
 * releases happen after. On 26 Sep 2026 a builder's tab loaded before the Step 6
 * release kept asking the server for conversations in the Step 5 shape (a
 * connection and a property) and was answered "not found" on every poll; the
 * page read "Loading…" and then "could not be loaded", while the site itself
 * already served the build that asks correctly. Nothing told the reader that
 * reloading was the whole remedy.
 *
 * The entry script's name carries the build's content hash, so comparing the
 * one this page loaded with the one `/` now names is an exact test: equal is
 * current, different is a newer build. Anything unreadable is "unknown" and
 * says nothing — a false prompt would teach people to ignore the real one.
 */

/** The entry script a served `index.html` names, e.g. `/assets/index-C7F7vz0I.js`. */
export function entryScriptOf(html: string): string | null {
  const match = /<script\b[^>]*\bsrc="([^"]*\/assets\/index-[^"]+\.js)"/i.exec(html);
  return match ? match[1] : null;
}

export type BuildFreshness = 'current' | 'newer_available' | 'unknown';

/** Compares the entry this page loaded with the one the site serves now. */
export function buildFreshness(loaded: string | null, served: string | null): BuildFreshness {
  if (!loaded || !served) return 'unknown';
  const name = (src: string) => src.slice(src.lastIndexOf('/') + 1);
  return name(loaded) === name(served) ? 'current' : 'newer_available';
}
