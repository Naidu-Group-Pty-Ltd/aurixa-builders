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
 * THE PROPERTIES, EACH ONE A WAY THE IMPORT COULD GO WRONG:
 *
 *   1. a free row is claimable
 *   2. a claimed row is NOT claimable by anybody else
 *   3. a release naming the WRONG token changes nothing (the stale-worker
 *      case: the whole safety property of the release)
 *   4. a release naming the right token frees it
 *   5. an EXPIRED lease is claimable again, without anybody intervening
 *   6. a worker that died holding the claim is owed recovery
 *   7. a live claim keeps the tick alive and is NEVER recovered — recovery
 *      beside a live worker is two workers
 *   8. a hand-off let go moments ago is kept alive and NOT re-dispatched —
 *      its successor is on its way
 *   9. a hand-off nobody took within a minute IS owed recovery — the lost
 *      dispatch, which the first version of this migration could not see
 *  10. an import no worker ever held is neither — nothing a worker did
 *      makes it recovery's business
 *  11. a claim or a release from an EARLIER attempt is neither — "Read
 *      again" takes no claim, so a re-read in progress carries the previous
 *      import's release, and reading that as a lost hand-off would start a
 *      second reader beside a live one
 *  12. a hand-off holding no claim (the re-read's) is still owed recovery
 *      when its successor never arrives — the dispatch stamps it
 *  13. the recovery bound stops all of it, so a document that dies every
 *      time cannot loop the minute tick
 *  14. a claim arms the tick — observable only where pg_cron is real and the
 *      tick was not already running, and reported as unobservable otherwise
 *      rather than passed
 *
 * SAFE AGAINST ANY DEPLOYMENT. It asks the read-only
 * `builder_stock_imports_owed_recovery()` and never calls the recovery that
 * acts on it, because that dispatches real invocations for real imports. The
 * one property that must call the dispatcher (12) runs only when told the
 * dispatcher reaches nothing — `--may-dispatch`, which the acceptance gate
 * passes — and is reported as not exercised otherwise.
 *
 *   usage: node scripts/ops/probe-import-claim.mjs "postgres://…" [--may-dispatch]
 *                                                  [--organisation=<uuid>]
 *          node scripts/ops/probe-import-claim.mjs          (uses PGURL)
 */
import { execFileSync } from 'node:child_process';

const url = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || process.env.PGURL;
const mayDispatch = process.argv.includes('--may-dispatch');
if (!url) {
  console.error('probe-import-claim: no connection string (argv[2] or PGURL)');
  process.exit(2);
}

const psql = (sql) => execFileSync('psql', [url, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8' }).trim();

// An organisation to hang the probe rows on — used as found, or made and
// removed. Same rule as `probe-watchdog-backoff`, and for the same reason.
// `--organisation=<uuid>` names one, so a run against a live deployment puts
// its rows on the operator's own organisation rather than a customer's.
const named = (process.argv.find((arg) => arg.startsWith('--organisation=')) ?? '')
  .slice('--organisation='.length);
if (named && !/^[0-9a-f-]{36}$/i.test(named)) {
  console.error('probe-import-claim: --organisation must be a uuid');
  process.exit(2);
}
let org = named
  ? psql(`select id from public.builder_organisations where id = '${named}';`)
  : psql('select id from public.builder_organisations limit 1');
if (named && !org) {
  console.error(`probe-import-claim: no organisation ${named}`);
  process.exit(2);
}
const mintedOrg = !org;
if (mintedOrg) {
  org = psql(`insert into public.builder_organisations (legal_name, org_type)
              values ('probe-import-claim', 'builder') returning id;`);
}
if (!org) {
  console.error('probe-import-claim: no builder organisation to probe against');
  process.exit(2);
}

/*
 * AN ATTEMPT THAT BEGAN TEN MINUTES AGO, so that what the probe does to a row
 * happens inside it — every claim and release is newer than the attempt's
 * start, exactly as in a real import. `startedAgo` of zero is an attempt
 * starting now, which is what a re-read looks like against the history an
 * earlier import left on the row.
 */
const newParsingUpload = (name, startedAgo = "interval '10 minutes'") => psql(`
  insert into public.builder_stock_uploads
    (organisation_id, original_filename, storage_bucket, storage_path,
     status, processing_started_at)
  values ('${org}', '${name}.pdf', 'builder-stock-lists',
          'probe/${org}/${name}.pdf', 'parsing', now() - ${startedAgo})
  returning id;
`);

const id = newParsingUpload('probe-import-claim');
// A row in the state a live import is in for the instant between being marked
// `parsing` and being claimed — and the state every import was in before this
// migration. No worker has held it.
const neverHeld = newParsingUpload('probe-import-claim-never-held');
// A re-read that has just begun, on a row an earlier import claimed and let go.
const reread = newParsingUpload('probe-import-claim-reread', "interval '0 seconds'");

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
const inFlight = () => Number(psql('select public.builder_stock_imports_in_flight();'));
/** Is THIS row owed recovery? Asked of the read-only set, never the dispatcher. */
const owed = (row = id) => psql(`select count(*) from public.builder_stock_imports_owed_recovery() o(id)
                                  where o.id = '${row}';`) === '1';
/**
 * How the keep-alive count moves across one change to the probe row, measured
 * tightly around it so another deployment's imports starting or finishing
 * cannot be mistaken for this row's effect.
 */
const inFlightDelta = (change) => {
  const before = inFlight();
  change();
  return inFlight() - before;
};
const TICK = 'settle-builder-stock-marketplace-eligibility';
const cronIsReal = () => psql(`select exists(select 1 from pg_extension where extname = 'pg_cron');`) === 't';
const tickScheduled = () => psql(`select exists(select 1 from cron.job where jobname = '${TICK}');`) === 't';

try {
  const realCron = cronIsReal();
  const tickWasRunning = realCron && tickScheduled();

  check(inFlightDelta(() => check(claim('worker-a'), 'a free import is claimable',
    'a free import refused the claim')) === 1,
  'a claimed import keeps the recovery tick alive',
  'A CLAIMED IMPORT LETS THE TICK UNSCHEDULE UNDER IT');

  // 14. Arming. Observable only where pg_cron is real and the tick was idle.
  if (!realCron) {
    console.log('--   a claim arms the recovery tick: unobservable here (pg_cron is not installed); asserted where it is');
  } else if (tickWasRunning) {
    console.log('--   a claim arms the recovery tick: unobservable here (the tick was already running)');
  } else {
    check(tickScheduled(), 'a claim arms the recovery tick',
      'A CLAIMED IMPORT HAS NO TICK TO RECOVER IT');
  }

  check(!claim('worker-b'), 'a claimed import refuses a second worker',
    'TWO WORKERS CAN HOLD THE SAME IMPORT');

  check(!owed(), 'a live claim is never recovered',
    'RECOVERY WOULD START A SECOND WORKER BESIDE A LIVE ONE');

  check(!release('worker-b') && heldBy() === 'worker-a',
    'a release naming the wrong token changes nothing',
    'A STALE WORKER RELEASED A SUCCESSOR\'S CLAIM');

  check(release('worker-a') && heldBy() === '',
    'a release naming the right token frees the import',
    'the holder could not release its own claim');

  // 8. The hand-off, the instant after it: successor dispatched, not arrived.
  check(!owed(), 'a hand-off let go moments ago is not re-dispatched',
    'RECOVERY RACES A SUCCESSOR THAT IS STILL ON ITS WAY');
  check(inFlight() >= 1 && psql(`select (import_released_at is not null)::text
                                   from public.builder_stock_uploads where id = '${id}';`) === 'true',
    'a hand-off waiting for its successor keeps the tick alive',
    'A HAND-OFF CAN LOSE THE TICK THAT STANDS BEHIND IT');

  // 9. The lost dispatch. Released, and nobody took it for five minutes.
  psql(`update public.builder_stock_uploads
           set import_released_at = now() - interval '5 minutes' where id = '${id}';`);
  check(owed(), 'a hand-off nobody took within a minute is owed recovery',
    'A LOST DISPATCH LEAVES AN IMPORT NOTHING CAN SEE');

  // 10. Never held: parsing, no token, no release.
  check(!owed(neverHeld), 'an import no worker ever held is never recovered',
    'RECOVERY STARTS A READER BESIDE AN IMPORT THAT NEVER NEEDED A CLAIM');

  // 11. The history an EARLIER import left on a row a re-read now holds.
  const staleRelease = inFlightDelta(() => psql(`update public.builder_stock_uploads
      set import_released_at = now() - interval '1 day' where id = '${reread}';`));
  check(!owed(reread) && staleRelease === 0,
    'a release from an earlier attempt is never recovered, and keeps nothing alive',
    'RECOVERY STARTS A SECOND READER BESIDE A LIVE RE-READ');
  psql(`update public.builder_stock_uploads
           set import_claim_token = 'a-worker-from-last-week',
               import_claim_until = now() - interval '1 day'
         where id = '${reread}';`);
  check(!owed(reread), 'a claim from an earlier attempt is never recovered',
    'A STALE CLAIM MAKES A LIVE RE-READ LOOK DEAD');

  // 12. A hand-off holding no claim, as a re-read hands off. The dispatcher
  // is the only thing that can say it happened, so it is called — here only.
  if (!mayDispatch) {
    console.log('--   a hand-off holding no claim is still recovered: not exercised (needs --may-dispatch; it calls the real dispatcher)');
  } else {
    psql(`select public.builder_stock_dispatch_import_continuation('${neverHeld}');`);
    const stampedNow = !owed(neverHeld);
    psql(`update public.builder_stock_uploads
             set import_released_at = now() - interval '5 minutes' where id = '${neverHeld}';`);
    check(stampedNow && owed(neverHeld),
      'a hand-off holding no claim is recovered once its successor fails to arrive',
      'A RE-READ WHOSE DISPATCH IS LOST IS LEFT READING FOR EVER');
  }

  // 5 & 6. An expired lease: the killed-worker case. Claimed, never handed back.
  check(claim('worker-c', 10), 'a freed import is claimable again',
    'a freed import stayed shut');
  psql(`update public.builder_stock_uploads
           set import_claim_until = now() - interval '1 minute' where id = '${id}';`);
  check(owed(), 'a worker that died holding the claim is owed recovery',
    'a dead worker left an import nothing can see');
  check(claim('worker-d'), 'an expired lease is claimable by the next worker',
    'AN EXPIRED LEASE HELD THE IMPORT SHUT');

  // 13. And the bound, on both ways of being owed.
  psql(`update public.builder_stock_uploads
           set import_claim_until = now() - interval '1 minute',
               import_recovery_attempts = 3
         where id = '${id}';`);
  const diedAtBound = !owed();
  psql(`update public.builder_stock_uploads
           set import_claim_token = null, import_claim_until = null,
               import_released_at = now() - interval '5 minutes'
         where id = '${id}';`);
  const lostAtBound = !owed();
  check(diedAtBound && lostAtBound
    && inFlightDelta(() => psql(`update public.builder_stock_uploads
                                    set import_recovery_attempts = 2 where id = '${id}';`)) === 1,
  'an import stops counting, and stops being recovered, once its recovery bound is spent',
  'A FAILING IMPORT CAN LOOP THE MINUTE TICK FOR EVER');
} finally {
  for (const row of [id, neverHeld, reread]) {
    const removed = psql(
      `delete from public.builder_stock_uploads where id = '${row}' returning id;`).trim();
    if (!removed) {
      console.error(`probe-import-claim: LEFT PROBE UPLOAD ${row} BEHIND — remove by hand`);
      verdict = 1;
    }
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
