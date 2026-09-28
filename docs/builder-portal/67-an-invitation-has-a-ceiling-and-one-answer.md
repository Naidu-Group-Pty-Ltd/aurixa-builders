# 67 — An invitation has a ceiling, and one answer

28 Sep 2026. Two findings on `builder-portal-invite`, fixed together because
both are about what one organisation's owner or administrator can do with that
door: send without bound, and learn from the answer whether an arbitrary
address already has a Builder Portal account.

## 1. The ceiling

`invite` and `resend` each mint a one-time token and send an email through the
mail provider every tenant shares. Nothing bounded them — the door sat in the
rate-limit gate's EXEMPT list on the reasoning that a ceiling would cap
onboarding rather than an attacker, and doc 65's review had already named the
gap (a caller could provoke provider failures at will).

**What is counted.** Both acts, and nothing else, against two buckets in the
shared limiter (`auth_rate_limits`, through `consumeAuthRateLimit` — the same
RPC, the same fallbacks and the same 429 as every other door):

| Bucket | Key | Ceiling |
|---|---|---|
| the person | `binv_user:<session user id>` | 40 an hour |
| the organisation | `binv_org:<active organisation id>` | 100 an hour |

The person is consumed first and the check stops at the first refusal, so an
administrator over their own ceiling spends none of the organisation's.

**Why those numbers.** Production held no genuine invitation history to fit
them to: every inviter in the activity log was a proof account (the busiest
sent 11 in one hour, one organisation 12) and the largest real organisation
had two members. So they are reasoned from the workflow — an owner onboarding
an office of about thirty in one sitting, with room for resends and typos; and
several administrators doing that together. The organisation's ceiling is also
the bound on what one tenant can spend of the shared provider, however many
administrators it appoints. The hour is the window every other email-sending
door here uses (forgot-password, register, accept-invite, verify-email).

**Why identity, not the address.** The caller is authenticated, and both keys
come from the server-validated session; the caller can choose neither. The
IP-first helpers exist for doors a stranger knocks on, where the address is the
only identity there is. Here an address key would be worse than redundant:
requests arrive through the portal's `/fn` proxy, and one that reaches the
function without the proxy's proof secret — or with no trusted address header
at all — shares a bucket with every other tenant, so one organisation's burst
would refuse everybody's invitations. The gate now enforces this:
`builder-portal-invite` must call `enforceSessionRateLimit` and may not call an
IP-first helper.

**Where it sits.** After the owner/administrator check, so a member cannot
spend the organisation's allowance on requests that were going to be refused;
before anything is looked up, written, minted or sent, so a refused request
leaves no account, membership, token, email or activity entry, and the 429
cannot vary with the address asked. The body is the shared one
(`{ error, retry_after_seconds }`); the function also sets `Retry-After`, which
the portal's proxy does not forward — it carries only `content-type` and
`set-cookie`, for every door alike.

## 2. The one answer

What `invite` answered depended on an account that may belong to somebody the
caller has never met:

| The address | Before | Now |
|---|---|---|
| brand new | `success, email_sent, expires_at` | `{"success":true}` |
| a pending invitee elsewhere | `success, email_sent, expires_at` | `{"success":true}` |
| already signs in | `success, email_sent` — **no `expires_at`** | `{"success":true}` |
| revoked by an operator | `success, email_sent: false` | `{"success":true}` |
| a case-variant race | `success, email_sent: false` | `{"success":true}` |

`expires_at`'s absence said "this address already has an account", and
`email_sent: false` beside a working provider said "and it was revoked".

Every success the invite action gives now goes through
`tenantInviteResponse({ inviteUrl })`, which has no parameter through which
anything else about the invitee could arrive. The one-time link is added only
where the deployment has no mail provider at all (`mayHandLinkToInviter`,
unchanged). Nothing about expiry changed: the token's expiry is still stored
and still refused at acceptance. Whether an email left is still recorded — in
the activity log's metadata, now for the access notice to an account that
already signs in as well as for invitations. No tenant can read that: the
log's RLS admits `service_role` alone (measured: `anon` and `authenticated`
see 0 of its 2,699 rows), no edge function reads it, and the one reader a
tenant reaches, `builder_visible_activity`, returns no metadata and admits no
`portal_user` entry, which is what every invitation is logged against.

**And the same answer the second time.** The independent review of this
change found that the first answer was uniform and a repeat was not. After one
invitation the caller's organisation holds a seat for any address it typed —
`active` at once for an address that already signs in, `invited` for any other —
and two more answers were keyed on the account behind that seat:

| After one invitation | Before | Now |
|---|---|---|
| `invite` the same address again | **409** `membership_not_promotable` if it already signs in, 200 otherwise | 200, same bytes |
| `resend` its seat | **409** `already_active` if it already signs in, 200 otherwise | 200, same bytes |

A repeat is now decided by this organisation's own seat, which its
administrators already see on the members list, never by the account: a
`suspended` seat is refused whatever the account is (only an `active` seat can
be suspended from the portal, so this is the case that refused before); an
`active` seat of an account that signs in is a working member already, so there
is nothing to grant or send; an `invited` seat is re-sent, or promoted at once
for an account that has since started signing in, as before. Where a
promotion finds nothing left to promote (a concurrent repeat got there first),
the seat is read again and decides the same way. `resend` of an
account that already signs in sends nothing, because there is nothing for it to
accept, and answers as a re-sent invitation does. `resend`'s answer lost
`email_sent` and `expires_at` for the same reason `invite`'s did. Nothing in the
product read `resend`'s answer.

The portal's card no longer reads either field. Its message comes from the
link alone: "If <address> can be added to <organisation>, they'll get an email
about it", or, where there is no mail provider, the link to pass on.

## 3. What this does not close

Stated so nobody reads the response fix as more than it is. Doc 68 (28 Sep
2026) closes most of these: every invitation now waits for its invitee, each
lives on its own seat, the answer takes a fixed time, sends are paced, there is
a deployment-wide delivery reading, and the name has a ceiling. Its §8 says what
still stands.

- **The members list still separates them.** This, together with the member
  actions that answer by the state the list shows, is where a tenant
  administrator can still tell. (Suspending an `invited` seat is refused, and
  cancelling an invitation removes the seat only for an account that has not
  signed in.) An address that already signs in joins as a live member at once,
  which is the owner's recorded decision: there is nothing for it to accept. So
  after one invitation, `list_members` shows:
  - a member, under the account's own registered name, for an address that
    already signs in;
  - a pending invitation for a new address;
  - for an address another organisation is already inviting, the name that
    organisation typed;
  - nothing at all for a revoked account.

  Closing it means changing that decision (a grant to an established account
  that waits for the person to accept joining, and a list that shows the name
  the inviter typed), not this door.
- **With no mail provider**, the link's presence still separates "must set a
  password" from "need not". There the inviter is the only postman, and
  withholding the link would stop the deployment inviting anybody. Production
  has a provider, so it never returns a link.
- **Response time** differs by path. These send no email, so they answer
  sooner:
  - a revoked account;
  - a repeat for an active member;
  - a `resend` to an account that signs in.

  This change removed the value that used to differ on the last two; the
  timing difference beside it is as it was. It is measured in production by
  the proof run. The remedy is to answer first and send afterwards
  (`EdgeRuntime.waitUntil` or an outbox).
- **A missing token pepper** makes new and pending addresses answer 503 while
  established ones answer 200. That misconfiguration also stops every
  invitation, so it cannot persist unnoticed.
- **The ceiling is hourly, not paced.** 40 (or an organisation's 100) can be
  spent in one burst, and nothing caps a day, while the mail provider limits
  sends per second across every tenant. Every door here shares that property.
  The remedy is paced sending through an outbox, not a second window on one
  door.
- **A failed send is invisible to the inviter.** The answer that used to say so
  varied with the address, which was the leak. What is missing is a
  deployment-level delivery-health signal; a per-address one would reopen the
  oracle.
- **Two quiet answers, by design.**
  - A repeat for an active member ignores a different role in the request;
    changing a role is `manage_member`'s job.
  - A `resend` to a waiting seat whose account now signs in sends nothing and
    does not promote the seat; inviting again does. No screen calls `resend`.
- **An organisation learns when an operator later revokes an account it has
  already seated.** `resend` answers 409, and a repeat for that seat answers
  200. This is about its own member, not about whether an address exists.
- **Unchanged, and out of scope here:**
  - The colleague's `name` has no length bound before it reaches an email; its
    volume is now capped by the ceiling.
  - One organisation re-inviting another's pending invitee still replaces that
    invitee's single token (doc 65).
  - Join-request emails are unbudgeted but bounded, because nothing creates
    join requests any more.
  - The token update in `issueInvite` sets the account `invited` and inactive
    without checking it is still unaccepted. An account that activated between
    the read and that write would be deactivated. The window is a few
    milliseconds, and the repeat path's seat read adds one query to it. The fix
    is a conditional update with a row count.

## 4. How it is held

- `builderInviteRateLimit.spec.ts` — the keys, the budgets, the order, and
  where the handler checks: after the role gate, before the first write, mint,
  send or log, answered with the shared 429, never an IP-first helper.
- `builderInviteOracle.spec.ts` — every 2xx in the invite and resend blocks is
  `tenantInviteResponse`, a repeat is decided by the seat and not the account,
  neither field is named in anything either answers, the evidence is still
  logged, expiry is still enforced at acceptance, and no tenant-facing reader
  returns those log entries or their metadata. The two repeat assertions failed
  on the code the review read, before the fix.
- Both specs failed on `main`: 8 of the oracle spec's 13, and the whole ceiling
  spec — 4 of its 15 still failing once its module existed, because the handler
  had no ceiling. Five mutants — the ceiling moved after a write, moved before
  the role gate, keyed on the address, `email_sent` restored to one answer,
  `expires_at` restored to another — were each caught.
- `check-auth-rate-limit-coverage.mjs` — the door is in its own class and must
  call `enforceSessionRateLimit` and no IP-first helper.
- `portal-access-proof.mjs` sections J and K, on the live deployment with
  disposable organisations only: three addresses of each of the four kinds
  answer the same bytes, as do a second invitation of every one and a resend of
  every seat, while the server handles them four different ways; the
  ceiling counts once per person and per organisation, admits a burst to 40 and
  refuses past it, leaves nothing behind when it refuses, holds for a second
  administrator once the organisation's allowance is spent, and leaves another
  organisation untouched. A printed body never shows a link. Every proof that
  invites removes its own buckets, and the cleanup audit counts any bucket used
  in the last week that names an account or organisation which no longer
  exists.

## 5. Proved in production

28 Sep 2026, after #142 merged (47e4919) and deployed through the normal path.
`builder-portal-invite` moved from v833 to v838 with a new bundle hash; the
migration ledger was untouched (66 rows, newest `20260928120000`); the Vercel
production deployment of 47e4919 was READY. Every proof ran on disposable
organisations only.

**`portal-access-proof`, 138 of 138** (run `4b2c03d1`):

- **J — one answer.** Every answer was the same bytes, `{"success":true}`:
  12 first invitations (three each of new, pending elsewhere, already signed
  in, revoked), 12 repeats and 9 resends. Underneath, the server handled the
  four kinds four different ways (`invited/invited`, `invited/invited` plus the
  other organisation's waiting seat, `active/active`, `revoked/none`). The
  operator-only log still recorded 6 invitation sends and 3 grant notices, and
  a repeat of an address that already signs in granted and sent nothing.
- **Response time, measured, median of three:** new 1,438 ms, pending 1,441,
  signed in 1,335, revoked 932. A revoked account answers about half a second
  sooner because it sends no email (§3).
- **K — the ceiling.**
  - Each of D's 33 invitation and resend calls was counted once, against the
    person and against the organisation.
  - A member was refused 403 before the ceiling; the organisation's count
    stayed at 35.
  - A burst past the person's ceiling answered 200, 200, 429 (the 41st). It
    said to wait 3,501 s, and the function's own `Retry-After` matched its
    body (3,494).
  - The refused requests left no account, no membership, no activity (25 → 25)
    and none of the organisation's allowance (37 → 37).
  - A refused resend re-minted nothing. Listing members and cancelling an
    invitation still answered.
  - A second administrator with a fresh allowance was refused once the
    organisation's was spent. Another organisation invited as normal.
- **I — the takeover fix** held throughout, and its two answers are now the
  same bytes.
- **Cleanup:** zero of everything, the ceiling's buckets included.

**The regression sequence**, one phase at a time:

| Phase | Result |
|---|---|
| `verify` | nothing pending, nothing changed |
| `smoke` | 81 checks, 0 failures |
| `proxy-trust` | 12 of 12 |
| `stock-messaging-proof` | 42 of 42 |
| `stock-private-chat-proof` | 38 of 38 |
| `portal-performance-proof` | 5 of 5 |
| `activation-speed-proof` | 12 of 12 |
| `portal-browser-proof` | 19 of 19 |
| `message-speed-proof` | 24 of 24 |

**The cleanup audit, last:** `AUDIT CLEAN — WITH EXPECTED RETAINED SECURITY LOG
EVIDENCE`. It found 0 mutable proof artefacts, 0 orphaned ceiling buckets and
no proof data in the real conversations, and it wrote nothing. The 9 retained
entries are earlier runs' deliberate refusals. Read afterwards, production held
0 ceiling buckets and 0 proof accounts or organisations. The 6 genuine accounts
and 6 live seats were unchanged.
