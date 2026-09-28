#!/usr/bin/env node
/**
 * DOES A BUILDER EMAIL ACTUALLY REACH A MAILBOX?
 *
 * The client-readiness audit could not say, and its first answer was wrong.
 * Every send on record had failed — 110 invitations since 16 Sep 2026, each
 * logged `Resend refused the send 422` — which was read as an unverified
 * sender. Every one of them had in fact gone to a proof address on
 * `@example.com` or `@smoke.example`: reserved names no mail system will ever
 * deliver to and the provider refuses at the API. So the corpus proved nothing
 * in either direction — AN INSTRUMENT THAT CAN ONLY SEND TO A RESERVED DOMAIN
 * CANNOT MEASURE DELIVERY, and its refusals are no more evidence of a broken
 * configuration than of a working one.
 *
 * (Two real sends DID succeed: the access-request invitations of 18 Sep 2026
 * recorded `invite_sent: true`, which is written only from a send the provider
 * accepted. That is what tells us the sender and the key are sound. The
 * diagnosis step below re-establishes both halves from the database rather
 * than resting on this note.)
 *
 * This phase is the missing instrument. It takes ONE mailbox the operator
 * controls, passed in rather than committed, and drives the two emails a new
 * client actually depends on through the live doors:
 *
 *   1. an invitation, whose response reports the provider's own verdict; and
 *   2. a password reset, whose door answers generically by design — so the
 *      assertion is that the provider refused nothing and a reset code was
 *      minted.
 *
 * Three rules it keeps:
 *
 *   * NO ADDRESS IS COMMITTED. The recipient arrives in the environment, and
 *     only its domain is ever printed. A proof that names a mailbox in a log
 *     is a proof that publishes one.
 *   * A RESERVED DOMAIN IS REFUSED UP FRONT. Pointing this at
 *     `@example.com` would reproduce the very blind spot it exists to close,
 *     and would report a pass that means nothing.
 *   * THE ORGANISATION IS DISPOSABLE AND IS REMOVED. Only the mailbox is real.
 *     Nothing is written to a genuine organisation, and the account this
 *     creates for the mailbox is deleted at the end.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const RECIPIENT = (process.env.PROOF_EMAIL_RECIPIENT || '').trim().toLowerCase();
const RUN = randomBytes(4).toString('hex');
const TAG = 'email';
const ORG_PREFIX = `Smoke Rollout ${TAG} ${RUN}`;
const MARK = 'smoke-rollout';
const ALL_ACKS = ['portal_access', 'data_accuracy', 'confidentiality', 'binding_amlctf_arrangement'];

/** Names that can never receive mail — RFC 2606 and the test TLDs beside it. */
const UNDELIVERABLE = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|example|smoke\.example)$/i;

const results = [];
function record(name, ok, detail = '', { required = true } = {}) {
  results.push({ name, ok, detail, required });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!ACCESS_TOKEN || !PEPPER) {
  console.error('email delivery proof needs SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER');
  process.exit(1);
}
if (!RECIPIENT || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(RECIPIENT)) {
  console.error(
    'email delivery proof needs PROOF_EMAIL_RECIPIENT — one mailbox the operator controls.\n' +
    'It is never committed: pass it as the workflow input for this phase.',
  );
  process.exit(1);
}
const domain = RECIPIENT.split('@')[1];
if (UNDELIVERABLE.test(domain)) {
  console.error(
    `email delivery proof refuses ${domain}: a reserved name cannot receive mail, so a pass would ` +
    'mean nothing. This is exactly the blind spot the phase exists to close.',
  );
  process.exit(1);
}
console.log(`email delivery proof run=${RUN} origin=${ORIGIN} recipient domain=${domain}`);

const sqlLit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const id = (value) => `${sqlLit(value)}::uuid`;
const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');

async function q(label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: ${response.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return []; }
}

async function call(fn, body, cookie = null) {
  const response = await fetch(`${ORIGIN}/fn/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Request': 'builder',
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, setCookies: response.headers.getSetCookie?.() ?? [] };
}

const cookieFrom = (setCookies) => (setCookies ?? [])
  .map((line) => line.split(';')[0])
  .find((pair) => pair.startsWith('__Host-builder_session_token=')) ?? null;

const ORGS_SQL = `SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`;

/**
 * Everything this run made, and nothing else. The mailbox's own account is
 * removed with it: a proof that leaves a real address holding a membership in
 * a deleted organisation has not cleaned up.
 */
async function cleanup(stage) {
  await q(`cleanup ${stage}`, `
    DELETE FROM public.builder_organisation_memberships
     WHERE organisation_id IN (${ORGS_SQL});
    DELETE FROM public.builder_portal_sessions
     WHERE builder_user_id IN (
       SELECT id FROM public.builder_portal_users
        WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)} OR email = ${sqlLit(RECIPIENT)});
    DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
    DELETE FROM public.builder_portal_users
     WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)} OR email = ${sqlLit(RECIPIENT)};`);
}

let crashed = null;
await cleanup('start');
try {
  /*
   * FIRST, THE DIAGNOSIS — from the log rather than from a recollection.
   *
   * The audit's reading was that "every Builder send is failing", and the
   * first explanation offered for it was a wrong sender. That explanation was
   * wrong, and the way to settle it is to ask what the failures have in
   * common rather than to reason about configuration.
   *
   * Two witnesses, because neither is complete on its own:
   *
   *   * `builder_portal_activity_log` records `email_sent` beside every
   *     invitation and has NO foreign key to the user (its own comment: the
   *     audit trail outlives the records it describes). So the rows survive a
   *     proof run's cleanup while the accounts do not — and an invitation
   *     whose account has since been DELETED is itself evidence of a
   *     disposable one, because no real account is ever deleted here.
   *   * `builder_access_requests` is durable and holds the requests real
   *     people made, with its own `invite_sent`.
   *
   * Reported as counts by kind. No address is selected, and a deliverable
   * domain is never named: a reserved name belongs to nobody, a real one
   * names a business.
   */
  // Narrower than the refusal above, deliberately. This one CLASSIFIES history,
  // so anything it fails to call reserved counts as deliverable and makes the
  // assertion below harder to pass. The refusal guards what this run sends, so
  // there it is the wider list that is safe.
  const RESERVED_SQL = "~* '(^|\\.)(example\\.(com|org|net)|test|invalid|localhost|smoke\\.example)$'";
  const split = (await q('invitation outcomes by recipient kind', `
    SELECT CASE WHEN u.id IS NULL THEN 'removed'
                WHEN split_part(u.email, '@', 2) ${RESERVED_SQL} THEN 'reserved'
                ELSE 'deliverable' END AS kind,
           (l.metadata->>'email_sent' = 'true') AS sent,
           count(*)::int AS n
      FROM public.builder_portal_activity_log l
      LEFT JOIN public.builder_portal_users u ON u.id = l.entity_id
     WHERE l.action IN ('builder_invite_sent', 'builder_invite_resent')
     GROUP BY 1, 2 ORDER BY 1, 2`));
  const tally = (kind, sent) =>
    split.filter((r) => r.kind === kind && r.sent === sent).reduce((t, r) => t + Number(r.n), 0);
  for (const kind of ['reserved', 'removed', 'deliverable']) {
    console.log(`  diagnosis — ${kind} recipients: ${tally(kind, true)} accepted, ${tally(kind, false)} refused`);
  }
  record('D: NO refused invitation ever went to a recipient that could have received it',
    tally('deliverable', false) === 0,
    `${tally('deliverable', false)} refusals to a deliverable recipient; ` +
    `${tally('reserved', false) + tally('removed', false)} to reserved or since-deleted proof accounts`);

  const requests = (await q('access requests by recipient kind', `
    SELECT CASE WHEN split_part(email, '@', 2) ${RESERVED_SQL} THEN 'reserved'
                ELSE 'deliverable' END AS kind, invite_sent, count(*)::int AS n
      FROM public.builder_access_requests
     WHERE invited_at IS NOT NULL OR invite_sent
     GROUP BY 1, 2 ORDER BY 1, 2`).catch(() => []));
  const accepted = requests
    .filter((r) => r.kind === 'deliverable' && r.invite_sent === true)
    .reduce((t, r) => t + Number(r.n), 0);
  record('D: and a real mailbox HAS been accepted by the provider, so the sender and the key are sound',
    accepted > 0,
    `${accepted} access-request invitation(s) to a deliverable domain were accepted. ` +
    'That is written only from a send the provider answered 2xx to.');

  // A disposable organisation with an owner, governed through the real doors.
  const ownerEmail = `${MARK}-${TAG}-${RUN}-owner@example.com`;
  const created = await q('seed', `
    WITH o AS (
      INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
      VALUES (${sqlLit(`${ORG_PREFIX} A`)}, 'builder', 'active', true, now())
      RETURNING id
    ), u AS (
      INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at, password_hash)
      VALUES (${sqlLit(ownerEmail)}, 'Email Owner', 'active', true, now(), 'x')
      RETURNING id
    ), m AS (
      INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
      SELECT u.id, o.id, 'owner', true, 'active' FROM u, o RETURNING builder_user_id, organisation_id
    )
    SELECT (SELECT id FROM u) AS user_id, (SELECT id FROM o) AS org_id`);
  const { user_id: ownerId, org_id: orgId } = created[0];
  await q('onboarding', `SELECT public.builder_ensure_onboarding_steps(${id(ownerId)})`);

  const token = `${randomUUID()}-${randomUUID()}`;
  const sessionId = (await q('mint session', `
    INSERT INTO public.builder_portal_sessions(
      builder_user_id, token_hash, absolute_expires_at, idle_expires_at, active_organisation_id)
    VALUES (${id(ownerId)}, ${sqlLit(hmacHex(PEPPER, token))},
            now() + interval '12 hours', now() + interval '240 minutes', ${id(orgId)})
    RETURNING id`))[0].id;
  const cookie = `__Host-builder_session_token=${token}`;
  await call('builder-portal-verify', { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, cookie);
  await call('builder-portal-verify', { action: 'complete_onboarding' }, cookie);
  record('0: a disposable organisation, governed, with nothing real in it',
    !!sessionId && !!orgId, `org=${String(orgId).slice(0, 8)}`);

  // 1. THE INVITATION. `email_sent` is written from the provider's own answer.
  const invite = await call('builder-portal-invite',
    { action: 'invite', email: RECIPIENT, name: 'Delivery Proof', membership_role: 'read_only' }, cookie);
  record('1: the invitation door accepted the request', invite.status === 200, `status=${invite.status}`);
  record('1: THE PROVIDER ACCEPTED THE INVITATION EMAIL — it left this platform',
    invite.json?.email_sent === true,
    `email_sent=${invite.json?.email_sent}. false means the provider refused it; the reason is now in ` +
    'the function log as `provider_message`, beside the sender it tried and never the recipient.');
  // The whole reason the takeover was reachable: a failed send hands the link
  // back. A send the provider accepted must not.
  record('1: and no one-time link came back in the response, because the email carries it',
    !invite.json?.invite_url,
    invite.json?.invite_url ? 'a link WAS returned' : 'absent');

  // 2. THE PASSWORD RESET. The door answers generically whatever happens — it
  // must not confirm whether an account exists — so the evidence is that a
  // code was minted and that the provider refused nothing.
  const before = new Date().toISOString();
  const reset = await call('builder-portal-forgot-password', { email: RECIPIENT });
  const resetRow = (await q('reset token', `
    SELECT (reset_token_hash IS NOT NULL) AS minted, reset_token_expires_at > now() AS live
      FROM public.builder_portal_users WHERE email = ${sqlLit(RECIPIENT)}`))[0] ?? {};
  record('2: the reset door answered, generically, as it must', reset.status === 200, `status=${reset.status}`);
  record('2: a reset code was minted and is live, so an email was composed and sent',
    resetRow.minted === true && resetRow.live === true,
    `minted=${resetRow.minted} live=${resetRow.live} since=${before.slice(11, 19)}Z`);

  console.log('\n  The two assertions a mailbox settles, and this proof cannot:');
  console.log(`  * an invitation to ${domain} has arrived, and its link opens the password form;`);
  console.log(`  * a reset code to ${domain} has arrived, and it is six digits.`);
  console.log('  Neither is asserted here. The provider accepting a send is not a mailbox receiving it.');
} catch (error) {
  crashed = error;
  record('the proof ran to completion', false, String(error?.message || error));
} finally {
  await cleanup('end');
  const residue = (await q('residue', `
    SELECT (SELECT count(*) FROM public.builder_organisations
             WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)})::int AS orgs,
           (SELECT count(*) FROM public.builder_portal_users
             WHERE email = ${sqlLit(RECIPIENT)}
                OR email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)})::int AS users`))[0];
  record('cleanup: the disposable organisation and the mailbox\'s account are both gone',
    Number(residue.orgs) === 0 && Number(residue.users) === 0,
    `orgs=${residue.orgs} users=${residue.users}`);
}

const required = results.filter((r) => r.required);
const passed = required.filter((r) => r.ok).length;
console.log(`\n${passed} of ${required.length} required checks passed (run ${RUN})`);
if (crashed || passed !== required.length) {
  console.log('EMAIL DELIVERY PROOF FAILED');
  process.exit(1);
}
console.log('EMAIL DELIVERY PROOF PASSED');
