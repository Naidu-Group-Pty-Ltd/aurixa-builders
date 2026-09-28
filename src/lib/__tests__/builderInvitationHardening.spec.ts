import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVITEE_NAME_MAX_CHARS,
  readInviteeName,
} from '../../../supabase/functions/_shared/builderInviteScope.pure';
import {
  DELIVERY_BACKLOG_DELAYED_MS,
  DELIVERY_CHECK_RECIPIENT_DEFAULT,
  DELIVERY_HELD_BACK_WINDOW_SECONDS,
  EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION,
  EMAIL_SEND_MAX_WAIT_MS,
  EMAIL_SEND_SPACING_MS,
  INVITE_ANSWER_FLOOR_MS,
  answerDelayMs,
  deliveryCheckState,
  deliveryHealthView,
  readSendSlot,
} from '../../../supabase/functions/_shared/builderEmailDelivery.pure';

/**
 * THE INVITATION DOOR'S REMAINING HARDENING (doc 68). Each block is one of the
 * findings doc 67 §3 left open, stated as the property that closes it.
 */

const repo = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const inviteSource = repo('supabase', 'functions', 'builder-portal-invite', 'index.ts');
const invite = stripComments(inviteSource);
const block = (from: string, to: string) => invite.slice(invite.indexOf(from), invite.indexOf(to));
const inviteBlock = block("if (action === 'invite')", "if (action === 'resend')");
const resendBlock = block("if (action === 'resend')", "if (action === 'revoke_invite')");
const migrationSql = repo('supabase', 'migrations', '20260929090000_an_invitation_waits_for_its_invitee.sql');

describe('1. the answer takes the same time whatever the address is', () => {
  /*
   * Measured in production (doc 67 §5): a revoked account answered in ~930 ms,
   * every other kind in ~1,350–1,450 ms, because only they sent an email before
   * answering. The answer now waits for a fixed floor and every email is sent
   * after it, so the time an answer takes is the floor, for every kind.
   */
  it('is held to a floor that clears the work done before it', () => {
    expect(INVITE_ANSWER_FLOOR_MS).toBeGreaterThanOrEqual(1000);
    expect(answerDelayMs(10_000, 10_200)).toBe(INVITE_ANSWER_FLOOR_MS - 200);
    expect(answerDelayMs(10_000, 10_000 + INVITE_ANSWER_FLOOR_MS + 5)).toBe(0);
  });

  it('every answer invite and resend give is held to it — successes and refusals alike', () => {
    for (const [name, body] of [['invite', inviteBlock], ['resend', resendBlock]] as const) {
      expect(body.length, `${name} block found`).toBeGreaterThan(300);
      const returns = [...body.matchAll(/\breturn\b[^;]*;/g)].map((m) => m[0]);
      expect(returns.length).toBeGreaterThan(1);
      for (const statement of returns) {
        expect(statement, `${name}: an answer that skips the floor`).toMatch(/return await answer\(/);
      }
    }
  });

  it('sends nothing before answering — every email starts only once the answer\'s floor has passed', () => {
    for (const body of [inviteBlock, resendBlock]) {
      expect(body).not.toMatch(/await sendBuilderEmail\(/);
      expect(body).not.toMatch(/await sendPacedBuilderEmail\(/);
      expect(body).toMatch(/afterAnswer\(holdAnswer\(receivedAt\)\.then\(\(\) => deliverInvitation\(/);
      expect(body).not.toMatch(/afterAnswer\(deliverInvitation\(/);
    }
  });
});

describe('2. invitations are paced, so a burst cannot hammer the shared mail provider', () => {
  it('spaces sends further apart than the provider\'s per-second ceiling allows', () => {
    // Resend admits 2 requests a second per team, shared with every other send
    // this deployment makes; invitations take at most one of them.
    expect(EMAIL_SEND_SPACING_MS).toBeGreaterThanOrEqual(500);
    // A queued send waits inside the edge worker's own lifetime.
    expect(EMAIL_SEND_MAX_WAIT_MS).toBeLessThanOrEqual(120_000);
  });

  it('reads the reservation as a wait, a full queue, or a degraded pacer — never as "send now"', () => {
    expect(readSendSlot({ data: 2500, error: null })).toEqual({ kind: 'wait', ms: 2500 });
    expect(readSendSlot({ data: 0, error: null })).toEqual({ kind: 'wait', ms: 0 });
    expect(readSendSlot({ data: null, error: null })).toEqual({ kind: 'paced_out' });
    expect(readSendSlot({ data: null, error: { message: 'boom' } })).toEqual({ kind: 'unpaced' });
    expect(readSendSlot({ data: 'nonsense', error: null })).toEqual({ kind: 'unpaced' });
  });

  it('every invitation email goes through the pacer, within its organisation\'s own share', () => {
    const delivery = repo('supabase', 'functions', '_shared', 'builderEmailDelivery.ts');
    expect(delivery).toMatch(/rpc\('builder_reserve_email_send_slot'/);
    expect(delivery).toMatch(/_scope: scope\?\.key \?\? null/);
    expect(delivery).toMatch(/_scope_max_queued: scope\?\.maxQueued \?\? null/);
    expect(invite).toMatch(/sendPacedBuilderEmail\(/);
    expect(invite).toMatch(/\{ key: `org:\$\{activeOrganisationId\}`, maxQueued: EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION \}/);
    expect(invite).not.toMatch(/[^d]sendBuilderEmail\(\{\s*to: target/);
  });

  it('one organisation\'s burst cannot fill the queue everyone waits in', () => {
    // Found by the independent review: with three administrators an
    // organisation could burst ~91 sends into a 90-slot queue and every other
    // tenant's invitations were delayed, or dropped as paced out.
    expect(EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION).toBeGreaterThanOrEqual(5);
    expect(EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION * EMAIL_SEND_SPACING_MS).toBeLessThanOrEqual(EMAIL_SEND_MAX_WAIT_MS / 3);
  });

  it('records when each email actually left, for the proof and for an operator', () => {
    expect(invite).toMatch(/logInviteActivity\('builder_invite_delivery'[\s\S]{0,200}sent_at: sentAt/);
  });

  it('the reservation is one statement under one lock, in the database', () => {
    expect(migrationSql).toMatch(/CREATE OR REPLACE FUNCTION public\.builder_reserve_email_send_slot/);
    expect(migrationSql).toMatch(/FOR UPDATE/);
  });

  it('replaces what an earlier draft of it defined, so a function is never left ambiguous', () => {
    // The third review: a database that ran an earlier body keeps the old
    // signatures beside the new ones, and a zero-argument call is then "not
    // unique". No database has run one (the version is absent from
    // production's ledger), and this keeps it re-runnable if one ever did.
    expect(migrationSql).toMatch(/DROP FUNCTION IF EXISTS public\.builder_email_delivery_reading\(\);/);
    expect(migrationSql).toMatch(/DROP FUNCTION IF EXISTS public\.builder_reserve_email_send_slot\(integer, integer\);/);
  });

  it('nothing it creates is left with Supabase\'s default grants — its sequence included', () => {
    // The second review: an identity column's sequence is granted to anon and
    // authenticated by default like any other new object.
    expect(migrationSql).toMatch(
      /REVOKE ALL ON SEQUENCE public\.builder_email_send_reservations_id_seq FROM PUBLIC, anon, authenticated;/);
  });
});

describe('3. a deployment-wide delivery signal that names no address and no message', () => {
  it('is read from a delivery check and the queue, and nothing else', () => {
    const view = deliveryHealthView({ configured: true, reading: { state: 'operational', checked_at: 't', backlog_ms: 0 } });
    expect(view).toEqual({ state: 'operational', checked_at: 't' });
    expect(deliveryHealthView({ configured: true, reading: { state: 'degraded', checked_at: 't', backlog_ms: 0 } }).state)
      .toBe('degraded');
    expect(deliveryHealthView({
      configured: true, reading: { state: 'operational', checked_at: 't', backlog_ms: DELIVERY_BACKLOG_DELAYED_MS },
    }).state).toBe('delayed');
    expect(deliveryHealthView({ configured: true, reading: null }).state).toBe('unknown');
    expect(deliveryHealthView({ configured: false, reading: null }).state).toBe('not_configured');
  });

  it('its inputs have no field through which an address or a message could arrive', () => {
    const pure = repo('supabase', 'functions', '_shared', 'builderEmailDelivery.pure.ts');
    const fn = pure.slice(pure.indexOf('export function deliveryHealthView'));
    const params = fn.slice(0, fn.indexOf('{', fn.indexOf(')')));
    expect(params).toMatch(/configured/);
    expect(params).not.toMatch(/email|address|recipient|message|invite|user|member/i);
  });

  it('checks delivery by sending to a sink that belongs to nobody, never to a real invitee', () => {
    expect(DELIVERY_CHECK_RECIPIENT_DEFAULT).toBe('delivered@resend.dev');
    expect(deliveryCheckState({ sent: true })).toBe('operational');
    expect(deliveryCheckState({ sent: false, reason: 'refused' })).toBe('degraded');
    expect(deliveryCheckState({ sent: false, reason: 'refused', status: 422 })).toBe('degraded');
    expect(deliveryCheckState({ sent: false, reason: 'unreachable' })).toBe('degraded');
    // A check that never left the queue found nothing out about the provider:
    // it records no reading, rather than calling delivery broken for 30
    // minutes because somebody else's burst filled the queue.
    expect(deliveryCheckState({ sent: false, reason: 'paced_out' })).toBeNull();
    const delivery = stripComments(repo('supabase', 'functions', '_shared', 'builderEmailDelivery.ts'));
    const run = delivery.slice(delivery.indexOf('async function runDeliveryCheck'));
    expect(run).toMatch(/if \(state === null\)/);
  });

  it('a provider that throttled the check found nothing out either — it records no reading', () => {
    // The second review: every other send this deployment makes shares the
    // provider's per-second ceiling unpaced, so anyone able to time two sends
    // against a stale check could have every tenant's card read "not working"
    // for half an hour. A throttle is not a failure to deliver.
    expect(deliveryCheckState({ sent: false, reason: 'refused', status: 429, code: 'rate_limit_exceeded' })).toBeNull();
    // The third review: the provider answers 429 for an exhausted quota too,
    // and then nothing is delivered at all — that is degraded, as is any 429
    // the provider did not name as a throttle.
    expect(deliveryCheckState({ sent: false, reason: 'refused', status: 429, code: 'daily_quota_exceeded' })).toBe('degraded');
    expect(deliveryCheckState({ sent: false, reason: 'refused', status: 429, code: 'monthly_quota_exceeded' })).toBe('degraded');
    expect(deliveryCheckState({ sent: false, reason: 'refused', status: 429 })).toBe('degraded');
    const sender = stripComments(repo('supabase', 'functions', '_shared', 'builderInviteEmail.ts'));
    expect(sender).toMatch(/return \{ sent: false, reason: 'refused', status: response\.status, code: providerErrorName\(detail\) \};/);
  });

  it('tells an organisation\'s administrators when their own invitation emails were held back — and only theirs', () => {
    // The second review: one organisation's share is 20 waiting sends, while
    // "delayed" needs a 30-second queue, so an organisation's own overflow was
    // dropped with nothing on any screen. A refusal is stamped against the
    // organisation's own scope, and read back only under that scope.
    expect(deliveryHealthView({
      configured: true, reading: { state: 'operational', checked_at: 't', backlog_ms: 0, scope_held_back: true },
    }).state).toBe('held_back');
    // Not working outranks held back; held back outranks a long queue.
    expect(deliveryHealthView({
      configured: true, reading: { state: 'degraded', checked_at: 't', backlog_ms: 0, scope_held_back: true },
    }).state).toBe('degraded');
    expect(deliveryHealthView({
      configured: true,
      reading: { state: 'operational', checked_at: 't', backlog_ms: DELIVERY_BACKLOG_DELAYED_MS, scope_held_back: true },
    }).state).toBe('held_back');
    expect(DELIVERY_HELD_BACK_WINDOW_SECONDS).toBeGreaterThanOrEqual(300);
    expect(migrationSql).toMatch(/INSERT INTO public\.builder_email_send_scope_refusals/);
    expect(migrationSql).toMatch(/CREATE OR REPLACE FUNCTION public\.builder_email_delivery_reading\(\s*_scope text/);
    const delivery = stripComments(repo('supabase', 'functions', '_shared', 'builderEmailDelivery.ts'));
    expect(delivery).toMatch(/rpc\('builder_email_delivery_reading', \{\s*_scope: scope \?\? null,\s*_held_back_window_seconds: DELIVERY_HELD_BACK_WINDOW_SECONDS/);
    const health = block("if (action === 'delivery_health')", "if (action === 'invite')");
    expect(health).toMatch(/readDeliveryHealth\(supabase, getBrandConfig, `org:\$\{activeOrganisationId\}`\)/);
  });

  it('is behind the same owner-or-administrator gate, and reads nothing about any invitee', () => {
    const health = block("if (action === 'delivery_health')", "if (action === 'invite')");
    expect(health.length).toBeGreaterThan(50);
    expect(invite.indexOf("if (action === 'delivery_health')"))
      .toBeGreaterThan(invite.indexOf("membershipRole !== 'owner' && membershipRole !== 'administrator'"));
    expect(health).not.toMatch(/body\.|builder_portal_users|builder_organisation_memberships|activity/);
  });

  it('is refreshed on a clock, never because one send failed', () => {
    // An early re-check after a failure would itself say "your send failed".
    const delivery = stripComments(repo('supabase', 'functions', '_shared', 'builderEmailDelivery.ts'));
    const paced = delivery.slice(delivery.indexOf('export async function sendPacedBuilderEmail'));
    expect(paced.slice(0, paced.indexOf('\n}\n'))).not.toMatch(/builder_claim_email_delivery_check|runDeliveryCheck/);
  });
});

describe('4. an invitee name has a ceiling', () => {
  it('is the registration door\'s own ceiling', () => {
    expect(INVITEE_NAME_MAX_CHARS).toBe(200);
    const schemas = repo('supabase', 'functions', '_shared', 'authBodySchemas.ts');
    expect(schemas).toMatch(/name: optionalField\(z\.string\(\)\.max\(200\)\)/);
  });

  it('trims, requires a name, and refuses one past the ceiling rather than cutting it', () => {
    expect(readInviteeName('  Sam  ')).toEqual({ ok: true, name: 'Sam' });
    expect(readInviteeName('   ').ok).toBe(false);
    expect(readInviteeName(undefined).ok).toBe(false);
    expect(readInviteeName('x'.repeat(200))).toEqual({ ok: true, name: 'x'.repeat(200) });
    const long = readInviteeName('x'.repeat(201));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/200/);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(readInviteeName('\u{1F3D7}'.repeat(200)).ok).toBe(true);
    expect(readInviteeName('\u{1F3D7}'.repeat(201)).ok).toBe(false);
  });

  it('is enforced by the door and by the column', () => {
    expect(inviteBlock).toMatch(/readInviteeName\(body\.name\)/);
    expect(migrationSql).toMatch(/char_length\(invited_name\)/);
  });
});

describe('5. one organisation cannot replace another organisation\'s invitation', () => {
  it('the invite door never writes a token on the account', () => {
    // The account's single token slot was the thing a second organisation
    // overwrote. Each invitation now lives on its own organisation's seat.
    const userWrites = invite.match(/\.from\('builder_portal_users'\)\s*\.update\(\{[\s\S]*?\}\)/g) ?? [];
    for (const write of userWrites) expect(write).not.toMatch(/invite_token_hash:(?!\s*null\b)/);
  });

  it('a re-sent invitation replaces only its own seat\'s token, and only while that seat waits', () => {
    const reissue = invite.slice(invite.indexOf('const reissueSeatInvitation'));
    expect(reissue.length).toBeGreaterThan(100);
    const body = reissue.slice(0, reissue.indexOf('};'));
    expect(body).toMatch(/\.eq\('id', seatId\)/);
    expect(body).toMatch(/\.eq\('status', PENDING_MEMBERSHIP_STATUS\)/);
    expect(body).toMatch(/\.eq\('organisation_id', activeOrganisationId\)/);
  });

  it('the database holds one live token per seat, unique, only while the seat waits', () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX[\s\S]*invite_token_hash[\s\S]*WHERE invite_token_hash IS NOT NULL/);
    expect(migrationSql).toMatch(/invite_token_hash IS NULL OR \(status = 'invited' AND revoked_at IS NULL/);
    expect(migrationSql).toMatch(/BEFORE UPDATE OF status, revoked_at ON public\.builder_organisation_memberships/);
  });
});

describe('6. an account whose state changes mid-invitation is never deactivated or downgraded', () => {
  it('the invite door writes no status and no activity flag to any account', () => {
    const userWrites = invite.match(/\.from\('builder_portal_users'\)\s*\.update\(\{[\s\S]*?\}\)/g) ?? [];
    for (const write of userWrites) {
      expect(write).not.toMatch(/\bstatus:/);
      expect(write).not.toMatch(/is_active:/);
    }
  });

  it('the operator door stamps an owner invitation only on an account that is still unaccepted, and reads the count', () => {
    const admin = stripComments(repo('supabase', 'functions', 'builder-network-admin', 'index.ts'));
    const stamps = admin.match(/\.from\('builder_portal_users'\)\s*\.update\(\{[\s\S]*?invite_token_hash: minted\.tokenHash[\s\S]*?\.select\('id'\)/g) ?? [];
    expect(stamps.length).toBe(2);
    for (const stamp of stamps) {
      expect(stamp).toMatch(/\.is\('password_hash', null\)/);
      expect(stamp).toMatch(/\.is\('invite_accepted_at', null\)/);
      expect(stamp).toMatch(/\.is\('revoked_at', null\)/);
      // The second review: an operator's suspension of an account that never
      // accepted was lifted by the next owner invitation or application.
      expect(stamp).toMatch(/\.eq\('status', 'invited'\)/);
    }
  });
});
