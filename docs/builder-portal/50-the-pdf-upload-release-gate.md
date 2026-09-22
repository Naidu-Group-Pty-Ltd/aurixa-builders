# The PDF-upload release gate

What a builder's PDF now has to survive before this product claims to read
it, and what it found on the way.

> **The short version.** A gate that runs the portal's own import over real
> PDF bytes with generative-model assistance *blocked* rather than merely
> unconfigured. First run: **nine of sixteen documents produced no property
> at all.** After the eight defects below: **sixteen documents, 0 failures,
> 3 named limits, 0 generative-model calls attempted.**

## 1 · The architectural causes

**The deterministic reader stood down on shapes it should have read, and a
model caught it.** Every refusal in `pdfDeterministicRows.pure.ts` was
written under one stated asymmetry: *"a false incidental loses a field for
good, and a false unaccounted costs one model call."* That trade was sound
while a model stood behind the reader. It no longer exists, so an
unaccounted line now costs the whole document — and the reader had never
been measured under those conditions, because nothing had ever run it
under them.

**A vendor's billing state was being reported as a fact about a builder's
file.** `Lot 37 - Miami 190 - Property Package.pdf` recorded
`assisted_reader_refused`, detail `openrouter/openai/gpt-5.6-luna: refused
402` — an account with no credit — over a document whose text extracts
cleanly at 3,962 characters.

**Evidence was discarded exactly where it was needed.** The zero-row
failure path carried no `detail` at all, and an `ambiguous` refusal named
the field that conflicted without the two values that conflicted. Both were
survivable while a model stood behind them; with the model gone they are
the outcome, and an outcome nobody can diagnose can only be investigated by
asking the builder to send the file again.

**A schedule's rows all share one anchor.** `pdf:page1` is every
brochure's anchor and every row's anchor on a one-page stock list, so a
re-read could correct the first row of a list and forked the rest.

## 2 · The shared direct/URL document path

There is **one** document pipeline and both transports already reached it.
`process_upload` downloads the stored object and calls
`runStockImport({ bytes, sourceKind: 'file' })`; the URL route fetches the
bytes and calls `runStockImport({ bytes, sourceKind: 'url', baseUrl })`.
`sourceKind` reaches exactly two things — the wording of a "nothing
readable" message (`'page'` vs `'file'`) and the telemetry line — and is
never passed to `extractStockFile`. There was no second, weaker parser for
uploaded bytes, and none was introduced.

The transport differences that remain are provenance only: a URL source
supplies a classification taken from the response as well as the bytes, and
a `baseUrl` so a relatively-linked image resolves against the page that
published it.

## 3 · Identical bytes, both routes

Each document is imported twice: once through storage (upload row → object
→ `download()` → `runStockImport`), once through HTTP (fetch →
`runStockImport`), into **equivalent but separate organisations** — because
the duplicate guard is keyed on (organisation, sha256) and relaxing it to
make the comparison possible would have been testing a product we do not
ship.

**All sixteen agree** on `ok`, on property count, and field-for-field
across lot, unit, address, suburb, state, postcode, beds, baths, cars, land
size, build size, price, development, project and design.

| | route A (upload) | route B (URL) |
|---|---|---|
| total, 16 documents | 5,515 ms | 5,463 ms |
| bytes handed to the pipeline | identical, asserted per document | identical |
| HTTP fetches | 0 | 16 |

The two are within 1%, and the URL route is the one that also paid for a
fetch — the document work dominates, which is what "the transport only
obtains the bytes" looks like when measured. **No claim is made that either
route is faster.**

## 4 · The gate itself

`scripts/stock-acceptance/` — see its README for how to run it.

| layer | what runs |
|---|---|
| database | PostgreSQL 16 built by **this repository's own migrations** |
| API | **real PostgREST 12.2.3**, the version Supabase runs |
| client / PDF / runtime | **real** supabase-js, **real** unpdf 0.12.1, **real** Deno |
| pipeline | the shared modules unmodified, entered at `runStockImport` |
| storage | a local object store |

Only the object store is stubbed, and it is the one layer where a stub
cannot be subtly wrong: a blob store has no query language to disagree
about. Emulating PostgREST is how the AML `.or()` defect and the
builder-stock ranking fallback's error code both passed their own tests
while only the server disagreed.

**Models are blocked, not unconfigured.** The harness replaces
`globalThis.fetch` and *throws* on any request to a generative-model host,
counts it, and fails the run on a non-zero count. "No key was set" would
prove a call did not complete; this proves none was attempted.

Every document is additionally put through **repeat processing**, a
**re-read of its own row**, and an **organisation-ownership check** on
every property it produced.

## 5 · The eight defects

1. **A composed address line could not be read.** `readStreetLine` needs
   the street and locality on two lines directly above one another — the
   shape of the two flyers it was measured on. Seven of the nine failing
   documents failed on one line each, e.g. `Lot 9 Perrin Street, Armstrong
   Creek VIC 3217`. `readComposedAddressLine` reuses the module's own
   `STREET_TYPE`, `AU_STATE` and `readLocalityLine`, joins the same
   `addressBlocks` list so the one-block-per-document guard counts both
   shapes, and takes the lot off the front only where the document has not
   already said which lot it is. A labelled `Head Office:` address is
   positively recognised and is never a candidate.
2. **A phantom property from a disclaimer.** A three-property schedule
   imported four, the fourth a property whose lot number was `All prices
   correct at time of publication. E&OE.` The first attempt failed because
   `normaliseStockRow` caps a lot number at 39 characters, cutting off the
   `E&OE.` that identifies it: **a coerced field is not evidence about the
   document; the cell is.**
3. **A marketing slogan as a design name.** `SALE NOW ON` drawn on the
   page and repeated in the filename — two independent sources genuinely
   agreeing, about an *offer*. Asked of the candidate now, not the
   evidence.
4. **A site plan's neighbours became a contradiction.** `Lot 303 Lot 304
   Lot 306 Lot 307` above *"Adjoining allotments are not offered for sale
   in this package."* Nothing geometric separates that from a real
   two-property page — what separates them is that one of the two says so,
   so designations are suppressed only where the page carries an explicit
   exclusion statement **and** names more than one.
5. **`Build 214m2` and `Package $845,000` were unread.** `build m2` and
   `package $` were always in the vocabulary; a brochure attaches the
   marker to the *value* while a spreadsheet puts it in the heading. A bare
   label is retried once with the marker its value carries, so nothing new
   is admitted and `Package 3` stays unread.
6. **`Site Area` was not a land size** while `Build Area` was — the same
   half-a-list the alias set's own comment already describes.
7. **The icon row was read only on a band carrying nothing else**, so a
   price or a size sharing that band cost a property its bedrooms,
   bathrooms and car spaces.
8. **A re-read of a stock list forked it** — three properties became five.
   `byOwnLot` keys this upload's own rows by their lot designation, scoped
   to the upload because two lists may each carry a Lot 12.

Two more, in the sweep rather than the reader: **a verdict is finished and
a fault is not** (Lot 37 was being re-read on every tick, 1.9 MB each time,
for ever), and **an error that was ours is superseded by the answer the
document now gets** (the row still said the model refused it, three
model-free re-reads later).

## 5a · Lot 37, and what its row finally said

The one live upload in this deployment — every other one has been deleted
by the builder — and the document this incident is about. It was reported
first as an unreadable brochure, then as a model account with no credit.

Once the model left the path and refusals began carrying their own
evidence, the sweep re-read it from its stored bytes, with no upload and no
"Read again", and the row said:

```
conflicting_values:development_name
development_name = ·
development_name = PROPLAUNCH
```

**The document does not name two estates. One of the two is a bullet
glyph.** A middle dot was claimed as a development name, the platform's own
branding as another, the two disagreed, and a material conflict stood down
a brochure that states its lot, its design and its land size perfectly.

A value carrying no letter and no digit anywhere is now refused as a value
— alphanumeric rather than alphabetic, because `lot_number` is legitimately
`12` and `postcode` is legitimately `3338`.

**And with the glyph gone, the real pair was finally visible** — which took
one more deploy, because the row's recorded reason was only rewritten where
the previous reason had been *ours*, so a stamp saying version 4 sat beside
a diagnosis produced by version 3. The recorded reason is now always the
current reader's answer; a source is read once per reader version, so
"churn" was never the risk.

```
development_name = PROPLAUNCH
development_name = M A S T E R P L A N
```

A marketing platform's brand mark, and a page heading a designer tracked
out. **The document names no estate.** Two rules follow, and both are
general:

- **Letter-spaced type is not a value.** Text extraction returns what the
  page draws, which for tracked-out type is one glyph run per letter. Four
  single letters at least and all of them, so `U 3` and `Lot 37` are
  untouched; refused rather than rejoined, because joining invents a word
  the document never set as one.
- **`development_name` is no longer material.** The list answers one
  question — can this evidence mean the wrong property or the wrong deal? An
  estate is a place *containing* many properties; the lot identifies one and
  still refuses. So the estate is dropped rather than chosen between, and
  reads as not stated, which is what the document says.

Three tests asserting *"two estates refuses the whole document"* were
renegotiated with their reasoning rather than adjusted, and two were added.

The row moved on its own across three deploys, which is the evidence that
the sweep is doing the work rather than a person:

| | before | after |
|---|---|---|
| `status` | `imported` | `complete` |
| `error_code` | `assisted_reader_refused` | `no_properties_found` |
| detail | `openrouter/…: refused 402` | the reader's own evidence |
| `reader_settled_version` | 2, re-read every tick for ever | 3, settled |

## 6 · Supported classes, and the limits

| class | outcome |
|---|---|
| package brochure (marketing page + siting plan) | 1 property, 10 fields |
| single-property flyer with an area schedule | 1 property, 12 fields |
| table stock list | 3 properties, 9 fields each |
| site plan naming adjoining lots | 1 property, 11 fields; neighbours excluded |
| mixed scan + text layer | 1 property, 12 fields |
| floor plan with room dimensions (held out) | 1 property, 12 fields |
| builder's office address on the page (held out) | 1 property, 7 fields; office address never the property's |
| money written without a currency symbol (held out) | 1 property, 7 fields; the two ambiguous figures read as not stated |
| promotional overlay | 1 property; the slogan is never a name |
| legitimate fine print | 1 property; the render is not blocked |
| missing optional fields | 1 property, 6 fields |
| two organisations, same filename and lot number | 1 property each, correctly owned |
| scanned, no text layer | honest `pdf_no_text_layer` |
| encrypted | honest `pdf_text_extraction_failed` |

**Named limits** — printed on every run, never failing the gate, because
each ends in a refusal or an absent field and never a wrong value:

- **A page setting two properties in columns** refuses. Brochure mode reads
  one property; reading this needs column reconstruction on a page that is
  not a table.
- **A bare design heading** on a document naming no estate whose filename
  names no design is declined rather than guessed (`ASPEN 18` could equally
  be an estate or the builder).

## 7 · Not covered by this gate

Stated rather than implied.

- **Images.** This gate measures the document's data. Image election,
  settlement and the portal's serving path are exercised by the PDF
  election worker's own CI canary, not here, and "the image actually loads
  and decodes through the portal" is **not** asserted by this corpus.
- **OCR for image-only pages.** Not implemented. A scanned PDF gets an
  honest `pdf_no_text_layer`, which is a specific true statement and not a
  model-credit error — but it is a refusal, and rasterise-plus-OCR remains
  the open piece of §5.
- **Those "two stranded production rows" were neither.** Both were DELETED
  by the builder minutes after upload, which the sweep correctly refuses to
  touch. Recorded because an earlier reading of this incident called them
  stranded jobs, and they were not.

## 8 · The 176 lines, and the mistake that nearly buried them

This section previously recorded that `Lot 37`'s 176 unattributed lines were
not carried into the record, and that "which writer drops them is not yet
identified". **That was wrong.** Nothing drops them. They were in
`error_detail` the whole time under `deterministic_ignored` — the key the
SUCCESS path writes — and the query read `error_detail->>'detail'`, the key
the FAILURE path writes. It returned null, and a chain of otherwise-correct
elimination followed from a wrong reading of a record. Kept here because it
is the same class of error this whole document is about: **a record read the
wrong way is worse than no record**, and the elimination felt rigorous right
up to the point it was pointless.

Reading them properly solved the document. `Lot 37` is **dot-delimited
throughout**, and every field it was thought not to state is sitting either
side of a middle dot:

```
Miami 190 · Spectral
Sandpiper · Tweed Heads NSW
190.38 m² · 4 bed · 2 bath · double garage
LAND PRICE $780,000 · REGISTERING Q1 2027
Build $547,407          $1,327,407
```

Read as whole lines none of them matches anything — a design followed by a
facade name, an estate followed by a locality, a specification run, each one
long string the vocabulary has no entry for. Split on the dot, every segment
is an ordinary statement the reader already understands.

It is the **same character** that was being claimed as an estate, and that is
not a coincidence: a designer using it as a separator leaves it standing
alone wherever a segment either side is empty, so reading it as a value was
the first symptom of not reading it as punctuation.

Only where it separates: whitespace on both sides, so a decimal and
`1300·555·020` are untouched. The bullet `•` is excluded, because it opens a
list item rather than separating two fields and every inclusions list is full
of them.

**The estate is `Sandpiper`, at Tweed Heads West NSW 2485 — not `PROPLAUNCH`.**
