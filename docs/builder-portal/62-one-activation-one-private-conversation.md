# 62 · One activation, one private conversation

Step 5 (doc 61) let a Command Centre user and a property's builder exchange
messages over the signed Builders Network. Its conversation belonged to the
PROPERTY, and anyone with Listings access on this side (or `inventory` access
on the builder's) could read it. This step changes who a conversation is for,
and nothing about how a message travels.

The same contract is implemented twice:

- **Command Centre:** `npc-property-dashbord`'s
  `20261224090000_one_activation_one_private_conversation.sql`.
- **aurixa-builders (this repository):** `20260926120000_one_activation_one_private_conversation.sql`.

The Command Centre's copy of this document is `npc-property-dashbord`'s
`docs/builder-portal/52-…`; the two are the same contract.

## 1. What a conversation is now

**One activation, one conversation.** Two activations of the same property
(for two clients, perhaps by two Command Centre users) have two separate
conversations. Nobody reaches an activation's conversation because it is the
same property, because they hold Listings or `inventory` access, because they
are a project party, because they belong to the same organisation, or
because they know its URL.

**Its identity.** The activation's shared reference is the one the activation
contract already carries in every `stock.selection.*` event:
`remote_selection_ref`. A new conversation's id is derived from it:

```
md5('agency.activation:' || <network connection id> || ':' || <remote_selection_ref>)::uuid
```

Both ends compute it without asking each other. The reference itself is never
put into anything new: messages and participant events carry only the derived
`conversation_id`.

**The one conversation that already exists** keeps the id it was created with
(Step 5's property derivation). The conversation row records which activation
it belongs to (`selection_ref`), so a historical id and a derived id are
resolved the same way: a conversation is found by its row, and a new one is
recognised by the derivation.

**When it opens.** It is created, and becomes writable, when the builder
acknowledges the activation. It stays writable while the activation is live
(acknowledged and not withdrawn), the connection is active with
`stock:publish`, and the builder still lists the property (Step 5's rules,
unchanged). Once the activation is withdrawn it is closed: its participants
keep its history, and nobody can send, retry or invite.

## 2. Who is in it

**Initial participants.** When the builder acknowledges, the conversation
starts with exactly two people:

1. the Command Centre user who activated the property;
2. the Builder Portal user who acknowledged it.

**Membership is local, and each side is the only authority over its own
users.** Each side keeps a participant table. A row for a local user grants
that user access; a row for a remote participant is a display record and
grants nothing to anyone.

A local user must be a current (`joined`) participant, checked on the server,
to read, poll, send, retry, list participants, invite or leave. A
non-participant may learn only that a private conversation exists: never a
message body, a participant list, a message count or a delivery state.

**Invite.** A participant may invite an active colleague from their own side
only: on the Command Centre, an active user who holds Listings view; on the
network, an active member of the same builder organisation who holds
`inventory` view. The server reads the candidate's membership from its own
rows; the browser names a user and nothing else, and any user who is not a
valid candidate is refused. Inviting is a write, so the inviter also needs the
permission sending needs (Listings edit here, `inventory` edit on the
network); a participant who holds view alone reads the conversation and adds
nobody, exactly as they send nothing. An invited colleague sees the whole history.
Inviting someone already in the conversation changes nothing. A conversation
that is closed takes no invitation.

**Leave.** A participant may leave; nobody may remove anybody. While the
conversation is live, the last participant on a side cannot leave until a
colleague from that side has joined. A closed conversation can be left
freely. Leaving ends access at once: the next read, poll, send, retry, invite
or participant list is refused exactly as a user without access is refused
(Step 5's refusal handling). Leaving never deletes history. Someone invited
again after leaving joins again and sees the whole history.

**The whole history, not a window of it.** A read returns the newest page of
messages and says whether anything older exists (`has_earlier`, with
`earlier_cursor`, the id of the oldest message returned). "Show earlier
messages" asks again with that id as `before_message_id` and the next page is
added above; the poll keeps only the newest page current. Paging is ordered by
(`created_at`, `id`), so two messages written in the same instant are neither
repeated nor skipped, and a cursor from another conversation returns nothing.
The page size is unchanged: a longer history is reached by paging, never by a
larger window.
Once an earlier page has been read, every newest window a poll brings is kept
as well: the window moves on as messages arrive, and a message that slides
out of it sits after the earliest page's cursor, where no page returns it.
A window that shares nothing with the last one (a whole window arrived
unseen) restarts paging from the new window, so nothing between is
unreachable. Sending a failed message again from an earlier page takes the
retry's answer into the kept copy.

**Lock order.** Posting takes the conversation row before the poster's
participant row, the order leaving takes them in, so a post and a leave by the
same person wait for each other rather than deadlock.

## 3. The events

All events travel through the existing outbox, signed, and are checked at the
door against their exact key set.

**`agency.message.posted`, `agency.message.receipt`** — unchanged (doc 51).
The receiver now finds the conversation by its row, or recognises a new one
by the derivation from a live activation of this property on this connection.
Any other `conversation_id` is refused as `conversation_mismatch`.

**`agency.message.participant`** — new. Named under `agency.message.` so it
travels the message lane and inherits its hold, park and revocation rules
unchanged.

- dedupe key: `agency.participant:<conversation_id>:<participant_ref>:<version>`
- payload keys, exactly:
  - `schema_version` (1);
  - `conversation_id`;
  - `stock_item_id`;
  - `participant_ref` — a random uuid minted per (conversation, local user).
    It is never a user id, an email address or a phone number.
  - `display_name` (1–200 characters);
  - `side` (`command_centre` | `builder`) — always the SENDER's own side;
  - `state` (`joined` | `left`);
  - `version` — per participant, starting at 1 and rising by one on every
    change.
- no receipt.

The receiver keeps, for each `participant_ref`, the highest version it has
seen, and only that version's state and name. So a replay changes nothing and
events arriving out of order settle on the latest. It is refused, and stored
nowhere, if:

- `side` is not the sender's side;
- the property is not the connection's builder's;
- the conversation is neither a row here for this connection and property
  nor the derivation of a live activation of this property on this
  connection;
- any key, type or value is outside the contract.

A remote participant row can never be turned into access.

**`stock.selection.acknowledged`** — one new key:
`acknowledged_by_display_name`, the acknowledging builder user's display name.
It carries no id. An acknowledgement made before this step never carried it,
and is shown as "Acknowledged".

**`stock.item.upserted`** — the `organisation` object gains the builder
organisation's own public contact fields: `contact_email`, `contact_phone`
and `website`. They are read from `builder_organisations`, never from any
user, and are omitted when empty.

Nothing else crosses: no client, no note, no selection id, no internal user
id. The network privacy contract (`builderNetworkPrivacy.pure.ts`) still
screens every payload in both directions.

## 4. The acknowledgement on the Command Centre

The main sweep applies `stock.selection.acknowledged` exactly as before. Once
it has, and only if the acknowledgement matches a live activation of the
connection's own builder, one idempotent step
(`builder_network_after_acknowledgement`) runs:

1. records `acknowledged_by_display_name`;
2. creates the activation's conversation;
3. adds the activator as its Command Centre participant;
4. sends the activator's `agency.message.participant` (joined);
5. writes ONE notification for the activator (`builder_activation_acknowledged`,
   linking to Portals → Builder Portal). This is the bell item and the source
   of the Builder Portal badge.
6. queues ONE acknowledgement email on the existing `integration_outbox`
   (idempotency key `builder_activation_acknowledged:<selection id>`). The
   cross-portal worker sends it through the workspace's own email identity,
   retrying with the outbox's backoff.

Steps 5 and 6 happen only the first time. Their anchor is a row keyed by the
activation, so a replayed or reordered acknowledgement adds nothing. An email
that cannot be sent is retried, and after the outbox's limit dead-lettered.
It never touches the acknowledgement.

The notification and the email name the builder company, the property and the
acknowledging builder user. They carry no client data.

## 5. The conversations that already existed

Nothing in either migration guesses who a conversation belongs to. Existing
data is seeded by a separate production-rollout phase, `agency-chat-backfill`.
It is a dry run unless `apply` is true, and it reads both projects:

- A pair is seeded only where BOTH sides agree:
  - a Command Centre activation that is live and acknowledged, whose
    activating user is active;
  - a network announcement with the same reference on the same connection and
    property, acknowledged by a user who is still an active member of the
    builder organisation.

  Anything else is reported by id and left alone.
- The one existing conversation keeps its id and its three messages. It is
  bound to its activation and seeded with its activator and acknowledger.
- The other acknowledged activations get an empty conversation seeded the
  same way.
- No notification and no email is sent for an acknowledgement made before
  this step.

## 6. Where it is used

**Command Centre.**

- **Portals → Builder Portal**, with two tabs:
  - **Activated Properties:** one row per activation. It shows the builder's
    company contact fields, who activated it, who acknowledged it, and its
    status. It links to the property page, and to the conversation only for
    a participant.
  - **Messaging:** the conversations the viewer is in, with their
    participants, Add user and Leave chat.
- The property page's Messages card lists only the viewer's own activation
  conversations for that property.

**Builder Portal.** Agencies → Messages lists only the conversations the
viewer is in, with the same participant list, Add user and Leave chat.

## 7. Proof

- **Command Centre, in the database:** `src/lib/__tests__/builderStockPrivateConversations.spec.ts`
  runs the real migrations on a throwaway Postgres.
- **Command Centre, reads and projections:** `builderStockPrivateConversationsRead.spec.ts`.
- **Network:** aurixa-builders `scripts/db/agency-private-chat-check.mjs`
  checks the network half on the rebuilt schema.
- **Live, both doors:** `scripts/ops/stock-private-chat-proof.mjs`
  (production-rollout phase `stock-private-chat-proof`).

The requirement-to-test map is in the Command Centre PR.
