# 61 · An agency and a builder talk about an activated property

Command Centre users and a property's builder exchange messages about a property the Command Centre has activated. The messages travel over the signed Builders Network: no email, no separate API, no model.

The same contract is implemented twice:

- **Command Centre:** `npc-property-dashbord` `20261221120000_an_agency_and_a_builder_talk_over_the_network.sql`, documented there as `docs/builder-portal/51-…`.
- **aurixa-builders (this repository):** `20260925180000_an_agency_and_a_builder_talk_over_the_network.sql`.

## 1. The conversation

**Key.** There is one conversation per (connection, property). Its id is derived, not stored in either system first:

```
md5('agency.conversation:' || <network connection id> || ':' || <stock item id>)::uuid
```

- Both ends compute the same id, so repeated "start" attempts converge.
- A payload naming any other id for that pair is refused as `conversation_mismatch`, so a message cannot be moved into another thread by changing an id.

**When it is open.** It is open while the property is activated:
- on the Command Centre: a live `builder_stock_selections` row;
- on the network: a live announcement on that connection.

When the activation is withdrawn, the history stays readable and nothing new can be written.

**Owner.** The Command Centre user whose activation opened it owns it (`owner_user_id`). Anyone with Listings edit access writes into it as themselves. On the network side, anyone in the builder's organisation with `inventory` edit writes as themselves. Every message carries its writer's display name.

## 2. The events

Both event types are sent through the existing outbox, signed, with the existing dedupe keys.

**`agency.message.posted`**
- dedupe key: `agency.message:<message id>:<generation>`
- payload keys, exactly: `schema_version` (1), `conversation_id`, `message_id`, `stock_item_id`, `body` (1–4,000 characters), `sender_display_name`, `sent_at` (the writing side's server clock), `generation`.
- It carries no user id, no client, no note and no email.

**`agency.message.receipt`**
- dedupe key: `agency.receipt:<message id>:<generation>`
- payload: `schema_version`, `message_id`, `conversation_id`, `generation`, `outcome` (`accepted` | `refused`), and `reason` when refused.

## 3. Delivery states

| State | Means |
| --- | --- |
| `queued` | Written here, not yet accepted by the other side. The door's 200 alone does not change this. |
| `delivered` | The other side's sweep applied the message and sent back an accepted receipt for this generation. |
| `failed` | Refused (with the other side's reason), the outbox row dead-lettered (`not_delivered`), or the current generation reached the other side and no receipt came back within 15 minutes (`confirmation_timeout`, shown as "Not confirmed" — never as a refusal, because the other side may hold it). |

**Retries.** A failed message stays visible. Only its writer can retry it, and only while the conversation is open. A retry re-sends it under generation + 1. The receiver answers every generation but stores the message once: rows are keyed by the sender's message id. So a message that WAS accepted, whose receipt was lost on the way back, is confirmed by the next generation's receipt. A late receipt for an older generation changes nothing.

**The confirmation window.** Without it, a lost receipt would leave a message Sending for ever: its outbox row is already delivered, and only a failed message may be retried. The message sweep's own minute schedule fails any message whose current generation has been delivered for more than 15 minutes without a receipt. It reads only the message and its outbox row; there is no second transport.

**Idempotency.** A repeat of the same send reuses the same browser `client_message_id`, which is unique per sender. So a lost response or an ambiguous timeout never creates a second message. The key is bound to the text: the same key with different text is refused (`AGENCY_MESSAGE_ID_REUSED`), and the composer mints a new key whenever the text changes. A repeat is answered before anything about the relationship is checked: it writes nothing, so a connection that closed or paused after the first send cannot make the sender read a message it already made as "not sent".

## 4. Its own lane

Both main inbound sweeps refuse an event type they do not handle, and the refusal is terminal. So message events are routed into their own lane:

- A `BEFORE INSERT` trigger stamps message events `processed_at` when they land, so the main sweep never sees them.
- The message sweep (`builder_network_apply_message_events` here, `builder_agency_apply_message_events` on the network) keeps its own stamp (`message_applied_at`).
- It runs each minute, and the network door also runs it once when an envelope lands.
- The main, media and rank sweeps are unchanged.

**Failure handling.** One message that cannot be applied is retried on later sweeps. After five attempts it is dead-lettered with a critical operational event. It never blocks the messages after it: each claim takes its own row with `SKIP LOCKED`, and each row runs in its own exception block.

**Ordering.** Both ends sort by `(sent_at, id)`, using the writing side's server clock with the id as tie-breaker. Messages that arrive out of order settle into the order they were written.

## 5. What is re-checked when a message is applied

Every check below is made under a share lock on the rows it reads (the connection and the live activations), held until the message is written. So a revocation, dispute or withdrawal that lands at the same moment either commits first and is seen, or waits for the message. The same holds when a message is sent or retried.


A signed payload is not authority. When a message event is applied, all of these are checked against the rows:

- the connection is active (for new content; a receipt that landed before a revocation still settles the message it answers, since it carries no content);
- the property belongs to the connection's builder;
- the conversation id equals the derivation for this connection and property;
- the activation is live;
- a message id already stored belongs to the same conversation and side.

Wrong builder, wrong workspace (connection), wrong property and a malformed message are each refused, stored nowhere, and answered with a refused receipt.

## 6. Reading and writing

**Command Centre.** The card is on the property page (`BuilderStockConversation`) and uses `builder-stock-marketplace`:

- `get_builder_conversation`: Listings view.
- `send_builder_message`: Listings edit.
- `retry_builder_message`: Listings edit, and only the writer.

**Builder Portal.** The Agencies → Messages tab uses `builder-portal-stock`:

- `get_agency_conversation`: `inventory` view.
- `send_agency_message`: `inventory` edit.
- `retry_agency_message`: `inventory` edit.

On both sides the sender is the session's user, and the request names no user or organisation. The thread re-reads itself every 10 seconds while the page is visible. Polling is the whole transport, and nothing depends on realtime.

## 7. Proof

| Where | What |
| --- | --- |
| `scripts/db/agency-messaging-check.mjs` (CI baseline job) | The network's half on a schema rebuilt from every migration. Covers: posting, idempotency, colleagues, refusals across organisations, connections and properties, the lane, receipts, dead-letter and retry, poison isolation, ordering, the unchanged main sweep, and grants. |
| `src/lib/__tests__/builderAgencyMessages.spec.ts` | The read (organisation-pinned, activation-backed), the projection (no user id or client key), the refusal map, and the edge permissions. |
| `src/pages/builder/__tests__/builderAgencies.spec.tsx` | The Messages tab: senders, delivery states, retry, one idempotency key, and the closed state. |
| `scripts/ops/stock-messaging-proof.mjs` (phase `stock-messaging-proof`) | End to end across both live doors. |
| npc-property-dashbord `src/lib/__tests__/builderStockAgencyMessaging*.spec.ts` | The Command Centre's half. |
