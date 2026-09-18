/**
 * Mission Control's organisation CRUD, and the two lines it may not cross:
 * the lifecycle columns move only under their own verbs, and an operator
 * bootstraps an EMPTY organisation rather than administering somebody else's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AU_STATES,
  DESCRIPTIVE_COLUMNS,
  ORG_TYPES,
  readOrganisationInput,
} from '../../../supabase/functions/_shared/builderOrganisationInput.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('creating an organisation', () => {
  it('requires a legal name', () => {
    for (const body of [{}, { legal_name: '' }, { legal_name: '   ' }]) {
      const result = readOrganisationInput(body, 'create');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('a_legal_name_is_required');
    }
  });

  it('trims and keeps the description', () => {
    const result = readOrganisationInput(
      { legal_name: '  Bright Homes Pty Ltd ', trading_name: 'Bright Homes', org_type: 'builder' },
      'create',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.legal_name).toBe('Bright Homes Pty Ltd');
      expect(result.patch.org_type).toBe('builder');
    }
  });

  it('refuses an org_type the column would reject', () => {
    const result = readOrganisationInput({ legal_name: 'X', org_type: 'plumber' }, 'create');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('org_type_is_not_recognised');
    for (const type of ORG_TYPES) {
      expect(readOrganisationInput({ legal_name: 'X', org_type: type }, 'create').ok).toBe(true);
    }
  });

  it('normalises an ABN written with spaces, and lowercases the email', () => {
    const result = readOrganisationInput(
      { legal_name: 'X', org_type: 'builder', abn: ' 12 345 678 901 ', contact_email: ' Owner@Example.COM ' },
      'create',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.abn).toBe('12345678901');
      expect(result.patch.contact_email).toBe('owner@example.com');
    }
  });

  it('refuses a contact address that is not an email', () => {
    const result = readOrganisationInput({ legal_name: 'X', org_type: 'builder', contact_email: 'not-an-email' }, 'create');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('contact_email_is_not_an_email');
  });
});

/**
 * Every shape rule the COLUMN holds, refused here with the field's own name.
 *
 * The rules are read out of the migration rather than restated, so this suite
 * fails if the table gains a constraint the validator does not enforce —
 * which is exactly how six of eight realistic console inputs came to reach
 * Postgres and return an unattributed 500.
 */
describe('the column rules are enforced before the database sees them', () => {
  const migration = read('supabase/migrations/00000000000000_network_baseline.sql');
  const table = migration.slice(
    migration.indexOf('CREATE TABLE public.builder_organisations '),
    migration.indexOf('CREATE TABLE public.builder_organisations ') + 4000,
  );
  const complete = (over: Record<string, unknown> = {}) => ({
    legal_name: 'Bright Homes Pty Ltd',
    org_type: 'builder',
    ...over,
  });

  it('requires a type, because the column is NOT NULL with no default', () => {
    expect(table).toMatch(/org_type text NOT NULL/);
    expect(table).not.toMatch(/org_type text NOT NULL DEFAULT/);
    for (const absent of [{}, { org_type: '' }, { org_type: '   ' }]) {
      const result = readOrganisationInput({ legal_name: 'X', ...absent }, 'create');
      expect(result.ok, JSON.stringify(absent)).toBe(false);
      if (!result.ok) expect(result.error).toBe('an_organisation_type_is_required');
    }
  });

  it('never lets an edit clear the type', () => {
    const result = readOrganisationInput({ org_type: '' }, 'update');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('an_organisation_type_is_required');
  });

  it('holds an ABN to eleven digits and an ACN to nine', () => {
    expect(table).toContain("abn ~ '^[0-9]{11}$'");
    expect(table).toContain("acn ~ '^[0-9]{9}$'");
    for (const [field, bad, error] of [
      ['abn', '123', 'abn_must_be_11_digits'],
      ['abn', '123456789012', 'abn_must_be_11_digits'],
      ['abn', 'not-a-number', 'abn_must_be_11_digits'],
      ['acn', 'abc', 'acn_must_be_9_digits'],
      ['acn', '12345678', 'acn_must_be_9_digits'],
    ] as const) {
      const result = readOrganisationInput(complete({ [field]: bad }), 'create');
      expect(result.ok, `${field}=${bad}`).toBe(false);
      if (!result.ok) expect(result.error).toBe(error);
    }
    // Spacing is the operator's, not a different number.
    const ok = readOrganisationInput(complete({ abn: '12 345 678 901', acn: '123-456-789' }), 'create');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.patch.abn).toBe('12345678901');
      expect(ok.patch.acn).toBe('123456789');
    }
  });

  it('holds a postcode to four digits', () => {
    expect(table).toContain("postcode ~ '^[0-9]{4}$'");
    for (const bad of ['312', '30000', 'VIC']) {
      const result = readOrganisationInput(complete({ postcode: bad }), 'create');
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error).toBe('postcode_must_be_4_digits');
    }
    expect(readOrganisationInput(complete({ postcode: '3000' }), 'create').ok).toBe(true);
  });

  it('takes the eight states the column takes, and refuses rather than corrects', () => {
    for (const state of AU_STATES) {
      expect(table, state).toContain(`'${state}'::text`);
      expect(readOrganisationInput(complete({ state }), 'create').ok, state).toBe(true);
    }
    // `vic` is plainly meant and is still refused: upper-casing one spelling
    // while guessing at `Victoria` is a console deciding what was said.
    for (const bad of ['vic', 'Victoria', 'NZ']) {
      const result = readOrganisationInput(complete({ state: bad }), 'create');
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error).toBe('state_is_not_an_australian_state');
    }
  });

  it('leaves every one of those columns nullable-by-blank', () => {
    // A blank box is "not stated", which each column accepts as NULL. Only
    // the two the table makes NOT NULL are required.
    const result = readOrganisationInput(
      complete({ abn: '', acn: '', postcode: '', state: '', contact_email: '' }),
      'create',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const column of ['abn', 'acn', 'postcode', 'state', 'contact_email'] as const) {
        expect(result.patch[column], column).toBeNull();
      }
    }
  });
});

describe('editing an organisation', () => {
  it('patches only the keys that were sent', () => {
    const result = readOrganisationInput({ contact_phone: '0400 000 000' }, 'update');
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.patch)).toEqual(['contact_phone']);
  });

  it('lets a present-but-empty field clear a column', () => {
    const result = readOrganisationInput({ trading_name: '' }, 'update');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.trading_name).toBeNull();
  });

  it('will not let the legal name be cleared', () => {
    const result = readOrganisationInput({ legal_name: '' }, 'update');
    expect(result.ok).toBe(false);
  });

  it('refuses an empty edit rather than writing nothing', () => {
    const result = readOrganisationInput({ organisation_id: 'x' }, 'update');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('nothing_to_update');
  });
});

describe('the lifecycle columns are not writable here', () => {
  it('is not possible to set status, is_active or a stamp through the patch', () => {
    // Three CHECK constraints tie these together. A form that could move one
    // of them would be a second lifecycle path, and the two would disagree
    // the first time one forgot a stamp.
    const result = readOrganisationInput(
      {
        legal_name: 'X',
        org_type: 'builder',
        status: 'active',
        is_active: true,
        activated_at: '2026-01-01T00:00:00Z',
        suspended_at: null,
        suspension_reason: 'nope',
      },
      'create',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const forbidden of ['status', 'is_active', 'activated_at', 'suspended_at', 'suspension_reason']) {
        expect(result.patch).not.toHaveProperty(forbidden);
      }
    }
    expect(DESCRIPTIVE_COLUMNS).not.toContain('status' as never);
    expect(DESCRIPTIVE_COLUMNS).not.toContain('is_active' as never);
  });

  it('a created organisation is born unapproved', () => {
    // Creating the row is not the same act as vetting it.
    const code = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(code).toMatch(/status:\s*'pending_activation',\s*is_active:\s*false/);
  });
});

describe('closing an organisation', () => {
  const code = readCode('supabase/functions/builder-network-admin/index.ts');

  it('demands a reason and is terminal', () => {
    expect(code).toContain("operation === 'close_organisation'");
    expect(code).toMatch(/close_organisation[\s\S]{0,900}a_reason_is_required/);
    expect(code).toMatch(/close_organisation[\s\S]{0,1400}status:\s*'closed',\s*is_active:\s*false/);
  });

  it('never deletes the organisation', () => {
    // The network's record of who was on it is not an operator's to destroy.
    expect(code).not.toMatch(/from\('builder_organisations'\)\s*\.delete\(/);
    expect(code).not.toMatch(/\.delete\(\)[\s\S]{0,80}builder_organisations/);
  });
});

describe('bootstrapping the first owner', () => {
  const code = readCode('supabase/functions/builder-network-admin/index.ts');

  it('refuses once the organisation has any member', () => {
    // The module header's rule: a platform that decides membership in
    // somebody else's organisation has re-grown the shape this replaced.
    expect(code).toContain('organisation_already_has_members');
    expect(code).toMatch(/builder_organisation_memberships[\s\S]{0,300}count:\s*'exact'/);
  });

  it('refuses to re-mint a link for an account that already exists', () => {
    // That would be a credential reset dressed as an invitation.
    expect(code).toContain('that_person_already_has_an_account');
    expect(code).toMatch(/password_hash\s*\|\|\s*\w+\.invite_accepted_at/);
  });

  it('grants owner, which the portal-side invite deliberately cannot', () => {
    expect(code).toMatch(/membership_role:\s*'owner'/);
    const portal = readCode('supabase/functions/builder-portal-invite/index.ts');
    expect(portal).toMatch(/INVITABLE_ROLES\s*=\s*new Set\(\[[^\]]*\]\)/);
    expect(portal).not.toMatch(/INVITABLE_ROLES\s*=\s*new Set\(\[[^\]]*'owner'/);
  });

  it('returns the link once and stores only the hash', () => {
    expect(code).toContain('invite_url');
    expect(code).toMatch(/invite_token_hash:\s*minted\.tokenHash/);
    expect(code).not.toMatch(/invite_token(?!_hash|_expires)\s*:/);
  });

  it('refuses rather than storing an unpeppered token', () => {
    expect(code).toContain('invite_service_unavailable');
  });
});

describe('one PORTAL-invite mechanism, not two', () => {
  // Scoped deliberately. `create_connection` in the same file mints a
  // WORKSPACE CONNECTION code — a different credential with a 14-day window,
  // its own column and its own acceptance path in
  // `builder-network-connections`. Unifying those would be a conflation, not
  // a de-duplication, so this rule is about the portal invite alone.
  const ownerBlock = () => {
    const code = readCode('supabase/functions/builder-network-admin/index.ts');
    const start = code.indexOf("operation === 'invite_organisation_owner'");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("operation === 'upsert_workspace'", start);
    return code.slice(start, end > start ? end : undefined);
  };

  it('both callers mint through the shared module', () => {
    for (const fn of ['builder-portal-invite', 'builder-network-admin']) {
      expect(readCode(`supabase/functions/${fn}/index.ts`), fn).toContain('mintBuilderInvite');
    }
  });

  it('neither rolls its own portal token or accept-invite URL', () => {
    const portal = readCode('supabase/functions/builder-portal-invite/index.ts');
    expect(portal).not.toMatch(/crypto\.randomUUID\(\)\}-\$\{crypto\.randomUUID\(\)/);
    expect(portal).not.toContain('/builder/accept-invite?token=');
    const owner = ownerBlock();
    expect(owner).not.toMatch(/crypto\.randomUUID\(\)\}-\$\{crypto\.randomUUID\(\)/);
    expect(owner).not.toContain('/builder/accept-invite?token=');
  });

  it('the connection code stays its own credential', () => {
    const code = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(code).toContain('INVITE_CODE_EXPIRY_DAYS');
    expect(code).toMatch(/invite_code_hash/);
  });
});
