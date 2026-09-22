/**
 * ===========================================================================
 * AN IMPORT THAT SUCCEEDED WRITES DOWN WHAT IT FOUND.
 * ===========================================================================
 *
 * `runStockImport` returns a summary and writes no counts, for the same
 * reason it returns a refusal rather than writing one: the caller knows what
 * to do with the answer and the engine does not. The portal's `finishImport`
 * writes it, and the reader sweep's `writeImportOutcome` writes its own
 * near-identical version.
 *
 * WHY A THIRD COPY IS THE ONE THAT MATTERS. The acceptance gate was the third
 * caller and wrote nothing at all, so every URL import it ran left
 * `records_detected: 0` on a row holding a correctly imported property —
 * which is `false "nothing imported"`, the incident's own symptom, produced
 * by the gate that exists to detect it. Eleven rows, measured 22 September
 * 2026, and every one of them a harness omission rather than a defect.
 *
 * So the counts are written once, here, and the gate calls the same function
 * the product does. This is `closeRefusedUpload`'s rule applied to the other
 * half of the outcome: a caller that IMITATES the product's write is a caller
 * that can disagree with it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It writes no status and no error. Those
 * are not alike across callers and must not be made alike: the portal moves
 * an upload through its own lifecycle under a person's eyes, the sweep writes
 * a status only where a successful read plainly contradicts the stored one,
 * and each has a paragraph explaining itself. The COUNTS are the same fact
 * however the import was reached, which is exactly why they can be shared.
 */

/** The part of a successful import every caller records identically. */
export interface ImportCounts {
  detected: number;
  imported: number;
  updated: number;
  failed: number;
}

/**
 * The four columns, named once.
 *
 * Exported separately because the portal's own write states the status and a
 * source notice in the same statement — things that are NOT alike across
 * callers and must not be made alike — while the counts are. A caller that
 * needs the whole write uses `recordImportCounts`; one that needs the columns
 * inside a larger update spreads these.
 */
export function importCountColumns(summary: ImportCounts): Record<string, number> {
  return {
    records_detected: summary.detected,
    records_imported: summary.imported,
    records_updated: summary.updated,
    records_failed: summary.failed,
  };
}

export async function recordImportCounts(
  db: any,
  input: {
    uploadId: string;
    organisationId?: string | null;
    summary: ImportCounts;
    /** Stamped only where the caller's own flow treats the import as over. */
    completed?: boolean;
  },
): Promise<void> {
  let query = db.from('builder_stock_uploads').update({
    ...importCountColumns(input.summary),
    ...(input.completed === false
      ? {}
      : { processing_completed_at: new Date().toISOString() }),
  }).eq('id', input.uploadId);
  // Scoped where the caller knows the organisation, never invented: a tenant
  // filter that guesses writes nothing and says so nowhere.
  if (input.organisationId) query = query.eq('organisation_id', input.organisationId);
  await query;
}

/**
 * ===========================================================================
 * AND THE WHOLE OUTCOME ROW, ONCE, BECAUSE THERE ARE TWO CALLERS NOW.
 * ===========================================================================
 *
 * The paragraph above says the STATUS and the ERROR are not alike across
 * callers and must not be made alike. That was true of the portal and the
 * reader sweep, and it is exactly false of the two callers below: the
 * browser's `process_upload` and the dispatcher's `continue_import` are the
 * SAME import, split across isolates because one of them ran out of CPU. If
 * they wrote different statuses for the same result, an import would mean
 * something different depending on which invocation happened to finish it —
 * which is the worst possible place for a divergence, because it depends on a
 * document's size.
 *
 * So the columns are composed here and the two callers spread them. Each
 * still owns what is genuinely its own: the portal's statement adds the
 * organisation filter and the `select` its response needs; the continuation's
 * adds nothing, because a dispatcher has no response to shape.
 *
 * Pure: it returns columns. Nothing here reads a clock but the completion
 * stamp, and nothing here writes.
 */
export interface ImportOutcomeSummary extends ImportCounts {
  failures: Array<{ label: string; reason: string }>;
}

export function importOutcomeColumns(
  result: {
    uploadStatus: string;
    summary: ImportOutcomeSummary;
    deterministicIgnored?: string[] | null;
    deterministicPlacement?: string[] | null;
  },
  /**
   * What a SPREADSHEET source could not give us, where the caller read one.
   *
   * Null for every file import, which is what a continuation always is — it
   * resumes from stored bytes, and stored bytes have no hyperlinks to fail to
   * read. Passing null is therefore a statement about the source rather than
   * a caller declining to look.
   */
  sourceNotice: { code?: string | null; message?: string | null; detail?: unknown } | null,
): Record<string, unknown> {
  const importDiagnosis = result.deterministicIgnored?.length
    ? {
      deterministic_ignored: result.deterministicIgnored,
      deterministic_placement: result.deterministicPlacement ?? null,
    }
    : null;
  const outcomeDetail = result.summary.failures.length
    ? { failures: result.summary.failures }
    : (sourceNotice ? sourceNotice.detail : null);
  return {
    status: result.uploadStatus,
    ...importCountColumns(result.summary),
    error_code: result.summary.failures.length ? null : (sourceNotice?.code ?? null),
    error_detail: (outcomeDetail || importDiagnosis)
      ? { ...(outcomeDetail as Record<string, unknown> ?? {}), ...(importDiagnosis ?? {}) }
      : null,
    error_message: result.summary.failures.length
      ? `${result.summary.failed} row(s) could not be saved.`
      : (sourceNotice?.message ?? null),
    processing_completed_at: new Date().toISOString(),
  };
}

/** The columns a failed import writes, named beside the ones a good one does. */
export function importFailureColumns(
  code: string, message: string, detail?: unknown,
): Record<string, unknown> {
  return {
    status: 'failed',
    error_code: code,
    error_message: message,
    error_detail: detail ? { detail: String(detail).slice(0, 128_000) } : null,
    processing_completed_at: new Date().toISOString(),
  };
}
