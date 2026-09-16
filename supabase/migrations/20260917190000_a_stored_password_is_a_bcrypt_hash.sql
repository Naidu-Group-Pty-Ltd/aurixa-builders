-- ============================================================================
-- A STORED PASSWORD IS A BCRYPT HASH — THE DATABASE NOW SAYS SO
--
-- `verifyPassword` used to end with, in effect, `return password === storedHash`
-- for any value that did not look like bcrypt. It was labelled a legacy
-- plaintext migration path; there was no migration, `isLegacyPassword` had no
-- callers, and nothing anywhere prevented a non-bcrypt value from being stored.
-- Any row whose `password_hash` was not bcrypt — an import artefact, a
-- placeholder, an operator-set value — was therefore a plaintext credential
-- compared with a short-circuiting `===`.
--
-- The code half is fixed: `verifyPassword` now returns false for anything that
-- is not bcrypt. This is the other half. The code cannot see rows written by
-- anything that is not the code, so the column states the invariant itself.
--
-- Deliberately NOT destructive and NOT a behaviour change:
--
--   * NULL is still allowed, and must be. An invited user exists as a row with
--     no password until they accept; `builder-portal-invite` reads exactly that
--     (`target.invite_accepted_at || target.password_hash`) to tell a pending
--     invitation from an active account. A NOT NULL here would break invitations.
--   * Every existing row already satisfies it — verified on production before
--     writing this migration: 3 rows, 3 bcrypt-shaped, 0 otherwise. No data is
--     rewritten, deleted or re-hashed by this migration, and none can be.
--   * Every writer in this repository (`builder-portal-accept-invite`,
--     `-reset-password`, `-change-password`) stores `hashPassword()` output,
--     which is bcryptjs at cost 10 — `$2a$10$` followed by 53 characters of
--     salt and digest. The pattern below accepts precisely that family.
--
-- ADD … NOT VALID followed by VALIDATE keeps the exclusive lock to the moment
-- of definition rather than the table scan. With three rows the distinction is
-- academic; it is written this way so it stays correct when it is not.
-- ============================================================================

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.builder_portal_users'::regclass
       AND conname  = 'builder_portal_users_password_hash_is_bcrypt'
  ) THEN
    ALTER TABLE public.builder_portal_users
      ADD CONSTRAINT builder_portal_users_password_hash_is_bcrypt
      CHECK (
        password_hash IS NULL
        OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
      ) NOT VALID;

    ALTER TABLE public.builder_portal_users
      VALIDATE CONSTRAINT builder_portal_users_password_hash_is_bcrypt;
  END IF;
END
$do$;

-- ===========================================================================
-- Assertions — the constraint exists, is validated, and behaves.
--
-- The behavioural half runs inside a sub-transaction that is ALWAYS rolled
-- back: the block ends by raising a sentinel it then catches, so every row it
-- wrote disappears whether the proof passed or failed. Nothing depends on a
-- DELETE being correct, and no business data is read or written — the rows it
-- creates are its own and they do not survive it. PL/pgSQL variables are not
-- rolled back with the sub-transaction, which is what lets the verdict outlive
-- it. (Organisation membership lives in `builder_organisation_memberships`, so
-- a portal user row needs no parent to exist.)
-- ===========================================================================
DO $assert$
DECLARE
  v_validated         boolean;
  v_plaintext_refused boolean := false;
  v_bcrypt_accepted   boolean := false;
  v_null_accepted     boolean := false;
  v_probe             uuid;
BEGIN
  SELECT convalidated INTO v_validated
    FROM pg_constraint
   WHERE conrelid = 'public.builder_portal_users'::regclass
     AND conname  = 'builder_portal_users_password_hash_is_bcrypt';

  IF v_validated IS NULL THEN
    RAISE EXCEPTION 'assertion failed: the bcrypt CHECK constraint was not created';
  END IF;
  IF NOT v_validated THEN
    RAISE EXCEPTION 'assertion failed: the bcrypt CHECK constraint exists but was never validated';
  END IF;

  -- No stored password may violate it. VALIDATE would already have refused,
  -- but an operator who added the constraint by hand as NOT VALID would not.
  IF EXISTS (
    SELECT 1 FROM public.builder_portal_users
     WHERE password_hash IS NOT NULL
       AND password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
  ) THEN
    RAISE EXCEPTION 'assertion failed: a stored password_hash is not a bcrypt hash';
  END IF;

  BEGIN
    -- 1. Plaintext is refused. This is the whole point of the constraint.
    BEGIN
      INSERT INTO public.builder_portal_users(email, name, password_hash)
      VALUES ('migration-selftest-plaintext@invalid.test', 'selftest', 'hunter2');
    EXCEPTION WHEN check_violation THEN
      v_plaintext_refused := true;
    END;

    -- 2. A real bcrypt hash is accepted — every legitimate writer produces one.
    INSERT INTO public.builder_portal_users(email, name, password_hash)
    VALUES ('migration-selftest-bcrypt@invalid.test', 'selftest',
            '$2a$10$abcdefghijklmnopqrstuuKq3Z9m3vFQ2n1S8wR7pYc0dL5bXeG2.')
    RETURNING id INTO v_probe;
    v_bcrypt_accepted := true;

    -- 3. NULL is accepted — the pending-invitation shape the invite flow reads.
    INSERT INTO public.builder_portal_users(email, name, password_hash)
    VALUES ('migration-selftest-invited@invalid.test', 'selftest', NULL);
    v_null_accepted := true;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BCRYPT_CHECK_PROOF_ROLLBACK';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'BCRYPT_CHECK_PROOF_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_plaintext_refused THEN
    RAISE EXCEPTION 'assertion failed: a plaintext password_hash was accepted';
  END IF;
  IF NOT v_bcrypt_accepted THEN
    RAISE EXCEPTION 'assertion failed: a bcrypt password_hash was refused';
  END IF;
  IF NOT v_null_accepted THEN
    RAISE EXCEPTION 'assertion failed: a pending invitation (NULL password_hash) was refused';
  END IF;

  -- Nothing the proof wrote may have survived the sentinel.
  IF EXISTS (SELECT 1 FROM public.builder_portal_users WHERE id = v_probe)
     OR EXISTS (SELECT 1 FROM public.builder_portal_users
                 WHERE email LIKE 'migration-selftest-%@invalid.test') THEN
    RAISE EXCEPTION 'assertion failed: the proof left selftest rows behind';
  END IF;
END
$assert$;
