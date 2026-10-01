/**
 * WHICH OUTBOX EVENTS MAY GO OUT TOGETHER.
 *
 * The worker sent one event at a time, 25 a minute, and a 44-property stock
 * list queued 308 events (1 October 2026), so the Command Centre trailed the
 * Builder Portal by eight minutes and more.
 *
 * `stock.item.upserted` events for DIFFERENT properties are independent: each
 * carries its property's whole state, and the Command Centre keeps whichever
 * has the higher `source_version`. So a run of them may be sent in parallel.
 * Every other event (a catalog reconciliation, a selection, an agency message)
 * is a BARRIER: it waits for the wave before it and goes alone, so the
 * Command Centre still receives those in queue order — a reconciliation
 * archives what is older than it, and must not overtake the properties queued
 * ahead of it. Two events for the same property never share a wave.
 *
 * Input is in claim order; output is a list of waves, sent one after another,
 * each wave's events in parallel. Nothing is dropped or reordered across a
 * barrier.
 */
export interface DeliveryEvent {
  event_type?: unknown;
  payload?: unknown;
}

const itemOf = (event: DeliveryEvent): string | null => {
  if (event.event_type !== 'stock.item.upserted') return null;
  const id = (event.payload as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id ? id : null;
};

export function deliveryWaves<T extends DeliveryEvent>(events: readonly T[], maxWave: number): T[][] {
  const width = Math.max(1, Math.floor(maxWave));
  const waves: T[][] = [];
  let wave: T[] = [];
  let seen = new Set<string>();
  const close = () => {
    if (wave.length) waves.push(wave);
    wave = [];
    seen = new Set();
  };
  for (const event of events) {
    const item = itemOf(event);
    if (item === null) {
      close();
      waves.push([event]);
      continue;
    }
    if (seen.has(item) || wave.length >= width) close();
    seen.add(item);
    wave.push(event);
  }
  close();
  return waves;
}
