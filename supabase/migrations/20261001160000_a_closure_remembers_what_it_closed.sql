-- ===========================================================================
-- A closure remembers what it closed.
--
-- `close_organisation` overwrites `status` with 'closed' and keeps nothing
-- else, so `reopen_organisation` could not tell the two pending states apart.
-- A never-approved organisation is either 'pending_verification' (a
-- self-registration awaiting vetting) or 'pending_activation' (created by an
-- operator and awaiting activation). The registration migration
-- (20260914200000) gives the two different owners and different remedies.
-- Reading `activated_at` alone sent a registration closed during vetting back
-- into the operator-created queue.
--
-- The activity log already records the closure, but it is not a place to read
-- state back from. No edge function reads `builder_portal_activity_log`,
-- which `builderInviteOracle.spec.ts` pins. So the pre-closure status lives on
-- the row the closure changes, written in the same update that sets 'closed'.
--
-- WHAT CHANGES.
--   1. `builder_organisations.status_before_closure`: nullable, one of the
--      four statuses an organisation can be closed from.
--   2. `close_organisation` writes it, and `reopen_organisation` reads it and
--      clears it (builderOrganisationReopen.pure.ts decides the target).
--
-- WHAT DOES NOT CHANGE. Every existing row is NULL, including organisations
-- closed before this, because nothing recorded what they were. Reopening such
-- an organisation goes to 'pending_activation' when it was never approved.
-- That state is approved by the same act and the same gates as
-- 'pending_verification', so the fallback can misfile an organisation but
-- never admit one. The column carries no constraint tying it to
-- status = 'closed', so the legacy `builder_admin_set_organisation_status`
-- keeps working. A stale value cannot mislead: every close writes it afresh,
-- and only a closed row is ever read for it.
--
-- ROLLBACK. Drop the column after restoring the previous
-- `builder-network-admin`; nothing else reads it.
-- ===========================================================================
BEGIN;

ALTER TABLE public.builder_organisations
  ADD COLUMN IF NOT EXISTS status_before_closure text;

ALTER TABLE public.builder_organisations
  DROP CONSTRAINT IF EXISTS builder_organisations_status_before_closure_check;
ALTER TABLE public.builder_organisations
  ADD CONSTRAINT builder_organisations_status_before_closure_check
  CHECK (
    status_before_closure IS NULL
    OR status_before_closure = ANY (ARRAY[
      'pending_verification'::text,
      'pending_activation'::text,
      'active'::text,
      'suspended'::text
    ])
  );

COMMENT ON COLUMN public.builder_organisations.status_before_closure IS
  'The status this organisation held when it was last closed, written by close_organisation in the same update and cleared by reopen_organisation. NULL for an open organisation and for closures recorded before 20261001160000.';

COMMIT;
