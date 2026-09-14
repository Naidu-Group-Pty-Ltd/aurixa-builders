/**
 * Builder stock lists — writing the rows.
 *
 * Takes what `extract.ts` read, normalises it, and matches each record against
 * the stock this organisation already has before deciding to insert or update.
 *
 * Two rules carry this module:
 *
 *   MATCHING IS CONSERVATIVE. Only two keys count — the builder's own
 *   reference, and development + lot/unit with both halves present. Anything
 *   fuzzier can merge two different properties, and a merged property is a
 *   defect nobody can see. A duplicate row, by contrast, is visible and can be
 *   archived.
 *
 *   AN UPDATE NEVER ERASES. A second upload of a thinner file must not blank
 *   the fields the first one filled, so only values the new file actually
 *   carries are written. That includes availability: a row whose status column
 *   we could not read leaves the stored status alone rather than resetting it
 *   to `unknown`.
 */
import {
  coercePostcode, coerceState,
  developmentUnitMatchKey, normaliseStockRow, stockIdentityHints,
  stockMatchKeys, stockRecordLabel, storedRowDevelopmentUnitKey,
  type NormalisedStockRecord,
} from './normalise.pure.ts';
import { parseBuilderAddressLine } from '../builderStockAddress.pure.ts';
import {
  describeIdentityChange, identityDifferences, stockPropertyIdentity,
  type StockPropertyIdentity,
} from './stockIdentity.pure.ts';
import {
  lifecycleForMatchedProperty, lifecycleForNewProperty,
} from './stockLifecycle.pure.ts';
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import type { RowLinkDiscovery } from './suppliedEvidence.pure.ts';
import type { ExtractedMedia } from './extract.ts';
import {
  attributeDocumentMedia, settleContainerMediaRoles, settleRowAssetRoles,
  type AnchoredAssets, type SourceImageAsset,
} from './sourceAssets.pure.ts';
import { roleDetail, roleFromExplicitField } from './sourceImageRole.pure.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import { readAllRows } from './pagedRead.ts';
import { assignPdfMediaRolesPerProperty } from './pdfPrimaryImage.pure.ts';
import {
  carriedSanitizationFor, PROVENANCE_VERSION, storeSourceImages,
  type SourceImageFetcher,
} from './sourceImages.ts';
import { anchorPdfRowsToPages, pdfAnchorPage } from './pdfRowAnchors.pure.ts';
import { documentVisualKinds, eligibilityDetailFor } from './assessSourceImage.ts';

/** What `attachDocumentMedia` did with one picture, for a caller that counts. */
export interface AttachedMedia {
  reference: string;
  /** The property it reached, or null where the document did not say. */
  stockItemId: string | null;
  anchor: string | null;
  stored: boolean;
}

export interface ImportOutcome {
  detected: number;
  imported: number;
  updated: number;
  failed: number;
  itemIds: string[];
  /** Safe to show the uploader: a label and a short reason, never a stack. */
  failures: Array<{ label: string; reason: string }>;
  /**
   * Properties whose card now has the builder's own picture on it.
   *
   * Reported so an import can SAY whether supplied-image processing worked
   * rather than leaving a reader to infer it from an empty frame later.
   */
  withSourceImage: number;
  /**
   * IMAGERY THIS IMPORT DELIBERATELY LEFT FOR THE ENRICHMENT PASS.
   *
   * The properties are saved either way; this says only that their pictures
   * are not all attached yet, so the caller keeps the upload's settlement
   * markers open and the browser's existing loop finishes the job. See
   * `IMAGE_BUDGET_MS`.
   */
  imageryOutstanding: boolean;
  /**
   * Rows whose source anchor matched a property we hold, but which now
   * describe a DIFFERENT property.
   *
   * Reported because it is the one case where an import deliberately does not
   * carry a builder's photographs forward, and an operator who sees a card go
   * back to "No image found" is owed the reason. Each entry names the label and
   * what changed.
   */
  replacedProperties: Array<{ label: string; reason: string }>;
  /**
   * New properties written INVISIBLE, awaiting publication.
   *
   * A replacement stock list's new rows must not appear on the Marketplace as
   * blank cards the instant they are inserted — see `stockLifecycle.pure.ts`.
   * Zero here means either a first-ever upload (nothing to protect) or a list
   * whose properties all matched.
   */
  staged: number;
  /**
   * Published properties this import MATCHED whose new values are held back
   * until the cutover.
   *
   * Their rows are untouched and go on serving exactly what they served
   * before — the replacement's price, availability and description sit in
   * `pending_patch` until `publish_builder_stock_upload` applies them.
   */
  deferred: number;
  /**
   * The uploads this one supersedes: those that were supplying the rows it
   * matched, captured before their `upload_id` was re-pointed. The cutover
   * archives what they still supply and nothing else.
   */
  replacesUploadIds: string[];
  /**
   * New properties that inherited the photograph an ARCHIVED row already held
   * for the same property — what stops a delete-and-re-upload blanking the
   * Marketplace while every picture is derived again from scratch.
   */
  inheritedImagery: number;
}

interface ExistingItem {
  id: string;
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  unit_number: string | null;
  lot_number: string | null;
  /*
   * The rest are for the identity guard on the anchor key, and they are all
   * cheap columns. `source_row` is deliberately NOT read: the whole blob for
   * twenty thousand rows is megabytes an edge worker does not have, and every
   * field the identity needs is a column already — except the anchor, which
   * PostgREST projects out of the JSON for us.
   */
  address_line: string | null;
  suburb: string | null;
  building_size_sqm: number | string | null;
  lifecycle_status: string | null;
  /**
   * The upload CURRENTLY supplying this row, read BEFORE the import re-points
   * it. It is the only moment the old supplier is knowable: #2347 rewrites
   * `upload_id` on every matched row, so by cutover time the evidence of which
   * upload used to serve it is gone. See `replaces_upload_ids`.
   */
  upload_id: string | null;
  /**
   * Whether this row holds a settled photograph — read so an ARCHIVED row can
   * hand one to the row a re-import creates for the same property.
   */
  primary_image_id: string | null;
  /** `source_row->>source_anchor`, projected under this alias. */
  source_anchor: string | null;
  /**
   * `source_row->>house_design`, projected the same way and for the same
   * reason: it is part of both the match key and the identity, and it is not
   * a column of its own. A scalar out of the JSON costs what the anchor
   * costs, which is why the blob itself still stays unread.
   */
  house_design: string | null;
}

/**
 * A property an anchor currently names, and what it IS.
 *
 * The two travel together because they are one key: the anchor gets us to a
 * candidate, and the identity is the only thing that licenses carrying that
 * candidate's photographs forward.
 */
interface AnchoredProperty {
  id: string;
  identity: StockPropertyIdentity;
  /** Set on the archived index only, where it names the photograph to carry. */
  primaryImageId?: string | null;
}

/**
 * The columns the match indexes are built from.
 *
 * The anchor is projected out of `source_row` rather than joined or re-read.
 * PostgREST validates a select list before it applies permissions, so a
 * mistyped path here fails loudly with 42703 rather than arriving as
 * `undefined` — which is the one thing that must not happen to an identity
 * field. Verified against the live REST endpoint.
 */
const EXISTING_ITEM_SELECT = 'id, external_reference, development_name, project_name, '
  + 'unit_number, lot_number, address_line, suburb, building_size_sqm, '
  + 'lifecycle_status, upload_id, primary_image_id, '
  + 'source_anchor:source_row->>source_anchor, '
  + 'house_design:source_row->>house_design';

/**
 * Lend a property's settled imagery to the row a re-import just created.
 *
 * COPIES, NEVER MOVES. The archived row keeps its own image rows and its own
 * pointer, so the record of what the deleted list served survives and this can
 * never be destructive. Only `stock_item_id` and `upload_id` change on the
 * copies; every byte, verification status and provenance detail is the
 * donor's, because "is this photograph this property's" was already answered
 * for this exact property.
 */
async function carryImageryForward(
  // The same untyped client every other writer in this module takes.
  db: any,
  input: { organisationId: string; uploadId: string },
  donor: { id: string; primaryImageId: string | null },
  itemId: string,
): Promise<boolean> {
  const { data: donorImages, error: readError } = await db
    .from('builder_stock_item_images')
    .select('*')
    .eq('stock_item_id', donor.id)
    .eq('organisation_id', input.organisationId)
    .order('position', { ascending: true });
  if (readError) throw readError;
  const rows = (donorImages ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return false;

  const copies = rows.map((row) => {
    const copy = { ...row };
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    copy.stock_item_id = itemId;
    copy.upload_id = input.uploadId;
    return copy;
  });

  const { data: written, error: writeError } = await db
    .from('builder_stock_item_images').insert(copies).select('id');
  if (writeError) throw writeError;
  const inserted = (written ?? []) as Array<{ id: string }>;
  if (!inserted.length) return false;

  /*
   * Which copy leads is decided by the donor's own pointer, found by POSITION
   * in the ordered read — the one property of a row that survives copying.
   * Where the donor's pointer names nothing we copied, the first copy leads
   * and the ordinary primary enforcement corrects it, so the worst case is
   * today's behaviour.
   */
  const donorPrimaryIndex = rows.findIndex((row) => row.id === donor.primaryImageId);
  const lead = inserted[donorPrimaryIndex >= 0 ? donorPrimaryIndex : 0];
  const { error: pointError } = await db
    .from('builder_stock_items')
    .update({ primary_image_id: lead.id })
    .eq('id', itemId)
    .eq('organisation_id', input.organisationId);
  if (pointError) throw pointError;
  return true;
}

function referenceKey(item: ExistingItem): string | null {
  const value = item.external_reference?.trim().toLowerCase();
  return value || null;
}

const developmentUnitKey = storedRowDevelopmentUnitKey;

/** Only the fields the record actually carries. Null means "the file was silent". */
function writablePatch(record: NormalisedStockRecord): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (column: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '') patch[column] = value;
  };
  set('external_reference', record.external_reference);
  set('development_name', record.development_name);
  set('project_name', record.project_name);
  set('address_line', record.address_line);

  /*
   * THE PLACE, WHERE THE SOURCE HAD NO COLUMN FOR IT.
   *
   * The aliases in `normalise.pure.ts` map a HEADING onto a field, which is
   * how a spreadsheet states a suburb. A Notion database states it inside the
   * page title and has no such column, so on the 10 September 2026 list
   * `suburb` and `postcode` were null on all nineteen rows while every one of
   * them carried `Beveridge` and `3753` inside `address_line`. Measured over
   * every upload since 6 September: each CSV populated the suburb on every
   * row, and each Notion import on none.
   *
   * HERE, AND DELIBERATELY NOT IN THE RECORD. `normaliseStockRow` produces
   * what the SOURCE said, and that record is what `stockRecordLabel` and
   * `stockMatchKeys` are built from — the label a package document is
   * searched for, and the key a re-import matches on. Filling the suburb
   * there changed which PDF in a Drive folder is judged to name a property,
   * which is a different decision with a different blast radius: a row whose
   * folder offered two candidate packages became unambiguous and took one.
   * So the parse reaches the COLUMNS a card and a geocoder read, and reaches
   * nothing that decides identity.
   *
   * ONLY WHAT THE LINE NAMES, and only where the source stated nothing — a
   * builder who typed a suburb into a column meant it. The lot is left out
   * for the sharper form of the same rule: it is half of
   * `development + lot/unit + design`, and that key is consulted without the
   * identity guard the anchor gets.
   */
  const place = parseBuilderAddressLine(record.address_line);
  set('suburb', record.suburb ?? place.suburb);
  set('state', record.state ?? coerceState(place.state));
  set('postcode', record.postcode ?? coercePostcode(place.postcode));
  set('lot_number', record.lot_number);
  set('unit_number', record.unit_number);
  set('bedrooms', record.bedrooms);
  set('bathrooms', record.bathrooms);
  set('car_spaces', record.car_spaces);
  set('property_type', record.property_type);
  set('land_size_sqm', record.land_size_sqm);
  set('building_size_sqm', record.building_size_sqm);
  set('price', record.price);
  set('price_display', record.price_display);
  set('expected_completion', record.expected_completion);
  set('description', record.description);
  // `unknown` is the absence of a reading, not a reading of absence.
  if (record.availability_status !== 'unknown') {
    patch.availability_status = record.availability_status;
  }
  return patch;
}

/**
 * Resolve the existing builder project and unit a record names, when the
 * portal already holds them.
 *
 * This is what keeps the feature from duplicating the inventory model: a stock
 * row that IS a `builder_units` row links to it instead of copying it. Nothing
 * is created here — an unmatched record simply carries no unit, which is a
 * complete and correct state.
 */
async function buildInventoryIndex(db: any, organisationId: string): Promise<{
  projectByName: Map<string, string>;
  unitByProjectAndNumber: Map<string, string>;
}> {
  const projectByName = new Map<string, string>();
  const unitByProjectAndNumber = new Map<string, string>();

  const { data: projects } = await db
    .from('builder_projects')
    .select('id, name, project_reference')
    .or(`developer_organisation_id.eq.${organisationId},builder_organisation_id.eq.${organisationId}`)
    .limit(500);

  for (const project of projects ?? []) {
    const name = String(project.name ?? '').trim().toLowerCase();
    if (name) projectByName.set(name, project.id);
    const reference = String(project.project_reference ?? '').trim().toLowerCase();
    if (reference) projectByName.set(reference, project.id);
  }

  const projectIds = Array.from(new Set(Array.from(projectByName.values())));
  if (projectIds.length) {
    // Paged: `.limit(5000)` is capped at 1,000 by the API, and a unit missing
    // from this map is a unit the import cannot link. See `pagedRead.ts`.
    const unitPage = await readAllRows<{ id: string; project_id: string; unit_number: unknown }>(
      () => db
        .from('builder_units')
        .select('id, project_id, unit_number')
        .in('project_id', projectIds)
        .order('id', { ascending: true }));
    for (const unit of unitPage.rows) {
      const number = String(unit.unit_number ?? '').trim().toLowerCase();
      if (number) unitByProjectAndNumber.set(`${unit.project_id}|${number}`, unit.id);
    }
  }

  return { projectByName, unitByProjectAndNumber };
}

/**
 * HOW LONG AN IMPORT MAY SPEND ATTACHING PICTURES.
 *
 * MEASURED IN PRODUCTION, AND IT IS THE DEFECT THIS CONSTANT EXISTS FOR. This
 * function's own comment further down says "The page enriches next. Images
 * never block the import." That was the intent and it was not true: every
 * stored image is downloaded here, hashed three times and put through
 * `eligibilityDetailFor`, which decodes a thumbnail and runs the marketing
 * overlay classifier. On 27 Aug 2026 a 23-row Notion stock list did that
 * inline and the worker was killed on its RESOURCE limit ~16s in — twice, on
 * consecutive attempts.
 *
 * A KILLED WORKER IS THE WORST WAY FOR THIS TO FAIL. It emits no body and no
 * CORS headers, so the browser's fetch REJECTS rather than reading a status:
 * the portal showed "Failed to fetch" while the server had already committed
 * the upload and every property in it. The user is told the import failed by
 * the one path that cannot tell them anything else.
 *
 * So the image phase is BUDGETED and the records are not. Properties are
 * cheap and are always saved in full; pictures are expensive, are attached
 * while there is room, and whatever is left is reported as outstanding —
 * which is a state this system already knows how to finish, because
 * `enrich_images` settles exactly this and `repairSourceImagesForUpload`
 * re-reads the source (including re-fetching a Notion page for its row
 * covers) to do it.
 */
const IMAGE_BUDGET_MS = 8_000;

/**
 * And a ceiling on the COUNT, because the limit that killed the worker is CPU
 * rather than wall clock and a deadline only measures the latter. Each stored
 * image is a decode plus a classifier pass; twenty of them is the most one
 * request may take on. The rest are outstanding, not lost.
 */
const MAX_IMAGES_PER_IMPORT = 20;

/**
 * One record as `source_row` stores it, carrying the link-discovery stamp.
 *
 * The stamp rides INSIDE the row rather than on the item or the upload
 * because the row is the one thing every later reading holds: the settler
 * reads `source_row` to find a property's branches, and the fallback gate
 * reads the same column to decide whether those branches are the whole story.
 * A stamp kept anywhere else is a stamp a reader can fail to join.
 */
function stampedRow(
  record: unknown,
  discovery?: RowLinkDiscovery | null,
): Record<string, unknown> {
  const row = record as Record<string, unknown>;
  return discovery ? { ...row, link_discovery: discovery } : { ...row };
}

export async function importStockRecords(
  db: any,
  input: {
    organisationId: string;
    uploadId: string;
    builderUserId: string | null;
    rows: Array<Record<string, unknown>>;
    media: ExtractedMedia[];
    /** Imagery the source published against one of its own rows. */
    rowAssets?: AnchoredAssets[];
    /**
     * When the image phase must stop. Defaults to `IMAGE_BUDGET_MS` from now.
     * The records are never subject to it — see that constant.
     */
    imageDeadlineAt?: number;
    /**
     * The document's prose, one entry per page, for a format that paginates.
     * A PDF's properties are read out of prose and carry no anchor of their
     * own, so the page each one is described on is worked out here — see
     * `pdfRowAnchors.pure.ts`, which refuses far more often than it answers.
     */
    pageTexts?: string[];
    /**
     * Did the document's OWN page tree establish that order?
     *
     * False means a page number is the third-lowest object number rather than
     * the third page, so no page may be read as a property's cover. It defaults
     * to true only where no paginated reader ran at all.
     */
    pageOrderAuthoritative?: boolean;
    /** The uploaded document's own name, recorded on every image it yielded. */
    filename?: string | null;
    /**
     * What the import managed to see of each row's link layer — stamped onto
     * every `source_row` it writes, because the reading has to survive on the
     * ROW: the gate that decides whether the online fallback may run reads
     * stored rows, long after this run and its upload metadata are gone.
     */
    linkDiscovery?: RowLinkDiscovery | null;
  },
  /**
   * Injected for the same reason the repair injects it: the production fetcher
   * reaches for `Deno.resolveDns`, and the end-to-end contract this module now
   * owns — import produces a displayable card — has to be exercisable.
   */
  deps: { fetchImage?: SourceImageFetcher } = {},
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    detected: 0, imported: 0, updated: 0, failed: 0, itemIds: [], failures: [],
    withSourceImage: 0,
    imageryOutstanding: false,
    replacedProperties: [],
    staged: 0,
    deferred: 0,
    replacesUploadIds: [],
    inheritedImagery: 0,
  };

  /**
   * The image phase's allowance, spent by every step that stores a picture.
   *
   * `room()` is asked BEFORE each expensive step rather than after it, so the
   * step that would exceed the budget is the one that does not run. Anything
   * it declines is recorded as outstanding rather than dropped.
   */
  const imageDeadlineAt = (input.imageDeadlineAt ?? Date.now() + IMAGE_BUDGET_MS);
  let imagesStored = 0;
  const room = (): boolean => {
    if (Date.now() > imageDeadlineAt || imagesStored >= MAX_IMAGES_PER_IMPORT) {
      outcome.imageryOutstanding = true;
      return false;
    }
    return true;
  };

  /**
   * Anchor → the property it became.
   *
   * An anchor that two properties claim is demoted to null rather than
   * arbitrarily resolved: a slide holding two lots states no relationship
   * between its picture and either of them, and picking one would be exactly
   * the mis-attribution this whole path exists to prevent.
   */
  const itemIdByAnchor = new Map<string, string | null>();
  const labelByItemId = new Map<string, string>();
  const identityHintsByItemId = new Map<string, readonly string[]>();
  /**
   * Each property's own house design, for the design-cover rung — the one that
   * accepts a document naming the HOUSE where none names the LOT. The linked
   * document path has passed it since that rung existed and the uploaded-PDF
   * path never did, so an uploaded package could not reach it at all.
   */
  const designByItemId = new Map<string, string | null>();
  const claimAnchor = (anchor: string | null, itemId: string) => {
    if (!anchor) return;
    if (!itemIdByAnchor.has(anchor)) { itemIdByAnchor.set(anchor, itemId); return; }
    if (itemIdByAnchor.get(anchor) !== itemId) itemIdByAnchor.set(anchor, null);
  };

  // Normalise first, so `detected` counts properties and not spreadsheet lines.
  const records: NormalisedStockRecord[] = [];
  for (const row of input.rows) {
    const record = normaliseStockRow(row);
    if (record) records.push(record);
  }
  outcome.detected = records.length;
  if (!records.length) return outcome;

  /**
   * A paginated document's own structure, applied to records that arrived
   * without an anchor. Only records the pages actually name get one; the rest
   * stay unanchored, which is the whole point — an unanchored record's
   * photograph is stored against the upload and shown against nobody.
   */
  if (input.pageTexts?.length) {
    const photoPages = input.media
      .map((media) => pdfAnchorPage(media.anchor))
      .filter((page): page is number => page !== null);
    const anchors = anchorPdfRowsToPages(
      records.map((record) => stockRecordLabel(record)),
      input.pageTexts,
      photoPages,
      input.pageOrderAuthoritative !== false,
    );
    records.forEach((record, index) => {
      if (!record.source_anchor && anchors[index]) record.source_anchor = anchors[index];
    });
  }

  /*
   * PAGED. `.limit(20000)` was never honoured — the API caps a response at
   * 1,000 rows — so past a thousand properties this index silently held only
   * the oldest thousand, and the note below applied to every property after
   * them. `id` joins the ordering because `created_at` is not unique and
   * offset paging needs a total order. See `pagedRead.ts`.
   */
  const existingPage = await readAllRows<ExistingItem>(
    () => db
      .from('builder_stock_items')
      .select(EXISTING_ITEM_SELECT)
      .eq('organisation_id', input.organisationId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }));
  const existingRows = existingPage.rows;
  const existingError = existingPage.failed
    ? (existingPage.error as { message?: string } | null) : null;

  /*
   * A FAILED READ IS NOT AN EMPTY ORGANISATION.
   *
   * Every key below is built from this one query, so an error that is
   * discarded here matches nothing and turns the whole import into an insert
   * of duplicates — which is precisely the outcome this change exists to end,
   * reached by a different route. This repository has paid for the general
   * form of that mistake more than once: a read that FAILED is not a row that
   * is ABSENT.
   */
  if (existingError) {
    throw new Error(`Existing stock could not be read: ${existingError.message ?? 'unknown'}`);
  }

  const byReference = new Map<string, string>();
  const byDevelopmentUnit = new Map<string, string>();
  /**
   * The anchor index, and the two rules that make it safe.
   *
   * ACTIVE ROWS ONLY. An archived row is stock somebody deliberately removed,
   * and quietly reviving it because a later file mentions the same source row
   * is a decision nobody asked for. An anchor whose only rows are archived
   * behaves exactly as an unmatched anchor does: a fresh property.
   *
   * NEWEST ACTIVE ROW WINS A COLLISION, which is only safe because of the
   * identity guard below and would not be otherwise. The pre-fix history left
   * three active rows under some anchors — every re-import inserted a set and
   * the old set was archived only when the operator deleted its upload — and
   * treating that as an ambiguity to refuse would permanently disable the key
   * for exactly the properties it was built to rescue. The newest row is the
   * current meaning of that source row in both ways a collision can arise:
   * duplicates of one property, where the newest is the live one, and a source
   * row re-used for a different property, where the newest is what it now
   * describes. What decides whether anything is CARRIED FORWARD is never this
   * tie-break; it is `identityDifferences`.
   */
  const byAnchor = new Map<string, AnchoredProperty>();
  /**
   * ARCHIVED rows that still hold a photograph, indexed by anchor.
   *
   * Deleting a stock list ARCHIVES its rows and the photographs live ON those
   * rows, so a re-import of the same list inserts fresh rows holding nothing
   * and every card reads "No image found" until the engine has re-downloaded
   * and re-parsed every linked package it read an hour ago. Upload 479689a0
   * was deleted holding 20 of 23 photographs; its replacement began at zero.
   *
   * Kept separate from `byAnchor` on purpose: this index may only ever LEND a
   * photograph. It never revives a row and it is never a match key, so an
   * archived property stays archived and a new row stays a new row.
   */
  const archivedByAnchor = new Map<string, AnchoredProperty>();
  /** How much PUBLISHED stock this organisation already serves. */
  let published = 0;
  /** Item id -> the upload supplying it before this import touched anything. */
  const supplierBefore = new Map<string, string>();
  /** Item id -> its lifecycle before this import, so a match cannot publish it. */
  const lifecycleBefore = new Map<string, string | null>();
  for (const item of (existingRows ?? []) as ExistingItem[]) {
    const reference = referenceKey(item);
    if (reference) byReference.set(reference, item.id);
    const developmentUnit = developmentUnitKey(item);
    if (developmentUnit) byDevelopmentUnit.set(developmentUnit, item.id);

    /*
     * DOES THIS ORGANISATION HAVE A WORKING MARKETPLACE TO PROTECT?
     *
     * Only a PUBLISHED row counts. A staged row from an earlier, unfinished
     * replacement is invisible, so an organisation holding nothing but staged
     * rows still has an empty page — and staging again would keep it empty.
     */
    if (item.lifecycle_status === 'active') published += 1;
    /* The supplier as it stands NOW, before any of this import's re-pointing. */
    if (item.upload_id) supplierBefore.set(item.id, item.upload_id);
    lifecycleBefore.set(item.id, item.lifecycle_status);

    const anchor = item.source_anchor?.trim();
    if (!anchor) continue;
    if (item.lifecycle_status === 'archived') {
      // Oldest-first read, so the last write wins: the most recent answer.
      if (item.primary_image_id) {
        archivedByAnchor.set(anchor, {
          id: item.id,
          identity: stockPropertyIdentity(item),
          primaryImageId: item.primary_image_id,
        });
      }
      continue;
    }
    // Read oldest-first, so the last write for an anchor is the newest row.
    // The identity is computed here and only here — for the rows an anchor can
    // actually reach, rather than for every row the organisation holds.
    byAnchor.set(anchor, { id: item.id, identity: stockPropertyIdentity(item) });
  }

  const inventory = await buildInventoryIndex(db, input.organisationId);
  const now = new Date().toISOString();
  /** Uploads whose rows this one takes over. See `replacesUploadIds`. */
  const supersededUploads = new Set<string>();
  /*
   * WHERE A NEW PROPERTY STARTS. Decided ONCE, from the state before this
   * import wrote anything, so a twenty-three-row list cannot stage its first
   * row and publish its last because the count moved underneath it.
   */
  const newPropertyLifecycle = lifecycleForNewProperty({
    organisationHasPublishedStock: published > 0,
  });

  for (const record of records) {
    const label = stockRecordLabel(record);
    try {
      const keys = stockMatchKeys(record);

      /**
       * THE ANCHOR FIRST, AND ONLY WHERE IT IS STILL THE SAME PROPERTY.
       *
       * The anchor is the source's id for a ROW. It is the strongest key here
       * and the only one the live list carries, but a row can be edited or
       * re-used for the next lot in the estate, and an update in place would
       * hand the new property every photograph the old one had earned —
       * badged "Builder supplied", on the wrong house. So the row id gets us
       * to a candidate and `identityDifferences` decides whether to keep it.
       *
       * A changed identity falls through to the two property-level keys
       * rather than straight to an insert: a builder reference, or a
       * development and a lot, are statements about a PROPERTY, so if either
       * still matches, that match is better evidence than the anchor was.
       * Only when nothing matches does this become a new property — and a new
       * property starts with no imagery at all, which is the whole point.
       *
       * The row the anchor pointed at is left exactly as it is. It keeps its
       * own photographs and its own place on the marketplace; whether it
       * should still be offered is a question for deleting its upload, not
       * for a file that stopped mentioning it.
       */
      const identity = stockPropertyIdentity(record);
      const anchored = keys.anchor ? byAnchor.get(keys.anchor) : undefined;
      const anchorDifferences = anchored
        ? identityDifferences(anchored.identity, identity)
        : [];
      if (anchored && anchorDifferences.length) {
        outcome.replacedProperties.push({
          label, reason: describeIdentityChange(anchorDifferences),
        });
      }

      const existingId = (anchored && !anchorDifferences.length ? anchored.id : undefined)
        ?? (keys.reference ? byReference.get(keys.reference) : undefined)
        ?? (keys.developmentUnit
          ? byDevelopmentUnit.get(developmentUnitMatchKey(keys.developmentUnit))
          : undefined);

      const patch = writablePatch(record);

      // Link, never copy.
      const projectName = (record.project_name ?? record.development_name ?? '').trim().toLowerCase();
      const projectId = projectName ? inventory.projectByName.get(projectName) : undefined;
      if (projectId) {
        patch.builder_project_id = projectId;
        const unitNumber = (record.unit_number ?? record.lot_number ?? '').trim().toLowerCase();
        const unitId = unitNumber
          ? inventory.unitByProjectAndNumber.get(`${projectId}|${unitNumber}`)
          : undefined;
        if (unitId) patch.builder_unit_id = unitId;
      }

      let itemId: string;
      if (existingId) {
        /*
         * A MATCHED ROW KEEPS ITS OWN LIFECYCLE — this update deliberately
         * does not name `lifecycle_status`, so a published property goes on
         * serving its correct imagery throughout the replacement, which is the
         * whole point of #2347, and a still-staged one stays invisible.
         *
         * Its previous supplier is remembered instead: `upload_id` is about to
         * be re-pointed at this upload, and after that nothing can tell which
         * upload used to serve it. The cutover needs exactly that to know what
         * counts as a REMOVED property.
         */
        const previous = supplierBefore.get(existingId);
        if (previous && previous !== input.uploadId) supersededUploads.add(previous);
      }
      if (existingId) {
        /**
         * A PUBLISHED PROPERTY'S NEW VALUES ARE HELD BACK, NOT APPLIED.
         *
         * Staging fixes MEMBERSHIP and does nothing about VALUES. `patch`
         * carries price, availability, description, land and building size, and
         * writing it to a row the Marketplace is serving publishes half a
         * dataset the moment the file is imported: A's new price beside B's old
         * membership, while the replacement is still processing and might never
         * finish. Proved before this was written — the Marketplace read
         * returned 850000/reserved with C invisible and B still standing.
         *
         * So the whole patch, and the membership change with it, goes into a
         * column nothing serves. `publish_builder_stock_upload` applies it,
         * names every column it may write, and does so in the same statement
         * that promotes the staged rows and archives the removed ones.
         *
         * A PATCH RATHER THAN A REPLACEMENT ROW, because the row id must not
         * change: it is what `stock_item_id` and `primary_image_id` point at, so
         * a swap would strand this property's earned imagery on the old id.
         *
         * Only where there is something to protect, and only for a row that is
         * actually PUBLISHED. A first-ever upload, and a still-staged row from
         * an unfinished replacement, are applied directly as they always were —
         * neither is on anybody's screen.
         */
        const defer = newPropertyLifecycle === 'staged'
          && lifecycleBefore.get(existingId) === 'active';

        const { data, error } = await db
          .from('builder_stock_items')
          .update(defer ? {
            /*
             * ONLY THE SERVED VALUES AND THE MEMBERSHIP ARE HELD BACK.
             *
             * `source_row` is applied immediately because it serves nothing and
             * drives everything: it is what `repairSourceImages` reads to find
             * this property's photographs. Holding it back would mean the
             * builder's new imagery could not be looked for until the cutover —
             * and a builder photograph arriving before the cutover SHOULD
             * become the card's picture. An image that appears on a card which
             * had none is not a replacement value leaking; it is the ladder
             * doing exactly what it is for, and `chooseCardImage` guarantees it
             * can only ever be an improvement.
             */
            pending_upload_id: input.uploadId,
            pending_patch: patch,
            source_row: stampedRow(record, input.linkDiscovery),
          } : {
            ...patch,
            upload_id: input.uploadId,
            source_row: stampedRow(record, input.linkDiscovery),
            /*
             * REVIVES AN ARCHIVED ROW; NEVER PUBLISHES A STAGED ONE. This used
             * to be a flat `'active'`, which was right when there were two
             * lifecycles and would silently promote a replacement property
             * nobody had looked for yet now that there are three.
             */
            lifecycle_status: lifecycleForMatchedProperty(
              lifecycleBefore.get(existingId), newPropertyLifecycle),
            last_seen_at: now,
          })
          .eq('id', existingId)
          .eq('organisation_id', input.organisationId)
          .select('id')
          .single();
        if (error) throw error;
        itemId = data.id;
        outcome.updated += 1;
        if (defer) outcome.deferred += 1;
      } else {
        const { data, error } = await db
          .from('builder_stock_items')
          .insert({
            ...patch,
            organisation_id: input.organisationId,
            upload_id: input.uploadId,
            first_upload_id: input.uploadId,
            created_by_builder_user_id: input.builderUserId,
            source_row: stampedRow(record, input.linkDiscovery),
            availability_status: patch.availability_status ?? 'unknown',
            lifecycle_status: newPropertyLifecycle,
            last_seen_at: now,
          })
          .select('id')
          .single();
        if (error) throw error;
        itemId = data.id;
        outcome.imported += 1;
        if (newPropertyLifecycle === 'staged') outcome.staged += 1;

        /*
         * INHERIT THE PHOTOGRAPH THIS PROPERTY ALREADY HAD.
         *
         * ANCHOR TO FIND IT, IDENTITY TO LICENSE IT — never the anchor alone.
         * That rule is not new here: it is exactly what governs the live
         * anchor key above, for exactly the reason it matters more on this
         * path. A source row can be re-used for a different property, and a
         * photograph carried on the strength of a re-used row would put one
         * property's house on another's card. So the archived candidate must
         * agree on development, lot, street, design AND building size —
         * `identityDifferences` empty — before anything travels.
         *
         * It is also why the lot alone can never be the key: this library
         * holds Lot 60941 Cloverton twice and Lot 1342 Austin twice, the pairs
         * differing only in building size, and treating either pair as one
         * property would silently delete a real one.
         *
         * A failure costs the inheritance and never the import: the engine
         * derives the photograph again, which is what it does today.
         */
        const donor = keys.anchor ? archivedByAnchor.get(keys.anchor) : undefined;
        if (donor && identityDifferences(donor.identity, identity).length === 0) {
          try {
            const carried = await carryImageryForward(
              db, { organisationId: input.organisationId, uploadId: input.uploadId },
              { id: donor.id, primaryImageId: donor.primaryImageId ?? null }, itemId);
            if (carried) outcome.inheritedImagery += 1;
          } catch (error) {
            console.warn('[builderStock] imagery could not be carried forward', {
              upload_id: input.uploadId,
              stock_item_id: itemId,
              donor_item_id: donor.id,
              phase: 'imagery_inheritance',
              message: safeFailureReason(error),
            });
          }
        }

        // Keep the in-memory index current so two rows in ONE file that match
        // each other update rather than colliding on the unique index.
        const reference = keys.reference;
        if (reference) byReference.set(reference, itemId);
        if (keys.developmentUnit) {
          byDevelopmentUnit.set(developmentUnitMatchKey(keys.developmentUnit), itemId);
        }
      }

      /*
       * And the anchor, pointed at the row this record just became — on both
       * branches, because both can move it.
       *
       * It matters most in the case that got here by a CHANGED identity: the
       * anchor still names the property it USED to describe, and leaving it
       * there would make a second row carrying that anchor compare itself
       * against a property nobody is describing any more. The identity travels
       * with it, so the two halves of the key cannot drift apart.
       */
      if (keys.anchor) byAnchor.set(keys.anchor, { id: itemId, identity });

      outcome.itemIds.push(itemId);
      // The label the property was matched on, kept so a paginated source can
      // ask which page states THIS property's identity — and the identity
      // names the label leaves out, for the corroboration test alone.
      labelByItemId.set(itemId, label);
      identityHintsByItemId.set(itemId, stockIdentityHints(record));
      designByItemId.set(itemId, record.house_design ?? null);
      claimAnchor(record.source_anchor, itemId);

      /**
       * Image URLs the file itself listed are stage-1 provenance: the builder
       * supplied them, so they are `source_supplied` and not a search result.
       * The BYTES are taken now rather than the link being kept — see
       * `sourceImages.ts` — so the card does not depend on somebody else's
       * server months later.
       */
      if (record.image_urls.length && room()) {
        imagesStored += record.image_urls.length;
        await storeSourceImages(db, {
          organisationId: input.organisationId,
          uploadId: input.uploadId,
          stockItemId: itemId,
          assets: settleRowAssetRoles(
            record.image_urls.map((url, position): SourceImageAsset => ({
              url,
              reference: url.slice(0, 400),
              origin: 'stock_list_column',
              provider: 'stock_list_column',
              pageUrl: null,
              position,
              linkFallback: true,
              // LEVEL 1: the heading the URL sat under is the source saying
              // what the image is for.
              role: roleFromExplicitField(record.image_url_fields[url]),
            })),
            {
              container: 'this property\'s row',
              designation: 'property image',
              preferredIndex: record.image_urls.findIndex(
                (url) => roleFromExplicitField(record.image_url_fields[url]).evidenceLevel === 1),
            },
          ),
        }, { fetchImage: deps.fetchImage });
      }
    } catch (error) {
      outcome.failed += 1;
      if (outcome.failures.length < 25) {
        outcome.failures.push({ label, reason: safeFailureReason(error) });
      }
    }
  }

  /**
   * Imagery the SOURCE tied to one of its rows — a Notion row's cover, an
   * `<img>` inside a stock table's row. The anchor came out of the source and
   * travelled with the row; nothing here matches by order or by name.
   */
  for (const anchored of input.rowAssets ?? []) {
    const itemId = itemIdByAnchor.get(anchored.anchor);
    if (!itemId) continue;
    if (!room()) break;
    imagesStored += anchored.assets.length;
    await storeSourceImages(db, {
      organisationId: input.organisationId,
      uploadId: input.uploadId,
      stockItemId: itemId,
      assets: anchored.assets,
    }, { fetchImage: deps.fetchImage });
  }

  if (input.media.length && !room()) {
    // The document's own media is the same expensive work by another route.
    // Left whole for the enrichment pass rather than half-attributed here:
    // `attachDocumentMedia` decides roles across the WHOLE set, so running it
    // against a truncated one would be attribution on partial evidence.
    outcome.imageryOutstanding = true;
  } else await attachDocumentMedia(
    db, { ...input, documentRowCount: records.length }, outcome.itemIds, itemIdByAnchor,
    input.pageTexts?.length
      ? {
        labelByItemId,
        identityHintsByItemId,
        designByItemId,
        /*
         * One property in the document means there is nobody else in it to
         * confuse this property with, so a second lot number printed on its
         * page is context rather than a competitor. See `pageStatesIdentity`.
         */
        soleProperty: records.length === 1,
        pageTexts: input.pageTexts,
        pageOrderAuthoritative: input.pageOrderAuthoritative !== false,
      }
      : null,
  );

  /**
   * SETTLE THE POINTER. An import that stores a photograph and does not say
   * which one the property shows has not finished.
   *
   * This used to be nobody's job here. `primary_image_id` was written only by
   * `enrichStockItem` — the stage-2/3 PROVIDER loop — so a property's own
   * builder-supplied picture reached its card as a side effect of going out to
   * Google and Perplexity for pictures it did not need. Where that loop did not
   * run, and it does not run for a property it has already been through, the
   * image sat in the bucket with nothing pointing at it and the card read "No
   * image found". That is how Lot 537 Kirramingly Avenue ended up needing a
   * person to press "Source images".
   *
   * It is the same rule the repair and the marketplace apply
   * (`chooseDisplayableImage`), and it is cheap: a read of the rows this import
   * just wrote and one column. No network, no provider, no budget.
   */
  for (const itemId of new Set(outcome.itemIds)) {
    try {
      const primary = await chooseAndStorePrimaryImage(db, itemId);
      if (primary) outcome.withSourceImage += 1;
    } catch (error) {
      // An import must not fail because a pointer could not be written; the
      // property is already saved. It is logged so it is discoverable, and the
      // re-queue below means the automatic loop will try again.
      console.warn('[builderStock] primary image not settled at import', {
        upload_id: input.uploadId,
        stock_item_id: itemId,
        phase: 'primary_assignment',
        message: safeFailureReason(error),
      });
    }
  }

  /**
   * PUT EVERY TOUCHED PROPERTY BACK IN THE IMAGE QUEUE.
   *
   * `enrich_images` selects `enrichment_status in ('pending','enriching')`, and
   * an import never wrote that column — so re-importing a source updated the
   * property, attached a better image and left it in whatever state it had
   * finished in last time. `complete` meant the loop skipped it; `failed` meant
   * nothing automatic would ever look at it again, which is precisely what
   * every property became on the day the role rule shipped.
   *
   * A property this import touched has new imagery by definition, so its image
   * pipeline starts again. This is pipeline state and not property data: no
   * price, availability, configuration, selection or linkage is written here.
   */
  if (outcome.itemIds.length) {
    const touched = [...new Set(outcome.itemIds)];
    await db.from('builder_stock_items')
      .update({ enrichment_status: 'pending' })
      // Scoped like every other write in this module: an id in a list is a
      // lookup key, never authority.
      .eq('organisation_id', input.organisationId)
      .in('id', touched);

    /*
     * AND `enrichment_status` IS NOT THE ONLY LATCH. `image_work_stage` is,
     * and a property that has been through the ladder once is left `settled`
     * — which `settleItemImages` reads as "there is nothing further to try".
     * So a re-import that gave a property a document it did not have before
     * updated its price and its sizes, marked it pending, and never looked at
     * the document: exactly the shape of the defect that left twenty-six live
     * properties with a brochure the reader had only just learned to see.
     *
     * REOPENED ONLY WHERE THERE IS SOMETHING TO GAIN, in the link recovery's
     * own words and by its own rule — a property already holding an image has
     * its builder's picture, and re-running the source stage for it would
     * spend a claim to reach the same answer. The ladder's own attempt counts
     * and its banked negatives still decide what is actually re-asked; this
     * only makes the property visible to them again.
     *
     * Pipeline state, never property data: no price, availability,
     * configuration, selection or linkage is written here.
     */
    await db.from('builder_stock_items')
      .update({
        image_work_stage: 'source',
        image_work_claim_until: null,
        image_work_next_attempt_at: new Date().toISOString(),
        image_work_updated_at: new Date().toISOString(),
      })
      .eq('organisation_id', input.organisationId)
      .in('id', touched)
      .is('primary_image_id', null);
  }

  outcome.replacesUploadIds = [...supersededUploads];

  /*
   * RECORDED ON THE UPLOAD, because the cutover happens minutes or hours later
   * in a different invocation and this is the only moment the answer exists.
   *
   * Written even when empty — an upload that superseded nothing must archive
   * nothing, and a NULL that later reads as "unknown" is how a cutover talks
   * itself into archiving a stock list the builder keeps beside this one.
   *
   * Failure here is not fatal to the import: the properties are saved either
   * way, and an upload with no recorded predecessor publishes its own rows and
   * archives none — visibly wrong stock a person can remove, rather than
   * correct stock silently destroyed.
   */
  const { error: replacesError } = await db
    .from('builder_stock_uploads')
    .update({ replaces_upload_ids: outcome.replacesUploadIds })
    .eq('id', input.uploadId)
    .eq('organisation_id', input.organisationId);
  if (replacesError) {
    outcome.failures.push({
      label: 'stock list',
      reason: 'The list this one replaces could not be recorded, so removed '
        + 'properties will stay on the marketplace until the old list is deleted.',
    });
  }

  return outcome;
}

/**
 * Store the imagery found INSIDE the document.
 *
 * ATTRIBUTION IS STRUCTURAL FIRST. Every office format states where a picture
 * sits — a spreadsheet drawing is anchored to a cell, a `<w:drawing>` lives
 * inside a `<w:tr>`, a slide holds one property's schedule — and where the
 * container said so, that statement decides. Counting is what remains for a
 * format that stated nothing, and `attributeDocumentMedia` switches even that
 * off once any image in the same document carried a real anchor.
 *
 * Anything unattributed is kept against the UPLOAD with no property attached:
 * source information is never deleted, and a render of lot 12 shown against
 * lot 40 is worse than showing nothing.
 */
export async function attachDocumentMedia(
  db: any,
  input: {
    organisationId: string; uploadId: string; media: ExtractedMedia[];
    /** The document these pictures came out of, recorded on each of them. */
    filename?: string | null;
    /**
     * How many property rows the DOCUMENT stated — which can exceed the
     * imported list when rows failed to import or, in the repair, when only
     * some re-matched. The one-property containment fallback keys on this,
     * so a caller holding one match out of a twelve-row file cannot present
     * the file as a one-property document.
     */
    documentRowCount?: number;
  },
  itemIdsInOrder: string[],
  itemIdByAnchor: Map<string, string | null>,
  /**
   * The properties this upload produced, and the page text they were read out
   * of. Present for a PAGINATED source, where the role of a picture is decided
   * by which page presents the property as a package — see
   * `pdfPrimaryImage.pure.ts`. Absent for everything else, whose containment is
   * the only thing the format states.
   */
  paginated?: {
    labelByItemId: Map<string, string>;
    /** Each property's other identity names. See `pageStatesIdentity`. */
    identityHintsByItemId?: Map<string, readonly string[]>;
    /** Each property's own house design, for the design-cover rung. */
    designByItemId?: Map<string, string | null>;
    /** The document produced exactly ONE property. See `pageStatesIdentity`. */
    soleProperty?: boolean;
    pageTexts: string[];
    pageOrderAuthoritative: boolean;
  } | null,
): Promise<AttachedMedia[]> {
  const attached: AttachedMedia[] = [];
  if (!input.media.length) return attached;

  const resolvedAnchors: Record<string, string> = {};
  for (const [anchor, itemId] of itemIdByAnchor.entries()) {
    if (itemId) resolvedAnchors[anchor] = itemId;
  }
  /**
   * A PDF's photographs are attributed by the page they were drawn on and by
   * nothing else. Counting is not the fallback here: a page anchor that no
   * property claimed is the document DECLINING to say whose house that is, and
   * the answer to that is an image kept against the upload and shown against
   * nobody. Other formats keep the counting fallback they always had.
   */
  const pageAnchored = input.media.some((media) => pdfAnchorPage(media.anchor) !== null);
  const attributions = attributeDocumentMedia({
    anchors: input.media.map((media) => media.anchor ?? null),
    itemIdByAnchor: resolvedAnchors,
    itemIdsInOrder: pageAnchored ? [] : itemIdsInOrder,
    rowCount: input.documentRowCount,
  });

  /**
   * WHAT EACH PICTURE IS FOR, settled once for the whole document.
   *
   * Provenance — these bytes came from here — was already recorded and was
   * never the problem. This is the second fact: did the source present this
   * image as THIS property's listing image? Without it, "source_supplied" was
   * read as "safe to show", and a bedroom render reached a client's card.
   */
  /*
   * WHAT EACH PICTURE IS, before anything decides which one leads a card.
   *
   * Only the PDF path asks: it is the one that elects a hero from several
   * pictures on a page using the document's own emphasis, and a brochure that
   * leads with its floor plan states the plan exactly as emphatically as one
   * that leads with the house. Two live Palomino cards drew a green line
   * drawing badged "Builder supplied" for that reason.
   */
  const visualKinds = paginated
    ? await documentVisualKinds(input.media)
    : [];

  const roles = paginated
    ? assignPdfMediaRolesPerProperty({
      media: input.media,
      stockItemIds: attributions.map((attribution) => attribution.stockItemId),
      visualKinds,
      ...paginated,
    })
    : settleContainerMediaRoles({
      media: input.media.map((media) => ({ name: media.name, anchor: media.anchor ?? null })),
      stockItemIds: attributions.map((attribution) => attribution.stockItemId),
      structural: attributions.map((attribution) => attribution.structural),
      container: 'the container in the builder\'s own document',
    });

  for (const [index, media] of input.media.entries()) {
    const path = `${input.organisationId}/${input.uploadId}/document/${index}-${media.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60)}`;
    try {
      const { error: uploadError } = await db.storage
        .from(STOCK_IMAGE_BUCKET)
        .upload(path, media.bytes, { contentType: media.contentType, upsert: true });
      if (uploadError) throw uploadError;

      const attribution = attributions[index];
      const stockItemId = attribution.stockItemId;

      /*
       * WHAT A RE-IMPORT MUST NOT TAKE WITH IT.
       *
       * This is the path a builder's second upload of the same stock list runs
       * through, and the upsert below replaces `source_detail` wholesale — so
       * without this it destroys the sanitization record for bytes that have
       * not changed. See `sanitizationCarryForward`. A row with no owning
       * property has no per-property record to carry, so it is not asked.
       */
      const carried = stockItemId
        ? await carriedSanitizationFor(db, {
          stockItemId,
          sourceStage: 'uploaded_document',
          reference: media.name.slice(0, 400),
          storedSha256: media.provenance?.storedSha256 ?? null,
        })
        : {};

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: media.name.slice(0, 400),
        source_provider: 'uploaded_file',
        storage_bucket: STOCK_IMAGE_BUCKET,
        storage_path: path,
        content_type: media.contentType,
        byte_size: media.bytes.length,
        verification_status: 'source_supplied',
        confidence: stockItemId ? 1 : null,
        processing_status: 'ready',
        position: index,
        source_detail: {
          // The origin every embedded-document image shares, stamped so a
          // census can SEE this path — it used to write no origin at all, and
          // every row it produced landed in the legacy no-origin bucket.
          origin: 'document_media',
          attributed: !!stockItemId,
          structural: attribution.structural,
          anchor: media.anchor ?? null,
          reason: attribution.reason,
          // What the enumeration that produced this entry looked like, when
          // the extractor recorded one. A truncated read is a fact about the
          // row, not a silence.
          ...(media.enumeration ? { enumeration: media.enumeration } : {}),
          ...roleDetail(roles[index]),
          // Whether the marketplace may DRAW it. Every format lands here or
          // in `sourceImages.ts`, and both ask the same question of the bytes.
          ...await eligibilityDetailFor(media.bytes, roles[index].role),
          upload_id: input.uploadId,
          stock_item_id: stockItemId,
          filename: input.filename ?? null,
          /**
           * Where in the builder's own document this came from, and what it
           * hashes to at both ends. This is the record that makes
           * "source_supplied" a fact somebody can check rather than a label.
           */
          ...(media.provenance
            ? {
              page: media.provenance.page,
              method: media.provenance.method,
              object_number: media.provenance.objectNumber,
              resource_name: media.provenance.resourceName,
              source_width: media.provenance.sourceWidth,
              source_height: media.provenance.sourceHeight,
              source_sha256: media.provenance.sourceSha256,
              stored_sha256: media.provenance.storedSha256,
              crop: media.provenance.crop,
              page_area_share: media.provenance.pageAreaShare,
              transformation: media.provenance.transformation,
              // Stamped only where the origin is actually recorded, because
              // this is the version the re-audit trusts.
              provenance_version: PROVENANCE_VERSION,
            }
            : {}),
          // Last, so a re-import cannot lose what another stage established
          // about these exact bytes — and only ever the keys that stage owns.
          ...carried,
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });
      attached.push({
        reference: media.name.slice(0, 400),
        stockItemId,
        anchor: media.anchor ?? null,
        stored: true,
      });
    } catch {
      // A document image that will not store must not fail the import. The
      // property is already saved and stages 2 and 3 still run.
      attached.push({
        reference: media.name.slice(0, 400),
        stockItemId: null,
        anchor: media.anchor ?? null,
        stored: false,
      });
    }
  }
  return attached;
}

function safeFailureReason(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error ?? '');
  if (/duplicate key/i.test(message)) return 'A matching property already exists in your stock.';
  if (/violates check constraint/i.test(message)) return 'A value in this row is outside the allowed range.';
  if (/invalid input syntax/i.test(message)) return 'A value in this row could not be read.';
  return 'This row could not be saved.';
}
