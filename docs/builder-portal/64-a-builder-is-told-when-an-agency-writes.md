# 64 — A builder is told when an agency writes, and messages arrive faster

The owner, 27 Sep 2026: messages should arrive faster, and the Builder Portal
needs the popup the Command Centre already has when a new message comes in.

Messaging is still polling. Nothing here is pushed or realtime, and nothing
should describe it that way.

## 1. Where the time went

Measured on 27 Sep 2026 from the gateway's own logs and the message rows, on
real traffic:

| Stage | Before |
| --- | --- |
| A Builder Portal request (send, read, poll) | 3–5.5 s; `builder-portal-stock` averaged 4.6 s |
| Database work inside that request | 14–25 ms |
| Builder → Command Centre, sent to landed | 1.3–1.5 s |
| Command Centre → Builder, sent to landed | 2.4–3.3 s |
| An open conversation noticing a new message | up to 10 s, then a ~4 s read |

**The portal ran on the wrong side of the world.** The browser calls
`/fn/<name>`, a Vercel function that calls the edge function. The edge
runtime executes a function in the region closest to its caller, and the
caller is that proxy. With no region declared, Vercel ran the proxy in `iad1`
(Washington), so every portal request executed in `us-east-1`
(`x_sb_edge_region` in `function_edge_logs`, called from Ashburn) against a
database in Sydney. Each of a request's ten or so round trips crossed the
Pacific.

`vercel.json` now declares `"regions": ["syd1"]`, beside the database in
`ap-southeast-2`. `fnProxyPolicy.spec.ts` ties the two together: it reads the
database region from this repository's README and fails if the proxy is not in
the Vercel region beside it.

## 2. The popup

"New message from <agency>" appears wherever the reader is in the portal, with
who wrote it and the lot, and an **Open** button to that conversation
(`/builder/messages?view=agencies&thread=<id>`). It is the builder-side
counterpart of the Command Centre's popup (its `list_new_builder_messages`).

- **The read.** `builder-portal-stock` `list_new_agency_messages` is read-only
  and sits behind the session and the `inventory` view gate like every stock
  operation. It returns the agency's messages that arrived after a cursor:
  - only in conversations the reader has joined, in the organisation the
    session acts for;
  - only the agency's side, never what this organisation wrote;
  - who wrote it, the agency, the lot, the address and when it landed, and
    never the body or a user id.
- **The cursor.** The cursor is this database's arrival clock (`created_at`).
  The first read answers only the cursor, so opening the portal replays
  nothing. A burst larger than 20 that landed in one sweep is named in part;
  the thread holds all of it.
- **The poll.** The popup checks every 5 s while the tab is in view, and at
  once when the tab comes back. It stops on 401, 403 or 409 (the tab now
  shows a different organisation from the session). Anything else is asked
  again next time, from the same cursor.
- **It is also the open thread's doorbell.** When a message arrives, the
  conversation it arrived in and the Messages list re-read themselves at
  once. A thread already on screen therefore shows it within one check,
  instead of on its own 10 s cadence. No popup is raised over the thread the
  reader is looking at.
- **The reader can turn it off.** Settings → Your preferences → "Tell me when
  a message is posted" (`notify_message_posted`, default on) now governs the
  popup. With it off, the thread still refreshes.
- **No sound.** The Command Centre's ping follows its own sound setting, and
  the portal has no such setting.

## 3. What was not changed

- The signed network, both doors, both workers and the minute schedules are
  unchanged. The Command Centre's own popup check is the same shape, and its
  thread refresh is the Command Centre's change.
- The two doors still execute in the region nearest their caller: the Builder
  door in Singapore when the Command Centre delivers, the Command Centre door
  in Sydney when the network delivers. Pinning each to its own database's
  region would take roughly 1 s more off Command Centre → Builder. It needs
  each side to know the other's region, which neither stores today.

## 4. Proof

- `src/lib/__tests__/fnProxyPolicy.spec.ts`: the proxy region.
- `src/lib/__tests__/builderAgencyMessagePopups.spec.ts`: the read (members
  only, this organisation only, the agency's side only, the cursor, no body or
  user id), the edge operation (session identity, writes nothing), the
  wording, and the link.
- `src/components/builder-portal/__tests__/agencyMessagePopups.spec.tsx`: the
  polling loop, driven with fake timers.
- Production-rollout phase `message-speed-proof`: the whole change on the
  live product, on disposable rows of its own. It times portal reads, each
  side's send, delivery both ways and the first read that names a message.
  It proves the new read's privacy rules and, in a real Chromium, the popup,
  Open, and an open thread refreshing. `baseline` measures what is live
  before a change. It also runs the cleanup audit's real-conversation check
  against its own disposable conversation, which must flag every message and
  participant in it (`scripts/ops/realConversationAudit.pure.mjs`).
- Production-rollout phase `step6-proof-audit` asks what the real
  conversations hold, never how much: any number of genuine messages, and no
  message or participant that carries a proof marker, that a proof identity
  wrote or is, or that has no living author on the side that records it.
- Production-rollout phase `cc-frontend-build`: which build the Command
  Centre's published frontend serves. Lovable reports a publish as started,
  never as served, and this sandbox's egress refuses both Command Centre
  origins, so a GitHub runner reads them. For each origin it reads
  `/version.json` and the entry script the page loads. Both must name the same
  build, because the manifest alone is a static file and says nothing about
  the JavaScript a browser runs. `cc_build` also requires that build to be
  that commit. An origin that will not answer a scripted client is reported
  as challenged by bot protection or as refused, and says by whom. That is
  never a wrong build, and nothing here tries to get past it. The rules are
  `scripts/ops/ccFrontendBuild.pure.mjs`, tested in
  `src/lib/__tests__/ccFrontendBuild.spec.ts`.

## 5. Measured after the change

Both columns come from the same instrument, `message-speed-proof`, run from a
GitHub runner in the United States through the live proxy. That runner's own
distance to the services is inside every figure. Each is the median of five,
on 27 Sep 2026.

| Measure | Before (run 36314425351) | After (run 36315572978) |
| --- | --- | --- |
| A portal read (`workspace_summary`) | 4.1 s | 0.8 s |
| Opening the Messages list | 6.8 s | 1.1 s |
| Opening a conversation | 5.6 s | 1.1 s |
| A builder sending a message | 3.1 s | 1.0 s |
| Builder → Command Centre, written to landed | 1.30 s | 1.37 s |
| Command Centre → Builder, written to landed | 2.97 s | 2.35 s |
| Command Centre message, written to first read by the portal | 11.0 s (conversation read) | 4.2 s (new-message read) |
| "New message from <agency>" on the builder's screen | — | 4.9 s |
| The next message shown in an open thread | — | 6.5 s |

The gateway's own logs agree, and they do not include the runner's distance.
From 11:15 UTC every `builder-portal-*` request was called from Sydney and
executed in `ap-southeast-2`. Before, every one was called from Ashburn and
executed in `us-east-1`.

| Function | Median execution before | Median execution after |
| --- | --- | --- |
| `builder-portal-stock` | 5.1 s | 0.9 s |
| `builder-portal-workspace` | 4.0 s | 0.5 s |
| `builder-portal-verify` | 4.0 s | 0.5 s |
| `builder-portal-login` | 1.4 s | 0.3 s |

Database-to-database delivery did not change, and was not meant to: it runs
through the two doors and workers §3 leaves alone.
