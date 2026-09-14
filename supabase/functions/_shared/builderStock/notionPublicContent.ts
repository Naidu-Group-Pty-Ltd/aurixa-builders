/**
 * Builder stock lists — retrieving a PUBLIC Notion page's actual content.
 *
 * A published Notion page serves a client-rendering shell. The stock list is
 * not in that HTML at any point: it is fetched afterwards, by the browser,
 * from Notion's own public endpoints on the same host, with no credential of
 * any kind. This module makes those same unauthenticated requests server-side
 * and hands the result to `notionRecordMap.pure.ts` to decode.
 *
 * WHAT THIS IS NOT:
 *   • It is NOT a Notion API integration. There is no key, no token, no OAuth,
 *     no setting, and nothing is read from the environment. The endpoints used
 *     are the ones a logged-out browser calls for a page that has been shared
 *     to the web; a page that has not been shared answers them with a 401,
 *     which is exactly the evidence `notion_not_public` is allowed to rest on.
 *   • It is NOT a second import pipeline. It produces a matrix. The matrix
 *     becomes CSV, the CSV goes through `runStockImport` like every other
 *     source, and nothing downstream knows Notion exists.
 *   • It executes NO JavaScript. It parses JSON.
 *
 * SSRF: every request goes through `postGuardedJson`, which applies the same
 * `assertPublicUrl` guard, the same timeouts and the same size ceiling as the
 * ordinary source fetch, refuses redirects outright, and sends no cookie,
 * Authorization header or Supabase credential. The destination is additionally
 * pinned to the SAME HOST the page was fetched from, and only when that host
 * is a Notion one — so this cannot be steered at a third address.
 */
import { postGuardedJson, SourceFetchError } from './fetchSource.ts';
import { isNotionHost } from './urlSource.pure.ts';
import {
  describeNotionPage, extractNotionPageId, matrixToCsv, mergeNotionRecordMaps,
  notionAssetUrl, notionCollectionTable, notionReadableText, notionRowAssetRefs,
  notionSimpleTableMatrices, preferredNotionViewId, withNotionRowAnchors,
  type NotionRecordMap,
} from './notionRecordMap.pure.ts';
import {
  SOURCE_ANCHOR_HEADER, settleRowAssetRoles, type AnchoredAssets, type SourceImageAsset,
} from './sourceAssets.pure.ts';
import {
  noPrimaryEvidence, roleFromExplicitField, roleFromStructuralContainer,
} from './sourceImageRole.pure.ts';

/** Rows asked for in one go. A stock list an order of magnitude larger than
 * this is not something a builder maintains by hand in Notion. */
const MAX_COLLECTION_ROWS = 1000;

/**
 * How many row PAGES may be opened to look for image blocks.
 *
 * A row's own page is a second request, so it is made only for rows Notion
 * says have a body at all (`content` is non-empty) and only up to this many.
 * On the live stock list that is zero requests: 70 rows, every one of them a
 * database row with no page body, and their imagery on the row's cover.
 */
const MAX_ROW_PAGE_FETCHES = 40;

/** Everything the recovery attempt learned. Server-side diagnostics only. */
export interface NotionRecoveryDiagnostics {
  page_id_found: boolean;
  chunk_status: number | null;
  chunk_bytes: number;
  block_type: string | null;
  has_collection: boolean;
  query_status: number | null;
  query_bytes: number;
  row_count: number;
  column_count: number;
  simple_tables: number;
  text_length: number;
  /** Rows the page supplied imagery for, and assets across all of them. */
  rows_with_source_images: number;
  source_image_assets: number;
  row_pages_fetched: number;
  /** Set only when Notion itself refused us. */
  access_denied_status: number | null;
  /**
   * The link named a view (`?v=`) the page does not have. The read is refused
   * rather than served another view, so this is the one diagnostic that says
   * the source was rejected for naming a stock list nobody could find.
   */
  requested_view_missing: boolean;
}

export type NotionRecovery =
  | {
    ok: true;
    /** Header row first, and carrying the reserved anchor column. Fed to the
     *  ordinary pipeline as CSV. */
    matrix: string[][];
    csv: string;
    /**
     * The builder's own imagery, keyed by the anchor its row carries.
     *
     * This is the half of a Notion page the import used to throw away: a row
     * owns its cover and its file properties, and flattening the record map
     * to text keeps the filename and loses the file.
     */
    assets: AnchoredAssets[];
    title: string | null;
    /** Recorded as `parse_strategy` on the audit row. */
    strategy: string;
    diagnostics: NotionRecoveryDiagnostics;
  }
  | {
    ok: true;
    matrix: null;
    /** Prose carries no per-row imagery. Present so every successful recovery
     *  answers the same question rather than the caller having to ask twice. */
    assets: AnchoredAssets[];
    /** Prose for the existing model-assisted path. */
    text: string;
    title: string | null;
    strategy: string;
    diagnostics: NotionRecoveryDiagnostics;
  }
  | {
    ok: false;
    /**
     * `access_denied` is the ONLY value that may produce
     * `notion_not_public`, and it is set only when Notion answered 401/403 or
     * named an authorisation error. Everything else means "public, but we
     * could not read a stock list out of it".
     */
    reason: 'no_page_id' | 'unreachable' | 'access_denied' | 'no_content'
      | 'requested_view_missing';
    diagnostics: NotionRecoveryDiagnostics;
  };

/**
 * Load the pages of rows that HAVE a page, and merge them into the map.
 *
 * A database row is also a page, and a builder who pastes a render into that
 * page rather than onto the row's cover has still supplied it for that exact
 * property. Notion states which rows have a body — `content` — so this opens
 * only those, and stops at `MAX_ROW_PAGE_FETCHES`. A row page that will not
 * load leaves the row with whatever its properties already gave us; it is
 * never a reason to fail the import.
 */
async function mergeRowPages(
  recordMap: NotionRecordMap,
  rowIds: string[],
  origin: URL,
  diagnostics: NotionRecoveryDiagnostics,
): Promise<NotionRecordMap> {
  const blocks = (recordMap.block && typeof recordMap.block === 'object')
    ? recordMap.block as Record<string, unknown> : {};

  let merged = recordMap;
  let fetches = 0;
  for (const rowId of rowIds) {
    if (fetches >= MAX_ROW_PAGE_FETCHES) break;
    const entry = blocks[rowId];
    const record = entry && typeof entry === 'object'
      ? unwrapRow(entry as Record<string, unknown>) : null;
    const content = Array.isArray(record?.content) ? record?.content : [];
    if (!content.length) continue;
    // Already merged by an earlier chunk.
    if (content.every((id) => typeof id === 'string' && id in blocks)) continue;

    fetches += 1;
    try {
      const chunk = await postGuardedJson(
        new URL('/api/v3/loadCachedPageChunkV2', origin.origin).toString(),
        { page: { id: rowId }, limit: 100, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
      );
      if (chunk.status < 200 || chunk.status >= 300) continue;
      merged = mergeNotionRecordMaps(merged, recordMapOf(chunk.json));
    } catch (error) {
      if (!(error instanceof SourceFetchError)) throw error;
    }
  }
  diagnostics.row_pages_fetched = fetches;
  return merged;
}

/** Descend a record-map wrapper far enough to see the block itself. */
function unwrapRow(entry: Record<string, unknown>): Record<string, unknown> | null {
  let node: unknown = entry;
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const record = node as Record<string, unknown>;
    if (typeof record.id === 'string') return record;
    if ('value' in record) { node = record.value; continue; }
    return null;
  }
  return null;
}

/**
 * Turn what each row OWNS into fetchable, attributable assets.
 *
 * The anchor is the row's block id, which is the same anchor the CSV carries,
 * so the property and its render are joined by Notion's own identifier rather
 * than by position, count or resemblance.
 */
function collectRowAssets(
  recordMap: NotionRecordMap,
  rowIds: string[],
  pageUrl: string,
  origin: URL,
): AnchoredAssets[] {
  const out: AnchoredAssets[] = [];
  for (const rowId of rowIds) {
    const refs = notionRowAssetRefs(recordMap, rowId);
    if (!refs.length) continue;

    const assets: SourceImageAsset[] = [];
    /**
     * The row's COVER is what Notion itself puts at the top of that row's page,
     * so it is the row designating its own leading image — LEVEL 3. A file
     * property is LEVEL 1 instead, judged on the property's NAME ("Facade",
     * "Floorplan"), and a loose image block inside the row's page body is the
     * row saying nothing at all.
     */
    let coverIndex = -1;
    for (const ref of refs) {
      const url = notionAssetUrl(origin.origin, ref);
      if (!url) continue;
      if (ref.origin === 'page_cover' && coverIndex < 0) coverIndex = assets.length;
      assets.push({
        url,
        // Notion's OWN name for the file, not the signed URL it resolves to.
        // The signed URL changes on every request, so keying on it would make
        // every re-import write a new row for the same picture.
        reference: ref.source.slice(0, 400),
        origin: ref.origin === 'page_cover' ? 'notion_page_cover'
          : ref.origin === 'file_property' ? 'notion_file_property'
          : ref.origin === 'image_block' ? 'notion_image_block'
          : 'notion_link_property',
        provider: 'notion',
        pageUrl,
        position: assets.length,
        // Never: a Notion delivery URL is signed and expires within the hour.
        linkFallback: false,
        role: ref.origin === 'page_cover'
          ? roleFromStructuralContainer({
            container: 'the Notion row for this property',
            designation: 'page cover',
          })
          : ref.origin === 'file_property' || ref.origin === 'link_property'
            ? roleFromExplicitField(ref.label)
            : noPrimaryEvidence(
              'this image sits in the row\'s page body and the row does not present it '
              + 'as the property\'s listing image'),
      });
    }
    if (assets.length) {
      out.push({
        anchor: `notion:${rowId}`,
        // A single explicitly named property-image property wins — that rule
        // lives in `settleRowAssetRoles`, which reads the LEVEL 1 evidence off
        // the assets themselves. The cover is the row's STRUCTURAL preference,
        // consulted only when no explicit field settles it: it leads a row
        // that names nothing, and it leads a row whose explicit fields
        // contradict each other, because between two equal claims the row's
        // own cover slot is the only designation left standing.
        assets: settleRowAssetRoles(assets, {
          container: 'the Notion row for this property',
          designation: coverIndex >= 0 ? 'page cover' : 'property image',
          preferredIndex: coverIndex >= 0 ? coverIndex : undefined,
        }),
      });
    }
  }
  return out;
}

function blankDiagnostics(): NotionRecoveryDiagnostics {
  return {
    page_id_found: false, chunk_status: null, chunk_bytes: 0, block_type: null,
    has_collection: false, query_status: null, query_bytes: 0, row_count: 0,
    column_count: 0, simple_tables: 0, text_length: 0, access_denied_status: null,
    rows_with_source_images: 0, source_image_assets: 0, row_pages_fetched: 0,
    requested_view_missing: false,
  };
}

/** Notion's own name for "you may not read this". Evidence, not inference. */
function deniedByNotion(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) return true;
  if (!body || typeof body !== 'object') return false;
  const name = String((body as Record<string, unknown>).name ?? '').toLowerCase();
  return name === 'unauthorizederror' || name === 'restrictedresourceerror';
}

function recordMapOf(body: unknown): NotionRecordMap {
  if (!body || typeof body !== 'object') return {};
  const map = (body as Record<string, unknown>).recordMap;
  return (map && typeof map === 'object') ? map as NotionRecordMap : {};
}

/** The row ids the view returned, in the order and filtering a reader sees. */
function resultBlockIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const result = (body as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return [];
  const reducers = (result as Record<string, unknown>).reducerResults;
  const group = (reducers && typeof reducers === 'object')
    ? (reducers as Record<string, unknown>).collection_group_results
    : null;
  const source = (group && typeof group === 'object') ? group : result;
  const ids = (source as Record<string, unknown>).blockIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Recover what a public Notion page actually shows.
 *
 * `finalUrl` is the address the ordinary fetch settled on and `html` is what
 * it returned; both are inputs rather than something re-fetched, so this adds
 * at most two requests to an import.
 */
export async function recoverNotionPublicContent(
  finalUrl: string,
  html: string,
): Promise<NotionRecovery> {
  const diagnostics = blankDiagnostics();

  let origin: URL;
  try {
    origin = new URL(finalUrl);
  } catch {
    return { ok: false, reason: 'unreachable', diagnostics };
  }
  // The endpoints are Notion's own, on the host the page came from. Anything
  // else is not a destination this module is willing to invent.
  if (!isNotionHost(origin.hostname)) {
    return { ok: false, reason: 'unreachable', diagnostics };
  }

  const pageId = extractNotionPageId(finalUrl, html);
  diagnostics.page_id_found = !!pageId;
  if (!pageId) return { ok: false, reason: 'no_page_id', diagnostics };

  const endpoint = (path: string) => new URL(path, origin.origin).toString();

  let chunk: { status: number; json: unknown; byteLength: number };
  try {
    chunk = await postGuardedJson(endpoint('/api/v3/loadCachedPageChunkV2'), {
      page: { id: pageId },
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    });
  } catch (error) {
    if (!(error instanceof SourceFetchError)) throw error;
    return { ok: false, reason: 'unreachable', diagnostics };
  }
  diagnostics.chunk_status = chunk.status;
  diagnostics.chunk_bytes = chunk.byteLength;

  if (deniedByNotion(chunk.status, chunk.json)) {
    diagnostics.access_denied_status = chunk.status;
    return { ok: false, reason: 'access_denied', diagnostics };
  }
  if (chunk.status < 200 || chunk.status >= 300) {
    return { ok: false, reason: 'unreachable', diagnostics };
  }

  const chunkMap = recordMapOf(chunk.json);
  const shape = describeNotionPage(chunkMap, pageId, preferredNotionViewId(finalUrl));
  diagnostics.block_type = shape.blockType;
  diagnostics.has_collection = !!shape.collectionId;

  /*
   * THE LINKED VIEW IS THE STOCK LIST. If `?v=` names a view this page does
   * not have, there is no honest way to continue: any other view is a
   * different set of properties, and importing it would replace the builder's
   * stock with somebody else's answer to a question they did not ask.
   */
  if (shape.requestedViewMissing) {
    diagnostics.requested_view_missing = true;
    return { ok: false, reason: 'requested_view_missing', diagnostics };
  }

  // (1) A database — the shape a real stock list takes. Its rows are not in
  // the chunk; the view has to be queried for them.
  if (shape.collectionId && shape.collectionViewId && shape.spaceId) {
    let query: { status: number; json: unknown; byteLength: number } | null = null;
    try {
      query = await postGuardedJson(endpoint('/api/v3/queryCollection?src=initial_load'), {
        source: { type: 'collection', id: shape.collectionId, spaceId: shape.spaceId },
        collectionView: { id: shape.collectionViewId, spaceId: shape.spaceId },
        /*
         * THE VIEW'S OWN QUERY, VERBATIM.
         *
         * A Notion view is a QUERY over a collection — a filter, a sort, a
         * grouping — and the rows a reader sees are the rows that query
         * returns. Sending an empty query here asked the COLLECTION instead,
         * so a builder who linked a filtered view of a large database would
         * have every row of it imported as their stock list. It has never
         * shown on the source that reported this because that view filters
         * nothing, which is exactly why it needed finding by reading the
         * contract rather than the symptom.
         *
         * Spread verbatim rather than translated: Notion supplies the
         * canonical structure, and re-deriving it would be a second
         * implementation of somebody else's filter language, free to disagree
         * with the page the builder is looking at.
         */
        loader: {
          type: 'reducer',
          reducers: {
            collection_group_results: { type: 'results', limit: MAX_COLLECTION_ROWS },
          },
          ...(shape.viewQuery ?? {}),
          searchQuery: '',
          userTimeZone: 'Australia/Sydney',
        },
      });
    } catch (error) {
      if (!(error instanceof SourceFetchError)) throw error;
      query = null;
    }

    if (query) {
      diagnostics.query_status = query.status;
      diagnostics.query_bytes = query.byteLength;
      if (deniedByNotion(query.status, query.json)) {
        diagnostics.access_denied_status = query.status;
        return { ok: false, reason: 'access_denied', diagnostics };
      }
      if (query.status >= 200 && query.status < 300) {
        // The row blocks come back on the query's own record map; the schema
        // and the view came back on the chunk's. Merged so the decoder sees
        // one map rather than having to know which half held what.
        let merged = mergeNotionRecordMaps(chunkMap, recordMapOf(query.json));
        const table = notionCollectionTable(merged, {
          collectionId: shape.collectionId,
          viewId: shape.collectionViewId,
          blockIds: resultBlockIds(query.json),
        });
        if (table.matrix.length > 1) {
          // A row's own page, only where Notion says it has a body. Merged in
          // so the image blocks inside it are read exactly like a cover.
          merged = await mergeRowPages(merged, table.rowIds, origin, diagnostics);

          const assets = collectRowAssets(merged, table.rowIds, finalUrl, origin);
          diagnostics.rows_with_source_images = assets.length;
          diagnostics.source_image_assets = assets
            .reduce((total, row) => total + row.assets.length, 0);

          // The anchor column travels with the rows, so the CSV that gets
          // snapshotted and re-parsed still says which Notion row each
          // property came from.
          const matrix = withNotionRowAnchors(table.matrix, table.rowIds, SOURCE_ANCHOR_HEADER);
          diagnostics.row_count = matrix.length - 1;
          diagnostics.column_count = matrix[0].length;
          return {
            ok: true,
            matrix,
            csv: matrixToCsv(matrix),
            assets,
            title: shape.title,
            strategy: 'notion_collection',
            diagnostics,
          };
        }
      }
    }
  }

  // (2) A simple `table` block on an ordinary page. A simple table has no row
  // pages and no per-row files, so there is no imagery to recover from it.
  const simple = notionSimpleTableMatrices(chunkMap);
  diagnostics.simple_tables = simple.length;
  const widest = simple.slice().sort((a, b) => b.length - a.length)[0];
  if (widest && widest.length > 1) {
    diagnostics.row_count = widest.length - 1;
    diagnostics.column_count = widest[0].length;
    return {
      ok: true,
      matrix: widest,
      csv: matrixToCsv(widest),
      assets: [],
      title: shape.title,
      strategy: 'notion_simple_table',
      diagnostics,
    };
  }

  // (3) Prose. Handed to the existing model-assisted path, which reads it
  // under the same "never invent a value" schema a brochure gets.
  const text = notionReadableText(chunkMap);
  diagnostics.text_length = text.length;
  if (text.trim().length >= 40) {
    return {
      ok: true, matrix: null, assets: [], text,
      title: shape.title, strategy: 'notion_blocks', diagnostics,
    };
  }

  return { ok: false, reason: 'no_content', diagnostics };
}
