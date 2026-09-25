# 58 · A project shows the property it was opened for

## 1. What was wrong

An activation opens a project (`builder_stock_activation_fanout`). On the Projects page:

- the list was a table of names and dates, with no picture and no figures;
- the detail page listed the property's figures, but drew no picture, although `get_project` already returned `primary_image_id` and the Stock List a click away drew the photograph;
- the Parties tab was read-only, although `upsert_party` and `delete_party` have always existed on the server.

## 2. What now happens

**The property is read the way the Stock List reads it.** `readPropertyViews` (`_shared/builderStock/propertyView.ts`) reads the property with:

- `STOCK_ITEM_SELECT`;
- the builder's own figures and place laid over the extraction, by the same call `decorateItems` makes, in the same order;
- the images, from `STOCK_IMAGE_SELECT`, in position order;
- which figures the brochure supplied, from `figuresSuppliedByDocument`.

The browser chooses the picture with `primaryStockImage` and draws it with `StockPicture`. That is one rule and one treatment, so a project never shows a different picture from the Stock List.

**Which property a project is.** `projectStockItemIds` decides:

1. the property the activation named, if there is one;
2. otherwise, the property whose own row names the project (`builder_stock_items.builder_project_id`), preferring the one updated last;
3. otherwise, none. The page never guesses.

Every read is pinned to the session's organisation. A project reachable through a developer-side grant therefore never shows another organisation's property.

**The photograph is served to the project.** `builder-portal-projects` has an `image_url` operation, gated on project access. The Stock List's `inventory` permission is not what opens a project, and the photograph belongs to the project it is shown on.

Before signing, the operation checks that the image belongs to this project's property, in this organisation. An image id that belongs to anything else gets the same answer as one that does not exist.

**The documents the property's row links to** are listed as links (`propertyDocumentLinks`):

- They are read by the pipeline's own `rowSourceBranchCandidates`, over `unmappedWithRecoveredLinks`.
- Each is named by the column the builder filed it under, and classed as brochure, floor plan, site plan, estate or other from that heading.
- Only http(s) links are listed, at most twelve.

**The list** draws each project's photograph and headline figures: price, layout, home size and land size.

**Parties can be added, edited and removed** (`ProjectPartiesPanel`):

- `projects.edit` may add and edit; `projects.delete` may remove, after a confirmation that names the party.
- A party is a contact record only. The dialog says so, the request carries no access field (a spec asserts this), and `builder-portal-projects` never writes `builder_project_access`.
- Who can open a project is still decided only by project access grants.

## 3. One read that #113 got wrong

`decorateItems` passed `item.document_figures` to `figuresSuppliedByDocument`, but `STOCK_ITEM_SELECT` never selected that column. So "Read from the brochure" could not appear on any Stock List card.

The column is now read in the query `decorateItems` already makes for `source_row`, not added to `STOCK_ITEM_SELECT`, which is a disclosure boundary. The project page reads it the same way.

## 4. What a gallery would need

Measured on production on 25 Sep 2026 (`stock-field-coverage`, gallery census): 69 live properties hold exactly one builder image and one holds two. Every one of those images has the `primary_property` role.

The pipeline keeps a property's listing photograph and nothing else. A project therefore shows one photograph, the same one the Stock List shows. More pictures per property (interiors, floor plans) would need the image pipeline to keep them, which is a separate change.

## 5. Proof

- `builderProjectProperty.spec.ts` covers:
  - document naming, recovered links and bounds;
  - which property a project is;
  - the overlay order and the organisation pin;
  - the image operation's gate and its ownership check;
  - that no access grant is written;
  - the #113 read.
- `projectParties.spec.tsx` covers who may add, edit and remove, the no-access statement, the payload, name required, and remove-after-confirm.
- `scripts/ops/stock-project-proof.mjs` (phase `stock-project-proof`) proves all of this on the live product. The activation is delivered through the live network door over a proof-only workspace connection. It also checks that another organisation can reach neither the project nor its photograph.
