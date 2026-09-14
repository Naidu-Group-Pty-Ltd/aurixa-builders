-- Builder / Developer Portal — Collaboration: documents and their versions,
-- document permissions, conversations and messages, tasks and assignments with
-- due dates, and notifications with unread counts.
--
-- Additive only. Every earlier Builder object is reused unchanged.
--
-- Blueprint:
--   These four are the PORTAL-WIDE collaboration surfaces. Unlike inventory,
--   transactions, construction and delivery — each of which hangs off one
--   parent aggregate — a document, conversation, task or notification may be
--   attached to ANY Builder aggregate. So each row carries a discriminated
--   (scope_type, scope_id) pair, and ONE resolver
--   (`builder_resolve_scope_permission`) dispatches to the resolver that
--   already governs that aggregate. There is still no new access table.
--
--     document_records / document_access_grants  -> builder_documents
--                                                   builder_document_versions
--                                                   builder_document_grants
--     conversations / conversation_participants  -> builder_conversations
--                                                   builder_conversation_participants
--                                                   builder_messages
--     case_tasks / case_task_assignments         -> builder_tasks
--                                                   builder_task_assignments
--
-- DATA BOUNDARY: none of these tables carries money, a client financial
-- position, an AML determination or a privileged legal field. A document is
-- metadata plus a storage path that never leaves the server; a message is text
-- between Builder users; a task is work; a notification is a pointer.

-- ===========================================================================
-- 0. Prerequisites
-- ===========================================================================
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access',
     'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
     'reservation', 'allocation',
     'transaction', 'transaction_party', 'transaction_case_link',
     'construction_case', 'construction_stage', 'milestone',
     'progress_update', 'photograph',
     'variation', 'variation_approval', 'progress_claim',
     'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
     'document', 'document_version', 'document_grant',
     'conversation', 'message', 'task', 'task_assignment', 'notification'));

-- Every collaboration row names the aggregate it belongs to. The scope list is
-- closed: a value outside it cannot be resolved and is refused at write time.
CREATE OR REPLACE FUNCTION public.builder_scope_exists(_scope_type text, _scope_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN CASE _scope_type
    WHEN 'project' THEN EXISTS (SELECT 1 FROM public.builder_projects WHERE id = _scope_id)
    WHEN 'unit' THEN EXISTS (SELECT 1 FROM public.builder_units WHERE id = _scope_id)
    WHEN 'transaction' THEN EXISTS (SELECT 1 FROM public.builder_transactions WHERE id = _scope_id)
    WHEN 'construction_case' THEN
      EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _scope_id)
    ELSE false
  END;
END $$;

/**
 * ONE resolver for every collaboration row. It dispatches to the resolver that
 * already governs the named aggregate, so a document attached to a transaction
 * is exactly as reachable as that transaction — no more, no less. There is no
 * separate collaboration grant a caller could aim at.
 */
CREATE OR REPLACE FUNCTION public.builder_resolve_scope_permission(
  _user_id uuid, _scope_type text, _scope_id uuid,
  _permission_key text DEFAULT 'documents', _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN CASE _scope_type
    WHEN 'project' THEN
      public.builder_resolve_project_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'unit' THEN
      public.builder_resolve_unit_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'transaction' THEN
      public.builder_resolve_transaction_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'construction_case' THEN
      public.builder_resolve_construction_permission(_user_id, _scope_id, _permission_key, _level)
    ELSE false
  END;
END $$;

CREATE OR REPLACE FUNCTION public.builder_enforce_collaboration_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT public.builder_scope_exists(NEW.scope_type, NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
      DETAIL=format('%s %s does not exist', NEW.scope_type, NEW.scope_id);
  END IF;
  RETURN NEW;
END $$;

-- The organisation that owns a scoped row, resolved server-side for the audit.
CREATE OR REPLACE FUNCTION public.builder_scope_org(_scope_type text, _scope_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  IF _scope_type = 'project' THEN
    SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
    FROM public.builder_projects WHERE id = _scope_id;
  ELSIF _scope_type = 'unit' THEN
    SELECT COALESCE(p.developer_organisation_id, p.builder_organisation_id) INTO v_org
    FROM public.builder_units u JOIN public.builder_projects p ON p.id = u.project_id
    WHERE u.id = _scope_id;
  ELSIF _scope_type = 'transaction' THEN
    SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = _scope_id;
  ELSIF _scope_type = 'construction_case' THEN
    SELECT t.organisation_id INTO v_org
    FROM public.builder_construction_cases c
    JOIN public.builder_transactions t ON t.id = c.transaction_id
    WHERE c.id = _scope_id;
  END IF;
  RETURN v_org;
END $$;

-- ===========================================================================
-- 1. Documents, versions and permissions
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('project','unit','transaction','construction_case')),
  scope_id uuid NOT NULL,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  document_type text NOT NULL DEFAULT 'other'
    CHECK (document_type IN ('contract','plan','specification','permit','certificate',
                             'variation','claim','inspection_report','defect_report',
                             'handover_pack','warranty','photo','other')),
  -- The CURRENT version. Every version's bytes live in storage; this table
  -- never holds a public URL.
  current_version_id uuid,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','archived','withdrawn')),
  is_customer_visible boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_documents_scope_idx
  ON public.builder_documents(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS builder_documents_org_idx ON public.builder_documents(organisation_id);

COMMENT ON TABLE public.builder_documents IS
  'Builder document metadata. The storage path lives on the version row and is never a public URL; it is handed out only by a function that has already resolved the caller''s permission.';

CREATE TABLE IF NOT EXISTS public.builder_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.builder_documents(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  storage_path text NOT NULL CHECK (length(btrim(storage_path)) > 0),
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  content_type text NOT NULL DEFAULT 'application/pdf',
  byte_size bigint CHECK (byte_size IS NULL OR byte_size > 0),
  checksum text,
  change_note text,
  uploaded_by_type text NOT NULL DEFAULT 'builder_user'
    CHECK (uploaded_by_type IN ('builder_user','command_user','service_role','system')),
  uploaded_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  uploaded_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number)
);
CREATE INDEX IF NOT EXISTS builder_document_versions_doc_idx
  ON public.builder_document_versions(document_id, version_number DESC);

-- A version is immutable once written: a document's history is its audit trail.
CREATE OR REPLACE FUNCTION public.builder_document_versions_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_VERSION_IMMUTABLE',
    DETAIL='document versions cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_document_versions_immutable ON public.builder_document_versions;
CREATE TRIGGER trg_builder_document_versions_immutable
  BEFORE UPDATE OR DELETE ON public.builder_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.builder_document_versions_immutable();

/**
 * A document permission. This does NOT widen access: the scope resolver is
 * still consulted first and a grant cannot open a document whose scope the
 * caller cannot reach. A grant only ever NARROWS — it marks a document as
 * restricted to the named users.
 */
CREATE TABLE IF NOT EXISTS public.builder_document_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.builder_documents(id) ON DELETE CASCADE,
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  can_download boolean NOT NULL DEFAULT true,
  granted_by_user_id uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, builder_user_id)
);
CREATE INDEX IF NOT EXISTS builder_document_grants_doc_idx
  ON public.builder_document_grants(document_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.builder_document_grants IS
  'A restriction, not a widening. The scope resolver is consulted first; a grant can only narrow a document to the named users.';

/**
 * Can this user see this document?
 *
 * 1. The scope resolver must allow it. This is the hard gate: it walks the
 *    aggregate's own chain, which already includes the active-membership check.
 * 2. If the document has ANY live grant, the user must hold one. A document
 *    with no grants is visible to everyone who passes step 1.
 */
CREATE OR REPLACE FUNCTION public.builder_can_see_document(
  _user_id uuid, _document_id uuid, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.builder_documents; v_restricted boolean;
BEGIN
  SELECT * INTO d FROM public.builder_documents WHERE id = _document_id;
  IF d.id IS NULL THEN RETURN false; END IF;

  IF NOT public.builder_resolve_scope_permission(
       _user_id, d.scope_type, d.scope_id, 'documents', _level) THEN
    RETURN false;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.builder_document_grants
                 WHERE document_id = _document_id AND revoked_at IS NULL)
  INTO v_restricted;
  IF NOT v_restricted THEN RETURN true; END IF;

  RETURN EXISTS (SELECT 1 FROM public.builder_document_grants
                 WHERE document_id = _document_id AND builder_user_id = _user_id
                   AND revoked_at IS NULL);
END $$;

-- ===========================================================================
-- 2. Conversations and messages
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('project','unit','transaction','construction_case')),
  scope_id uuid NOT NULL,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  last_message_at timestamptz,
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_conversations_scope_idx
  ON public.builder_conversations(scope_type, scope_id, status);

CREATE TABLE IF NOT EXISTS public.builder_conversation_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.builder_conversations(id) ON DELETE CASCADE,
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  -- The read watermark. Unread counts are derived from it, never stored.
  last_read_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, builder_user_id)
);
CREATE INDEX IF NOT EXISTS builder_conversation_participants_user_idx
  ON public.builder_conversation_participants(builder_user_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS public.builder_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.builder_conversations(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  author_type text NOT NULL DEFAULT 'builder_user'
    CHECK (author_type IN ('builder_user','command_user','service_role','system')),
  author_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  author_user_id uuid,
  author_display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_messages_conversation_idx
  ON public.builder_messages(conversation_id, created_at DESC);

-- A message is immutable. Editing history would defeat the record.
CREATE OR REPLACE FUNCTION public.builder_messages_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MESSAGE_IMMUTABLE',
    DETAIL='messages cannot be edited or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_messages_immutable ON public.builder_messages;
CREATE TRIGGER trg_builder_messages_immutable
  BEFORE UPDATE OR DELETE ON public.builder_messages
  FOR EACH ROW EXECUTE FUNCTION public.builder_messages_immutable();

/**
 * Can this user see this conversation?
 *
 * The scope resolver is the hard gate, exactly as for documents. Participation
 * then narrows: a conversation with participants is visible only to them.
 */
CREATE OR REPLACE FUNCTION public.builder_can_see_conversation(
  _user_id uuid, _conversation_id uuid, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.builder_conversations; v_has_participants boolean;
BEGIN
  SELECT * INTO c FROM public.builder_conversations WHERE id = _conversation_id;
  IF c.id IS NULL THEN RETURN false; END IF;

  IF NOT public.builder_resolve_scope_permission(
       _user_id, c.scope_type, c.scope_id, 'messages', _level) THEN
    RETURN false;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.builder_conversation_participants
                 WHERE conversation_id = _conversation_id AND left_at IS NULL)
  INTO v_has_participants;
  IF NOT v_has_participants THEN RETURN true; END IF;

  RETURN EXISTS (SELECT 1 FROM public.builder_conversation_participants
                 WHERE conversation_id = _conversation_id AND builder_user_id = _user_id
                   AND left_at IS NULL);
END $$;

-- ===========================================================================
-- 3. Tasks and assignments
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('project','unit','transaction','construction_case')),
  scope_id uuid NOT NULL,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  due_date date,
  completed_at timestamptz,
  created_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_tasks_scope_idx
  ON public.builder_tasks(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS builder_tasks_due_idx
  ON public.builder_tasks(due_date) WHERE due_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.builder_task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.builder_tasks(id) ON DELETE CASCADE,
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  unassigned_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, builder_user_id)
);
CREATE INDEX IF NOT EXISTS builder_task_assignments_user_idx
  ON public.builder_task_assignments(builder_user_id) WHERE unassigned_at IS NULL;

-- ===========================================================================
-- 4. Notifications
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  notification_type text NOT NULL DEFAULT 'general'
    CHECK (notification_type IN ('general','task_assigned','task_due','message',
                                 'defect_raised','inspection_scheduled','status_change',
                                 'document_added','variation_decision')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  body text,
  -- A POINTER to the thing that happened. The notification carries no copy of
  -- the record's contents, so a stale notification cannot leak a withdrawn one.
  scope_type text CHECK (scope_type IS NULL OR
    scope_type IN ('project','unit','transaction','construction_case')),
  scope_id uuid,
  entity_kind text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_notifications_user_idx
  ON public.builder_notifications(builder_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_notifications_unread_idx
  ON public.builder_notifications(builder_user_id) WHERE read_at IS NULL;

COMMENT ON TABLE public.builder_notifications IS
  'A pointer to something that happened. Carries no copy of the record, so a stale notification cannot leak content the reader may no longer see.';

-- Scope guards on every collaboration table that carries one.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_documents','builder_conversations','builder_tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_scope ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_scope BEFORE INSERT OR UPDATE OF scope_type, scope_id
                    ON public.%I FOR EACH ROW
                    EXECUTE FUNCTION public.builder_enforce_collaboration_scope()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 5. Accessible-set and unread-count functions
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_accessible_documents(
  _user_id uuid, _scope_type text DEFAULT NULL, _scope_id uuid DEFAULT NULL)
RETURNS TABLE (document_id uuid, scope_type text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.scope_type, d.scope_id
  FROM public.builder_documents d
  WHERE (_scope_type IS NULL OR d.scope_type = _scope_type)
    AND (_scope_id IS NULL OR d.scope_id = _scope_id)
    AND public.builder_can_see_document(_user_id, d.id, 'view');
$$;

CREATE OR REPLACE FUNCTION public.builder_accessible_conversations(
  _user_id uuid, _scope_type text DEFAULT NULL, _scope_id uuid DEFAULT NULL)
RETURNS TABLE (conversation_id uuid, scope_type text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.scope_type, c.scope_id
  FROM public.builder_conversations c
  WHERE (_scope_type IS NULL OR c.scope_type = _scope_type)
    AND (_scope_id IS NULL OR c.scope_id = _scope_id)
    AND public.builder_can_see_conversation(_user_id, c.id, 'view');
$$;

CREATE OR REPLACE FUNCTION public.builder_accessible_tasks(
  _user_id uuid, _scope_type text DEFAULT NULL, _scope_id uuid DEFAULT NULL)
RETURNS TABLE (task_id uuid, scope_type text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.scope_type, t.scope_id
  FROM public.builder_tasks t
  WHERE (_scope_type IS NULL OR t.scope_type = _scope_type)
    AND (_scope_id IS NULL OR t.scope_id = _scope_id)
    AND public.builder_resolve_scope_permission(_user_id, t.scope_type, t.scope_id, 'tasks', 'view');
$$;

/**
 * Unread counts, derived rather than stored.
 *
 * A conversation is unread when it has a message after the participant's
 * watermark; a notification is unread when read_at is null. Both are filtered
 * through the same resolvers that govern the records themselves, so a count can
 * never reveal a conversation the caller may not open.
 */
CREATE OR REPLACE FUNCTION public.builder_unread_counts(_user_id uuid)
RETURNS TABLE (unread_messages bigint, unread_notifications bigint, overdue_tasks bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*) FROM public.builder_conversation_participants p
     JOIN public.builder_conversations c ON c.id = p.conversation_id
     WHERE p.builder_user_id = _user_id AND p.left_at IS NULL
       AND c.last_message_at IS NOT NULL
       AND (p.last_read_at IS NULL OR c.last_message_at > p.last_read_at)
       AND public.builder_can_see_conversation(_user_id, c.id, 'view')),
    (SELECT count(*) FROM public.builder_notifications n
     WHERE n.builder_user_id = _user_id AND n.read_at IS NULL),
    (SELECT count(*) FROM public.builder_task_assignments a
     JOIN public.builder_tasks t ON t.id = a.task_id
     WHERE a.builder_user_id = _user_id AND a.unassigned_at IS NULL
       AND t.status NOT IN ('done','cancelled')
       AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE
       AND public.builder_resolve_scope_permission(
             _user_id, t.scope_type, t.scope_id, 'tasks', 'view'));
$$;

-- ===========================================================================
-- 6. Guarded commands — write and trusted audit in ONE transaction
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_upsert_document(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _document_id uuid, _scope_type text, _scope_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_documents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_documents; v_row public.builder_documents; v_org uuid;
BEGIN
  IF _document_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_documents WHERE id = _document_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_documents SET
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      description = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      document_type = CASE WHEN _payload ? 'document_type' THEN _payload->>'document_type' ELSE document_type END,
      status = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      is_customer_visible = CASE WHEN _payload ? 'is_customer_visible'
        THEN (_payload->>'is_customer_visible')::boolean ELSE is_customer_visible END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF NULLIF(btrim(COALESCE(_payload->>'title','')), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_TITLE_REQUIRED';
    END IF;
    v_org := public.builder_scope_org(_scope_type, _scope_id);
    IF v_org IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_documents(scope_type, scope_id, organisation_id, title,
      description, document_type, is_customer_visible)
    VALUES (_scope_type, _scope_id, v_org, _payload->>'title', _payload->>'description',
      COALESCE(_payload->>'document_type','other'),
      COALESCE((_payload->>'is_customer_visible')::boolean, false))
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _document_id IS NULL THEN 'builder_document_created'
         ELSE 'builder_document_updated' END,
    'document', v_row.id, v_row.organisation_id, _actor_builder_user_id,
    CASE WHEN _document_id IS NULL THEN NULL ELSE jsonb_build_object('title', v_existing.title) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('scope_type', v_row.scope_type, 'scope_id', v_row.scope_id));
  RETURN v_row;
END $$;

/**
 * Append a version.
 *
 * This is the one collaboration command that takes NO `_expected_version`, and
 * deliberately so. It is an APPEND, not an edit: the caller supplies no field of
 * an existing row. The only change to `builder_documents` is `current_version_id`,
 * a server-derived pointer set to the row just inserted, under the `FOR UPDATE`
 * lock that also serialises the version-number allocation.
 *
 * Requiring a version here would make two people uploading at once fail
 * spuriously rather than queue — the opposite of what optimistic concurrency is
 * for — while protecting nothing, because there is no user-supplied value that
 * a concurrent write could clobber. Editing the document's own fields still goes
 * through `builder_upsert_document`, which does require it. The touch trigger
 * bumps `row_version` here too, so anyone holding an open edit form correctly
 * gets a 409 on their next save: the document did change.
 */
CREATE OR REPLACE FUNCTION public.builder_add_document_version(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _document_id uuid, _payload jsonb, _reason text DEFAULT NULL)
RETURNS public.builder_document_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.builder_documents; v_row public.builder_document_versions; v_next integer;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'storage_path','')), '') IS NULL
     OR NULLIF(btrim(COALESCE(_payload->>'file_name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_FILE_REQUIRED';
  END IF;
  SELECT * INTO d FROM public.builder_documents WHERE id = _document_id FOR UPDATE;
  IF d.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_NOT_FOUND';
  END IF;

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_next
  FROM public.builder_document_versions WHERE document_id = _document_id;

  INSERT INTO public.builder_document_versions(document_id, version_number, storage_path,
    file_name, content_type, byte_size, checksum, change_note,
    uploaded_by_type, uploaded_by_builder_user_id, uploaded_by_user_id)
  VALUES (_document_id, v_next, _payload->>'storage_path', _payload->>'file_name',
    COALESCE(_payload->>'content_type','application/pdf'),
    NULLIF(_payload->>'byte_size','')::bigint, _payload->>'checksum', _payload->>'change_note',
    _actor_type, _actor_builder_user_id, _actor_user_id)
  RETURNING * INTO v_row;

  UPDATE public.builder_documents SET current_version_id = v_row.id WHERE id = _document_id;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_document_version_added',
    'document_version', v_row.id, d.organisation_id, _actor_builder_user_id,
    NULL, jsonb_build_object('version_number', v_row.version_number,
                             'file_name', v_row.file_name),
    _reason, jsonb_build_object('document_id', _document_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_set_document_grant(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _document_id uuid, _builder_user_id uuid, _can_download boolean,
  _revoke boolean DEFAULT false, _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_document_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.builder_documents; v_existing public.builder_document_grants;
        v_row public.builder_document_grants;
BEGIN
  SELECT * INTO d FROM public.builder_documents WHERE id = _document_id;
  IF d.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing FROM public.builder_document_grants
  WHERE document_id = _document_id AND builder_user_id = _builder_user_id FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_document_grants SET
      can_download = _can_download,
      revoked_at = CASE WHEN _revoke THEN COALESCE(revoked_at, now()) ELSE NULL END,
      revocation_reason = CASE WHEN _revoke THEN _reason ELSE NULL END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _revoke THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_GRANT_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_document_grants(document_id, builder_user_id, can_download,
      granted_by_user_id)
    VALUES (_document_id, _builder_user_id, _can_download, _actor_user_id)
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _revoke THEN 'builder_document_grant_revoked' ELSE 'builder_document_grant_set' END,
    'document_grant', v_row.id, d.organisation_id, _actor_builder_user_id,
    CASE WHEN v_existing.id IS NULL THEN NULL
         ELSE jsonb_build_object('revoked_at', v_existing.revoked_at) END,
    jsonb_build_object('builder_user_id', v_row.builder_user_id,
                       'can_download', v_row.can_download,
                       'revoked_at', v_row.revoked_at, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('document_id', _document_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_create_conversation(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _scope_type text, _scope_id uuid, _payload jsonb,
  _participant_ids uuid[] DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_conversations; v_org uuid; p uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'subject','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONVERSATION_SUBJECT_REQUIRED';
  END IF;
  v_org := public.builder_scope_org(_scope_type, _scope_id);
  IF v_org IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;

  INSERT INTO public.builder_conversations(scope_type, scope_id, organisation_id, subject)
  VALUES (_scope_type, _scope_id, v_org, _payload->>'subject')
  RETURNING * INTO v_row;

  -- The author is always a participant; anyone else named is added too. A
  -- participant who cannot reach the scope still cannot open the conversation,
  -- because the resolver runs first.
  IF _actor_builder_user_id IS NOT NULL THEN
    INSERT INTO public.builder_conversation_participants(conversation_id, builder_user_id)
    VALUES (v_row.id, _actor_builder_user_id) ON CONFLICT DO NOTHING;
  END IF;
  IF _participant_ids IS NOT NULL THEN
    FOREACH p IN ARRAY _participant_ids LOOP
      INSERT INTO public.builder_conversation_participants(conversation_id, builder_user_id)
      VALUES (v_row.id, p) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_conversation_created',
    'conversation', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('subject', v_row.subject),
    _reason, jsonb_build_object('scope_type', _scope_type, 'scope_id', _scope_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_post_message(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _conversation_id uuid, _body text, _display_name text DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.builder_conversations; v_row public.builder_messages;
BEGIN
  IF NULLIF(btrim(COALESCE(_body,'')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MESSAGE_BODY_REQUIRED';
  END IF;
  SELECT * INTO c FROM public.builder_conversations WHERE id = _conversation_id FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONVERSATION_NOT_FOUND';
  END IF;
  IF c.status = 'archived' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONVERSATION_ARCHIVED';
  END IF;

  INSERT INTO public.builder_messages(conversation_id, body, author_type,
    author_builder_user_id, author_user_id, author_display_name)
  VALUES (_conversation_id, _body, _actor_type, _actor_builder_user_id, _actor_user_id,
    _display_name)
  RETURNING * INTO v_row;

  UPDATE public.builder_conversations
  SET last_message_at = v_row.created_at, message_count = message_count + 1
  WHERE id = _conversation_id;

  -- The author's own watermark advances so their own message is not unread.
  IF _actor_builder_user_id IS NOT NULL THEN
    UPDATE public.builder_conversation_participants SET last_read_at = v_row.created_at
    WHERE conversation_id = _conversation_id AND builder_user_id = _actor_builder_user_id;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_message_posted',
    'message', v_row.id, c.organisation_id, _actor_builder_user_id,
    NULL, jsonb_build_object('conversation_id', _conversation_id),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_mark_conversation_read(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.builder_conversations;
BEGIN
  SELECT * INTO c FROM public.builder_conversations WHERE id = _conversation_id;
  IF c.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONVERSATION_NOT_FOUND';
  END IF;

  -- Scoped to the caller's own participation row. A conversation the caller does
  -- not participate in matches nothing, so the watermark cannot be moved for
  -- anyone else.
  UPDATE public.builder_conversation_participants SET last_read_at = now()
  WHERE conversation_id = _conversation_id AND builder_user_id = _actor_builder_user_id
    AND left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_NOT_A_PARTICIPANT';
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_conversation_read',
    'conversation', _conversation_id, c.organisation_id, _actor_builder_user_id,
    NULL, jsonb_build_object('read_at', now()), NULL, '{}'::jsonb);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_task(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _task_id uuid, _scope_type text, _scope_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_tasks; v_row public.builder_tasks; v_org uuid;
BEGIN
  IF _task_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_tasks WHERE id = _task_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TASK_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_tasks SET
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      description = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      status = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      priority = CASE WHEN _payload ? 'priority' THEN _payload->>'priority' ELSE priority END,
      due_date = CASE WHEN _payload ? 'due_date' THEN (_payload->>'due_date')::date ELSE due_date END,
      completed_at = CASE WHEN _payload ? 'status' AND _payload->>'status' = 'done'
                          THEN COALESCE(completed_at, now())
                          WHEN _payload ? 'status' THEN NULL ELSE completed_at END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF NULLIF(btrim(COALESCE(_payload->>'title','')), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TASK_TITLE_REQUIRED';
    END IF;
    v_org := public.builder_scope_org(_scope_type, _scope_id);
    IF v_org IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_tasks(scope_type, scope_id, organisation_id, title, description,
      priority, due_date, created_by_builder_user_id)
    VALUES (_scope_type, _scope_id, v_org, _payload->>'title', _payload->>'description',
      COALESCE(_payload->>'priority','normal'), (_payload->>'due_date')::date,
      _actor_builder_user_id)
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _task_id IS NULL THEN 'builder_task_created' ELSE 'builder_task_updated' END,
    'task', v_row.id, v_row.organisation_id, _actor_builder_user_id,
    CASE WHEN _task_id IS NULL THEN NULL
         ELSE jsonb_build_object('status', v_existing.status, 'due_date', v_existing.due_date) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'due_date', v_row.due_date, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('scope_type', v_row.scope_type, 'scope_id', v_row.scope_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_set_task_assignment(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _task_id uuid, _builder_user_id uuid, _unassign boolean DEFAULT false,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_task_assignments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.builder_tasks; v_existing public.builder_task_assignments;
        v_row public.builder_task_assignments;
BEGIN
  SELECT * INTO t FROM public.builder_tasks WHERE id = _task_id;
  IF t.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TASK_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing FROM public.builder_task_assignments
  WHERE task_id = _task_id AND builder_user_id = _builder_user_id FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_task_assignments SET
      unassigned_at = CASE WHEN _unassign THEN COALESCE(unassigned_at, now()) ELSE NULL END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _unassign THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ASSIGNMENT_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_task_assignments(task_id, builder_user_id,
      assigned_by_builder_user_id)
    VALUES (_task_id, _builder_user_id, _actor_builder_user_id)
    RETURNING * INTO v_row;

    -- Assignment raises a notification for the assignee. It is a POINTER: it
    -- carries the task title only, never its contents.
    INSERT INTO public.builder_notifications(builder_user_id, organisation_id,
      notification_type, title, body, scope_type, scope_id, entity_kind, entity_id)
    VALUES (_builder_user_id, t.organisation_id, 'task_assigned',
      'You were assigned a task', t.title, t.scope_type, t.scope_id, 'task', t.id);
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _unassign THEN 'builder_task_unassigned' ELSE 'builder_task_assigned' END,
    'task_assignment', v_row.id, t.organisation_id, _actor_builder_user_id,
    CASE WHEN v_existing.id IS NULL THEN NULL
         ELSE jsonb_build_object('unassigned_at', v_existing.unassigned_at) END,
    jsonb_build_object('builder_user_id', v_row.builder_user_id,
                       'unassigned_at', v_row.unassigned_at,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('task_id', _task_id));
  RETURN v_row;
END $$;

/**
 * Mark notifications read. The rows touched are ALWAYS the actor's own: the
 * reader is `_actor_builder_user_id`, taken from the verified session, never
 * from the request body. An id belonging to another user matches no row, so a
 * supplied id can never mark someone else's notification read.
 */
CREATE OR REPLACE FUNCTION public.builder_mark_notifications_read(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _notification_ids uuid[] DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count bigint; v_org uuid;
BEGIN
  IF _actor_builder_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_NOTIFICATION_READER_REQUIRED';
  END IF;

  SELECT organisation_id INTO v_org FROM public.builder_notifications
  WHERE builder_user_id = _actor_builder_user_id
    AND (_notification_ids IS NULL OR id = ANY(_notification_ids)) LIMIT 1;

  UPDATE public.builder_notifications SET read_at = now()
  WHERE builder_user_id = _actor_builder_user_id AND read_at IS NULL
    AND (_notification_ids IS NULL OR id = ANY(_notification_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_notifications_read',
    'notification', NULL, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('marked_read', v_count), NULL, '{}'::jsonb);
  RETURN v_count;
END $$;

-- ===========================================================================
-- 7. Touch triggers
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_documents','builder_document_grants',
                           'builder_conversations','builder_conversation_participants',
                           'builder_tasks','builder_task_assignments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 8. Role baselines
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions
  (membership_role, permission_key, can_view, can_edit, can_delete)
SELECT r.role, k.key, true,
       r.role <> 'read_only',
       r.role IN ('owner','administrator')
FROM (VALUES ('owner'),('administrator'),('manager'),('member'),('read_only')) AS r(role)
CROSS JOIN (VALUES ('documents'),('messages'),('tasks')) AS k(key)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 9. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_documents','builder_document_versions',
                           'builder_document_grants','builder_conversations',
                           'builder_conversation_participants','builder_messages',
                           'builder_tasks','builder_task_assignments',
                           'builder_notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_service ON public.%I
      AS PERMISSIVE FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')$p$, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

DO $$
DECLARE f text; a text;
BEGIN
  FOR f, a IN SELECT * FROM (VALUES
    ('builder_scope_exists','text, uuid'),
    ('builder_scope_org','text, uuid'),
    ('builder_resolve_scope_permission','uuid, text, uuid, text, text'),
    ('builder_can_see_document','uuid, uuid, text'),
    ('builder_can_see_conversation','uuid, uuid, text'),
    ('builder_accessible_documents','uuid, text, uuid'),
    ('builder_accessible_conversations','uuid, text, uuid'),
    ('builder_accessible_tasks','uuid, text, uuid'),
    ('builder_unread_counts','uuid'),
    ('builder_upsert_document','uuid, text, uuid, uuid, text, uuid, jsonb, bigint, text'),
    ('builder_add_document_version','uuid, text, uuid, uuid, jsonb, text'),
    ('builder_set_document_grant','uuid, text, uuid, uuid, uuid, boolean, boolean, bigint, text'),
    ('builder_create_conversation','uuid, text, uuid, text, uuid, jsonb, uuid[], text'),
    ('builder_post_message','uuid, text, uuid, uuid, text, text, text'),
    ('builder_mark_conversation_read','uuid, text, uuid, uuid'),
    ('builder_upsert_task','uuid, text, uuid, uuid, text, uuid, jsonb, bigint, text'),
    ('builder_set_task_assignment','uuid, text, uuid, uuid, uuid, boolean, bigint, text'),
    ('builder_mark_notifications_read','uuid, text, uuid, uuid[]')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 10. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_scope_exists','builder_scope_org','builder_resolve_scope_permission',
    'builder_can_see_document','builder_can_see_conversation',
    'builder_accessible_documents','builder_accessible_conversations',
    'builder_accessible_tasks','builder_unread_counts',
    'builder_upsert_document','builder_add_document_version','builder_set_document_grant',
    'builder_create_conversation','builder_post_message','builder_mark_conversation_read',
    'builder_upsert_task','builder_set_task_assignment','builder_mark_notifications_read',
    'builder_enforce_collaboration_scope']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: collaboration function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_documents','builder_document_versions','builder_document_grants',
                      'builder_conversations','builder_conversation_participants',
                      'builder_messages','builder_tasks','builder_task_assignments',
                      'builder_notifications')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_documents','builder_document_grants','builder_conversations',
                    'builder_conversation_participants','builder_tasks',
                    'builder_task_assignments']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['documents','messages','tasks']) AS k
  WHERE NOT EXISTS (SELECT 1 FROM public.builder_role_default_permissions
                    WHERE permission_key = k AND membership_role='manager' AND can_view);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: permission key(s) without a role baseline: %', v_missing;
  END IF;

  -- No collaboration table may carry money, a client financial position, an AML
  -- determination or a privileged legal field.
  SELECT string_agg(table_name||'.'||column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('builder_documents','builder_document_versions','builder_document_grants',
                       'builder_conversations','builder_conversation_participants',
                       'builder_messages','builder_tasks','builder_task_assignments',
                       'builder_notifications')
    AND (column_name LIKE '%amount%' OR column_name LIKE '%price%' OR column_name LIKE '%cost%'
         OR column_name LIKE '%income%' OR column_name LIKE '%borrowing%'
         OR column_name LIKE '%aml%' OR column_name LIKE '%privileg%'
         OR column_name LIKE '%commission%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a collaboration table carries restricted data: %', v_missing;
  END IF;

  RAISE NOTICE 'builder collaboration: documents, versions, grants, conversations, messages, tasks, assignments and notifications installed';
END $$;
