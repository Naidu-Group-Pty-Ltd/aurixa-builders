/**
 * A builder who typed the right password is told WHY they cannot come in.
 *
 * The reported defect: an operator suspends an organisation and its members
 * are told "Invalid email or password" — so they reset a password that was
 * never wrong, and are told the same thing again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_DENIAL,
  membershipIsLive,
  readAccessDenial,
  readLockout,
  type MembershipRow,
} from '../../../supabase/functions/_shared/builderAccessDenial.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const NOW = new Date('2026-09-18T06:00:00Z');

const membership = (over: Partial<MembershipRow> = {}): MembershipRow => ({
  status: 'active',
  revoked_at: null,
  valid_from: '2026-01-01T00:00:00Z',
  valid_until: null,
  organisation_status: 'active',
  organisation_legal_name: 'Bright Homes Pty Ltd',
  ...over,
});

describe('the suspended organisation', () => {
  it('is named, and the password is explicitly exonerated', () => {
    const reading = readAccessDenial([membership({ organisation_status: 'suspended' })], NOW);
    expect(reading.code).toBe('organisation_suspended');
    expect(reading.message).toContain('Bright Homes Pty Ltd');
    expect(reading.message).toMatch(/suspended/i);
    // The whole point: stop sending people to the password reset.
    expect(reading.message).toMatch(/nothing is wrong with your password/i);
  });

  it('falls back to a neutral subject when the organisation has no name', () => {
    for (const name of [null, '', '   ']) {
      const reading = readAccessDenial(
        [membership({ organisation_status: 'suspended', organisation_legal_name: name })],
        NOW,
      );
      expect(reading.code).toBe('organisation_suspended');
      expect(reading.message.startsWith('Your organisation')).toBe(true);
    }
  });

  it('outranks a second membership that merely ended', () => {
    // The actionable reason wins: the operator can lift a suspension.
    const reading = readAccessDenial(
      [
        membership({ status: 'revoked', organisation_legal_name: 'Old Co' }),
        membership({ organisation_status: 'suspended', organisation_legal_name: 'Bright Homes Pty Ltd' }),
      ],
      NOW,
    );
    expect(reading.code).toBe('organisation_suspended');
    expect(reading.message).toContain('Bright Homes Pty Ltd');
  });

  it('is not claimed for an organisation the builder no longer belongs to', () => {
    // A suspended organisation the member was already removed from is not
    // why they cannot sign in.
    const reading = readAccessDenial(
      [membership({ organisation_status: 'suspended', revoked_at: '2026-05-01T00:00:00Z' })],
      NOW,
    );
    expect(reading.code).toBe('membership_ended');
  });
});

describe('the other organisation states', () => {
  it('names an unapproved registration as awaiting approval', () => {
    const reading = readAccessDenial(
      [membership({ organisation_status: 'pending_activation' })],
      NOW,
    );
    expect(reading.code).toBe('organisation_pending_activation');
    expect(reading.message).toMatch(/approved/i);
  });

  it('names a closed organisation and does not promise a route back', () => {
    const reading = readAccessDenial([membership({ organisation_status: 'closed' })], NOW);
    expect(reading.code).toBe('organisation_closed');
    expect(reading.message).toMatch(/cannot be reopened/i);
  });

  it('says nothing new about an organisation state it cannot classify', () => {
    // A confident wrong sentence is worse than the generic refusal.
    const reading = readAccessDenial([membership({ organisation_status: 'something_new' })], NOW);
    expect(reading).toEqual(GENERIC_DENIAL);
    expect(reading.message).toBe('');
  });
});

describe('membership state', () => {
  it('treats revoked, expired, not-yet-valid and inactive as ended', () => {
    const ended: Partial<MembershipRow>[] = [
      { revoked_at: '2026-05-01T00:00:00Z' },
      { valid_until: '2026-05-01T00:00:00Z' },
      { valid_from: '2027-01-01T00:00:00Z' },
      { status: 'suspended' },
    ];
    for (const over of ended) {
      expect(membershipIsLive(membership(over), NOW)).toBe(false);
      expect(readAccessDenial([membership(over)], NOW).code).toBe('membership_ended');
    }
  });

  it('does not name the organisation when the membership is what ended', () => {
    // Somebody removed them; that organisation's record is not ours to narrate.
    const reading = readAccessDenial([membership({ revoked_at: '2026-05-01T00:00:00Z' })], NOW);
    expect(reading.message).not.toContain('Bright Homes');
  });

  it('separates belonging to nothing from having been removed', () => {
    expect(readAccessDenial([], NOW).code).toBe('no_membership');
    expect(readAccessDenial([], NOW).message).not.toBe(
      readAccessDenial([membership({ revoked_at: '2026-05-01T00:00:00Z' })], NOW).message,
    );
  });
});

describe('a locked account', () => {
  it('says the password was right and when the lock lifts', () => {
    const reading = readLockout('2026-09-18T06:07:30Z', NOW);
    expect(reading?.code).toBe('account_locked');
    expect(reading?.message).toMatch(/8 minutes/);
    expect(reading?.message).toMatch(/password was correct/i);
  });

  it('is silent when there is no live lock', () => {
    expect(readLockout(null, NOW)).toBeNull();
    expect(readLockout('2026-09-18T05:59:00Z', NOW)).toBeNull();
    expect(readLockout('not-a-date', NOW)).toBeNull();
  });

  it('never reports less than a minute', () => {
    expect(readLockout('2026-09-18T06:00:01Z', NOW)?.message).toMatch(/1 minute\b/);
  });
});

describe('where this may be consulted', () => {
  const login = read('supabase/functions/builder-portal-login/index.ts');
  const code = login.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('is read only after the password has been verified', () => {
    // An attacker without the password must never reach it — that is the
    // whole basis on which this module is allowed to be specific.
    // Compare CALL SITES, not mentions: the import sits at the top of the
    // file, above everything, so a naive indexOf would always "fail".
    //
    // `readAccessDenial` itself is no longer called here. It moved behind
    // `explainNoAccessibleOrganisation`, which reads the memberships and
    // applies it — one implementation, because activation needs the same
    // sentence and two copies is how two surfaces come to disagree. This
    // follows the call rather than pinning the old name.
    const body = code.replace(/^import[\s\S]*?from\s*'[^']*';\s*$/gm, ' ');
    const verified = body.indexOf('passwordValid');
    for (const call of [
      'explainNoAccessibleOrganisation(',
      'readAccountState(',
      'readLockout(',
    ]) {
      const consulted = body.indexOf(call);
      expect(consulted, call).toBeGreaterThan(-1);
      expect(consulted, call).toBeGreaterThan(verified);
    }
    expect(verified).toBeGreaterThan(-1);
  });

  it('is applied in exactly one place, so both surfaces say the same thing', () => {
    // The login route and the activation route must not each carry their own
    // membership query and their own reading of it.
    const helper = read('supabase/functions/_shared/builderPortalAuth.ts');
    expect(helper).toContain('readAccessDenial(');
    for (const caller of [
      'supabase/functions/builder-portal-login/index.ts',
      'supabase/functions/builder-portal-accept-invite/index.ts',
    ]) {
      const source = read(caller)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      expect(source, caller).toContain('explainNoAccessibleOrganisation(');
      expect(source, caller).not.toContain('readAccessDenial(');
    }
  });

  it('never decides access, only explains a refusal already made', () => {
    // The authority stays `builder_accessible_organisations`. The module may
    // NAME it — its header explains which module decides and why this one
    // must not — but it must never call it.
    expect(code).toContain('listAccessibleOrganisations');
    const source = read('supabase/functions/_shared/builderAccessDenial.pure.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(source).not.toMatch(/\ballowed\s*:/);
    expect(source).not.toContain('builder_accessible_organisations');
    expect(source).not.toMatch(/\bfrom\s*\(|\brpc\s*\(|\bsupabase\b/);
  });
});
