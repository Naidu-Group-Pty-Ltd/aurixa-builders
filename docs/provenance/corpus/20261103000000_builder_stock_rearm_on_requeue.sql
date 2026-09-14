-- ===========================================================================
-- Builder Stock — re-arm the engine when work is REQUEUED, not only inserted.
--
-- THE DEFECT, MEASURED IN PRODUCTION ON 2 SEPTEMBER 2026.
--
-- `settle-builder-stock-marketplace-eligibility` is the only thing that invokes
-- `builder-stock-image-settler` on its own. Its tick unschedules the job when
-- both queues are empty — correctly — and `builder_stock_items_rearm_settlement`
-- puts it back. That trigger fired AFTER INSERT, on the reasoning that "every
-- way a property can arrive re-arms the engine".
--
-- A property does not only ARRIVE. It is re-read. "Read again" on a source, a
-- design render supplied for eleven lots, a link recovered onto a row — every
-- one of them is an UPDATE of a property that already exists, setting
-- `image_work_stage = 'source'` and `enrichment_status = 'pending'`. None of
-- them inserts. None of them fired the trigger.
--
-- So at 15:10 on 1 September the job drained and unscheduled itself, correctly.
-- At 01:55 on 2 September a builder clicked "Read again": the readers had just
-- learned to see the thirteen brochures the source names, the import wrote
-- correct prices and sizes to all twenty-six rows and requeued twenty-four of
-- them — and then nothing happened. Twenty-six properties sat at `pending`,
-- `cron.job` held forty-eight jobs and not one for the settler, and the
-- Marketplace showed the same two photographs it had shown for a day. It was
-- re-armed by hand, and this is the change that makes the hand unnecessary.
--
-- THE CHANGE IS THE TRIGGER'S EVENT AND NOTHING ELSE. The function is
-- untouched; the schedule is untouched; `ensure_…` is untouched and is
-- idempotent, so a statement that changes fifty rows probes `cron.job` once.
-- The UPDATE is narrowed to the two columns that MEAN "work was queued" — a
-- price edit, an availability change, a `last_seen_at` touch fire nothing.
--
-- Statement level, as before: a re-read that touches twenty-six rows re-arms
-- once.
-- ===========================================================================

DROP TRIGGER IF EXISTS builder_stock_items_rearm_settlement ON public.builder_stock_items;
CREATE TRIGGER builder_stock_items_rearm_settlement
  AFTER INSERT OR UPDATE OF enrichment_status, image_work_stage
  ON public.builder_stock_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.builder_stock_items_rearm_settlement();

COMMENT ON TRIGGER builder_stock_items_rearm_settlement ON public.builder_stock_items IS
  'Re-arms the settlement cron job whenever image work is queued — on a new '
  'property (INSERT) and on a re-read, a supplied render or a recovered link '
  '(UPDATE of enrichment_status / image_work_stage). Statement level; the '
  'function it calls is idempotent.';
