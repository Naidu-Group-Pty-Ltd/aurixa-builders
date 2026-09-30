import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeWorkDocument, encodeWorkDocument, isDropboxFetchHost,
  readFolderWorkContext, readSanitizeWorkContext,
} from '../../../supabase/functions/_shared/builderStock/heavyWorkWire.pure';

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
const SHARED = 'supabase/functions/_shared/builderStock';

describe('the heavy work wire', () => {
  it('carries any script through the header and refuses what it cannot read', () => {
    const value = { name: 'Lot 9 — Façade 東京', n: 3 };
    expect(decodeWorkDocument(encodeWorkDocument(value))).toEqual(value);
    expect(decodeWorkDocument('%%%')).toBeNull();
    expect(decodeWorkDocument(null)).toBeNull();
  });

  it('fetches from Dropbox hosts only, over https, on every hop', () => {
    expect(isDropboxFetchHost('https://www.dropbox.com/scl/fo/a/b?dl=1')).toBe(true);
    expect(isDropboxFetchHost('https://uc123.dl.dropboxusercontent.com/zip_download_get/x')).toBe(true);
    expect(isDropboxFetchHost('http://www.dropbox.com/scl/fo/a/b')).toBe(false);
    expect(isDropboxFetchHost('https://dropbox.com.evil.example/x')).toBe(false);
    expect(isDropboxFetchHost('https://evil.example/dl.dropboxusercontent.com')).toBe(false);
    expect(isDropboxFetchHost('https://user:pw@www.dropbox.com/x')).toBe(false);
    expect(isDropboxFetchHost('https://www.dropbox.com:8443/x')).toBe(false);
    expect(isDropboxFetchHost('https://169.254.169.254/latest')).toBe(false);
  });

  it('never reads a malformed repair region as no region', () => {
    expect(readSanitizeWorkContext({})).toEqual({});
    expect(readSanitizeWorkContext({ repairRegion: { left: 0, top: 0, right: 1, bottom: 1 } }))
      .toEqual({ repairRegion: { left: 0, top: 0, right: 1, bottom: 1 } });
    expect(readSanitizeWorkContext({ repairRegion: { left: 2, top: 0, right: 1, bottom: 1 } })).toBeNull();
    expect(readSanitizeWorkContext({ repairRegion: [] })).toBeNull();
    expect(readSanitizeWorkContext(null)).toBeNull();
  });

  it('refuses a folder context it cannot vouch for', () => {
    const good = {
      url: 'https://www.dropbox.com/scl/fo/a/b', label: 'Display Home', lot: null, word: 'lot',
      design: 'Mira 22', fieldDesign: null, identityHints: ['Estate'], confirmedLots: null, buildingSqm: 210,
    };
    expect(readFolderWorkContext(good)).toEqual(good);
    expect(readFolderWorkContext({ ...good, word: 'parcel' })).toBeNull();
    expect(readFolderWorkContext({ ...good, identityHints: [1] })).toBeNull();
    expect(readFolderWorkContext({ ...good, confirmedLots: 'x' })).toBeNull();
    expect(readFolderWorkContext({ ...good, buildingSqm: -1 })?.buildingSqm).toBeNull();
  });
});

describe('where the heavy work runs', () => {
  it('the settler repairs through the worker where one is configured', () => {
    expect(read(`${SHARED}/settleImageSanitization.ts`))
      .toMatch(/options\.sanitize \?\? sanitizeWithCapacity/);
    expect(read(`${SHARED}/previewSanitization.ts`))
      .toMatch(/deps\.sanitize \?\? sanitizeWithCapacity/);
  });

  it('a Dropbox folder is read by the worker unless a test hands over its own stream', () => {
    const source = read(`${SHARED}/packageImages.ts`);
    expect(source).toMatch(/deps\.streamFolder \? null : heavyWorkRoute\(\)/);
    expect(source).toMatch(/recoverDropboxFolderOnWorker\(/);
  });

  it('the worker repairs on the deterministic route only and calls no vendor', () => {
    const worker = read('workers/builder-stock-pdf-worker/src/pdfElection.do.ts');
    expect(worker).toMatch(/allowGenerative: false/);
    expect(read('workers/builder-stock-pdf-worker/build.mjs')).toMatch(/noVendorFetch\.ts/);
  });
});

describe('a repair still owed is not a property with no photograph', () => {
  it('a sweep deferred by a standing attempt counts it', () => {
    expect(read(`${SHARED}/settleImageSanitization.ts`))
      .toMatch(/if \(attemptedRecently\(detail\)\) \{\s*outcome\.deferred = \(outcome\.deferred \?\? 0\) \+ 1;/);
  });

  it('keeps the property on sanitization — standing or faulted — as a counted failure rather than routing it on', () => {
    const source = read(`${SHARED}/settleItemImages.ts`);
    const rule = source.slice(source.indexOf('const owed = (sanitization.deferred ?? 0) + sanitization.unresolved;'));
    expect(rule).toMatch(/if \(answered === 0 && owed > 0\) \{/);
    expect(rule).toMatch(/settlement\.nextStage = 'sanitization';/);
    expect(rule).toMatch(/settlement\.failed = true;/);
  });
});
