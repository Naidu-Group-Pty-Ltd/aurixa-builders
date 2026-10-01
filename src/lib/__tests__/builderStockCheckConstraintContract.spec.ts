/**
 * NO STOCK-PIPELINE WRITE NAMES A VALUE ITS COLUMN'S CHECK WOULD REFUSE.
 *
 * 30 September 2026: the manifest writer recorded a `branch_kind` the
 * column's CHECK did not name, the database refused the write, and 41 ready
 * properties were held off the marketplace by a state nobody chose. A
 * refused write looks, from the code, exactly like a write nobody attempted.
 *
 * For every enumerated CHECK on the four stock tables, the allowed set is read
 * from the LATEST migration that defines it, and every literal assignment to
 * that column in the stock pipeline (`column: 'value'`, `.eq('column', 'value')`
 * is a read and is ignored) must be in it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/** constraint name → the column it governs */
const CONTRACTS: Record<string, string> = {
  builder_stock_uploads_status_check: 'status',
  builder_stock_uploads_source_manifest_state_check: 'source_manifest_state',
  builder_stock_uploads_image_failure_state_check: 'image_failure_state',
  builder_stock_uploads_source_type_check: 'source_type',
  builder_stock_items_lifecycle_status_check: 'lifecycle_status',
  builder_stock_items_image_work_stage_check: 'image_work_stage',
  builder_stock_items_enrichment_status_check: 'enrichment_status',
  builder_stock_items_availability_status_check: 'availability_status',
  builder_stock_item_images_processing_status_check: 'processing_status',
  builder_stock_item_images_source_stage_check: 'source_stage',
  builder_stock_item_images_verification_status_check: 'verification_status',
  builder_stock_source_assets_state_check: 'state',
  builder_stock_source_assets_branch_kind_check: 'branch_kind',
  builder_stock_source_assets_kind_check: 'kind',
};

const TABLES = ['builder_stock_source_assets', 'builder_stock_item_images', 'builder_stock_uploads', 'builder_stock_items'];

function allowedValues(constraint: string): Set<string> {
  let found: string | null = null;
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const re = new RegExp(`CONSTRAINT ${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*(?:,|;|NOT VALID)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) found = m[1];
    // An inline column CHECK carries no name of its own (Postgres names it
    // `<table>_<column>_check`), so it is read by its table and column.
    const table = TABLES.find((t) => constraint.startsWith(`${t}_`));
    const column = CONTRACTS[constraint];
    if (table && sql.includes(table)) {
      const inline = new RegExp(`CHECK \\(\\s*\\(?${column} IN \\(([^)]*)\\)`, 'g');
      while ((m = inline.exec(sql))) found = m[1];
    }
  }
  if (!found) throw new Error(`no definition of ${constraint}`);
  return new Set([...found.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const fnRoot = join(ROOT, 'supabase/functions');
const sources = [
  ...walk(join(fnRoot, '_shared/builderStock')),
  ...readdirSync(fnRoot).filter((d) => d.startsWith('builder-')).flatMap((d) => walk(join(fnRoot, d))),
].map((p) => [p.slice(ROOT.length + 1), readFileSync(p, 'utf8')] as const);


describe('stock pipeline writes and CHECK constraints agree', () => {
  for (const [constraint, column] of Object.entries(CONTRACTS)) {
    it(`${column} (${constraint})`, () => {
      const allowed = allowedValues(constraint);
      expect(allowed.size).toBeGreaterThan(1);
      const offenders: string[] = [];
      for (const [path, src] of sources) {
        // A write is judged only in a file that names the column's table:
        // `lifecycle_status` and `status` exist on other tables too.
        const table = TABLES.find((t) => constraint.startsWith(`${t}_`))!;
        if (!src.includes(table)) continue;
        const re = new RegExp(`(?<![.\\w'"])${column}\\s*:\\s*'([a-z_]+)'`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (!allowed.has(m[1])) {
            const line = src.slice(0, m.index).split('\n').length;
            offenders.push(`${path}:${line} ${column}: '${m[1]}'`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
