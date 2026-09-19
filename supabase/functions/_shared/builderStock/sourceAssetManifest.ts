/**
 * The durable manifest of what a stock list's source supplies — the write
 * side of `builder_stock_source_assets`.
 *
 * ENUMERATED ONCE, CONSUMED PER ITEM. The import writes one row per
 * (property, source asset): every row-linked branch — the unsupported ones
 * included, VISIBLY, where they used to vanish from evidence — and every
 * embedded picture the document itself yielded. Workers then update states
 * in place as branches answer, so "what does this upload still owe?" is a
 * table read instead of a re-download and a re-parse of the whole source.
 *
 * The states are the taxonomy the invariant runs on:
 *   pending      — owed work; blocks publication of an invariant upload.
 *   stored       — a photograph from this asset is in the images table.
 *   no_image     — READ, and it genuinely presents no photograph for this
 *                  row (a floor plan, estate collateral). Knowledge.
 *   unreadable   — OUR fault: could not fetch/open. Never "no photo".
 *   unsupported  — a URL shape this pipeline does not traverse, recorded
 *                  instead of silently dropped from evidence.
 *   failed       — retired after its attempt budget; a person is owed.
 *
 * EVERY WRITE IS BEST-EFFORT and says so: the manifest is bookkeeping over
 * work whose truth lives in the images table and the branch records. A
 * failed manifest write must never fail an import or a claim — it leaves a
 * pending row that the readiness gate holds honest until a later sync lands.
 */
import {
  rowSourceBranchCandidates, unmappedWithRecoveredLinks,
} from './sourceBranches.pure.ts';

export type SourceAssetState =
  | 'pending' | 'stored' | 'no_image' | 'unreadable' | 'unsupported' | 'failed'
  // A document nobody needed to open: the property was satisfied by another of
  // its own. A fact about our reading, never a finding about the document —
  // which is why it is not spelled 'no_image'. Written only by
  // builder_stock_reconcile_source_manifest.
  | 'not_required';

/**
 * Write the manifest for everything this upload's stored rows supply.
 * Idempotent: upserts on (upload, item, kind, reference) and never regresses
 * a resolved state back to pending.
 */
export async function writeUploadSourceManifest(
  db: any,
  input: { organisationId: string; uploadId: string },
): Promise<{ written: number; error?: string }> {
  try {
    const { data: items, error } = await db
      .from('builder_stock_items')
      .select('id, source_row')
      .eq('organisation_id', input.organisationId)
      .or(`upload_id.eq.${input.uploadId},pending_upload_id.eq.${input.uploadId}`)
      .limit(2000);
    if (error) return { written: 0, error: String(error.message ?? error) };

    const rows: Record<string, unknown>[] = [];
    for (const item of (items ?? []) as Array<{ id: string; source_row: unknown }>) {
      const sourceRow = (item.source_row ?? {}) as Record<string, unknown>;
      const unmapped = unmappedWithRecoveredLinks(
        (sourceRow.unmapped ?? null) as Record<string, string> | null, sourceRow);
      for (const candidate of rowSourceBranchCandidates(unmapped)) {
        rows.push({
          upload_id: input.uploadId,
          organisation_id: input.organisationId,
          stock_item_id: item.id,
          kind: 'row_branch',
          reference: candidate.url.slice(0, 500),
          branch_kind: candidate.kind,
          column_header: candidate.column.slice(0, 200),
          state: candidate.kind === 'unsupported' ? 'unsupported' : 'pending',
          state_detail: candidate.kind === 'unsupported'
            ? 'this URL shape is not one the pipeline can open; it is recorded rather than dropped'
            : null,
        });
      }
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const page = rows.slice(i, i + 200);
      const { error: upsertError } = await db
        .from('builder_stock_source_assets')
        .upsert(page, {
          onConflict: 'upload_id,stock_item_id,kind,reference',
          ignoreDuplicates: true,
        });
      if (upsertError) return { written, error: String(upsertError.message ?? upsertError) };
      written += page.length;
    }
    return { written };
  } catch (error) {
    return { written: 0, error: String((error as { message?: string })?.message ?? error) };
  }
}

/**
 * Record one branch's resolution. Inserts the row if the upload predates the
 * manifest, so historical uploads converge lazily as their branches answer.
 */
export async function syncSourceAssetState(
  db: any,
  input: {
    organisationId: string; uploadId: string; stockItemId: string;
    reference: string; state: SourceAssetState; detail?: string | null;
    imageId?: string | null;
  },
): Promise<void> {
  try {
    await db.from('builder_stock_source_assets').upsert({
      upload_id: input.uploadId,
      organisation_id: input.organisationId,
      stock_item_id: input.stockItemId,
      kind: 'row_branch',
      reference: input.reference.slice(0, 500),
      state: input.state,
      state_detail: input.detail ? String(input.detail).slice(0, 300) : null,
      image_id: input.imageId ?? null,
    }, { onConflict: 'upload_id,stock_item_id,kind,reference' });
  } catch (error) {
    console.warn('[builderStock] manifest state not recorded', {
      phase: 'source_manifest', upload_id: input.uploadId,
      stock_item_id: input.stockItemId, state: input.state,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 160),
    });
  }
}
