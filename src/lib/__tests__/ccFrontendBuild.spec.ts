import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module shared with the ops script
import { describeRefusal, entryScriptOf, judgeServedBuild, readBuildManifest, sameCommit } from '../../../scripts/ops/ccFrontendBuild.pure.mjs';

/**
 * WHICH BUILD THE COMMAND CENTRE SERVES (docs/builder-portal/64 §4).
 *
 * The Command Centre's frontend reaches production through Lovable's publish,
 * and Lovable reports a publish as STARTED, never as served. Its build names
 * its own commit twice: `/version.json` (the manifest) and a string literal
 * compiled into the entry bundle (`__BUILD_ID__`). The check reads both from
 * the live origin, and these rules decide what they prove.
 */

const VITE_INDEX = `<!doctype html><html><head>
  <script type="module" crossorigin src="/assets/index-CnTho5T3.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-react-zffjb7D6.js">
  <script src="/lm.js"></script>
</head><body><div id="root"></div></body></html>`;

describe('the entry script a browser loads', () => {
  it('is the module script in index.html, whatever order its attributes are in', () => {
    expect(entryScriptOf(VITE_INDEX)).toBe('/assets/index-CnTho5T3.js');
    expect(entryScriptOf('<script src="/assets/a.js" type="module"></script>')).toBe('/assets/a.js');
  });

  it('is never a preload link or a classic script, and a page with neither module has none', () => {
    expect(entryScriptOf('<link rel="modulepreload" href="/assets/x.js"><script src="/lm.js"></script>')).toBeNull();
    expect(entryScriptOf('')).toBeNull();
  });
});

describe('the manifest', () => {
  it('names a build id', () => {
    expect(readBuildManifest('{"buildId":"31ad90e6ec0c"}')).toEqual({ buildId: '31ad90e6ec0c' });
  });

  it('is nothing when it is not JSON or names no build (an SPA fallback page answers 200 too)', () => {
    expect(readBuildManifest('<!doctype html><html></html>')).toBeNull();
    expect(readBuildManifest('{"buildId":""}')).toBeNull();
    expect(readBuildManifest('{}')).toBeNull();
    expect(readBuildManifest('null')).toBeNull();
  });
});

describe('two ids name the same commit', () => {
  it('when one is a prefix of the other, whatever the case', () => {
    expect(sameCommit('31ad90e6ec0c', '31ad90e6ec0cc5ee767c23233b4de77a5e19b951')).toBe(true);
    expect(sameCommit('31AD90E6EC0C', '31ad90e')).toBe(true);
  });

  it('never for a different commit, a prefix too short to name one, or an id that is not a commit', () => {
    expect(sameCommit('73b841e68f67', '31ad90e6ec0c')).toBe(false);
    expect(sameCommit('31ad90', '31ad90e6ec0c')).toBe(false);
    expect(sameCommit('tmgf3k2x1', 'tmgf3k2x1')).toBe(false);
    expect(sameCommit('dev', 'dev')).toBe(false);
  });
});

describe('what an origin proves', () => {
  const served = (over: Record<string, unknown> = {}) => judgeServedBuild({
    manifest: { buildId: '31ad90e6ec0c' }, entryCarriesId: true, expected: '31ad90e6ec0c', ...over,
  });

  it('serves the expected commit when the manifest names it and the bundle a browser loads carries it', () => {
    expect(served()).toEqual({ ok: true, reasons: [] });
  });

  it('with nothing expected, it records the build and requires only that the two agree', () => {
    expect(served({ expected: '' })).toEqual({ ok: true, reasons: [] });
  });

  it('is not proved by the manifest alone: a page loading another bundle is a stale or split deploy', () => {
    const verdict = served({ entryCarriesId: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/bundle/);
  });

  it('is another commit when the manifest names one', () => {
    const verdict = served({ manifest: { buildId: '73b841e68f67' }, expected: '31ad90e6ec0c' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/73b841e68f67/);
  });

  it('names no commit when the build had no git context, and says so rather than inferring one', () => {
    const verdict = served({ manifest: { buildId: 'tmgf3k2x1' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no commit/);
  });

  it('proves nothing without a manifest', () => {
    const verdict = served({ manifest: null, entryCarriesId: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/version\.json/);
  });
});

describe('an origin that would not answer', () => {
  it('is challenged by bot protection when the edge says so, whatever the status digit', () => {
    expect(describeRefusal({ status: 403, server: 'cloudflare', mitigated: 'challenge', body: '' }))
      .toBe('challenged by bot protection (HTTP 403, cloudflare)');
    expect(describeRefusal({ status: 503, server: 'cloudflare', mitigated: null,
      body: '<html><head><title>Just a moment...</title></head><body></body></html>' }))
      .toBe('challenged by bot protection (HTTP 503, cloudflare)');
  });

  it('is otherwise refused, and names who refused it and what its page said', () => {
    expect(describeRefusal({ status: 403, server: 'cloudflare', mitigated: null,
      body: '<title>Attention Required! | Cloudflare</title>' }))
      .toBe('challenged by bot protection (HTTP 403, cloudflare)');
    expect(describeRefusal({ status: 403, server: 'nginx', mitigated: null, body: '<title>403 Forbidden</title>' }))
      .toBe('refused (HTTP 403, nginx, "403 Forbidden")');
    expect(describeRefusal({ status: 404, server: null, mitigated: null, body: 'Not found' }))
      .toBe('refused (HTTP 404)');
  });
});
