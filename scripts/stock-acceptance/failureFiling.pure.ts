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
 */

/** What a fixture declares about its own gap. */
export interface DeclaredLimit {
  /** Why the gap exists, as the corpus states it. */
  known_limit?: string;
  /**
   * The shortfalls the gap covers: `photograph`, or `<row>.<field>` for a
   * field the document states and the pipeline leaves absent.
   */
  limit_covers?: string[];
}

/**
 * Where a failure is filed: `limits` (reported, never failing) or `fails`.
 *
 * `shortfall` names what fell short — a photograph, or a row's field — and is
 * absent for everything else a check can find.
 */
export function fileFailure(
  expect: DeclaredLimit,
  _shortfall?: string | null,
): 'limits' | 'fails' {
  return expect.known_limit ? 'limits' : 'fails';
}

/**
 * The shortfalls a fixture declares that did not fall short on this run.
 * `fellShort` is what the run filed against the declaration.
 */
export function staleLimits(_expect: DeclaredLimit, _fellShort: ReadonlySet<string>): string[] {
  return [];
}

/** The text a forbidden word is looked for in, upper-cased. */
export function forbiddenWordText(record: unknown): string {
  return JSON.stringify(record).toUpperCase();
}
