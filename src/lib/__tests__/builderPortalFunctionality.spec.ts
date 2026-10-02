/**
 * THE FIVE PORTAL FIXES, HELD TO WHAT PRODUCTION ACTUALLY SHOWED.
 *
 * Every number quoted here was read from the live database on 2 October 2026
 * by `scripts/ops/portal-functionality-state.ts` (read-only, SELECT only).
 * They are in the assertions' reasons rather than in the assertions, because
 * the product must be right for every organisation and not for that one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PASSIVE_BUILDER_ACTIVITY_ACTIONS, builderActivityActor,
  isSignificantBuilderActivity, significantBuilderActivity,
} from '../../../supabase/functions/_shared/builderActivitySignificance.pure';
import {
  ACTION_REQUIRED_EMPTY, ACTION_REQUIRED_TITLE, actionRequiredItems,
} from '../builderActionRequired.pure';
import { isOfferedBuilderMessageView, WITHDRAWN_BUILDER_MESSAGE_VIEWS } from '../builderHiddenSections.pure';
import { messagesViewFrom } from '../builderAgency';
import { BUILDER_SCOPE_TYPES, SCOPE_TYPE_LABELS } from '../builderCollaboration';
import { allowedProjectTransitions } from '../builderProjects';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../', p), 'utf8');

describe('Fix 1 — Project Conversations is withdrawn, and old links still land', () => {
  it('the view is withdrawn and never offered', () => {
    expect(WITHDRAWN_BUILDER_MESSAGE_VIEWS).toContain('projects');
    expect(isOfferedBuilderMessageView('projects')).toBe(false);
    expect(isOfferedBuilderMessageView('agencies')).toBe(true);
  });

  it('a withdrawn, unknown or absent view falls back rather than dead-ending', () => {
    // Production held 0 `project_conversation_message` records and 4 agency
    // threads, so nothing is lost — but a bookmark must still open a page.
    for (const stale of ['projects', 'nonsense', '']) {
      expect(messagesViewFrom(new URLSearchParams(`view=${stale}`))).toBe('agencies');
    }
    expect(messagesViewFrom(new URLSearchParams())).toBe('agencies');
  });

  it('the page no longer builds a tab strip for it', () => {
    const page = read('src/pages/builder/BuilderMessages.tsx');
    expect(page).not.toContain('ProjectConversations');
  });
});

describe('Fix 2 — Action required replaces the delivery-attention card', () => {
  it('it says what it is, and says so when nothing is owed', () => {
    expect(ACTION_REQUIRED_TITLE).toBe('Action required');
    expect(actionRequiredItems({
      activationsAwaitingAcknowledgement: 0, propertiesNeedingAPicture: 0,
      overdueTasks: 0, unreadMessages: 0,
    })).toEqual([]);
    expect(ACTION_REQUIRED_EMPTY).toMatch(/nothing/i);
  });

  it('only a genuine outstanding count becomes an item', () => {
    const items = actionRequiredItems({
      activationsAwaitingAcknowledgement: 2, propertiesNeedingAPicture: 0,
      overdueTasks: 1, unreadMessages: 0,
    });
    expect(items.map((i) => i.count)).toEqual([2, 1]);
    expect(items.every((i) => i.count > 0)).toBe(true);
  });

  it('it never points at a withdrawn surface', () => {
    const items = actionRequiredItems({
      activationsAwaitingAcknowledgement: 9, propertiesNeedingAPicture: 9,
      overdueTasks: 9, unreadMessages: 9,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.to).not.toContain('view=projects');
  });
});

describe('Fix 3 — a project status can be changed, and the history says by whom', () => {
  it('every status a live project can hold offers somewhere to go', () => {
    // Production holds `planning` (4 projects) and `approved` (1). A status
    // with no transition draws no control at all, which is the reported fault.
    for (const status of ['planning', 'pre_sales', 'approved', 'under_construction',
      'practical_completion', 'handover', 'on_hold'] as const) {
      expect(allowedProjectTransitions(status).length).toBeGreaterThan(0);
    }
    // And the two terminal ones deliberately offer none.
    expect(allowedProjectTransitions('completed')).toEqual([]);
    expect(allowedProjectTransitions('cancelled')).toEqual([]);
  });

  it('the history carries the person, and the page never prints a column name', () => {
    const shared = read('supabase/functions/_shared/builderProjects.ts');
    expect(shared).toContain('changed_by_builder_user_id');
    expect(shared).toContain('attachStatusHistoryActors');
    const page = read('src/pages/builder/BuilderProjectDetail.tsx');
    // `changed_by_type.replace(/_/g, ' ')` printed "builder user" at a reader.
    expect(page).not.toContain("changed_by_type.replace");
    expect(page).toContain('builderActivityActor');
  });
});

describe('Fix 4 — Tasks By Record can reach a property', () => {
  it('the client offers every scope the server stores', () => {
    // Measured: all 5 tasks in production are `stock_item`, 0 on a project —
    // and `stock_item` was missing from the client list, so the picker could
    // not select the only records that have tasks.
    expect(BUILDER_SCOPE_TYPES).toContain('stock_item');
    for (const scope of BUILDER_SCOPE_TYPES) {
      expect(SCOPE_TYPE_LABELS[scope]).toBeTruthy();
      expect(SCOPE_TYPE_LABELS[scope]).not.toMatch(/_/);
    }
  });
});

describe('Fix 5 — Activity shows changes, and names who made them', () => {
  it('looking at a record is not a change', () => {
    // 474 of 4,544 log rows, and 25 of the 26 rows in the two real per-user
    // feeds, were `builder_project_viewed` under a heading saying "what has
    // changed".
    expect(isSignificantBuilderActivity('builder_project_viewed')).toBe(false);
    expect(isSignificantBuilderActivity('builder_login')).toBe(false);
    expect(isSignificantBuilderActivity('builder_notifications_read')).toBe(false);
    // And a real change survives.
    expect(isSignificantBuilderActivity('builder_project_status_changed')).toBe(true);
    expect(isSignificantBuilderActivity('builder_task_created')).toBe(true);
    expect(isSignificantBuilderActivity('builder_stock_image_supplied')).toBe(true);
  });

  it('the filter narrows and never reorders or invents', () => {
    const rows = [
      { id: '1', action: 'builder_project_viewed' },
      { id: '2', action: 'builder_task_created' },
      { id: '3', action: 'builder_login' },
      { id: '4', action: 'builder_project_status_changed' },
    ];
    expect(significantBuilderActivity(rows).map((r) => r.id)).toEqual(['2', '4']);
    // An unknown action is a change until something says otherwise: a new
    // server action must never vanish from the feed by default.
    expect(isSignificantBuilderActivity('builder_something_new')).toBe(true);
    expect(isSignificantBuilderActivity('')).toBe(false);
  });

  it('the actor is a person, never the database’s word for an account', () => {
    expect(builderActivityActor({ actor_type: 'builder_user', actor_name: 'Jordan Lee' }))
      .toBe('Jordan Lee');
    // The reported defect: every row said this.
    for (const row of [
      { actor_type: 'builder_user' },
      { actor_type: 'system' },
      { actor_type: 'service_role' },
      { actor_type: 'command_user' },
      { actor_type: 'what_is_this' },
      {},
    ]) {
      const label = builderActivityActor(row);
      expect(label).not.toBe('Portal user');
      expect(label).not.toMatch(/_/);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(builderActivityActor({ actor_type: 'system' })).toBe('System');
    // Whitespace is not a name.
    expect(builderActivityActor({ actor_type: 'builder_user', actor_name: '   ' }))
      .not.toBe('   ');
  });

  it('the feed is handed the one list, and the database is not given a second copy', () => {
    const fn = read('supabase/functions/builder-portal-workspace/index.ts');
    expect(fn).toContain('PASSIVE_BUILDER_ACTIVITY_ACTIONS');
    expect(fn).toContain('_exclude_actions');
    // An older database has no such argument; the endpoint must still answer.
    expect(fn).toContain('significantBuilderActivity');
    const migration = read(
      'supabase/migrations/20261002060000_the_activity_feed_names_who_acted.sql');
    // The gate is the same one it always was.
    expect(migration).toContain('builder_can_see_activity');
    // The name the read used to drop.
    expect(migration).toContain('builder_portal_users');
    expect(migration).toContain('actor_name');
    /*
     * NO ACTION IS NAMED IN THE SQL ITSELF: the list lives in one module and
     * is passed in. Comments may name one as evidence — and this one does —
     * so the executable lines are what is read, which is also the only half
     * that could ever disagree with the module.
     */
    const executable = migration.split('\n')
      .filter((line) => !line.trimStart().startsWith('--')).join('\n');
    for (const action of PASSIVE_BUILDER_ACTIVITY_ACTIONS) {
      expect(executable).not.toContain(action);
    }
    expect(executable).toContain('_exclude_actions');
  });
});
