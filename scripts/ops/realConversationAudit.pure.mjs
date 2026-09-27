/**
 * What the cleanup audit asks of a real conversation. Pure, so the rule is
 * tested without a database (src/lib/__tests__/realConversationAudit.spec.ts).
 *
 * A real conversation may hold any number of genuine messages; people keep
 * talking in it. What it must never hold is anything a proof wrote: a message
 * or a participant that
 *   - carries a proof marker, or
 *   - a proof identity wrote, or is, or
 *   - has no living author on the side that records who wrote it, which is
 *     what a proof row looks like once its user has been removed and nothing
 *     carried a marker.
 *
 * Each side records authorship for its own side only. The Command Centre
 * knows which of its staff wrote a message and the network which builder did;
 * the other side's copy carries a display name and no user. So a row is judged
 * by the users of the database it was read from, and the audit reads both
 * sides. A deleted author looks different on each: the Command Centre keeps a
 * dangling id (`missing`), the network's foreign key sets it to NULL.
 */

// Strings only a proof writes. Case-sensitive on purpose: generic words such
// as "proof" appear in real data ("proof of identity").
export const MARKER_RE = [
  'smoke-rollout', 'Smoke Rollout ', 'proof_no_access',
  'Private Chat Proof', 'Messaging Proof', 'Media Proof Street', 'Project Proof', 'Agencies Proof',
  'Proofvale', 'Proof only — not for sale', 'Proof description', 'A signed proof message',
  'Proof Certifi', 'Proof Contact', 'Proof Client', 'Proof Sender', 'proof\\.contact@example\\.com',
  '(private-chat|messaging|media|project|agencies)-proof',
].join('|');

const SIDES = {
  cc: {
    own: 'command_centre', users: 'custom_users',
    messages: 'builder_network_messages', author: 'sender_user_id',
    participants: 'builder_network_conversation_participants', user: 'local_user_id',
  },
  net: {
    own: 'builder', users: 'builder_portal_users',
    messages: 'builder_agency_messages', author: 'sender_builder_user_id',
    participants: 'builder_agency_conversation_participants', user: 'builder_user_id',
  },
};

// An eight-character id prefix, as the audit names real conversations, or a whole id.
const CONVERSATION = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * One read-only SELECT: every message and participant of the named
 * conversations on one side, with whether each carries a marker and what is
 * known of its local author. Ids leave it cut to eight characters; no body,
 * name or email does.
 */
export function conversationRowsSql(db, conversations) {
  const side = SIDES[db];
  if (!side) throw new Error(`unknown side: ${db}`);
  const ids = [...(conversations ?? [])].map(String);
  if (!ids.length) throw new Error('no conversation to read');
  for (const value of ids) if (!CONVERSATION.test(value)) throw new Error('not a conversation id');
  const within = ids.map((value) => `x.conversation_id::text LIKE ${literal(`${value.toLowerCase()}%`)}`).join(' OR ');
  const marker = literal(MARKER_RE);
  const read = (kind, table, ref, userColumn) => `
    SELECT ${literal(db)} AS db, ${literal(kind)} AS kind, left(x.${ref}::text, 8) AS ref,
           left(x.conversation_id::text, 8) AS conversation, x.side,
           x::text ~ ${marker} AS marker,
           CASE WHEN x.${userColumn} IS NULL THEN 'none' WHEN u.id IS NULL THEN 'missing' ELSE 'present' END AS local,
           coalesce(u::text ~ ${marker}, false) AS local_marker
      FROM public.${table} x LEFT JOIN public.${side.users} u ON u.id = x.${userColumn}
     WHERE ${within}`;
  return `${read('message', side.messages, 'id', side.author)}
    UNION ALL${read('participant', side.participants, 'participant_ref', side.user)}`;
}

/** The rows that are proof data, each named by ids and reasons only. */
export function proofDataFindings(rows) {
  const findings = [];
  for (const row of rows ?? []) {
    const message = row.kind === 'message';
    const reasons = [];
    if (row.marker === true) reasons.push('carries a proof marker');
    if (row.local === 'present' && row.local_marker === true) {
      reasons.push(message ? 'written by a proof identity' : 'a proof identity');
    }
    const ownSide = SIDES[row.db]?.own === row.side;
    if (row.local === 'missing' || (ownSide && row.local !== 'present')) {
      reasons.push(message ? 'its author no longer exists' : 'the user no longer exists');
    }
    if (reasons.length) {
      findings.push({ db: row.db, kind: row.kind, ref: row.ref, conversation: row.conversation, side: row.side, reasons });
    }
  }
  return findings;
}
