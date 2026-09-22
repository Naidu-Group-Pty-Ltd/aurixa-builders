/**
 * ===========================================================================
 * A REFUSAL CLOSES THE ROW. NOTHING MAY BE LEFT MID-FLIGHT.
 * ===========================================================================
 *
 * `runStockImport` marks an upload `parsing` when it starts and RETURNS a
 * refusal rather than writing one — which is right, because the caller knows
 * what to do with it and the engine does not. Every production caller then
 * writes a terminal status. A caller that forgets leaves a row saying
 * `status: parsing, error_code: duplicate_file`: an error on a status that
 * means "still working", which nothing will ever move.
 *
 * MEASURED 22 SEPTEMBER 2026, in the acceptance harness rather than in
 * production: sixteen rows stranded exactly that way, and because `parsing` is
 * one of the re-readable statuses the reader sweep considered every one of
 * them on every tick, for ever, and refused every one. A backlog that can
 * never drain looks identical to a backlog that is draining slowly.
 *
 * The rule is one line and it is here so there is one of it. The portal's
 * duplicate branch and the acceptance gate now call the same function, which
 * is what "the gate exercises the same entry point" has to mean in practice —
 * an imitation of this write would have kept the two able to disagree.
 */

/** What a refusal leaves behind: a terminal status and the reason for it. */
export async function closeRefusedUpload(
  db: any,
  input: {
    uploadId: string;
    organisationId?: string | null;
    code: string;
    message: string;
    detail?: unknown;
  },
): Promise<void> {
  let query = db.from('builder_stock_uploads').update({
    status: 'failed',
    error_code: input.code,
    error_message: input.message,
    ...(input.detail === undefined ? {} : { error_detail: input.detail }),
    processing_completed_at: new Date().toISOString(),
  }).eq('id', input.uploadId);
  /*
   * Scoped to the organisation where the caller knows it, and not invented
   * where it does not: a tenant filter that guesses is worse than one that is
   * absent, because it silently writes nothing.
   */
  if (input.organisationId) query = query.eq('organisation_id', input.organisationId);
  await query;
}
