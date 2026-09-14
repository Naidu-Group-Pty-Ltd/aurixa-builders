/**
 * Builder stock lists — shared client types and labels.
 *
 * One module for both audiences. The Builder Portal and the Command Centre
 * render the same properties with the same wording, and a status that reads
 * "Sold" on one side and "sold" on the other is how two surfaces stop looking
 * like one product.
 *
 * The vocabularies here are re-exported from the edge function's pure modules
 * where one already exists, so the browser cannot offer a value the server
 * would reject.
 */
import { addressWithoutLeadingDesignation } from '../../supabase/functions/_shared/builderStock/normalise.pure';
import { parseBuilderAddressLine } from '../../supabase/functions/_shared/builderStockAddress.pure';
/*
 * The five figures a builder may state, and the rules for each, imported
 * rather than restated — what the dialog asks for and what the server accepts
 * cannot become two standards. Same move `assessPepEvidence` makes.
 */
import {
  MANUAL_STAT_SPECS, MANUAL_STAT_FIELDS, manualStatFields,
  type ManualStatField, type ManualStatSpec,
} from '../../supabase/functions/_shared/builderStock/manualStats.pure';
import {
  comparePrimaryEvidence, isPrimaryRole, readStoredEvidenceLevel, readStoredRole,
} from '../../supabase/functions/_shared/builderStock/sourceImageRole.pure';
import {
  isMarketplaceEligible,
} from '../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import {
  servableClearanceFor,
  servableDerivativeFor,
} from '../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

export {
  stockFileAcceptAttribute,
  MAX_STOCK_FILE_BYTES,
  STOCK_EXTENSIONS,
} from '../../supabase/functions/_shared/builderStock/fileTypes.pure';
export {
  isPrimaryRole, readStoredRole, PRIMARY_ROLE,
  type SourceImageRole,
} from '../../supabase/functions/_shared/builderStock/sourceImageRole.pure';

export type StockUploadStatus =
  | 'uploaded' | 'parsing' | 'imported' | 'enriching' | 'complete'
  | 'partially_complete' | 'failed';

export type StockAvailability =
  | 'available' | 'on_hold' | 'reserved' | 'contracted' | 'sold' | 'settled'
  | 'withdrawn' | 'unknown';

export type StockImageStage = 'uploaded_document' | 'google_maps' | 'internet_search';

export type StockSelectionStatus =
  | 'selected' | 'builder_acknowledged' | 'progressed' | 'completed' | 'withdrawn';

export type StockSourceType = 'file' | 'url';

export interface BuilderStockUpload {
  id: string;
  organisation_id: string;
  uploaded_by_builder_user_id: string | null;
  /** How the bytes reached us. Both end in the same import pipeline. */
  source_type: StockSourceType;
  /** URL sources only: what the builder pasted, and where it settled. */
  source_url: string | null;
  final_url: string | null;
  /** A page title or shortened URL. What the history row is labelled with. */
  source_title: string | null;
  retrieved_at: string | null;
  original_filename: string;
  declared_content_type: string | null;
  detected_content_type: string | null;
  byte_size: number | null;
  status: StockUploadStatus;
  parse_strategy: string | null;
  records_detected: number;
  records_imported: number;
  records_updated: number;
  records_failed: number;
  image_stage_summary: Record<string, Record<string, number>> | null;
  error_code: string | null;
  /** Safe to display. The internal diagnosis is never sent to the browser. */
  error_message: string | null;
  /**
   * Answered by the server from the reason it recorded (which never reaches
   * the browser): brochure links are waiting to be recovered, and
   * `refresh_brochure_links` would accept this row.
   */
  link_recovery_available?: boolean;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuilderStockImage {
  id: string;
  stock_item_id: string | null;
  source_stage: StockImageStage;
  source_reference: string | null;
  source_provider: string | null;
  source_page_url: string | null;
  external_url: string | null;
  storage_path: string | null;
  content_type: string | null;
  verification_status: 'source_supplied' | 'location_derived' | 'unverified' | 'property_identity_verified';
  confidence: number | null;
  processing_status: 'pending' | 'ready' | 'unavailable' | 'failed';
  error_message: string | null;
  position: number;
  source_detail: Record<string, unknown> | null;
  created_at: string;
}

export interface BuilderStockItem {
  id: string;
  organisation_id: string;
  upload_id: string | null;
  first_upload_id: string | null;
  created_by_builder_user_id: string | null;
  builder_project_id: string | null;
  builder_unit_id: string | null;
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  unit_number: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  property_type: string | null;
  land_size_sqm: number | null;
  building_size_sqm: number | null;
  /**
   * The figures the BUILDER stated, where their stock list did not.
   *
   * The five fields above are already the EFFECTIVE values — the server lays
   * a builder's own figures over the document's in `applyManualStats`, once,
   * in the projection both this portal and the Command Centre marketplace
   * read, so the two can never disagree about one house. This field says
   * WHICH of them were typed rather than read, and `stated_*` carries what
   * the document said underneath.
   *
   * Optional because a deployment whose server predates the column sends no
   * such field, and its absence means "nothing was stated" rather than an
   * error. See `_shared/builderStock/manualStats.pure.ts`.
   */
  manual_stats?: {
    values: Partial<Record<ManualStatField, number>>;
    recorded_at: string | null;
    recorded_by: string | null;
  } | null;
  /** What the document said, where a builder overrode it. */
  stated_bedrooms?: number | null;
  stated_bathrooms?: number | null;
  stated_car_spaces?: number | null;
  stated_building_size_sqm?: number | null;
  stated_land_size_sqm?: number | null;
  /**
   * The house on the land — `Vanta 20`, `Nex 20`, `Cura 20B`.
   *
   * Projected out of `source_row` by `STOCK_ITEM_SELECT`, because it is not a
   * column of its own. It is what NAMES a package: a lot sells several houses
   * and they share the lot, the suburb, the land size and often the bed count,
   * so without this two siblings are one card drawn twice. Optional because a
   * deployment whose server predates the projection sends no such field, and
   * every reader must treat its absence as "not stated" rather than invent one.
   */
  house_design?: string | null;
  price: number | null;
  price_display: string | null;
  availability_status: StockAvailability;
  expected_completion: string | null;
  description: string | null;
  /**
   * `staged` is imported-but-not-published: a replacement stock list's new
   * properties, invisible to the Marketplace until their imagery has been
   * looked for. See `_shared/builderStock/stockLifecycle.pure.ts`.
   */
  lifecycle_status: 'active' | 'staged' | 'archived';
  enrichment_status: 'pending' | 'enriching' | 'complete' | 'partial' | 'failed';
  enriched_at: string | null;
  primary_image_id: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  /**
   * Where the imagery engine has got to on this property — the ladder's rung,
   * `settled` being the last. It reaches the browser so a row can tell a
   * picture that is still coming from one that is not: those read identically
   * without it, and a person looking at work in flight can only conclude the
   * product is broken. Optional because a deployment whose server predates
   * this sends no such field, and `stockImageProgress` treats its absence as
   * finished rather than inventing progress. */
  image_work_stage?: string | null;
  /** Attached by the server. */
  images?: BuilderStockImage[];
  /**
   * How many builder documents this property's own row attaches — a brochure,
   * a siting plan, a plan of subdivision.
   *
   * Counted by the server with the same rule the image pipeline uses to decide
   * what it will try, so this cannot claim a document the pipeline would not
   * read. It is a COUNT and never a list: saying a row attaches nothing needs
   * no address.
   *
   * Zero is the one reason for a missing picture that a builder can act on. No
   * reader conjures a document nobody attached.
   */
  source_documents?: number;
  /**
   * How many of those documents we could not read, split by whose failure it
   * was: `unprocessed` is ours, `unreachable` is the link's. Never a finding
   * about the document itself.
   *
   * A count and nothing else. Why a document could not be read is the
   * pipeline's own vocabulary — a kill, a memory ceiling, a timeout, a retry
   * tally — and none of it belongs on a builder's screen; what belongs there
   * is that the document has not been read yet. Kept apart from
   * `source_documents` because "we never read it" and "we read it and it
   * showed no house" call for opposite actions.
   */
  source_documents_unprocessed?: number;
  source_documents_unreachable?: number;
  /**
   * What the documents we DID read said about themselves, where they named no
   * picture for this property.
   *
   * The opposite case to the two counts above, and the reason it is text
   * rather than a number: those cover OUR failures and a builder can do
   * nothing with the mechanism, while this is a finding about the builder's
   * own document and is the only thing that tells a brochure with no
   * photograph apart from a brochure for the wrong property. Only `inspected`
   * refusals reach it — `stockDocumentNotes` is the gate, server-side.
   *
   * Optional because a deployment whose server predates the projection sends
   * none, and a row with none reads exactly as it did before.
   */
  source_document_notes?: Array<{ document: string; detail: string }>;
  builder_organisation?: { id: string; legal_name: string; trading_name: string | null } | null;
  selection_count?: number;
  latest_selection?: {
    id: string; status: StockSelectionStatus; selected_at: string; acknowledged_at: string | null;
  } | null;
  /** Live selections on this property. Carries no client identifier — see
   *  `decorate()` in `builder-stock-marketplace`. */
  selections?: Array<{
    id: string; status: StockSelectionStatus; selected_at: string;
  }>;
}

/** What the BUILDER is shown. No client, no adviser, no note. */
export interface BuilderStockSelectionForBuilder {
  id: string;
  stock_item_id: string;
  organisation_id: string;
  source_upload_id: string | null;
  originating_builder_user_id: string | null;
  builder_project_id: string | null;
  status: StockSelectionStatus;
  selected_at: string;
  acknowledged_at: string | null;
  acknowledged_by_builder_user_id: string | null;
  builder_reference: string | null;
  stock_item?: Partial<BuilderStockItem> | null;
}

/** What the COMMAND CENTRE is shown — it made the selection. */
export interface BuilderStockSelection extends BuilderStockSelectionForBuilder {
  client_id: string;
  selected_by_user_id: string;
  withdrawn_at: string | null;
  internal_notes: string | null;
  client?: { id: string; primary_first_name: string; primary_surname: string } | null;
  builder_organisation?: { id: string; legal_name: string; trading_name: string | null } | null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What a source row is called in the history. */
export function stockSourceLabel(upload: Pick<BuilderStockUpload,
  'source_type' | 'source_title' | 'original_filename' | 'source_url'>): string {
  if (upload.source_type === 'url') {
    return upload.source_title || upload.source_url || 'Imported page';
  }
  return upload.original_filename;
}

export const STOCK_SOURCE_TYPE_LABELS: Record<StockSourceType, string> = {
  file: 'File',
  url: 'URL',
};

export const STOCK_UPLOAD_STATUS_LABELS: Record<StockUploadStatus, string> = {
  uploaded: 'Uploaded',
  parsing: 'Reading the file',
  imported: 'Properties imported',
  enriching: 'Finding images',
  complete: 'Complete',
  partially_complete: 'Complete with issues',
  failed: 'Failed',
};

export const STOCK_UPLOAD_STATUS_CLASSES: Record<StockUploadStatus, string> = {
  uploaded: 'border-border/70 bg-muted/40 text-muted-foreground',
  parsing: 'border-primary/30 bg-primary/10 text-primary',
  imported: 'border-primary/30 bg-primary/10 text-primary',
  enriching: 'border-primary/30 bg-primary/10 text-primary',
  complete: 'border-success/30 bg-success/10 text-success',
  partially_complete: 'border-warning/30 bg-warning/10 text-warning',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export const STOCK_AVAILABILITY_LABELS: Record<StockAvailability, string> = {
  available: 'Available',
  on_hold: 'On hold',
  reserved: 'Reserved',
  contracted: 'Under contract',
  sold: 'Sold',
  settled: 'Settled',
  withdrawn: 'Withdrawn',
  unknown: 'Not stated',
};

export const STOCK_AVAILABILITY_CLASSES: Record<StockAvailability, string> = {
  available: 'border-success/30 bg-success/10 text-success',
  on_hold: 'border-warning/30 bg-warning/10 text-warning',
  reserved: 'border-warning/30 bg-warning/10 text-warning',
  contracted: 'border-primary/30 bg-primary/10 text-primary',
  sold: 'border-border/70 bg-muted/40 text-muted-foreground',
  settled: 'border-border/70 bg-muted/40 text-muted-foreground',
  withdrawn: 'border-border/70 bg-muted/40 text-muted-foreground',
  unknown: 'border-dashed border-border/70 bg-muted/30 text-muted-foreground',
};

/** Availability the marketplace still offers. Mirrors the server's set. */
export const SELECTABLE_AVAILABILITY: ReadonlySet<StockAvailability> =
  new Set<StockAvailability>(['available', 'on_hold', 'unknown']);

export const STOCK_IMAGE_STAGE_LABELS: Record<StockImageStage, string> = {
  uploaded_document: 'From the stock list',
  google_maps: 'Street View / satellite',
  internet_search: 'Found online',
};

/** The short badge that must appear wherever an image does. */
export const STOCK_IMAGE_STAGE_BADGES: Record<StockImageStage, string> = {
  uploaded_document: 'Builder supplied',
  google_maps: 'Location imagery',
  internet_search: 'Unverified',
};

export const STOCK_SELECTION_STATUS_LABELS: Record<StockSelectionStatus, string> = {
  selected: 'Selected for a client',
  builder_acknowledged: 'Acknowledged by builder',
  progressed: 'Progressing',
  completed: 'Completed',
  withdrawn: 'Withdrawn',
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * THE PICTURE FRAME'S SHAPE, AS A NUMBER THE ARITHMETIC CAN USE.
 *
 * `BuilderStockTab` draws the frame with the Tailwind literal `aspect-[16/9]`,
 * which cannot be composed from a variable without defeating the class
 * extractor — so the two are written separately and pinned together by
 * `builderStockCardPicture.test.ts` rather than trusted to stay in step.
 *
 * SIXTEEN BY NINE BECAUSE THAT IS WHAT A FACADE RENDER IS. Measured over the
 * 94 properties live on 11 September 2026:
 *
 *     1.778   66 cards   the modal shape, by a factor of six
 *                        (64 exactly 16:9, 2 at 1.7780)
 *     1.600   11 cards
 *     1.258    7 cards
 *     1.400    3 cards
 *     1.019    3 cards
 *     1.416    2 cards
 *     1.717    2 cards
 *
 * The previous frame was 16:10, fitted to a corpus of twenty-seven that a
 * later stock list replaced entirely — which is the lesson: a frame fitted to
 * one upload is wrong for the next. 16:9 is not fitted, it is what the
 * builders' rendering software emits, and 70% of the live list matches it
 * exactly.
 */
export const CARD_PICTURE_ASPECT = 16 / 9;

/**
 * HOW MUCH MAY BE CROPPED DEPENDS ON WHICH WAY THE CROP RUNS.
 *
 * This is the rule, and it is about what a facade photograph IS rather than
 * about a percentage fitted to one upload. A picture TALLER than the frame is
 * cropped top and bottom, and on a facade render that is sky and foreground
 * planting — verified by eye on the three worst-case live images, where a
 * 43% crop removed nothing but sky and shrubs and improved the composition.
 * A picture WIDER than the frame is cropped left and right, which is where a
 * house extends, and a page crop of a brochure banner can put the building
 * anywhere along it.
 *
 * So the vertical allowance is generous and the horizontal one is tight. Past
 * either, the picture is contained whole rather than cut.
 */
export const CARD_PICTURE_MAX_VERTICAL_CROP = 0.5;
export const CARD_PICTURE_MAX_HORIZONTAL_CROP = 0.2;

export type CardPictureFit = 'cover' | 'contain';

/**
 * How a picture of this shape should sit in the frame.
 *
 * A picture whose dimensions cannot be read answers `contain`: showing it
 * whole is the choice that cannot cut a house in half, so the unmeasured case
 * takes the safe one.
 */
export function cardPictureFit(width: number, height: number): CardPictureFit {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'contain';
  if (width <= 0 || height <= 0) return 'contain';
  const ratio = width / height;
  if (ratio === CARD_PICTURE_ASPECT) return 'cover';
  // Taller than the frame: covering discards HEIGHT — sky and planting.
  if (ratio < CARD_PICTURE_ASPECT) {
    return 1 - ratio / CARD_PICTURE_ASPECT <= CARD_PICTURE_MAX_VERTICAL_CROP
      ? 'cover' : 'contain';
  }
  // Wider than the frame: covering discards WIDTH — where a house extends.
  return 1 - CARD_PICTURE_ASPECT / ratio <= CARD_PICTURE_MAX_HORIZONTAL_CROP
    ? 'cover' : 'contain';
}

/**
 * What share of the frame a CONTAINED picture leaves bare.
 *
 * Only meaningful where `cardPictureFit` said `contain`; a covered picture
 * leaves none. The ground is drawn whenever a contained picture leaves any
 * worth filling.
 */
export function cardPictureGroundShare(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  if (width <= 0 || height <= 0) return 0;
  const ratio = width / height;
  return 1 - Math.min(ratio, CARD_PICTURE_ASPECT) / Math.max(ratio, CARD_PICTURE_ASPECT);
}

/** Whether a contained picture needs ground drawn behind it. */
export function cardPictureNeedsGround(width: number, height: number): boolean {
  return cardPictureFit(width, height) === 'contain'
    && cardPictureGroundShare(width, height) > 0;
}

/*
 * A LIST'S OWN DISAMBIGUATOR IS DATA, NOT A NAME.
 *
 * Where two packages are sold on one lot the source list says so in the
 * address itself — `Lot 60941 - Cloverton Estate, Kalkallo VIC 3064
 * [3 Bed · 140 m²]` — and `parseBuilderAddressLine` hands that bracketed text
 * back as the design name, because on every other row it IS one (`Ilya 15`).
 *
 * Printed verbatim it made the card say a thing twice and a different thing
 * once: the bed count is already an icon two lines below, while `140 m²` is
 * the HOUSE and the row underneath reads `286 m² land`, so one card carried
 * two unlike square-metre figures and labelled neither.
 */
const CONFIGURATION_TOKEN_SOURCE =
  '\\b\\d+(?:\\.\\d+)?\\s*'
  + '(?:bed(?:s|room|rooms)?|bath(?:s|room|rooms)?|car(?:s|\\s*spaces?)?'
  + '|garages?|m2|sqm|m\u00b2)(?![a-z0-9])';

/** Separators a list uses between those tokens, and nothing else. */
const CONFIGURATION_GLUE = /[\u00b7,;:\-\u2013\u2014/+&|]/g;

/**
 * True when every word of `text` is a bed/bath/car/size token — so the text
 * describes the package's configuration and names nothing.
 *
 * Deliberately conservative: one unrecognised word makes it a NAME, because
 * suppressing a real design name loses the only thing that tells two packages
 * apart, while keeping a stray data suffix merely looks untidy.
 */
export function describesConfigurationOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!new RegExp(CONFIGURATION_TOKEN_SOURCE, 'i').test(trimmed)) return false;
  const rest = trimmed
    .replace(new RegExp(CONFIGURATION_TOKEN_SOURCE, 'gi'), ' ')
    .replace(CONFIGURATION_GLUE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.length === 0;
}

/** The house size a configuration annotation states, where it states one. */
export function sizeFromConfiguration(text: string): number | null {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(?:m2|sqm|m\u00b2)(?![a-z0-9])/i);
  return match ? Number(match[1]) : null;
}

/**
 * THE HOUSE SIZE AS A CARD SHOWS IT: WHOLE SQUARE METRES.
 *
 * ROUNDED FOR DISPLAY AND NOWHERE ELSE. Builders quote a house plan to the
 * centimetre — seven of the thirty-one rows live on 11 September 2026 carry
 * `179.82`, `190.38`, `174.65` — and two decimals beside a whole `563 m²
 * land` reads as noise on a card that has one line for both. The COLUMN is
 * untouched and nothing here writes: `building_size_sqm` keeps every digit
 * the builder supplied, for the contract, the report and the export, and
 * this is only what a card prints.
 *
 * A size that rounds AWAY is nothing rather than `0 m²`, because `0.4 m²` is
 * a bad record and a card must never state a house has no floor area.
 */
export function homeSizeDisplay(sqm: number | null | undefined): number | null {
  if (sqm === null || sqm === undefined) return null;
  const value = Number(sqm);
  if (!Number.isFinite(value) || value <= 0) return null;
  const whole = Math.round(value);
  return whole > 0 ? whole : null;
}

/** `179.82` → `180 m² home`; a number that is not one → nothing. */
export function homeSizeLabel(sqm: number | null | undefined): string | null {
  const value = homeSizeDisplay(sqm);
  return value === null ? null : `${value} m\u00b2 home`;
}

export function stockItemTitle(item: Pick<BuilderStockItem,
  'unit_number' | 'lot_number' | 'address_line' | 'development_name'
  | 'project_name' | 'external_reference' | 'building_size_sqm'
  | 'house_design'>): string {
  /*
   * The column first, then the line. A Notion list has no Lot column — it
   * states the lot inside the title — and that lot is deliberately not
   * written to `lot_number`, because the column is half of the duplicate
   * match key and two packages on one lot would collide there. Reading it
   * here costs nothing and decides nothing.
   */
  const parsed = parseBuilderAddressLine(item.address_line);
  /*
   * THE DESIGNATION THE LINE OPENED WITH, not whichever field the parse
   * happened to fill. `Lot 1 - 13/15 Rose Street` carries BOTH — lot 1 is the
   * row, and 13 is a unit over street number 15 — and reading the unit made
   * the two dual-key halves of that address, Lot 1 and Lot 2, render as one
   * title: `Unit 13, 15 Rose Street`, twice.
   */
  const leading = /^\s*(lot|unit)\s*\.?\s*([0-9]+[a-z]?)\b/i.exec(item.address_line ?? '');
  const designation: { word: 'Lot' | 'Unit'; value: string } | null = item.unit_number
    ? { word: 'Unit', value: String(item.unit_number) }
    : item.lot_number ? { word: 'Lot', value: String(item.lot_number) }
    : leading ? { word: leading[1].toLowerCase() === 'unit' ? 'Unit' : 'Lot', value: leading[2] }
    : null;
  const prefix = designation ? `${designation.word} ${designation.value}` : '';
  /*
   * The address without the designation the prefix is about to repeat — the
   * SAME rule the server's own label applies, imported rather than restated,
   * because a card reading "Lot 1731, Lot 1731 Hornsea Street" and a log
   * reading "Lot 1731, Hornsea Street" are two answers to one question.
   */
  const address = designation
    ? addressWithoutLeadingDesignation(item.address_line, designation.word, designation.value)
    : (item.address_line ?? '');

  /*
   * AND NOT THE LOCALITY THE CARD PRINTS DIRECTLY UNDERNEATH.
   *
   * `stockItemLocality` already renders the suburb, state and postcode on
   * their own line, so a title carrying them again spends its width twice on
   * one fact — and the width is finite. Measured on the 10 September 2026
   * list, `Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]`
   * truncated at `[4 B…`, which is where the two packages offered on that one
   * lot differ; the cards for a 3-bed and a 4-bed house read identically.
   *
   * The parts come from `parseBuilderAddressLine`, the same reading the map
   * and the geocoder take, so what a card calls a property and what a pin is
   * placed by cannot drift apart.
   *
   * ONLY WHERE THE PARSE DID NOT HAVE TO GUESS, for the reason it always
   * carries: a line opening with a bare number is ambiguous and the parser
   * resolves it as a lot, so composing from its parts would turn the supplied
   * `12 Hornsea Street` into `Hornsea Street`. The parts are used where the
   * line NAMED its lot or a street number was positively identified, and
   * every other line is titled exactly as it was before.
   */
  // `13/15 Rose Street` is one address and stays one: a unit over a street
  // number says which door, and dropping it names the building instead.
  const houseNumber = parsed.unitNumber && parsed.streetNumber
    ? `${parsed.unitNumber}/${parsed.streetNumber}`
    : parsed.streetNumber;
  const street = (leading || parsed.streetNumber)
    ? [houseNumber, parsed.streetName, parsed.streetType]
      .filter(Boolean).join(' ').trim()
    : '';
  const place = street || (leading ? (parsed.estate ?? '') : '');

  const body = place || address
    || item.development_name || item.project_name || item.external_reference || '';

  /*
   * The house, where the line named one. Two packages on one lot are two
   * different things to sell — different price, different bedrooms, different
   * brochure — and the design is the only part of the line that says which.
   *
   * WHERE THE LIST SAID IT IN DATA RATHER THAN IN A NAME, THE DATA IS
   * RESTATED, NOT ECHOED. `[3 Bed · 140 m²]` is how the Cloverton rows are
   * told apart, and printed verbatim it put the bed count on a card that
   * already draws it as an icon and an unlabelled `140 m²` two lines above
   * `286 m² land`. The house size is the one fact there that the card does
   * not otherwise carry, so that is what survives — labelled, and read from
   * the column rather than from the text wherever the column has it.
   */
  /*
   * THE RECORD'S OWN FIELD FIRST, THEN THE ADDRESS LINE.
   *
   * A Notion list states the design inside the address (`… [Ilya 15]`); a
   * spreadsheet gives it a column of its own, which arrives here as
   * `house_design` and never touches `address_line` at all. Measured on the
   * 95 properties live on 11 September 2026, 35 cards across 15 lots shared
   * every other visible fact with a sibling, and the design separated all 35.
   * Reading only the address line left every one of those a card drawn twice.
   */
  const annotation = (item.house_design ?? '').trim() || (parsed.designName ?? '');
  const suffix = !annotation ? ''
    : describesConfigurationOnly(annotation)
      ? (homeSizeLabel(item.building_size_sqm)
        ?? homeSizeLabel(sizeFromConfiguration(annotation)) ?? '')
      : (body.includes(annotation) ? '' : annotation);
  const titled = suffix ? `${body} · ${suffix}` : body;

  if (prefix && titled) return `${prefix}, ${titled}`;
  return prefix || titled || 'Unnamed property';
}

export function stockItemLocality(item: Pick<BuilderStockItem,
  'suburb' | 'state' | 'postcode'>): string {
  return [item.suburb, item.state, item.postcode].filter(Boolean).join(' ');
}

/**
 * The price line.
 *
 * `price_display` wins when it exists, because it is what the builder's own
 * file said — printing "$749,000" where the schedule said "From $749,000" is a
 * different offer.
 */
export function stockItemPrice(item: Pick<BuilderStockItem, 'price' | 'price_display'>): string | null {
  if (item.price_display) return item.price_display;
  if (item.price === null || item.price === undefined) return null;
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
  }).format(item.price);
}

export function stockItemConfiguration(item: Pick<BuilderStockItem,
  'bedrooms' | 'bathrooms' | 'car_spaces'>): string | null {
  const parts: string[] = [];
  if (item.bedrooms !== null && item.bedrooms !== undefined) parts.push(`${item.bedrooms} bed`);
  if (item.bathrooms !== null && item.bathrooms !== undefined) parts.push(`${item.bathrooms} bath`);
  if (item.car_spaces !== null && item.car_spaces !== undefined) parts.push(`${item.car_spaces} car`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Is this the builder's OWN photograph, designated for this property?
 *
 * Tier 1 and 2 of the card ranking, mirroring the server's `primaryImage.ts`.
 * It is no longer the whole rule — a property with no builder image may now
 * fall back to a VERIFIED web photograph and then to Street View, in that
 * order and never above this one; see `primaryStockImage` and the server's
 * `imagePriority.pure.ts`. What has not changed is that nothing below this
 * tier may ever be badged "Builder supplied".
 */
export function isDisplayableSourceImage(image: BuilderStockImage): boolean {
  return image.source_stage === 'uploaded_document'
    && image.verification_status === 'source_supplied'
    && image.processing_status === 'ready'
    && !!(image.storage_path || image.external_url)
    && isPrimaryRole(readStoredRole(image.source_detail))
    // The stored verdict, read — never re-measured. Deciding this per card
    // would mean decoding every image on every render.
    //
    // Or the same photograph with the laid-over graphic taken off. That is a
    // derivative of THESE bytes, named by id and by SHA-256 and re-measured by
    // the same classifier, not a substitute picture. Mirrors the server's
    // `primaryImage.ts`, and both read the one rule.
    //
    // Or the same photograph with nothing wrong with it: a clearance, which is
    // the precise inspection's finding that the classifier convicted this
    // picture for a feature of the house rather than for a badge. That serves
    // the ORIGINAL — nothing was made and nothing was changed.
    && (isMarketplaceEligible(image.source_detail)
      || !!servableDerivativeFor(image.source_detail)
      || !!servableClearanceFor(image.source_detail));
}

/**
 * The card's image, or null.
 *
 * TWO THINGS CHANGED HERE, AND THE SECOND IS WHAT A CLIENT ACTUALLY SAW.
 *
 * The role check above is the first: "the builder supplied this" and "the
 * builder supplied this AS this property's listing image" are different facts,
 * and only the second belongs on a card badged "Builder supplied".
 *
 * The second is that the fallback can no longer reach an image the source did
 * not designate. It used to fall back to the lowest-`position` SOURCE image
 * whenever `primary_image_id` was absent or stale, which meant the server could
 * decline to nominate a primary and the card would show one anyway. Lot 537
 * Kirramingly Avenue is exactly that: its `primary_image_id` is null in the
 * database, and the bedroom render reached the marketplace through this
 * fallback alone. The fallback is kept — a stale pointer at a Street View must
 * still resolve to the builder's own image rather than to nothing — but it now
 * ranks only images that already passed the role check above, so there is
 * nothing for it to fall back TO unless the source designated one.
 */
/**
 * Does this image serve the builder's ORIGINAL bytes, untouched? Mirrors the
 * server's `primaryImage.ts`, as `isDisplayableSourceImage` above already
 * does: true for a measured-clean picture and for a cleared one; false for an
 * image that reaches a card only through its sanitized derivative.
 */
function servesCleanOriginal(image: BuilderStockImage): boolean {
  return isMarketplaceEligible(image.source_detail)
    || !!servableClearanceFor(image.source_detail);
}

/**
 * Is this a web-search image whose identity against THIS property was checked?
 * Mirrors the server's `imagePriority.pure.ts`. Every historical row is
 * `unverified` and none of them satisfies this.
 */
export function isVerifiedWebImage(image: BuilderStockImage): boolean {
  if (image.source_stage !== 'internet_search') return false;
  if (image.verification_status !== 'property_identity_verified') return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;
  const identity = (image.source_detail ?? {} as Record<string, unknown>)
    .property_identity as Record<string, unknown> | undefined;
  return !!identity && Array.isArray(identity.matched) && identity.matched.length > 0;
}

/**
 * Is this a Street View still of the property's own address? Satellite tiles
 * live in the same stage and are never a photograph of a house.
 */
export function isStreetViewImage(image: BuilderStockImage): boolean {
  if (image.source_stage !== 'google_maps') return false;
  if (image.processing_status !== 'ready') return false;
  if (!(image.storage_path || image.external_url)) return false;
  const detail = (image.source_detail ?? {}) as Record<string, unknown>;
  return detail.product === 'streetview' && typeof detail.address === 'string'
    && !!detail.address;
}

/** What a card may honestly say about where its picture came from. */
export type StockImageProvenance = 'builder_supplied' | 'web_sourced' | 'street_view';

export const STOCK_PROVENANCE_LABEL: Record<StockImageProvenance, string> = {
  builder_supplied: 'Builder supplied',
  web_sourced: 'Web sourced',
  street_view: 'Street View',
};

/** The provenance of one image, or null where it may not be shown at all. */
export function stockImageProvenance(
  image: BuilderStockImage,
): StockImageProvenance | null {
  if (isDisplayableSourceImage(image)) return 'builder_supplied';
  if (isVerifiedWebImage(image)) return 'web_sourced';
  if (isStreetViewImage(image)) return 'street_view';
  return null;
}

export function primaryStockImage(item: BuilderStockItem): BuilderStockImage | null {
  const displayable = (item.images ?? []).filter(isDisplayableSourceImage);

  /*
   * NO BUILDER IMAGE: THE FALLBACKS, IN ORDER. A verified web photograph of
   * this exact property first, a Street View of its address second, nothing
   * third. Both are ranked BELOW every builder row, so a source image
   * arriving later always takes the card back.
   */
  if (!displayable.length) {
    const fallback = (item.images ?? []).filter(isVerifiedWebImage);
    const tier = fallback.length ? fallback : (item.images ?? []).filter(isStreetViewImage);
    if (!tier.length) return null;
    if (item.primary_image_id) {
      const chosen = tier.find((image) => image.id === item.primary_image_id);
      if (chosen) return chosen;
    }
    return [...tier].sort((a, b) =>
      (a.position ?? 0) - (b.position ?? 0)
      || String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }

  if (item.primary_image_id) {
    const chosen = displayable.find((image) => image.id === item.primary_image_id);
    if (chosen) return chosen;
  }
  // The stored choice is missing or stale. Ranked exactly as the server ranks
  // it — a clean builder original ahead of a cleaned promotional derivative,
  // then the strength of the source's own evidence, then the order the SOURCE
  // gave them, then the id — so the two never disagree. (The clean-first key
  // is the one this mirror was missing after the server gained it: the same
  // property's clean render and repaired page cover sorted differently here
  // and there, and two surfaces showed two pictures.)
  return [...displayable].sort((a, b) =>
    (servesCleanOriginal(a) ? 0 : 1) - (servesCleanOriginal(b) ? 0 : 1)
    || comparePrimaryEvidence(
      readStoredEvidenceLevel(a.source_detail), readStoredEvidenceLevel(b.source_detail))
    || (a.position ?? 0) - (b.position ?? 0)
    || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

/** Per-stage state for the enrichment readout. */
export function stockImageStageSummary(item: BuilderStockItem): Array<{
  stage: StockImageStage; label: string; ready: number; note: string | null;
}> {
  const stages: StockImageStage[] = ['uploaded_document', 'google_maps', 'internet_search'];
  return stages.map((stage) => {
    const rows = (item.images ?? []).filter((image) => image.source_stage === stage);
    const ready = rows.filter((image) => image.processing_status === 'ready').length;
    const problem = rows.find((image) => image.processing_status !== 'ready');
    return {
      stage,
      label: STOCK_IMAGE_STAGE_LABELS[stage],
      ready,
      note: ready ? null : (problem?.error_message ?? 'Not attempted yet'),
    };
  });
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `a`, `a and b`, `a, b and c` — an English list, not a comma join. */
function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ManualStatsReading {
  /** Fields the builder stated themselves. */
  stated: ManualStatField[];
  /** Fields still empty — neither the document nor the builder gave one. */
  missing: ManualStatField[];
  /** One line under the schedule, or null where there is nothing to say. */
  note: string | null;
  /** What the control offers, which changes with what is outstanding. */
  action: string;
}

/**
 * What to say about a property's figures, under its schedule.
 *
 * ONE LINE, AND ONLY WHERE THERE IS SOMETHING TO SAY. A per-row "stated by
 * you" chip on five rows is five chips saying one thing; a drawing puts that
 * in a note under the schedule, which is also where a builder is already
 * looking when they notice a figure is wrong.
 *
 * It names WHICH fields rather than counting them, because "three figures are
 * missing" sends somebody to compare two lists to find out which three.
 *
 * The action wording follows the outstanding work: a property with an empty
 * row is offered "Add", one that is complete is offered "Edit". A control that
 * says the same thing whatever the state is a control nobody reads.
 */
export function describeManualStats(item: BuilderStockItem): ManualStatsReading {
  const stated = manualStatFields(item as unknown as Record<string, unknown>);
  const missing = MANUAL_STAT_FIELDS.filter((field) => {
    const value = (item as unknown as Record<string, unknown>)[field];
    // `0` is a stated figure — a studio has no bedroom, a townhouse may have
    // no car space — so this asks whether a number is present, never whether
    // it is truthy.
    return value === null || value === undefined || !Number.isFinite(Number(value));
  });
  const labelOf = (field: ManualStatField) => {
    const spec = MANUAL_STAT_SPECS.find((entry) => entry.field === field);
    return spec?.prose ?? (spec?.label ?? field).toLowerCase();
  };

  /*
   * LABEL FIRST, THEN THE FIELDS. The brand's voice is "precise, unhurried,
   * quietly authoritative — it states the position, names the next action, and
   * stops". The first version explained itself instead: "Bedrooms, bathrooms,
   * car spaces and home are not in your stock list · bedrooms stated by you"
   * reads as an apology, repeats "your", and joins two independent statements
   * with a middot. Naming the CONDITION first lets a builder scan the state
   * without reading the list, and the two conditions become two sentences
   * rather than one run-on.
   */
  const sentences: string[] = [];
  if (missing.length) {
    sentences.push(`Not specified in your stock list: ${sentenceList(missing.map(labelOf))}.`);
  }
  if (stated.length) {
    sentences.push(`Supplied by you: ${sentenceList(stated.map(labelOf))}.`);
  }
  const note = sentences.length ? sentences.join(' ') : null;

  return {
    stated, missing, note,
    /*
     * The act, named and stopped. "Add these figures" leant on a demonstrative
     * and "Edit figures" named a form rather than the record; both sit under a
     * ruled SCHEDULE, which is the artefact a builder already works in and the
     * noun the rest of this portal uses.
     */
    action: missing.length ? 'Complete the schedule' : 'Update the schedule',
  };
}

/*
 * Re-exported so a surface takes the whole stock vocabulary from one module,
 * the way it already takes `stockItemTitle` and the availability labels.
 */
export {
  MANUAL_STAT_SPECS, MANUAL_STAT_FIELDS, manualStatFields,
};
export type { ManualStatField, ManualStatSpec };
