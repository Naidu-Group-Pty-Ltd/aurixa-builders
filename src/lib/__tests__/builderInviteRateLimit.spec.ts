import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVITE_SEND_BUDGETS,
  INVITE_SEND_SCOPE,
  enforceSessionLimits,
  sessionRateLimitDimensions,
} from '../../../supabase/functions/_shared/sessionRateLimit.pure';

/**
 * AN INVITATION IS BUDGETED BY WHO SENT IT, NOT BY WHERE IT CAME FROM.
 *
 * `builder-portal-invite` had no ceiling: any owner or administrator could mint
 * invitations and spend the mail provider's allowance without bound. The
 * shared limiter's IP-first helpers are the wrong tool for it — they exist for
 * UNAUTHENTICATED doors, where the source address is the only identity there
 * is — because through the portal's own proxy, or with no trusted address
 * header, every caller collapses into ONE bucket, and one organisation's burst
 * would refuse every other organisation's invitations.
 *
 * An invitation is sent by an authenticated person acting for an organisation,
 * and both come from the server-validated session. So those are the keys: the
 * person, then the organisation. Neither can be chosen by the caller.
 */

describe('what an invitation is keyed on', () => {
  const dims = sessionRateLimitDimensions({
    scope: INVITE_SEND_SCOPE,
    userId: '11111111-1111-4111-8111-111111111111',
    organisationId: '22222222-2222-4222-8222-222222222222',
    budgets: INVITE_SEND_BUDGETS,
  });

  it('the person first, then the organisation — and nothing else', () => {
    expect(dims.map((d) => d.dimension)).toEqual(['user', 'organisation']);
  });

  it('keys each on the server-validated id, never on an address', () => {
    expect(dims[0].key).toBe('binv_user:11111111-1111-4111-8111-111111111111');
    expect(dims[1].key).toBe('binv_org:22222222-2222-4222-8222-222222222222');
    for (const d of dims) expect(d.key).not.toMatch(/ip|untrusted|\d+\.\d+\.\d+\.\d+/i);
  });

  it('refuses to build a key from a missing id rather than share one bucket', () => {
    // A key built from `undefined` would be one bucket every such caller shares
    // — the exact failure identity keying exists to avoid.
    expect(() => sessionRateLimitDimensions({
      scope: INVITE_SEND_SCOPE, userId: '', organisationId: 'x', budgets: INVITE_SEND_BUDGETS,
    })).toThrow();
    expect(() => sessionRateLimitDimensions({
      scope: INVITE_SEND_SCOPE, userId: 'x', organisationId: '', budgets: INVITE_SEND_BUDGETS,
    })).toThrow();
  });
});

describe('the ceiling', () => {
  it('is generous enough for onboarding a whole team in one sitting', () => {
    // Production held no genuine invitation history on 28 Sep 2026 — every
    // inviter in the activity log was a proof account, the busiest sending 11
    // in an hour — and the largest real organisation had 2 members. So the
    // number is reasoned rather than fitted: a builder's owner onboarding an
    // office of about thirty in one sitting, with room for resends and typos.
    expect(INVITE_SEND_BUDGETS.user).toEqual({ max: 40, windowSeconds: 3600 });
    // Several administrators onboarding together.
    expect(INVITE_SEND_BUDGETS.organisation).toEqual({ max: 100, windowSeconds: 3600 });
  });

  it('uses the one-hour window the other email-sending doors use', () => {
    // forgot-password, register and accept-invite all budget per hour.
    expect(INVITE_SEND_BUDGETS.user.windowSeconds).toBe(3600);
    expect(INVITE_SEND_BUDGETS.organisation.windowSeconds).toBe(3600);
  });
});

describe('how the dimensions are consumed', () => {
  const dims = sessionRateLimitDimensions({
    scope: INVITE_SEND_SCOPE, userId: 'u1', organisationId: 'o1', budgets: INVITE_SEND_BUDGETS,
  });

  it('allows when every dimension allows', async () => {
    const seen: string[] = [];
    const decision = await enforceSessionLimits(dims, async (key) => {
      seen.push(key);
      return { allowed: true, retryAfterSeconds: 0, degraded: false };
    });
    expect(decision.allowed).toBe(true);
    expect(seen).toEqual(['binv_user:u1', 'binv_org:o1']);
  });

  it('stops at the person: an administrator over their own ceiling spends none of the organisation\'s', async () => {
    const seen: string[] = [];
    const decision = await enforceSessionLimits(dims, async (key) => {
      seen.push(key);
      return key.startsWith('binv_user:')
        ? { allowed: false, retryAfterSeconds: 1200, degraded: false }
        : { allowed: true, retryAfterSeconds: 0, degraded: false };
    });
    expect(decision).toMatchObject({ allowed: false, retryAfterSeconds: 1200, refusedBy: 'user' });
    expect(seen).toEqual(['binv_user:u1']);
  });

  it('refuses on the organisation once its shared ceiling is reached', async () => {
    const decision = await enforceSessionLimits(dims, async (key) => (key.startsWith('binv_org:')
      ? { allowed: false, retryAfterSeconds: 300, degraded: false }
      : { allowed: true, retryAfterSeconds: 0, degraded: false }));
    expect(decision).toMatchObject({ allowed: false, retryAfterSeconds: 300, refusedBy: 'organisation' });
  });

  it('carries forward that the shared limiter was unavailable', async () => {
    const decision = await enforceSessionLimits(dims, async () => ({ allowed: true, retryAfterSeconds: 0, degraded: true }));
    expect(decision.degraded).toBe(true);
  });
});

describe('a burst, against the real budgets', () => {
  /**
   * The shared limiter's semantics, as `security_consume_rate_limit` has them
   * (verified against a rebuilt database: 40 allowed, the 41st refused): every
   * call bumps the bucket, refused or not, and it answers `count <= max`.
   */
  const limiter = () => {
    const counts = new Map<string, number>();
    const consume = async (key: string, budget: { max: number }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { allowed: count <= budget.max, retryAfterSeconds: count <= budget.max ? 0 : 3600, degraded: false };
    };
    return { counts, consume };
  };
  const send = (l: ReturnType<typeof limiter>, userId: string, organisationId: string) =>
    enforceSessionLimits(sessionRateLimitDimensions({
      scope: INVITE_SEND_SCOPE, userId, organisationId, budgets: INVITE_SEND_BUDGETS,
    }), l.consume);

  it('one administrator: 40 go through, the rest are refused, and the refusals cost the organisation nothing', async () => {
    const l = limiter();
    const outcomes = [];
    for (let i = 0; i < 45; i += 1) outcomes.push(await send(l, 'admin-1', 'org-1'));
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(40);
    expect(outcomes.slice(40).every((o) => !o.allowed && o.refusedBy === 'user' && o.retryAfterSeconds > 0)).toBe(true);
    expect(l.counts.get('binv_org:org-1')).toBe(40);
  });

  it('several administrators: the organisation stops at 100, however many it appoints', async () => {
    const l = limiter();
    let allowed = 0;
    let refusedByOrganisation = 0;
    for (const admin of ['a', 'b', 'c', 'd']) {
      for (let i = 0; i < 40; i += 1) {
        const o = await send(l, admin, 'org-1');
        if (o.allowed) allowed += 1;
        else if (o.refusedBy === 'organisation') refusedByOrganisation += 1;
      }
    }
    expect(allowed).toBe(100);
    expect(refusedByOrganisation).toBe(60);
  });

  it('another organisation, and its administrators, are untouched by the first one\'s burst', async () => {
    const l = limiter();
    for (let i = 0; i < 150; i += 1) await send(l, `admin-${i % 4}`, 'org-1');
    expect(await send(l, 'admin-x', 'org-2')).toMatchObject({ allowed: true, refusedBy: null });
  });
});

describe('where builder-portal-invite checks it', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
  const invite = read('builder-portal-invite', 'index.ts');
  const code = invite.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const at = (pattern: RegExp) => {
    const m = pattern.exec(code);
    return m ? m.index : -1;
  };
  const limiter = at(/enforceSessionRateLimit\s*\(/);

  it('checks the session ceiling', () => {
    expect(limiter).toBeGreaterThan(-1);
  });

  it('only for the two acts that send an email or mint a credential', () => {
    const guard = code.slice(Math.max(0, limiter - 400), limiter);
    expect(guard).toMatch(/action === 'invite' \|\| action === 'resend'/);
  });

  it('AFTER the owner/administrator check — a member cannot spend the organisation\'s budget', () => {
    // Otherwise any member could exhaust the organisation's ceiling with
    // requests that were going to be refused anyway, and deny the
    // administrators who may actually invite.
    const roleCheck = at(/membershipRole !== 'owner' && membershipRole !== 'administrator'/);
    expect(roleCheck).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(roleCheck);
  });

  it('BEFORE anything is written, minted or sent — a refused request leaves no trace', () => {
    for (const effect of [/\.insert\(/, /\.update\(/, /mintBuilderInvite\(/, /sendBuilderEmail\(/, /builder_log_activity/]) {
      const first = at(effect);
      if (first > -1) expect(limiter, `${effect} precedes the ceiling`).toBeLessThan(first);
    }
  });

  it('answers with the shared 429 and Retry-After', () => {
    expect(code.slice(limiter, limiter + 700)).toMatch(/authRateLimitedResponse\(/);
  });

  it('never keys an invitation on the source address', () => {
    // The IP-first helpers are for unauthenticated doors; here they would put
    // every caller behind the proxy into one bucket.
    expect(code).not.toMatch(/\b(beginAuthRateLimit|enforceAuthRateLimit)\s*\(/);
  });
});
