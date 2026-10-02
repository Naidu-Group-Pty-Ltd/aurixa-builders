/**
 * Where a new organisation's first owner sits when the account already sits
 * somewhere — and the two application windows that were refusing the
 * correction of a simple mistake.
 *
 * Measured 1 Oct 2026: one public application and six operator "Invite owner"
 * attempts all failed on `builder_memberships_one_primary_key`, because the
 * address had owned an organisation that was later CLOSED and still held its
 * primary seat there. Each door inserted its owner seat as primary
 * unconditionally, read every 23505 as "a seat I can promote", and — for an
 * account with no password yet — did not read the error at all. Every
 * resubmission that afternoon was then refused by the address window, which
 * counted the refused application as one "already with us".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_LIVE_KEY,
  MEMBERSHIP_ONE_PRIMARY_KEY,
  ownerInvitationMayBeReissued,
  ownerSeatIsPrimary,
  readMembershipCollision,
} from '../../../supabase/functions/_shared/builderOwnerSeat.pure';
import {
  ADDRESS_WINDOW_OUTCOMES,
  IN_FLIGHT_MINUTES,
  ORIGIN_WINDOWS,
} from '../../../supabase/functions/_shared/builderAccessRequest.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const NEW_ORG = 'cccccccc-3333-4333-8333-333333333333';
const CLOSED_ORG = 'dddddddd-4444-4444-8444-444444444444';

/** The two errors Postgres actually raised, quoted from the 1 Oct logs' shape. */
const primaryTaken = {
  code: '23505',
  message: `duplicate key value violates unique constraint "${MEMBERSHIP_ONE_PRIMARY_KEY}"`,
  details: 'Key (builder_user_id)=(…) already exists.',
};
const seatExists = {
  code: '23505',
  message: `duplicate key value violates unique constraint "${MEMBERSHIP_LIVE_KEY}"`,
  details: 'Key (builder_user_id, organisation_id)=(…, …) already exists.',
};

describe('reading a membership collision', () => {
  it('names the primary-seat collision the closed organisation caused', () => {
    expect(readMembershipCollision(primaryTaken)).toBe('primary_taken');
  });

  it('names a seat already held in this organisation as its own case', () => {
    // The two have opposite remedies: one is "insert it as a non-primary
    // seat", the other is "there is nothing to insert".
    expect(readMembershipCollision(seatExists)).toBe('seat_exists');
  });

  it('reads the index from the details as well as the message', () => {
    expect(readMembershipCollision({ code: '23505', message: 'duplicate key', details: MEMBERSHIP_LIVE_KEY }))
      .toBe('seat_exists');
  });

  it('never guesses an index it does not name', () => {
    expect(readMembershipCollision({ code: '23505', message: 'duplicate key value violates unique constraint "something_else"' }))
      .toBe('unrecognised');
  });

  it('is nothing at all for an error that is not a unique violation', () => {
    expect(readMembershipCollision(null)).toBeNull();
    expect(readMembershipCollision(undefined)).toBeNull();
    expect(readMembershipCollision({ code: '23503', message: MEMBERSHIP_ONE_PRIMARY_KEY })).toBeNull();
  });
});

describe('whether a new owner seat is the account\'s primary', () => {
  it('is primary for an account with no seat anywhere', () => {
    expect(ownerSeatIsPrimary([], NEW_ORG)).toBe(true);
  });

  it('is NOT primary where the account already holds one elsewhere — a closed organisation included', () => {
    // The reported case. Sign-in still lands them in the new organisation: a
    // closed organisation is never accessible, so the only accessible one
    // opens by default.
    expect(ownerSeatIsPrimary([{ organisation_id: CLOSED_ORG, is_primary: true }], NEW_ORG)).toBe(false);
  });

  it('is primary where the account sits elsewhere but not as anybody\'s primary', () => {
    expect(ownerSeatIsPrimary([{ organisation_id: CLOSED_ORG, is_primary: false }], NEW_ORG)).toBe(true);
    expect(ownerSeatIsPrimary([{ organisation_id: CLOSED_ORG, is_primary: null }], NEW_ORG)).toBe(true);
  });

  it('ignores a seat in the organisation being granted — that is the seat_exists case', () => {
    expect(ownerSeatIsPrimary([{ organisation_id: NEW_ORG, is_primary: true }], NEW_ORG)).toBe(true);
  });
});

describe('the one grant both operator doors use', () => {
  const grant = readCode('supabase/functions/_shared/builderOwnerSeat.ts');

  it('reads where the account already sits before it decides primary, and fails closed when it cannot', () => {
    const readAt = grant.indexOf(".select('organisation_id, is_primary')");
    const decideAt = grant.indexOf('ownerSeatIsPrimary(');
    expect(readAt).toBeGreaterThan(-1);
    expect(decideAt).toBeGreaterThan(readAt);
    expect(grant).toMatch(/if \(seatsError\) \{\s*return \{ ok: false, reason: 'seats_unreadable'/);
  });

  it('retries a primary that appeared since the read as a non-primary seat, never as no seat', () => {
    expect(grant).toMatch(/readMembershipCollision\(error\) === 'primary_taken'[\s\S]{0,120}insertSeat\(false\)/);
  });

  it('never reads an unrecognised collision as the seat already being there', () => {
    expect(grant).toMatch(/readMembershipCollision\(error\) !== 'seat_exists'\) \{\s*return \{ ok: false, reason: 'seat_not_granted'/);
  });

  it('calls a seat that was already there a success only when it is the seat this grant would have written', () => {
    expect(grant).toMatch(/const expected = args\.accountIsActive \? 'active' : PENDING_MEMBERSHIP_STATUS/);
    expect(grant).toMatch(/seat\.membership_role === 'owner' && seat\.status === expected/);
    expect(grant).toMatch(/reason: 'seat_held_otherwise'/);
  });

  it('never edits a membership in another organisation', () => {
    // The closed organisation's seat is that person's record of where they
    // were; the operator plane does not rewrite it to make room.
    expect(grant).not.toMatch(/\.update\(|\.delete\(|\.upsert\(/);
  });

  it('is never ignored by a door: every failure stops the door before it reports success', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    const calls = [...admin.matchAll(/const seat = await grantOwnerSeat\(supabase, \{/g)];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const after = admin.slice(call.index ?? 0, (call.index ?? 0) + 700);
      expect(after).toMatch(/if \(!seat\.ok\) \{/);
    }
  });
});

describe('an application that could not seat its owner', () => {
  const admin = readCode('supabase/functions/builder-network-admin/index.ts');
  const application = admin.slice(
    admin.indexOf("if (operation === 'submit_access_request')"),
    admin.indexOf("if (operation === 'list_access_requests')"),
  );

  it('refuses a withdrawn account BEFORE it creates the organisation', () => {
    // It used to create the organisation first and refuse after, leaving an
    // ownerless row holding the applicant's ABN and name — which then refused
    // the corrected application as "already registered".
    const refusal = application.indexOf("settle('refused', 'that_account_has_been_withdrawn')");
    const created = application.indexOf("from('builder_organisations')\n        .insert(");
    expect(refusal).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(refusal);
  });

  it('rolls back the empty organisation it created on every later failure', () => {
    for (const detail of ['owner_not_created', 'invite_not_issued', 'owner_not_attached']) {
      expect(application).toContain(`abandon('${detail}'`);
    }
  });

  it('records which organisation it left standing when the rollback could not happen', () => {
    expect(application).toMatch(/organisation_id: removed \? null : organisation\.id/);
  });
});

describe('the windows that refused a corrected application', () => {
  it('count only applications that wrote to the address, never a refused one', () => {
    expect([...ADDRESS_WINDOW_OUTCOMES].sort()).toEqual(['attached', 'provisioned']);
    expect(ADDRESS_WINDOW_OUTCOMES).not.toContain('refused');
  });

  it('hold the address for an application still being acted on, briefly', () => {
    // The same applicant pressing submit twice; a run that died is not held
    // against its own retry for a day.
    expect(IN_FLIGHT_MINUTES).toBeGreaterThan(0);
    expect(IN_FLIGHT_MINUTES).toBeLessThanOrEqual(30);
  });

  it('is read with the outcome filter in the handler, in separate counts rather than an interpolated filter', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(admin).toMatch(/\.in\('status', ADDRESS_WINDOW_OUTCOMES\)/);
    expect(admin).toMatch(/\.eq\('status', 'received'\)\s*\.gte\('created_at', inFlightSince\)/);
    expect(admin).not.toMatch(/\.or\(`[^`]*created_at/);
  });

  it('holds an unsettled application that may already have written to the address for the whole window', () => {
    // A run that sent the invitation and died before it settled left a
    // `received` row the ten-minute count stopped reading, so an application
    // under different company details minted a second organisation, re-stamped
    // the invitation and mailed the address again.
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(admin).toMatch(
      /\.eq\('status', 'received'\)\s*\.not\('organisation_id', 'is', null\)\s*\.gte\('created_at', since\)/,
    );
    expect(admin).toMatch(/\(recent \?\? 0\) \+ \(inFlight \?\? 0\) \+ \(unsettled \?\? 0\) > 0/);
    expect(admin).toMatch(/recentError \|\| inFlightError \|\| unsettledError/);
  });

  it('marks the application with its organisation before the send, which cannot be undone', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    const application = admin.slice(admin.indexOf("operation === 'submit_access_request'"));
    const mark = application.search(
      /\.update\(\{ organisation_id: organisation\.id, builder_user_id: ownerId \}\)\s*\.eq\('id', request\.id\)/,
    );
    const send = application.indexOf('sendBuilderEmail(');
    expect(mark).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(mark);
    // And nothing between the mark and the send can refuse the application,
    // or a refused row would carry an organisation it was never given.
    expect(application.slice(mark, send)).not.toMatch(/abandon\(|settle\('refused'/);
  });

  it('says when an application could not be settled, rather than leaving it received in silence', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(admin).toMatch(/const \{ error: settleError \} = await supabase\s*\.from\('builder_access_requests'\)/);
    expect(admin).toMatch(/access request not settled/);
  });

  it('leave an office room to correct a mistake without being told to come back tomorrow', () => {
    // Every correction is another counted attempt at the origin.
    const [short, long] = [...ORIGIN_WINDOWS].sort((a, b) => a.hours - b.hours);
    expect(short.limit).toBeGreaterThanOrEqual(8);
    expect(long.limit).toBeGreaterThanOrEqual(short.limit * 2);
  });
});

describe('an owner invitation whose link the operator may not hold', () => {
  const admin = readCode('supabase/functions/builder-network-admin/index.ts');
  const door = admin.slice(
    admin.indexOf("if (operation === 'invite_organisation_owner')"),
    admin.indexOf("if (operation === 'upsert_workspace')"),
  );

  it('says the link was withheld, rather than answering an empty one', () => {
    // The console read an absent link as "" and drew an empty box to copy.
    expect(door).toMatch(/link_withheld: !established && !linkIsTheirs/);
    expect(door).toMatch(/invite_url: established \|\| !linkIsTheirs \? null : minted!\.url/);
  });

  it('emails it whether or not the operator ticked the box, because the email is its only road', () => {
    // Otherwise the person is invited by a link nobody holds, and this door
    // refuses a second attempt because the organisation now has a member.
    expect(door).toMatch(/const mustEmail = !established && !linkIsTheirs/);
    expect(door).toMatch(/const emailRequested = body\.send_email === true \|\| mustEmail/);
    expect(door).toMatch(/if \(emailRequested\) \{/);
    expect(door).toMatch(/email_requested: emailRequested/);
  });
});

describe('re-issuing the first owner\'s invitation', () => {
  const owner = 'acc-1';
  const waiting = { builder_user_id: owner, membership_role: 'owner', status: 'invited', revoked_at: null };

  it('yields only to the same person\'s waiting owner seat', () => {
    expect(ownerInvitationMayBeReissued({ seats: [waiting], accountId: owner })).toBe(true);
  });

  it('is never "nobody here yet" — an empty organisation is the ordinary bootstrap, not a re-issue', () => {
    expect(ownerInvitationMayBeReissued({ seats: [], accountId: owner })).toBe(false);
  });

  it('refuses another person, an accepted seat, another role, a revoked seat or an unknown account', () => {
    expect(ownerInvitationMayBeReissued({ seats: [{ ...waiting, builder_user_id: 'acc-2' }], accountId: owner })).toBe(false);
    expect(ownerInvitationMayBeReissued({ seats: [{ ...waiting, status: 'active' }], accountId: owner })).toBe(false);
    expect(ownerInvitationMayBeReissued({ seats: [{ ...waiting, membership_role: 'admin' }], accountId: owner })).toBe(false);
    expect(ownerInvitationMayBeReissued({ seats: [{ ...waiting, revoked_at: '2026-10-01T00:00:00Z' }], accountId: owner })).toBe(false);
    expect(ownerInvitationMayBeReissued({ seats: [waiting], accountId: null })).toBe(false);
    // One good seat does not launder another person beside it.
    expect(ownerInvitationMayBeReissued({
      seats: [waiting, { ...waiting, builder_user_id: 'acc-2' }],
      accountId: owner,
    })).toBe(false);
  });

  it('says on the record and in the answer that an earlier link stopped working', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(admin).toMatch(/reissued: reissue,\s*email_sent:/);
    expect(admin).toMatch(/reissued: reissue,\s*expires_at:/);
  });
});
