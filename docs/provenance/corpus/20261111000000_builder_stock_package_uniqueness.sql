-- Builder stock — a house-and-land PACKAGE is the property, not the lot.
--
-- `builder_stock_items_org_development_unit_key` made (organisation,
-- development, lot) unique, which encodes the belief that a piece of land can
-- only ever be one thing to sell. A house-and-land list disproves that on
-- nearly every page: Harlow 801 is offered as a Cura 20B at $808,170, a Nex 20
-- at $859,520 and an Elara 18 at $796,545 — three products, one lot.
--
-- The importer's own match key was widened to include the house design in
-- #2475, so it now correctly decides those rows are different properties and
-- inserts them. This index then refused every one, and the refusal reached the
-- builder as "A matching property already exists in your stock": nineteen rows
-- of one import declined for being duplicates of each other.
--
-- The design is normalised here exactly as `designToken` normalises it in
-- `normalise.pure.ts` — lowercased, trimmed, internal whitespace collapsed —
-- so a row the application considers new is a row this index considers new. A
-- row naming no design keys on the empty string, which is what the old index
-- did for every row, so a stock list without the column is unaffected.
--
-- Verified before writing: across all 757 rows, archived included, no two
-- share (organisation, development, lot, design).

begin;

drop index if exists public.builder_stock_items_org_development_unit_key;

create unique index builder_stock_items_org_development_unit_design_key
  on public.builder_stock_items using btree (
    organisation_id,
    lower(btrim(coalesce(development_name, project_name))),
    lower(btrim(coalesce(unit_number, lot_number))),
    lower(btrim(regexp_replace(coalesce(source_row ->> 'house_design', ''), '\s+', ' ', 'g')))
  )
  where (
    coalesce(development_name, project_name) is not null
    and btrim(coalesce(development_name, project_name)) <> ''::text
    and coalesce(unit_number, lot_number) is not null
    and btrim(coalesce(unit_number, lot_number)) <> ''::text
  );

comment on index public.builder_stock_items_org_development_unit_design_key is
  'One property per (organisation, development, lot, house design). The design '
  'is part of the key because a house-and-land list sells the same land with a '
  'choice of house, and those rows are different products at different prices.';

commit;
