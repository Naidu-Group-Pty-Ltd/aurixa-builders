/**
 * Builder stock — ONE WORKER PER IMPORT, AND A LEASE THAT CANNOT REWIND.
 *
 * ===========================================================================
 * WHAT THIS PREVENTS, NAMED RATHER THAN IMPLIED.
 * ===========================================================================
 *
 * Once an import can be continued by a second invocation, four things become
 * possible that were not before, and every one of them writes a customer's
 * stock list twice:
 *
 *   • A continuation dispatched twice — the hand-off fires and the recovery
 *     sweep fires — reading the same document in two isolates at once.
 *   • A successor starting while its predecessor is still alive, because the
 *     dispatch is immediate and the predecessor has not returned yet.
 *   • A builder clicking through a second `process_upload` on a row a
 *     continuation already holds.
 *   • A worker the runtime killed, whose claim would otherwise hold the
 *     import shut until somebody noticed.
 *
 * `builder_stock_claim_import` answers all four with one conditional UPDATE:
 * free or expired is claimable, anything else is not, and the row lock makes
 * the check and the write one act. There is no queue, no advisory lock and no
 * second table, because there is exactly one row that could hold the answer
 * and it already exists.
 *
 * ===========================================================================
 * THE LEASE IS INVOCATION-SIZED ON PURPOSE.
 * ===========================================================================
 *
 * A lease is how long a DEAD worker blocks the work. The settler's own
 * incident is the lesson: a single boolean lock held for its full term by a
 * killed worker shut the queue for every property, seventeen minutes, no work
 * at all. Lengthening a lease is never the remedy for anything — it buys a
 * slow worker time by selling a dead worker's victims the same amount.
 *
 * Ninety seconds covers the storage download of a 25 MB document plus the
 * run's own `IMPORT_RUN_BUDGET_MS`, which is the longest an invocation may
 * legitimately hold it.
 *
 * ===========================================================================
 * AND THE RELEASE IS TOKEN-SCOPED, WHICH IS THE WHOLE SAFETY PROPERTY.
 * ===========================================================================
 *
 * The settler shipped a release that named the stage it THOUGHT it held, and
 * on an item whose stage had since advanced that walked a property back down
 * its ladder. So a release here names the TOKEN it took, and the statement
 * clears the claim only where that token is still on the row. A worker whose
 * lease expired while a successor took over cannot release the successor's
 * claim — not because of timing, but because it cannot spell the token.
 *
 * A release also writes nothing else. It hands back a lease; it never states
 * progress, and progress is the one thing a stale worker must not be able to
 * touch.
 */

/** Ninety seconds. See the header for why it is not longer. */
export const IMPORT_LEASE_SECONDS = 90;

export interface ImportClaim {
  /** The token this invocation holds, for the release. */
  token: string;
  /** Hand the claim back. Safe to call twice; safe to call after expiry. */
  release(): Promise<void>;
}

/** A token nobody else will mint. Opaque; it identifies an invocation, not a user. */
export function mintImportClaimToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Take the import claim on one upload, or answer null.
 *
 * NULL IS A NORMAL ANSWER, not an error: it means somebody else is reading
 * this document right now, and the right response is to do nothing at all.
 * Two workers doing nothing is correct; two workers importing is not.
 *
 * `held` AND `unavailable` ARE DIFFERENT ANSWERS AND LEAD OPPOSITE WAYS.
 * `held` means somebody else has it: stop. `unavailable` means the claim
 * function is not there — a deployment whose migration has not been
 * dispatched — and the caller PROCEEDS, unclaimed, exactly as every import
 * did before this existed. A feature the migrations have not reached degrades
 * rather than failing; refusing here would take every import on that
 * deployment down to add a guard against a hand-off it cannot perform either.
 */
export async function claimImport(
  // `any`, like every other client parameter in this module tree: supabase-js
  // returns a thenable builder rather than a Promise, so a structural type
  // here would refuse the real client and pass a hand-written stub.
  supabase: any,
  uploadId: string,
  leaseSeconds: number = IMPORT_LEASE_SECONDS,
): Promise<{ ok: true; claim: ImportClaim } | { ok: false; reason: 'held' | 'unavailable' }> {
  const token = mintImportClaimToken();
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await supabase.rpc('builder_stock_claim_import', {
      p_upload_id: uploadId,
      p_token: token,
      p_lease_seconds: leaseSeconds,
    }));
  } catch (thrown) {
    error = thrown;
  }
  if (error) {
    console.warn('[builderStock] import claim could not be taken', {
      phase: 'import_claim', upload_id: uploadId,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
    });
    return { ok: false, reason: 'unavailable' };
  }
  if (data !== true) return { ok: false, reason: 'held' };

  let released = false;
  return {
    ok: true,
    claim: {
      token,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          await supabase.rpc('builder_stock_release_import', {
            p_upload_id: uploadId, p_token: token,
          });
        } catch { /* the lease expires on its own; a failed release costs latency */ }
      },
    },
  };
}

/**
 * RELEASE THE CLAIM, THEN START THE SUCCESSOR. IN THAT ORDER.
 *
 * The two acts are written together because doing them the other way round is
 * silently broken and looks fine: the dispatch succeeds, the successor
 * arrives a few hundred milliseconds later, finds the row still claimed by
 * the invocation that dispatched it, correctly declines — and the import
 * waits for the minute tick's recovery. Everything logs success and the
 * customer waits sixty seconds for a hand-off that was supposed to be
 * immediate.
 *
 * BEST-EFFORT ON THE DISPATCH, NEVER ON THE RELEASE. The release is awaited
 * because the successor depends on it; the dispatch is the accelerator, and
 * `builder_stock_recover_stalled_imports` reaches the same row within a
 * minute if pg_net or the vault is having a bad day.
 */
export async function releaseThenContinue(
  supabase: any,
  claim: ImportClaim | null,
  uploadId: string,
): Promise<boolean> {
  await claim?.release();
  try {
    const { data, error } = await supabase
      .rpc('builder_stock_dispatch_import_continuation', { p_upload_id: uploadId });
    if (error) {
      console.warn('[builderStock] continuation dispatch unavailable; recovery will drive', {
        phase: 'import_continuation_dispatch', upload_id: uploadId,
        detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
      });
      return false;
    }
    return data !== false;
  } catch {
    // The stalled-import recovery reaches the same row. Latency, never work.
    return false;
  }
}
