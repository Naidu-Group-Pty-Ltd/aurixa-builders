/**
 * ONE IMPLEMENTATION, TWO PORTALS. The Marketplace Hero Standard's planner,
 * its drawing module and the picture component are kept BYTE-IDENTICAL in the
 * Builder Portal (aurixa-builders) and the Command Centre
 * (npc-property-dashbord), and this file — identical in both — pins the same
 * SHA-256 for each. Change one copy and this fails in that repository; change
 * both, update the digests here in both, and the two can still never draw one
 * property two ways.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

export const HERO_PARITY_DIGESTS: Record<string, string> = {
  'supabase/functions/_shared/builderStock/marketplaceHero.pure.ts': '8b1b6d940e008f9addcff43e19720ee143518c2bed1b2685c5fdfb7bc60b7bd9',
  'src/lib/marketplaceHero.ts': '25d93959813513b13aedfb28d80831b0071af6a11a08edff06946f0479915906',
  'src/components/stock/StockPicture.tsx': 'a9a591d9b520a087a32ce230ef7147c75a68e4e6e4df7d9150395fceba25b55e',
};

describe('the hero standard is one implementation in both portals', () => {
  it.each(Object.entries(HERO_PARITY_DIGESTS))('%s is the shared copy', (path, digest) => {
    const bytes = readFileSync(resolve(__dirname, '../../..', path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
  });
});
