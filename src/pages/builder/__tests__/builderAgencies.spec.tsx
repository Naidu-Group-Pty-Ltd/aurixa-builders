import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE AGENCIES AREA, AS A BUILDER MEETS IT.
 *
 * One section, two bookmarkable tabs — Activated Properties and Messages —
 * reached from the portal navigation only by a user whose organisation role
 * already opens the Stock List's activations (`inventory` view). The data is
 * mocked at the query hook; what is asserted is what the page does with it:
 * the property link appears only where project access already exists, the
 * Messages shell invents no message and offers no working composer, and an
 * empty organisation is told so rather than shown a blank.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const state: {
  records: any[];
  error: { status?: number; message?: string } | null;
  loading: boolean;
} = { records: [], error: null, loading: false };

vi.mock('@/lib/builderStockQueries', () => ({
  useBuilderActivatedProperties: () => ({
    data: state.error ? undefined : { records: state.records, pagination: { page: 1, page_size: 25, total: state.records.length, total_pages: 1 } },
    error: state.error,
    isLoading: state.loading,
    isFetching: false,
    refetch: vi.fn(),
  }),
  builderStockImageUrl: vi.fn(async () => null),
}));

import BuilderAgencies from '../BuilderAgencies';
import { builderNavItemVisible } from '@/components/builder-portal/builderNavVisibility.pure';

const ACTIVATION = {
  id: 'ann-a1',
  connection_id: 'conn-a',
  stock_item_id: 'item-a1',
  status: 'builder_acknowledged',
  activated_at: '2026-09-20T01:00:00Z',
  updated_at: '2026-09-20T02:00:00Z',
  acknowledged_at: '2026-09-20T02:00:00Z',
  acknowledged_by_name: 'Bailey Builder',
  agency: {
    name: 'Example Agency',
    workspace_label: 'Example Agency Workspace',
    contact_name: 'Avery Adviser',
    contact_email: 'avery@agency.example',
    contact_phone: null,
  },
  property: {
    lot_number: '101', unit_number: null, address_line: '1 Example Street',
    suburb: 'Exampleville', state: 'VIC', postcode: '3000',
    development_name: 'Example Estate', house_design: 'The Example 28', external_reference: null,
  },
  primary_image: null,
  project: { id: 'proj-a1', accessible: true },
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder/agencies" element={<BuilderAgencies />} />
        <Route path="/builder/agencies/:tab" element={<BuilderAgencies />} />
        <Route path="/builder/projects/:projectId" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.records = [];
  state.error = null;
  state.loading = false;
});

describe('navigation', () => {
  it('offers the Agencies area only to a user who can already view activations', () => {
    const item = { to: '/builder/agencies', label: 'Agencies', permission: 'inventory' } as const;
    expect(builderNavItemVisible(item, { can: () => true, showCompliance: false })).toBe(true);
    expect(builderNavItemVisible(item, { can: () => false, showCompliance: false })).toBe(false);
    // Asked for the right key and level, not merely "anything".
    const asked: string[] = [];
    builderNavItemVisible(item, { can: (k, l) => { asked.push(`${k}:${l}`); return true; }, showCompliance: false });
    expect(asked).toEqual(['inventory:view']);
  });

  it('leaves every existing entry exactly as visible as it was', () => {
    const plain = { to: '/builder/projects', label: 'Projects' } as const;
    expect(builderNavItemVisible(plain, { can: () => false, showCompliance: false })).toBe(true);
  });

  it('is declared in the portal navigation and routed as one section with bookmarkable tabs', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toMatch(/to: '\/builder\/agencies', label: 'Agencies'[^}]*permission: 'inventory'/);
    expect(layout).toContain('builderNavItemVisible(');
    const app = code('src/App.tsx');
    expect(app).toContain('path="agencies"');
    expect(app).toContain('path="agencies/:tab"');
  });

  it('does not replace or rename the builder team\'s own Messages section', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toContain("{ to: '/builder/messages', label: 'Messages'");
  });
});

describe('Activated Properties', () => {
  it('lists each activation with its property, design, agency, contact and acknowledgement', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies/activations');
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(/Lot 101/)).toBeInTheDocument();
    expect(within(row).getByText(/1 Example Street/)).toBeInTheDocument();
    expect(within(row).getByText('The Example 28')).toBeInTheDocument();
    expect(within(row).getByText('Example Agency')).toBeInTheDocument();
    expect(within(row).getByText('Avery Adviser')).toBeInTheDocument();
    expect(within(row).getByText('Acknowledged')).toBeInTheDocument();
    expect(within(row).getByText(/Bailey Builder/)).toBeInTheDocument();
  });

  it('links the property to its project where the builder has project access', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies/activations');
    expect(screen.getByRole('link', { name: /view project/i })).toHaveAttribute('href', '/builder/projects/proj-a1');
  });

  it('draws no project link where the builder has no project access', () => {
    state.records = [{ ...ACTIVATION, project: { id: 'proj-a1', accessible: false } }];
    renderAt('/builder/agencies/activations');
    expect(screen.queryByRole('link', { name: /view project/i })).toBeNull();
  });

  it('says when no agency has activated anything yet', () => {
    renderAt('/builder/agencies/activations');
    expect(screen.getByText(/no agency has activated/i)).toBeInTheDocument();
  });

  it('says so, rather than showing an empty list, when the server refuses', () => {
    state.error = { status: 403, message: 'You do not have access to stock' };
    renderAt('/builder/agencies/activations');
    expect(screen.getByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText(/no agency has activated/i)).toBeNull();
  });

  it('is the section\'s default tab', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies');
    expect(screen.getByRole('tab', { name: /activated properties/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Messages shell', () => {
  it('lists one conversation per agency and property, with no messages it did not receive', () => {
    state.records = [ACTIVATION, { ...ACTIVATION, id: 'ann-a1-again' }];
    renderAt('/builder/agencies/messages');
    expect(screen.getByRole('tab', { name: /messages/i })).toHaveAttribute('aria-selected', 'true');
    const conversations = screen.getAllByRole('option');
    expect(conversations).toHaveLength(1);
    fireEvent.click(conversations[0]);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
    expect(screen.getAllByText('Example Agency').length).toBeGreaterThan(0);
    const composer = screen.getByRole('textbox', { name: /message/i });
    expect(composer).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('tells an organisation with no activations that there is nobody to message yet', () => {
    renderAt('/builder/agencies/messages');
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });

  it('sends nothing anywhere: no mutation, no model, no email', () => {
    const page = code('src/pages/builder/BuilderAgencies.tsx');
    expect(page).not.toMatch(/useMutation|mutateAsync|invoke\(/);
    expect(page).not.toMatch(/openrouter|anthropic|openai|claude/i);
    expect(page).not.toMatch(/mailto:.*send|sendEmail/);
  });
});
