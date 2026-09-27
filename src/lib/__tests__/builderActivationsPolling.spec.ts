/**
 * The Activated Properties list refreshes itself.
 *
 * The Command Centre now delivers an activation within seconds of it being
 * made, but the app turns refetch-on-focus off globally and neither activation
 * query polled — so an open Agencies page still showed nothing new until it
 * was reloaded. Both read the list on the team conversation's cadence; a
 * refusal stops the poll, anything transient keeps it going.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVATED_PROPERTIES_POLL_MS } from '../builderPolling.pure';

const readCode = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const hookBody = (code: string, name: string) => {
  const from = code.slice(code.indexOf(`export function ${name}(`));
  return from.slice(0, from.indexOf('\n}\n'));
};

describe('activated properties polling', () => {
  it('refreshes within seconds, not minutes', () => {
    expect(ACTIVATED_PROPERTIES_POLL_MS).toBeGreaterThanOrEqual(5_000);
    expect(ACTIVATED_PROPERTIES_POLL_MS).toBeLessThanOrEqual(15_000);
  });

  it('both activation reads poll, and only while the tab is visible', () => {
    const code = readCode('src/lib/builderStockQueries.ts');
    for (const hook of ['useBuilderActivatedProperties', 'useEveryBuilderActivatedProperty']) {
      const body = hookBody(code, hook);
      expect(body).toMatch(/refetchInterval:\s*\(query\)\s*=>\s*pollUnlessGone\(query\.state,\s*ACTIVATED_PROPERTIES_POLL_MS\)/);
      expect(body).toMatch(/refetchIntervalInBackground:\s*false/);
    }
  });
});
