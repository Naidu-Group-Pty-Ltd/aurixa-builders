-- Builder stock — remembering that a package was checked and named no image.
--
-- WHAT WAS BROKEN. The source-provenance repair has three outcomes for a row's
-- linked package: an image was recovered, the package was read and named no
-- image for this property, or the package could not be read at all. Only the
-- first was ever written down. The second — a SUCCESSFUL inspection with a
-- negative answer — left no trace, so the next sweep could not tell it from a
-- property nobody had looked at yet, and fetched and re-parsed the same Drive
-- document again. Every five minutes. For ever.
--
-- Production upload f7e0d4d1 is exactly that shape: 70 rows, 13 already
-- holding a current image, and the rest naming packages that had already been
-- read and had already answered "nothing here for this property". The sweep
-- read `rows_read: 70, matched: 13, images_stored: 0`, hit its per-run work
-- bound, reported itself incomplete, and left `source_images_settled_version`
-- unwritten — so the cron job could never see an empty queue and could never
-- unschedule itself.
--
-- WHAT FIXES IT. One column holding the terminal negative result, so the sweep
-- can skip a package it has already answered at the CURRENT algorithm version.
--
-- IT IS A CACHE OF A DECISION, AND IT IS KEYED SO IT CANNOT OUTLIVE ITS
-- PREMISES. Three things invalidate it, and all three are compared rather than
-- assumed:
--
--   * the provenance version — a bump means the extractor changed its mind
--     about what it can find, so every negative answer is stale by definition;
--   * the package the row names — a builder who swaps package A for package B
--     must have B read, and a stored answer about A must not suppress it;
--   * the row anchor — the same property reached through a different source row
--     is a different question.
--
-- WHAT IT IS NOT. It is not an image, and it is deliberately NOT a row in
-- `builder_stock_item_images`: everything that decides what a card may draw
-- reads that table, and a "there is no picture" record living among the
-- pictures is one predicate away from being served as one. It is not display
-- eligibility either — `marketplace_eligibility_*` answers whether a picture we
-- HAVE may be shown, on its own version and its own settled marker, and this
-- answers whether a picture exists at all. Overloading either would have made
-- one of them lie.
--
-- An OPERATIONAL failure — a fetch that timed out, a folder needing a login, a
-- parser that threw — never reaches this column. That is the whole distinction
-- it exists to preserve: "we looked and there is nothing" is knowledge, "we
-- could not look" is not, and only the first may ever stop us looking again.
--
-- Additive, idempotent, and it rewrites no existing property data. Nothing here
-- reads, writes or alters an image.

ALTER TABLE public.builder_stock_items
  ADD COLUMN IF NOT EXISTS source_provenance_result jsonb;

COMMENT ON COLUMN public.builder_stock_items.source_provenance_result IS
  'Terminal result of the source-provenance repair for this property when its '
  'linked package was read successfully and named no image for it. Shape: '
  '{result, provenance_version, package_reference, source_anchor, detail, '
  'checked_at}. Honoured only while provenance_version, package_reference and '
  'source_anchor all still match; any change re-opens the question. Never '
  'written for an operational failure, and never a substitute for a '
  'builder_stock_item_images row.';

-- The sweep asks one question of this column, per upload: "which of these
-- properties has already been answered at the current version?". It reads the
-- item rows it is already reading, so no index is added for the read.
-- A partial index keeps the operational query — how many properties are
-- currently parked on a negative answer — cheap without carrying the 45 items
-- that have no result at all.
CREATE INDEX IF NOT EXISTS builder_stock_items_source_provenance_result_idx
  ON public.builder_stock_items ((source_provenance_result->>'provenance_version'))
  WHERE source_provenance_result IS NOT NULL;

-- No grant or policy change. The column lives on a table that already has RLS,
-- is written only by the settler's service-role client, and is added to no
-- projection, so nothing a tenant can read gains a field.
