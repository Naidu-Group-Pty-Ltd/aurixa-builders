#!/usr/bin/env node
/**
 * ===========================================================================
 * DOES A KILLED WORKER STILL BILL THE PROPERTY? ASK THE DATABASE.
 * ===========================================================================
 *
 * `20260922100000_a_worker_we_killed_must_not_bill_the_property.sql` changes
 * one branch of `builder_stock_image_watchdog`: the FIRST expiry of a lease
 * makes the property claimable immediately, and every expiry after it keeps
 * the bounded ladder (30 s, 60 s, 120 s, 240 s, then flat 300 s).
 *
 * READING THE FUNCTION BACK WOULD PROVE THE TEXT WAS APPLIED AND NOTHING
 * ELSE. This repository has paid for that distinction more than once — the
 * retention purge asserted by its configuration, the `manual_stats` CHECK
 * that accepted every row it was written to refuse, the AML `.or()` whose
 * test agreed with the code while only the server disagreed. So this puts a
 * row in each of the two states, runs the REAL function, reads the REAL
 * `image_work_next_attempt_at` back, and removes what it made.
 *
 * IT DOES NOT BELONG IN THE MIGRATION. Inserting a `builder_stock_items` row
 * fires the trigger that schedules the settlement cron job, and running the
 * watchdog touches every other row it is responsible for deployment-wide.
 * Neither is a thing a migration should do; both are fine in a gate against
 * the acceptance database, and fine once against production after a deploy.
 *
 * WHAT IT CLEANS UP, AND WHAT IT DOES NOT. It deletes exactly the two rows it
 * inserted, by id, and nothing else — it never touches a row it did not
 * create. If it cannot delete them it says so loudly rather than exiting
 * green, because two synthetic properties left in a real organisation's stock
 * is worse than a failed probe.
 *
 *   usage: node scripts/ops/probe-watchdog-backoff.mjs "postgres://…"
 *          node scripts/ops/probe-watchdog-backoff.mjs          (uses PGURL)
 */
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || process.env.PGURL;
if (!url) {
  console.error('probe-watchdog-backoff: no connection string (argv[2] or PGURL)');
  process.exit(2);
}

const psql = (sql) => execFileSync('psql', [url, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8' }).trim();

/*
 * AN ORGANISATION TO HANG THE TWO PROBE ROWS ON.
 *
 * Production and a seeded acceptance run both have one; a freshly built
 * database does not, and refusing there would mean the gate silently stopped
 * proving this the moment the build order changed. So one is MADE when none
 * exists — `pending_activation`, inactive, named for what it is — and removed
 * with the rows at the end. An organisation that was already there is used as
 * found and never touched.
 */
let org = psql('select id from public.builder_organisations limit 1');
const mintedOrg = !org;
if (mintedOrg) {
  org = psql(`insert into public.builder_organisations (legal_name, org_type)
              values ('probe-watchdog-backoff', 'builder') returning id;`);
}
if (!org) {
  console.error('probe-watchdog-backoff: no builder organisation to probe against');
  process.exit(2);
}

/*
 * A CLAIM THAT EXPIRED FIVE MINUTES AGO, which is past the watchdog's own
 * thirty-second grace whichever way the clocks are skewed. One row has never
 * failed; the other has failed once, so the ladder should already be running
 * for it.
 */
const ids = psql(`
  insert into public.builder_stock_items
    (organisation_id, lifecycle_status, image_work_stage,
     image_work_failures, image_work_claim_until, image_work_next_attempt_at)
  values
    ('${org}', 'staged', 'sanitization', 0, now() - interval '5 minutes', now()),
    ('${org}', 'staged', 'sanitization', 1, now() - interval '5 minutes', now())
  returning id || '|' || image_work_failures;
`).split('\n').filter(Boolean);

if (ids.length !== 2) {
  console.error(`probe-watchdog-backoff: expected two probe rows, got ${ids.length}`);
  process.exit(1);
}
const byFailures = Object.fromEntries(ids.map((row) => {
  const [id, failures] = row.split('|');
  return [failures, id];
}));

let verdict = 0;
try {
  psql('select public.builder_stock_image_watchdog();');
  const read = (id) => psql(
    `select extract(epoch from (image_work_next_attempt_at - now()))::int
       from public.builder_stock_items where id = '${id}';`);
  const first = Number(read(byFailures['0']));
  const second = Number(read(byFailures['1']));

  // The first expiry: claimable now. A couple of seconds of slack for the
  // round trip, and nothing like the thirty the ladder would have written.
  if (!(first <= 2)) {
    console.error(`FAIL a first lease expiry still buys ${first}s of backoff`);
    verdict = 1;
  } else {
    console.log(`ok   first expiry -> claimable in ${first}s`);
  }
  // The second: the ladder, undisturbed. 30·2^1 = 60 s for failure 2.
  if (!(second >= 30)) {
    console.error(`FAIL a second lease expiry lost its backoff (${second}s)`);
    verdict = 1;
  } else {
    console.log(`ok   second expiry -> backoff ${second}s`);
  }
} finally {
  const removed = psql(
    `delete from public.builder_stock_items
      where id in ('${byFailures['0']}', '${byFailures['1']}') returning id;`)
    .split('\n').filter(Boolean).length;
  if (removed !== 2) {
    console.error(`probe-watchdog-backoff: LEFT ${2 - removed} PROBE ROW(S) BEHIND — remove by hand`);
    verdict = 1;
  }
  if (mintedOrg) {
    const gone = psql(
      `delete from public.builder_organisations where id = '${org}' returning id;`).trim();
    if (!gone) {
      console.error(`probe-watchdog-backoff: LEFT PROBE ORGANISATION ${org} BEHIND`);
      verdict = 1;
    }
  }
}
process.exit(verdict);
