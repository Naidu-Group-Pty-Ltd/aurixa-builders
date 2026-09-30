/*
 * A PHOTOGRAPH MID-REPAIR IS NOT A MISSING ONE — reopen the properties that
 * were stamped as though it were.
 *
 * MEASURED 30 SEPTEMBER 2026. Ten industrial units each held the builder's own
 * facade, convicted by the display gate for a small badge (2.6% of the frame).
 * The deterministic repair of that picture succeeds and passes the gate — run
 * on the stored bytes in CI — but costs 2.8 s of CPU against the edge's 2.0 s,
 * so every attempt was killed, its claim kept later sweeps off the row, and
 * the item settler routed each property to `fallback`, which read the
 * convicted picture as "an image that is not a photograph of this property"
 * and stamped it terminally `failed`.
 *
 * The code in the same change moves the repair to the PDF worker and keeps a
 * property on `sanitization` while a repair is still owed. This statement
 * gives back the properties the old rule already stamped: `failed`, not
 * archived, holding a designated builder photograph the display gate
 * convicted of a laid-over graphic, and on which the repair has never settled
 * — no derivative, no refusal and no clearance written. A property the repair
 * ANSWERED is not touched, whatever the answer was.
 *
 * Back to `sanitization`, the stage that owes it a look, twenty minutes out so
 * the worker and the functions this change ships are live first. Idempotent:
 * a property the repair has since answered no longer matches.
 */
update public.builder_stock_items i
   set image_work_stage           = 'sanitization',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now() + interval '20 minutes',
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
        and im.source_detail ->> 'role' = 'primary_property'
        and im.source_detail ->> 'marketplace_eligibility_state' = 'ineligible'
        and im.source_detail ->> 'marketplace_rejection_reason' = 'annotated_marketing_tile'
        and not (im.source_detail ? 'sanitized_derivative')
        and not (im.source_detail ? 'sanitization_failure')
        and not (im.source_detail ? 'sanitization_clearance')
   );
