# What a document says, before anyone asks what it means

*Written 22 September 2026, against `Lot 37 - Miami 190 - Property Package.pdf`
and a seventeen-document acceptance corpus.*

Read this before touching
`supabase/functions/_shared/builderStock/documentNormalisation.pure.ts`,
`fieldTypes.pure.ts`, the `BrochureUnit` seam in `pdfDeterministicRows.pure.ts`,
or any reader that decides what a value is.

---

## 1 · The repair that was about to be made, and why it was wrong

The reported document is typeset with tracked-out headings, so text extraction
returns

```
L O T   3 7   E S T A T E   B E D   B A T H   G A R A G E   T O T A L   H O M E
```

and not one of them matches a vocabulary entry. The obvious repair is a rule per
field — recognise `B E D`, recognise `B A T H`, recognise `T O T A L  H O M E` —
and it is the wrong repair twice over. It is five copies of one idea, and every
one of them is a rule about a *document* rather than about *documents*.

Letter-spacing is a property of the **type**. So it is resolved once, at the one
place where raw PDF evidence becomes the evidence readers consume, before any
reader is asked a question.

## 2 · The pipeline, and where the seam is

```
RAW PDF  →  page text  ┐
         →  positioned runs, with their own set widths  ┘
                              ↓
              ***  normaliseUnits()  ***          ← the seam
                              ↓
                       canonical units
                              ↓
        property readers · labelled · beside · below · caption · icon row
                              ↓
              ***  acceptFieldValue()  ***        ← the one gate
                              ↓
                      property records
```

`unitsFromPageText` and `unitsFromLayout` are the only two things that make a
unit, and both now route through `normaliseUnits`. Everything downstream reads
units, so nothing downstream needs a typography rule and nothing downstream may
have one.

## 3 · The two transports disagree about what a tracked heading IS

Measured by building a brochure with real PDF character spacing and reading the
bytes back through this product's own extractor:

| transport | what a tracked heading looks like |
|---|---|
| flattened page text | one string, `M A S T E R P L A N` — the extractor inserts a space wherever glyphs did not abut. This is the shape the production Lot 37 row recorded. |
| positioned runs | **ten cells** — `M` at x=56.7, `A` at 79.5, `S` at 100.9 — because the cell assembler joins runs that abut, and tracked glyphs by definition do not. |

The first version of this layer handled only the string form. It would have
read nothing at all on the transport the product actually uses when positions
are available, and the acceptance corpus would have said so — which is the
reason the corpus builds real PDFs rather than synthesising page text.

On that page the inter-glyph gap is **12.0 units every time**, against a mean
glyph advance of 8.7, and the gap between `T O T A L` and `P A C K A G E` is
**26.0**. Regular, bounded, and a word break at roughly twice the letter gap.
That is what tracking is, and it is not what anything else looks like.

## 4 · The rules, and the negatives that bound them

A run is folded only where **all four** hold, and each is the page's own
evidence:

1. **One baseline.** Cells are grouped by row and a run may not leave it.
2. **Single glyphs.** A cell of two or more characters is a word the assembler
   already joined.
3. **Bounded.** Every gap is measured against the run's *own* glyph advance, so
   nothing here is a number of points that a 9pt caption and a 40pt cover title
   would both have to satisfy.
4. **Regular.** The letter gaps must agree with each other.

And at least one glyph must be a **letter**.

### `3 2 1` is an icon row, and the suite caught it on the first run

Every brochure in the corpus draws `3 2 1` under its design name — bed, bath and
car, three values in three columns. The first version of this layer collapsed
any run of three single characters and read it as the number **321**. Four
fixtures lost their counts.

**Letter-spacing is applied to words.** A run of bare digits is left exactly as
the page drew it. `L O T  3 7` still reads, because its first segment is a word
and that is the evidence the whole line is set that way; `3 7` on its own does
not, and reaches the same reading only where a collapsed heading sits beside it
on the same row within the same measured gap.

Condition 4 is the one that makes the rule safe against a different failure:
three cells holding one character each is also what a table of single-letter
codes looks like, and the difference is not the characters — it is that a
tracked run's gaps agree and a column grid's do not.

### A run breaks at anything that is not a letter or a digit

The same page draws `L A N D  +  B U I L D`. Folding the lot together gives
`LAND + BUILD`, a phrase no vocabulary has, and loses the two labels the
document wrote. Broken at the sign it yields `LAND`, `+`, `BUILD`.

## 5 · The raw evidence is never destroyed

A normalised unit carries `raw` — the text as the page drew it — beside `text`,
and `normalisation: { rule, sources }` saying which rule fired and on what. A
reader that wants the literal string still has it, a refusal can quote what was
actually on the page, and nothing downstream has to trust this module to have
been right.

## 6 · A heading is a label candidate. It is not a candidate for anything else

This is the rule the whole layer turns on, and it was paid for twice.

**On the claim.** Version 8 refused any letter-spaced *value*, which caught
`development_name = M A S T E R P L A N` — a page heading offered as the estate.
That guard worked precisely because nothing had made it legible; once it
collapses to `MASTERPLAN` the guard cannot see it. So the **fact** travels
instead: this document set these words as display type, therefore they are its
headings, therefore no field may hold one. Numbers are excluded by construction,
because `3 7` is the lot the heading above it introduces.

**On the search.** The first run of the wired layer lost the design on the very
document it was written for. `corroborateDesignFromFilename` takes an unresolved
line whose words all appear in the filename; it had one candidate, `Miami 190`,
and now had three, because `L O T` and `P A C K A G E` had become `LOT` and
`PACKAGE` — both words in `Lot 37 - Miami 190 - Property Package.pdf`. Three
candidates is ambiguity, so it took none.

Normalisation made two headings legible and a reader downstream read their
legibility as evidence. Headings are now kept out of the candidate pool, once,
where every reader draws from it.

## 7 · One gate. Readers discover evidence; they do not set the standard

Whether a value *belongs* to a field is discovery, and it is each reader's
business. Whether what was found is the *kind* of thing the field holds is not,
and it was being answered in four tests in the reader and in three readers
besides — a count guard one reader made, an area guard another made, a
designation shape a third made.

`acceptFieldValue(field, value, proof)` is now the only answer:

```
MONEY IS NEVER AN AREA.
AN AREA IS NEVER AN IDENTIFIER.
A MEASUREMENT IS NEVER A ROOM COUNT.
A COUNT IS A SMALL WHOLE NUMBER OF ROOMS AND NOTHING ELSE.
```

The case it exists for is the one normalisation creates. Making `L A N D` and
`B U I L D` legible is correct — they *are* those words — and it is also what
puts two AREA labels beside a package price, which no reader could have done
before because no reader could read the heading:

```
T O T A L  P A C K A G E  ·  L A N D  +  B U I L D  ·  I N C .  G S T
                                                        $1,327,407
```

Declined: `land_size_sqm:money_is_not_an_area`.

**Every refusal is named**, from a fixed vocabulary of this product's own words,
and travels as `diagnostics.declinedBecause`. A field name alone says a
statement was refused and not what was wrong with it: `land_size_sqm` declined
reads as a brochure with a missing measurement until the log can say
`money_is_not_an_area`.

**`declinedFields` stayed a list of names.** Widening it into `field:reason`
would have been the quieter change and the worse one — `importTelemetry`
projects that list into the import log and three specs read it as names, so
every one of them would have kept passing while meaning something else.

### Price: absent is better than wrong

A price must say it is money, or the structure must. A label drawn near a value
is weak evidence — `Total` sits over a floor area on one brochure and over a
package price on the next — so under `proof: 'label'` a bare `659,900` is
declined `no_currency_marker`. A reconstructed schedule proves its grid (every
data cell inside exactly one of the header's columns, no two sharing one), so
under `proof: 'column'` a bare figure is a price.

Nothing else is proof-sensitive. That money is not an area is a fact about the
**value**, and no amount of structure makes it false.

## 8 · What the corpus found once the layer was wired

An address block is a property of the page's lines, and it was being collected
only for a line nothing else could read. A builder writes

```
Lot 37 Fairweather Drive
Sandpiper Estate, Tweed Heads NSW 2485
```

and the first line is a **lot heading** — read, claimed, and therefore never
offered to the address reader. The street, the suburb, the state and the
postcode were all absent on a document that prints them in full. Whether a line
names a lot and whether it names a street are two different questions about the
same words, and only one of them was being asked.

Three things followed, each general:

- **Collection moved out of the unresolved branch.** The whole-document guard is
  unchanged: two blocks still claim nothing.
- **`readStreetLine` accepts `Lot 37 Fairweather Drive`.** The composed reader
  has accepted that form on a one-line address since it was written
  (`Lot 9 Perrin Street, Armstrong Creek VIC 3217`); the two-line reader did
  not, so the identical address read completely in one shape and not at all in
  the other. **The word is required** — a bare leading number is a street number
  here and a *lot* on builder stock, and nothing in the line can tell them apart.
- **One address is one block.** A composed reading naming neither a street nor a
  lot is a locality line, and on a two-line address it is the second line of a
  block already collected — so pushing it made one address look like two, the
  guard refused them both, and nothing was imported. The guard was right; it was
  being handed the same address twice. **The lot counts**: `Lot 37, Sandpiper
  Estate, Tweed Heads NSW` carries no street at all, and the lot is how it says
  which property it is.

The locality line is also now read by the composed reader first, because
`readLocalityLine` takes everything before the state as the suburb and would
have given `Sandpiper Estate, Tweed Heads` — a suburb no register has.

## 9 · What was deleted

Six rules about what a value is left `pdfDeterministicRows.pure.ts`:
`COUNT_VALUE`, `MAX_PLAUSIBLE_COUNT`, `statesACount`, `statesAnAmount`,
`MEASURED_FIELDS` and the letter-spaced-value guard `isLetterSpacedType`, along
with the file's private copy of the field-separator rule. `readsAsACount` is
imported back for the icon-row reader, which asks the same question while
*discovering* rather than while deciding — two copies of "what a count looks
like" is how one of them comes to admit `22.59`.

## 10 · What is asserted

- `builderStockDocumentNormalisation.spec.ts` — 34 assertions, roughly half of
  them negatives, with the glyph coordinates taken to the tenth of a point from
  a real PDF read through this product's own extractor. Includes the two layers
  together on the `LAND + BUILD` block.
- `builderStockFieldTypes.spec.ts` — 21 assertions over the four absolutes, the
  price rule, and the fields the gate deliberately has no opinion about.
- **Both were run with the gate removed**: 15 of 47 fail, including the
  integration case. A fixture that passes without its fix proves nothing, which
  this programme has already paid to learn once.
- `scripts/stock-acceptance/` — 17 real PDFs through the portal's own entry
  point, both transports, **0 failures, 3 named limits, 0 generative-model
  calls attempted**. The seventeenth is held out and is this document class:
  a brochure typeset with real PDF character spacing.

## 11 · One renegotiated expectation, and one corrected fixture

`builderStockReadingEvidence.spec.ts` asserted that `LAND 334,000` was **not**
in `declinedFields`, because the plausibility bound used to live in
`normaliseStockRow` — the reader claimed the figure, the coercion nulled it
downstream, and the import log said nothing at all. Both guards now sit in
`acceptFieldValue`, so the statement is declined where it is made and the log
can say which of the two refused it. The measurement is still absent.

`heldout-money-not-area` expected the land size to be **absent**, because the
reader saw `Land 320,000` and `Land Size 320m2`, could not choose, and dropped
the field. That was the conservative side of a conflict that should never have
existed: `320,000` is refused as an area before it can dispute anything, so the
one real reading stands and the document's own `Land Size 320m2` is imported.
Both facts the fixture exists to prove are unchanged — the dollar figure is not
in the land size, and the bare `Total` is not a price.

## 12 · What this does not do

It does not decide what anything means. `BED` is a phrase, not a bedroom count;
`LAND` beside `$547,407` is a phrase beside a currency amount. Normalisation
makes a document legible. Typing decides what may be written down. Neither
invents a fact, and where the two together cannot prove a figure the field is
left empty — because **absent is better than wrong**.
