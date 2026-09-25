/**
 * THE BUILDER'S AGENCIES AREA — WHAT IT READS, AND WHAT IT MAY NEVER SHOW.
 *
 * Step 4 of the Builder Portal ↔ Command Centre programme gives a builder one
 * place for the agencies (connected Command Centre workspaces) that activate
 * their stock: an Activated Properties list and a Messages shell. Neither is a
 * new source of truth. The activation IS `builder_stock_selection_announcements`
 * — the row the signed network sweep converges — and these tests hold the read
 * to that, to the session's organisation, and to what the network was
 * authorised to disclose.
 *
 * The reader is exercised against an in-memory stand-in that ENFORCES the
 * filters it is given, so an organisation boundary that is not asked for in
 * the query is a failing test here rather than a leak in production.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATED_PROPERTY_ANNOUNCEMENT_SELECT,
  projectActivatedProperties,
} from '../../../supabase/functions/_shared/builderStock/activatedProperties.pure';
import { readActivatedProperties } from '../../../supabase/functions/_shared/builderStock/activatedProperties';
import { agencyThreadKey, agencyThreadsFrom } from '../builderAgency';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
/** Comments explain a rule; only code may satisfy an assertion about code. */
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// ---------------------------------------------------------------------------
// An in-memory supabase stand-in that applies every filter it is handed.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

interface Recorded { table: string; filters: Array<[string, string, unknown]> }

function standIn(tables: Record<string, Row[]>, rpc: Record<string, Row[]> = {}) {
  const log: Recorded[] = [];
  const rpcLog: Array<{ fn: string; args: Row }> = [];

  const from = (table: string) => {
    const entry: Recorded = { table, filters: [] };
    log.push(entry);
    let orders: Array<[string, boolean]> = [];
    let window: [number, number] | null = null;
    let wantCount = false;
    const builder: any = {
      select(_cols: string, opts?: { count?: string }) { wantCount = !!opts?.count; return builder; },
      eq(col: string, value: unknown) { entry.filters.push(['eq', col, value]); return builder; },
      in(col: string, values: unknown[]) { entry.filters.push(['in', col, values]); return builder; },
      is(col: string, value: unknown) { entry.filters.push(['is', col, value]); return builder; },
      order(col: string, opts?: { ascending?: boolean }) {
        orders = [...orders, [col, opts?.ascending !== false]]; return builder;
      },
      range(a: number, b: number) { window = [a, b]; return builder; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          let rows = (tables[table] ?? []).filter((row) => entry.filters.every(([op, col, value]) => {
            if (op === 'eq') return row[col] === value;
            if (op === 'in') return (value as unknown[]).includes(row[col]);
            if (op === 'is') return (row[col] ?? null) === value;
            return true;
          }));
          for (const [col, asc] of [...orders].reverse()) {
            rows = [...rows].sort((a, b) => {
              const x = String(a[col] ?? ''); const y = String(b[col] ?? '');
              return x === y ? 0 : (x < y ? -1 : 1) * (asc ? 1 : -1);
            });
          }
          const count = rows.length;
          if (window) rows = rows.slice(window[0], window[1] + 1);
          return Promise.resolve({ data: rows, error: null, count: wantCount ? count : null })
            .then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return builder;
  };

  return {
    client: {
      from,
      rpc(fn: string, args: Row) { rpcLog.push({ fn, args }); return Promise.resolve({ data: rpc[fn] ?? [], error: null }); },
    },
    log,
    rpcLog,
  };
}

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONN_A = 'c0000000-0000-4000-8000-00000000000a';
const CONN_B = 'c0000000-0000-4000-8000-00000000000b';
const USER_A = 'u0000000-0000-4000-8000-00000000000a';

function fixture() {
  return {
    builder_stock_selection_announcements: [
      {
        id: 'ann-a1', connection_id: CONN_A, stock_item_id: 'item-a1', organisation_id: ORG_A,
        remote_selection_ref: 'ref-secret-a1', remote_client_label: 'Mr Example Client',
        status: 'builder_acknowledged', acknowledged_at: '2026-09-20T02:00:00Z',
        acknowledged_by_builder_user_id: USER_A,
        agency_name: 'Example Agency', agency_contact: {
          contact_name: 'Avery Adviser', contact_email: 'avery@agency.example', contact_phone: '0400 000 000',
        },
        activation_task_id: 'task-a1', activation_project_id: 'proj-a1',
        created_at: '2026-09-20T01:00:00Z', updated_at: '2026-09-20T02:00:00Z',
      },
      {
        id: 'ann-a2', connection_id: CONN_A, stock_item_id: 'item-a2', organisation_id: ORG_A,
        remote_selection_ref: 'ref-secret-a2', remote_client_label: null,
        status: 'selected', acknowledged_at: null, acknowledged_by_builder_user_id: null,
        agency_name: null, agency_contact: null,
        activation_task_id: null, activation_project_id: 'proj-not-mine',
        created_at: '2026-09-21T01:00:00Z', updated_at: '2026-09-21T01:00:00Z',
      },
      {
        id: 'ann-b1', connection_id: CONN_B, stock_item_id: 'item-b1', organisation_id: ORG_B,
        remote_selection_ref: 'ref-secret-b1', remote_client_label: null,
        status: 'selected', acknowledged_at: null, acknowledged_by_builder_user_id: null,
        agency_name: 'Other Agency', agency_contact: null,
        activation_task_id: null, activation_project_id: 'proj-b1',
        created_at: '2026-09-22T01:00:00Z', updated_at: '2026-09-22T01:00:00Z',
      },
    ],
    builder_stock_items: [
      {
        id: 'item-a1', organisation_id: ORG_A, lot_number: '101', unit_number: null,
        address_line: '1 Example Street', suburb: 'Exampleville', state: 'VIC', postcode: '3000',
        development_name: 'Example Estate', project_name: null, external_reference: 'EX-101',
        primary_image_id: 'img-a1', house_design: 'The Example 28',
      },
      {
        id: 'item-a2', organisation_id: ORG_A, lot_number: '102', unit_number: null,
        address_line: '2 Example Street', suburb: 'Exampleville', state: 'VIC', postcode: '3000',
        development_name: 'Example Estate', project_name: null, external_reference: null,
        primary_image_id: null, house_design: null,
      },
      {
        id: 'item-b1', organisation_id: ORG_B, lot_number: '9', unit_number: null,
        address_line: '9 Other Road', suburb: 'Elsewhere', state: 'NSW', postcode: '2000',
        development_name: null, project_name: null, external_reference: null,
        primary_image_id: 'img-b1', house_design: 'Other Design',
      },
    ],
    builder_stock_item_images: [
      {
        id: 'img-a1', stock_item_id: 'item-a1', source_stage: 'uploaded_document',
        storage_path: 'org-a/item-a1/front.jpg', external_url: null, content_type: 'image/jpeg',
        verification_status: 'source_supplied', processing_status: 'ready', position: 0,
        source_detail: null, confidence: null, error_message: null, source_reference: null,
        source_provider: null, source_page_url: null, created_at: '2026-09-19T00:00:00Z',
      },
      {
        id: 'img-b1', stock_item_id: 'item-b1', source_stage: 'uploaded_document',
        storage_path: 'org-b/item-b1/front.jpg', external_url: null, content_type: 'image/jpeg',
        verification_status: 'source_supplied', processing_status: 'ready', position: 0,
        source_detail: null, confidence: null, error_message: null, source_reference: null,
        source_provider: null, source_page_url: null, created_at: '2026-09-19T00:00:00Z',
      },
    ],
    workspace_connections: [
      { id: CONN_A, workspace_id: 'ws-a' },
      { id: CONN_B, workspace_id: 'ws-b' },
    ],
    workspace_registry: [
      { id: 'ws-a', slug: 'example-agency', display_name: 'Example Agency Workspace' },
      { id: 'ws-b', slug: 'other-agency', display_name: 'Other Agency Workspace' },
    ],
    builder_organisation_memberships: [
      { builder_user_id: USER_A, organisation_id: ORG_A, status: 'active' },
    ],
    builder_portal_users: [
      { id: USER_A, name: 'Bailey Builder', email: 'bailey@builder.example' },
    ],
    builder_project_parties: [
      // A party is a CONTACT. Its presence must never open anything.
      { id: 'party-1', project_id: 'proj-not-mine', organisation_id: ORG_A, email: 'bailey@builder.example' },
    ],
  };
}

async function readAsOrgA(accessible: string[] = ['proj-a1']) {
  const db = standIn(fixture());
  const result = await readActivatedProperties(db.client, {
    organisationId: ORG_A,
    page: 1,
    pageSize: 25,
    listAccessibleProjectIds: async () => accessible,
  });
  return { db, result };
}

describe('Activated Properties reads the existing activation record', () => {
  it('its source is the announcements table the network sweep converges — no second model', async () => {
    const { db } = await readAsOrgA();
    expect(db.log.map((q) => q.table)).toContain('builder_stock_selection_announcements');
    for (const invented of ['builder_activations', 'builder_agency_activations', 'builder_stock_selections']) {
      expect(db.log.map((q) => q.table)).not.toContain(invented);
    }
  });

  it('returns this organisation\'s activations, newest first', async () => {
    const { result } = await readAsOrgA();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => r.id)).toEqual(['ann-a2', 'ann-a1']);
    expect(result.pagination.total).toBe(2);
  });

  it('asks the database for the session organisation on every table that has one', async () => {
    const { db } = await readAsOrgA();
    for (const table of ['builder_stock_selection_announcements', 'builder_stock_items']) {
      const query = db.log.find((q) => q.table === table);
      expect(query, table).toBeDefined();
      expect(query!.filters).toContainEqual(['eq', 'organisation_id', ORG_A]);
    }
  });
});

describe('a builder cannot see another organisation\'s activation', () => {
  it('never returns an activation, property or photo that belongs to organisation B', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const text = JSON.stringify(result.records);
    for (const foreign of ['ann-b1', 'item-b1', 'img-b1', 'Other Agency', 'Other Road', CONN_B]) {
      expect(text).not.toContain(foreign);
    }
  });

  it('drops a row the query should not have returned rather than trusting it', () => {
    // Defence in depth: the projection re-checks the organisation itself.
    const f = fixture();
    const records = projectActivatedProperties({
      organisationId: ORG_A,
      announcements: f.builder_stock_selection_announcements,
      items: f.builder_stock_items,
      images: f.builder_stock_item_images,
      workspaceLabelByConnection: new Map([[CONN_A, 'A'], [CONN_B, 'B']]),
      acknowledgerNameById: new Map(),
      accessibleProjectIds: new Set(['proj-a1', 'proj-b1']),
    });
    expect(records.map((r) => r.id)).toEqual(['ann-a2', 'ann-a1']);
    // An item of another organisation never decorates an activation of this one.
    const tampered = projectActivatedProperties({
      organisationId: ORG_A,
      announcements: [{ ...f.builder_stock_selection_announcements[0], stock_item_id: 'item-b1' }],
      items: f.builder_stock_items,
      images: f.builder_stock_item_images,
      workspaceLabelByConnection: new Map(),
      acknowledgerNameById: new Map(),
      accessibleProjectIds: new Set(),
    });
    expect(tampered[0].property).toBeNull();
    expect(tampered[0].primary_image).toBeNull();
  });
});

describe('what an activation tells the builder', () => {
  it('names the agency, its workspace and its outward contact, and the acknowledgement', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const a1 = result.records.find((r) => r.id === 'ann-a1')!;
    expect(a1.agency).toEqual({
      name: 'Example Agency',
      workspace_label: 'Example Agency Workspace',
      contact_name: 'Avery Adviser',
      contact_email: 'avery@agency.example',
      contact_phone: '0400 000 000',
    });
    expect(a1.status).toBe('builder_acknowledged');
    expect(a1.activated_at).toBe('2026-09-20T01:00:00Z');
    expect(a1.acknowledged_at).toBe('2026-09-20T02:00:00Z');
    expect(a1.acknowledged_by_name).toBe('Bailey Builder');
  });

  it('carries the property, its design and its elected photograph', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const a1 = result.records.find((r) => r.id === 'ann-a1')!;
    expect(a1.property).toMatchObject({
      lot_number: '101', address_line: '1 Example Street', suburb: 'Exampleville',
      development_name: 'Example Estate', house_design: 'The Example 28',
    });
    expect(a1.primary_image?.id).toBe('img-a1');
    const a2 = result.records.find((r) => r.id === 'ann-a2')!;
    expect(a2.primary_image).toBeNull();
  });

  it('never carries the client label, the Command Centre\'s selection ref or a user id', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const text = JSON.stringify(result.records);
    expect(text).not.toContain('Mr Example Client');
    expect(text).not.toContain('ref-secret');
    for (const record of result.records) {
      expect(record).not.toHaveProperty('remote_client_label');
      expect(record).not.toHaveProperty('remote_selection_ref');
      expect(record).not.toHaveProperty('client_reference');
      expect(record).not.toHaveProperty('acknowledged_by_builder_user_id');
    }
    expect(ACTIVATED_PROPERTY_ANNOUNCEMENT_SELECT).not.toMatch(/remote_client_label|remote_selection_ref/);
  });
});

describe('the property link follows existing project access', () => {
  it('links the project only where this user already has project access', async () => {
    const { result } = await readAsOrgA(['proj-a1']);
    if (!result.ok) throw new Error('read failed');
    expect(result.records.find((r) => r.id === 'ann-a1')!.project).toEqual({ id: 'proj-a1', accessible: true });
    expect(result.records.find((r) => r.id === 'ann-a2')!.project).toEqual({ id: 'proj-not-mine', accessible: false });
  });

  it('a project party gains nothing: the parties table is never read to decide access', async () => {
    const { db, result } = await readAsOrgA([]);
    if (!result.ok) throw new Error('read failed');
    expect(db.log.map((q) => q.table)).not.toContain('builder_project_parties');
    for (const record of result.records) {
      if (record.project) expect(record.project.accessible).toBe(false);
    }
  });
});

describe('the edge operation', () => {
  const stock = readCode('supabase/functions/builder-portal-stock/index.ts');

  it('exists, and sits behind the same inventory gate the Stock List\'s activations do', () => {
    const gate = stock.indexOf("if (!await can('view'))");
    const op = stock.indexOf("operation === 'list_activated_properties'");
    expect(gate).toBeGreaterThan(-1);
    expect(op).toBeGreaterThan(gate);
  });

  it('reads through the shared reader with the server-held organisation and project resolver', () => {
    const op = stock.slice(stock.indexOf("operation === 'list_activated_properties'"));
    const body = op.slice(0, op.indexOf('operation ===', 10));
    expect(body).toContain('readActivatedProperties(supabase');
    expect(body).toContain('organisationId: activeOrganisationId');
    expect(body).toContain('listAccessibleBuilderProjectIds(supabase, me.id, activeOrganisationId');
    expect(body).not.toMatch(/body\.organisation_id|body\.organisationId/);
  });
});

describe('the Messages shell', () => {
  it('has one thread per agency and property, and no message it did not receive', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const threads = agencyThreadsFrom([...result.records, ...result.records]);
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((t) => t.key)).size).toBe(2);
    for (const thread of threads) {
      expect(thread.messages).toEqual([]);
      expect(thread.transport).toBe('not_connected');
    }
    expect(threads.map((t) => t.key)).toEqual([
      agencyThreadKey({ connection_id: CONN_A, stock_item_id: 'item-a2' }),
      agencyThreadKey({ connection_id: CONN_A, stock_item_id: 'item-a1' }),
    ]);
  });

  it('is built from this organisation\'s activations only, so another builder\'s never appears', async () => {
    const { result } = await readAsOrgA();
    if (!result.ok) throw new Error('read failed');
    const threads = agencyThreadsFrom(result.records);
    expect(JSON.stringify(threads)).not.toContain('item-b1');
  });

  it('an organisation with no activations has no threads', () => {
    expect(agencyThreadsFrom([])).toEqual([]);
  });
});
