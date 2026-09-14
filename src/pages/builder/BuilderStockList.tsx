import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Boxes, CheckCircle2, ChevronLeft, ChevronRight, FileImage,
  Globe, Image as ImageIcon, ImageDown, ImageOff, Link2, Loader2, Map, Plus,
  RefreshCw, Sparkles, Trash2, Upload, type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SearchInput } from '@/components/ui/search-input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  BuilderPropertyImageButton,
} from '@/components/builder-portal/BuilderPropertyImage';
import { StockPicture } from '@/components/stock/StockPicture';
import { BuilderStockFiguresButton } from '@/components/builder-portal/BuilderStockFigures';
import { AU_LOCALE } from '@/lib/aml/displayDate';
import { BuilderSchedule } from '@/components/builder-portal/ui/BuilderSchedule';
import { useDebounce } from '@/hooks/useDebounce';
import {
  importBuilderStockUrl, type StockImportSummary, type StockUploadProgress, type StockUploadResult, uploadBuilderStockFile, useAcknowledgeStockSelection, useBuilderStockItems, useBuilderStockSelections, useBuilderStockUploads, useArchiveBuilderStockItem, useDeleteBuilderStockSource, useEnrichPendingStockImages, useRecoverStockSourceImages, useRefreshBrochureLinks, useReprocessStockSource,
  useSetBuilderStockAvailability, builderStockImageUrl,
} from '@/lib/builderStockQueries';
import {
  describeManualStats,
  formatFileSize, primaryStockImage, stockFileAcceptAttribute, stockImageStageSummary,
  stockItemLocality, stockItemPrice, stockItemTitle,
  MAX_STOCK_FILE_BYTES, STOCK_AVAILABILITY_CLASSES, STOCK_AVAILABILITY_LABELS,
  STOCK_IMAGE_STAGE_BADGES, STOCK_SELECTION_STATUS_LABELS, STOCK_UPLOAD_STATUS_CLASSES,
  STOCK_UPLOAD_STATUS_LABELS, STOCK_SOURCE_TYPE_LABELS, stockSourceLabel,
  type BuilderStockItem, type BuilderStockUpload, type StockAvailability,
  type StockImageStage, type StockSelectionStatus, type StockUploadStatus,
} from '@/lib/builderStock';
import { isNonBlockingSourceNotice } from '../../../supabase/functions/_shared/builderStock/sourceAccessNotice.pure';
import {
  describeSourceDeletion,
} from '../../../supabase/functions/_shared/builderStock/sourceDeletion.pure';
import {
  countArrivingUploads, countWorkingImages, stockImageProgress,
  STOCK_IMAGE_PROGRESS_BADGE, STOCK_IMAGE_PROGRESS_DETAIL, STOCK_IMAGE_PROGRESS_LABEL,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import './BuilderStockList.css';

/**
 * Builder Portal — Stock List.
 *
 * The builder's side of the Stock List → Property Marketplace feature: upload a
 * schedule in whatever format the sales team keeps it in, watch it import, and
 * see which of the resulting properties a Command Centre adviser has selected
 * for a buyer.
 *
 * Nothing here names an organisation. The server holds the active organisation
 * on the session and scopes every query to it, so this page cannot ask for
 * another builder's stock even if somebody edits its state.
 *
 * The upload control accepts every format the reader supports, not PDFs — the
 * `accept` attribute is derived from `STOCK_EXTENSIONS`, so the picker and the
 * server's classifier cannot drift apart.
 */

const AVAILABILITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All availability' },
  { value: 'available', label: 'Available' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'contracted', label: 'Under contract' },
  { value: 'sold', label: 'Sold' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'unknown', label: 'Not stated' },
];

const SETTABLE_AVAILABILITY: StockAvailability[] = [
  'available', 'on_hold', 'reserved', 'contracted', 'sold', 'settled', 'withdrawn',
];

/**
 * Only the steps a builder is actually waiting on.
 *
 * "Processing supplied images" and "Finding images" used to sit at the end of
 * this list. They were not steps of the import — they were the browser driving
 * image work, and one of them held this dialog open for twenty minutes on a
 * list that had already imported in nineteen seconds. Imagery is the backend's
 * now, so the last thing the builder waits for is the properties being saved.
 */
const PHASE_LABEL: Record<StockUploadProgress['phase'], string> = {
  requesting: 'Preparing the upload',
  uploading: 'Uploading the file',
  processing: 'Reading the properties',
  done: 'Finished',
};

const PHASE_PERCENT: Record<StockUploadProgress['phase'], number> = {
  requesting: 15, uploading: 45, processing: 80, done: 100,
};

export default function BuilderStockList() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState('all');
  const [uploadFilter, setUploadFilter] = useState('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);

  const [progress, setProgress] = useState<StockUploadProgress | null>(null);
  const [lastSummary, setLastSummary] = useState<StockImportSummary | null>(null);
  /**
   * Properties the backend still owes imagery, as the import reported it.
   *
   * Held beside the summary rather than inside it because it is a fact about
   * the QUEUE and not about the file: the summary says what was read and
   * saved, this says what is still being worked on without anybody waiting.
   */
  const [lastImageWorkPending, setLastImageWorkPending] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [pendingDelete, setPendingDelete] = useState<BuilderStockUpload | null>(null);

  useEffect(() => { setPage(1); }, [debounced, availability, uploadFilter]);

  const uploadsQuery = useBuilderStockUploads(1);
  const selectionsQuery = useBuilderStockSelections(1);
  const arrivingUploads = countArrivingUploads(uploadsQuery.data?.records ?? []);
  const itemsQuery = useBuilderStockItems({
    search: debounced.trim(),
    availability: availability === 'all' ? '' : availability,
    uploadId: uploadFilter === 'all' ? '' : uploadFilter,
    page,
    pageSize: 25,
  }, { pollWhileArriving: arrivingUploads > 0 });

  const setAvailabilityMutation = useSetBuilderStockAvailability();
  const acknowledge = useAcknowledgeStockSelection();
  const enrichPending = useEnrichPendingStockImages();
  const deleteSource = useDeleteBuilderStockSource();
  const recoverImages = useRecoverStockSourceImages();
  const refreshLinks = useRefreshBrochureLinks();
  const reprocessSource = useReprocessStockSource();

  const records = itemsQuery.data?.records ?? [];
  const pagination = itemsQuery.data?.pagination;
  /*
   * How many properties on this page the imagery engine still owes something.
   * The list re-reads itself while this is above zero (see
   * `useBuilderStockItems`), so the number comes down on its own.
   */
  const workingImages = countWorkingImages(records.map((item) => ({
    hasImage: !!item.primary_image_id,
    sourceDocuments: item.source_documents ?? 0,
    unprocessedDocuments: item.source_documents_unprocessed ?? 0,
    unreachableDocuments: item.source_documents_unreachable ?? 0,
    workStage: item.image_work_stage,
  })));
  const uploads = uploadsQuery.data?.records ?? [];
  const selections = selectionsQuery.data?.records ?? [];

  const pendingSelections = useMemo(
    () => selections.filter((selection) => selection.status === 'selected'),
    [selections],
  );

  const refreshAll = useCallback(() => {
    void itemsQuery.refetch();
    void uploadsQuery.refetch();
    void selectionsQuery.refetch();
  }, [itemsQuery, uploadsQuery, selectionsQuery]);

  const reportImport = useCallback((result: StockUploadResult) => {
    const imported = result.summary;
    setLastSummary(imported);
    setLastImageWorkPending(result.imageWorkPending);
    toast({
      title: 'Stock list imported',
      description: `${imported.imported} new and ${imported.updated} updated from ${imported.detected} propert${imported.detected === 1 ? 'y' : 'ies'}.`
        + (result.imageWorkPending
          ? ' Images are still being found — you can close this page.'
          : ''),
    });
    refreshAll();
  }, [refreshAll, toast]);

  const reportImportFailure = useCallback((error: unknown) => {
    const failure = error as Error & { code?: string };
    const duplicate = failure.code === 'duplicate_file';
    /**
     * A REQUEST THAT NEVER ANSWERED DID NOT NECESSARILY FAIL.
     *
     * `transport_failed` means the browser got no response at all, so this
     * page does not know whether the import ran — and in production it HAD
     * run. Announcing "could not be imported" there is not a cautious message,
     * it is a false one, and it is what led to the same list being imported
     * twice. The sources list is refreshed below either way, so the honest
     * heading sends the reader to the answer rather than away from it.
     */
    /*
     * A DEADLINE IS THE SAME KIND OF SILENCE. `deadline_exceeded` is this
     * page's own clock giving up on a request that never answered — which is
     * precisely the state `transport_failed` describes, reached deliberately
     * rather than by the socket dying. Both mean the browser does not know,
     * and neither may be reported as a failed import.
     */
    const undetermined = failure.code === 'transport_failed'
      || failure.code === 'deadline_exceeded';
    toast({
      title: duplicate
        ? 'Already imported'
        : undetermined
          ? 'This import did not report back'
          : 'The stock list could not be imported',
      description: undetermined
        ? `${failure.message} If it appears in your sources below, it worked.`
        : failure.message,
      variant: duplicate || undetermined ? 'default' : 'destructive',
    });
    void uploadsQuery.refetch();
  }, [toast, uploadsQuery]);

  /**
   * Re-read one source and attach the imagery it supplied.
   *
   * For stock that is already imported: the properties, their prices, their
   * availability and every client selection stay exactly where they are, and
   * only the pictures change.
   */
  /**
   * Only a Google Sheet whose workbook would not export has links to recover.
   *
   * The server answers that question per row (`link_recovery_available`),
   * beside the recorded reason only it may read — this page once derived it
   * from `error_detail` (which the list never sends) and then from
   * `error_code` (which carries the notice, not the reason), and under both
   * readings the control never rendered for anyone. The server is still the
   * authority: `refresh_brochure_links` re-checks its own row before acting.
   */
  const canRefreshBrochureLinks = useCallback((upload: BuilderStockUpload) => (
    upload.link_recovery_available === true
  ), []);

  const refreshBrochureLinks = useCallback((upload: BuilderStockUpload) => {
    refreshLinks.mutate(upload.id, {
      onSuccess: () => {
        toast({
          title: 'Looking for the brochure links',
          description: 'Your stock list is unchanged. Any documents we recover will '
            + 'be attached to their properties shortly.',
        });
      },
      onError: (error) => {
        toast({
          title: 'Brochure links could not be refreshed',
          description: error instanceof Error ? error.message : 'Please try again shortly.',
          variant: 'destructive',
        });
      },
    });
  }, [refreshLinks, toast]);

  /**
   * Read this source again with today's parsers.
   *
   * Offered on a source that has already been read — a source still waiting
   * for its first pass has `process_upload`, which reports its own progress
   * and its own duplicate refusal, and the server refuses this one for it.
   *
   * The confirmation says what actually changes, because this is the one
   * control here that DOES rewrite property data: prices, sizes, designs and
   * document links are re-read from the file. What it cannot do is lose a
   * property or a selection — the import matches by the same identity rule it
   * always has and updates in place.
   */
  const canReprocess = useCallback((upload: BuilderStockUpload) => (
    !['uploaded', 'failed', 'parsing'].includes(String(upload.status ?? ''))
  ), []);

  const reprocessStockSource = useCallback((upload: BuilderStockUpload) => {
    reprocessSource.mutate(upload.id, {
      onSuccess: (response) => {
        const summary = response.summary;
        toast({
          title: 'Source read again',
          description: summary
            ? `${summary.imported ?? 0} added, ${summary.updated ?? 0} updated. `
              + 'Any pictures we can now reach will appear shortly.'
            : 'Any pictures we can now reach will appear shortly.',
        });
        void uploadsQuery.refetch();
      },
      onError: (error) => {
        toast({
          title: 'That source could not be read again',
          description: error instanceof Error ? error.message : 'Please try again shortly.',
          variant: 'destructive',
        });
      },
    });
  }, [reprocessSource, toast, uploadsQuery]);

  const recoverSourceImages = useCallback((upload: BuilderStockUpload) => {
    recoverImages.mutate(upload.id, {
      onSuccess: (response) => {
        const result = response.results?.[0];
        if (result?.error) {
          toast({
            title: 'That source could not be read again',
            description: result.error,
            variant: 'destructive',
          });
          return;
        }
        const stored = result?.images_stored ?? 0;
        toast({
          title: stored
            ? `${stored} supplied image${stored === 1 ? '' : 's'} recovered`
            : 'No supplied images were found',
          description: stored
            ? `${result?.primary_updated ?? 0} propert${(result?.primary_updated ?? 0) === 1 ? 'y' : 'ies'} now show the builder's own photograph.`
            : 'This source does not carry a photograph for any of its properties.',
        });
        refreshAll();
      },
      onError: (error: unknown) => {
        toast({
          title: 'The source images could not be recovered',
          description: (error as Error).message,
          variant: 'destructive',
        });
      },
    });
  }, [recoverImages, refreshAll, toast]);

  const handleFile = useCallback(async (file: File) => {
    if (file.size > MAX_STOCK_FILE_BYTES) {
      toast({
        title: 'That file is too large',
        description: `The limit is ${Math.round(MAX_STOCK_FILE_BYTES / (1024 * 1024))} MB.`,
        variant: 'destructive',
      });
      return;
    }

    setLastSummary(null);
    setLastImageWorkPending(0);
    try {
      const result = await uploadBuilderStockFile(file, setProgress);
      reportImport(result);
    } catch (error) {
      reportImportFailure(error);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [reportImport, reportImportFailure]);

  /**
   * A linked source. The browser sends the address and nothing else — the
   * server fetches it, snapshots it and runs the same import a file gets.
   */
  const handleUrl = useCallback(async () => {
    const value = sourceUrl.trim();
    if (!value) return;
    setLastSummary(null);
    setLastImageWorkPending(0);
    try {
      const result = await importBuilderStockUrl(value, setProgress);
      reportImport(result);
      setSourceUrl('');
      setAddOpen(false);
    } catch (error) {
      reportImportFailure(error);
    } finally {
      setProgress(null);
    }
  }, [reportImport, reportImportFailure, sourceUrl]);

  const busy = progress !== null;

  /*
   * The three figures, each with something to read it against.
   *
   * Nothing here invents a movement — the queries return counts, not a series.
   * Each baseline is either a related figure this page already computes
   * (`workingImages`, `arrivingUploads`) or a sentence that makes a zero
   * legible, which is the rule `BuilderSchedule` makes mandatory.
   */
  const summary = [
    {
      key: 'properties',
      label: 'Properties listed',
      value: pagination?.total ?? records.length,
      baseline: workingImages > 0
        ? `${workingImages} still finding a picture`
        : 'No imagery outstanding',
    },
    {
      key: 'uploads',
      label: 'Stock lists uploaded',
      value: uploadsQuery.data?.pagination.total ?? uploads.length,
      baseline: arrivingUploads > 0
        ? `${arrivingUploads} still being read`
        : 'All have been read',
    },
    {
      key: 'selections',
      label: 'Awaiting your acknowledgement',
      value: pendingSelections.length,
      baseline: pendingSelections.length === 0
        ? 'Nothing to acknowledge'
        : 'Selected by an adviser',
    },
  ];

  return (
    <BuilderPortalShell
      className="builder-stock-list-page"
      title="Stock List"
      description="Upload your available stock in whatever format you keep it, and see which properties have been selected for a buyer."
      actions={
        <>
          <Button
            className="builder-stock-list-hero-action"
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={itemsQuery.isFetching || busy}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', itemsQuery.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button className="builder-stock-list-hero-action" size="sm" onClick={() => setAddOpen(true)} disabled={busy}>
            {busy
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <Plus className="mr-2 h-4 w-4" aria-hidden />}
            Add stock list
          </Button>
        </>
      }
    >
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        accept={stockFileAcceptAttribute()}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) { setAddOpen(false); void handleFile(file); }
        }}
      />

      <BuilderSchedule className="builder-stock-list-metrics" figures={summary} />

      {progress ? (
        <Card className="builder-stock-list-progress">
          <CardContent className="space-y-3 p-4">
            <div className="text-sm font-medium">{PHASE_LABEL[progress.phase]}</div>
            <Progress value={PHASE_PERCENT[progress.phase]} />
            <p className="text-xs text-muted-foreground">
              Images are found in the background once the properties are saved. You can close this page as soon as the import finishes.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {lastSummary
        ? <ImportSummaryCard summary={lastSummary} imageWorkPending={lastImageWorkPending} />
        : null}

      {pendingSelections.length ? (
        <Card className="builder-stock-list-section builder-stock-list-selections">
          <CardHeader>
            <CardTitle className="text-base">Selected for a buyer</CardTitle>
            <CardDescription>
              A Command Centre adviser has selected these properties from your stock list.
              Acknowledge each one to confirm you have seen it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingSelections.map((selection) => (
              <div
                key={selection.id}
                className="builder-stock-list-selection flex flex-col gap-3 rounded-xl border border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {selection.stock_item
                      ? stockItemTitle(selection.stock_item as never)
                      : 'A property from your stock'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Selected {new Date(selection.selected_at).toLocaleString('en-AU')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={acknowledge.isPending}
                  onClick={() => {
                    acknowledge.mutate(selection.id, {
                      onSuccess: () => toast({ title: 'Acknowledged' }),
                      onError: (error) => toast({
                        title: 'Could not acknowledge',
                        description: (error as Error).message,
                        variant: 'destructive',
                      }),
                    });
                  }}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden />
                  Acknowledge
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="builder-stock-list-section builder-stock-list-workspace">
        <CardHeader className="builder-stock-list-workspace-header gap-5">
          <div className="min-w-0">
            <p className="bd-annot bd-annot-strong">Your stock</p>
            <CardTitle className="mt-1.5 text-lg tracking-tight">
              {pagination
                ? `${pagination.total} ${pagination.total === 1 ? 'property' : 'properties'} on the marketplace`
                : 'Your stock'}
            </CardTitle>
            <CardDescription className="mt-1">
              Properties imported from your stock lists. These are what the Command Centre sees.
            </CardDescription>
          </div>
          {/*
            One toolbar rather than three stacked controls. The search takes the
            slack (`flex-1` over a `basis-64` floor) and the two filters hold a
            fixed compact width, so at narrow widths they wrap onto their own
            line instead of forcing the card wider than the column.
          */}
          <div className="builder-stock-list-toolbar glass-rail flex flex-wrap items-center gap-2 rounded-xl p-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search address, suburb, development or reference"
              aria-label="Search stock"
              containerClassName="min-w-0 flex-1 basis-72"
              className="h-11 w-full"
            />
            <Select value={availability} onValueChange={setAvailability}>
              <SelectTrigger
                className="h-11 w-full min-w-0 sm:w-48"
                aria-label="Filter by availability"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVAILABILITY_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={uploadFilter} onValueChange={setUploadFilter}>
              <SelectTrigger
                className="h-11 w-full min-w-0 sm:w-60"
                aria-label="Filter by stock list"
              >
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stock lists</SelectItem>
                {uploads.map((upload) => (
                  <SelectItem key={upload.id} value={upload.id}>
                    {upload.original_filename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="builder-stock-list-workspace-content">
          {itemsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading your stock…
            </div>
          ) : itemsQuery.isError ? (
            <div className="py-12 text-center text-sm text-destructive">
              {(itemsQuery.error as Error).message}
            </div>
          ) : !records.length ? (
            <div className="py-12 text-center">
              <Boxes className="mx-auto h-10 w-10 text-muted-foreground/50" aria-hidden />
              <p className="mt-3 text-sm font-medium">
                {debounced || availability !== 'all' || uploadFilter !== 'all'
                  ? 'No stock matches those filters'
                  : 'No stock has been uploaded yet'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {debounced || availability !== 'all' || uploadFilter !== 'all'
                  ? 'Clear the filters to see everything you have uploaded.'
                  : 'Upload a spreadsheet, CSV, Word document, PDF or photograph of your schedule.'}
              </p>
            </div>
          ) : (
            <>
              {/*
                WORK IN FLIGHT, SAID ONCE AT THE TOP.

                Reading it off the rows rather than asking the server for a
                second opinion, so the banner and the badges can never
                disagree. It disappears by itself: the list re-reads while this
                is above zero and the count comes down as the engine settles
                each property, so nobody is told to wait on a screen that never
                changes — and nobody has to reload to find out it is done.
              */}
              {workingImages > 0 || arrivingUploads > 0 ? (
                <div
                  role="status"
                  className="builder-stock-list-processing mb-5 flex items-start gap-3 rounded-xl border border-border/70 px-4 py-3"
                >
                  <Loader2
                    className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                    aria-hidden
                  />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {workingImages > 0
                        ? workingImages === 1
                          ? 'Finding a picture for 1 property'
                          : `Finding pictures for ${workingImages} properties`
                        : 'Bringing in your stock list'}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {workingImages > 0
                        ? 'Their brochures are being read now. '
                        : null}
                      {arrivingUploads > 0
                        ? 'A stock list is still being processed, so more properties '
                          + 'will appear here as it finishes. '
                        : null}
                      This runs on its own and finishes without you — the list
                      updates as each one lands, so there is no need to upload the
                      file again.
                    </p>
                  </div>
                </div>
              ) : null}

              {/*
                ONE PRESENTATION. THE PLATE SHEET.

                This was a table above 1400px and a stacked card list below
                it, both rendered and one hidden with `min-[1400px]:hidden` —
                the duplicate-DOM shape the Command Centre work already
                recorded: a CSS-hidden copy still carries every accessible
                name in the document, and two presentations are two places
                for an act to go missing.

                They are one plate list now, which is also what let the
                photograph in: a plate needs the width a table column could
                never give it.
              */}
              <ul className="bd-plate-list builder-stock-list-plates">
                {records.map((item) => (
                  <StockPlate
                    key={item.id}
                    item={item}
                    saving={setAvailabilityMutation.isPending}
                    onAvailabilityChange={(next) => {
                      setAvailabilityMutation.mutate(
                        { stockItemId: item.id, availability: next },
                        {
                          onError: (error) => toast({
                            title: 'Could not update availability',
                            description: (error as Error).message,
                            variant: 'destructive',
                          }),
                        },
                      );
                    }}
                    onRemoved={refreshAll}
                  />
                ))}
              </ul>

              {pagination && pagination.total_pages > 1 ? (
                <div className="builder-stock-list-pagination mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Page {pagination.page} of {pagination.total_pages} · {pagination.total} properties
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline" size="sm" disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                      Previous
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      disabled={page >= pagination.total_pages}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="builder-stock-list-section builder-stock-list-sources">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Stock list sources</CardTitle>
            <CardDescription>
              Every stock list you have added — uploaded or linked — and what happened to it.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={enrichPending.isPending}
            onClick={() => {
              enrichPending.mutate(undefined, {
                onSuccess: (result) => toast({
                  title: result.processed
                    ? `Images found for ${result.processed} propert${result.processed === 1 ? 'y' : 'ies'}`
                    : 'Nothing was waiting for images',
                  description: result.remaining ? `${result.remaining} still to go.` : undefined,
                }),
                onError: (error) => toast({
                  title: 'Image lookup could not run',
                  description: (error as Error).message,
                  variant: 'destructive',
                }),
              });
            }}
          >
            {enrichPending.isPending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
            Retry image lookup
          </Button>
        </CardHeader>
        <CardContent>
          {!uploads.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No stock lists have been added yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>Properties</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uploads.map((upload) => (
                    <TableRow key={upload.id}>
                      <TableCell>
                        <p className="max-w-[18rem] truncate text-sm font-medium" title={stockSourceLabel(upload)}>
                          {stockSourceLabel(upload)}
                        </p>
                        <p className="max-w-[18rem] truncate text-xs text-muted-foreground">
                          {upload.source_type === 'url' && upload.source_url
                            ? upload.source_url
                            : formatFileSize(upload.byte_size)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-medium">
                          {upload.source_type === 'url'
                            ? <Link2 className="mr-1 h-3 w-3" aria-hidden />
                            : <Upload className="mr-1 h-3 w-3" aria-hidden />}
                          {STOCK_SOURCE_TYPE_LABELS[upload.source_type] ?? upload.source_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(upload.created_at).toLocaleString('en-AU')}
                      </TableCell>
                      <TableCell className="text-sm">
                        {upload.records_detected
                          ? `${upload.records_imported} new · ${upload.records_updated} updated`
                          : '—'}
                        {upload.records_failed ? (
                          <span className="block text-xs text-warning">
                            {upload.records_failed} could not be saved
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn('font-medium', STOCK_UPLOAD_STATUS_CLASSES[upload.status as StockUploadStatus])}
                        >
                          {STOCK_UPLOAD_STATUS_LABELS[upload.status as StockUploadStatus] ?? upload.status}
                        </Badge>
                        {upload.error_message ? (
                          /*
                           * A SOURCE-ACCESS ERROR IS AN ERROR, AND THE UPLOAD
                           * STILL SUCCEEDED.
                           *
                           * Both facts have to survive the same row. A Google
                           * Sheet shared so anyone with the link may view it
                           * answers for its property rows and can still refuse
                           * the workbook its link targets live in — so the
                           * import is complete, the badge says so, and this
                           * says what could not be reached. Muted grey read as
                           * a footnote and nobody saw it; failing the upload
                           * would send a builder to re-import a list that is
                           * already in.
                           */
                          <p
                            className={cn(
                              'mt-1 flex max-w-[22rem] items-start gap-1.5 text-xs',
                              isNonBlockingSourceNotice(upload.error_code)
                                ? 'rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive'
                                : 'text-muted-foreground',
                            )}
                          >
                            {isNonBlockingSourceNotice(upload.error_code) ? (
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            ) : null}
                            <span>{upload.error_message}</span>
                          </p>
                        ) : null}
                        {upload.image_stage_summary
                          && Object.keys(upload.image_stage_summary).length ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Images: {Object.entries(upload.image_stage_summary)
                              .map(([stage, states]) =>
                                `${stage.replace(/_/g, ' ')} ${states.ready ?? 0}`)
                              .join(' · ')}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {/*
                          Recover the imagery this source supplied.
                          For stock that is already imported: the source is read
                          again and the builder's own photographs are attached to
                          the properties they came from. Nothing is re-imported,
                          so prices, availability and client selections are
                          untouched — deleting and re-uploading a stock list to
                          fix a picture is not a repair.
                        */}
                        {/*
                          Ask again for the document links this sheet would not
                          export. Shown only where there is something to
                          recover; the server refuses in every other case, so
                          this is a convenience rather than the control.
                        */}
                        {canRefreshBrochureLinks(upload) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={refreshLinks.isPending || busy}
                            onClick={() => refreshBrochureLinks(upload)}
                            aria-label={`Refresh brochure links for ${stockSourceLabel(upload)}`}
                          >
                            <Link2 className="h-4 w-4" aria-hidden />
                            <span className="sr-only sm:not-sr-only sm:ml-2">
                              Refresh brochure links
                            </span>
                          </Button>
                        ) : null}
                        {/*
                          Read the file again with today's parsers. Shown only
                          on a source that has already been read; the server
                          refuses the rest, so this is a convenience rather
                          than the control.
                        */}
                        {canReprocess(upload) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={reprocessSource.isPending || busy}
                            onClick={() => reprocessStockSource(upload)}
                            aria-label={`Read ${stockSourceLabel(upload)} again`}
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden />
                            <span className="sr-only sm:not-sr-only sm:ml-2">Read again</span>
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={recoverImages.isPending || deleteSource.isPending || busy}
                          onClick={() => recoverSourceImages(upload)}
                          aria-label={`Recover source images for ${stockSourceLabel(upload)}`}
                        >
                          <ImageDown className="h-4 w-4" aria-hidden />
                          <span className="sr-only sm:not-sr-only sm:ml-2">Source images</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={deleteSource.isPending || busy}
                          onClick={() => setPendingDelete(upload)}
                          aria-label={`Delete ${stockSourceLabel(upload)}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                          <span className="sr-only sm:not-sr-only sm:ml-2">Delete</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add a source: a file from this computer, or an address to fetch. */}
      <Dialog open={addOpen} onOpenChange={(open) => { if (!busy) setAddOpen(open); }}>
        <DialogContent className="builder-stock-list-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a stock list</DialogTitle>
            <DialogDescription>
              Upload a file, or paste a link and we will fetch it for you.
              Both are read the same way.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="file">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="file">
                <Upload className="mr-2 h-4 w-4" aria-hidden />
                Upload file
              </TabsTrigger>
              <TabsTrigger value="url">
                <Link2 className="mr-2 h-4 w-4" aria-hidden />
                Add from URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="space-y-3 pt-4">
              <p className="text-sm text-muted-foreground">
                Spreadsheets (XLSX, XLS, ODS, CSV), documents (DOCX, ODT, RTF, PDF),
                web pages (HTML), data (JSON, XML), presentations (PPTX) and
                photographs of a printed schedule.
              </p>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  : <Upload className="mr-2 h-4 w-4" aria-hidden />}
                Choose a file
              </Button>
            </TabsContent>

            <TabsContent value="url" className="space-y-3 pt-4">
              <div className="space-y-2">
                <Label htmlFor="builder-stock-url">Stock list URL</Label>
                <Input
                  id="builder-stock-url"
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://example.com/stock-list"
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy && sourceUrl.trim()) void handleUrl();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  A web page, a direct link to a spreadsheet or PDF, or a Notion page
                  you have shared publicly. The page is saved at the moment it is
                  imported, so later edits do not change what was brought in.
                </p>
              </div>
              <Button
                className="w-full"
                disabled={busy || !sourceUrl.trim()}
                onClick={() => void handleUrl()}
              >
                {busy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  : <Link2 className="mr-2 h-4 w-4" aria-hidden />}
                Import stock list
              </Button>
            </TabsContent>
          </Tabs>

          {progress ? (
            <div className="space-y-2">
              <Progress value={PHASE_PERCENT[progress.phase]} />
              <p className="text-xs text-muted-foreground">{PHASE_LABEL[progress.phase]}</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/*
        Deletion is explicit and says what it will do. A builder removing a
        source is saying "this should no longer supply stock", not "erase the
        record" — so the copy names the marketplace consequence and the fact
        that selections already made are kept.
      */}
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
      >
        <AlertDialogContent className="builder-stock-list-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDelete ? stockSourceLabel(pendingDelete) : ''}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Properties this stock list is currently supplying will be removed from
              the Builder Stock marketplace straight away. Properties a newer stock
              list also supplies will stay. Any property already selected for a buyer
              keeps its record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSource.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteSource.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!pendingDelete) return;
                deleteSource.mutate(pendingDelete.id, {
                  onSuccess: (result) => {
                    const removed = result.removed;
                    /*
                     * THROUGH THE RULE, NOT BESIDE IT. This was composed here
                     * and reported `archived` alone, so deleting a list whose
                     * stock a newer list still supplies said "0 properties
                     * were removed" while the properties stayed on the page —
                     * which reads as a delete that did not work.
                     * `describeSourceDeletion` is the one place that says what
                     * a deletion did, and it already knew about the retained
                     * ones; it simply had no caller.
                     */
                    toast({
                      title: 'Stock list deleted',
                      description: describeSourceDeletion({
                        archived: removed.archived,
                        retainedBecauseResupplied: removed.retainedBecauseResupplied,
                        affectedSelections: removed.affectedSelections,
                      }, 'past'),
                    });
                    setPendingDelete(null);
                    refreshAll();
                  },
                  // The source stays visible on failure — the UI never pretends
                  // a delete happened.
                  onError: (error) => toast({
                    title: 'The stock list could not be deleted',
                    description: (error as Error).message,
                    variant: 'destructive',
                  }),
                });
              }}
            >
              {deleteSource.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                : <Trash2 className="mr-2 h-4 w-4" aria-hidden />}
              Delete stock list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BuilderPortalShell>
  );
}

function ImportSummaryCard(
  { summary, imageWorkPending }: { summary: StockImportSummary; imageWorkPending: number },
) {
  return (
    <Card className="builder-stock-list-import">
      <CardContent className="p-5 md:p-6">
        <div className="builder-stock-list-import-summary">
          <span className="builder-stock-list-import-icon" aria-hidden>
            <Upload className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">Last import</CardTitle>
            <CardDescription className="mt-1">
              {summary.detected} propert{summary.detected === 1 ? 'y was' : 'ies were'} read from the file.
            </CardDescription>
          </div>
          <div className="builder-stock-list-import-counts">
            <span className="builder-stock-list-import-count builder-stock-list-import-count-new">
              <strong className="tabular-nums">{summary.imported}</strong> new
            </span>
            <span className="builder-stock-list-import-count">
              <strong className="tabular-nums">{summary.updated}</strong> updated
            </span>
            {summary.failed ? (
              <span className="builder-stock-list-import-count text-warning">
                <strong className="tabular-nums">{summary.failed}</strong> not saved
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-4 space-y-3 border-t border-border/60 pt-4 text-sm">
        {/*
          * SAID PLAINLY, BECAUSE A FINISHED IMPORT IS NOT A FINISHED PICTURE.
          *
          * The dialog no longer waits for imagery, so this is the only place a
          * builder learns there is still work — and the only honest reading of
          * a successful import is "the properties are saved, the pictures are
          * coming". Claiming otherwise by saying nothing is what a summary of
          * a completed import would otherwise imply.
          */}
          {imageWorkPending ? (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Images are still being found for {imageWorkPending} propert{imageWorkPending === 1 ? 'y' : 'ies'}. This continues on our
              servers — you do not need to keep this page open.
            </p>
          ) : null}
          {summary.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {warning}
            </p>
          ))}
          {summary.failures.length ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {summary.failures.map((failure, index) => (
                <li key={`${failure.label}-${index}`}>
                  <span className="font-medium text-foreground">{failure.label}</span> — {failure.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stock row presentation
//
// One set of field renderers, drawn either into a table cell (xl and up) or
// into a stacked card (below xl), so the two presentations cannot drift. Every
// one of them reads the same fields the previous single table row read, and
// none of them decides anything: no filtering, no derived availability, no
// selection state of its own.
// ---------------------------------------------------------------------------

/**
 * The selection badge's tint, drawn only from the availability palette this
 * module already ships — no new colour values. Selection statuses are the
 * server's; nothing here adds one.
 */
const SELECTION_STATUS_CLASSES: Record<StockSelectionStatus, string> = {
  selected: STOCK_AVAILABILITY_CLASSES.on_hold,
  builder_acknowledged: STOCK_AVAILABILITY_CLASSES.contracted,
  progressed: STOCK_AVAILABILITY_CLASSES.contracted,
  completed: STOCK_AVAILABILITY_CLASSES.available,
  withdrawn: STOCK_AVAILABILITY_CLASSES.sold,
};

/** Short forms of the image-stage labels, for chips too narrow for the full one. */
const STOCK_IMAGE_STAGE_SHORT_LABELS: Record<StockImageStage, string> = {
  uploaded_document: 'Stock list',
  google_maps: 'Street View',
  internet_search: 'Online',
};

const STOCK_IMAGE_STAGE_ICONS: Record<StockImageStage, LucideIcon> = {
  uploaded_document: FileImage,
  google_maps: Map,
  internet_search: Globe,
};

/**
 * The amount, and whatever the builder's file said around it.
 *
 * Presentation only: the string `stockItemPrice` returns is split at the first
 * currency figure and both halves are printed, in the order they were written.
 * Nothing is dropped or reformatted — "From $749,000" keeps its "From", and the
 * full line is carried on `title` as well. A price is the offer; setting the
 * qualifier a size down makes the figure scannable without editing it.
 */
const PRICE_AMOUNT = /^([\s\S]*?\$\s?[\d,]+(?:\.\d+)?)\s*([\s\S]*)$/;

function splitPriceLine(price: string | null): { amount: string; qualifier: string | null } {
  if (!price) return { amount: '—', qualifier: null };
  const match = PRICE_AMOUNT.exec(price.trim());
  if (!match) return { amount: price, qualifier: null };
  return { amount: match[1], qualifier: meaningfulTerms(match[2]) };
}

/**
 * A QUALIFIER HAS TO SAY SOMETHING.
 *
 * Builders footnote a price on their own sheets, so `price_display` arrives as
 * `"$863,850 *"` and the split hands the figure `$863,850` and the terms `*`
 * — a footnote MARKER whose footnote is on a page the card does not have.
 * Live on the prime, Lot 324 drew a lone asterisk under its price.
 *
 * The marker is dropped and the figure keeps every digit: nothing here edits
 * the offer, and `title` still carries the builder's line exactly as written,
 * so the asterisk is still there for anyone who hovers it. A run with no
 * letter and no digit carries no terms — `*`, `†`, `(*)`, `~` — while
 * `"* conditions apply"` is a real qualifier and survives.
 */
function meaningfulTerms(terms: string | undefined): string | null {
  const text = (terms ?? '').trim();
  if (!text) return null;
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}

function PropertyIdentity({ item }: { item: BuilderStockItem }) {
  const title = stockItemTitle(item);
  const locality = stockItemLocality(item);
  return (
    <div className="builder-stock-list-property min-w-0">
      {/* Wraps to a second line rather than truncating: an address is what
          identifies the property, and half of one identifies nothing. */}
      <p className="break-words text-sm font-medium leading-snug text-foreground">{title}</p>
      {locality || item.external_reference ? (
        <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">
          {locality}
          {locality && item.external_reference ? ' · ' : ''}
          {item.external_reference ? `Ref ${item.external_reference}` : ''}
        </p>
      ) : null}
    </div>
  );
}

function PriceBlock({ item }: { item: BuilderStockItem }) {
  const price = stockItemPrice(item);
  const { amount, qualifier } = splitPriceLine(price);
  return (
    <div className="builder-stock-list-price min-w-0" title={price ?? undefined}>
      <p className="break-words text-sm font-semibold tabular-nums leading-snug text-foreground">
        {amount}
      </p>
      {qualifier ? (
        <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">{qualifier}</p>
      ) : null}
    </div>
  );
}

/**
 * What imagery this property has, and where each stage got to.
 *
 * The same two facts the text readout carried — which image the card would draw,
 * and the per-stage ready counts — as a badge and three chips. A stage that
 * found nothing is drawn dashed and muted rather than being written out, and
 * its full label and reason stay on the element for hover and screen readers.
 */
function ImageSources({ item, showLabels = false }: { item: BuilderStockItem; showLabels?: boolean }) {
  const image = primaryStockImage(item);
  const stages = stockImageStageSummary(item);
  /*
   * WHY A ROW WITHOUT A PICTURE NEEDS THREE DIFFERENT SENTENCES.
   *
   * "No image yet" was drawn for a property the engine was actively reading, a
   * property whose documents had all been read and named nothing, and a
   * property with no document at all. Only the first is worth waiting for and
   * only the last two can be acted on — and rendering them identically is why
   * work in flight looked like a broken product. The rule is in
   * `imageProgress.pure.ts`; this only draws it.
   *
   * Both counts come from the server with the rules the pipeline itself uses,
   * so this cannot promise a document the pipeline would not read, or claim
   * work that is not outstanding.
   */
  const progress = stockImageProgress({
    hasImage: !!image,
    sourceDocuments: item.source_documents ?? 0,
    workStage: item.image_work_stage,
  });
  const working = progress === 'working';
  // Recorded by the server when it read the document. Absent on a deployment
  // whose projection predates this, which reads exactly as it did before.
  const notes = showLabels ? (item.source_document_notes ?? []) : [];

  return (
    <div className="builder-stock-list-images flex min-w-0 flex-col items-start gap-1.5">
      <Badge
        variant="outline"
        title={image
          ? STOCK_IMAGE_STAGE_BADGES[image.source_stage]
          : STOCK_IMAGE_PROGRESS_DETAIL[progress]}
        className={cn(
          'max-w-full gap-1 px-1.5 py-0 text-[11px] font-medium',
          image
            ? STOCK_AVAILABILITY_CLASSES.available
            : working
              // Work in flight is a live state, not an absence: solid rather
              // than dashed, so a glance down the column separates the rows
              // that need somebody from the rows that need only time.
              ? 'border-border/70 bg-muted/50 text-foreground'
              : 'border-dashed border-border/70 bg-muted/30 text-muted-foreground',
        )}
      >
        {image
          ? <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />
          : working
            ? <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            : <ImageOff className="h-3 w-3 shrink-0" aria-hidden />}
        {/*
          The chip says the short form; the full sentence is the accessible
          name, exactly as the stage chips below do it. Two of the six states
          are longer than this column has ever been able to draw, and a status
          clipped to "No picture in the s…" states nothing.
        */}
        <span className="truncate" aria-hidden={!image}>
          {image
            ? STOCK_IMAGE_STAGE_BADGES[image.source_stage]
            : STOCK_IMAGE_PROGRESS_BADGE[progress]}
        </span>
        {image ? null : (
          <span className="sr-only">{STOCK_IMAGE_PROGRESS_LABEL[progress]}</span>
        )}
      </Badge>

      {/*
        WHAT THE DOCUMENTS THEMSELVES SAID, WHERE THEY NAMED NO PICTURE.
        The chip above can only say a picture is missing; this says why, in
        the words the election recorded when it read the file. It is the
        difference between a brochure with no photograph in it and a brochure
        for a different property — which read identically until now, and only
        the second is a mistake the person holding the sheet can correct.
        Server-gated to `inspected` findings: nothing about our own failures
        reaches here.
      */}
      {!image && notes.length ? (
        <ul className="w-full space-y-0.5 text-[11px] leading-snug text-muted-foreground">
          {notes.map((note) => (
            <li key={`${note.document}-${note.detail}`} className="min-w-0">
              <span className="font-medium text-foreground/80">{note.document}</span>
              {': '}
              {note.detail}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Whatever else went wrong, somebody can fix this one card. The picture a
        builder attaches here carries level 1 — they said "this is that
        property's picture", and nothing was read or inferred to arrive at it —
        so it outranks anything taken out of a document.
      */}
      <BuilderPropertyImageButton
        stockItemId={item.id}
        propertyLabel={stockItemTitle(item)}
        hasImage={!!image}
      />

      <ul className="builder-stock-list-image-stages flex flex-wrap items-center gap-1">
        {stages.map((stage) => {
          const Icon = STOCK_IMAGE_STAGE_ICONS[stage.stage];
          const found = stage.ready > 0;
          return (
            <li
              key={stage.stage}
              title={found ? `${stage.label}: ${stage.ready}` : `${stage.label}: ${stage.note ?? 'none'}`}
              className={cn(
                'inline-flex max-w-full items-center gap-0.5 rounded-md border px-1 py-0.5 text-[11px] leading-none',
                found
                  ? 'border-border/60 bg-muted/30 text-foreground'
                  : 'border-dashed border-border/60 text-muted-foreground',
              )}
            >
              <Icon className="h-3 w-3 shrink-0" aria-hidden />
              {showLabels ? (
                <span className="truncate">{STOCK_IMAGE_STAGE_SHORT_LABELS[stage.stage]}</span>
              ) : null}
              <span className="tabular-nums">{found ? stage.ready : '—'}</span>
              <span className="sr-only">
                {stage.label}: {found ? `${stage.ready} available` : (stage.note ?? 'none')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The availability control. Same value, same options, same handler and same
 * accessible name as before — only the trigger's width is now the column's
 * rather than a fixed 10rem that the column had to grow to fit.
 */
function AvailabilityControl({
  item, saving, onAvailabilityChange, className,
}: {
  item: BuilderStockItem;
  saving: boolean;
  onAvailabilityChange: (next: string) => void;
  className?: string;
}) {
  return (
    <Select
      value={item.availability_status}
      onValueChange={onAvailabilityChange}
      disabled={saving}
    >
      <SelectTrigger
        className={cn('h-9 w-full min-w-0', className)}
        aria-label={`Availability for ${stockItemTitle(item)}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {item.availability_status === 'unknown' ? (
          <SelectItem value="unknown">{STOCK_AVAILABILITY_LABELS.unknown}</SelectItem>
        ) : null}
        {SETTABLE_AVAILABILITY.map((status) => (
          <SelectItem key={status} value={status}>{STOCK_AVAILABILITY_LABELS[status]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The selection state. The statuses are the server's, rendered with the labels
 * this module already publishes; "Not selected" names the absence the em-dash
 * used to stand for and is not a status the data can hold.
 */
function SelectionStatus({ item }: { item: BuilderStockItem }) {
  if (!item.latest_selection) {
    return <span className="text-xs text-muted-foreground">Not selected</span>;
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        // Wraps inside the column instead of widening it — the status is the
        // one thing on this row that must never be pushed off the edge.
        'max-w-full whitespace-normal px-1.5 py-0.5 text-[11px] font-medium leading-tight',
        SELECTION_STATUS_CLASSES[item.latest_selection.status]
          ?? STOCK_AVAILABILITY_CLASSES.on_hold,
      )}
    >
      {STOCK_SELECTION_STATUS_LABELS[item.latest_selection.status]}
    </Badge>
  );
}

interface StockPresentationProps {
  item: BuilderStockItem;
  saving: boolean;
  onAvailabilityChange: (next: string) => void;
  onRemoved: () => void;
}

/**
 * REMOVING ONE PROPERTY, WHICH IS PUTTING IT AWAY RATHER THAN DESTROYING IT.
 *
 * The server operation has existed since the portal shipped — permission
 * gated, activity logged, and it sets `lifecycle_status` to `archived` rather
 * than deleting a row. Nothing ever called it. A builder whose list carried a
 * property they no longer sell could remove the whole stock list or nothing.
 *
 * The word is REMOVE, not delete, because that is what happens: the property
 * leaves their list and the Builder Stock marketplace, and the record — with
 * any selection a Command Centre user already made against it — is kept. A
 * button that promised deletion would be promising something the server
 * deliberately does not do.
 */
function RemoveProperty({ item, onRemoved }: {
  item: BuilderStockItem;
  onRemoved: () => void;
}) {
  const { toast } = useToast();
  const archive = useArchiveBuilderStockItem();
  const [confirming, setConfirming] = useState(false);
  const label = stockItemTitle(item);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
        disabled={archive.isPending}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Remove
        <span className="sr-only">{` ${label} from your stock list`}</span>
      </Button>

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        <AlertDialogContent className="builder-stock-list-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{label}”?</AlertDialogTitle>
            {/* Says what actually happens, in the order it happens. */}
            <AlertDialogDescription>
              It comes off your stock list and out of the Builder Stock marketplace
              straight away. The record is kept, along with any selection a Command
              Centre user has already made against it. Re-uploading a stock list that
              still contains this property brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isPending}
              onClick={(event) => {
                event.preventDefault();
                archive.mutate(item.id, {
                  onSuccess: () => {
                    toast({
                      title: 'Property removed',
                      description: `${label} is no longer on your stock list.`,
                    });
                    setConfirming(false);
                    onRemoved();
                  },
                  // The row stays put on failure — the page never pretends a
                  // removal happened. A permission refusal arrives here too,
                  // in the server's own words.
                  onError: (error) => toast({
                    title: 'The property could not be removed',
                    description: (error as Error).message,
                    variant: 'destructive',
                  }),
                });
              }}
            >
              {archive.isPending ? 'Removing…' : 'Remove property'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** xl and up: the six-column table row. */
/**
 * ONE PROPERTY, DRAWN AS A PLATE.
 *
 * What replaces `StockRow` (a six-column table row above 1400px) and
 * `StockCard` (the same fields stacked below it, rendered in parallel and
 * hidden with `min-[1400px]:hidden`).
 *
 * ## The defect this exists to fix
 *
 * This page rendered ZERO photographs. Every builder's own house imagery is
 * discovered from what they supplied, de-duplicated, classified, ranked and
 * stored — and the Images column showed them a status word. The server's
 * `image_url` operation was live and `builderStockImageUrl` was written; it
 * had no caller anywhere. A builder could hand over a picture through
 * `BuilderPropertyImageButton` and never see it.
 *
 * A volume builder sells off an elevation, so the elevation leads. Every
 * fact and every control the two old presentations carried is still here —
 * identity, price, configuration, image provenance, availability, removal,
 * selection — because none of them was the problem.
 *
 * ## Three things worth knowing
 *
 * **The picture treatment is not this file's.** `StockPicture` is the
 * marketplace card's fit-and-ground logic, extracted so both portals draw
 * the same photograph the same way. Re-deriving it here would have
 * reproduced the grey-band defect it was built to fix.
 *
 * **The configuration is a keyed schedule, not chips.** `ConfigurationChips`
 * showed bed/bath/car as unlabelled icon pills and omitted land entirely.
 * A dash in a cell whose key is drawn beside it is unambiguous — which is
 * why the "name an absence, never dash it" rule that governs `TitleBlock`
 * does not bind here: that rule is about a fixed grid lying about which key
 * a value belongs to, and here the key is on the page.
 *
 */
export function StockPlate({
  item, saving, onAvailabilityChange, onRemoved,
}: StockPresentationProps) {
  const image = primaryStockImage(item);
  const title = stockItemTitle(item);
  const locality = stockItemLocality(item);
  const price = stockItemPrice(item);
  const { amount, qualifier } = splitPriceLine(price);

  return (
    <li className="bd-plate">
      <div className="bd-plate-mount">
        <StockPicture
          image={image}
          resolveUrl={builderStockImageUrl}
          className="bd-plate-frame"
          alt={`${title} — the picture shown on the marketplace`}
          emptyLabel="No picture found yet"
          emptyAction={
            <div className="mt-2">
              <BuilderPropertyImageButton
                stockItemId={item.id}
                propertyLabel={title}
                hasImage={false}
              />
            </div>
          }
        />
        {/*
          Under the picture, because everything in it is ABOUT the picture:
          where it came from, how to replace it, and which sources were read.
          It was briefly a one-line caption beside a "Plate n / m" annotation;
          the real render showed it is three lines of controls, and the sheet
          number was decoration colliding with a button.
        */}
        <div className="bd-plate-caption">
          <ImageSources item={item} showLabels />
        </div>
      </div>

      {/*
        TWO COLUMNS, AND THE SECOND ONE IS ANCHORED AT BOTH ENDS.

        The plate and its provenance cluster stand ~440px tall; the facts
        beside them fill ~250px. A third column left ~180px of dead space
        under the schedule, and merely moving the controls into the second
        column left the same void with a stack floating at the top of it —
        measured on the real component, not the harness. So the body is a
        sheet in its own right: the property is named at the head, the title
        block and its controls are set at the foot, and the space between
        them is the sheet's, bounded by a rule at each end.
      */}
      <div className="bd-plate-body">
        <div className="bd-plate-head">
          <PlateIdentity item={item} />
          {/*
            The row's own controls, in its top-right corner. `Remove` had a
            line of its own at the foot — one quiet text button 700px from
            anything, costing 52px of every row — and the head's right-hand
            side was 90% empty. It is safe here because it opens a
            confirmation naming the property; what it must not be is loud or
            adjacent to something ordinary, which is why it stays a text
            button under the status rather than beside the schedule.
          */}
          <div className="bd-plate-controls">
            <SelectionStatus item={item} />
            <RemoveProperty item={item} onRemoved={onRemoved} />
          </div>
        </div>

        <div className="bd-plate-foot">
          <SpecSchedule
            item={item}
            price={price ? amount : null}
            terms={qualifier}
            availability={
              /* Bounded. The trigger declares `w-full` for the narrow
                 presentations that used to call it, and in a 910px column
                 that drew a 908px empty select across the foot of the row. */
              <AvailabilityControl
                item={item}
                saving={saving}
                onAvailabilityChange={onAvailabilityChange}
                className="h-9 w-[12rem]"
              />
            }
          />
          {/*
            THE NOTE UNDER THE SCHEDULE, which is where a drawing puts one and
            where a builder is already looking when they notice a figure is
            wrong. It names which figures the stock list did not state and
            which the builder stated themselves — a per-row chip would say the
            same thing up to five times — and the control beside it changes its
            wording with what is outstanding.
          */}
          <StockFiguresNote item={item} />
        </div>
      </div>
    </li>
  );
}

/** What the stock list did not say, and the way to say it. */
function StockFiguresNote({ item }: { item: BuilderStockItem }) {
  const reading = describeManualStats(item);
  return (
    <div className="bd-spec-note">
      {reading.note ? <p className="bd-spec-note-text">{reading.note}</p> : null}
      <BuilderStockFiguresButton item={item} />
    </div>
  );
}

/**
 * The property, named at the head of its own sheet.
 *
 * `PropertyIdentity` is the list's shared identity block and stays exactly as
 * it is for every other caller; this is the plate's, because a plate has room
 * for two facts the row never had. The estate goes ABOVE the address as the
 * eyebrow — `stockItemTitle` deliberately leaves `development_name` out (it
 * spends the title's width twice and truncated the one part that tells two
 * packages on one lot apart), so on the list it is a fact the builder's own
 * file supplied and nothing ever drew. It is suppressed where the title
 * already carries it, because a title falls back to the estate name when the
 * row states no address at all.
 */
function PlateIdentity({ item }: { item: BuilderStockItem }) {
  const title = stockItemTitle(item);
  const locality = stockItemLocality(item);
  const estate = (item.development_name ?? item.project_name ?? '').trim();
  const eyebrow = [
    estate && !title.includes(estate) ? estate : '',
    (item.property_type ?? '').trim(),
  ].filter(Boolean).join(' · ');

  return (
    <div className="builder-stock-list-property min-w-0">
      {eyebrow ? <p className="bd-annot bd-plate-eyebrow">{eyebrow}</p> : null}
      {/* Wraps rather than truncating, for the reason the shared block
          carries: half an address identifies nothing. */}
      <p className="bd-plate-title">{title}</p>
      {locality || item.external_reference ? (
        <p className="bd-plate-place">
          {locality}
          {locality && item.external_reference ? ' · ' : ''}
          {item.external_reference ? `Ref ${item.external_reference}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * THE SCHEDULE: the offer and the specification, as one ruled object.
 *
 * A builder lives in two artefacts — the elevation and the schedule of
 * inclusions that goes with it — so the plate is the first and this is the
 * second: labels left in annotation type, figures right and tabular, a
 * hairline between every row.
 *
 * ## Why it runs DOWN the column and not across it
 *
 * Measured, on the real component rather than the harness. The plate stands
 * 306px with its provenance cluster beneath it — 410px of left column — and
 * the property's identity is 91px. A four-cell strip beside that left ~450px
 * of the row empty horizontally AND ~150px empty vertically; a full-width
 * title block across the body fixed the width and made the height worse. Six
 * stacked rows come to 216px, and 91 + 216 + 52 of controls + the column's
 * own gaps is 407px against the plate stack's 410 — so the two columns read
 * as one sheet because they actually are the same height.
 *
 * That is also what let the labels become words. `BED / BATH / CAR` was the
 * abbreviation a four-cell strip could afford.
 *
 * ## Three rules
 *
 * **A ROW WITH NOTHING IN IT PRINTS A DASH AND KEEPS ITS PLACE.** That is
 * the convention the device comes from — a drawing with no revision prints
 * `—` in the REV field rather than dropping the field — and it is what makes
 * the figures align down the sheet. A collapsing schedule would put LAND
 * where HOME was on the row above it.
 *
 * **PRICE NOT STATED IS A STATE, NOT AN ABSENCE.** A builder's sheet may
 * price on application, so the leading row says so in words at reading size
 * rather than printing a 1.5rem em dash where the figure goes — which is
 * exactly what `splitPriceLine(null)` would hand it.
 *
 * **NOTHING HERE REFORMATS THE OFFER.** The figure is the first half of
 * whatever `stockItemPrice` returned, so "From $749,000" keeps its "From"
 * and the rest of the line is set under it as the field's own note — which
 * is where it belongs: above the schedule, "fixed price, house and land"
 * read as a stray lowercase sentence qualifying nothing.
 *
 * ## Availability is a field, not a loose control
 *
 * A drawing's title block carries its STATUS, and whether a property is
 * available is a fact about it that happens to be settable. Left outside as
 * a bare select it sat 700px from anything it related to, at the foot of the
 * row, beside the one destructive control — so the quietest thing on the
 * plate and the loudest shared a line. In the schedule it is the last field,
 * and `Remove` is then the only thing outside it.
 */
function SpecSchedule({ item, price, terms, availability }: {
  item: BuilderStockItem;
  price: string | null;
  terms: string | null;
  availability: ReactNode;
}) {
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'bed', label: 'Bedrooms', value: numberOrDash(item.bedrooms) },
    { key: 'bath', label: 'Bathrooms', value: numberOrDash(item.bathrooms) },
    { key: 'car', label: 'Car spaces', value: numberOrDash(item.car_spaces) },
    { key: 'home', label: 'Home', value: areaOrDash(item.building_size_sqm) },
    { key: 'land', label: 'Land', value: areaOrDash(item.land_size_sqm) },
  ];

  return (
    <dl className="bd-spec">
      <div className="bd-spec-row bd-spec-lead">
        <dt className="bd-annot">Price</dt>
        <dd className="bd-spec-offer">
          {price
            ? <span className="bd-spec-price">{price}</span>
            : <span className="bd-spec-unpriced">On application</span>}
          {terms ? <span className="bd-spec-terms">{terms}</span> : null}
        </dd>
      </div>
      {rows.map((row) => (
        <div className="bd-spec-row" key={row.key}>
          <dt className="bd-annot">{row.label}</dt>
          <dd className="bd-spec-value">{row.value}</dd>
        </div>
      ))}
      <div className="bd-spec-row bd-spec-settable">
        <dt className="bd-annot">Availability</dt>
        <dd className="bd-spec-control">{availability}</dd>
      </div>
    </dl>
  );
}

/** An area in whole square metres, or an em dash where none is recorded. */
function areaOrDash(value: number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014';
  return `${Math.round(value).toLocaleString(AU_LOCALE)} m\u00b2`;
}

/** A count, or an em dash where the record does not state one. */
function numberOrDash(value: number | null | undefined): string {
  return value === null || value === undefined ? '\u2014' : String(value);
}
