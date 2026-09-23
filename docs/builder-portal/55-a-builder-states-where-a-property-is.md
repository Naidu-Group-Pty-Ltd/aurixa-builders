# A builder states where a property is

A package brochure can name its lot and its estate and nothing else. When it
does, no reader can place the property, and until this change the builder had
nowhere to say where it is. This records the document that showed it, where
the builder's statement is kept and why, and how it reaches every surface that
draws or places a property.

## 1. The document

`Lot 101 - PICO - BROCHURE v002.pdf`, uploaded 23 September 2026. Six pages;
page 1 is the offer, pages 2–6 are the builder's standard inclusions. Its
whole location is one line:

```
Lot 101 Watsons Reach Estate
Titles December 2026
Land - $238,500
Build - $366,000
TOTAL - $604,500
PICO 8
```

Every page's text layer was read, and all three pictures on page 1 were
recognised: the facade render, the floor plan, and the area schedule that
carries the build size (`TOTAL: 124.50m²`, doc 52 §16–17). The document holds
no street, suburb, state or postcode anywhere, and no land AREA — the land has
a price and nothing else. Outside the area schedule, the text layer's only
square-metre figure is a site-works allowance on page 3, `Allotment up to
500m2 with a maximum setback of 5m to the house`, which is correctly not read
as the lot's size. The page's own small print says why: *"It is not the
actual lot for sale … refer to contract drawings and site plans for exact
dimensions and setback."*

So the card read `Lot 101, Watsons Reach Estate · PICO 8` with no locality
line, and a clone could not place it: its address composer keeps an estate
name and never geocodes it, because an estate is a marketing name for land
that often predates any street directory entry
(`builderStockAddress.pure.ts`). That is correct, and it leaves exactly one
party who can supply the address.

## 2. What existed

The card's **"Complete the schedule"** took five figures — bedrooms,
bathrooms, car spaces, home size, land size — stored in `manual_stats` and laid
over the document on read (`manualStats.pure.ts`). A land size stated there
stopped at the network until `20260923140000` fixed the composer's keys. Of
the stock function's operations, only `set_availability` and
`set_manual_stats` change what a property says about itself, and neither took
an address.

## 3. Where the statement lives, and why not in the columns

`importStock.ts` lists `address_line`, `suburb`, `state` and `postcode` in
`UNSAYABLE_ON_REREAD`: a same-source re-read that states nothing sets them to
NULL. The reader sweep re-reads every upload whenever the reader's version
moves. An address typed into those columns would therefore be erased by the
next reader release, with nothing reporting it — the correction losing to the
document it corrects, the rule `manualStats.pure.ts` was written around.

So the address is kept where the figures are: four more keys under
`manual_stats.values`, as strings. `builder_stock_items_manual_stats_shape`
admits them with the columns' own rules — the state is one of the eight
`builder_stock_items_state_check` admits, the postcode four digits as
`builder_stock_items_postcode_check` requires — and still asserts key presence
before any dereference, because a CHECK passes on NULL and `->` on an absent
key is NULL.

## 4. How it reaches every surface

**The builder's own card.** `applyStatedLocation` lays the stated parts over
the columns and keeps the document's reading of each on `stated_*`, the
convention the figures use. It must run **before** `applyManualStats`, which
rewrites `manual_stats` to the five figures alone — the other way round, the
address vanishes from the builder's card while still being stored. The
decorator's call is pinned in `builderStockStatedLocation.spec.ts`.

**Every clone.** `builder_network_compose_stock_item_payload` sends the
EFFECTIVE address — the builder's part where one is stated, the document's
where not — in the ordinary `address_line`, `suburb`, `state` and `postcode`
keys. A clone copies those into its mirror verbatim, and every surface there
reads the columns: the card, the locality line, the geocoder that places a
pin, the state filter and the search. Nothing changes on any clone, and
`manual_stats` travels only where a figure is stated, so an address alone
never arrives as an empty `{"values":{}}`.

**The figures' module is untouched.** `manualStats.pure.ts` is byte-identical
to the copy every clone overlays figures with; the address is a module of its
own (`statedLocation.pure.ts`) so that stays true, and the digest is pinned.

**Ranking.** `builder-ranking-recompute` already counts a stated value toward
completeness through its `manual_stats.values` fallback, so a stated address
counts there with no change. Cohorts and breadth read the columns, exactly as
they do for the figures.

## 5. The rules

- **Each part stands alone.** A builder may state the suburb and state and keep
  the document's street. Clearing a part gives the document its reading back;
  clearing every part and figure withdraws the statement.
- **Refused, never cleaned.** A state is accepted as `VIC`, `vic` or
  `Victoria` and stored as `VIC`. A suburb carries no digit (a number there is
  a postcode or a lot in the wrong box). A postcode is four digits. A street is
  3–120 characters of letters, digits and the punctuation addresses are written
  with. Anything else is refused with the part named; nothing is truncated.
- **Silence keeps.** A request that does not mention the address — a tab
  opened before the deploy — keeps the stored address rather than clearing it,
  and a request with no figures keeps the figures.
- **The lot is not stateable.** It is half of the key a re-import finds a
  property by, and restating it could orphan the property from its own list.
- **No postcode-to-state check.** Postcodes do not partition the states — 0872
  serves remote communities in more than one jurisdiction — and refusing a
  true address is worse than letting the geocoder's own gates judge a wrong
  one.

## 6. Evidence

- `scripts/ops/probe-stated-location-payload.mjs`, against a database built
  from every migration, all rolled back. Before the migration:
  `FAIL the database refused a stated address: … violates check constraint
  "builder_stock_items_manual_stats_shape"`. After:
  - a stated suburb, state and postcode travel in the columns a clone copies,
    the unstated street keeping the document's reading, and no `manual_stats`
    is sent;
  - a stated street beside a stated land size travel apart — the street in
    `address_line`, the figure alone in `manual_stats`;
  - all 11 malformed statements are refused: a state outside the eight, a
    lower-case state, a three-digit postcode, a numeric postcode, a numeric
    suburb, a one-character suburb, a two-character street, a JSON null, an
    unknown key, an empty statement, and a statement with no `values`.
- It runs on every acceptance run (`run.sh`), beside the figures' probe, which
  still passes on the widened constraint.
- `builderStockStatedLocation.spec.ts` and `builderStockFigures.spec.tsx`: the
  rules, the overlay and its order, the save, the composer changed in exactly
  two places, and the dialog — the stock list's reading under each part,
  seeding from the builder's statement only, every part sent with `null` for
  a cleared box.

## 7. What it deliberately does not do

It does not infer. The builder's own earlier stock lists, archived on the
network, place `Watsons Reach` in a suburb, and filling Lot 101's card from
them would have been easy. An estate name is not a place, though: the
inference is right until an estate straddles a boundary or a builder has two
estates of one name, and the builder is one dialog away from saying it
themselves. Offering the builder's own earlier reading as a suggestion in the
dialog is the obvious next step and is not taken here.
