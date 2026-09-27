/**
 * Stage timings for one request, as a `Server-Timing` header.
 *
 * Observability only: it records how long each stage of a handler took so a
 * slow request can be attributed to the stage that made it slow, rather than
 * guessed at. It carries durations and stage names — never data — and the
 * portal proxy does not forward it to browsers (FORWARDED_RESPONSE_HEADERS);
 * the performance proof reads it by calling the function directly.
 */
export interface StageTimer {
  mark(stage: string): void;
  header(): string;
}

export function createStageTimer(now: () => number = () => performance.now()): StageTimer {
  const started = now();
  let last = started;
  const stages: Array<[string, number]> = [];
  const clean = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_');
  return {
    mark(stage) {
      const at = now();
      stages.push([clean(stage), at - last]);
      last = at;
    },
    header() {
      return [...stages, ['total', last - started] as [string, number]]
        .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(', ');
    },
  };
}
