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
