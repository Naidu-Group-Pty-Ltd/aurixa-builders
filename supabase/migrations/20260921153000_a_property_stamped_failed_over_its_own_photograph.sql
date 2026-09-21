/*
 * THE PROPERTY THIS STRANDED, RE-OPENED ONCE.
 *
 * `readSuppliedEvidence` counted only BRANCHES — URLs found on the row — so a
 * property whose photograph came out of the PDF its builder uploaded named no
 * source at all and read as `no_evidence`: "this row names no source this
 * pipeline can open". That answer is terminal under the invariant. The
 * property is stamped `failed`, a person is paged, and the eligibility and
 * sanitization stages that decide whether the picture may be SHOWN never run.
 *
 * MEASURED 21 SEPTEMBER 2026 on `LOT 48 - EMBER - FLYER.pdf`. The cover
 * election had designated the flyer's own facade render — `role:
 * primary_property`, evidence level 2 — and the display gate answered
 * `overlay_uncertain` over one faint text line at 4.5% of the image height.
 * That is `pending`, not a refusal; the overlay repair exists for exactly it.
 * The source stage stamped the property `failed` before the repair could run,
 * the card stayed blank, and the upload stayed unpublished with
 * `awaiting source photographs: … 1 failed`.
 *
 * `suppliedEvidence.pure.ts` answers `held` now and the ladder advances. That
 * reaches every future claim — and reaches no property already sitting at the
 * terminal stage, because `settleItemImages`' own header records the rule: a
 * property at a terminal stage is never claimed again, so a change that
 * re-opens work ships with the migration that sends the affected properties
 * back to the stage that has to re-run them. This is that migration.
 *
 * NARROW, AND EVERY PART CHECKED RATHER THAN ASSUMED. It re-opens only a
 * property that is `failed` AND holds a `ready` image its own uploaded
 * document supplied AND whose role is `primary_property` — the exact state
 * the old reading mis-answered. A property that failed for any other reason,
 * or that holds no designated picture, is a person's queue and is not
 * touched. It writes pipeline state and nothing else: no price, availability,
 * configuration, status, selection, builder or project linkage, and no image
 * row.
 *
 * `image_work_failures` is cleared with the stage because the watchdog
 * escalates on that counter, and leaving it would walk the property straight
 * back to `failed` on its own bookkeeping rather than on a reading.
 */

update public.builder_stock_items i
   set image_work_stage           = 'source',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now(),
       image_work_failures        = 0,
       image_work_attempts        = 0,
       image_work_updated_at      = now(),
       updated_at                 = now()
 where i.image_work_stage = 'failed'
   and i.lifecycle_status <> 'archived'
   and exists (
     select 1
       from public.builder_stock_item_images im
      where im.stock_item_id = i.id
        and im.source_stage = 'uploaded_document'
        and im.processing_status = 'ready'
        and im.source_detail->>'role' = 'primary_property'
   );
