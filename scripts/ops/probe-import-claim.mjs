#!/usr/bin/env node
/**
 * ===========================================================================
 * CAN TWO WORKERS IMPORT THE SAME STOCK LIST? ASK THE DATABASE.
 * ===========================================================================
 *
 * `20260922140000_an_import_too_big_for_one_isolate_hands_off_rather_than_dying.sql`
 * makes an import resumable, and the moment it is resumable four things
 * become possible that were not before — a continuation dispatched twice, a
 * successor starting while its predecessor is alive, a builder clicking
 * through a second `process_upload`, and a killed worker holding the row
 * shut. `builder_stock_claim_import` answers all four, and this asks it.
 *
 * READING THE FUNCTION BACK WOULD PROVE THE TEXT WAS APPLIED AND NOTHING
 * ELSE. This repository has paid for that distinction repeatedly — the
 * retention purge asserted by its configuration, the `manual_stats` CHECK
 * that accepted every row it was written to refuse, the AML `.or()` whose
 * test agreed with the code while only the server disagreed. So this runs the
 * REAL functions against REAL rows, reads the REAL columns back, and removes
 * what it made.
 *
 * SIX PROPERTIES, EACH ONE A WAY THE IMPORT COULD GO WRONG:
 *
 *   1. a free row is claimable
 *   2. a claimed row is NOT claimable by anybody else
 *   3. a release naming the WRONG token changes nothing (the stale-worker
 *      case: the whole safety property of the release)
 *   4. a release naming the right token frees it
 *   5. an EXPIRED lease is claimable again, without anybody intervening
 *   6. a claimed row whose claim is gone counts as a stalled import, and
 *      stops counting once the recovery bound is spent
 *
 *   usage: node scripts/ops/probe-import-claim.mjs "postgres://…"
 *          node scripts/ops/probe-import-claim.mjs          (uses PGURL)
 */
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || process.env.PGURL;
if (!url) {
  console.error('probe-import-claim: no connection string (argv[2] or PGURL)');
  process.exit(2);
}

const psql = (sql) => execFileSync('psql', [url, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8' }).trim();

// An organisation to hang the probe row on — used as found, or made and
// removed. Same rule as `probe-watchdog-backoff`, and for the same reason.
let org = psql('select id from public.builder_organisations limit 1');
const mintedOrg = !org;
if (mintedOrg) {
  org = psql(`insert into public.builder_organisations (legal_name, org_type)
              values ('probe-import-claim', 'builder') returning id;`);
}
if (!org) {
  console.error('probe-import-claim: no builder organisation to probe against');
  process.exit(2);
}

const stalled = () => Number(psql('select public.builder_stock_stalled_imports();'));
const stalledBefore = stalled();

const id = psql(`
  insert into public.builder_stock_uploads
    (organisation_id, original_filename, storage_bucket, storage_path,
     status, processing_started_at)
  values ('${org}', 'probe-import-claim.pdf', 'builder-stock-lists',
          'probe/${org}/probe-import-claim.pdf', 'parsing', now())
  returning id;
`);

let verdict = 0;
const check = (ok, good, bad) => {
  if (ok) console.log(`ok   ${good}`);
  else { console.error(`FAIL ${bad}`); verdict = 1; }
};
const claim = (token, lease = 90) =>
  psql(`select public.builder_stock_claim_import('${id}', '${token}', ${lease});`) === 't';
const release = (token) =>
  psql(`select public.builder_stock_release_import('${id}', '${token}');`) === 't';
const heldBy = () => psql(`select coalesce(import_claim_token, '')
                             from public.builder_stock_uploads where id = '${id}';`);

try {
  check(claim('worker-a'), 'a free import is claimable',
    'a free import refused the claim');

  check(!claim('worker-b'), 'a claimed import refuses a second worker',
    'TWO WORKERS CAN HOLD THE SAME IMPORT');

  check(!release('worker-b') && heldBy() === 'worker-a',
    'a release naming the wrong token changes nothing',
    'A STALE WORKER RELEASED A SUCCESSOR\'S CLAIM');

  check(release('worker-a') && heldBy() === '',
    'a release naming the right token frees the import',
    'the holder could not release its own claim');

  // An expired lease: the killed-worker case. Claimed, never handed back.
  check(claim('worker-c', 10), 'a freed import is claimable again',
    'a freed import stayed shut');
  psql(`update public.builder_stock_uploads
           set import_claim_until = now() - interval '1 minute' where id = '${id}';`);
  check(stalled() === stalledBefore + 1,
    'a claim that expired with the row still parsing counts as stalled',
    'a dead worker left an import nothing can see');
  check(claim('worker-d'), 'an expired lease is claimable by the next worker',
    'AN EXPIRED LEASE HELD THE IMPORT SHUT');

  // And the bound, so a document that dies every time cannot loop the tick.
  psql(`update public.builder_stock_uploads
           set import_claim_until = now() - interval '1 minute',
               import_recovery_attempts = 3
         where id = '${id}';`);
  check(stalled() === stalledBefore,
    'a stalled import stops counting once its recovery bound is spent',
    'A FAILING IMPORT CAN LOOP THE MINUTE TICK FOR EVER');
} finally {
  const removed = psql(
    `delete from public.builder_stock_uploads where id = '${id}' returning id;`).trim();
  if (!removed) {
    console.error(`probe-import-claim: LEFT PROBE UPLOAD ${id} BEHIND — remove by hand`);
    verdict = 1;
  }
  if (mintedOrg) {
    const gone = psql(
      `delete from public.builder_organisations where id = '${org}' returning id;`).trim();
    if (!gone) {
      console.error(`probe-import-claim: LEFT PROBE ORGANISATION ${org} BEHIND`);
      verdict = 1;
    }
  }
}
process.exit(verdict);
