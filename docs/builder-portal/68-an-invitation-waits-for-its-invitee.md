# 68 — An invitation waits for its invitee

28 Sep 2026. The owner's rule, and the six items doc 67 §3 left open on
`builder-portal-invite`. Migration `20260929090000_an_invitation_waits_for_its_invitee.sql`
is additive and changes no existing row.

## 1. Every organisation invitation waits for the invitee

An address that already signed in somewhere used to join an inviting
organisation at once: the membership was granted `active`, nothing was
minted, and a notice said "you now have access". Two things followed.

- **Nobody agreed to it.** Any owner or administrator could put an existing
  account into their organisation, with a role they chose, and it appeared in
  that person's switcher.
- **It was the last oracle.** The members list filed that address as a live
  member under its registered name the moment it was invited. A new address
  waited as an invitation under the name the inviter typed. One invitation told
  an administrator whether an arbitrary address already had an account.

The owner's rule: every organisation invitation waits for the invitee to accept
it, established accounts included.

| The invitee | The seat | The email | Accepting |
|---|---|---|---|
| a new address, or one never accepted | `invited` | "Set your password" | sets the password, activates the account and this seat, signs in (as before) |
| an account that already signs in | `invited` | "Accept invitation" | one click: this seat comes up; nothing about the account is written; no session is issued |
| an account an operator revoked | none | none | — |

- **The join writes nothing to the account.** Its password, status and activity
  are not the link's to touch. A link that could set a password would be a
  password reset dressed as an invitation. A password sent with a join is
  ignored.
- **The join issues no session.** A link that signed somebody in without their
  password would be a weaker door than the one they already use. They sign in as
  they always have, and the organisation is there.
- **The mailbox is the proof, as it is for a first invitation.** Anyone who
  holds the mailbox can already reset the password (`forgot-password`), so
  accepting by the emailed link trusts nothing the product did not already
  trust.
- **The link is never handed to the inviter for a join.** On a deployment with
  no mail provider the inviter is handed the link, but only one that sets a
  password (`inviterMayHoldInvitationLink`). A join link would let the inviter
  accept on the person's behalf.
- **A link somebody else holds keeps what it was minted for** (found by the
  independent review). Each seat records what its link is for
  (`invite_requires_password`) and whether it was handed to the inviter
  (`invite_link_handed`), decided before the link exists by the same rule that
  hands it over.
  - A **handed** password-setting link whose account has since started
    signing in elsewhere is refused, not turned into a join, since a join would
    let the inviter accept for the person. The organisation invites again, and
    the person is emailed a join.
  - A link **only the mailbox holds** follows the account. Its holder is the
    person, who could reset the password with that mailbox anyway. So someone
    invited by two organisations before they had an account can accept both:
    the second link joins (the second review; it used to stop working until the
    organisation sent it again).
  - Every account-slot token was minted for an account with no password, and
    may be an operator's, so the slot path still refuses an account that has
    one (`already_active`), as it always did.
- **Existing memberships are untouched.** Nothing is backfilled, and every
  `active` seat stays `active`.
- **The page.** `BuilderAcceptInvite` shows no password form for a join, says
  there is nothing to set, and after the click sends the person to the portal
  rather than pretending a session exists.
- **The members list** shows a waiting seat under the name this organisation
  typed (`invited_name`), never the account's. Once the person accepts, they are
  a member and are shown as they call themselves. `revoke_invite` cancels a
  waiting seat whoever it is for (it used to cancel only for an account that had
  never signed in).
- **Inviting a waiting person again carries the role chosen now** (the second
  review: the first invitation's role used to stand, so lowering it by inviting
  again did not take). An owner's seat, which only the operator's doors create,
  is never re-roled here. A re-send chooses no role and changes none.

**Not changed, deliberately:** the operator's doors (`builder-network-admin`:
`invite_organisation_owner`, which seeds an EMPTY organisation's first owner, and
`submit_access_request`, an applicant's own application) still attach an
established account at once. They are the operator plane, not an organisation
inviting a colleague, and were left as they are. Join-request approval is the
person's own request and also stays live at once.

## 2. Each invitation lives on its own seat

The token lived in the account's ONE slot (`builder_portal_users.invite_token_hash`),
so organisation B inviting an address A had already invited replaced A's token,
and A's link stopped working with nothing to say why. Each organisation's
invitation now lives on its own waiting seat
(`builder_organisation_memberships.invite_token_hash`, `invite_token_expires_at`).

- **Nothing another organisation does can reach it.** A re-send replaces this
  seat's token and no other.
- **The column holds only a peppered hash**, in the same hex shape as the account
  slot. It is unique across seats.
- **It may sit only on a waiting, live seat** (`builder_memberships_token_on_waiting_seat`).
- **It is destroyed by whatever moves the seat on** (trigger
  `trg_builder_membership_invitation_ends`): acceptance, suspension or removal,
  by any path. No function has to remember to clear it.
- **Acceptance uses it up in the statement that accepts it.**
  `promoteWaitingMembership` takes `inviteTokenHash`, so one token brings one
  seat up, once.

The account slot stays for the operator's doors and for anything issued
before this. The acceptance door reads the seat first, then the slot.

## 3. The answer takes the same time for every kind of address

A revoked account answered ~450 ms sooner than every other kind (doc 67 §5),
because only the others sent an email before answering. Now:

- every email starts only once the answer's floor has passed, in the background
  (`afterAnswer(holdAnswer(...).then(...))`, `EdgeRuntime.waitUntil`);
- every `invite` and `resend` answer past the owner/administrator gate and the
  ceiling, a fault included, waits for a fixed floor, `INVITE_ANSWER_FLOOR_MS` =
  1,500 ms after the request arrived. The CSRF, 401, 403 and 429 answers before
  that are decided without reading the address and are not held.

The work before the answer is a few database round trips, well under the floor,
so the time an answer takes is the floor for every kind. The act is logged when
it happens (`builder_invite_sent` / `builder_invite_resent`). Whether its email
left is logged when that happens (`builder_invite_delivery`, with `email_sent`,
the outcome and `sent_at`), where only an operator reads it.

## 4. Invitations are paced

The ceiling is 40 an hour per person and 100 per organisation, and all of it
could be spent in one second. The mail provider admits 2 requests a second per
team, shared by every send this deployment makes.

- **Each invitation email waits for its own slot**, reserved in the database under
  one row lock (`builder_reserve_email_send_slot`). Invitations leave at most one
  a second (`EMAIL_SEND_SPACING_MS`), deployment-wide, however many isolates are
  sending — half the provider's ceiling.
- **One organisation has its own share.** At most 20 of one organisation's
  emails may wait at once (`EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION`, counted in
  `builder_email_send_reservations`). The independent review measured an
  organisation with three administrators bursting ~91 sends into the whole
  queue. Now its own sends past 20 are refused, and a burst from one
  organisation holds everyone else back by at most ~20 s. Several organisations
  bursting at once can still fill the queue between them (§8).
- **A refused send is stamped against its organisation**
  (`builder_email_send_scope_refusals`), whether it was refused for the
  organisation's own share or because the whole queue was full, so that
  organisation's administrators are told (§5).
- **A full queue sends nothing.** A slot further away than 90 s
  (`EMAIL_SEND_MAX_WAIT_MS`, inside the edge worker's lifetime on the smallest
  plan) is refused rather than queued without end. The invitation stays waiting,
  the outcome is logged `paced_out`, and inviting the address again re-sends it.
  The delivery record carries `sent_at`, when the email left the queue.
- **A pacer that cannot be asked** is met with the isolate's own spacing, not
  with none: the shape every limiter here degrades to.

## 5. One delivery reading for the whole deployment

An administrator whose invitation never arrived had no way to know whether mail
was working at all. The answer that used to hint at it varied with the address,
which was the leak. `delivery_health` (owner or administrator) now answers one
reading for the deployment:

- **`operational` / `degraded`** — from a check sent to the provider's own sink
  (`delivered@resend.dev`, overridable by `BUILDER_EMAIL_DELIVERY_CHECK_RECIPIENT`),
  never from a real invitation;
- **`held_back`** — when the caller's OWN organisation had an invitation email
  held back in the last 15 minutes (`DELIVERY_HELD_BACK_WINDOW_SECONDS`), read
  only under that organisation's scope and never another's (the second review:
  an organisation's own overflow was invisible, since its share of 20 never
  makes a 30-second queue);
- **`delayed`** — when the send queue is 30 s or longer;
- **`not_configured`** — when there is no mail provider;
- **`unknown`** — before the first check.

The check runs at most every 30 minutes, claimed by exactly one request and run
after its answer (`builder_claim_email_delivery_check`, a 2-minute lease). It is
refreshed on the clock and never because one send failed, since an early check
would itself say "your send failed". A check that never left the queue records
nothing: it learned nothing about the provider, and recording `degraded` would
let one tenant's burst tell every tenant delivery was broken. Nor does a check
the provider throttled (HTTP 429): every other send this deployment makes shares
that ceiling unpaced, so a throttle says the provider was busy, and anyone able
to time two sends against a stale check could otherwise make every tenant's
card read "not working" for half an hour (the second review). Its inputs have
no field through which an address, an invitation or a message could arrive, and
a spec holds it to that. The invite card shows `degraded`, `held_back`,
`delayed` and `not_configured`, and nothing otherwise, and reads again after
each invitation is recorded, so a burst shows what it caused.

## 6. The name has a ceiling

200 characters, the registration door's own. The door refuses a longer name
rather than cutting it, and counts characters rather than UTF-16 units. The
column refuses one too (`builder_memberships_invited_name_length`), and the card
caps the field.

## 7. An account is never deactivated or downgraded mid-invitation

`issueInvite` wrote `status: 'invited', is_active: false` to the account without
checking it was still unaccepted, so an account that activated between the read
and the write was deactivated.

- **The invite door now writes nothing to an account that exists.** It creates an
  account only for a new address, and everything else it writes is the seat.
- **The operator's two owner-invitation stamps** now apply only while the account
  is still an unaccepted invitation (`invited`, no password, not accepted, not
  withdrawn), and read the row count. A stamp that finds nothing refuses
  (`invite_failed` / `invite_not_issued`) rather than overwrite an account, so
  an operator's suspension of an account that never accepted is not lifted by
  the next owner invitation or by somebody applying in its name (the second
  review).
- **Acceptance activates** only while the account is still `invited`,
  unaccepted, has no password and is not withdrawn. An account an operator
  suspended before it accepted stays suspended, and the page is not offered a
  password form for it: `validate` refuses what `accept` would.

## 8. What this does not close

- **A revoked account still differs on the members list.** The database refuses
  any live seat for a withdrawn account (`builder_guard_membership`), so inviting
  one creates nothing and the list shows nothing. Every other kind now shows a
  waiting invitation under the typed name. Closing it needs an invitation record
  that is not a membership. The answer and its timing are the same.
- **With no mail provider** (production has one):
  - only a password-setting link is handed to the inviter, so the link's
    presence still separates a first invitation from a join;
  - a link the inviter holds stops working if the person starts signing in
    elsewhere, which tells the inviter so over time;
  - an established account can never be sent an invitation, because there is no
    email and its link is never handed over. Its seat waits.
- **A missing token pepper** answers 503 for every kind except a revoked account,
  which answers 200. That misconfiguration stops every invitation, so it cannot
  persist unnoticed.
- **An email waits inside the worker that answered.** If the platform recycles it
  before the email's slot, that email does not leave and has no delivery record.
  The invitation stays waiting, and inviting again re-sends it.
- **The delivery check proves the provider accepts this deployment's sends**, not
  that a given mailbox receives them. The real-inbox proof (`email-delivery-proof`)
  still waits for a mailbox.
- **The floor hides the work before the answer only while that work stays under
  1.5 s.** A database stall longer than that shows through, for every kind alike.
- **A join is one click on the emailed page.** A mail scanner that renders pages
  and presses buttons could accept one. A first invitation is safe from this
  while the person has no password, because it needs one. Requiring a signed-in session instead would
  strand the accounts with no organisation open (3 of 6 in production), who
  cannot sign in.
- **Repeats reach the person again.** Inviting or re-sending to an established
  account emails an "Accept invitation" each time, bounded by the 40/100-an-hour
  ceilings.
- **The delivery readings are coarse side channels.** `delayed` is
  deployment-wide, so an administrator who holds the queue near 30 s can watch
  other tenants' invitation activity, coarsely, never per address. `held_back`
  is the organisation's own: an administrator who fills their own share can tell
  whether one more invitation tried to send an email. That separates a revoked
  account and a person already a member here from everyone else, and the
  members list already shows both.
- **Several organisations bursting together can still fill the queue.** Each is
  held to 20 waiting sends, so it takes five at once to fill 90 s (measured:
  21, 20, 20, 20 and 10 slots, and a sixth refused). The hourly ceilings bound
  it, the refused organisations are told (`held_back`), and inviting again
  re-sends.
- **An operator-seeded owner who accepts another organisation's invitation
  first** is left with an owner link that is refused (`already_active`), and
  `invite_organisation_owner` answers 409 because the organisation already has a
  seat. This is as it was before this change (the slot token was replaced
  then), and repairing it is an operator-plane change this work leaves alone.
- **Unchanged from doc 67:** `resend` answers 409 for an account an operator
  revoked after it was seated. This is about the organisation's own member.

## 9. How it is held

- **Specs.**
  - `builderInvitationAcceptance.spec.ts`: the rule, the copy, the list, the
    invite door and the join.
  - `builderInvitationHardening.spec.ts`: the floor, pacing, the delivery
    reading, the name, per-seat tokens and the race.
  - `builderInviteJoin.spec.tsx`: the page and the hook.
  - `builderTeamInviteCard.spec.tsx`: the card.
  - `builderInviteScope`, `builderInviteOracle`, `builderOrganisationAdmin` and
    `builderSecurityHardening` were renegotiated where they pinned the old rule,
    each saying so.
- **Database.** `db:invitation-acceptance:check` rebuilds from the migrations,
  with Supabase's own default privileges in force, and proves:
  - the migration changes no existing row;
  - the token rules (CHECK, uniqueness, hex shape, kind, the trigger);
  - the name bound;
  - pacing under eight concurrent reservations, the bounded wait, one
    organisation's share, and the refusal stamp on either kind of refusal;
  - the delivery reading, and that a scope reads only its own refusals, and
    only within the window;
  - that everything is service_role only, sequences included.
- **Production.** `portal-access-proof` section L asks the live deployment, over
  disposable organisations:
  - an account that already signs in is invited, not added;
  - the invite writes nothing to the account;
  - the one-click join sets no password and issues no session;
  - per-seat tokens: a re-send replaces only its own;
  - invited by two organisations before they had an account, the person can
    accept both, and the second link joins;
  - a link handed to the inviter stops working once the person signs in, and
    inviting again mints a join the mailbox alone holds;
  - the name ceiling;
  - a concurrent burst answers alike while its emails leave at least a second
    apart;
  - the deployment-wide delivery reading;
  - a slot invitation to an account that signs in is refused.

  Section J now requires every kind to answer no sooner than the floor and in
  the same time. Sections B, I and K replay tokens onto the seat, and section I
  shows an invitation sent again carries the role chosen now.
