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
