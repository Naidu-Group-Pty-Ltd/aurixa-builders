# 66 — Six migrations production ran out of band

Reconciled 28 Sep 2026. `production-rollout verify` had halted since 20 Sep on
six ledger versions this repository did not carry, and nothing reported it.

## 1. What happened

On 20 Sep 2026, between 07:16 and 09:17 UTC, six migrations were applied to
production directly through the Supabase `apply_migration` tool. That tool
records the SQL on the ledger row under a wall-clock version. Four were then
committed as repository files under round-number versions; two never were.

| Ledger version | What it did | Repository file carrying its effect |
|---|---|---|
| `20260920071612` | seeds the stock-extraction model assignment | `20260920070000_…` |
| `20260920075824` | narrows its fallback chain | `20260920080000_…` |
| `20260920091154` | first cut of the US$10/month AI spend ceiling | `20260920090000_…` |
| `20260920091209` | moves the assignment to OpenRouter | `20260920100000_…` |
| `20260920091331` | **qualifies columns so settle stops raising 42702** | `20260920090000_…` |
| `20260920091706` | **revokes EXECUTE from PUBLIC — a security fix** | `20260920090000_…` |

The deploy lane then **executed** the four repository files on top
(`apply-migrations.mjs` runs a file and only then records its version, with no
body). So production's end state for every object the six touched is what those
files produce, and `20260920090000` is the consolidated version of the ceiling:
it carries both the qualified columns and the revoke from PUBLIC.

The security fix is worth stating plainly. Postgres grants EXECUTE on a new
function to PUBLIC, and `anon` and `authenticated` reach it by inheriting
PUBLIC — so the first cut's `REVOKE … FROM anon, authenticated` removed
nothing, and five `SECURITY DEFINER` functions that move money were callable
by an anonymous caller.

## 2. What was proved, and how

Read-only against production, then a rebuild of this directory into a local
Postgres, compared by a fingerprint of every object the six touched: columns,
constraints, indexes, RLS flags, table and function ACLs, policies, triggers,
the md5 of every function body, and the one configuration row.

- **A clean rebuild of the repository as it stood already equals production**
  on every line. The one difference is `MAINTAIN` in the table ACLs: a
  privilege Postgres 17 adds to `GRANT ALL`. Production runs 17; the rebuild
  runs 16, as CI does. So the two "missing" migrations were never missing from
  a rebuild — their effect is in the consolidated file. (An earlier report of
  this finding said a rebuilt environment would lack them. That was wrong.)
- **All six bodies were read back from the ledger byte-exact**, each verified
  against the md5 of the ledger row's own statements.
- **Restoring them as executable migrations would have broken rebuilds.**
  Measured: a rebuild runs files in version order, so the out-of-band
  `091154` would run *after* `090000` where production ran it *before*, and
  four `ai_budget_*` function bodies would then differ from production's —
  `reserve` among them, with nothing later to correct it.

## 3. The reconciliation

Six **record-only** migration files, one per ledger version. Each carries the
exact SQL production recorded behind a `--|` prefix, its md5, when and how it
was applied, and the repository file whose effect production has. None
executes anything.

- `verify` passes because the repository now carries every version the ledger
  records. The check is unchanged; it still halts on any new foreign version.
- Production is not touched. A recorded version is never pending, so neither
  `apply` nor the deploy lane runs these files there.
- No ledger row was deleted, rewritten or added.

## 4. What holds it

- `src/lib/__tests__/migrationLedgerRecords.spec.ts` — each file exists, its
  body recovers to the ledger's md5, nothing in it executes, and the file whose
  effect it names exists. 24 tests, all failing before the files existed.
- `scripts/db/ai-budget-rebuild-check.mjs` (CI: `db:ai-budget:check`) — a
  rebuild from every migration equals production's fingerprint, only
  `service_role` may execute the five functions, a call as `anon` or
  `authenticated` is refused by the server with 42501, and reserve-then-settle
  runs. It was shown to fail on both defects it exists for: with the revoke
  narrowed back to `anon, authenticated`, an anonymous call succeeds; with the
  bodies restored as executable SQL, the four function bodies diverge.

That check fills a real gap. `baseline-check.mjs` proves "privileged
functions answer to service_role and to nobody else" against the baseline file
alone, and the `ai_budget_*` functions were created after it — so no check had
ever looked at them.
