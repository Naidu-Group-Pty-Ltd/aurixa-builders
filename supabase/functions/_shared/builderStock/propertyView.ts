/**
 * BUILDER STOCK — A PROPERTY AS A PROJECT PAGE SHOWS IT.
 *
 * The Projects page is where an activated property is worked on, and it must
 * show the property exactly as the Stock List does: the same figures, the
 * builder's own stated figures laid over the extraction, the same photograph
 * chosen by the same rule. This is the read that makes that true.
 *
 * WHAT IT REUSES, AND WHY THAT IS THE WHOLE POINT. The overlay is
 * `applyManualStatsToAll(items.map(applyStatedLocation))` — the exact call
 * `builder-portal-stock`'s `decorateItems` makes, in the same order, because
 * `applyManualStats` rewrites `manual_stats` and a stated location read after
 * it would read nothing. The images are `STOCK_IMAGE_SELECT` ordered by
 * position, the rows the browser's `primaryStockImage` ranks — so the picture
 * a project shows is the picture the Stock List shows, chosen by one function.
 * The provenance of brochure figures is `figuresSuppliedByDocument`.
 *
 * WHAT IT ADDS: the documents the property's own row links to
 * (`propertyDocumentLinks`), which a property page offers to open.
 *
 * EVERY READ IS PINNED TO THE ORGANISATION. A stock item id reaches here from
 * a project the caller may see; the filter is what stops a project reachable
 * through a developer-side grant from showing another organisation's property.
 */
import { STOCK_IMAGE_SELECT, STOCK_ITEM_SELECT } from './projection.pure.ts';
import { applyManualStatsToAll, manualStatFields } from './manualStats.pure.ts';
import { applyStatedLocation } from './statedLocation.pure.ts';
import { figuresSuppliedByDocument } from './brochureFigures.pure.ts';
import { propertyDocumentLinks, type PropertyDocumentLink } from './propertyDocuments.pure.ts';

export interface PropertyView {
  /** The property as the Stock List serves it, with `images` and figure provenance. */
  item: Record<string, unknown>;
  documents: PropertyDocumentLink[];
}

export async function readPropertyViews(
  db: any,
  args: { organisationId: string; stockItemIds: readonly string[] },
): Promise<Map<string, PropertyView>> {
  const organisationId = args.organisationId;
  const ids = Array.from(new Set(args.stockItemIds.filter(Boolean)));
  const views = new Map<string, PropertyView>();
  if (!organisationId || !ids.length) return views;

  const [{ data: rawItems, error: itemsError }, { data: images }, { data: rows }] = await Promise.all([
    db.from('builder_stock_items')
      .select(STOCK_ITEM_SELECT)
      .in('id', ids)
      .eq('organisation_id', organisationId),
    db.from('builder_stock_item_images')
      .select(STOCK_IMAGE_SELECT)
      .in('stock_item_id', ids)
      .eq('organisation_id', organisationId)
      .order('position', { ascending: true }),
    db.from('builder_stock_items')
      .select('id, source_row, document_figures')
      .in('id', ids)
      .eq('organisation_id', organisationId),
  ]);
  if (itemsError) throw itemsError;

  const items: any[] = applyManualStatsToAll((rawItems ?? []).map(applyStatedLocation));

  const imagesByItem = new Map<string, any[]>();
  for (const image of images ?? []) {
    const list = imagesByItem.get(image.stock_item_id) ?? [];
    list.push(image);
    imagesByItem.set(image.stock_item_id, list);
  }
  const rowById = new Map<string, any>((rows ?? []).map((row: any) => [String(row.id), row]));

  for (const item of items) {
    const row = rowById.get(String(item.id)) ?? null;
    const sourceRow = (row?.source_row ?? null) as Record<string, unknown> | null;
    views.set(String(item.id), {
      item: {
        ...item,
        images: imagesByItem.get(item.id) ?? [],
        document_figure_fields: figuresSuppliedByDocument({
          documentFigures: row?.document_figures ?? null,
          row: item,
          sourceRow,
          stated: manualStatFields(item),
        }),
      },
      documents: propertyDocumentLinks(sourceRow),
    });
  }
  return views;
}
