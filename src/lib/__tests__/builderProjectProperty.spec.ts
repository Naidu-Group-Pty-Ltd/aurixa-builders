import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_PROPERTY_DOCUMENT_LINKS, propertyDocumentLinks,
} from '../../../supabase/functions/_shared/builderStock/propertyDocuments.pure';
import { projectStockItemIds } from '../../../supabase/functions/_shared/builderStock/projectProperty.pure';

/**
 * A PROJECT OPENED BY AN ACTIVATION IS A PROPERTY, AND ITS PAGE SHOWS ONE.
 *
 * The Projects page named the property and printed its figures, but drew no
 * picture — while the same property's photograph was drawn on the Stock List a
 * click away, and `get_project` already returned `primary_image_id`. These pin
 * the three things the page now rests on: which property a project IS, what
 * its own stock row links to, and that its photograph is served to anybody the
 * PROJECT is open to, through the same code the Stock List serves it with.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('what a property\'s own row links to', () => {
  const row = (unmapped: Record<string, string>, extra: Record<string, unknown> = {}) =>
    ({ unmapped, ...extra });

  it('names each link by the column the builder filed it under, and says what it is', () => {
    const links = propertyDocumentLinks(row({
      'Brochure URL': 'https://drive.google.com/file/d/brochure-id/view',
      'Floor Plan': 'https://example.com/plans/lot-12.pdf',
      'Siting / Masterplan URL': 'https://example.com/siting.pdf',
      'Estate Brochure / Location Map': 'https://example.com/estate.pdf',
      'Rental Appraisal': 'https://example.com/rent.pdf',
      'Build Price': '$477,440',
    }));
    const byLabel = Object.fromEntries(links.map((link) => [link.label, link.kind]));
    expect(byLabel).toEqual({
      Brochure: 'brochure',
      'Floor Plan': 'floor_plan',
      'Siting / Masterplan': 'site_plan',
      'Estate Brochure / Location Map': 'estate',
      'Rental Appraisal': 'other',
    });
  });

  it('carries a link only the recovery could see, and never a cell that is not a link', () => {
    const links = propertyDocumentLinks(row(
      { Brochure: 'Brochure', 'Build Price': '$1' },
      {
        recovered_link_columns: ['Brochure'],
        unmapped: { Brochure: 'https://drive.google.com/file/d/recovered/view', 'Build Price': '$1' },
      },
    ));
    expect(links.map((link) => link.url)).toEqual(['https://drive.google.com/file/d/recovered/view']);
  });

  it('lists a document pasted into two columns once, and refuses anything but http(s)', () => {
    const links = propertyDocumentLinks(row({
      'Brochure URL': 'https://example.com/a.pdf',
      Brochure: 'https://example.com/a.pdf',
      Other: 'javascript:alert(1) ftp://example.com/x.pdf',
    }));
    expect(links).toHaveLength(1);
  });

  it('is bounded, and a row with nothing says nothing', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      [`Doc ${String(i).padStart(2, '0')}`, `https://example.com/${i}.pdf`]));
    expect(propertyDocumentLinks(row(many))).toHaveLength(MAX_PROPERTY_DOCUMENT_LINKS);
    expect(propertyDocumentLinks(null)).toEqual([]);
    expect(propertyDocumentLinks({})).toEqual([]);
  });
});

describe('which property a project is', () => {
  it('is the property its activation named, before any other link', () => {
    const ids = projectStockItemIds({
      projectIds: ['p1', 'p2', 'p3'],
      activationStockItemByProject: new Map([['p1', 'stock-a']]),
      linkedStock: [
        { id: 'stock-z', builder_project_id: 'p1', updated_at: '2026-09-25T00:00:00Z' },
        { id: 'stock-b', builder_project_id: 'p2', updated_at: '2026-09-01T00:00:00Z' },
        { id: 'stock-c', builder_project_id: 'p2', updated_at: '2026-09-20T00:00:00Z' },
      ],
    });
    expect(ids.get('p1')).toBe('stock-a');
    // Of two rows naming the project, the one the builder touched last.
    expect(ids.get('p2')).toBe('stock-c');
    // A project no property names has none, rather than a guess.
    expect(ids.has('p3')).toBe(false);
  });
});

describe('builder-portal-projects serves the property the way the Stock List does', () => {
  const fn = read('supabase/functions/builder-portal-projects/index.ts');
  const view = read('supabase/functions/_shared/builderStock/propertyView.ts');

  it('reads the property through the shared view, for the detail AND the list', () => {
    expect(fn).toContain("from '../_shared/builderStock/propertyView.ts'");
    const detail = fn.slice(fn.indexOf("operation === 'get_project'"), fn.indexOf("operation === 'update_project'"));
    const list = fn.slice(fn.indexOf("operation === 'list_projects'"), fn.indexOf("operation === 'get_project'"));
    expect(detail).toContain('readPropertyViews(');
    expect(list).toContain('readPropertyViews(');
  });

  it('lays the builder\'s own figures and place over the extraction, as the Stock List does', () => {
    // The place first, then the figures: the same call decorateItems makes.
    expect(view).toMatch(/applyManualStatsToAll\(\(rawItems \?\? \[\]\)\.map\(applyStatedLocation\)\)/);
    expect(view).toContain('figuresSuppliedByDocument(');
    expect(view).toContain('document_figures');
  });

  it('pins every read to the organisation this session acts as', () => {
    const reads = view.split('db.from(').slice(1);
    expect(reads.length).toBe(3);
    for (const statement of reads) expect(statement).toContain(".eq('organisation_id', organisationId)");
  });

  it('serves a project\'s photograph to whoever the PROJECT is open to, and only its own', () => {
    const op = fn.slice(fn.indexOf("operation === 'image_url'"));
    expect(op.indexOf('loadProject(')).toBeGreaterThan(-1);
    expect(op.indexOf('loadProject(')).toBeLessThan(op.indexOf('serveStockImage('));
    // The image must belong to this project's property, in this organisation.
    expect(op).toContain(".eq('stock_item_id', stockItemId)");
    expect(op).toContain(".eq('organisation_id', activeOrganisationId)");
    // The Stock List's inventory permission is not what opens a project.
    expect(op).not.toMatch(/inventory/);
  });

  it('never writes a project access grant — a party is a contact, not a key', () => {
    expect(fn).not.toMatch(/from\('builder_project_access'\)/);
    expect(fn).not.toMatch(/builder_grant|grant_project_access/);
  });
});

describe('the Stock List reads the brochure figures it reports on', () => {
  it('selects document_figures where it decorates a property (the #113 read)', () => {
    const stock = read('supabase/functions/builder-portal-stock/index.ts');
    const decorate = stock.slice(stock.indexOf('async function decorateItems('));
    const select = decorate.match(/\.select\('id, source_row, source_provenance_result[^']*'\)/)?.[0] ?? '';
    expect(select).toContain('document_figures');
    expect(decorate).toContain('documentFigures: documentFiguresByItem.get(');
  });
});
