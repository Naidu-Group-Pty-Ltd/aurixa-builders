import { describe, expect, it } from 'vitest';
import { buildFreshness, entryScriptOf } from './buildFreshness.pure';

const page = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script>`
  + '<link rel="stylesheet" crossorigin href="/assets/index-Dh3dq991.css"></head><body></body></html>';

describe('whether this tab runs the build the site serves', () => {
  it('reads the entry script a served page names', () => {
    expect(entryScriptOf(page('/assets/index-C7F7vz0I.js'))).toBe('/assets/index-C7F7vz0I.js');
    expect(entryScriptOf('<html><body>no scripts</body></html>')).toBeNull();
  });

  it('the same entry is current, a different one is a newer build', () => {
    expect(buildFreshness('/assets/index-C7F7vz0I.js', '/assets/index-C7F7vz0I.js')).toBe('current');
    expect(buildFreshness('/assets/index-Old00000.js', '/assets/index-C7F7vz0I.js')).toBe('newer_available');
  });

  it('compares file names, so an absolute and a relative address of one build agree', () => {
    expect(buildFreshness('https://builders.example/assets/index-C7F7vz0I.js', '/assets/index-C7F7vz0I.js')).toBe('current');
  });

  it('says nothing when either side cannot be read', () => {
    expect(buildFreshness(null, '/assets/index-C7F7vz0I.js')).toBe('unknown');
    expect(buildFreshness('/assets/index-C7F7vz0I.js', null)).toBe('unknown');
  });
});
