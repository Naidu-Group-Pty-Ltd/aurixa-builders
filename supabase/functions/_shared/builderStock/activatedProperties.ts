/**
 * The read behind the Agencies page's Activated Properties.
 *
 * Every query is pinned to the organisation the SESSION holds, passed in by
 * the caller and never taken from a request body. Project access is not
 * decided here: the caller hands over the existing resolver
 * (`builder_accessible_projects`), so a project party — a contact, not a user
 * — gains nothing, because nothing here reads the parties table.
 *
 * A failed read of the activations themselves is `ok: false` and never an
 * empty list: "the agency has activated nothing" and "we could not ask" are
 * different statements and the page renders them differently. The decorating
 * reads (labels, names, photograph) fail soft, because an activation without
 * its workspace's display name is still an activation.
 */
import {
  ACTIVATED_PROPERTY_ANNOUNCEMENT_SELECT,
  ACTIVATED_PROPERTY_ITEM_SELECT,
  projectActivatedProperties,
  type ActivatedProperty,
} from './activatedProperties.pure.ts';
import { STOCK_IMAGE_SELECT } from './projection.pure.ts';

export type ActivatedPropertiesRead =
  | {
    ok: true;
    records: ActivatedProperty[];
    pagination: { page: number; page_size: number; total: number; total_pages: number };
  }
  | { ok: false };

// deno-lint-ignore no-explicit-any
type Client = any;
type Row = Record<string, unknown>;

const unique = (values: unknown[]): string[] =>
  Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)));

export async function readActivatedProperties(
  supabase: Client,
  args: {
    organisationId: string;
    page: number;
    pageSize: number;
    listAccessibleProjectIds: () => Promise<string[]>;
  },
): Promise<ActivatedPropertiesRead> {
  const { organisationId, page, pageSize } = args;
  const from = (page - 1) * pageSize;

  const { data, count, error } = await supabase
    .from('builder_stock_selection_announcements')
    .select(ACTIVATED_PROPERTY_ANNOUNCEMENT_SELECT, { count: 'exact' })
    .eq('organisation_id', organisationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) return { ok: false };

  const announcements = (data ?? []) as Row[];
  const itemIds = unique(announcements.map((row) => row.stock_item_id));
  const connectionIds = unique(announcements.map((row) => row.connection_id));
  const acknowledgerIds = unique(announcements.map((row) => row.acknowledged_by_builder_user_id));

  const [itemsRead, connectionsRead, membersRead, accessible] = await Promise.all([
    itemIds.length
      ? supabase.from('builder_stock_items').select(ACTIVATED_PROPERTY_ITEM_SELECT)
        .eq('organisation_id', organisationId).in('id', itemIds)
      : Promise.resolve({ data: [] }),
    connectionIds.length
      ? supabase.from('workspace_connections').select('id, workspace_id').in('id', connectionIds)
      : Promise.resolve({ data: [] }),
    // A colleague's name is shown only if they are a member of THIS organisation.
    acknowledgerIds.length
      ? supabase.from('builder_organisation_memberships').select('builder_user_id')
        .eq('organisation_id', organisationId).in('builder_user_id', acknowledgerIds)
      : Promise.resolve({ data: [] }),
    args.listAccessibleProjectIds().catch(() => [] as string[]),
  ]);

  const items = ((itemsRead as { data?: Row[] }).data ?? []) as Row[];
  const imageIds = unique(items.map((item) => item.primary_image_id));
  const workspaceIds = unique(((connectionsRead as { data?: Row[] }).data ?? []).map((c) => c.workspace_id));
  const memberIds = unique(((membersRead as { data?: Row[] }).data ?? []).map((m) => m.builder_user_id));

  const [imagesRead, registryRead, usersRead] = await Promise.all([
    imageIds.length
      ? supabase.from('builder_stock_item_images').select(STOCK_IMAGE_SELECT)
        .in('id', imageIds).in('stock_item_id', unique(items.map((item) => item.id)))
      : Promise.resolve({ data: [] }),
    workspaceIds.length
      ? supabase.from('workspace_registry').select('id, slug, display_name').in('id', workspaceIds)
      : Promise.resolve({ data: [] }),
    memberIds.length
      ? supabase.from('builder_portal_users').select('id, name').in('id', memberIds)
      : Promise.resolve({ data: [] }),
  ]);

  const registry = new Map(((registryRead as { data?: Row[] }).data ?? [])
    .map((w) => [String(w.id), (w.display_name as string | null) || (w.slug as string | null) || null]));
  const workspaceLabelByConnection = new Map<string, string | null>(
    ((connectionsRead as { data?: Row[] }).data ?? [])
      .map((c) => [String(c.id), registry.get(String(c.workspace_id)) ?? null]),
  );
  const acknowledgerNameById = new Map<string, string | null>(
    ((usersRead as { data?: Row[] }).data ?? [])
      .map((u) => [String(u.id), (u.name as string | null) ?? null]),
  );

  const records = projectActivatedProperties({
    organisationId,
    announcements,
    items,
    images: ((imagesRead as { data?: Row[] }).data ?? []) as Row[],
    workspaceLabelByConnection,
    acknowledgerNameById,
    accessibleProjectIds: new Set(accessible),
  });

  const total = count ?? records.length;
  return {
    ok: true,
    records,
    pagination: {
      page, page_size: pageSize, total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}
