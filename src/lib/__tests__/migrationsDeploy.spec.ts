/**
 * Schema ships, and it ships before the code that reads it.
 *
 * Until 18 Sep 2026 nothing in this repository applied a migration. The deploy
 * workflow shipped every edge function on every push to main and verified by
 * effect that they had landed; the database had no lane at all, and CI never
 * noticed that a branch had added a table production would never see.
 *
 * `20260918100500_builder_access_requests.sql` merged with a full green check,
 * deployed its function, and left the schema behind. The function then answered
 * every public applicant with an unattributed 500 —
 *
 *   PGRST205  Could not find the table 'public.builder_access_requests'
 *             in the schema cache
 *
 * — and the first person to find out was a user filling in the form.
 *
 * These assertions are about the LANE, not about any one migration: that it
 * exists, that it is reached by a change to `supabase/migrations/**`, and that
 * it runs before the functions do. The last is the one that matters most and
 * is the easiest to lose in a reordering — a function deployed against a table
 * that does not exist yet IS the outage above.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const WORKFLOW = ".github/workflows/deploy-supabase-functions.yml";
const RUNNER = "scripts/ops/apply-migrations.mjs";

describe("migrations have a deploy lane", () => {
  const workflow = read(WORKFLOW);

  it("runs the migration runner", () => {
    expect(workflow).toContain("node scripts/ops/apply-migrations.mjs");
  });

  it("runs it BEFORE any function is deployed", () => {
    // Not interchangeable. Schema, then code.
    const migrationsAt = workflow.indexOf("node scripts/ops/apply-migrations.mjs");
    const functionsAt = workflow.indexOf("supabase functions deploy");
    expect(migrationsAt).toBeGreaterThan(-1);
    expect(functionsAt).toBeGreaterThan(-1);
    expect(migrationsAt).toBeLessThan(functionsAt);
  });

  it("is reached by a change to the migrations directory", () => {
    // A lane that only triggers on `supabase/functions/**` never runs for a
    // pull request that adds a table and nothing else, which is precisely the
    // shape of change most likely to need it.
    expect(workflow).toContain("'supabase/migrations/**'");
  });

  it("needs no credential the functions lane does not already have", () => {
    // `supabase db push` wants a database password — a SECOND secret nobody
    // has configured. A lane that cannot run until somebody adds one is a
    // lane that stays unrun, so this uses the access token already here.
    expect(workflow).not.toContain("SUPABASE_DB_PASSWORD");
    const step = workflow.slice(
      workflow.indexOf("apply pending migrations"),
      workflow.indexOf("supabase/setup-cli"),
    );
    expect(step).toContain("SUPABASE_ACCESS_TOKEN");
  });
});

describe("the runner", () => {
  const runner = read(RUNNER);

  it("reads what is applied from the CLI's own ledger", () => {
    // So this and `supabase db push` agree about what has happened, and
    // neither re-runs the other's work.
    expect(runner).toContain("supabase_migrations.schema_migrations");
  });

  it("records a version only AFTER its SQL succeeded", () => {
    // Recording first would mark a failed migration as applied and hide it
    // for ever, which is strictly worse than the gap this closes.
    const applyAt = runner.indexOf("const result = await query(sql);");
    const recordAt = runner.indexOf("insert into supabase_migrations.schema_migrations");
    expect(applyAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(applyAt);
    // And the failure path leaves before it can reach the record.
    const between = runner.slice(applyAt, recordAt);
    expect(between).toMatch(/if \(!result\.ok\)[\s\S]*process\.exit\(1\)/);
  });

  it("stops at the first failure rather than carrying on", () => {
    // Migrations are ordered because they depend on each other; carrying on
    // past a broken one applies later statements to a schema that does not
    // exist yet.
    expect(runner).toContain("stopped at the first failure");
  });

  it("refuses rather than reporting success when it cannot act", () => {
    // A runner that exits 0 with no credential turns this lane back into the
    // silence it was written to end.
    const guard = runner.slice(0, runner.indexOf("async function query"));
    expect(guard).toMatch(/if \(!token \|\| !projectRef\)[\s\S]{0,300}process\.exit\(1\)/);
    // An empty migrations directory is a broken checkout, not an up-to-date
    // database.
    expect(runner).toMatch(/files\.length === 0[\s\S]{0,300}process\.exit\(1\)/);
  });

  it("never echoes a migration's body into the log", () => {
    // A migration can carry a seeded credential or a piece of personal data,
    // and a workflow log is readable by everyone with repository access.
    // Targeted at the VARIABLE holding the body, not the substring "sql":
    // the first version of this matched `.sql` inside an error message about
    // an empty directory and failed on a file that logs nothing of the kind.
    expect(runner).not.toMatch(/console\.(log|error)\([^;]*\$\{sql\}/);
    expect(runner).not.toMatch(/console\.(log|error)\([^;]*[(,]\s*sql\s*[),]/);
  });

  it("invents no repair", () => {
    // No statement is rewritten, nothing is skipped on error. The
    // `check:migration-order` gate is what keeps them applicable.
    expect(runner).not.toMatch(/if not exists['"`]\s*\+/i);
    expect(runner).not.toContain("continue;");
  });
});
