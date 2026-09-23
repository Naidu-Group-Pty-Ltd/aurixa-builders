#!/usr/bin/env node
/**
 * ===========================================================================
 * DOES AN ADDRESS A BUILDER STATES REACH THE MARKETPLACE? ASK THE DATABASE.
 * ===========================================================================
 *
 * `20260923160000_a_builder_can_state_where_a_property_is.sql` does two
 * things, and each is asserted here by EFFECT rather than by reading the text
 * back — reading it back is how the `manual_stats` CHECK came to accept every
 * row it was written to refuse:
 *
 *   1. `builder_stock_items_manual_stats_shape` admits a stated street,
 *      suburb, state and postcode under `values`, and still refuses anything
 *      else: a state outside the eight, a postcode that is not four digits, a
 *      part that is not a string, a JSON null, a key it does not know, and an
 *      object with no `values` at all.
 *   2. `builder_network_compose_stock_item_payload` sends the EFFECTIVE
 *      address — the builder's part where one is stated, the document's
 *      where not — in the ordinary columns a clone copies, and sends
 *      `manual_stats` only where a FIGURE is stated.
 *
 * NOTHING IS KEPT. Everything runs inside one transaction that is rolled
 * back: an organisation only if none exists, STAGED properties (a staged row
 * fires no sync on insert), the composer's answers, and each refusal inside
 * its own savepoint.
 *
 * The places are placeholders of the right shape, never a customer's.
 *
 *   usage: node scripts/ops/probe-stated-location-payload.mjs "postgres://…"
 *          node scripts/ops/probe-stated-location-payload.mjs          (uses PGURL)
 */
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || process.env.PGURL;
if (!url) {
  console.error('probe-stated-location-payload: no connection string (argv[2] or PGURL)');
  process.exit(2);
}

const RECORDED_AT = '2026-09-23T00:00:00.000Z';
const BY = '00000000-0000-4000-8000-000000000001';
const statement = (values) => JSON.stringify({ values, recorded_at: RECORDED_AT, recorded_by: BY });

// What the document said, on both properties: a whole address, so that every
// part the builder does NOT state can be seen to survive.
const DOCUMENT = { address_line: 'Lot 7 Document Street', suburb: 'Document Vale', state: 'NSW', postcode: '2000' };

// An address alone — the Lot 101 shape: no figure stated.
const PLACED = { suburb: 'Sample Rise', state: 'VIC', postcode: '3999' };
// An address part beside a figure.
const MIXED = { address_line: 'Lot 7 Sample Crescent', land_size_sqm: 312 };

// Each must be REFUSED by the constraint. The label is what a failure names.
const REFUSED = [
  ['a state outside the eight', { values: { state: 'XX' } }],
  ['a lower-case state', { values: { state: 'vic' } }],
  ['a three-digit postcode', { values: { postcode: '399' } }],
  ['a numeric postcode', { values: { postcode: 3999 } }],
  ['a numeric suburb', { values: { suburb: 42 } }],
  ['a one-character suburb', { values: { suburb: 'X' } }],
  ['a two-character street', { values: { address_line: 'Lo' } }],
  ['a JSON null part', { values: { state: null } }],
  ['an unknown key', { values: { country: 'AU' } }],
  ['an empty statement', { values: {} }],
  ['a statement with no values', { location: { suburb: 'Sample Rise' } }],
];

const columns = "jsonb_build_object('address_line', p->'address_line', 'suburb', p->'suburb', 'state', p->'state', 'postcode', p->'postcode', 'has_manual_stats', p ? 'manual_stats', 'manual_stats', p->'manual_stats')";
const q = (text) => `'${text.replace(/'/g, "''")}'`;

const script = `
begin;
insert into public.builder_organisations (legal_name, org_type)
  select 'probe-stated-location-payload', 'builder'
  where not exists (select 1 from public.builder_organisations);
select id as org from public.builder_organisations limit 1 \\gset
insert into public.builder_stock_items (organisation_id, lifecycle_status, address_line, suburb, state, postcode, manual_stats)
  values (:'org', 'staged', ${q(DOCUMENT.address_line)}, ${q(DOCUMENT.suburb)}, ${q(DOCUMENT.state)}, ${q(DOCUMENT.postcode)}, ${q(statement(PLACED))}::jsonb)
  returning id as placed \\gset
insert into public.builder_stock_items (organisation_id, lifecycle_status, address_line, suburb, state, postcode, manual_stats)
  values (:'org', 'staged', ${q(DOCUMENT.address_line)}, ${q(DOCUMENT.suburb)}, ${q(DOCUMENT.state)}, ${q(DOCUMENT.postcode)}, ${q(statement(MIXED))}::jsonb)
  returning id as mixed \\gset
select 'placed|' || (select ${columns} from (select public.builder_network_compose_stock_item_payload(:'placed') as p) s)::text;
select 'mixed|' || (select ${columns} from (select public.builder_network_compose_stock_item_payload(:'mixed') as p) s)::text;
select set_config('probe.org', :'org', true) \\gset
create temp table probe_refusals (label text, outcome text) on commit drop;
do $probe$
declare
  entry record;
begin
  for entry in select * from jsonb_each(${q(JSON.stringify(Object.fromEntries(REFUSED)))}::jsonb) loop
    begin
      insert into public.builder_stock_items (organisation_id, lifecycle_status, manual_stats)
        values (current_setting('probe.org')::uuid, 'staged', entry.value);
      insert into probe_refusals values (entry.key, 'accepted');
    exception when check_violation then
      insert into probe_refusals values (entry.key, 'refused');
    end;
  end loop;
end
$probe$;
select 'refusal|' || label || '|' || outcome from probe_refusals order by label;
rollback;
`;

let output;
try {
  output = execFileSync('psql', [url, '-At', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  // The FIRST insert is refused by a constraint that predates this change —
  // which is the defect, stated as the database states it.
  console.error(`FAIL the database refused a stated address: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
  process.exit(1);
}

const lines = output.split('\n').filter((line) => line.includes('|'));
const answer = (key) => {
  const line = lines.find((entry) => entry.startsWith(`${key}|`));
  return line ? JSON.parse(line.slice(key.length + 1)) : null;
};

let verdict = 0;
const fail = (message) => { console.error(`FAIL ${message}`); verdict = 1; };

const placed = answer('placed');
if (!placed) {
  fail('the composer returned nothing for a stated address');
} else {
  for (const [field, value] of Object.entries(PLACED)) {
    if (placed[field] !== value) fail(`a stated ${field} travelled as ${JSON.stringify(placed[field])}, not ${JSON.stringify(value)}`);
  }
  // The part NOT stated keeps the document's reading.
  if (placed.address_line !== DOCUMENT.address_line) {
    fail(`an unstated street became ${JSON.stringify(placed.address_line)}; the document's must stand`);
  }
  // An address alone is not a figure, and sends no manual_stats at all.
  if (placed.has_manual_stats !== false) {
    fail(`an address alone sent manual_stats ${JSON.stringify(placed.manual_stats)}`);
  }
  if (!verdict) console.log(`ok   a stated address travels in the columns a clone copies: ${placed.suburb} ${placed.state} ${placed.postcode}, street kept as the document's`);
}

const mixed = answer('mixed');
const before = verdict;
if (!mixed) {
  fail('the composer returned nothing for a stated address beside a figure');
} else {
  if (mixed.address_line !== MIXED.address_line) fail(`a stated street travelled as ${JSON.stringify(mixed.address_line)}`);
  if (mixed.suburb !== DOCUMENT.suburb || mixed.state !== DOCUMENT.state || mixed.postcode !== DOCUMENT.postcode) {
    fail(`unstated parts did not keep the document's reading: ${JSON.stringify(mixed)}`);
  }
  const values = mixed.manual_stats?.values ?? null;
  if (!values || values.land_size_sqm !== 312) fail(`the stated figure travelled as ${JSON.stringify(mixed.manual_stats)}`);
  if (values && Object.keys(values).some((key) => key !== 'land_size_sqm')) {
    fail(`manual_stats carried more than the figures: ${JSON.stringify(values)}`);
  }
  if (verdict === before) console.log(`ok   a stated street and a stated figure travel apart: street in address_line, ${JSON.stringify(mixed.manual_stats)}`);
}

const outcomes = new Map(lines.filter((line) => line.startsWith('refusal|'))
  .map((line) => line.split('|')).map(([, label, outcome]) => [label, outcome]));
for (const [label] of REFUSED) {
  const outcome = outcomes.get(label);
  if (outcome !== 'refused') fail(`the constraint did not refuse ${label} (${outcome ?? 'no answer'})`);
}
if (REFUSED.every(([label]) => outcomes.get(label) === 'refused')) {
  console.log(`ok   the constraint refuses all ${REFUSED.length} malformed statements`);
}
process.exit(verdict);
