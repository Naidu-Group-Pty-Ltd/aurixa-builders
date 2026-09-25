/**
 * ===========================================================================
 * WHAT A NAMED LIMIT MAY ABSORB, AND WHERE A FORBIDDEN WORD IS LOOKED FOR.
 * ===========================================================================
 *
 * Two rules of the acceptance gate, kept out of `harness.ts` so they can be
 * asserted without a database (`stockAcceptanceFailureFiling.spec.ts`).
 *
 * A NAMED LIMIT is a gap the corpus has declared beside the document it
 * describes: a field the pipeline leaves absent, or a photograph it does not
 * find. It is reported on every run and never fails the gate. What it may
 * absorb is exactly what it declares (`limit_covers`), and nothing else.
 *
 * A FORBIDDEN WORD is a string a document puts on the page that must never
 * reach a property: a builder's office, a footer's phone number.
 *
 * BOTH WERE WIDER THAN THEY SAID, found 25 September 2026. A `known_limit`
 * turned EVERY failure of its fixture into a named limit — a wrong value, a
 * property in the wrong organisation, a photograph served across tenants —
 * so thirteen of the corpus's documents could not fail the gate, while the
 * harness's own comment promised that a wrong value "fails whatever is
 * written here". And a forbidden word was looked for in the record's whole
 * JSON, where a `created_at` of `…16.413007…` holds a footer's `1300`.
 */

/** What a fixture declares about its own gap. */
export interface DeclaredLimit {
  /** Why the gap exists, as the corpus states it. */
  known_limit?: string;
  /**
   * The shortfalls the gap covers: `photograph`, or `<row>.<field>` for a
   * field the document states and the pipeline leaves absent. A limit that
   * declares none is a note, and absorbs nothing.
   */
  limit_covers?: string[];
}

/**
 * Where a failure is filed: `limits` (reported, never failing) or `fails`.
 *
 * `shortfall` names what fell short — a photograph, or a row's field left
 * absent — and is absent for everything else a check can find, because
 * everything else is a wrong value, a fabricated record, a leak or a broken
 * transport: the things no gap in a reader can excuse.
 */
export function fileFailure(
  expect: DeclaredLimit,
  shortfall?: string | null,
): 'limits' | 'fails' {
  if (!expect.known_limit || !shortfall) return 'fails';
  return (expect.limit_covers ?? []).includes(shortfall) ? 'limits' : 'fails';
}

/**
 * The shortfalls a fixture declares that did not fall short on this run.
 *
 * A declared limit that no longer holds is removed, never left to be
 * believed — the rule `linked_limit` has always answered to. Left standing,
 * it would absorb the same shortfall the day it came back as a regression.
 */
export function staleLimits(expect: DeclaredLimit, fellShort: ReadonlySet<string>): string[] {
  if (!expect.known_limit) return [];
  return (expect.limit_covers ?? []).filter((subject) => !fellShort.has(subject));
}

/**
 * A value the product mints for itself — an id or a moment — which no
 * document wrote and so no document's words can be found in.
 */
const MINTED = new RegExp(
  '^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  + '|\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}(?::?\\d{2})?)?)$',
  'i',
);

/**
 * The text a forbidden word is looked for in, upper-cased: every value in the
 * record, nested ones included, except what the product minted. Never a
 * column's name, which no document wrote either.
 *
 * Asked of the WHOLE record still, and on purpose: the point is not which
 * field a heading would land in, it is that none may.
 */
export function forbiddenWordText(record: unknown): string {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (!MINTED.test(value)) values.push(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      values.push(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(record);
  return values.join('\n').toUpperCase();
}
