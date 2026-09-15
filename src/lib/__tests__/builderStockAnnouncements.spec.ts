/**
 * The Stock List's selection flow after the rewiring: announcements, not
 * the withdrawn Command Centre table.
 *
 * The behavioural half (announce → converge → acknowledge → outbox, the
 * organisation boundary, version monotonicity) is proven against the real
 * schema in scripts/db/baseline-check.mjs §4. Here: the projections, the
 * privacy boundary, and the wiring.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILDER_ANNOUNCEMENT_SELECT,
} from '../../../supabase/functions/_shared/builderStock/projection.pure';
import {
  assertPayloadCrossesClean,
} from '../../../supabase/functions/_shared/builderNetworkPrivacy.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const stock = readCode('supabase/functions/builder-portal-stock/index.ts');

describe('the deleted table stays deleted', () => {
  it('no stock source names builder_stock_selections', () => {
    for (const path of [
      'supabase/functions/builder-portal-stock/index.ts',
      'supabase/functions/_shared/builderStock/projection.pure.ts',
      'src/lib/builderStock.ts',
      'src/lib/builderStockQueries.ts',
      'src/pages/builder/BuilderStockList.tsx',
    ]) {
      expect(readCode(path), path).not.toMatch(/\bbuilder_stock_selections\b/);
    }
  });
});

describe('the announcement projection is the network contract', () => {
  it('carries the connection fields and none of the Command Centre columns', () => {
    expect(BUILDER_ANNOUNCEMENT_SELECT).toContain('remote_selection_ref');
    expect(BUILDER_ANNOUNCEMENT_SELECT).toContain('remote_client_label');
    expect(BUILDER_ANNOUNCEMENT_SELECT).toContain('connection_id');
    for (const forbidden of ['client_id', 'selected_by_user_id', 'internal_notes']) {
      expect(BUILDER_ANNOUNCEMENT_SELECT).not.toContain(forbidden);
    }
  });

  it('list and item decoration read the announcements table', () => {
    expect(stock).toContain("from('builder_stock_selection_announcements')");
    expect(stock).toContain('BUILDER_ANNOUNCEMENT_SELECT');
    // Item decoration exposes the honest field name for created_at.
    expect(stock).toContain('announced_at: row.created_at');
  });

  it('source deletion counts announcements, refusing on a failed count', () => {
    const deleteBlock = stock.slice(stock.indexOf("'delete_upload'"), stock.indexOf("'list_selections'"));
    expect(deleteBlock).toContain("from('builder_stock_selection_announcements')");
    expect(deleteBlock).toContain('selectionCountError');
  });
});

describe('acknowledgement is transactional with its outbound event', () => {
  it('the handler calls the one database command', () => {
    const ackBlock = stock.slice(stock.indexOf("'acknowledge_selection'"));
    expect(ackBlock).toContain("rpc('builder_stock_acknowledge_announcement'");
    expect(ackBlock).not.toMatch(/from\('builder_stock_selection_announcements'\)\s*\.\s*update/);
  });

  it('the command queues stock.selection.acknowledged with the stamp', () => {
    const migration = read('supabase/migrations/20260915120000_network_convergence_and_transport.sql');
    expect(migration).toContain("'stock.selection.acknowledged'");
    expect(migration).toMatch(/INSERT INTO public\.builder_network_outbox[\s\S]{0,400}stock\.selection\.acknowledged/);
    // Dedupe derives from the selection ref: a retry cannot double-deliver.
    expect(migration).toContain("'stock.selection.acknowledged:' || v_row.connection_id || ':' || v_row.remote_selection_ref");
  });

  it('the outbound payload crosses the privacy contract clean', () => {
    // The exact keys builder_stock_acknowledge_announcement composes.
    const payload = {
      remote_selection_ref: '4d1f0f27-6a86-4c39-9d3d-2a4c14b6a111',
      stock_item_id: '4d1f0f27-6a86-4c39-9d3d-2a4c14b6a222',
      status: 'builder_acknowledged',
      acknowledged_at: '2026-09-15T00:00:00Z',
    };
    expect(assertPayloadCrossesClean(payload)).toBe(payload);
  });

  it('the inbound announcement payload contract crosses clean too', () => {
    const payload = {
      remote_selection_ref: '4d1f0f27-6a86-4c39-9d3d-2a4c14b6a333',
      stock_item_id: '4d1f0f27-6a86-4c39-9d3d-2a4c14b6a444',
      status: 'selected',
      remote_client_label: 'Buyer via Harbour Realty',
    };
    expect(assertPayloadCrossesClean(payload)).toBe(payload);
  });
});

describe('convergence stays a sweep', () => {
  it('the inbound door lands, then runs the idempotent sweep opportunistically', () => {
    const inbound = readCode('supabase/functions/builder-network-inbound/index.ts');
    const landing = inbound.indexOf("from('builder_network_inbound_events')");
    const sweep = inbound.indexOf("rpc('builder_network_apply_inbound_events'");
    expect(landing).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(landing);
    // The domain tables are the sweep's to write, never the door's.
    expect(inbound).not.toContain("from('builder_stock_selection_announcements')");
  });

  it('both drivers are scheduled, guarded on pg_cron', () => {
    const migration = read('supabase/migrations/20260915120000_network_convergence_and_transport.sql');
    expect(migration).toContain("'builder-network-inbound-apply-1min'");
    expect(migration).toContain("'builder-network-outbox-worker-1min'");
    expect(migration).toMatch(/pg_extension WHERE extname = 'pg_cron'/);
  });
});

describe('the browser contract', () => {
  it('the frontend type names announced_at and carries no clone identifiers', () => {
    const lib = read('src/lib/builderStock.ts');
    const block = lib.slice(lib.indexOf('interface BuilderStockSelectionForBuilder'));
    expect(block).toContain('announced_at: string');
    expect(block).toContain('remote_selection_ref');
    for (const forbidden of ['client_id', 'selected_by_user_id', 'internal_notes', 'selected_at']) {
      expect(block.slice(0, block.indexOf('}'))).not.toContain(forbidden);
    }
  });

  it('the page renders the announcement instant', () => {
    expect(read('src/pages/builder/BuilderStockList.tsx')).toContain('selection.announced_at');
  });
});
