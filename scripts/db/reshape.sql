-- ===========================================================================
-- The Phase 2 reshape — the squash's edit list, EXECUTED.
--
-- Input:  a database holding the prime's builder corpus applied against the
--         network-standalone fixture (bootstrap + Part 1 services + Part 2
--         shims), exactly what npc-property-dashbord's
--         `builder:db:network-check --keep` builds.
-- Output: the Builders Network schema — the corpus end-state with every
--         entanglement settled the way docs 44/45 decided, and NOTHING of
--         the clone left. build-baseline.mjs dumps the result as the
--         network's consolidated baseline.
--
-- This file is catalog surgery rather than text surgery on 60 migration
-- files, for one reason: every edit here is ASSERTED BY EFFECT in the same
-- transaction that makes it. The sharpest of those assertions is the shim
-- drops themselves — every `DROP TABLE` below is RESTRICT (the default), so
-- a drop that succeeds IS the proof that nothing surviving still hangs off
-- the clone object. A text edit can silently miss a reference; a RESTRICT
-- drop cannot.
--
-- Section order is load-bearing: the connection graph is created FIRST
-- because E2's rewrite points builder_transactions at it, and the shims are
-- dropped LAST because the drops are the proof the earlier sections did
-- their whole job.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The connection graph (plan §2) — the network's own new schema.
--
-- A workspace is Mission Control's clones.id; trust is the Phase 1 assertion
-- verified offline against MC's JWKS. Connections are ACCESS CONTROL, never
-- agreement formation: scopes are unilateral, revocable grants, no signature
-- ceremony, no execution record beyond the audit trail — the prime deleted
-- agreement facilitation on purpose and it must not be rebuilt here under
-- another name.
--
-- RLS is enabled with NO policies on every table in this section: the
-- network's browser holds no Supabase credential at all (the /fn/* proxy
-- injects the anon key server-side), so a closed table is the correct and
-- only intended state. Every read and write is an edge function holding the
-- service role.
-- ===========================================================================

-- The MC directory cache. A row here says "Mission Control has vouched for
-- this workspace at least once"; the authoritative directory stays MC's.
CREATE TABLE public.workspace_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Mission Control's clones.id — THE workspace identity. Slugs rename;
  -- project refs change on handoff; this does not.
  mc_clone_id uuid NOT NULL UNIQUE,
  slug text NOT NULL,
  display_name text,
  -- What the last verified assertion carried, kept so an operator can see
  -- staleness rather than trust a cache silently.
  last_asserted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One organisation ↔ one workspace edge. `none` is not a row; `revoked` is
-- terminal and re-connection is a NEW row — the partnerAccess shape,
-- re-created here as the plan requires because the module that carried it
-- was deleted from the prime and cannot be imported.
CREATE TABLE public.workspace_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace_registry(id) ON DELETE RESTRICT,
  builder_organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'invited'
    CHECK (state IN ('invited', 'active', 'revoked')),
  -- Who started it: both onboarding paths are real (workspace-initiated
  -- invite, builder-initiated application).
  initiated_by text NOT NULL CHECK (initiated_by IN ('workspace', 'builder')),
  -- The invite code travels hashed, exactly like every one-time credential
  -- in the estate. A live link can never be re-read.
  invite_code_hash text,
  invite_expires_at timestamptz,
  -- Network → clone deliveries are HMAC-SHA256 over the raw body with a
  -- per-connection secret the CLONE minted at connection time. The network
  -- must hold it in usable form to SIGN with it — it is a symmetric secret,
  -- not a verifier — which is why this table is RLS-closed with no policy
  -- and why nothing readable is ever granted on it.
  outbound_hmac_secret text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Terminal means terminal.
  CHECK (state <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (state <> 'active' OR accepted_at IS NOT NULL)
);

-- One LIVE edge per (workspace, organisation); history accumulates as
-- revoked rows beside it.
CREATE UNIQUE INDEX workspace_connections_live_key
  ON public.workspace_connections (workspace_id, builder_organisation_id)
  WHERE state <> 'revoked';
CREATE INDEX workspace_connections_org_idx
  ON public.workspace_connections (builder_organisation_id, state);

-- The scope vocabulary, seeded and closed. A scope is DIRECTIONAL: it says
-- which side's data crosses, which is what makes a grant a disclosure
-- decision rather than a feature flag.
CREATE TABLE public.connection_scope_keys (
  key text PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('workspace_to_builder', 'builder_to_workspace')),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.connection_scope_keys (key, direction, description) VALUES
  ('transactions:share',      'builder_to_workspace', 'Transaction and reservation state for this connection''s dealings flows to the workspace.'),
  ('stock:publish',           'builder_to_workspace', 'Published stock items and their imagery are visible to the workspace''s marketplace.'),
  ('construction:share',      'builder_to_workspace', 'Construction case progress for this connection''s builds flows to the workspace.'),
  ('collaboration:messages',  'workspace_to_builder', 'The workspace may open and continue conversations with the organisation.'),
  ('delivery:handover',       'builder_to_workspace', 'Handover and practical-completion state flows to the workspace.'),
  ('documents:share',         'builder_to_workspace', 'Documents the organisation explicitly grants travel to the workspace.'),
  ('aml:reliance',            'workspace_to_builder', 'The workspace''s Compliance Passport surface may be served to this organisation''s portal users.');

-- A grant is a ROW, not an array entry, deliberately deviating from the
-- plan's `scopes[]` sketch: a foreign key is a vocabulary check the database
-- enforces on every write, where an array accepts any misspelling silently —
-- and a misspelled scope is an access decision that quietly never applies.
-- The shadow ledger on Mission Control keeps its display-only text[].
CREATE TABLE public.connection_scope_grants (
  connection_id uuid NOT NULL REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  scope_key text NOT NULL REFERENCES public.connection_scope_keys(key),
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- The side that RISKS data grants the scope; the other side cannot grant
  -- disclosure of somebody else's records.
  granted_by_side text NOT NULL CHECK (granted_by_side IN ('workspace', 'builder')),
  PRIMARY KEY (connection_id, scope_key)
);

-- Append-only. Connection rows are never deleted (revoked is terminal), so
-- NO ACTION is an assertion, not a convenience: history outlives nothing
-- because nothing it references can go.
CREATE TABLE public.workspace_connection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.workspace_connections(id),
  event_type text NOT NULL,
  actor_side text NOT NULL CHECK (actor_side IN ('workspace', 'builder', 'platform')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_connection_events_connection_idx
  ON public.workspace_connection_events (connection_id, created_at);

ALTER TABLE public.workspace_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_scope_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_scope_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_connection_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF (SELECT count(*) FROM public.connection_scope_keys) <> 7 THEN
    RAISE EXCEPTION 'scope vocabulary must hold exactly the seven planned keys';
  END IF;
END $$;

-- ===========================================================================
-- 2. E2 — builder_transactions.client_id becomes the connection pair.
--
-- A client is the WORKSPACE's record. What the network holds is (which
-- connection, which opaque per-connection reference) — a stored random uuid
-- the workspace minted, never derived, because a derived ref is a
-- cross-vendor correlation handle. All three columns nullable: unsold
-- inventory and direct-to-public sales exist, and `connection_id NOT NULL`
-- would invent counterparties.
-- ===========================================================================

ALTER TABLE public.builder_transactions DROP COLUMN client_id;
ALTER TABLE public.builder_transactions
  ADD COLUMN connection_id uuid REFERENCES public.workspace_connections(id) ON DELETE RESTRICT,
  ADD COLUMN remote_client_ref uuid,
  ADD COLUMN remote_client_label text,
  ADD CONSTRAINT builder_transactions_connection_pair
    CHECK ((connection_id IS NULL) = (remote_client_ref IS NULL));
CREATE INDEX builder_transactions_connection_idx
  ON public.builder_transactions (connection_id) WHERE connection_id IS NOT NULL;

-- ===========================================================================
-- 3. E3 — the stock marketplace split.
--
-- builder_stock_selections was ALWAYS Command Centre data (client_id,
-- selected_by_user_id, internal_notes) and stays in the clone, re-pointed at
-- the clone-side mirror. The network gets what the split gives each side:
-- publications (what this organisation shows to which workspace) and
-- selection ANNOUNCEMENTS — the fact of a selection, carrying an opaque
-- reference and at most a label, never a client id and never internal notes.
-- ===========================================================================

-- Selection-specific trigger machinery goes with its table; the shared touch
-- function (builder_stock_touch_updated_at) serves other stock tables and
-- stays.
DROP TABLE public.builder_stock_selections;
DROP FUNCTION public.builder_enforce_stock_selection_org();

CREATE TABLE public.builder_stock_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_item_id uuid NOT NULL REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  -- Denormalised BY THE SERVER at publish time, the selections table's own
  -- trick: an org check must not depend on a join through a mutable row.
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  published_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One LIVE publication per (item, connection); withdrawals accumulate.
CREATE UNIQUE INDEX builder_stock_publications_live_key
  ON public.builder_stock_publications (stock_item_id, connection_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX builder_stock_publications_connection_idx
  ON public.builder_stock_publications (connection_id) WHERE withdrawn_at IS NULL;
CREATE TRIGGER trg_builder_stock_publications_touch
  BEFORE UPDATE ON public.builder_stock_publications
  FOR EACH ROW EXECUTE FUNCTION public.builder_stock_touch_updated_at();

CREATE TABLE public.builder_stock_selection_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.workspace_connections(id) ON DELETE RESTRICT,
  stock_item_id uuid NOT NULL REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  -- The clone's selection id, opaque here. What the builder may know about
  -- WHO is a label the workspace chose to send — no client_id and no
  -- internal_notes exist in this table by design, and the privacy contract
  -- on the inbound path throws rather than filters if either ever arrives.
  remote_selection_ref uuid NOT NULL,
  remote_client_label text,
  status text NOT NULL DEFAULT 'selected'
    CHECK (status IN ('selected', 'builder_acknowledged', 'progressed', 'completed', 'withdrawn')),
  acknowledged_at timestamptz,
  acknowledged_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, remote_selection_ref)
);
CREATE INDEX builder_stock_selection_announcements_org_idx
  ON public.builder_stock_selection_announcements (organisation_id, status);
CREATE TRIGGER trg_builder_stock_selection_announcements_touch
  BEFORE UPDATE ON public.builder_stock_selection_announcements
  FOR EACH ROW EXECUTE FUNCTION public.builder_stock_touch_updated_at();

ALTER TABLE public.builder_stock_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_stock_selection_announcements ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 4. The document queue becomes builder-only.
--
-- The queue TRAVELS (doc 44: its builder FK is internal to the network after
-- Phase 2); the solicitor slot and the solicitor document store do not. The
-- `portal` column is deliberately KEPT, constrained to its one remaining
-- value: claim_builder_document_processing_jobs and
-- complete_builder_document_processing filter on it, and rewriting two
-- SECURITY DEFINER functions to save one column is churn with no safety
-- gain. The solicitor-shaped claim function was fixture scaffolding and goes
-- with its tables.
-- ===========================================================================

ALTER TABLE public.document_processing_jobs
  DROP CONSTRAINT document_processing_jobs_owner_agree;
ALTER TABLE public.document_processing_jobs DROP COLUMN document_version_id;
ALTER TABLE public.document_processing_jobs
  ALTER COLUMN builder_document_version_id SET NOT NULL,
  ALTER COLUMN portal SET DEFAULT 'builder';
ALTER TABLE public.document_processing_jobs
  DROP CONSTRAINT document_processing_jobs_portal_check;
ALTER TABLE public.document_processing_jobs
  ADD CONSTRAINT document_processing_jobs_portal_check CHECK (portal = 'builder');

DROP FUNCTION public.claim_document_processing_jobs(text, integer);
DROP TABLE public.document_versions;
DROP TABLE public.document_records;

-- ===========================================================================
-- 5. E5 — terms become the network's own.
--
-- Renamed to what they now are, the solicitor column gone (the network never
-- holds another portal's consent record — MIG-01's one-way drop stays in the
-- CLONE), builder_user_id NOT NULL with the FK the fixture could not declare
-- (it runs before Phase 1 creates builder_portal_users; its own header says
-- the squash restores it — this is that restoration). `portal` stays as a
-- single-value CHECK for the same reason the queue's does.
-- ===========================================================================

ALTER TABLE public.portal_terms_acceptances
  DROP CONSTRAINT portal_terms_acceptances_check;
ALTER TABLE public.portal_terms_acceptances DROP COLUMN solicitor_user_id;
ALTER TABLE public.portal_terms_acceptances
  ALTER COLUMN builder_user_id SET NOT NULL,
  ADD CONSTRAINT builder_terms_acceptances_user_fk
    FOREIGN KEY (builder_user_id) REFERENCES public.builder_portal_users(id) ON DELETE CASCADE;

ALTER TABLE public.portal_terms_versions RENAME TO builder_terms_versions;
ALTER TABLE public.portal_terms_acceptances RENAME TO builder_terms_acceptances;

ALTER TABLE public.builder_terms_versions
  DROP CONSTRAINT portal_terms_versions_portal_check;
ALTER TABLE public.builder_terms_versions
  ALTER COLUMN portal SET DEFAULT 'builder',
  ADD CONSTRAINT builder_terms_versions_portal_check CHECK (portal = 'builder');
ALTER TABLE public.builder_terms_acceptances
  DROP CONSTRAINT portal_terms_acceptances_portal_check;
ALTER TABLE public.builder_terms_acceptances
  ALTER COLUMN portal SET DEFAULT 'builder',
  ADD CONSTRAINT builder_terms_acceptances_portal_check CHECK (portal = 'builder');

-- The one surviving function that names the old tables, re-stated verbatim
-- with the new names. Everything else about it — the session-ownership
-- check, the alias workarounds for its OUT-column names, the bare ON
-- CONFLICT — is unchanged on purpose; each carries its own comment
-- explaining a defect it prevents.
CREATE OR REPLACE FUNCTION public.builder_accept_current_terms(
  _builder_user_id uuid, _session_id uuid,
  _ip_hash text DEFAULT NULL::text, _user_agent_hash text DEFAULT NULL::text)
RETURNS TABLE(terms_version_id uuid, version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_terms record;
BEGIN
  -- Session ownership, the same check builder_select_session_organisation
  -- performs below. Without it the function trusts whatever pair of ids it is
  -- handed, so a caller holding one valid session could record an acceptance
  -- against another user, or a revoked session could still write one.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_portal_sessions
    WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_NOT_FOUND';
  END IF;

  -- Aliased deliberately: this function's OUT column is also called `version`,
  -- so selecting the column under its own name makes the reference ambiguous
  -- and the function fails at runtime for every caller.
  SELECT btv.id AS terms_id, btv.version AS terms_version INTO v_terms
  FROM public.builder_terms_versions btv
  WHERE btv.portal = 'builder' AND btv.retired_at IS NULL AND btv.effective_at <= now()
  ORDER BY btv.effective_at DESC LIMIT 1;

  IF v_terms.terms_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TERMS_UNAVAILABLE';
  END IF;

  -- builder_terms_acceptances carries the ownership constraints: the owner
  -- column is NOT NULL with a real FK, and the portal is single-valued. A
  -- user therefore cannot accept on another user's or another portal's
  -- behalf.
  -- Bare `ON CONFLICT DO NOTHING` rather than a column inference list: this
  -- function's OUT column is also called `terms_version_id`, and an inference
  -- list is an expression context where plpgsql resolves that name to the OUT
  -- variable, making the reference ambiguous and failing at runtime. Only one
  -- row is inserted, so "any unique violation" is the same conflict either way.
  INSERT INTO public.builder_terms_acceptances(
    terms_version_id, portal, builder_user_id, ip_hash, user_agent_hash)
  VALUES (v_terms.terms_id, 'builder', _builder_user_id, _ip_hash, _user_agent_hash)
  ON CONFLICT DO NOTHING;

  UPDATE public.builder_portal_users
  SET has_accepted_current_terms = true, terms_accepted_at = now()
  WHERE id = _builder_user_id;

  PERFORM public.builder_log_activity(
    NULL, 'builder_user', 'builder_terms_accepted',
    'portal_user', _builder_user_id, NULL, _builder_user_id,
    NULL, jsonb_build_object('terms_version_id', v_terms.terms_id, 'version', v_terms.terms_version),
    NULL, jsonb_build_object('session_id', _session_id));

  terms_version_id := v_terms.terms_id;
  version := v_terms.terms_version;
  RETURN NEXT;
END $function$;

-- ===========================================================================
-- 6. E1 — the transaction-case machinery is the CLONE's.
--
-- The fourth case-link slot and the widened guard stay in the clone,
-- re-pointed at the clone-side mirror; the network never holds a case.
-- These functions read or write the case spine and go before their tables:
-- a plpgsql body is not dependency-tracked, so the RESTRICT drops below
-- would not catch a survivor — the pg_proc source sweep in section 9 is
-- what proves this list was complete.
-- ===========================================================================

DROP FUNCTION public.builder_link_transaction_to_case(uuid, text, uuid, uuid, uuid, text);
DROP FUNCTION public.builder_unlink_transaction_from_case(uuid, text, uuid, uuid, text);
DROP FUNCTION public.builder_set_transaction_client(uuid, text, uuid, uuid, uuid, bigint, text);

-- ===========================================================================
-- 7. E6 — the release-control plane does not travel.
--
-- A central platform does not need per-organisation portal rollout:
-- builder_organisations.status covers what the flag gated. Branches are
-- deleted, not migrated.
-- ===========================================================================

-- Signatures taken from pg_get_function_identity_arguments against the
-- built corpus, because a guessed signature under IF EXISTS is a drop that
-- silently never happens — the sweep in section 10 caught exactly that on
-- the first run of this file.
DROP FUNCTION public.get_builder_cutover_readiness(uuid, text);
DROP FUNCTION public.set_cross_portal_rollout_for(text, uuid, text, text, text, uuid, text, bigint);
DROP FUNCTION public.record_cross_portal_approval_for(text, uuid, text, text, text, uuid, text);
DROP FUNCTION public.revoke_cross_portal_approval_for(text, uuid, text, text, text, uuid, text);
DROP FUNCTION public.resolve_cross_portal_feature_mode(uuid, text);

-- ===========================================================================
-- 8. The shims go — and each RESTRICT drop is an assertion.
-- ===========================================================================

DROP TABLE public.transaction_case_links;
-- The guard is trigger-attached, and a trigger IS dependency-tracked — so
-- unlike the body-only helpers above, this drop must FOLLOW its table, and
-- its earlier position failed exactly as RESTRICT promises.
DROP FUNCTION public.guard_transaction_case_links();
DROP TABLE public.transaction_case_link_history;
DROP TABLE public.transaction_cases;
DROP TABLE public.purchase_files;
DROP TABLE public.legal_matters;
DROP TABLE public.client_deals;
DROP TABLE public.clients;

DROP TABLE public.cross_portal_firm_rollouts;
-- Trigger-attached, same rule as the guard above.
DROP FUNCTION IF EXISTS public.bump_cross_portal_rollout_version();
DROP TABLE public.cross_portal_rollout_history;
DROP TABLE public.cross_portal_dual_read_comparisons;
DROP TABLE public.cross_portal_cutover_approvals;
DROP TABLE public.cross_portal_reconciliation_runs;
DROP TABLE public.cross_portal_feature_definitions;

DROP TABLE public.user_permissions;
DROP TABLE public.dashboard_modules;
DROP TABLE public.custom_users;

-- ===========================================================================
-- 9. The network owns its buckets, its flags stay unseeded, and every table
--    is closed.
-- ===========================================================================

-- builder-documents was never created by a builder-named migration in the
-- prime (the boundary lesson, again — its bucket predates the corpus there).
-- The network creates all three for itself. Private, 25 MB, per the contract
-- in _shared/builderDocuments.ts.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('builder-documents', 'builder-documents', false, 26214400)
ON CONFLICT (id) DO NOTHING;

-- builder_stock_marketplace is the CLONE's flag — it gates the clone-side
-- marketplace surface and the clone keeps it (the fixture's own comment says
-- so). A copy here would be a switch wired to nothing: somebody flips it in
-- the network one day and nothing changes, which is configuration asserting
-- what no effect delivers. The network starts with an EMPTY flag table.
DELETE FROM public.feature_flags WHERE key = 'builder_stock_marketplace';

-- The harness bootstrap stands in for pgcrypto with five public functions
-- (digest x2, gen_random_bytes, crypt, gen_salt) so a raw corpus replay has
-- something to bind to. Nothing in the corpus calls any of them, and a FAKE
-- crypt() shipped in the baseline would shadow the platform's real pgcrypto
-- via search_path on a hosted project — a landmine, not a convenience. The
-- RESTRICT drops double as the proof nothing came to depend on them.
DROP FUNCTION public.digest(text, text);
DROP FUNCTION public.digest(bytea, text);
DROP FUNCTION public.gen_random_bytes(integer);
DROP FUNCTION public.crypt(text, text);
DROP FUNCTION public.gen_salt(text);

-- RLS everywhere. The Part 1 services arrived from the fixture without it;
-- in the network every public table is service-role-only until a policy
-- deliberately opens it, and section 10 asserts the EVERYWHERE.
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_operational_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_operational_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_processing_jobs ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 10. Prove it, in the same transaction.
-- ===========================================================================

DO $$
DECLARE
  bad text;
  n integer;
BEGIN
  -- No shim relation survives, under any name.
  SELECT string_agg(relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v')
    AND c.relname IN (
      'clients','client_deals','legal_matters','purchase_files',
      'transaction_cases','transaction_case_links','transaction_case_link_history',
      'dashboard_modules','custom_users','user_permissions',
      'document_records','document_versions',
      'portal_terms_versions','portal_terms_acceptances',
      'builder_stock_selections')
    OR (ns.nspname = 'public' AND c.relname LIKE 'cross\_portal\_%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'shim relations survive the reshape: %', bad;
  END IF;

  -- No surviving function's source names a clone object. This is the sweep
  -- that catches what RESTRICT cannot: plpgsql bodies are not
  -- dependency-tracked.
  SELECT string_agg(p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosrc ~* '\m(clients|client_deals|legal_matters|purchase_files|transaction_cases|transaction_case_links|transaction_case_link_history|dashboard_modules|custom_users|user_permissions|document_records|document_versions|portal_terms_versions|portal_terms_acceptances|builder_stock_selections|cross_portal_[a-z_]+)\M';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'surviving functions still name clone objects: %', bad;
  END IF;

  -- Every foreign key lands inside the network's own schema.
  SELECT string_agg(DISTINCT c.confrelid::regclass::text, ', ') INTO bad
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
  WHERE c.contype = 'f' AND ns.nspname = 'public'
    AND c.confrelid::regclass::text !~ '^(public\.)?(builder_|workspace_|connection_|feature_flags|portal_operational_|integration_|document_processing_jobs)'
    AND c.confrelid <> 'storage.buckets'::regclass;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a foreign key still leaves the network: %', bad;
  END IF;

  -- Every public table is RLS-enabled.
  SELECT string_agg(relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tables without row level security: %', bad;
  END IF;

  -- The corpus's builder tables all made it: 64 arrived, selections left,
  -- and the reshape added its own. Count the builder_* family exactly.
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'builder\_%';
  -- 63 corpus base tables (the 64th relation is the scan-health VIEW),
  -- minus selections, plus publications, announcements and the two renamed
  -- terms tables.
  IF n <> 66 THEN
    RAISE EXCEPTION 'expected 66 builder_%% tables after the reshape, found %', n;
  END IF;

  RAISE NOTICE 'reshape assertions passed: % builder tables, boundary closed, RLS everywhere', n;
END $$;

COMMIT;
