/**
 * THE ACTIVATION FAN-OUT AND THE STOCK MIRROR SYNC, PINNED.
 *
 * When a connected agency activates one of this network's properties, the
 * builder's team must learn of it where they actually look — the Dashboard,
 * the Tasks page and the Notifications bell — with the agency's name and
 * contact details attached. And the marketplace the Activate button lives on
 * must show THIS network's real stock, kept current by the outbound sync,
 * or the button aims at history.
 *
 * These tests pin the decisions at their source. The behavioural proof runs
 * in `scripts/db/baseline-check.mjs` against real SQL; what lives here is the
 * text of the contract, so a future edit that quietly drops the fan-out from
 * the sweep, widens the sync payload to the builder's raw row, or forgets
 * the Dashboard's entity-kind handshake has to change a named test to do it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertPayloadCrossesClean,
  BuilderNetworkPrivacyViolation,
} from '../../../supabase/functions/_shared/builderNetworkPrivacy.pure';
import {
  BUILDER_NOTIFICATION_TYPES, BUILDER_SCOPE_TYPES,
} from '../../../supabase/functions/_shared/builderCollaboration';
import {
  BUILDER_ANNOUNCEMENT_SELECT,
} from '../../../supabase/functions/_shared/builderStock/projection.pure';
import { NOTIFICATION_TYPE_LABELS } from '../builderCollaboration';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const MIGRATION = 'supabase/migrations/20260916150000_stock_activation_fanout_and_sync.sql';

describe('the fan-out is wired into the convergence path itself', () => {
  it('the sweep calls the fan-out inside the application transaction', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('PERFORM public.builder_stock_activation_fanout(v_announcement.id);');
    // And a withdrawal closes the pending work it opened.
    expect(sql).toContain("AND t.status IN ('open', 'in_progress', 'blocked')");
    expect(sql).toContain("SET status = 'cancelled'");
  });

  it('the fan-out is idempotent by key and by lock, never by hope', () => {
    const sql = read(MIGRATION);
    // The announcement row is locked: the door's opportunistic sweep and
    // pg_cron's scheduled one cannot both create the task.
    expect(sql).toContain('FOR UPDATE OF a;');
    // Notifications are unique per (announcement, member).
    expect(sql).toContain('builder_notifications_announcement_user_key');
    expect(sql).toMatch(/ON CONFLICT \(source_announcement_id, builder_user_id\)/);
  });

  it('the notification speaks the entity kind the Dashboard has always watched', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'stock_selection', v_title, v_body");
    // The Dashboard's own constant, cross-pinned so neither side can drift.
    const dashboard = read('src/pages/builder/BuilderDashboard.tsx');
    expect(dashboard).toContain("const STOCK_SELECTION_ENTITY_KIND = 'stock_selection';");
    expect(sql).toContain("'stock_selection', v_a.id, v_a.id");
  });

  it('the task carries the property, the agency and the contact — and lands assigned', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'Respond to activation: ' || v_label");
    expect(sql).toContain("E'\\nActivated by: ' || v_agency_name");
    expect(sql).toContain("E'\\nAgency contact: ' || v_contact_line");
    // Assigned to every active member: "My tasks" is where people look.
    expect(sql).toContain('INSERT INTO public.builder_task_assignments(task_id, builder_user_id');
    expect(sql).toContain('ON CONFLICT (task_id, builder_user_id) DO NOTHING');
  });

  it('the agency block is cleaned key by key and never erased by a later bare event', () => {
    const sql = read(MIGRATION);
    for (const key of ['contact_name', 'contact_email', 'contact_phone']) {
      expect(sql).toContain(`'${key}',`);
    }
    expect(sql).toContain('agency_name = COALESCE(EXCLUDED.agency_name,');
    expect(sql).toContain('agency_contact = COALESCE(EXCLUDED.agency_contact,');
  });

  it('every announcement that predates the code fans out via the backfill', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/FROM public\.builder_stock_selection_announcements\s+WHERE status IN \('selected', 'progressed', 'completed'\)/);
  });
});

describe('the stock_item scope is organisation-anchored and tasks-only', () => {
  it('all four database dispatchers learned the scope', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("WHEN 'stock_item' THEN\n      public.builder_resolve_stock_item_permission");
    expect(sql).toMatch(/builder_scope_exists[\s\S]*WHEN 'stock_item' THEN EXISTS \(SELECT 1 FROM public\.builder_stock_items/);
    expect(sql).toMatch(/builder_scope_org[\s\S]*ELSIF _scope_type = 'stock_item' THEN/);
    // The resolver answers tasks alone, view and edit alone.
    expect(sql).toContain("SELECT _permission_key = 'tasks'");
    expect(sql).toContain("AND _level IN ('view', 'edit')");
  });

  it('the vocabularies grew one word each, additively', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/builder_tasks_scope_type_check[\s\S]{0,400}'stock_item'::text/);
    expect(sql).toMatch(/builder_notifications_notification_type_check[\s\S]{0,500}'stock_selection'::text/);
    expect([...BUILDER_SCOPE_TYPES]).toContain('stock_item');
    expect([...BUILDER_NOTIFICATION_TYPES]).toContain('stock_selection');
    expect(NOTIFICATION_TYPE_LABELS.stock_selection).toBe('Property activated');
  });

  it('the collaboration function gates the scope on the active organisation', () => {
    const code = read('supabase/functions/builder-portal-collaboration/index.ts');
    expect(code).toContain("if (scopeType === 'stock_item') {");
    expect(code).toContain('item.organisation_id !== activeOrganisationId');
    // The honest matrix: tasks view/edit, nothing else.
    expect(code).toContain('perms: { tasks: { view: true, edit: true, delete: false } }');
  });
});

describe('the outbound sync ships a projection, never the builder\'s raw row', () => {
  it('source_row crosses as exactly one lifted key', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'house_design', v_i.source_row->>'house_design'");
    expect(sql).not.toContain("'source_row', v_i.source_row,");
    // manual_stats is a whitelist, not a spread.
    expect(sql).toContain("'bedrooms',          v_i.manual_stats->'bedrooms'");
  });

  it('the image block is the display rule\'s own keys and nothing else', () => {
    const sql = read(MIGRATION);
    for (const key of [
      'role', 'stored_sha256', 'marketplace_display_eligible',
      'marketplace_eligibility_state', 'sanitized_derivative', 'sanitization_clearance',
    ]) {
      expect(sql).toContain(`'${key}',`);
    }
    // Only a provably-builder-supplied, READY primary ever rides the event.
    expect(sql).toContain("v_img.source_stage = 'uploaded_document'");
    expect(sql).toContain("v_img.verification_status = 'source_supplied'");
    expect(sql).toContain("v_img.processing_status = 'ready'");
  });

  it('a representative composed payload crosses the shared privacy contract clean', () => {
    // The same shape builder_network_compose_stock_item_payload emits.
    const payload = {
      id: 'a'.repeat(36),
      organisation_id: 'b'.repeat(36),
      external_reference: 'LOT 109',
      address_line: 'Lot 109 Grandvista Boulevard',
      suburb: 'Berwick', state: 'VIC', postcode: '3806',
      bedrooms: 4, bathrooms: 2, car_spaces: 2,
      land_size_sqm: 350, building_size_sqm: 200,
      price: 750000, price_display: '$750,000',
      availability_status: 'available', lifecycle_status: 'active',
      enrichment_status: 'complete', image_work_stage: 'settled',
      house_design: 'NEX 20',
      manual_stats: { bedrooms: 4 },
      organisation: { id: 'b'.repeat(36), legal_name: 'Proof Homes Pty Ltd', trading_name: 'Proof Homes' },
      primary_image: {
        id: 'c'.repeat(36), source_stage: 'uploaded_document',
        verification_status: 'source_supplied', processing_status: 'ready',
        content_type: 'image/jpeg', position: 0,
        source_detail: {
          role: 'primary_property', stored_sha256: 'd'.repeat(64),
          marketplace_measured: true, marketplace_display_eligible: true,
          marketplace_eligibility_state: 'eligible', provenance_version: 26,
        },
      },
    };
    expect(() => assertPayloadCrossesClean(payload)).not.toThrow();

    // And the announce payload with its agency block.
    const announce = {
      remote_selection_ref: 'e'.repeat(36),
      stock_item_id: 'a'.repeat(36),
      status: 'selected',
      agency: {
        contact_name: 'Ava Adviser',
        contact_email: 'ava@agency.example',
        contact_phone: '03 9000 0000',
      },
    };
    expect(() => assertPayloadCrossesClean(announce)).not.toThrow();

    // The contract still throws on what it always forbade.
    expect(() => assertPayloadCrossesClean({ ...announce, client_email: 'x@y.z' }))
      .toThrow(BuilderNetworkPrivacyViolation);
    expect(() => assertPayloadCrossesClean({ ...announce, selected_by_user_id: 'f'.repeat(36) }))
      .toThrow(BuilderNetworkPrivacyViolation);
  });

  it('the catalogue reconcile is complete-or-loud, daily, and rides new connections', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'builder_network_stock_reconcile_oversized', 'critical'");
    expect(sql).toContain("'builder-network-stock-reconcile-daily'");
    expect(sql).toContain('trg_builder_network_connection_activated');
    expect(sql).toContain('PERFORM public.builder_network_backfill_stock_sync(NEW.id);');
  });

  it('the item trigger watches the projection, never image-work lease churn', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('NEW.primary_image_id, NEW.manual_stats');
    expect(sql).not.toMatch(/ROW\([^)]*NEW\.image_work_claim_until/);
  });
});

describe('the public stock-image door serves the invariant and nothing else', () => {
  it('is declared, unauthenticated on purpose, in config.toml', () => {
    const config = read('supabase/config.toml');
    expect(config).toContain('[functions.builder-network-stock-image]');
  });

  it('answers only the current primary of an active, client-visible item', () => {
    const code = read('supabase/functions/builder-network-stock-image/index.ts');
    expect(code).toContain(".eq('primary_image_id', image.id)");
    expect(code).toContain(".eq('lifecycle_status', 'active')");
    expect(code).toContain("rpc('builder_stock_item_client_visible', { p_item_id: item.id })");
    // The portal card's own serving order, at the byte boundary.
    expect(code).toContain('isMarketplaceEligible(detail) || !!servableClearanceFor(detail)');
    expect(code).toContain('cleanOriginal ? null : servableDerivativeFor(detail)');
    // Infrastructure failure is 503, never "no image exists".
    expect(code).toContain('status: 503');
    expect(code).toContain('status: 302');
  });
});

describe('the surfaces render the resolved activation, never a truncated sentence', () => {
  it('the list operations resolve the live context server-side, organisation-scoped', () => {
    const fn = read('supabase/functions/builder-portal-collaboration/index.ts');
    expect(fn).toContain('const loadStockActivations');
    // The walk starts from rows the active organisation owns — twice, because
    // the items read is scoped independently of the announcements read.
    expect((fn.match(/\.eq\('organisation_id', activeOrganisationId\)/g) || []).length)
      .toBeGreaterThanOrEqual(3);
    // All three list operations attach it: notifications by announcement,
    // both task lists by task.
    expect(fn).toContain('activationByAnnouncement');
    expect((fn.match(/const activationByTask = new Map/g) || []).length).toBe(2);
    // The registry fallback keeps the agency named even on a bare event.
    expect(fn).toContain("workspace.display_name || workspace.slug");
  });

  it('one shared presentation: live status chip, contact as links, road to the record', () => {
    const shared = read('src/components/builder-portal/StockActivation.tsx');
    expect(shared).toContain('ACTIVATION_STATUS_CLASSES[status]');
    expect(shared).toContain('mailto:${email}');
    expect(shared).toContain('tel:${phone');
    expect(shared).toContain('to="/builder/stock"');

    const notifications = read('src/pages/builder/BuilderNotifications.tsx');
    expect(notifications).toContain('ActivationNotificationCard');
    expect(notifications).toContain('formatRelativeTime');

    const tasks = read('src/pages/builder/BuilderTasks.tsx');
    expect(tasks).toContain('<ActivationContact activation={task.activation} dense />');
    // Prose clamps to two lines; the old single-line chop is gone for good.
    expect(tasks).toContain('line-clamp-2');
    expect(tasks).not.toContain('truncate text-xs');
    expect(tasks).toContain('describeDueDate');
  });

  it('a chip is never a bare outline that vanishes on a dark card', () => {
    const lib = read('src/lib/builderCollaboration.ts');
    expect(lib).toContain("high: 'border-warning/50 bg-warning/10 text-warning'");
    expect(lib).not.toContain("'border-accent/60 text-accent'");
    // Every activation status carries a tinted background with its border.
    expect(lib).toMatch(/selected: 'border-warning\/50 bg-warning\/10 text-warning'/);
  });
});

describe('what the builder reads back names the agency', () => {
  it('the announcement projection carries the disclosure', () => {
    const code = read('supabase/functions/_shared/builderStock/projection.pure.ts');
    expect(code).toContain('agency_name, agency_contact, activation_task_id,');
  });

  it('the Stock List renders the agency and the contact, as links', () => {
    const page = read('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('selection.agency_name || selection.workspace_label');
    expect(page).toContain('mailto:${selection.agency_contact.contact_email}');
    expect(page).toContain('Activated by an agency');
  });
});

// ===========================================================================
// AN ACTIVATION OPENS A PROJECT (20260917090000)
// ===========================================================================
const PROJECT_MIGRATION = 'supabase/migrations/20260917090000_an_activation_opens_a_project.sql';

describe('an activation opens a project — the notification is an entry point, not the product', () => {
  it('the fan-out creates, grants and links the project in the same transaction', () => {
    const sql = read(PROJECT_MIGRATION);
    expect(sql).toContain('INSERT INTO public.builder_projects(');
    expect(sql).toContain('INSERT INTO public.builder_project_access(');
    // Replays grant nothing twice.
    expect(sql).toContain('ON CONFLICT (builder_user_id, project_id) DO NOTHING');
    // Roles follow the member's standing in the organisation.
    expect(sql).toContain("WHEN 'owner'         THEN 'responsible'");
    expect(sql).toContain("WHEN 'read_only'     THEN 'read_only'");
    // The stock item is linked only when unlinked — a manual link is
    // somebody's decision and is never overwritten.
    expect(sql).toContain('WHERE id = v_item.id AND builder_project_id IS NULL');
    expect(sql).toContain('SET activation_project_id = v_project_id');
    // The opening is on the record like any human change would be.
    expect(sql).toContain('INSERT INTO public.builder_project_status_history(');
  });

  it('the announcement carries the pointer, and losing the project never orphans it', () => {
    const sql = read(PROJECT_MIGRATION);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS activation_project_id uuid');
    expect(sql).toContain('REFERENCES public.builder_projects(id) ON DELETE SET NULL');
  });

  it('withdrawal closes only untouched work, through the governed transition', () => {
    const sql = read(PROJECT_MIGRATION);
    // Planning and never written to — one edit or transition keeps the record.
    expect(sql).toContain("AND status = 'planning' AND row_version = 1");
    expect(sql).toContain('PERFORM public.builder_transition_project(');
    expect(sql).toContain("left('Activation withdrawn by ' || v_agency_name, 500)");
  });

  it('an acknowledged activation only ensures its project — no re-alerting', () => {
    const sql = read(PROJECT_MIGRATION);
    expect(sql).toContain("'builder_acknowledged', 'withdrawn')");
    expect(sql).toContain("IF v_a.status = 'builder_acknowledged' THEN");
  });

  it('the backfill visits every live announcement and the migration proves convergence', () => {
    const sql = read(PROJECT_MIGRATION);
    expect(sql).toContain("WHERE a.activation_project_id IS NULL AND a.status <> 'withdrawn'");
    expect(sql).toContain('activation project backfill visited');
    expect(sql).toContain('still have no project');
    // The sweep must not keep a private task-cancel path outside the fan-out.
    expect(sql).toContain('sweep still cancels tasks inline');
  });

  it('the task now sends people to the project', () => {
    const sql = read(PROJECT_MIGRATION);
    expect(sql).toContain(
      'Open the project to review the property and acknowledge the activation so the agency knows you have it.');
  });

  it('every activation read carries project_id', () => {
    const collaboration = read('supabase/functions/builder-portal-collaboration/index.ts');
    expect(collaboration).toContain('activation_project_id, connection_id');
    expect(collaboration).toContain('project_id: a.activation_project_id ?? null,');
    const stock = read('supabase/functions/builder-portal-stock/index.ts');
    expect(stock).toContain('activation_project_id: row.activation_project_id ?? null,');
    expect(BUILDER_ANNOUNCEMENT_SELECT).toContain('activation_project_id');
  });

  it('the projects door serves the activation and the property, organisation-pinned', () => {
    const projects = read('supabase/functions/builder-portal-projects/index.ts');
    expect(projects).toContain('const loadActivationContext = async (');
    // The announcement read is pinned to the session's organisation.
    expect(projects).toMatch(/from\('builder_stock_selection_announcements'\)[\s\S]{0,200}\.eq\('organisation_id', activeOrganisationId\)/);
    // The property rides the SAME projection the Stock List serves.
    expect(projects).toContain("import { STOCK_ITEM_SELECT } from '../_shared/builderStock/projection.pure.ts';");
    expect(projects).toContain('stock_item: stockItem,');
    expect(projects).toContain('activation,');
    // The list carries the light context for its activation line.
    expect(projects).toContain('agency_name: activation.agency_name,');
  });

  it('the surfaces open the project first', () => {
    const shared = read('src/components/builder-portal/StockActivation.tsx');
    expect(shared).toContain('export function ActivationProjectLink(');
    expect(shared).toContain('`/builder/projects/${projectId}`');

    const notifications = read('src/pages/builder/BuilderNotifications.tsx');
    expect(notifications).toContain('View project');
    expect(notifications).toContain('`/builder/projects/${activation.project_id}`');

    const bell = read('src/components/builder-portal/BuilderNotificationBell.tsx');
    expect(bell).toContain('`/builder/projects/${item.activation.project_id}`');

    const tasks = read('src/pages/builder/BuilderTasks.tsx');
    expect(tasks).toContain('<ActivationProjectLink projectId={task.activation.project_id} />');

    const stockList = read('src/pages/builder/BuilderStockList.tsx');
    expect(stockList).toContain('projectId={selection.activation_project_id}');
  });

  it('the project record shows the property and keeps the agency attached', () => {
    const detail = read('src/pages/builder/BuilderProjectDetail.tsx');
    expect(detail).toContain('function PropertyInformationCard(');
    expect(detail).toContain('function ActivatedByAgencyCard(');
    // Acknowledging lives on the record now, against the same announcement id
    // the Stock List uses, and refreshes the record it changed.
    expect(detail).toContain('acknowledge.mutate(activation.announcement_id');
    expect(detail).toContain('builderKeys.project(projectId)');
    const list = read('src/pages/builder/BuilderProjects.tsx');
    expect(list).toContain('Activated by {project.activation.agency_name');
  });

  it('the smoke cleanup removes projects before the organisation RESTRICT can bite', () => {
    const smoke = read('scripts/ops/production-smoke.mjs');
    const projectDelete = smoke.indexOf('DELETE FROM public.builder_projects WHERE builder_organisation_id IN');
    const orgDelete = smoke.indexOf("DELETE FROM public.builder_organisations WHERE legal_name LIKE 'Smoke Rollout %'");
    expect(projectDelete).toBeGreaterThan(-1);
    expect(orgDelete).toBeGreaterThan(projectDelete);
  });
});
