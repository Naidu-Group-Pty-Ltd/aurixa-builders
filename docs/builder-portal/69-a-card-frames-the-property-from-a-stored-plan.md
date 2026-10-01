# 69 — A card frames the property from a stored plan (Marketplace Hero Standard)

**1 October 2026.** Every marketplace card is 16:9, and the property is the
obvious subject. Before this, cards showed every picture whole unless its
shape was within 3% of 16:9 (`cardPictureFit`). The owner's rule of
30 September was right that a blind crop cuts houses. It also left cards with
a narrow strip of mostly sky, brochure crops on their white page, and houses
low in a tall frame. This standard replaces that rule for **cards only**.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Planner (pure) | `_shared/builderStock/marketplaceHero.pure.ts` | Thumbnail in (≤400 px, the decoder every judgement uses), plan out. |
| Bytes → plan | `_shared/builderStock/heroPlanning.ts` | Decodes and plans, and optionally draws a proof tile. |
| Worker route | `POST /v1/hero` on `builder-stock-pdf-worker` | Same token, lanes and queue as `/v1/sanitize`. Decoding runs here, not in an edge isolate. |
| Sweep | `_shared/builderStock/settleMarketplaceHero.ts` | Plans the non-archived cards that owe a plan, a few each tick. |
| Function | `builder-stock-hero-planner` | Isolated, on its own cron (`builder-stock-hero-planner-10min`). Operations: `plan`, `census`, `evaluate`, `summary`, `proof`. |
| Guarded write | `builder_stock_record_hero_presentation` | Merges one key into one row, only while the fingerprints stand. |
| Rollback | `builder_stock_clear_hero_presentation(NULL)` | Removes both keys everywhere. |
| To the Command Centre | `builder_network_compose_stock_item_payload` | Carries `marketplace_hero` beside the fingerprints it is keyed on. |
| Drawing | `src/lib/marketplaceHero.ts` + `StockPicture` | Byte-identical in both portals, pinned by `marketplaceHeroParity.spec.ts`. |

## The plan

The plan is stored at `source_detail.marketplace_hero` as
`{ plan, object: 'original'|'derivative', sha256, planned_at }`. `plan` holds:

- `version`;
- `mode`: `original`, `crop` or `fit`;
- `confidence`;
- `source` (the served image's own pixel size);
- `usable` (the photographic region);
- `focal` (the building);
- `crop`;
- `reasons`;
- `measures`.

### How a plan is made

1. **Canvas is not photograph.** Uniform white, black or neutral bands at an
   edge are trimmed. A band is trimmed only where it ends at a clean
   photographic edge, so a flat overcast sky is never read as a page margin.
2. **The building is never cut.** Its width comes from structure (long
   vertical edges such as walls, jambs and frames). Its top is the
   edge-dense region over that structure (the roof). Its bottom is the lowest
   structure, so driveway and lawn below it are soft. Lawn grain is
   edge-dense too, which is why texture never decides the box.
3. **No crop without a subject.** With no subject, the picture is cropped by
   no more than the old 3%, or shown whole.
4. **Zoom is earned.** Only a high-confidence subject is enlarged, and never
   past 1.67× or below 960 source pixels across. The target is a building at
   55–90% of the width.
5. **`fit` where 16:9 cannot hold the building.** The photographic region is
   shown whole on a plain ground. Nothing is invented around it, and nothing
   is blurred into the gap.

## The fingerprint is the guard

A plan is drawn only for the object the door actually serves (`original` or
`derivative`, by `derivativeToServe`) and only for the SHA-256 that object
has now. The SHA-256 comes from `stored_sha256`, then `source_sha256`, then
the eligibility's `marketplace_measured_sha256`.

The sweep hashes the bytes it downloads and plans nothing where they
disagree. A replaced file, a repair written later, or the door switching back
to the original each void the plan without anybody deleting it. The card is
then drawn as before until it is planned again.

The Command Centre's mirror holds no network storage path, which is why the
fingerprint is the SHA-256 and never a path.

## Presentation, and nothing else

- **What the sweep writes.** Only the two keys, only through the guarded
  RPC. It never writes eligibility, roles, identity, the primary pointer,
  `image_work_stage`, an upload or a publication.
- **Isolation.** It holds no pipeline claim, and the pipeline does not call
  it. A source scan in `marketplaceHeroSafety.spec.ts` pins both.
- **Failures.** A failure writes `marketplace_hero_attempt`. It retries after
  30 minutes, at most 6 times for the same bytes.
- **Several candidates.** The display rule takes croppability as a
  **tie-break below the evidence**, so a weaker-evidence picture never wins
  because it crops better. A candidate with no plan ranks with one that
  cannot be framed. The sweep never moves the primary pointer itself; the tie
  is applied when the pipeline next re-chooses.
- **Where it applies.** Only card call sites opt in (`presentation="card"`).
  Galleries and property pages keep the picture's own shape.

## Rollback

```sql
SELECT public.builder_stock_clear_hero_presentation(NULL);  -- every organisation
```

Every card then draws exactly as it did before. A plan the browser cannot
validate, or whose picture loads in a different shape, is ignored in the same
way, with no deploy.

## Proof without exporting a picture

`operation: 'proof'` re-plans representative cards with proof tiles: before
(whole), then the frame, with the photograph outlined blue, the building
orange and the frame green. It writes one PNG sheet and an `index.json` under
`builder-stock-images/_hero-proof/<stamp>/`. That is private storage, read by
an operator from the project dashboard. Only counts and paths leave the
platform.

Archived pictures are planned fresh for the proof and nothing is stored for
them, so a proof never becomes a partial backfill. `evaluate` does the same
for aggregate numbers.
