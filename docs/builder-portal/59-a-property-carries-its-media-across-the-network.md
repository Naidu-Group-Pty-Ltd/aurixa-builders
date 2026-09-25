# 59 · A property carries its photographs and documents across the network

## 1. What changed

The `stock.item.upserted` payload now carries a versioned `media` block beside `primary_image`, which is unchanged:

```
media: {
  schema_version: 1,
  photos:    [{ id, position, content_type }],   // 0..12, display order
  documents: [{ id, kind, label, url }]          // 0..12, typed links
}
```

A connected workspace converges that block in a sweep of its own. See the Command Centre's `docs/builder-portal/50-a-builder-property-has-a-page.md`.

## 2. What did not change

This change leaves the image pipeline alone: extraction, election, retention, OCR and brochure parsing are all untouched.

`builder_network_stock_item_gallery` is the item's primary image, under exactly the rule the composer has always applied (`uploaded_document`, `source_supplied`, `ready`), or nothing. So today a property sends the one photograph its card already shows. The array can hold twelve, but what goes in it is the pipeline's decision.

## 3. One rule for a document link, in two languages

The Builder Portal's project page lists a property's documents with `propertyDocumentLinks` (TypeScript). The outbox is composed by triggers, in SQL. `builder_network_property_documents` is that function's port.

`scripts/db/media-contract-check.ts` puts the same fixtures to both on every build and fails on any difference. It runs in CI's baseline job, against a database rebuilt from the baseline and every follow-on migration.

A document's id is the md5 of its URL. That keeps it stable across replays, so the receiving workspace updates the documents it already holds instead of adding copies.

Two small, recorded differences from JavaScript:

- Only string cells are read. `unmapped` is typed as strings.
- `\s` is PostgreSQL's class, not JavaScript's Unicode one.

## 4. The sync trigger

The trigger compared `source_row->>'house_design'` and no link. So a builder who corrected a brochure link sent nothing.

It now compares the documents the row yields, not the raw row, because every re-read of the source rewrites the raw row.

## 5. The image door

`builder-network-stock-image` served only an item's current primary. It now also serves a current member of the item's published gallery, read from the same function.

Today the gallery is the primary, so what the door serves does not change. The check exists so the two rules cannot drift apart.

## 6. Rollout

The migration ends with `builder_network_backfill_stock_sync(NULL)`, the operator's existing backfill. Every connected workspace therefore hears each live property once more, now with its media.

This is idempotent at the receiver. A workspace that has not yet applied its converger keeps those events until it does, because its migration settles only the events that carry no `media`.
