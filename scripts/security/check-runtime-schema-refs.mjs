/**
 * Runtime schema-reference gate.
 *
 * The extraction renamed the terms tables (`portal_terms_*` →
 * `builder_terms_*`) and withdrew the Command Centre's
 * `builder_stock_selections`; the runtime kept calling all three by their
 * old names and CI stayed green, because the baseline check proves the
 * DATABASE and the Deno check proves the TYPES — nothing held the runtime's
 * SQL against the standalone schema. This gate closes the static half of
 * that gap; `scripts/db/baseline-check.mjs` §4 closes the dynamic half by
 * proving every `.from()` / `.rpc()` literal in the ACTIVE runtime against
 * the rebuilt schema and exercising the flows.
 *
 * Scope here is EVERY runtime and browser source — withdrawn modules
 * included, because these three names have no legitimate reader anywhere in
 * this repository (a withdrawn module still deploys, and the old names
 * would fail at runtime for it exactly as they did for the active ones).
 * Comments are stripped first so prose about the rename cannot trip the
 * gate; specs and this script family are excluded because they QUOTE the
 * forbidden names in order to forbid them.
 *
 * Run with: npm run check:schema-refs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());

/** Objects the standalone schema does not carry, under any circumstances. */
const REMOVED_OBJECTS = [
  'portal_terms_versions',
  'portal_terms_acceptances',
  'builder_stock_selections',
];

const SCAN_ROOTS = ['supabase/functions', 'api', 'src'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);
const EXCLUDED = [
  /\.spec\.[tj]sx?$/, /\.test\.[tj]sx?$/, /__tests__\//,
  /scripts\//, /node_modules\//,
];

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(path);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.slice(dot))) continue;
    const rel = relative(root, path);
    if (EXCLUDED.some((pattern) => pattern.test(rel))) continue;
    files.push(path);
  }
};
for (const scanRoot of SCAN_ROOTS) walk(join(root, scanRoot));

const failures = [];
const pattern = new RegExp(`\\b(${REMOVED_OBJECTS.join('|')})\\b`);
for (const file of files) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const match = line.match(pattern);
    if (match) {
      failures.push(`${relative(root, file)}:${index + 1} references removed object "${match[1]}"`);
    }
  });
}

if (failures.length) {
  console.error(`${failures.length} removed-object reference(s) in runtime source:`);
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.error(
    '\nThese objects were renamed or withdrawn by the network extraction '
    + '(terms live in builder_terms_*; workspace selections arrive as '
    + 'builder_stock_selection_announcements). Point the code at the '
    + 'standalone schema rather than re-creating the clone object.');
  process.exit(1);
}
console.log(`schema-reference gate passed: ${files.length} runtime sources are clean of ${REMOVED_OBJECTS.join(', ')}.`);
