-- =====================================================================
-- A PARSER CORRECTION MUST REACH THE ROWS IT ALREADY WROTE.
-- =====================================================================
--
-- `builder_stock_uploads` already carries three settled-version markers, one
-- per image concern, and `builder-stock-image-settler` sweeps every upload
-- below the current version up to it from pg_cron. The TEXT reader had none:
-- `pdfDeterministicRows.pure.ts` runs once, at import, and the row it wrote is
-- frozen — its title, its configuration, its address, and, because the cover
-- election identifies pages by the row's own label, which picture leads its
-- card. A correction to the reader therefore reached every FUTURE upload and
-- not one row that already existed.
--
-- Measured 21 September 2026: `LOT 48 - EMBER - FLYER.pdf` imported twenty
-- minutes before the fix for the very defect it hit. Its card was titled
-- "Unit 115.30m 12.41sq" — a floor-plan area schedule read as a designation —
-- and its own facade render sat in storage, `ready` and `source_supplied`,
-- with the role `unknown`, because the poisoned label named no cover page.
-- The only repair available was the builder pressing "Read again" by hand.
--
-- This adds the fourth marker. NULL means "read by some earlier reader nobody
-- recorded", which is every upload that exists today — that is deliberate, and
-- it is what makes the sweep the thing that repairs production.
--
-- WHAT THE SWEEP MAY DO IS NOT DECIDED HERE. `readerVersion.pure.ts` refuses a
-- linked source outright (re-fetching a sheet imports edits nobody asked to
-- import, and that decision is the builder's), refuses a status that has never
-- been read, and stamps every refusal so an unanswerable question is asked
-- once rather than every tick for ever.

alter table public.builder_stock_uploads
  add column if not exists reader_settled_version integer;

comment on column public.builder_stock_uploads.reader_settled_version is
  'The DETERMINISTIC_READER_VERSION this source was last read at. NULL means '
  'an unrecorded earlier reader, so the source is outstanding. See '
  'supabase/functions/_shared/builderStock/readerVersion.pure.ts.';

-- The sweep asks exactly two questions — IS NULL, and < target — over live
-- uploads only, oldest first. Partial on `deleted_at` because a deleted source
-- is never swept and there is no reason to carry it in the index.
create index if not exists builder_stock_uploads_reader_settled_version_idx
  on public.builder_stock_uploads (reader_settled_version, created_at)
  where deleted_at is null;

-- A NEW KIND OF WORK MUST RE-ARM THE JOB THAT PERFORMS IT.
--
-- The settlement tick unschedules itself when it answers `complete: true`, and
-- on a deployment where every image marker was already current it has done
-- exactly that. The sweep this migration adds work for runs inside that tick,
-- so without this line the job that would do it is not running and the column
-- above would sit NULL for ever — the same shape as a migration whose INSERTs
-- never travel to a clone. `ensure_builder_stock_settlement_scheduled` is
-- idempotent and is what the import kick already calls.
do $$
begin
  perform public.ensure_builder_stock_settlement_scheduled();
exception when undefined_function then
  -- An environment rebuilt from the repo may not have reached that migration
  -- yet. The next import's kick arms it; nothing here may fail a deploy.
  null;
end $$;
