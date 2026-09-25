-- The brochure figure reader's minute tick retired itself while it still had
-- work (doc 57 §7).
--
-- `builder_stock_document_figures_pending()` counts what may be claimed NOW.
-- It leaves out a property whose claim lease is still live, and a `retry` whose
-- next attempt is still in the future. Those are right answers to "what may be
-- claimed now". They are wrong answers to "may the job stop". The tick asked
-- the first question when it meant the second.
--
-- Measured on production on 25 Sep 2026: the reader finished the stock list
-- with one property still owed and the job unscheduled. The last claim was
-- still leased when the tick ran, so the tick saw nothing owed and retired.
-- The lease then expired. Nothing re-arms the job except an image settling, so
-- the property was stranded.
--
-- The job now retires only when nothing is OUTSTANDING. That means nothing
-- claimable, nothing leased and nothing waiting on a retry. Dispatch still
-- follows what is claimable now, so a tick with only leased or deferred work
-- sends nothing and waits. The job is re-armed here for whatever is stranded.

CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_outstanding()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*) FROM public.builder_stock_items i
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND (
       public.builder_stock_document_figures_owed(i, public.builder_stock_document_figures_version())
       -- Held by a reader now: its answer, or its lapsed lease, is still to come.
       OR (i.document_figures_claim_until IS NOT NULL AND i.document_figures_claim_until >= now())
       -- Waiting on a retry that has attempts left, whenever it falls due.
       OR (i.document_figures ->> 'state' = 'retry'
           AND coalesce((i.document_figures ->> 'attempts')::integer, 0) < 6
           AND (i.document_figures ->> 'v')::integer = public.builder_stock_document_figures_version()
           AND i.document_figures ->> 'document'
               IS NOT DISTINCT FROM public.builder_stock_document_figures_document(i.source_provenance_result))
     )
$$;

CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_tick()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
DECLARE
  v_owed bigint := public.builder_stock_document_figures_pending();
  v_outstanding bigint := public.builder_stock_document_figures_outstanding();
  v_images bigint := 0;
  v_sent integer := 0;
BEGIN
  BEGIN
    SELECT outstanding INTO v_images FROM public.builder_stock_image_work_pending();
  EXCEPTION WHEN OTHERS THEN v_images := 0;
  END;
  -- Nothing claimable, leased or deferred, and nothing that could become owed:
  -- only then does the job retire itself.
  IF v_outstanding = 0 AND coalesce(v_images, 0) = 0 THEN
    BEGIN
      PERFORM cron.unschedule('read-builder-stock-document-figures');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('owed', 0, 'retired', true);
  END IF;
  IF v_owed > 0 THEN
    BEGIN
      PERFORM public.cron_invoke_signed_function('builder-stock-figure-reader', '{}'::jsonb, 'pg_cron');
      v_sent := 1;
    EXCEPTION WHEN OTHERS THEN v_sent := 0;
    END;
  END IF;
  RETURN jsonb_build_object('owed', v_owed, 'outstanding', v_outstanding,
    'images_outstanding', v_images, 'dispatched', v_sent);
END;
$$;

REVOKE ALL ON FUNCTION public.builder_stock_document_figures_outstanding() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_outstanding() TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_document_figures_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_tick() TO service_role;

-- Whatever a retired job left behind is picked up now; the tick retires the
-- job again once there is truly nothing left.
SELECT public.ensure_builder_stock_document_figures_scheduled();
