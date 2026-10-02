# 70 — A list says it is arriving, and each property is sent once

**1 October 2026.** A builder deleted their 41-property stock list and uploaded
a 44-property one 26 seconds later. Measured in production:

| Step | Time after the upload |
|---|---|
| File read, 44 properties created | 13 s |
| Photos ready, 43 of 44 | ~2 min 45 s |
| Last photo ready; list goes live in one cutover | 4 min 11 s |
| Last property reaches the Command Centre | 8 min+ (149 events still queued at 8 min) |

## The empty page

Deleting a list archives its properties at once, and a new list is held off
the marketplace until its photographs are ready. The progress banner was keyed
on rows already live (`countWorkingImages` over the list) or a file still being
read. Neither held between 13 s and 4 min 11 s, so the page showed an empty
list headed "Nothing is on the marketplace yet".

`src/lib/builderStockArrival.pure.ts` reads the upload's own counts
(`builder_stock_image_progress`: `total`, `photos_ready`, `working`,
`pending_assets`, `published`). While an unpublished upload still has work in
progress, the page shows "Preparing your stock list — N of M photos ready", a
progress bar, and placeholder plates where the empty message was. A held list
with nothing in progress is not "arriving": its blockers already say what holds
it. A property still being worked on is no longer listed under "waiting to go
live" with an "Add picture" button.

## The slow Command Centre

That upload put **308** `stock.item.upserted` events on the outbox, about seven
per property. Every image-row change re-enqueues the item, and every enqueue
carries the item's whole current state. The worker sent 25 a minute, one at a
time.

- **Sent once** (`20261001150000`). Enqueueing an item marks that connection's
  older waiting events for the same item `superseded`. The Command Centre keeps
  the higher `source_version`, so a waiting older copy could only ever be
  overwritten. A claimed event (possibly on the wire) is left alone. Only
  `stock.item.upserted` is ever superseded.
- **Sent in waves** (`builderNetworkDeliveryWaves.pure.ts`). Different
  properties go out 8 at a time. Any other event (reconciliation, selection,
  message) is a barrier and goes alone, in queue order. The worker claims again
  while there is work, inside a 35 s budget.

## Measured after the deploy

On 1 October 2026 at 18:34:40 UTC, after the deploy, the 44 live properties
were each queued twice in one transaction: 88 events. Read back from both
databases on 2 October (`stock-delivery-audit`, `stock-mirror-parity`):

| | |
|---|---|
| Events queued | 88 |
| Superseded before sending (never claimed, never received) | 44 |
| Delivered | 44, one per property, each property's newest |
| First arrival at the Command Centre | 23.6 s (19.5 s of it waiting for the minute's worker run) |
| Last arrival and last applied | 84.9 s |
| Arrivals | waves of 8, 8, 8, 6 in the first run; 8, 6 in the next |
| Retried | 14, once each; none had reached the Command Centre on the first try |
| Mirror | 44 of 44 live at the newest delivered version, 20 fields, photograph and hero plan identical |

The 14 retries were the tail of the first run. The Command Centre's runtime
log shows a fresh isolate for each arrival (8, 8, 8, 6) and none for the last
14 sends. Their error text is not recoverable, because a later success clears
`last_error`. The next minute's run delivered them.

A test can only guard what it reads. The guard used to check the word
`superseded` in the newest definition of the enqueue, so a later migration
that also superseded a claimed event, or another connection's, would pass. It
now checks the predicate in whichever migration defines the enqueue last.

## Not changed

The single cutover: a list still goes live when its photographs are ready, not
property by property. Deleting a list still takes it off the marketplace at
once. Re-reading a linked list (doc 49) keeps the live list up until the new one
is ready, and remains the better path than delete-then-upload.
