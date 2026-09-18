/**
 * Which organisation already holds the thing you just typed.
 *
 * `builder_organisations` carries THREE unique indexes, and a collision with
 * any of them is a 23505 that the create and update paths turned into a bare
 * 500 `create_failed` — rendered to an operator as "The organisation could
 * not be saved", naming no field and suggesting no remedy.
 *
 *   builder_organisations_abn_key         (abn) WHERE abn IS NOT NULL
 *   builder_organisations_acn_key         (acn) WHERE acn IS NOT NULL
 *   builder_organisations_legal_name_key  (lower(btrim(legal_name)))
 *
 * Measured in production on 18 Sep 2026: an operator re-used the ABN from the
 * form's own placeholder and was told nothing about which of ten fields was
 * wrong. It cost them the rest of the run — the organisation was never
 * created, so the owner was never invited, so the invitation they were
 * waiting for could not have been sent.
 *
 * This is the same class the CHECK constraints already answer for in
 * `builderOrganisationInput.pure.ts`: a constraint the caller cannot read is
 * a constraint the caller cannot satisfy. That module refuses a value it can
 * judge ALONE — a shape. This one names a collision, which can only be known
 * by asking the table, so it reads the database's own error rather than
 * pre-checking: a SELECT-then-INSERT would be a race, and the index is the
 * only authority on what is already taken.
 */

/** What Postgres raises when a unique index refuses a row. */
export const UNIQUE_VIOLATION = '23505';

export interface PostgresErrorLike {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: string | null;
}

/** The three indexes, and the field each one speaks for. */
const INDEX_FIELD: ReadonlyArray<readonly [string, string]> = [
  ['builder_organisations_abn_key', 'abn'],
  ['builder_organisations_acn_key', 'acn'],
  ['builder_organisations_legal_name_key', 'legal_name'],
];

const SENTENCE: Record<string, string> = {
  abn: 'another organisation on the network is already registered with that ABN',
  acn: 'another organisation on the network is already registered with that ACN',
  legal_name: 'another organisation on the network already has that legal name',
};

/**
 * Read a write error as a named collision, or as nothing.
 *
 * Returns null for every error that is NOT a unique violation this module
 * recognises, so the caller still fails the way it used to. An unrecognised
 * constraint is deliberately not guessed at: a wrong field name sends an
 * operator to edit something that was never the problem.
 */
export function readOrganisationConflict(
  error: PostgresErrorLike | null | undefined,
): { readonly field: string; readonly error: string } | null {
  if (!error || String(error.code ?? '') !== UNIQUE_VIOLATION) return null;
  // The index name appears in `message`; `details` carries the value, which
  // is NOT repeated back — an operator typed it and it is another
  // organisation's registration number.
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`;
  for (const [index, field] of INDEX_FIELD) {
    if (haystack.includes(index)) {
      return { field, error: `${field}_already_registered` };
    }
  }
  return null;
}

/** The sentence for a code this module produced. */
export function describeOrganisationConflict(code: string): string | null {
  const field = code.endsWith('_already_registered')
    ? code.slice(0, -'_already_registered'.length)
    : '';
  return SENTENCE[field] ?? null;
}
