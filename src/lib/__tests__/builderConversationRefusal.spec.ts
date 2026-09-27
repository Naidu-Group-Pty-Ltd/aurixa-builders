/**
 * A reader who can SEE a project conversation and is refused a post is told
 * the truth — 403 "You do not have permission to post here" — rather than
 * "Conversation not found" (measured on the live portal, 26 Sep 2026). A 404
 * stays the answer for anyone who cannot see it, so existence never leaks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const code = readFileSync(join(__dirname, '..', '..', '..',
  'supabase/functions/builder-portal-collaboration/index.ts'), 'utf8');
const body = code.slice(code.indexOf('const loadConversation = async'), code.indexOf('/** Authorise a task through the scope that owns it. */'));

describe('refusing a post in a conversation the reader can see', () => {
  it('re-asks at view level, and only a reader who can see the conversation is told 403', () => {
    expect(body).toMatch(/if \(!scope\.ok\) \{/);
    expect(body).toMatch(/level !== 'view'/);
    expect(body).toMatch(/loadScope\(\s*conversation\.scope_type as BuilderScopeType, conversation\.scope_id, 'messages', 'view'\)/);
    expect(body).toMatch(/_level: 'view'/);
    expect(body).toMatch(/status: 403, error: 'You do not have permission to post here'/);
    expect(body).toMatch(/return \{ ok: false, status: 404, error: 'Conversation not found' \}/);
  });
});
