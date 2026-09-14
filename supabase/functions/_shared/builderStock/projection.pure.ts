/**
 * Builder stock — what each audience is allowed to see.
 *
 * Two portals read the same four tables and they must not read the same
 * columns. The boundary is stated here, once, as data:
 *
 *   THE BUILDER learns that one of their properties was selected, when, and
 *   what stage it has reached. They do NOT learn who the client is. There is
 *   no client name, no contact detail, no internal note and no
 *   `client_id` in `BUILDER_SELECTION_SELECT` — the column is simply not
 *   selected, so a projection that forgets to strip it cannot exist.
 *
 *   THE COMMAND CENTRE sees the selection in full, including the client and
 *   the internal notes, because it made it.
 *
 * Pure: string constants and mappers, no IO.
 */

/** Stock item columns. The same set serves both audiences — a property is not
 *  private, and the organisation boundary is applied by the query, not here. */
/*
 * `house_design` IS NOT A COLUMN, AND IT IS WHAT NAMES A PACKAGE.
 *
 * A house-and-land list sells several houses on one piece of land, and the
 * design is the only thing that says which — the lot, the suburb, the land
 * size and often the bed count are shared by every sibling. Measured on the
 * 95 properties live on 11 September 2026: 75 lots, and 15 of them carry more
 * than one package, so 35 cards (37%) were indistinguishable from a sibling.
 * On every one of those 15 the design tells them apart, and there is no lot
 * where it would not.
 *
 * It lives in `source_row` rather than in a column of its own, and the
 * importer already reads it exactly like this (`EXISTING_ITEM_SELECT` in
 * `importStock.ts`) because it is half of the match key, while the package
 * uniqueness constraint keys on the same expression. This projection is the
 * one both the Marketplace and the builder's Stock List render from, and it
 * was the only reader that did not ask for it — so the database distinguished
 * two packages that both screens then drew identically.
 *
 * PostgREST validates a select list before permissions, so a mistyped path
 * here fails loudly with 42703 rather than arriving as `undefined`, which is
 * the one thing that must not happen to an identity field.
 */
/*
 * `manual_stats` — THE FIGURES THE BUILDER STATED THEMSELVES, where their
 * stock list did not. Selected here because this list is what BOTH audiences
 * read, and a property's bedroom count is not a disclosure boundary: it is
 * the same fact for the builder and for the Command Centre, and the two
 * screens disagreeing about one house is the failure this prevents. It is
 * not the effective value — `applyManualStats` overlays it on read.
 *
 * NOTHING BUT COLUMNS GOES INSIDE THE LITERAL. This note began INSIDE it,
 * which broke two ways at once: a comment in a template literal is text
 * PostgREST would receive as part of the select list, and the backticks
 * around a symbol name terminated the string and turned the rest into parsed
 * code (`TS2304: Cannot find name 'manualStatsOverlay'`). Every stock read
 * would have failed. `check-edge-functions.mjs` caught it, which is the
 * whole reason TS2304 is fatal there and never baselined.
 */
export const STOCK_ITEM_SELECT = `
  id, organisation_id, upload_id, first_upload_id, created_by_builder_user_id,
  builder_project_id, builder_unit_id, external_reference,
  development_name, project_name, address_line, suburb, state, postcode,
  lot_number, unit_number, bedrooms, bathrooms, car_spaces, property_type,
  land_size_sqm, building_size_sqm, price, price_display,
  availability_status, expected_completion, description,
  lifecycle_status, enrichment_status, enriched_at, primary_image_id,
  created_at, updated_at, last_seen_at,
  image_work_stage,
  house_design:source_row->>house_design,
  manual_stats
`;

/**
 * Source columns. `error_detail` and `storage_path` are absent: the first is
 * the internal diagnosis, the second is a location no browser needs.
 */
export const STOCK_UPLOAD_SELECT = `
  id, organisation_id, uploaded_by_builder_user_id, source_type, source_url,
  final_url, source_title, retrieved_at, original_filename,
  declared_content_type, detected_content_type, byte_size, status,
  parse_strategy, records_detected, records_imported, records_updated,
  records_failed, image_stage_summary, error_code, error_message,
  processing_started_at, processing_completed_at, created_at, updated_at
`;

export const STOCK_IMAGE_SELECT = `
  id, stock_item_id, source_stage, source_reference, source_provider,
  source_page_url, external_url, storage_path, content_type,
  verification_status, confidence, processing_status, error_message,
  position, source_detail, created_at
`;

/**
 * Selection columns for the BUILDER.
 *
 * `client_id`, `internal_notes` and `selected_by_user_id` are absent. That is
 * the control: a builder cannot be shown a column that was never read.
 */
export const BUILDER_SELECTION_SELECT = `
  id, stock_item_id, organisation_id, source_upload_id,
  originating_builder_user_id, builder_project_id, status, selected_at,
  acknowledged_at, acknowledged_by_builder_user_id, builder_reference,
  created_at, updated_at
`;

/** Selection columns for the Command Centre, which made the selection. */
export const COMMAND_SELECTION_SELECT = `
  id, stock_item_id, organisation_id, source_upload_id,
  originating_builder_user_id, builder_project_id, client_id,
  selected_by_user_id, status, selected_at, acknowledged_at,
  acknowledged_by_builder_user_id, withdrawn_at, internal_notes,
  builder_reference, created_at, updated_at
`;

/** Statuses a Command Centre user may move a selection to. */
export const COMMAND_SELECTION_STATUSES = [
  'selected', 'progressed', 'completed', 'withdrawn',
] as const;

/** Statuses the BUILDER may set. Acknowledging is the whole of their side. */
export const BUILDER_SELECTION_STATUSES = ['builder_acknowledged'] as const;

/** Availability a builder may set on their own stock. */
export const STOCK_AVAILABILITY_STATUSES = [
  'available', 'on_hold', 'reserved', 'contracted', 'sold', 'settled',
  'withdrawn', 'unknown',
] as const;

/**
 * Availability values the marketplace treats as live inventory.
 *
 * Everything else still appears — a Command Centre user needs to know a
 * property went — but it is not offered for selection.
 */
export const MARKETPLACE_SELECTABLE_AVAILABILITY: ReadonlySet<string> = new Set([
  'available', 'on_hold', 'unknown',
]);

export function isSelectableAvailability(status: string | null | undefined): boolean {
  return MARKETPLACE_SELECTABLE_AVAILABILITY.has(String(status ?? ''));
}

/** Clamp a page request. Shared so both functions paginate identically. */
export function stockPagination(body: { page?: unknown; page_size?: unknown }): {
  page: number; pageSize: number; from: number; to: number;
} {
  const page = Math.max(1, Math.min(500, Number(body.page) || 1));
  const pageSize = Math.max(1, Math.min(100, Number(body.page_size) || 25));
  const from = (page - 1) * pageSize;
  return { page, pageSize, from, to: from + pageSize - 1 };
}
