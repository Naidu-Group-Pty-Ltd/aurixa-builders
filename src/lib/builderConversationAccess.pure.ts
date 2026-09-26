/**
 * Whether a project conversation offers its reader a composer.
 *
 * `get_conversation` returns the reader's resolved permission matrix. Where it
 * DENIES `messages:edit` (a read_only member), a post is refused by the server
 * — so the page shows the conversation without a Send button that can only
 * fail. An absent or partial matrix denies nothing: the server remains the
 * authority, exactly as before.
 */
export function mayPostInConversation(
  permissions: Record<string, { view?: boolean; edit?: boolean; delete?: boolean } | undefined> | undefined,
): boolean {
  return permissions?.messages?.edit !== false;
}
