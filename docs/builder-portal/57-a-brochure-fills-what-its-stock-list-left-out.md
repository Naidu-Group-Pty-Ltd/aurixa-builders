# 57 · A property's own brochure fills what its stock list left out

## 1. What was measured

On 25 September 2026 the owner reported that many properties had no car spaces and no build size. The read-only production phase `stock-field-coverage` found:

- The one live stock list is a Google Sheet of 70 properties with **no floor-area column at all**. 69 of the 70 held no building size.
- The same sheet leaves the car count blank on its **20 dual-key rows** (Nex 20, Vanta 20 and Vanta 23).
- Every one of those rows links its own brochure. The image ladder already opens that brochure and takes the property's photograph from it.

The phase `stock-brochure-figures` then ran the product's own deterministic reader over each property's brochure:

- **43 of 69** state a floor area in their text.
- The area-schedule OCR that already serves an uploaded PDF reads **8 more** from a picture of the schedule.

Nothing carried a single one of these figures onto the row.

The dual-key brochures print no car count, as text or as picture. A car count for those rows can only come from the builder, through *Complete the schedule*.

## 2. What now happens

A dedicated reader, separate from the image ladder, handles this. Nothing about which picture a card draws moves.

1. **What is owed** (`builder_stock_document_figures_owed`): a live property missing any of the five figures a card draws, whose provenance holds a link that delivered its photograph. That is the one document the election has already held to this property's identity. The property must not already have been read at this version under that link.
2. **The parse** runs on the PDF worker, as protocol 4 with `purpose: 'figures'` (`brochureFigures.ts`). It returns:
   - the deterministic reading;
   - whether the document presents this property's design;
   - which pictures could print the area schedule. These are chosen there and never decoded there.
3. **The OCR** runs in the reader's own isolate, which parsed nothing. It uses the same `readFigures` path as an upload, and only where the text gave no floor area.
4. **The decision** (`brochureFigures.pure.ts`) is covered in §3.
5. **The record** (`record_builder_stock_document_figures`) keeps what the document stated in `document_figures`. It fills a figure column only if that column is still empty, in the same statement. A column this document filled before may take a new reading of it. A column the stock list wrote is never touched.

A self-unscheduling minute tick dispatches `builder-stock-figure-reader` while anything is owed or image work is outstanding. The tick is armed whenever a property's image work settles.

## 3. The rules

- **A lot's figures come from this lot; a design's figures from this design.** A brochure is often typeset for one specimen lot and linked from every lot selling the design. Measured: Lot 1728 · Nex 20 shows Lot 1629's brochure.
  - Bedrooms, bathrooms, car spaces and the floor area belong to the **design**. They may come from a brochure that presents this design.
  - The land size belongs to the **lot**. It comes only from a brochure that states this lot.
- **A confirmed lot needs this design.** A lot the builder confirmed in *Use brochure image* counts as this lot only where the document presents this property's design. Measured: Lot 1447 · Nex 20 shows Lot 1744 · Cura 20B's photograph, and must not take its figures.
- **One property, or nothing.** The reading must be `complete` with exactly one row.
- **The stock list outranks its brochure, and the builder outranks both.** `manual_stats` overlays everything on read.
- **A re-read of a silent stock list keeps the brochure's figure.** `writablePatch` falls back to `document_figures.values` where it would otherwise unsay a column. Without this, every *Read again* of a sheet with no floor-area column would blank every floor area the brochures supplied.
- **A read that learned nothing is `retry`**, with backoff. It is never a statement about the document.

## 4. One reader improvement, proved by arithmetic

The `VG18` brochures print their *House Specifications* block in two ways:

- as a run of labels and, elsewhere on the page, a run of values;
- or inline (`Ground Floor: 132.75m2`).

Either way, the positioned reader does not reach the values.

`readAreaScheduleTotalFromLines` pairs a label run with a value run only where all of these hold:

- both runs have the same length;
- the labels are a dwelling's parts closing on `Total`;
- every part adds to the total within the rounding two printed decimals allow. This is far stricter than the 25% the positioned reader tolerates, because nothing places a value beside its label.

It is asked only where the positioned schedule found nothing. Over the 68 real brochures it changed exactly the three VG18 readings (172.84 m² each) and nothing else.

## 5. What is left, and why

These are named rather than guessed:

- **Elara 18 (9 properties).** The area schedule is a 231×211 picture. Recognition drops every decimal point, including the squares column's, and reads `sq` as `s`. The picture proof refuses it, which is right: a misread digit is a figure the builder never printed.
- **Vanta 20 / Vanta 23 (3).** The reading is `ambiguous` (conflicting lot numbers), so it is one property or nothing.
- **Two readings that stood down (`incomplete`)**, and the dual-key car counts, which no brochure states.

All of these remain open to the builder through *Complete the schedule*. The card now says which figures were *Read from the brochure*.

## 6. Proof

- Held-out fixture `heldout-a-sheet-with-no-floor-area-whose-brochures-state-it`, entered before the code:
  - filled from its own brochure;
  - filled with the car count too;
  - the sheet's figure stands;
  - another lot of the same design gives its design figures and no land size;
  - all of it survives a re-read.
- `builderStockBrochureFigures.spec.ts` pins the standing rules, the bounds, the picture fill, the fallback, the wire, the SQL's fill-only-empty rule, and the new text pairing.
- The worker canary asks the built bundle a figures question and checks that an election protocol cannot carry one.
