/**
 * A read-only participant is shown the conversation, not a composer the
 * server will refuse. The live proof found a read_only member offered "Send",
 * whose post the server refuses (it reads as "Conversation not found").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mayPostInConversation } from '../builderConversationAccess.pure';
import {
  WITHDRAWN_BUILDER_MESSAGE_VIEWS, isOfferedBuilderMessageView,
} from '../builderHiddenSections.pure';

describe('who is offered the composer', () => {
  it('offers it only where the matrix does not deny messages:edit', () => {
    expect(mayPostInConversation({ messages: { view: true, edit: true, delete: false } })).toBe(true);
    expect(mayPostInConversation({ messages: { view: true, edit: false, delete: false } })).toBe(false);
    // An unanswered or partial matrix is not a denial: the server stays the authority.
    expect(mayPostInConversation(undefined)).toBe(true);
    expect(mayPostInConversation({})).toBe(true);
  });

  /**
   * RENEGOTIATED 2 OCTOBER 2026 — AND THE RULE IS KEPT, NOT DROPPED.
   *
   * This gate was the PROJECT conversation's: its composer read the matrix the
   * detail query returned. An agency conversation has no such matrix — a
   * builder is in it because their own activation opened it — so the gate
   * never applied there and nothing here weakens by the project view being
   * withdrawn.
   *
   * The module stays because the view is HIDDEN, not deleted: its route, its
   * tables and its server operations are all untouched, and whoever offers it
   * again must offer this with it. That is asserted rather than trusted —
   * offered implies gated — so the two can never come back apart.
   */
  it('the composer gate is kept, and returns with the view it guards', () => {
    expect(WITHDRAWN_BUILDER_MESSAGE_VIEWS).toContain('projects');
    const code = readFileSync(
      join(__dirname, '..', '..', 'pages', 'builder', 'BuilderMessages.tsx'), 'utf8');
    expect(code).not.toContain('ProjectConversations');
    if (isOfferedBuilderMessageView('projects')) {
      expect(code).toMatch(/mayPostInConversation\(/);
      expect(code).toMatch(/You can read this conversation but not post in it/);
    }
  });
});
