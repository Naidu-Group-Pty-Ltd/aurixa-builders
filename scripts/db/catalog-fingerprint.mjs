/**
 * One catalog fingerprint, shared by the baseline builder and the CI check.
 *
 * Two databases with the same fingerprint hold the same schema in every way
 * this programme cares about: tables, columns with types and nullability,
 * constraints with their definitions, indexes, RLS state, policies,
 * triggers, and function signatures WITH their bodies. The build writes the
 * fingerprint beside the baseline; the check rebuilds from the baseline
 * alone and must land on the identical hash — which is what makes "the
 * squash equals the corpus end-state" a measured fact instead of a claim.
 *
 * One implementation imported by both sides, because a fingerprint computed
 * two ways is two fingerprints (the repository this extraction leaves has
 * paid for that shape more than once).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const FINGERPRINT_SQL = `
WITH parts AS (
  SELECT 'table:' || c.relname || ':rls=' || c.relrowsecurity AS line
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
  UNION ALL
  SELECT 'column:' || table_name || '.' || column_name || ':' || data_type
         || ':' || is_nullable || ':' || coalesce(column_default, '-')
  FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'constraint:' || c.conrelid::regclass || '.' || c.conname || ':'
         || pg_get_constraintdef(c.oid)
  FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index:' || schemaname || '.' || indexname || ':' || indexdef
  FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy:' || schemaname || '.' || tablename || '.' || policyname || ':'
         || coalesce(qual, '-') || ':' || coalesce(with_check, '-') || ':' || cmd
  FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'trigger:' || tgrelid::regclass || '.' || tgname || ':' || tgfoid::regproc
  FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE n.nspname = 'public' AND NOT tgisinternal
  UNION ALL
  SELECT 'function:' || p.proname || '('
         || pg_get_function_identity_arguments(p.oid) || '):'
         || md5(p.prosrc)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
)
SELECT line FROM parts ORDER BY line;
`;

export function catalogFingerprint(psqlArgs) {
  const out = execFileSync(
    'psql',
    [...psqlArgs, '-At', '-v', 'ON_ERROR_STOP=1', '-c', FINGERPRINT_SQL],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? '' } },
  );
  return {
    hash: createHash('sha256').update(out).digest('hex'),
    lines: out.split('\n').filter(Boolean).length,
  };
}
