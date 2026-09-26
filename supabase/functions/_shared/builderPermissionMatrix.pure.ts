/**
 * A permission matrix, resolved concurrently — the same questions, the same
 * answers, without waiting for one key before asking about the next.
 *
 * Measured on the live portal (26 Sep 2026, portal-access-proof): every
 * project-scoped request took 10-11 s, because the matrix asked the database
 * about each of 21 keys in turn. The database remains the only authority:
 * every (key, level) it was asked before is asked now, a forbidden key is
 * still denied without asking, and an answer that is not `true` is a denial.
 * A question that THROWS fails the whole matrix, exactly as the sequential
 * loop it replaces did — nothing here turns an error into an answer.
 */
export type PermissionLevel = 'view' | 'edit' | 'delete';
export type PermissionMatrix = Record<string, { view: boolean; edit: boolean; delete: boolean }>;

/** Enough to finish a 21-key matrix in a handful of rounds without a burst of 63. */
export const PERMISSION_MATRIX_CONCURRENCY = 12;

const LEVELS: readonly PermissionLevel[] = ['view', 'edit', 'delete'];

export async function resolvePermissionMatrix(
  keys: readonly string[],
  forbidden: ReadonlySet<string>,
  ask: (key: string, level: PermissionLevel) => Promise<boolean>,
  options: { concurrency?: number } = {},
): Promise<PermissionMatrix> {
  const concurrency = Math.max(1, options.concurrency ?? PERMISSION_MATRIX_CONCURRENCY);
  const matrix: PermissionMatrix = {};
  const questions: Array<{ key: string; level: PermissionLevel }> = [];
  for (const key of keys) {
    // Insertion order is the key order, whatever order the answers arrive in.
    matrix[key] = { view: false, edit: false, delete: false };
    if (forbidden.has(key)) continue;
    for (const level of LEVELS) questions.push({ key, level });
  }

  let next = 0;
  const worker = async () => {
    while (next < questions.length) {
      const { key, level } = questions[next++];
      matrix[key][level] = (await ask(key, level)) === true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, worker));
  return matrix;
}
