/*
 * PROVENANCE 30 — THE ROLE GATE READS A DISPLAY HOME'S COVER THE SAME WAY.
 *
 * See the 30 note in `sourceImages.ts`: 29 nominated the display home's cover
 * and the role gate dropped the nomination, so the property banked the same
 * refusal at 29. Proven on the real brochure: recovered at 30. A display home listed by its design and
 * estate only ("Deanside VIC · Mira 22 Display Home") had its Dropbox folder
 * read to the end and its one brochure found, and the cover rule refused that
 * brochure because its first page names a street the listing never states.
 * The negative it banked at 28 was the reader's failing.
 *
 * Raises the settlement target to 30 and sends back to `source` only the
 * pictureless properties whose refusal was banked under an older reader.
 * Measured before shipping: one property, one organisation. Nothing a newer
 * reader answered, and no property holding a picture, is touched.
 */
select public.set_builder_stock_source_images_target(30);

update public.builder_stock_items i
   set image_work_stage           = 'source',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now() + interval '10 minutes',
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
        and coalesce((v ->> 'provenance_version')::integer, 0) < 30
   );

do $$
declare
  v_provenance integer;
begin
  select source_images_version
    into v_provenance
    from public.builder_stock_settlement_target where id = true;
  if coalesce(v_provenance, 0) < 30 then
    raise exception 'provenance target did not reach 30 (found %)', v_provenance;
  end if;
end;
$$;
