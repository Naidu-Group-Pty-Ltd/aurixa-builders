import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliveryWaves } from '../../../supabase/functions/_shared/builderNetworkDeliveryWaves.pure';

const item = (id: string, n = 0) => ({ n, event_type: 'stock.item.upserted', payload: { id } });
const other = (type: string, n = 0) => ({ n, event_type: type, payload: { organisation_id: 'o' } });
const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

describe('which outbox events may go out together', () => {
  it('different properties go out together, up to the width', () => {
    const waves = deliveryWaves(Array.from({ length: 20 }, (_, i) => item(`p${i}`)), 8);
    expect(waves.map((w) => w.length)).toEqual([8, 8, 4]);
  });

  it('two events for one property never share a wave, and keep their order', () => {
    const waves = deliveryWaves([item('a', 1), item('b', 2), item('a', 3), item('c', 4)], 8);
    expect(waves.map((w) => w.map((e) => e.n))).toEqual([[1, 2], [3, 4]]);
  });

  it('anything that is not a property is a barrier and goes alone, in queue order', () => {
    const waves = deliveryWaves([
      item('a', 1), item('b', 2), other('stock.catalog.reconciled', 3), item('c', 4), other('agency.message.posted', 5),
    ], 8);
    expect(waves.map((w) => w.map((e) => e.n))).toEqual([[1, 2], [3], [4], [5]]);
  });

  it('nothing is dropped, nothing reordered across a barrier, and a property with no id is a barrier', () => {
    const input = [item('a', 1), { n: 2, event_type: 'stock.item.upserted', payload: {} }, item('b', 3)];
    const waves = deliveryWaves(input, 0);
    expect(waves.flat().map((e) => e.n)).toEqual([1, 2, 3]);
    expect(waves.map((w) => w.length)).toEqual([1, 1, 1]);
  });
});

describe('a property is sent to the Command Centre once, in its latest state', () => {
  const migration = read('supabase/migrations/20261001150000_a_property_is_sent_once_in_its_latest_state.sql');
  const worker = read('supabase/functions/builder-network-outbox-worker/index.ts');

  it('only a waiting stock.item.upserted for the same connection and item is superseded, never a claimed one', () => {
    const supersede = migration.slice(migration.indexOf('UPDATE public.builder_network_outbox o'), migration.indexOf('v_version :='));
    expect(supersede).toContain("o.status = 'pending'");
    expect(supersede).toContain("o.event_type = 'stock.item.upserted'");
    expect(supersede).toContain('o.connection_id = v_conn.id');
    expect(supersede).toContain("o.payload->>'id' = _item_id::text");
    expect(supersede).toContain("o.locked_at IS NULL OR o.locked_at < now() - interval '10 minutes'");
    expect(migration).toContain("'superseded'::text");
  });

  it('the enqueue still composes, versions, dedupes and raises the no-route alert as before', () => {
    for (const piece of [
      'builder_network_compose_stock_item_payload(_item_id)',
      'builder_network_next_outbound_version(v_conn.id)',
      'ON CONFLICT (dedupe_key) DO NOTHING',
      "'builder_network_stock_has_no_route'",
    ]) expect(migration).toContain(piece);
  });

  it('the worker sends in waves inside a budget, and claims again while there is work', () => {
    expect(worker).toContain('deliveryWaves(events, DELIVERY_CONCURRENCY)');
    expect(worker).toMatch(/while \(Date\.now\(\) - startedAt < RUN_BUDGET_MS\)/);
    expect(worker).toContain('assertPayloadCrossesClean(event.payload ?? {})');
  });
});
