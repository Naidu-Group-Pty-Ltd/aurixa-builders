import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WITHDRAWN_BUILDER_SECTIONS,
  WITHDRAWN_BUILDER_SECTION_KEYS,
  isWithdrawnBuilderPath,
  withdrawnSectionForPath,
} from '@/lib/builderHiddenSections.pure';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Source with its comments removed.
 *
 * An assertion about what a page SAYS must not be satisfied — or broken — by
 * prose explaining the rule. This exact trap has been hit twice in this
 * repository: a test forbidding a phrase matched the comment that explained
 * why the phrase was forbidden.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('withdrawn builder sections — the set itself', () => {
  it('is exactly the five sections that are not offered', () => {
    expect(WITHDRAWN_BUILDER_SECTIONS.map((s) => s.label)).toEqual([
      'Inventory', 'Transactions', 'Pipeline', 'Construction', 'Documents',
    ]);
  });

  it('matches a section and everything under it', () => {
    // Each of these owns children — a unit, a transaction, a construction
    // case and its delivery leaf are INSIDE the section, not beside it.
    expect(isWithdrawnBuilderPath('/builder/construction')).toBe(true);
    expect(isWithdrawnBuilderPath('/builder/construction/abc')).toBe(true);
    expect(isWithdrawnBuilderPath('/builder/construction/abc/delivery')).toBe(true);
    expect(isWithdrawnBuilderPath('/builder/inventory/unit-1')).toBe(true);
  });

  it('does not match a sibling that merely shares an opening', () => {
    // A bare `startsWith` would withdraw a section nobody asked to hide.
    expect(isWithdrawnBuilderPath('/builder/documentsomething')).toBe(false);
    expect(isWithdrawnBuilderPath('/builder/inventoryx')).toBe(false);
  });

  it('leaves every offered section alone', () => {
    for (const path of [
      '/builder', '/builder/projects', '/builder/stock', '/builder/messages',
      '/builder/tasks', '/builder/notifications', '/builder/activity',
      '/builder/settings', '/builder/compliance',
    ]) {
      expect(isWithdrawnBuilderPath(path)).toBe(false);
    }
  });

  it('answers a missing path without throwing', () => {
    expect(isWithdrawnBuilderPath(null)).toBe(false);
    expect(isWithdrawnBuilderPath(undefined)).toBe(false);
    expect(isWithdrawnBuilderPath('')).toBe(false);
    expect(withdrawnSectionForPath(null)).toBeNull();
  });

  it('names the section a path belongs to', () => {
    expect(withdrawnSectionForPath('/builder/construction/abc')?.label).toBe('Construction');
    expect(withdrawnSectionForPath('/builder/projects')).toBeNull();
  });
});

describe('withdrawn builder sections — every door asks the same list', () => {
  /*
   * A section is reachable from more places than its sidebar entry, and
   * removing the entry alone leaves the others working. These assertions are
   * about the SHAPE of each surface — that it consults the module — rather
   * than about the strings, because a hard-coded copy in any one of them is
   * how "hidden" comes to mean "hidden from the sidebar".
   */

  it('the navigation filters on the module, not on a private list', () => {
    const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toContain('isWithdrawnBuilderPath');
    // One filter has to serve both surfaces: the desktop sidebar and the
    // mobile sheet mount the same SidebarNav.
    expect(layout.match(/<SidebarNav/g)?.length).toBe(2);
  });

  it('leaves the builder portal exactly nine navigation entries', () => {
    /*
     * The real NAV routes, put through the real predicate. Everything else
     * here checks that a surface CONSULTS the module; this checks the answer
     * it gets, which is what an operator actually sees.
     *
     * Compliance is flag-gated on top of this and absent wherever the flag is
     * off, so nine is the ceiling rather than the count on every deployment.
     */
    const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
    const nav = layout.slice(layout.indexOf('const NAV'), layout.indexOf('function tourAnchor'));
    const routes = [...nav.matchAll(/to: '(\/builder[a-z/]*)'/g)].map((m) => m[1]);

    expect(routes).toHaveLength(14);
    const shown = routes.filter((to) => !isWithdrawnBuilderPath(to));
    expect(shown).toEqual([
      '/builder',
      '/builder/compliance',
      '/builder/projects',
      '/builder/stock',
      '/builder/messages',
      '/builder/tasks',
      '/builder/notifications',
      '/builder/activity',
      '/builder/settings',
    ]);
    expect(routes.length - shown.length).toBe(WITHDRAWN_BUILDER_SECTIONS.length);
  });

  it('the dashboard filters its figures and its attention rows', () => {
    const dash = read('src/pages/builder/BuilderDashboard.tsx');
    // Both figure arrays plus the attention list, and the import.
    expect(dash.match(/isWithdrawnBuilderPath/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('the onboarding tour drops the steps whose anchors are gone', () => {
    const tour = read('src/components/builder-portal/BuilderOnboardingTour.tsx');
    expect(tour).toContain('WITHDRAWN_BUILDER_SECTION_KEYS');
    // Everything downstream must read the FILTERED list, or the progress
    // dots and the "3 of N" counter promise steps that never arrive.
    expect(tour).toContain('const VISIBLE_STEPS: TourStep[] = STEPS.filter');
    // And nothing at runtime may read the unfiltered table.
    expect(tour).not.toMatch(/\bSTEPS\.length\b/);
    expect(tour).not.toMatch(/\bSTEPS\.map\(/);
  });

  it('the routes stay declared and land on the notice', () => {
    // Hiding is not deleting: a route that stops existing falls through to
    // the catch-all and lands on the dashboard with no explanation, which
    // reads as a broken link rather than a decision.
    const app = read('src/App.tsx');
    for (const path of [
      'inventory', 'inventory/:unitId',
      'transactions', 'transactions/:transactionId',
      'pipeline',
      'construction', 'construction/:constructionCaseId',
      'construction/:constructionCaseId/delivery',
      'documents',
    ]) {
      expect(app).toContain(`<Route path="${path}" element={<BuilderSectionWithdrawn />} />`);
    }
  });

  it('leaves the offered sections routed to their own pages', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('<Route path="stock" element={<BuilderStockList />} />');
    expect(app).toContain('<Route path="projects" element={<BuilderProjects />} />');
    expect(app).toContain('<Route path="messages" element={<BuilderMessages />} />');
  });

  it('keeps the page components, so re-offering a section is one edit', () => {
    // The pages, their queries and their edge functions are untouched.
    const app = read('src/App.tsx');
    for (const page of [
      'BuilderInventory', 'BuilderUnitDetail', 'BuilderTransactions',
      'BuilderTransactionDetail', 'BuilderPipeline', 'BuilderConstruction',
      'BuilderConstructionDetail', 'BuilderDeliveryDetail', 'BuilderDocuments',
    ]) {
      expect(app).toContain(`const ${page} = lazyWithRetry`);
    }
  });

  it('the notice says nothing about permissions', () => {
    // The reader has not been denied anything — the portal does not carry
    // the section. "You do not have access" sends somebody to an
    // administrator who has nothing to grant.
    const page = readCode('src/pages/builder/BuilderSectionWithdrawn.tsx');
    const rendered = page.toLowerCase();
    expect(rendered).not.toContain('do not have access');
    expect(rendered).not.toContain('permission');
    expect(rendered).not.toContain('unauthorised');
    expect(page).toContain('not part of the Builder / Developer Portal');
  });

  it('the keys match the tour anchors they filter', () => {
    const tour = read('src/components/builder-portal/BuilderOnboardingTour.tsx');
    for (const key of WITHDRAWN_BUILDER_SECTION_KEYS) {
      // The anchor must still be SPELLED in ALL_STEPS for the filter to have
      // something to remove; a renamed anchor would silently re-show a step.
      if (key === 'pipeline') continue; // the tour never had a pipeline step
      expect(tour).toContain(`data-tour="${key}"`);
    }
  });
});
