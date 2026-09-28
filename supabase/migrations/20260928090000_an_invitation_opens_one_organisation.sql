-- AN INVITATION OPENS ONE ORGANISATION.
--
-- The invite token lives on `builder_portal_users`, so it is a credential for
-- an ACCOUNT, while the things it lights up are MEMBERSHIPS of organisations.
-- Nothing reconciled the two, and the gap was a cross-organisation takeover
-- (measured 27 Sep 2026): organisation A's administrator invites an address
-- that is still a pending invitee of organisation B, the send fails so the
-- plaintext link comes back to A's administrator, and accepting it activated
-- the ACCOUNT — bringing B's membership alive too, up to `owner`.
--
-- This migration adds the two facts the rule needs. It changes no existing
-- row: every membership that is `active` today stays `active`, and nothing
-- writes the new status until the functions that know about it are deployed.
--
--  1. A membership may WAIT. `invited` is the status a grant to a not-yet
--     -active account starts in, and acceptance promotes exactly the
--     organisation whose token was accepted. The word is the one the user row
--     already uses while pending, so one vocabulary describes one state.
--
--     Nothing new enforces it: `builder_accessible_organisations` has always
--     required `status = 'active'`, so a waiting membership is invisible to
--     session issue, organisation selection and every authorisation check.
--     The gate is one that already existed and is already asserted.
--
--  2. A token REMEMBERS its organisation, so acceptance can scope on it
--     instead of inferring a scope from the account's whole membership set.
--     Null means a token minted before this rule; the acceptance function
--     honours such a token only where the account holds exactly one
--     organisation, and refuses it otherwise rather than guessing.

ALTER TABLE public.builder_organisation_memberships
  DROP CONSTRAINT IF EXISTS builder_organisation_memberships_status_check;

ALTER TABLE public.builder_organisation_memberships
  ADD CONSTRAINT builder_organisation_memberships_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'invited'::text, 'suspended'::text, 'revoked'::text]));

COMMENT ON COLUMN public.builder_organisation_memberships.status IS
  'active | invited | suspended | revoked. `invited` is a membership granted to '
  'an account that has not accepted its invitation for THIS organisation yet: '
  'builder_accessible_organisations requires `active`, so it confers nothing '
  'until builder-portal-accept-invite promotes it.';

ALTER TABLE public.builder_portal_users
  ADD COLUMN IF NOT EXISTS invite_token_organisation_id uuid
  REFERENCES public.builder_organisations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.builder_portal_users.invite_token_organisation_id IS
  'The organisation the current invite token was minted for. Acceptance may '
  'activate only this organisation''s membership. Null is a token minted before '
  '20260928090000 and is honoured only where the account holds exactly one '
  'organisation.';

CREATE INDEX IF NOT EXISTS builder_memberships_pending_idx
  ON public.builder_organisation_memberships (organisation_id)
  WHERE status = 'invited' AND revoked_at IS NULL;
