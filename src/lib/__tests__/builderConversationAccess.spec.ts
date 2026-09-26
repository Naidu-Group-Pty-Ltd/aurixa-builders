/**
 * A read-only participant is shown the conversation, not a composer the
 * server will refuse. The live proof found a read_only member offered "Send",
 * whose post the server refuses (it reads as "Conversation not found").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mayPostInConversation } from '../builderConversationAccess.pure';

describe('who is offered the composer', () => {
  it('offers it only where the matrix does not deny messages:edit', () => {
    expect(mayPostInConversation({ messages: { view: true, edit: true, delete: false } })).toBe(true);
    expect(mayPostInConversation({ messages: { view: true, edit: false, delete: false } })).toBe(false);
    // An unanswered or partial matrix is not a denial: the server stays the authority.
    expect(mayPostInConversation(undefined)).toBe(true);
    expect(mayPostInConversation({})).toBe(true);
  });

  it('the project conversation page reads it', () => {
    const code = readFileSync(join(__dirname, '..', '..', 'pages', 'builder', 'BuilderMessages.tsx'), 'utf8');
    expect(code).toMatch(/mayPostInConversation\(detailQuery\.data\?\.permissions\)/);
    expect(code).toMatch(/You can read this conversation but not post in it/);
  });
});
