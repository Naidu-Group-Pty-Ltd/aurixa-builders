-- THE FIGURES A BUILDER STATES THEMSELVES.
--
-- A stock list does not always say how many bedrooms a house has. Measured on
-- the prime: of 57 PDF-sourced properties, 54 carry bed/bath/car and the three
-- that do not are dual-key homes, where the brochure states two sets of
-- figures for two self-contained dwellings and the extraction correctly
-- declined to collapse them into one number. No parser change fixes that — the
-- document does not carry the fact. The builder does.
--
-- WHY A COLUMN OF ITS OWN RATHER THAN WRITING `bedrooms`.
--
-- `writablePatch` in `importStock.ts` names bedrooms, bathrooms, car_spaces,
-- building_size_sqm and land_size_sqm, and writes each whenever the incoming
-- file states anything at all. A figure typed into those columns would
-- therefore survive a silent stock list and be destroyed by the next one that
-- speaks — the builder's deliberate correction losing to the document it was
-- correcting, which is the defect a repaired image already had against a
-- re-upload (#2347). The patch does not name this column, so an override
-- survives every re-import BY CONSTRUCTION rather than by anybody remembering.
--
-- The extraction is left exactly as it arrived in its own columns, so the
-- override is reversible and a surface can show a builder the reading they
-- disagreed with. The overlay happens on READ, in `manualStats.pure.ts`.
--
-- Shape: {"values": {"bedrooms": 3, ...}, "recorded_at": "...", "recorded_by": "..."}
-- Only stated fields appear in `values`; a missing key means the document
-- stands. Readers go through `readManualStats`, which drops anything that is
-- not one of the five fields carrying a finite in-range number, so a
-- hand-written statement cannot put a string where a bedroom count goes.

alter table public.builder_stock_items
  add column if not exists manual_stats jsonb;

comment on column public.builder_stock_items.manual_stats is
  'Configuration figures stated by the builder where their stock list did not. '
  'Overlaid on read by applyManualStats; deliberately NOT named by '
  'writablePatch, so a re-import cannot overwrite a builder''s own correction. '
  'Shape: {values:{bedrooms,bathrooms,car_spaces,building_size_sqm,land_size_sqm}, recorded_at, recorded_by}.';

-- An object, and its `values` an object. The column is written by one edge
-- function that validates every field, but a constraint is what makes that
-- true of every writer there will ever be — including a hand-run statement.
--
-- A CHECK CONSTRAINT PASSES ON NULL AND FAILS ONLY ON FALSE, which is the one
-- thing that makes a shape constraint over JSONB hard to write. The first
-- version of this opened with `jsonb_typeof(manual_stats -> 'values') =
-- 'object'`, and `->` on an ABSENT key is SQL NULL, so that comparison was
-- NULL rather than false, the whole `and` chain evaluated to NULL, and the
-- constraint ACCEPTED an object carrying no `values` key at all. Found by
-- probing the live constraint rather than by reading it — `{"recorded_at":"x"}`
-- was stored without complaint, and every expression below it was skipped for
-- the same reason. So the key's PRESENCE is asserted first, with `?`, which is
-- strictly true or false; once it holds, `-> 'values'` is never NULL and each
-- test below means what it says.
alter table public.builder_stock_items
  drop constraint if exists builder_stock_items_manual_stats_shape;

alter table public.builder_stock_items
  add constraint builder_stock_items_manual_stats_shape check (
    manual_stats is null
    or (
      jsonb_typeof(manual_stats) = 'object'
      and manual_stats ? 'values'
      and jsonb_typeof(manual_stats -> 'values') = 'object'
      -- Never an empty override: clearing every field removes the row's
      -- override entirely, so `{"values":{}}` is a state that cannot be
      -- reached and must not be storable.
      and manual_stats -> 'values' <> '{}'::jsonb
      -- No key outside the five, so a typo cannot sit in the column looking
      -- like a stated figure that no reader will ever apply. Stated as a key
      -- SUBTRACTION rather than a subquery, because a CHECK constraint admits
      -- no subquery at all: remove the five and nothing may remain.
      and (manual_stats -> 'values')
          - array['bedrooms', 'bathrooms', 'car_spaces',
                  'building_size_sqm', 'land_size_sqm'] = '{}'::jsonb
      -- Every stated figure is a number, asked of each field by name for the
      -- same reason. `0` is a value — a studio has no bedroom and a townhouse
      -- may have no car space — so this checks the TYPE, never truthiness,
      -- and `is null` is how a field goes unstated.
      and (manual_stats -> 'values' -> 'bedrooms' is null
           or jsonb_typeof(manual_stats -> 'values' -> 'bedrooms') = 'number')
      and (manual_stats -> 'values' -> 'bathrooms' is null
           or jsonb_typeof(manual_stats -> 'values' -> 'bathrooms') = 'number')
      and (manual_stats -> 'values' -> 'car_spaces' is null
           or jsonb_typeof(manual_stats -> 'values' -> 'car_spaces') = 'number')
      and (manual_stats -> 'values' -> 'building_size_sqm' is null
           or jsonb_typeof(manual_stats -> 'values' -> 'building_size_sqm') = 'number')
      and (manual_stats -> 'values' -> 'land_size_sqm' is null
           or jsonb_typeof(manual_stats -> 'values' -> 'land_size_sqm') = 'number')
    )
  );

-- Partial: the overwhelming majority of rows state nothing, and the index
-- exists to answer "which properties did a builder correct" for the audit
-- trail rather than to serve the card read, which already has the row.
create index if not exists builder_stock_items_manual_stats_idx
  on public.builder_stock_items (organisation_id)
  where manual_stats is not null;
