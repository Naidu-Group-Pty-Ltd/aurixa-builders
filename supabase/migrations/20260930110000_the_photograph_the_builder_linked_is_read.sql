/*
 * THE PHOTOGRAPH THE BUILDER LINKED IS READ: ASCII85 PICTURES, UNITS AND
 * DROPBOX FOLDERS.
 *
 * MEASURED 30 SEPTEMBER 2026, on the live Mairandi Notion list. Twenty-two
 * properties showed "needs a photo" although the builder had linked one for
 * every one of them. A read-only probe over the real links named four causes,
 * none of them about the builder's documents:
 *
 *   1. Nine brochures draw their cover picture as
 *      `/Filter [/ASCII85Decode /DCTDecode]` (and the page itself as ASCII85).
 *      The reader took any stream whose first filter was not Flate to be the
 *      picture already, found no JPEG signature in ASCII text, and decoded
 *      nothing.
 *   2. Ten industrial units are filed by "Unit 09", not by lot. The reader
 *      stopped at "does not name a lot" before opening the folder.
 *   3. Two packs for one lot were told apart by nothing, although the row said
 *      which was dual-key.
 *   4. Three display homes link a Dropbox shared FOLDER, whose only public
 *      form is a zip nothing here could read.
 *
 * The code carries the fixes (`pdfAscii85.pure.ts`, `drivePackage.pure.ts`,
 * `pdfPrimaryImage.pure.ts`, `zipStream.pure.ts`, `packageImages.ts`) and
 * `PROVENANCE_VERSION` 28. This is the other half the bump ships with, exactly
 * as `20260924100000_a_list_of_lots_is_a_list.sql` did for 27: the pg_cron tick
 * decides in SQL whether work is left, and a test fails when the constant and
 * this target disagree.
 */

select public.set_builder_stock_source_images_target(28);

/*
 * AND THE PROPERTIES THE OLD READER ALREADY CONCLUDED.
 *
 * BY CONDITION, NEVER BY ACCOUNT, BOTH TERMINAL STAGES, ONLY PICTURELESS
 * PROPERTIES, AND NOT BEFORE THE NEW CODE IS SERVING — the same four rules, for
 * the same reasons, as the migration for 27. Nothing here writes a price, an
 * availability, a configuration, a status, a selection or an image row.
 */

-- 1. A builder source was READ and refused under an extractor older than 28.
update public.builder_stock_items i
   set image_work_stage           = 'source',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now() + interval '20 minutes',
       image_work_failures        = 0,
       image_work_attempts        = 0,
       image_work_updated_at      = now(),
       updated_at                 = now()
 where i.lifecycle_status in ('active', 'staged')
   and i.image_work_stage in ('settled', 'failed')
   and i.primary_image_id is null
   and exists (
     select 1
       from jsonb_each(coalesce(i.source_provenance_result -> 'branches', '{}'::jsonb)) as b(k, v)
      where v ->> 'result' = 'no_deterministic_image'
        and coalesce((v ->> 'provenance_version')::integer, 0) < 28
   );

-- 2. A property whose only builder source is a Dropbox shared FOLDER. Under 27
--    that link was not a source at all, so it banked no branch record and
--    statement 1 cannot see it; it was concluded as "names no source this
--    pipeline can open".
update public.builder_stock_items i
   set image_work_stage           = 'source',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now() + interval '20 minutes',
       image_work_failures        = 0,
       image_work_attempts        = 0,
       image_work_updated_at      = now(),
       updated_at                 = now()
 where i.lifecycle_status in ('active', 'staged')
   and i.image_work_stage in ('settled', 'failed')
   and i.primary_image_id is null
   and (i.source_row -> 'unmapped')::text ~* 'https?://(www\.)?dropbox\.com/(scl/fo|sh)/';

-- ============================================================================
-- Post-migration assertion — a shape, not a hope
-- ============================================================================

do $$
declare
  v_provenance integer;
begin
  select source_images_version
    into v_provenance
    from public.builder_stock_settlement_target where id = true;
  if coalesce(v_provenance, 0) < 28 then
    raise exception 'provenance target did not reach 28 (found %)', v_provenance;
  end if;
end;
$$;
