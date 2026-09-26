/**
 * Which conversation an agreed activation is bound to by the backfill, and
 * how many messages each side holds in it BEFORE seeding (docs/builder-portal
 * /62 §5). Pure, so the rule is tested without either project.
 *
 * The counts are the backfill's promise: seeding writes participants and a
 * binding, never a message, so what is read back afterwards must equal them.
 * They are therefore taken from the conversation the plan settled on, on
 * each side, in EVERY branch — including a conversation already bound by an
 * earlier, interrupted run, which is exactly the run that must verify
 * rather than fail after writing.
 */
export function planConversation({ row, announcement, legacyId, derivedId }) {
  const reasons = [];
  const ccConversations = row.conversations ?? [];
  const netConversations = announcement.conversations ?? [];
  const ccLegacy = ccConversations.find((c) => c.id === legacyId);
  const netLegacy = netConversations.find((c) => c.id === legacyId);
  const ccBound = ccConversations.find((c) => c.selection_ref === row.selection_id);
  const netBound = netConversations.find((c) => c.selection_ref === row.selection_id);

  let conversationId;
  if (ccBound || netBound) {
    conversationId = (ccBound ?? netBound).id;
    if (ccBound && netBound && ccBound.id !== netBound.id) reasons.push('the two sides bound it to different conversations');
  } else if (ccLegacy || netLegacy) {
    if (!ccLegacy || !netLegacy) reasons.push("Step 5's conversation exists on one side only");
    if (row.live_activations_of_property !== 1) {
      reasons.push(`${row.live_activations_of_property} live activations share Step 5's conversation of this property`);
    }
    if ((ccLegacy?.selection_ref && ccLegacy.selection_ref !== row.selection_id)
        || (netLegacy?.selection_ref && netLegacy.selection_ref !== row.selection_id)) {
      reasons.push("Step 5's conversation is already bound to another activation");
    }
    conversationId = legacyId;
  } else {
    conversationId = derivedId;
  }
  const count = (list) => Number(list.find((c) => c.id === conversationId)?.messages ?? 0);
  return { conversationId, messages: { cc: count(ccConversations), net: count(netConversations) }, reasons };
}
