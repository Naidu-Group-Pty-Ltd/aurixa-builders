/**
 * Builder Portal — Stock List query layer.
 *
 * Mirrors `src/lib/builderQueries.ts`: one `invoke` wrapper that raises a typed
 * error, query keys under the same `builder` root, and one hook per surface.
 * Every call goes through `invokeBuilderFunction`, which carries the HttpOnly
 * portal cookie — the browser never reaches the database directly and never
 * names an organisation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBuilderFunction } from '@/lib/builderPortal';
import { actingOrganisation } from '@/lib/builderActingOrganisation';
import {
  countArrivingUploads, countWorkingImages,
} from '../../supabase/functions/_shared/builderStock/imageProgress.pure';
import type {
  BuilderStockItem, BuilderStockSelectionForBuilder, BuilderStockUpload,
  ManualStatField,
} from '@/lib/builderStock';

export const builderStockKeys = {
  root: () => ['builder', 'stock'] as const,
  uploads: (page: number) => ['builder', 'stock', 'uploads', page] as const,
  items: (filters: StockFilters) => ['builder', 'stock', 'items', filters] as const,
  item: (id: string) => ['builder', 'stock', 'item', id] as const,
  selections: (page: number) => ['builder', 'stock', 'selections', page] as const,
};

export interface StockFilters {
  search: string;
  availability: string;
  uploadId: string;
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  records: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

/**
 * Stamp every call with the organisation THIS TAB is displaying.
 *
 * `__Host-builder_session_token` is one cookie name per origin, so signing
 * into a second builder account silently repoints every open tab at the new
 * account while the old one still renders the previous organisation. Sending
 * what the page believes lets the server refuse the mismatch rather than file
 * the write under whoever the cookie now names — which on 12 September 2026
 * put one organisation's upload into another.
 *
 * Omitted when the tab does not know yet, so nothing that worked before starts
 * failing on a null.
 */
function withActingOrganisation(body: Record<string, unknown>): Record<string, unknown> {
  const expected = actingOrganisation();
  return expected ? { ...body, expected_organisation_id: expected } : body;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await invokeBuilderFunction<T>('builder-portal-stock', withActingOrganisation(body));
  if (error) {
    const failure = new Error(error.message) as Error & { code?: string; status?: number };
    failure.code = error.code;
    failure.status = error.status;
    throw failure;
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * How often the list re-reads itself while the imagery engine still owes it
 * something. The engine's own scheduler runs each minute, so this is a little
 * faster than the fastest thing it could report.
 */
const STOCK_WORKING_POLL_MS = 20_000;

export function useBuilderStockUploads(page = 1) {
  return useQuery({
    queryKey: builderStockKeys.uploads(page),
    queryFn: () => invoke<Paginated<BuilderStockUpload>>({
      operation: 'list_uploads', page, page_size: 20,
    }),
    /*
     * An upload that is still reading its file or finding its images changes
     * underneath the page, and it is what tells the list whether more
     * properties are coming. Polled only while one is in flight, and stopped
     * the moment they have all finished — the same rule as the item list.
     */
    refetchInterval: (query) => (
      countArrivingUploads(query.state.data?.records ?? []) > 0
        ? STOCK_WORKING_POLL_MS
        : false
    ),
  });
}

export function useBuilderStockItems(
  filters: StockFilters,
  /*
   * A reason to keep polling that this page's OWN rows cannot show.
   *
   * A replacement stock list writes its new properties staged, and this list
   * reads active ones, so properties still arriving are invisible here by
   * design. Without this the page would promise "more will appear" on a
   * screen that had stopped asking — the exact failure the banner exists to
   * end. Deliberately not part of the query key: it changes when to re-read,
   * never what is read, and keying on it would throw the cache away each time
   * an upload finished.
   */
  options: { pollWhileArriving?: boolean } = {},
) {
  return useQuery({
    queryKey: builderStockKeys.items(filters),
    queryFn: () => invoke<Paginated<BuilderStockItem>>({
      operation: 'list_stock',
      search: filters.search,
      availability_status: filters.availability,
      upload_id: filters.uploadId,
      page: filters.page,
      page_size: filters.pageSize,
    }),
    /*
     * POLL ONLY WHILE THERE IS SOMETHING TO SEE.
     *
     * A row that says "Finding a picture…" has to be able to stop saying it
     * without the person reloading the page — telling somebody to wait on a
     * screen that never changes is worse than telling them nothing. So the
     * list re-reads itself exactly while at least one property on this page
     * is still being worked, and stops the moment none is.
     *
     * Off by default rather than on: a builder whose stock has all settled is
     * the ordinary case, and every one of those pages polling for ever would
     * be this page's cost to every other tenant.
     */
    refetchInterval: (query) => {
      if (options.pollWhileArriving) return STOCK_WORKING_POLL_MS;
      const records = query.state.data?.records ?? [];
      return countWorkingImages(records.map((item) => ({
        hasImage: !!item.primary_image_id,
        sourceDocuments: item.source_documents ?? 0,
        unprocessedDocuments: item.source_documents_unprocessed ?? 0,
        unreachableDocuments: item.source_documents_unreachable ?? 0,
        workStage: item.image_work_stage,
      }))) > 0
        ? STOCK_WORKING_POLL_MS
        : false;
    },
  });
}

export function useBuilderStockSelections(page = 1) {
  return useQuery({
    queryKey: builderStockKeys.selections(page),
    queryFn: () => invoke<Paginated<BuilderStockSelectionForBuilder>>({
      operation: 'list_selections', page, page_size: 20,
    }),
  });
}

/** A short-lived signed URL for one stored image. */
export async function builderStockImageUrl(imageId: string): Promise<string | null> {
  try {
    const result = await invoke<{ url?: string }>({ operation: 'image_url', image_id: imageId });
    return result.url ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * How far the IMPORT has got. Four steps and no fifth.
 *
 * There used to be two more — `settling` and `enriching` — and they were not
 * steps of the import at all. They were the browser driving image processing,
 * and removing them is the whole of this change. See `uploadBuilderStockFile`
 * below.
 */
export interface StockUploadProgress {
  phase: 'requesting' | 'uploading' | 'processing' | 'done';
}

export interface StockImportSummary {
  detected: number;
  imported: number;
  updated: number;
  failed: number;
  /** Properties whose card shows the builder's own picture. */
  withSourceImage?: number;
  warnings: string[];
  failures: Array<{ label: string; reason: string }>;
}

export interface StockUploadResult {
  upload: BuilderStockUpload;
  summary: StockImportSummary;
  /**
   * Properties the backend still owes imagery, as at the moment the import
   * committed.
   *
   * REPORTED, NEVER WAITED ON. A finished import with outstanding image work
   * is the normal case, not a partial one — so the page says so instead of
   * holding the modal open until it reaches zero. Naming it is what stops a
   * successful import from reading as "images are done"; leaving it out is how
   * a summary comes to claim more than the server said.
   */
  imageWorkPending: number;
}

/** What deleting a source affected. Counts only — no client is named. */
export interface StockSourceRemoval {
  archived: number;
  retainedBecauseResupplied: number;
  affectedSelections: number;
}

/**
 * HOW LONG THE BROWSER WILL WAIT FOR ONE REQUEST BEFORE IT STOPS WAITING.
 *
 * An edge invocation that is KILLED on its resource limit returns nothing at
 * all — no body, no status, no CORS headers — and `fetch` neither resolves nor
 * rejects for it. There is no browser default that ends such a request, so a
 * promise awaited without a deadline is a modal that spins for ever. That is
 * exactly what happened on 29 Aug 2026: execution `08d8f54f` booted, logged,
 * and was terminated with no gateway response, and the import dialog sat on
 * one screen until the tab was closed.
 *
 * These are ceilings, not budgets. The import itself answers in 19-30 seconds
 * against an edge ceiling near 150; the numbers below are set high enough that
 * reaching one is evidence of a dead request rather than a slow one.
 */
const IMPORT_REQUEST_TIMEOUT_MS = 180_000;
/** The file goes straight to storage, so this one scales with the upload. */
const FILE_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * A REQUEST THAT NEVER ANSWERS IS A FAILED REQUEST, NOT A PENDING ONE.
 *
 * `deadline_exceeded` deliberately carries the same meaning as the transport
 * layer's `transport_failed`: the browser did not hear back, so whether the
 * work happened is UNDETERMINED. It must never be reported as "the import
 * failed" — on the production incident the import had already committed 23
 * properties before the request it was waiting on died.
 */
export class StockRequestDeadlineExceeded extends Error {
  readonly code = 'deadline_exceeded';

  constructor(what: string) {
    super(`The server did not answer while ${what}, so whether it completed is `
      + 'unknown. Refresh before trying again.');
    this.name = 'StockRequestDeadlineExceeded';
  }
}

/**
 * Race a request against a clock and cancel it when the clock wins.
 *
 * The signal is passed INTO the request rather than merely raced beside it, so
 * a timed-out call releases its connection instead of running on invisibly.
 */
async function withDeadline<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    // `AbortError` here is ours: nothing else aborts these requests. The
    // caller never asked to cancel, so it is a deadline and says so.
    if (controller.signal.aborted) throw new StockRequestDeadlineExceeded(what);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One bounded `builder-portal-stock` call. */
function invokeBounded<T>(
  what: string,
  body: Record<string, unknown>,
  ms = IMPORT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return withDeadline(what, ms, async (signal) => {
    const { data, error } = await invokeBuilderFunction<T>('builder-portal-stock', withActingOrganisation(body), { signal });
    if (error) {
      const failure = new Error(error.message) as Error & { code?: string; status?: number };
      failure.code = error.code;
      failure.status = error.status;
      throw failure;
    }
    return data as T;
  });
}

/**
 * THE IMPORT ENDS WHEN THE ROWS ARE COMMITTED. IT DOES NOT WAIT FOR PICTURES.
 *
 * This function used to have a fifth step: a `while` loop calling
 * `enrich_images` — an expensive image-processing operation — over and over
 * until the server reported nothing left. That made the browser the OWNER of
 * image work, and it was the wrong owner in three separate ways, all three
 * measured in production on 29 August 2026.
 *
 *   IT COULD NOT FINISH. Every one of 29 consecutive calls returned the same
 *   eight numbers (`rows_read: 23, matched: 0, images_stored: 0`); the source
 *   stage was deadlocked against its own budget and the loop had no way to
 *   know. The modal sat on "Processing supplied images" for twenty minutes.
 *
 *   IT COULD NOT SURVIVE. Call 30 was killed mid-request and returned no
 *   response at all, so the promise never settled and the dialog could never
 *   reach its own last line.
 *
 *   IT WAS NOT NEEDED. Through all of it the autonomous settler was claiming
 *   ONE property per cron tick and advancing it — twelve properties in the
 *   thirteen minutes after the browser stopped, with nobody watching. Source,
 *   eligibility, sanitization, the fallback ladder, primary selection and
 *   publication are all the backend's, and have been since the per-item claim
 *   shipped.
 *
 * So the loop is gone rather than budgeted. Raising a timeout or a request cap
 * would have kept the browser in charge of work it cannot own: the builder has
 * to be able to close the tab the moment the import answers, and after this
 * they can. What is left is reported — `imageWorkPending` — and never awaited.
 */
export async function uploadBuilderStockFile(
  file: File,
  onProgress?: (progress: StockUploadProgress) => void,
): Promise<StockUploadResult> {
  onProgress?.({ phase: 'requesting' });

  const created = await invokeBounded<{
    upload: BuilderStockUpload; signed_url: string; token: string;
  }>('preparing the upload', {
    operation: 'create_upload',
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    byte_size: file.size,
  });

  onProgress?.({ phase: 'uploading' });
  const put = await withDeadline('uploading the file', FILE_UPLOAD_TIMEOUT_MS, (signal) => fetch(
    created.signed_url,
    {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
      signal,
    },
  ));
  if (!put.ok) throw new Error('The file could not be uploaded. Please try again.');

  onProgress?.({ phase: 'processing' });
  const processed = await invokeBounded<{
    upload: BuilderStockUpload; summary: StockImportSummary; enrichment_pending: number;
  }>('reading the properties', { operation: 'process_upload', upload_id: created.upload.id });

  onProgress?.({ phase: 'done' });
  return {
    upload: processed.upload,
    summary: processed.summary,
    imageWorkPending: processed.enrichment_pending ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Import a stock list the builder linked to rather than uploaded.
 *
 * The browser sends only the URL. The server fetches it — behind the SSRF
 * guard, with every redirect re-checked — snapshots what it got, and runs the
 * same import a file goes through. Imagery is then the backend's, exactly as
 * it is for a file: see `uploadBuilderStockFile` for why there is no loop here
 * either.
 */
export async function importBuilderStockUrl(
  url: string,
  onProgress?: (progress: StockUploadProgress) => void,
): Promise<StockUploadResult> {
  onProgress?.({ phase: 'processing' });
  const imported = await invokeBounded<{
    upload: BuilderStockUpload; summary: StockImportSummary; enrichment_pending: number;
  }>('reading the linked list', { operation: 'import_url', url });

  onProgress?.({ phase: 'done' });
  return {
    upload: imported.upload,
    summary: imported.summary,
    imageWorkPending: imported.enrichment_pending ?? 0,
  };
}

/** Remove a stock-list source. Requires the inventory DELETE permission. */
export function useDeleteBuilderStockSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (uploadId: string) =>
      invoke<{ removed: StockSourceRemoval }>({
        operation: 'delete_upload', upload_id: uploadId,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

export function useSetBuilderStockAvailability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { stockItemId: string; availability: string }) =>
      invoke<{ record: BuilderStockItem }>({
        operation: 'set_availability',
        stock_item_id: input.stockItemId,
        availability_status: input.availability,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/**
 * State the figures this property's stock list did not.
 *
 * All five fields are sent every time, and a box the builder cleared is sent
 * as `null` rather than left out — `parseManualStats` reads an absent key, a
 * null and an empty string identically, so either shape works, and sending
 * the field states plainly that the correction was WITHDRAWN rather than
 * simply not mentioned this time.
 *
 * A cleared field therefore returns the document's own reading, and clearing
 * every field withdraws the whole override. `0` is NOT a cleared field: a
 * townhouse may have no car space, so it travels as the figure it is.
 *
 * The server refuses an out-of-range figure rather than clamping it, so a
 * rejection carries a message worth showing.
 */
export function useSetBuilderStockManualStats() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      stockItemId: string;
      stats: Partial<Record<ManualStatField, number | null>>;
    }) =>
      invoke<{ record: BuilderStockItem }>({
        operation: 'set_manual_stats',
        stock_item_id: input.stockItemId,
        stats: input.stats,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

export function useArchiveBuilderStockItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stockItemId: string) =>
      invoke<{ record: BuilderStockItem }>({
        operation: 'archive_stock_item', stock_item_id: stockItemId,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

export function useAcknowledgeStockSelection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (selectionId: string) =>
      invoke<{ record: BuilderStockSelectionForBuilder }>({
        operation: 'acknowledge_selection', selection_id: selectionId,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/** What one source yielded when its imagery was recovered. */
export interface StockSourceImageRepair {
  upload_id: string;
  rows_read: number;
  rows_with_imagery: number;
  matched: number;
  images_stored: number;
  /** Images taken out of a row's own linked package document. */
  from_package: number;
  /** Rows whose linked package named nothing for that exact property. */
  package_not_identified: number;
  /** Rows whose linked package needs a sign-in we will never do. */
  package_unreachable: number;
  /** The run was budgeted out; asking again continues where it stopped. */
  incomplete: boolean;
  /** Stage-1 rows whose origin could not be proven, refused for display. */
  demoted: number;
  primary_updated: number;
  error: string | null;
}

/**
 * Re-read a source and attach the imagery it supplied.
 *
 * For stock that is ALREADY imported. Nothing is created, no property field is
 * touched and no client selection moves — the source is read again and the
 * builder's own photographs are attached to the properties they came from,
 * which is what the earlier import failed to do.
 */
export function useRecoverStockSourceImages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (uploadId?: string) =>
      invoke<{
        results: StockSourceImageRepair[];
        primaries: { inspected: number; cleared: number; corrected: number };
      }>({
        operation: 'reprocess_source_images',
        ...(uploadId ? { upload_id: uploadId } : {}),
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/**
 * Hand over a picture for ONE property.
 *
 * Uploaded exactly as a stock list is — a signed URL, the browser PUTs to it,
 * and a second call confirms. The bytes are validated SERVER-SIDE out of
 * storage on that second call, so what is registered is what was actually
 * stored rather than what this browser said it sent.
 *
 * IT NAMES ONE PROPERTY AND REACHES NO OTHER. There was briefly a second
 * scope — a render supplied against a house DESIGN and fanned out to every
 * lot stating it — and it is withdrawn: a matching design string is not
 * evidence that a photograph is of a particular house.
 *
 * NOTHING HERE DECIDES WHICH PICTURE A CARD DRAWS. The supplied image is
 * stored at evidence level 1 and the settler re-decides each card from the
 * roles, as it always has.
 */
export function useSupplyBuilderStockImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; stockItemId: string }) => {
      const created = await invoke<{ storage_path: string; upload_url: string }>({
        operation: 'create_builder_image',
        filename: input.file.name,
        stock_item_id: input.stockItemId,
      });

      const put = await fetch(created.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': input.file.type || 'application/octet-stream' },
        body: input.file,
      });
      if (!put.ok) throw new Error('The image could not be uploaded. Please try again.');

      return await invoke<{ scope: 'property'; properties: number }>({
        operation: 'attach_builder_image',
        storage_path: created.storage_path,
        stock_item_id: input.stockItemId,
      });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/**
 * Read a source this organisation already imported, again, with today's parsers.
 *
 * A stock list is read once at upload and never again, so every correction to
 * the readers reaches only the NEXT builder's file — the rows already
 * published keep whatever the parser believed on the day. Two such corrections
 * are why this exists: an uploaded workbook was read for its displayed values
 * alone, so every brochure link in it was discarded; and a `LAND $` column
 * normalised to the same key as `LAND M2`, so the land PRICE was published as
 * the land SIZE.
 *
 * IT IS NOT A RE-UPLOAD, and re-uploading is not an alternative: identical
 * bytes are refused by a unique index, so the only route used to be deleting
 * the source and adding it again — which discards its history and every client
 * selection made against its properties. This re-reads the file already in the
 * bucket and updates each property in place, so ids, selections and the audit
 * trail all survive.
 *
 * It DOES rewrite what the source states — a price, a land size, a design, a
 * document link — because that is the point. What it cannot do is invent a
 * property or move one that the source no longer describes; the import's own
 * identity rule decides that, exactly as it does on any re-import.
 */
export function useReprocessStockSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (uploadId: string) =>
      invoke<{
        upload: BuilderStockUpload;
        summary: StockImportSummary;
        enrichment_pending: number;
      }>({
        operation: 'reprocess_upload',
        upload_id: uploadId,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/**
 * Ask again for the brochure links a Google Sheet would not export.
 *
 * The SOURCE only. No rows are re-imported, no stock data is touched, and no
 * price, availability or client selection moves — this exists precisely so a
 * builder does not have to delete and re-upload a working stock list to pick
 * up a document link. The server refuses unless the upload is a Google Sheet
 * currently reporting that its workbook could not be exported.
 */
export function useRefreshBrochureLinks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (uploadId: string) =>
      invoke<{ requested: boolean }>({
        operation: 'refresh_brochure_links',
        upload_id: uploadId,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}

/** Resume enrichment for stock left pending by an earlier upload. */
export function useEnrichPendingStockImages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<{ processed: number; remaining: number }>({
      operation: 'enrich_images',
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: builderStockKeys.root() }); },
  });
}
