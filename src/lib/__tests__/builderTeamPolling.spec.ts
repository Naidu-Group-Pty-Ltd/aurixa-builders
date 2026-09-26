/**
 * A team (project) conversation and the unread bell refresh themselves.
 *
 * The app turns refetch-on-focus off globally, and neither query polled, so a
 * colleague's message never appeared in an open project conversation and the
 * bell's count never moved until the page was reloaded — the defect the
 * agency chat had and was fixed for. Both now poll; a refusal (401/403) or a
 * conversation that is gone (404) stops the poll rather than repeating it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TEAM_CONVERSATION_POLL_MS, UNREAD_COUNTS_POLL_MS, pollUnlessGone,
} from '../builderPolling.pure';
import { AGENCY_CONVERSATION_POLL_MS } from '../builderAgency';

const readCode = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('team conversation and unread polling', () => {
  it('polls at the agency chat cadence, and the bell more gently', () => {
    expect(TEAM_CONVERSATION_POLL_MS).toBe(AGENCY_CONVERSATION_POLL_MS);
    expect(UNREAD_COUNTS_POLL_MS).toBeGreaterThanOrEqual(TEAM_CONVERSATION_POLL_MS);
    expect(UNREAD_COUNTS_POLL_MS).toBeLessThanOrEqual(60_000);
  });

  it('stops on a refusal or a conversation that is gone, and keeps polling otherwise', () => {
    expect(pollUnlessGone({ error: null }, 10_000)).toBe(10_000);
    expect(pollUnlessGone({ error: { status: 503 } }, 10_000)).toBe(10_000);
    expect(pollUnlessGone({ error: new Error('network') }, 10_000)).toBe(10_000);
    for (const status of [401, 403, 404]) {
      expect(pollUnlessGone({ error: { status } }, 10_000)).toBe(false);
    }
  });

  it('the open conversation and the bell read it', () => {
    const code = readCode('src/lib/builderQueries.ts');
    const conversation = code.slice(code.indexOf('export function useBuilderConversation('));
    expect(conversation.slice(0, conversation.indexOf('\n}\n')))
      .toMatch(/refetchInterval:\s*\(query\)\s*=>\s*pollUnlessGone\(query\.state,\s*TEAM_CONVERSATION_POLL_MS\)/);
    const counts = code.slice(code.indexOf('export function useBuilderUnreadCounts('));
    expect(counts.slice(0, counts.indexOf('\n}\n')))
      .toMatch(/refetchInterval:\s*\(query\)\s*=>\s*pollUnlessGone\(query\.state,\s*UNREAD_COUNTS_POLL_MS\)/);
  });
});
