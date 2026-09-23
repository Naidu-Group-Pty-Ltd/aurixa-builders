#!/usr/bin/env node
/**
 * ===========================================================================
 * DOES A FIGURE A BUILDER STATES REACH THE MARKETPLACE? ASK THE DATABASE.
 * ===========================================================================
 *
 * `20260923140000_a_builders_stated_figures_reach_the_marketplace.sql` changes
 * one block of `builder_network_compose_stock_item_payload`: the figures a
 * builder states on a card ("Complete the schedule") travel in the payload a
 * clone mirrors, in the shape the clone's marketplace reads — `values` and
 * `recorded_at` — where before every lookup read a key the column never holds.
 *
 * READING THE FUNCTION BACK WOULD PROVE THE TEXT WAS APPLIED AND NOTHING ELSE,
 * which is how the `manual_stats` CHECK came to accept every row it was
 * written to refuse. So this stores a stated land size on a real row, asks the
 * REAL composer for the payload, and reads the answer.
 *
 * NOTHING IS KEPT. It runs inside one transaction that is rolled back: an
 * organisation only if none exists, two STAGED properties (a staged row fires
 * no sync on insert), the composer's answers, and then all of it undone —
 * including anything the other triggers did.
 *
 *   usage: node scripts/ops/probe-stated-figures-payload.mjs "postgres://…"
 *          node scripts/ops/probe-stated-figures-payload.mjs          (uses PGURL)
 */
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || process.env.PGURL;
if (!url) {
  console.error('probe-stated-figures-payload: no connection string (argv[2] or PGURL)');
  process.exit(2);
}

const STATED = {
  values: { land_size_sqm: 312, bedrooms: 4 },
  recorded_at: '2026-09-23T00:00:00.000Z',
  recorded_by: '00000000-0000-4000-8000-000000000001',
};

const script = `
begin;
insert into public.builder_organisations (legal_name, org_type)
  select 'probe-stated-figures-payload', 'builder'
  where not exists (select 1 from public.builder_organisations);
select id as org from public.builder_organisations limit 1 \\gset
insert into public.builder_stock_items (organisation_id, lifecycle_status, manual_stats)
  values (:'org', 'staged', '${JSON.stringify(STATED)}'::jsonb)
  returning id as stated \\gset
insert into public.builder_stock_items (organisation_id, lifecycle_status)
  values (:'org', 'staged')
  returning id as silent \\gset
select 'stated|' || coalesce(public.builder_network_compose_stock_item_payload(:'stated')->'manual_stats', 'null'::jsonb)::text;
select 'silent|' || (public.builder_network_compose_stock_item_payload(:'silent') ? 'manual_stats')::text;
rollback;
`;

const output = execFileSync('psql', [url, '-At', '-q', '-v', 'ON_ERROR_STOP=1'],
  { input: script, encoding: 'utf8' });
const lines = Object.fromEntries(output.split('\n').filter((line) => line.includes('|'))
  .map((line) => [line.slice(0, line.indexOf('|')), line.slice(line.indexOf('|') + 1)]));

let verdict = 0;
const fail = (message) => { console.error(`FAIL ${message}`); verdict = 1; };

const stated = JSON.parse(lines.stated ?? 'null');
if (!stated || typeof stated !== 'object') {
  fail(`a stated land size composed to ${lines.stated ?? 'nothing'}`);
} else {
  if (stated.values?.land_size_sqm !== 312) fail(`values.land_size_sqm is ${JSON.stringify(stated.values?.land_size_sqm)}, not 312`);
  if (stated.values?.bedrooms !== 4) fail(`values.bedrooms is ${JSON.stringify(stated.values?.bedrooms)}, not 4`);
  if (stated.recorded_at !== STATED.recorded_at) fail(`recorded_at is ${JSON.stringify(stated.recorded_at)}`);
  if ('recorded_by' in stated) fail('recorded_by travelled; a builder user\'s id stays on the network');
  if (Object.keys(stated).some((key) => !['values', 'recorded_at'].includes(key))) {
    fail(`unexpected keys ${JSON.stringify(Object.keys(stated))}`);
  }
  if (!verdict) console.log(`ok   a stated land size travels as ${JSON.stringify(stated)}`);
}
if (lines.silent !== 'false') {
  fail(`a property with nothing stated carries manual_stats (${lines.silent ?? 'no answer'})`);
} else {
  console.log('ok   a property with nothing stated carries no manual_stats');
}
process.exit(verdict);
