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

## Not changed

The single cutover: a list still goes live when its photographs are ready, not
property by property. Deleting a list still takes it off the marketplace at
once. Re-reading a linked list (doc 49) keeps the live list up until the new one
is ready, and remains the better path than delete-then-upload.
