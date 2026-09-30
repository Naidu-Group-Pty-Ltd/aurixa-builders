/*
 * RUNTIME 4 → 5: the Dropbox folder read and the overlay repair run on the PDF
 * worker (see `runtimeVersion.pure.ts` and `heavyWorkWire.pure.ts`).
 *
 * The code constant is what re-asks a branch our own kills retired: a
 * `package_recovery_attempt` stamped by an older runtime reads as open again.
 * This records the new target beside it, exactly as the runtime 4 step did,
 * and brings the properties that bump reopens forward so they are read in the
 * next tick rather than after their backoff. Measured before shipping: three
 * properties, one organisation — the three display homes whose folder read was
 * killed four times each. Nothing a document answered is touched.
 */
INSERT INTO public.builder_stock_settlement_target (id, image_runtime_version)
VALUES (true, 5)
ON CONFLICT (id) DO UPDATE
  SET image_runtime_version =
        GREATEST(public.builder_stock_settlement_target.image_runtime_version,
                 EXCLUDED.image_runtime_version),
      updated_at = now();

update public.builder_stock_items i
   set image_work_stage           = 'source',
       image_work_claim_until     = NULL,
       image_work_next_attempt_at = now() + interval '5 minutes',
       image_work_failures        = 0,
       image_work_updated_at      = now(),
       updated_at                 = now()
 where i.lifecycle_status in ('active', 'staged')
   and i.primary_image_id is null
   and i.image_work_stage in ('source', 'eligibility', 'sanitization', 'fallback', 'failed')
   and exists (
     select 1
       from jsonb_each(coalesce(i.source_provenance_result -> 'branches', '{}'::jsonb)) as b(k, v)
      where v ->> 'result' = 'package_recovery_attempt'
        and coalesce((v ->> 'runtime_version')::integer, 0) < 5
        and coalesce((v ->> 'attempts')::integer, 0) >= 4
   );
