import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuilderNotification } from '@/lib/builderCollaboration';

/**
 * "PROPERTY ACTIVATED BY <AGENCY>" — ON EVERY PAGE, AND WHEN THE BUILDER IS
 * NOT LOOKING AT THE PORTAL AT ALL.
 *
 * Until 30 Sep 2026 this pop-up was raised by the Dashboard page alone, from
 * a notification list that was read once per page: a builder working on the
 * Stock List, or in another tab, was told about an activation only when they
 * happened to open the Dashboard.
 */

let notifications: BuilderNotification[] | undefined;
vi.mock('@/lib/builderQueries', () => ({ useBuilderNotifications: () => ({ data: notifications }) }));

let auth: { user: { id: string } | null; activeOrganisation: { organisation_id: string } | null };
vi.mock('@/hooks/useBuilderPortalAuth', () => ({ useBuilderPortalAuth: () => auth }));

const toast = vi.fn();
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }));

const deliverDesktopAlert = vi.fn((..._args: unknown[]) => 'shown');
vi.mock('@/lib/builderPortalAlerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/builderPortalAlerts')>()),
  deliverDesktopAlert: (...args: unknown[]) => deliverDesktopAlert(...args),
}));
vi.mock('../offerDesktopAlerts', () => ({ offerDesktopAlerts: vi.fn() }));

import { BuilderActivationPopups } from '../BuilderActivationPopups';
import { resetAlertClaims } from '@/lib/builderPortalAlerts';

let sequence = 0;
function activation(overrides: Partial<BuilderNotification> = {}): BuilderNotification {
  sequence += 1;
  return {
    id: `n-${sequence}`,
    notification_type: 'stock_selection',
    title: 'Property activated by Check Agency Pty Ltd',
    body: 'Lot 101, 1 Private Street has been activated for a client by Check Agency Pty Ltd',
    scope_type: null, scope_id: null,
    entity_kind: 'stock_selection', entity_id: `a-${sequence}`,
    read_at: null,
    created_at: new Date(Date.UTC(2026, 8, 30, 1, 0, sequence)).toISOString(),
    activation: {
      announcement_id: `a-${sequence}`, task_id: null, project_id: 'project-9', stock_item_id: 'item-1',
      property_label: 'Lot 101, 1 Private Street', status: 'selected', acknowledged_at: null,
      activated_at: '2026-09-30T01:00:00Z', agency_name: 'Check Agency Pty Ltd',
      contact_name: 'Casey Agent', contact_email: 'casey@example.test', contact_phone: null, client_reference: null,
    },
    ...overrides,
  };
}

let visibility: 'visible' | 'hidden' = 'visible';
function mount(path = '/builder/stock') {
  return render(<MemoryRouter initialEntries={[path]}><BuilderActivationPopups /></MemoryRouter>);
}

beforeEach(() => {
  toast.mockReset();
  deliverDesktopAlert.mockClear();
  resetAlertClaims();
  notifications = undefined;
  auth = { user: { id: 'user-me' }, activeOrganisation: { organisation_id: 'org-a' } };
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  document.title = 'Builder Portal';
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the activation pop-up', () => {
  it('pops on a page that is not the Dashboard, with the property, the contact and an Open button', () => {
    const waiting = activation();
    notifications = [waiting];
    mount('/builder/stock');
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, options] = toast.mock.calls[0] as [string, { description: string; action: { label: string } }];
    expect(title).toBe('Property activated by Check Agency Pty Ltd');
    expect(options.description).toBe('Lot 101, 1 Private Street — Contact Casey Agent · casey@example.test');
    expect(options.action.label).toBe('Open');
  });

  it('pops each unread activation once, however often the list is read, and never a read one', () => {
    const first = activation();
    const read = activation({ read_at: '2026-09-30T02:00:00Z' });
    notifications = [first, read];
    const view = mount();
    notifications = [first, read];
    view.rerender(<MemoryRouter initialEntries={['/builder/stock']}><BuilderActivationPopups /></MemoryRouter>);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('never turns what was already waiting into a burst of desktop notifications', () => {
    visibility = 'hidden';
    notifications = [activation(), activation()];
    mount();
    expect(deliverDesktopAlert).not.toHaveBeenCalled();
  });

  it('reaches a builder in another tab: a desktop notification, a count on the tab, the pop-up on return', () => {
    notifications = [];
    const view = mount();
    visibility = 'hidden';
    const fresh = activation();
    notifications = [fresh];
    view.rerender(<MemoryRouter initialEntries={['/builder/stock']}><BuilderActivationPopups /></MemoryRouter>);

    expect(toast).not.toHaveBeenCalled();
    expect(deliverDesktopAlert).toHaveBeenCalledTimes(1);
    expect(deliverDesktopAlert.mock.calls[0][0]).toMatchObject({
      heading: 'Property activated by Check Agency Pty Ltd', path: '/builder/projects/project-9',
    });
    expect(document.title).toBe('(1) Builder Portal');

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('Builder Portal');
  });

  it('is raised by the layout every signed-in page shares, and no longer by the Dashboard', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const layout = readFileSync(join(root, 'src/components/builder-portal/BuilderPortalLayout.tsx'), 'utf8');
    expect(layout.match(/<BuilderActivationPopups \/>/g)?.length).toBe(1);
    const dashboard = readFileSync(join(root, 'src/pages/builder/BuilderDashboard.tsx'), 'utf8');
    expect(dashboard).not.toMatch(/useBuilderNotifications|useToast/);
  });
});
