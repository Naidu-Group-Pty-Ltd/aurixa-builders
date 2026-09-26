# 63 — Messaging has one home

The owner, 26 Sep 2026: the conversations with agencies belong on the portal's
Messages page, not as a tab of the page that lists activations; that page keeps
the activated properties only, under a name that says what it is.

## What changed

- **Agency Activations** (`/builder/activations`, nav label *Agency
  Activations*, still offered only under `inventory` view) lists what connected
  agencies activated from the stock list, and nothing else. It was *Agencies*,
  with two tabs.
- **Messages** (`/builder/messages`) has two tabs, bookmarkable through
  `?view=`: *Agency conversations* (the private conversation each acknowledged
  activation opens, docs 62) and *Project conversations* (the portal's existing
  conversations, unchanged).
- The conversation UI moved, unchanged, into
  `src/components/builder-portal/AgencyConversations.tsx`. The server, the
  participant model and every read and write are untouched.

## Rules

- **No address breaks.** `/builder/agencies` and `/builder/agencies/activations`
  redirect to Agency Activations; `/builder/agencies/messages?thread=…` redirects
  to Messages' agency tab with the same conversation open
  (`legacyAgenciesTarget`).
- **A link that names a project conversation opens the project tab.** Every link
  to Messages written before the move (`?project=`, `?scope=`, `?scopeId=`,
  `?conversation=`) meant the project conversations, so `messagesViewFrom` sends
  those there; an explicit `?view=` wins; anything else opens the agency
  conversations. The project tab pins `view=projects` when it edits the URL, so
  clearing the project picker never flips the page.
- **Each page refreshes its own read.** Agency Activations' Refresh re-reads the
  activations; Messages' Refresh (agency tab) re-reads the conversation list.

## Why the conversations did not load (26 Sep 2026)

The owner's screenshots showed a conversation stuck on "Loading…" and then
"could not be loaded". The server and the data were correct: both conversations
belong to the organisation, their connection and property agree, and the reader
is an active owner and a joined participant. What was wrong was **the tab**.

- The gateway logged every failing request at exactly **215 bytes**, which is
  the Step 5 client's `get_agency_conversation` (a `connection_id` and a
  `stock_item_id`). The Step 6 server reads a `conversation_id`, so it answered
  "not found".
- In the same windows the function never queried the conversation tables. The
  site itself already served the Step 6 build, whose chunks carry
  `list_my_agency_conversations` and `conversation_id`.

So the tab had been open since before the release and was still running the
Step 5 JavaScript. A reload is the whole remedy. **A single-page app never
notices a release by itself**, so the portal now does: `useNewerBuildAvailable`
compares the entry script this page loaded with the one `/` serves (the file
name carries the content hash) on focus and every five minutes, and
`NewerBuildBanner` offers a reload. It never reloads by itself, because a
half-written message would be lost, and an unreadable check says nothing.
