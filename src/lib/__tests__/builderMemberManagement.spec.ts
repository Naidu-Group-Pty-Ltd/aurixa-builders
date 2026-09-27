/**
 * Member management in the portal: the pure half (what the endpoint answers
 * for each refusal, and how the member list is shaped). The authority itself
 * is proved against a real database by scripts/db/member-management-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import {
  MANAGEABLE_ROLES, MEMBER_ACTIONS, memberRefusal, shapeMembers,
} from '../../../supabase/functions/_shared/builderMemberManagement.pure';

describe('member management refusals', () => {
  it('maps every database refusal to a status and a sentence, never leaking the code as prose', () => {
    const cases: Array<[string, number]> = [
      ['BUILDER_NOT_ORG_ADMIN', 403], ['BUILDER_OWNER_ONLY', 403], ['BUILDER_MEMBERSHIP_NOT_FOUND', 404],
      ['BUILDER_MEMBER_SELF_MANAGEMENT', 409], ['BUILDER_LAST_OWNER', 409], ['BUILDER_MEMBER_ROLE_INVALID', 400],
      ['BUILDER_MEMBER_ACTION_UNKNOWN', 400], ['BUILDER_MEMBER_NOT_ACTIVE', 409], ['BUILDER_MEMBER_NOT_SUSPENDED', 409],
    ];
    for (const [code, status] of cases) {
      const r = memberRefusal(`ERROR: ${code}`);
      expect(r?.status, code).toBe(status);
      expect(r?.error).not.toMatch(/BUILDER_/);
    }
    expect(memberRefusal('connection reset')).toBeNull();
  });
  it('offers only the roles invitations offer, never owner', () => {
    expect([...MANAGEABLE_ROLES]).toEqual(['administrator', 'manager', 'member', 'read_only']);
    expect([...MEMBER_ACTIONS]).toEqual(['set_role', 'suspend', 'reactivate', 'remove']);
  });
});

describe('the member list', () => {
  const rows = [
    { id: 'm1', builder_user_id: 'u1', membership_role: 'owner', status: 'active' },
    { id: 'm2', builder_user_id: 'u2', membership_role: 'administrator', status: 'active' },
    { id: 'm3', builder_user_id: 'u3', membership_role: 'member', status: 'suspended' },
    { id: 'm4', builder_user_id: 'u4', membership_role: 'read_only', status: 'active' },
  ];
  const users = [
    { id: 'u1', name: 'Owen', email: 'owen@x.example', status: 'active' },
    { id: 'u2', name: 'Ada', email: 'ada@x.example', status: 'active' },
    { id: 'u3', name: 'Max', email: 'max@x.example', status: 'active' },
    { id: 'u4', name: 'New Person', email: 'new@x.example', status: 'invited' },
  ];
  it('separates pending invitations from members and says who may be managed by an administrator', () => {
    const shaped = shapeMembers(rows, users, { callerId: 'u2', callerRole: 'administrator' });
    expect(shaped.members.map((m) => m.builder_user_id)).toEqual(['u1', 'u2', 'u3']);
    expect(shaped.invitations.map((m) => m.builder_user_id)).toEqual(['u4']);
    const by = Object.fromEntries(shaped.members.map((m) => [m.builder_user_id, m]));
    expect(by.u1.can_manage).toBe(false); // an owner, and the caller is an administrator
    expect(by.u2.can_manage).toBe(false); // self
    expect(by.u2.is_self).toBe(true);
    expect(by.u3.can_manage).toBe(true);
    expect(by.u3.status).toBe('suspended');
  });
  it('lets an owner manage another owner, never themselves', () => {
    const shaped = shapeMembers([...rows, { id: 'm5', builder_user_id: 'u5', membership_role: 'owner', status: 'active' }],
      [...users, { id: 'u5', name: 'Olive', email: 'olive@x.example', status: 'active' }], { callerId: 'u1', callerRole: 'owner' });
    const by = Object.fromEntries(shaped.members.map((m) => [m.builder_user_id, m]));
    expect(by.u1.can_manage).toBe(false);
    expect(by.u5.can_manage).toBe(true);
  });
});
