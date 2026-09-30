import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A NEW STOCK LIST APPEARS WITHOUT A RELOAD — 30 September 2026.
 *
 * The page reads live properties, and a new list is held until its photographs
 * are ready. After an upload the page re-read the properties and the sources
 * but not the photo progress, which polls itself only while its OWN last answer
 * shows an upload in progress — so it kept "nothing in progress" for ever, the
 * list never polled, and the cutover was invisible until a reload.
 */
const page = readFileSync(resolve(__dirname, '../../pages/builder/BuilderStockList.tsx'), 'utf8');

describe('the Stock List follows an upload without a reload', () => {
  it('refreshes the photo progress with everything else after an upload', () => {
    const refresh = page.slice(page.indexOf('const refreshAll = useCallback'));
    expect(refresh.slice(0, refresh.indexOf('}, ['))).toMatch(/imageProgressQuery\.refetch\(\)/);
  });

  it('polls the list while any upload is still being worked', () => {
    expect(page).toMatch(/pollWhileArriving: arrivingUploads > 0 \|\| uploadStillWorking/);
  });

  it('re-reads the list the moment an upload goes live or a photograph lands', () => {
    expect(page).toMatch(/record\.published \? 1 : 0/);
    const effect = page.slice(page.indexOf('const lastProgressSignature'));
    expect(effect.slice(0, effect.indexOf('}, [progressSignature]'))).toMatch(/itemsQuery\.refetch\(\)/);
  });

  it('an import that did not report back reads everything, not only the sources', () => {
    const failure = page.slice(page.indexOf('const reportImportFailure'));
    expect(failure.slice(0, failure.indexOf('}, [toast'))).toMatch(/refreshAll\(\);/);
  });
});
