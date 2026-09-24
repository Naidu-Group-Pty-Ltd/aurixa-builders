/*
 * A LIST OF LOTS IS A LIST, A SPLIT PRICE IS A PRICE, AND A KERB IS NOT A
 * CAPTION.
 *
 * MEASURED 24 SEPTEMBER 2026, on a Google Sheet stock list imported by URL
 * whose every row links that lot's own flyer. Thirteen of its twenty-three
 * properties were left with no photograph although every flyer carries one,
 * and the forensics run over the real flyers named three causes — none of
 * them about fetching, all of them about how a page or a picture was READ:
 *
 *   1. Each townhouse flyer states its own lot and then the lots its design is
 *      released on — `LOT 28, 29, 30, 36, 37, 40, 41, 43, 44`. The cover rule
 *      read that list as ONE designation of its first number, so the page
 *      "stated another lot" for every lot but the one leading the list.
 *      Eleven properties.
 *
 *   2. Lot 45's flyer prints `Price - $841, 000`, the thousands in a run of
 *      their own, so the page carried one package fact against a cover's two.
 *
 *   3. Lot 54's photograph WAS elected and attached, then hidden as a
 *      marketing tile: the strict type pass read the kerb and lawn edge across
 *      the lower fifth of a clean facade render — from the frame's left edge
 *      to 86.7% of the way across — as a line of lettering, and the clearance
 *      then refused for `type_present`.
 *
 * The code carries the fixes (`pdfPrimaryImage.pure.ts`,
 * `marketingOverlay.pure.ts`) and the versions that say the answers changed:
 * `PROVENANCE_VERSION` 27 and `MARKETPLACE_ELIGIBILITY_VERSION` 4. This is
 * the other half each bump must ship with — the pg_cron tick decides in SQL
 * whether work is left, and SQL cannot read a TypeScript constant. A test
 * reads the migrations and fails when a constant and its target disagree.
 *
 * NOT A SANITIZATION BUMP, deliberately. Raising `SANITIZATION_VERSION`
 * expires every clearance — every card showing a builder's original under
 * "nothing on this picture to remove" would blank until the sweep came back —
 * and reopens refusals the repair reached by rebuilding pixels, which can be
 * handed to the generative route when asked again. The one refusal the new
 * reading can change reopens itself instead: a `type_present` refusal with
 * nothing removed, recorded under an older reading of type
 * (`sanitizationSettled`, `STRICT_TYPE_READING`).
 */

select public.set_builder_stock_source_images_target(27);
select public.set_builder_stock_eligibility_target(4);

/*
 * AND THE PROPERTIES THE OLD RULES ALREADY CONCLUDED.
 *
 * `settleItemImages`' own header records the rule: a property at a terminal
 * stage is never claimed again, so a version bump ships with the migration
 * that sends the affected properties back to the stage that has to re-run
 * them. Raising the targets re-opens the UPLOAD sweeps; this re-opens the
 * per-property ladder.
 *
 * BY CONDITION, NEVER BY ACCOUNT. Every organisation's properties answer to
 * the same two tests, so any builder whose flyers were misread the same way
 * is re-read the same way — measured before this shipped, the tests match the
 * thirteen properties above and nothing else in production.
 *
 * BOTH TERMINAL STAGES. Under the photograph invariant of 15 September 2026 a
 * property whose builder sources were all read and named no photograph ends
 * `failed`, not `settled` — a person is told, rather than a blank card being
 * published — so a reopen that looked at `settled` alone would miss exactly
 * the properties a misreading left pictureless.
 *
 * NARROW. A property that already shows a picture is not touched, and nothing
 * here writes property data — no price, availability, configuration, status,
 * selection, builder or project linkage — and no image row. The failure and
 * attempt counters are cleared with the stage because the watchdog escalates
 * on them, and leaving them would walk the property back to `failed` on its
 * own bookkeeping rather than on a reading.
 *
 * AND NOT BEFORE THE NEW CODE IS SERVING. This workflow applies migrations
 * FIRST and deploys the functions after them, and the PDF worker ships on a
 * lane of its own. A property claimed in that gap would be re-read by the
 * rules being replaced, concluded again under them, and — being terminal
 * again — never asked a third time. So the first attempt is set twenty
 * minutes out: well past both deploys, and nothing but the time has to pass.
 * The skew is also refused at the wire (`WireElectionContext.provenanceVersion`),
 * so a late worker costs a retry, never an answer.
 */

-- 1. A builder source was READ and refused under an extractor older than the
--    target: the cover rule changed what it can find. Back to `source`, where
--    `negativeProvenanceStillStands` treats every such answer as stale.
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
        and v ->> 'exhaustion' = 'inspected'
        and coalesce((v ->> 'provenance_version')::integer, 0) < 27
   );

-- 2. A picture the property's own source supplied is held back by a refusal
--    that rests on type the current reading no longer sees. Back to
--    `eligibility`, which re-judges it and hands it to the repair stage.
--    A property the first statement reopened is at `source` now and is not
--    touched again.
update public.builder_stock_items i
   set image_work_stage           = 'eligibility',
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
       from public.builder_stock_item_images im
      where im.stock_item_id = i.id
        and im.processing_status = 'ready'
        and im.source_detail -> 'sanitization_failure' ->> 'reason' = 'nothing_to_remove'
        and im.source_detail -> 'sanitization_failure' ->> 'clearance_refusal' = 'type_present'
        and coalesce((im.source_detail -> 'sanitization_failure' ->> 'type_reading')::integer, 1) < 2
   );

-- ============================================================================
-- Post-migration assertions — shapes, not hopes
-- ============================================================================

do $$
declare
  v_provenance integer;
  v_eligibility integer;
begin
  select source_images_version, marketplace_eligibility_version
    into v_provenance, v_eligibility
    from public.builder_stock_settlement_target where id = true;
  if coalesce(v_provenance, 0) < 27 then
    raise exception 'provenance target did not reach 27 (found %)', v_provenance;
  end if;
  if coalesce(v_eligibility, 0) < 4 then
    raise exception 'eligibility target did not reach 4 (found %)', v_eligibility;
  end if;
end;
$$;
