import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module shared with the ops script
import { planConversation } from '../../../scripts/ops/agencyChatBackfillPlan.pure.mjs';

/**
 * The backfill's plan (docs/builder-portal/62 §5): which conversation an
 * agreed activation keeps, and the message counts seeding must leave
 * unchanged. The counts must exist in every branch, including a resumed run
 * over a conversation an earlier, interrupted run already bound.
 */
const SEL = 'sel-1';
const LEGACY = 'legacy-conv';
const DERIVED = 'derived-conv';
const plan = (cc: unknown[], net: unknown[], live = 1) => planConversation({
  row: { selection_id: SEL, conversations: cc, live_activations_of_property: live },
  announcement: { conversations: net }, legacyId: LEGACY, derivedId: DERIVED,
});

describe('the backfill plan', () => {
  it('keeps Step 5\'s conversation whole, with its message counts', () => {
    const p = plan([{ id: LEGACY, selection_ref: null, messages: 3 }], [{ id: LEGACY, selection_ref: null, messages: 3 }]);
    expect(p).toEqual({ conversationId: LEGACY, messages: { cc: 3, net: 3 }, reasons: [] });
  });

  it('a resumed run over a conversation bound on both sides still carries the counts to verify', () => {
    const p = plan([{ id: LEGACY, selection_ref: SEL, messages: 3 }], [{ id: LEGACY, selection_ref: SEL, messages: 3 }]);
    expect(p.messages).toEqual({ cc: 3, net: 3 });
    expect(p.reasons).toEqual([]);
  });

  it('a resumed run bound on one side only takes each side\'s count from the same conversation', () => {
    const p = plan([{ id: LEGACY, selection_ref: SEL, messages: 3 }], [{ id: LEGACY, selection_ref: null, messages: 3 }]);
    expect(p).toMatchObject({ conversationId: LEGACY, messages: { cc: 3, net: 3 } });
  });

  it('with no conversation yet, the derived one is created empty', () => {
    expect(plan([], [])).toEqual({ conversationId: DERIVED, messages: { cc: 0, net: 0 }, reasons: [] });
  });

  it('refuses what the two sides disagree about', () => {
    expect(plan([{ id: LEGACY, selection_ref: null, messages: 3 }], []).reasons)
      .toContain("Step 5's conversation exists on one side only");
    expect(plan([{ id: 'a', selection_ref: SEL, messages: 0 }], [{ id: 'b', selection_ref: SEL, messages: 0 }]).reasons)
      .toContain('the two sides bound it to different conversations');
    expect(plan([{ id: LEGACY, selection_ref: null, messages: 1 }], [{ id: LEGACY, selection_ref: null, messages: 1 }], 2).reasons[0])
      .toMatch(/2 live activations share/);
  });
});
