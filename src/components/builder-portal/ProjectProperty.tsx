import { useCallback } from 'react';
import { ExternalLink, FileText, LayoutGrid, Map as MapIcon, Ruler } from 'lucide-react';

import { StockPicture } from '@/components/stock/StockPicture';
import { builderProjectImageUrl } from '@/lib/builderQueries';
import { primaryStockImage, type BuilderStockItem } from '@/lib/builderStock';
import { cn } from '@/lib/utils';
import type {
  PropertyDocumentKind, PropertyDocumentLink,
} from '../../../supabase/functions/_shared/builderStock/propertyDocuments.pure';

/**
 * AN ACTIVATED PROPERTY'S PHOTOGRAPH, ON ITS PROJECT.
 *
 * The same picture the Stock List draws — chosen by `primaryStockImage`, drawn
 * by `StockPicture` with its fit and ground — so a builder never sees one
 * house on the Stock List and another on the project it became. Only the
 * transport differs: the URL is minted by `builder-portal-projects`, because
 * project access is what opens this page.
 */
export function ProjectPropertyPicture({
  projectId, item, alt, aspectClassName, className, emptyLabel,
}: {
  projectId: string;
  item: Partial<BuilderStockItem> | null | undefined;
  alt: string;
  aspectClassName?: string;
  className?: string;
  emptyLabel?: string;
}) {
  // Stable per project: `StockPicture` re-signs whenever the resolver changes.
  const resolveUrl = useCallback(
    (imageId: string) => builderProjectImageUrl(projectId, imageId), [projectId]);
  const image = item ? primaryStockImage(item as BuilderStockItem) : null;
  return (
    <StockPicture
      image={image}
      resolveUrl={resolveUrl}
      alt={alt}
      aspectClassName={aspectClassName}
      className={className}
      emptyLabel={emptyLabel ?? 'No builder photograph for this property yet'}
    />
  );
}

const KIND_ICON: Record<PropertyDocumentKind, typeof FileText> = {
  brochure: FileText,
  floor_plan: LayoutGrid,
  site_plan: Ruler,
  estate: MapIcon,
  other: FileText,
};

/**
 * The documents the property's own stock row links to, named by the column
 * the builder filed each one under. They open in a new tab, without a
 * referrer: they are the builder's own links, served by whoever hosts them.
 */
export function PropertyDocumentsList({
  documents, className,
}: {
  documents: PropertyDocumentLink[] | null | undefined;
  className?: string;
}) {
  if (!documents?.length) return null;
  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Documents on this property's stock row
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {documents.map((document) => {
          const Icon = KIND_ICON[document.kind] ?? FileText;
          return (
            <li key={document.url}>
              <a
                href={document.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{document.label}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
