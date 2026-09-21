/*
 * A CONTROL THAT CANNOT BE SATISFIED IS AN OUTAGE, NOT A CONTROL.
 *
 * `overlay_uncertain` hides a picture and hands the question to the overlay
 * repair. The repair acts on REGIONS the strict pass located — and that state
 * is reached only when the strict pass located NONE, so there is nothing for
 * it to remove and nothing to re-decide. The picture is hidden for ever.
 *
 * MEASURED 21 SEPTEMBER 2026. `LOT 48 - EMBER - FLYER.pdf`: the cover
 * election had designated the flyer's own facade render at evidence level 2,
 * the strict pass measured zero on every signal it has, the faint pass found
 * ONE line at 4.5% of the height, the repair logged
 * `repaired 0, cleared 0, refused 0`, and the property settled with its own
 * photograph hidden and its upload unpublished behind "awaiting source
 * photographs".
 *
 * THE CORPUS, because this is a safety gate and one sample is not a
 * distribution. Of 900 measured images on this deployment: 666 eligible, 230
 * convicted `annotated_marketing_tile`, and 4 rows carrying just TWO distinct
 * pictures `uncertain`. The faint pass is well calibrated rather than
 * trigger-happy — 666 clean photographs produced no faint line at all — so
 * what is wrong is not its sensitivity but that its answer is terminal.
 *
 * `decideMarketplaceEligibility` now lets the SOURCE DOCUMENT'S OWN
 * DESIGNATION break that tie, and only that tie: the strict pass is untouched,
 * anything it convicts never reaches the branch, and a picture is admitted
 * only where that pass measured ZERO on every signal and the single thing
 * against it is one faint line. A promotional tile is not what a builder's
 * brochure presents as its package cover beside the lot, the price and the
 * size.
 *
 * `MARKETPLACE_ELIGIBILITY_VERSION` rises to 3 with it, and this is the other
 * half that bump must ship with: the pg_cron tick decides in SQL whether work
 * is left and SQL cannot read a TypeScript constant, so a bump that ships only
 * the constant changes new imports and silently leaves every stored image on
 * the old rules. A test reads these migrations and fails when the two
 * disagree.
 */

select public.set_builder_stock_eligibility_target(3);

/*
 * AND THE PROPERTIES THE OLD VERDICT ALREADY SETTLED.
 *
 * `settleItemImages`' own header records the rule: a property at a terminal
 * stage is never claimed again, so a version bump ships with the migration
 * that sends the affected properties back to the stage that has to re-run
 * them. Raising the target re-opens the UPLOAD sweep; this re-opens the
 * per-item ladder for the properties whose picture the old rule hid.
 *
 * NARROW. Only a property holding an image that is `pending` for
 * `overlay_uncertain` — the exact verdict this change re-decides. A property
 * hidden for any other reason, or convicted as a tile, is not touched, and
 * nothing here writes property data: no price, availability, configuration,
 * status, selection, builder or project linkage, and no image row. The
 * failure counter is cleared with the stage because the watchdog escalates on
 * it, and leaving it would walk the property back to `failed` on its own
 * bookkeeping rather than on a reading.
 */
update public.builder_stock_items i
   set image_work_stage           = 'eligibility',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now(),
       image_work_failures        = 0,
       image_work_attempts        = 0,
       image_work_updated_at      = now(),
       updated_at                 = now()
 where i.lifecycle_status <> 'archived'
   and exists (
     select 1
       from public.builder_stock_item_images im
      where im.stock_item_id = i.id
        and im.processing_status = 'ready'
        and im.source_detail->>'marketplace_rejection_reason' = 'overlay_uncertain'
   );
