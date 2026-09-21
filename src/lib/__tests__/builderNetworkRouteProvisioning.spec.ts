/**
 * AN APPROVED BUILDER HAS A ROUTE.
 *
 * The defect these pin ran three times in two weeks: a builder's stock
 * reaches a workspace only through
 *
 *     JOIN workspace_connections c ON i.organisation_id = c.builder_organisation_id
 *
 * and nothing but an operator's hand ever created that row. An organisation
 * approved onto the network could upload stock all day and match zero
 * connections — no events, no error, no operational row. The remedy applied
 * twice was to re-point the one connection at whichever builder was live that
 * week, which fixes one builder by unfixing another.
 *
 * Identity was never the defect and these tests say so: the organisation UUID
 * is assigned once and never re-derived, and nothing here may move a stock
 * item between builders. The receiver's half is pinned in npc-property-dashbord.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describeDistribution,
  distributionStateOf,
} from '../../../supabase/functions/_shared/builderStock/distributionState.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const stripSql = (body: string) => body.replace(/--[^\n]*/g, ' ');

const MIGRATION = 'supabase/migrations/20260921060000_an_approved_builder_has_a_route.sql';
const sql = stripSql(read(MIGRATION));

describe('approval provisions the route', () => {
  it('fires on an organisation becoming active, on insert or update', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_builder_organisation_activated\s*AFTER INSERT OR UPDATE OF status ON public\.builder_organisations/,
    );
    expect(sql).toMatch(/IF NEW\.status = 'active'\s*AND \(TG_OP = 'INSERT' OR OLD\.status IS DISTINCT FROM 'active'\)/);
  });

  it('reaches every registered workspace, not one remembered id', () => {
    expect(sql).toMatch(/FOR v_workspace IN SELECT w\.id, w\.slug FROM public\.workspace_registry w/);
  });

  it('is idempotent: a live connection is left exactly as it is', () => {
    expect(sql).toMatch(
      /CONTINUE WHEN EXISTS \(\s*SELECT 1 FROM public\.workspace_connections c\s*WHERE c\.workspace_id = v_workspace\.id\s*AND c\.builder_organisation_id = _organisation_id\s*AND c\.state <> 'revoked'\)/,
    );
  });

  it('never re-points an existing connection at another builder', () => {
    // The whole file may create connections and may never move one.
    expect(sql).not.toMatch(/UPDATE public\.workspace_connections[\s\S]{0,400}?SET[\s\S]{0,200}?builder_organisation_id\s*=/);
  });
});

describe('the transport belongs to the workspace, not to the builder', () => {
  it('copies the workspace’s existing addressing material', () => {
    expect(sql).toMatch(/SELECT c\.id, c\.inbound_url, c\.outbound_hmac_secret INTO v_transport/);
    expect(sql).toMatch(/AND c\.outbound_hmac_secret IS NOT NULL\s*AND c\.inbound_url IS NOT NULL/);
  });

  it('mints no secret anywhere', () => {
    expect(sql).not.toMatch(/gen_random_bytes|encode\s*\(\s*gen_random|md5\s*\(\s*random/i);
  });

  it('says so when a workspace has never been bootstrapped', () => {
    expect(sql).toContain('builder_network_workspace_has_no_transport');
    expect(sql).toMatch(/CASE WHEN v_transport\.id IS NULL THEN 'invited' ELSE 'active' END/);
  });

  it('uses an initiated_by the column actually admits', () => {
    // CHECK (initiated_by = ANY (ARRAY['workspace','builder']))
    expect(sql).not.toMatch(/initiated_by[\s\S]{0,80}'system'/);
    expect(sql).toMatch(/'workspace',/);
  });
});

describe('the new route announces itself before its stock follows', () => {
  it('mints the id first so the announcement can be queued ahead', () => {
    const fn = sql.slice(sql.indexOf('FUNCTION public.builder_network_provision_connections'));
    const mint = fn.indexOf('v_new_id := gen_random_uuid()');
    const announce = fn.indexOf("'connection.authorised'");
    const insert = fn.indexOf('INSERT INTO public.workspace_connections(');
    expect(mint).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(mint);
    expect(insert).toBeGreaterThan(announce);
  });

  it('announces on a connection that already reaches the workspace', () => {
    expect(sql).toMatch(/VALUES \(v_transport\.id, 'connection\.authorised'/);
  });

  it('carries only identity, never a credential', () => {
    const payload = sql.slice(sql.indexOf("'connection.authorised'"), sql.indexOf('ON CONFLICT (dedupe_key) DO NOTHING'));
    expect(payload).toContain("'builder_organisation_id'");
    expect(payload).toContain("'trading_name'");
    expect(payload).not.toMatch(/hmac|secret|inbound_url/i);
  });

  it('lets the connection’s own insert trigger do the backfill, once', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_builder_network_connection_activated\s*AFTER INSERT OR UPDATE OF state ON public\.workspace_connections/,
    );
    // Asking twice would mint a second outbound version per item.
    const fn = sql.slice(sql.indexOf('FUNCTION public.builder_network_provision_connections'),
                         sql.indexOf('FUNCTION public.builder_organisation_activated'));
    expect(fn).not.toContain('builder_network_backfill_stock_sync');
  });
});

describe('a route that matched nothing is a fact, not a silence', () => {
  it('records the zero-fanout against the organisation', () => {
    expect(sql).toContain('builder_network_stock_has_no_route');
    expect(sql).toMatch(/'reason', 'no_authorised_connection'/);
    expect(sql).toMatch(/'active_stock_count'/);
  });

  it('only for stock that is actually live', () => {
    expect(sql).toMatch(/IF v_item\.lifecycle_status = 'active' AND NOT EXISTS/);
  });

  it('at most once an hour per organisation, so a flood cannot hide it', () => {
    expect(sql).toMatch(/AND e\.occurred_at > now\(\) - interval '1 hour'/);
  });

  it('never fails the upload for want of a destination', () => {
    const fn = sql.slice(sql.indexOf('FUNCTION public.builder_network_enqueue_stock_item'));
    expect(fn.slice(0, fn.indexOf('$function$;'))).not.toMatch(/RAISE EXCEPTION/);
  });
});

describe('a stock item’s builder is an invariant', () => {
  it('refuses to move an item between organisations at the row', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_builder_stock_items_org_immutable\s*BEFORE UPDATE OF organisation_id ON public\.builder_stock_items/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION\s*'a stock item may not change builder/);
  });
});

describe('every builder’s distribution is queryable', () => {
  it('publishes one row per organisation, routed or not', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.builder_network_sync_state/);
    expect(sql).toMatch(/FROM public\.builder_organisations o;/);
  });

  it('names the state that used to be silent', () => {
    expect(sql).toContain("'no_authorised_connection'");
    for (const state of ['awaiting_connection', 'delivery_failed', 'syncing', 'synced', 'organisation_inactive']) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it('counts destinations and queued events per builder', () => {
    expect(sql).toMatch(/AS authorised_destinations/);
    expect(sql).toMatch(/AS events_queued/);
    expect(sql).toMatch(/AS active_stock_count/);
  });
});

describe('the builders already approved are given routes by the same code path', () => {
  it('backfills provisioning for every active organisation', () => {
    const tail = sql.slice(sql.lastIndexOf('DO $$'));
    expect(tail).toMatch(/SELECT id FROM public\.builder_organisations WHERE status = 'active'/);
    expect(tail).toMatch(/builder_network_provision_connections\(v_org\.id\)/);
  });

  it('and takes no builder’s route to give another one', () => {
    // The repair creates; the idempotence guard above is what stops it moving
    // anything. Stated here because it is the rule the previous two remedies
    // broke.
    const tail = sql.slice(sql.lastIndexOf('DO $$'));
    expect(tail).not.toMatch(/UPDATE|DELETE/);
  });
});

describe('the portal never claims a destination the builder does not have', () => {
  it('an unreadable state claims nothing about sharing', () => {
    const reading = describeDistribution(null);
    expect(reading.detail).not.toMatch(/Command Centre|shared with|workspaces see/i);
    expect(reading.attention).toBe(false);
  });

  it('says plainly when no workspace is authorised', () => {
    const reading = describeDistribution({
      state: 'no_authorised_connection',
      authorisedDestinations: 0,
      activeStockCount: 1,
      eventsQueued: 0,
      lastDeliveredAt: null,
    });
    expect(reading.attention).toBe(true);
    expect(reading.detail).toMatch(/no workspace is authorised/i);
    expect(reading.detail).toMatch(/saved/i);
  });

  it('counts the destinations it names', () => {
    const one = describeDistribution({
      state: 'synced', authorisedDestinations: 1, activeStockCount: 3,
      eventsQueued: 0, lastDeliveredAt: null,
    });
    expect(one.detail).toContain('1 workspace.');
    const two = describeDistribution({
      state: 'synced', authorisedDestinations: 2, activeStockCount: 3,
      eventsQueued: 0, lastDeliveredAt: null,
    });
    expect(two.detail).toContain('2 workspaces.');
  });

  it('reads a word it does not know as unknown rather than the nearest one', () => {
    expect(distributionStateOf('delivered_probably')).toBe('unknown');
    expect(distributionStateOf(undefined)).toBe('unknown');
    expect(distributionStateOf('synced')).toBe('synced');
  });
});
