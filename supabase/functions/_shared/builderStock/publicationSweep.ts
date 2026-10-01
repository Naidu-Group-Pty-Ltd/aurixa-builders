/**
 * BUILDER STOCK — A LIST THAT HAS FINISHED ITS WORK IS ASKED TO PUBLISH, EVERY TICK.
 *
 * WHY. `publish_builder_stock_upload` had two callers: the import that just
 * ran, and the settler after a PROPERTY finished its photo work — "there is
 * nothing else watching". So a list whose last property settled while a
 * LIST-level gate held it (its source manifest, its pending source files) was
 * never asked again once that gate cleared: every property ready, nothing
 * left to finish, nothing left to trigger the question. Measured 30 September
 * 2026 on a list of 41 ready properties held by a manifest that our own
 * database had refused to record.
 *
 * WHAT IT DOES, per tick, for a bounded number of lists whose properties have
 * all finished (`builder_stock_uploads_awaiting_publication`):
 *
 *   1. A manifest that is not recorded yet (`pending` on a finished list —
 *      the importer writes that, not `failed`, when OUR write failed) is
 *      written again. It is derived entirely from the stored rows and
 *      idempotent, so writing it again is always safe; success stamps it
 *      `complete`. A `failed` manifest is the source's own truncation and is
 *      left exactly as it is.
 *   2. Publication is asked, through the one function that decides it. The
 *      readiness rule, the atomic cutover and every guard live there and are
 *      untouched; this only makes sure the question is put.
 *
 * Bounded and never fatal: a failure on one list is logged and the next is
 * tried, and nothing here can fail the tick it runs in.
 */
import { writeUploadSourceManifest } from './sourceAssetManifest.ts';
import { publishUploadIfReady } from './itemWorkClaim.ts';

/** Lists one tick asks about. Asking is one cheap call each. */
export const PUBLICATION_SWEEP_LIMIT = 5;

export interface PublicationSweepOutcome {
  asked: number;
  manifestsWritten: number;
  published: number;
  unavailable?: boolean;
}

export async function healAndPublishSettledUploads(
  db: any,
  limit = PUBLICATION_SWEEP_LIMIT,
): Promise<PublicationSweepOutcome> {
  const outcome: PublicationSweepOutcome = { asked: 0, manifestsWritten: 0, published: 0 };
  let candidates: Array<{ upload_id: string; organisation_id: string; manifest_state: string | null }>;
  try {
    const { data, error } = await db.rpc('builder_stock_uploads_awaiting_publication', {
      p_limit: limit,
    });
    if (error) {
      // A deployment mid-migration has no function yet: the old behaviour stands.
      outcome.unavailable = true;
      return outcome;
    }
    candidates = (data ?? []) as typeof candidates;
  } catch {
    outcome.unavailable = true;
    return outcome;
  }

  for (const candidate of candidates) {
    try {
      if (candidate.manifest_state === 'pending') {
        const manifest = await writeUploadSourceManifest(db, {
          organisationId: candidate.organisation_id, uploadId: candidate.upload_id,
        });
        if (manifest.error) {
          console.error('[builderStock] source manifest still not recorded', {
            phase: 'publication_sweep', upload_id: candidate.upload_id,
            detail: manifest.error.slice(0, 200),
          });
        } else {
          const { error: stampError } = await db.from('builder_stock_uploads')
            .update({ source_manifest_state: 'complete' })
            .eq('id', candidate.upload_id)
            .eq('organisation_id', candidate.organisation_id)
            .eq('source_manifest_state', 'pending');
          if (!stampError) outcome.manifestsWritten += 1;
        }
      }
      outcome.asked += 1;
      const published = await publishUploadIfReady(db, candidate.upload_id);
      if (published.published) outcome.published += 1;
    } catch (error) {
      console.error('[builderStock] publication sweep could not ask about a list', {
        phase: 'publication_sweep', upload_id: candidate.upload_id,
        detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
      });
    }
  }
  if (outcome.asked) {
    console.info('[builderStock] publication sweep', { phase: 'publication_sweep', ...outcome });
  }
  return outcome;
}
