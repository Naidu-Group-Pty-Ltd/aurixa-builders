/**
 * Which build the Command Centre's published frontend serves
 * (docs/builder-portal/64 §4). Pure, so the rules are tested without the
 * origin.
 *
 * Lovable reports a publish as started, never as served. The Command Centre's
 * build names its own commit twice (its `vite.config.ts`): `/version.json`,
 * and a string literal compiled into the entry bundle. The manifest alone is
 * a static file and proves nothing about the JavaScript a browser runs, so an
 * origin proves a build only when both name it.
 */

/** The module script a browser loads first: Vite's entry. */
export function entryScriptOf(html) {
  for (const tag of String(html ?? '').match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

/** `{ buildId }`, or null when the answer is not a manifest (an SPA fallback page answers 200 too). */
export function readBuildManifest(text) {
  let value;
  try { value = JSON.parse(String(text ?? '')); } catch { return null; }
  const buildId = value && typeof value === 'object' ? value.buildId : undefined;
  return typeof buildId === 'string' && buildId.length > 0 ? { buildId } : null;
}

const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Two ids name the same commit: both commit ids, one a prefix of the other. */
export function sameCommit(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  if (!COMMIT.test(x) || !COMMIT.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

const CHALLENGE_PAGE = /just a moment|attention required|cf-chl|challenge-platform/i;

/**
 * Why an origin did not answer, in words. A bot-protection challenge is its
 * own reading, recognised by what the edge said and never by the status digit
 * (the same challenge arrives under 403 and 503): it refuses a scripted
 * client, not the build, and nothing here tries to get past it.
 */
export function describeRefusal({ status, server, mitigated, body }) {
  const text = String(body ?? '');
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim().slice(0, 80) || '';
  const by = server ? `, ${server}` : '';
  if (String(mitigated ?? '').toLowerCase() === 'challenge' || CHALLENGE_PAGE.test(title) || CHALLENGE_PAGE.test(text.slice(0, 4000))) {
    return `challenged by bot protection (HTTP ${status}${by})`;
  }
  return `refused (HTTP ${status}${by}${title ? `, "${title}"` : ''})`;
}

/**
 * What one origin proves. `expected` is the commit the publish was meant to
 * serve; blank records whatever is served and requires only that the manifest
 * and the bundle agree.
 */
export function judgeServedBuild({ manifest, entryCarriesId, expected }) {
  const reasons = [];
  if (!manifest) {
    reasons.push('no build manifest: /version.json did not answer with a build id');
    return { ok: false, reasons };
  }
  if (!COMMIT.test(manifest.buildId)) {
    reasons.push(`build ${manifest.buildId} names no commit (built without git context)`);
  } else if (expected && !sameCommit(manifest.buildId, expected)) {
    reasons.push(`serves ${manifest.buildId}, not ${expected}`);
  }
  if (!entryCarriesId) {
    reasons.push(`the bundle a browser loads is not build ${manifest.buildId} (a stale or split deploy)`);
  }
  return { ok: reasons.length === 0, reasons };
}
