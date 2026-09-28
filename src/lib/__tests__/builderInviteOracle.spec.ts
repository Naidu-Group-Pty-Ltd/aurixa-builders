import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tenantInviteResponse } from '../../../supabase/functions/_shared/builderInviteScope.pure';

/**
 * AN INVITATION ANSWERS THE SAME WHATEVER THE ADDRESS ALREADY IS.
 *
 * `invite` takes an arbitrary email from an organisation's administrator, and
 * what it answered depended on the state of an account that may belong to
 * nobody the caller knows:
 *
 *   brand-new or pending address   success, email_sent, expires_at
 *   already has an active account  success, email_sent           ← no expires_at
 *   an account an operator revoked success, email_sent: false    ← false while mail works
 *   a case-variant race            success, email_sent: false
 *
 * So `expires_at`'s absence said "this address already has a Builder Portal
 * account", and `email_sent: false` beside a healthy provider said "and it was
 * revoked" — an oracle over other organisations' staff, one request per guess,
 * exactly what this function's own header forbids.
 *
 * Neither field was needed. `expires_at` was read by nothing in the product,
 * and invitation expiry is enforced where the token is accepted, not by what
 * the inviter is told. `email_sent` chose a toast's wording — and the reason an
 * email did not go (a revoked account, not a provider) was the leak. A failed
 * send is still recorded, with the provider's own answer, in the activity log.
 *
 * So one function shapes every answer `invite` gives, and it reads nothing
 * about the invitee. The one-time link is the only optional field, and it
 * depends on the DEPLOYMENT (no mail provider at all), never on the address.
 */

describe('the answer an organisation administrator gets', () => {
  it('is only that the request was taken', () => {
    expect(tenantInviteResponse({ inviteUrl: null })).toEqual({ success: true });
  });

  it('carries the link only where the deployment has no mail provider', () => {
    expect(tenantInviteResponse({ inviteUrl: 'https://x/accept?token=t' }))
      .toEqual({ success: true, invite_url: 'https://x/accept?token=t' });
  });

  it('never carries a field that could vary with the invitee', () => {
    const shapes = [tenantInviteResponse({ inviteUrl: null }), tenantInviteResponse({ inviteUrl: 'u' })];
    for (const shape of shapes) {
      expect(shape).not.toHaveProperty('email_sent');
      expect(shape).not.toHaveProperty('expires_at');
      expect(Object.keys(shape).every((k) => k === 'success' || k === 'invite_url')).toBe(true);
    }
  });

  it('reads nothing about the invitee to decide it', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared',
      'builderInviteScope.pure.ts'), 'utf8');
    const start = source.indexOf('export function tenantInviteResponse');
    // Found first: an assertion over an empty slice would pass by finding nothing.
    expect(start).toBeGreaterThan(-1);
    const fn = source.slice(start);
    const params = fn.slice(0, fn.indexOf(')'));
    expect(params).toMatch(/inviteUrl/);
    expect(params).not.toMatch(/account|established|revoked|pending|status|email|member/i);
  });
});

describe('every way builder-portal-invite can answer an invitation', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions',
    'builder-portal-invite', 'index.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const block = code.slice(code.indexOf("if (action === 'invite')"), code.indexOf("if (action === 'resend')"));

  it('the invite block exists and was found', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('answers success through tenantInviteResponse and nothing else — new, active, pending, revoked, race', () => {
    // Every 2xx the invite action can return. Errors (400 for a bad address,
    // 409 for a membership of THIS organisation) are about the caller's own
    // request or own organisation and disclose nothing about anyone else's.
    // Every answer now waits for the floor first (doc 68), so each is
    // `return await answer(json(...))`; the shape inside is what is pinned.
    const successes = [...block.matchAll(/return await answer\(json\((?![^)]*\b(?:400|401|403|404|409|500|503)\))/g)];
    expect(successes.length).toBeGreaterThan(0);
    for (const m of successes) {
      const call = block.slice(m.index, m.index + 160);
      expect(call, 'a success answer not shaped by tenantInviteResponse').toMatch(/answer\(json\(tenantInviteResponse\(/);
    }
  });

  it('names neither leaking field in anything the invite block answers', () => {
    // The activity-log calls are set aside, and only those: that log is where
    // the evidence the answer no longer carries now lives, and no tenant can
    // read it (the next assertion).
    const answered = block.replace(/logInviteActivity\([\s\S]*?\);/g, ' ');
    expect(answered).not.toMatch(/\bexpires_at\s*:/);
    expect(answered).not.toMatch(/\bemail_sent\s*:/);
  });

  it('and no tenant can read those log entries or what they record', () => {
    /*
     * The log's RLS admits service_role alone — measured in production on
     * 28 Sep 2026, anon and authenticated each see 0 of its 2,699 rows — and no
     * edge function reads it. The one reader a tenant reaches is
     * `builder_visible_activity` (the Activity page): it returns no metadata
     * column, and `builder_can_see_activity` admits no `portal_user` entry,
     * which is the entity every invitation is logged against. Production held
     * exactly three functions naming the table that day: that reader, the
     * writer and the append-only trigger. Pinned so neither rule widens quietly.
     */
    const migrations = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
    const definitions = (fn: string) => readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()
      .flatMap((f) => {
        const sql = readFileSync(join(migrations, f), 'utf8')
          .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
        return [...sql.matchAll(new RegExp(
          `CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\([\\s\\S]*?\\n\\$\\$;`, 'g'))].map((m) => m[0]);
      });
    const readers = definitions('builder_visible_activity');
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) expect(reader.slice(0, reader.indexOf('AS $$'))).not.toMatch(/metadata/);
    const visible = definitions('builder_activity_entity_is_portal_visible');
    expect(visible.length).toBeGreaterThan(0);
    for (const rule of visible) expect(rule).not.toMatch(/'portal_user'/);
    for (const dir of readdirSync(join(__dirname, '..', '..', '..', 'supabase', 'functions'))) {
      const file = join(__dirname, '..', '..', '..', 'supabase', 'functions', dir, 'index.ts');
      if (!existsSync(file)) continue;
      expect(readFileSync(file, 'utf8'), `${dir} reads the activity log`)
        .not.toMatch(/from\(\s*['"]builder_portal_activity_log['"]\s*\)/);
    }
  });

  it('a SECOND invitation of the same address is decided by this organisation\'s seat, never by the account', () => {
    /*
     * Found by the independent review. The first answer was the same for every
     * address, but a repeat was not: an address that already signed in held an
     * `active` seat after the first invitation, the repeat hit the live key, the
     * account was active, nothing could be promoted — 409. Every other kind of
     * address answered 200 twice. So two requests still told an administrator
     * whether an arbitrary address had an account.
     */
    const start = block.indexOf("String(membershipError.code) === '23505'");
    expect(start).toBeGreaterThan(-1);
    const conflict = block.slice(start);
    // The seat is read, and it is what decides.
    expect(conflict).toMatch(/\.select\('status'\)/);
    const suspended = conflict.indexOf("seat.status === 'suspended'");
    const alreadyHere = conflict.indexOf("seat.status === 'active'");
    expect(suspended).toBeGreaterThan(-1);
    expect(alreadyHere).toBeGreaterThan(-1);
    // Doc 68: the account is not consulted here at all any more — an active
    // seat is a working member whoever they are, a waiting one is re-sent.
    expect(conflict).not.toMatch(/accountIsActive/);
    // A suspended seat is refused, whatever the account is ...
    expect(conflict.slice(suspended, suspended + 400)).toMatch(/409\)/);
    // ... and an active member of this organisation is answered as everyone is.
    expect(conflict.slice(alreadyHere, alreadyHere + 200)).toMatch(/return await answer\(json\(tenantInviteResponse\(\{ inviteUrl: null \}\)\)\)/);
    // The seat is read before any 409 in the branch can be reached.
    expect(conflict.indexOf(".select('id, status, invited_name')")).toBeGreaterThan(-1);
    expect(conflict.indexOf(".select('id, status, invited_name')")).toBeLessThan(conflict.search(/409\)/));
  });

  it('a re-sent invitation that finds nothing waiting re-reads the seat rather than refusing', () => {
    /*
     * The re-review's remaining path, as it reads under doc 68: two concurrent
     * repeats of an `invited` seat both read `invited`; the invitee accepts
     * between the read and the re-mint, or the other request's re-mint wins —
     * either way this one re-mints nothing. The seat decides here too: now
     * `active` is a working member, answered as everyone is; anything else is
     * refused as before, and nothing is sent.
     */
    const zero = block.indexOf('if (!reissued)');
    expect(zero).toBeGreaterThan(-1);
    const after = block.slice(zero, zero + 900);
    expect(after).toMatch(/\.select\('status'\)/);
    expect(after).toMatch(/return await answer\(json\(tenantInviteResponse\(\{ inviteUrl: null \}\)\)\)/);
    // The re-read precedes any refusal on this path.
    expect(after.indexOf(".select('status')")).toBeLessThan(after.search(/409\)/));
  });

  it('resend answers the same whether or not the person already signs in', () => {
    // Reached for ANY address once one invitation has given the caller a seat
    // for it, so `invite` then `resend` was the same oracle by another route.
    const resend = code.slice(code.indexOf("if (action === 'resend')"), code.indexOf("if (action === 'revoke_invite')"));
    expect(resend.length).toBeGreaterThan(200);
    expect(resend).not.toMatch(/already_active/);
    const successes = [...resend.matchAll(/return await answer\(json\((?![^)]*\b[45]\d\d\))/g)];
    expect(successes.length).toBeGreaterThanOrEqual(2);
    for (const m of successes) {
      expect(resend.slice(m.index, m.index + 160), 'a resend success not shaped by tenantInviteResponse')
        .toMatch(/answer\(json\(tenantInviteResponse\(/);
    }
    expect(resend).not.toMatch(/\bexpires_at\s*:/);
    expect(resend).not.toMatch(/\bemail_sent\s*:/);
  });

  it('still records whether the email left — in the activity log, where an operator reads it', () => {
    // Removing the field from the answer must not remove the evidence. Doc 68
    // sends after answering, so the act is logged when it happens and whether
    // its email left is logged when THAT happens — for every invitation, since
    // an established account is now sent one too.
    expect(code).toMatch(/logInviteActivity\(resent \? 'builder_invite_resent' : 'builder_invite_sent'/);
    expect(code).toMatch(/logInviteActivity\('builder_invite_delivery'[\s\S]{0,160}email_sent: outcome\.sent/);
  });

  it('keeps expiry enforced where it matters — at acceptance, not in the answer', () => {
    const accept = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions',
      'builder-portal-accept-invite', 'index.ts'), 'utf8');
    expect(accept).toMatch(/invite_token_expires_at/);
    expect(code).toMatch(/invite_token_expires_at: minted\.expiresAt\.toISOString\(\)/);
  });
});

describe('the portal card, which read both fields', () => {
  const card = readFileSync(join(__dirname, '..', '..', 'components', 'builder-portal',
    'BuilderTeamInviteCard.tsx'), 'utf8');
  const client = readFileSync(join(__dirname, '..', 'builderPortal.ts'), 'utf8');

  it('no longer reads email_sent or expires_at from the answer', () => {
    expect(card).not.toMatch(/data\.email_sent|data\.expires_at/);
  });

  it('decides its message from the link alone — the one field that depends on the deployment', () => {
    expect(card).toMatch(/data\.invite_url/);
  });

  it('its type no longer promises fields the answer never carries', () => {
    const type = client.slice(client.indexOf('export function builderInviteTeamMember'));
    const shape = type.slice(0, type.indexOf("'builder-portal-invite'"));
    expect(shape).not.toMatch(/email_sent|expires_at/);
  });
});
