/**
 * A STOCK LIST BEING PREPARED SHOWS THE BUILDER'S OWN PROPERTIES.
 *
 * THE REGRESSION. The owner asked for one thing: a clear sign that image
 * processing was still happening. What shipped (#171) also took the per-row
 * visibility away. A new list's rows are `staged`, the marketplace list draws
 * `active` rows, and the staged section was filtered to the properties a
 * PHOTOGRAPH would release — which excludes every row the engine is still
 * working on. So a real 44-property import drew four anonymous grey
 * rectangles, and a builder could not see which properties existed or what
 * each one was waiting for.
 *
 * WHAT IS ASSERTED, in the order the states occur:
 *
 *   1. rows exist and images are working → the real lots and addresses are
 *      drawn, and the skeleton presentation is NOT used instead;
 *   2. a working row says "Finding a picture…" and is not asked for one;
 *   3. a row that gets its picture draws it;
 *   4. a terminal failure keeps the row AND offers the manual act;
 *   5. every photo ready and a list-level gate still holding → the real rows
 *      stay, the gate is named, and nothing says photos are still being found;
 *   6. once published, the ordinary marketplace presentation takes over;
 *   7. the skeletons survive only for the seconds before any row exists.
 *
 * Only the DATA is replaced. The page, its copy, its permission gate and
 * every rule it draws are the real ones, and the progress figures are shaped
 * exactly as `builder_stock_image_progress` returns them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuilderStockItem } from '@/lib/builderStock';
import {
  STOCK_IMAGE_PROGRESS_BADGE,
} from '../../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  describePublicationBlocker, publicationBlockers,
} from '../../../../supabase/functions/_shared/builderStock/publicationBlockers.pure';

const state = vi.hoisted(() => ({
  held: [] as unknown[],
  active: [] as unknown[],
  progress: [] as unknown[],
  canEdit: true,
  canDelete: true,
}));

vi.mock('@/lib/builderStockQueries', () => {
  const noop = () => {};
  const idle = {
    mutate: noop, mutateAsync: async () => undefined, isPending: false, reset: noop,
  };
  const mutation = () => idle;
  return {
    useBuilderStockItems: () => ({
      data: {
        records: state.active,
        pagination: { total: state.active.length, page: 1, page_size: 25 },
      },
      isLoading: false, isError: false,
    }),
    useBuilderStockHeldItems: () => ({ data: { records: state.held }, refetch: noop }),
    useBuilderStockUploads: () => ({
      data: { records: [], pagination: { total: 0, page: 1, page_size: 25 } },
      refetch: noop, isError: false, isLoading: false,
    }),
    useBuilderStockSelections: () => ({
      data: { records: [], pagination: { total: 0, page: 1, page_size: 25 } },
    }),
    useBuilderStockImageProgress: () => ({ data: { records: state.progress } }),
    useAcknowledgeStockSelection: mutation,
    useArchiveBuilderStockItem: mutation,
    useDeleteBuilderStockSource: mutation,
    useEnrichPendingStockImages: mutation,
    useRecoverStockSourceImages: mutation,
    useRefreshBrochureLinks: mutation,
    useReprocessStockSource: mutation,
    useRetryStockSource: mutation,
    useSetBuilderStockAvailability: mutation,
    useSetBuilderStockManualStats: mutation,
    useSupplyBuilderStockImage: mutation,
    useConfirmBrochureImage: mutation,
    useUndoBrochureImage: mutation,
    importBuilderStockUrl: noop,
    uploadBuilderStockFile: noop,
    /* The real helper SIGNS a stored object, so it answers a promise. */
    builderStockImageUrl: async () => ({ url: 'https://example.invalid/picture.jpg' }),
  };
});
vi.mock('@/components/builder-portal/BuilderPortalShell', () => ({
  BuilderPortalShell: ({
    children, actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => <div>{actions}{children}</div>,
}));
vi.mock('@/hooks/useBuilderPortalAuth', () => ({
  useBuilderPortalAuth: () => ({
    can: (_key: string, level: 'view' | 'edit' | 'delete' = 'view') => (
      level === 'delete' ? state.canDelete : level === 'edit' ? state.canEdit : true
    ),
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));

// eslint-disable-next-line import/first
import BuilderStockList from '../BuilderStockList';

/** A staged row as the portal projects one, with its image state. */
const row = (
  lot: string,
  overrides: Partial<BuilderStockItem> = {},
): BuilderStockItem => ({
  id: `item-${lot}`,
  organisation_id: 'org-1',
  address_line: `Lot ${lot}, Warragul Rise`,
  lot_number: lot,
  house_design: 'VANTA 20',
  suburb: 'Warragul', state: 'VIC', postcode: '3820',
  development_name: 'Warragul Rise',
  lifecycle_status: 'staged',
  availability_status: 'available',
  primary_image_id: null,
  image_work_stage: 'source',
  source_documents: 1,
  source_documents_unprocessed: 0,
  source_documents_unreachable: 0,
  source_links_unsupported: 0,
  source_document_notes: [],
  images: [],
  ...overrides,
} as unknown as BuilderStockItem);

/** `builder_stock_image_progress`'s own shape. */
const progress = (over: Record<string, unknown>) => ({
  upload_id: 'upload-1', total: 3, photos_ready: 0, failed: 0, working: 3,
  manifest_state: 'complete', failure_state: null, blocked_reason: null,
  published: false, pending_assets: 0, ...over,
});

function draw({ held = [] as BuilderStockItem[], active = [] as BuilderStockItem[], progressRecords = [] as unknown[] }) {
  state.held = held;
  state.active = active;
  state.progress = progressRecords;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><BuilderStockList /></QueryClientProvider>,
  );
}

const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();

/*
 * A STORED PICTURE A CARD WOULD ACTUALLY DRAW, built to
 * `isDisplayableSourceImage`'s own rule rather than to a shape that merely
 * looks right: the builder's own document, ready, filed in a column that may
 * supply a primary, with an eligible marketplace verdict.
 */
const readyImage = {
  id: 'image-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  is_primary: true,
  storage_path: 'builder-stock-images/org-1/picture.jpg',
  source_detail: {
    role: 'primary_property',
    marketplace_eligibility_state: 'eligible',
  },
};

beforeEach(() => {
  state.canEdit = true;
  state.canDelete = true;
});

describe('a list being prepared draws the builder’s own properties', () => {
  it('1. imported rows with images in flight are drawn, and skeletons do not stand in for them', () => {
    draw({
      held: [row('270'), row('271'), row('272')],
      progressRecords: [progress({ working: 3 })],
    });

    // The rows themselves: the lot a builder recognises, and its locality.
    for (const lot of ['270', '271', '272']) {
      expect(pageText()).toContain(`Lot ${lot}, Warragul Rise`);
    }
    expect(pageText()).toContain('Warragul');
    // The banner the owner asked for survives.
    expect(pageText()).toContain('Preparing your stock list — 0 of 3 photos ready');
    // And the anonymous presentation is not used in their place.
    expect(screen.queryByLabelText('Properties being prepared')).toBeNull();
  });

  it('2. a property still being worked on says so, and is not asked for a picture', () => {
    draw({ held: [row('270')], progressRecords: [progress({ working: 1, total: 1 })] });

    expect(pageText()).toContain(STOCK_IMAGE_PROGRESS_BADGE.working);
    expect(screen.queryAllByLabelText(/^Add a picture for/)).toHaveLength(0);
  });

  it('3. the picture appears on the row as soon as there is one', async () => {
    draw({
      held: [row('270', {
        primary_image_id: 'image-1',
        image_work_stage: 'settled',
        images: [readyImage],
      } as unknown as Partial<BuilderStockItem>)],
      progressRecords: [progress({ total: 1, photos_ready: 1, working: 0 })],
    });

    expect(pageText()).toContain('Lot 270, Warragul Rise');
    /*
     * The row draws the photograph itself — asserted on the drawn element
     * rather than on a word, because the badge a builder reads here is the
     * provenance one ("Builder supplied") and a page can carry that over an
     * empty frame.
     */
    const drawn = await screen.findByAltText(/the picture shown on the marketplace$/);
    expect(drawn.getAttribute('src')).toBe('https://example.invalid/picture.jpg');
    /* And it stops saying one is being looked for, or missing. */
    expect(pageText()).not.toContain(STOCK_IMAGE_PROGRESS_BADGE.working);
    expect(pageText()).not.toContain('No picture found yet');
    /* The act becomes Replace rather than Add. */
    expect(screen.queryAllByLabelText(/^Add a picture for/)).toHaveLength(0);
    expect(screen.getAllByLabelText(/^Replace the picture for/).length).toBeGreaterThan(0);
  });

  it('4. a terminal failure keeps the property visible and offers the manual act', () => {
    draw({
      held: [row('270', { image_work_stage: 'failed' } as Partial<BuilderStockItem>)],
      progressRecords: [progress({ total: 1, photos_ready: 0, failed: 1, working: 0 })],
    });

    expect(pageText()).toContain('Lot 270, Warragul Rise');
    expect(screen.getAllByLabelText(/^Add a picture for/).length).toBeGreaterThan(0);
    expect(pageText()).not.toContain(STOCK_IMAGE_PROGRESS_BADGE.working);
  });

  it('5. every photo ready with a gate still holding: rows stay, the gate is named, nothing claims to be searching', () => {
    /*
     * The 44-of-44 reading, in miniature: the engine has finished and the list
     * is held by a source file nobody has answered for. The sentence asserted
     * is the blocker module's own, so this cannot pass against invented copy.
     */
    const reading = {
      total: 3, photosReady: 3, failed: 0, working: 0,
      manifestState: 'failed', pendingAssets: 0, published: false,
    };
    const blockers = publicationBlockers(reading);
    expect(blockers).toContain('source_listing_failed');

    draw({
      held: [row('270'), row('271'), row('272')],
      progressRecords: [progress({
        total: 3, photos_ready: 3, working: 0, manifest_state: 'failed',
      })],
    });

    for (const lot of ['270', '271', '272']) {
      expect(pageText()).toContain(`Lot ${lot}, Warragul Rise`);
    }
    expect(pageText()).toContain('Your stock list is not on the marketplace yet — 3 of 3 photos ready');
    for (const blocker of blockers) {
      expect(pageText()).toContain(describePublicationBlocker(blocker, reading));
    }
    expect(pageText()).not.toContain('Preparing your stock list');
  });

  it('6. once the list is published the ordinary marketplace presentation takes over', () => {
    draw({
      active: [row('270', {
        lifecycle_status: 'active',
        primary_image_id: 'image-1',
        image_work_stage: 'settled',
        images: [readyImage],
      } as unknown as Partial<BuilderStockItem>)],
      progressRecords: [progress({ total: 1, photos_ready: 1, working: 0, published: true })],
    });

    expect(pageText()).toContain('Lot 270, Warragul Rise');
    expect(pageText()).not.toContain('Preparing your stock list');
    expect(pageText()).not.toContain('not on the marketplace yet');
    expect(screen.queryByLabelText('Properties being prepared')).toBeNull();
  });

  it('7. skeletons are drawn only while the import has produced no rows at all', () => {
    draw({ progressRecords: [progress({ total: 3, working: 3 })] });

    expect(screen.getByLabelText('Properties being prepared')).toBeTruthy();
    expect(pageText()).toContain('Preparing your stock list — 0 of 3 photos ready');
  });
});
