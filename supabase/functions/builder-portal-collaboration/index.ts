/**
 * Builder / Developer Portal — Collaboration
 *
 * Portal-facing documents and versions, document permissions, conversations and
 * messages, tasks and assignments with due dates, and notifications with unread
 * counts. Mirrors `builder-portal-delivery`: cookie session, governance gate,
 * server-held active organisation, parent-first access resolution, tri-state
 * permission matrix, guarded transactional commands.
 *
 * The difference from every earlier Builder module is the SHAPE of the parent.
 * A collaboration row names its aggregate with a `(scope_type, scope_id)` pair,
 * and `builder_resolve_scope_permission` dispatches to the resolver that already
 * governs that aggregate. So a document on a transaction is exactly as reachable
 * as that transaction — no more, no less. There is no collaboration-level grant
 * a caller could aim at: a scope pair in the body is a lookup key, never
 * authority, and the project behind it is re-checked against the session's
 * active organisation on every request.
 *
 * DATA BOUNDARY: nothing here reads Client, Finance, Solicitor, AML or
 * commission data. A document is metadata; the bytes live in storage and
 * `storage_path` is STRIPPED from every response — a caller who needs the file
 * asks for a short-lived signed URL, which re-resolves their permission first.
 *
 * Operations
 *   list_documents | get_document | upsert_document | add_document_version
 *   document_url | list_document_grants | set_document_grant
 *   list_conversations | get_conversation | create_conversation
 *   post_message | mark_conversation_read
 *   list_tasks | my_tasks | upsert_task | set_task_assignment
 *   list_notifications | mark_notifications_read | unread_counts
 *   collaboration_summary
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import {
  resolveBuilderSession,
  builderGovernanceError,
  resolveBuilderProjectAccess,
  resolveBuilderProjectPermissions,
  listAccessibleBuilderProjectIds,
  builderMatrixCan,
  logBuilderProjectActivity,
  type BuilderPermissionMatrix,
} from '../_shared/builderPortalAuth.ts';
import {
  BUILDER_DOCUMENT_SELECT,
  BUILDER_DOCUMENT_VERSION_SELECT,
  BUILDER_DOCUMENT_GRANT_SELECT,
  BUILDER_CONVERSATION_SELECT,
  BUILDER_PARTICIPANT_SELECT,
  BUILDER_MESSAGE_SELECT,
  BUILDER_TASK_SELECT,
  BUILDER_TASK_ASSIGNMENT_SELECT,
  BUILDER_NOTIFICATION_SELECT,
  BUILDER_DOCUMENT_BUCKET,
  BUILDER_DOCUMENT_URL_TTL_SECONDS,
  buildDocumentPayload,
  buildVersionPayload,
  buildConversationPayload,
  buildTaskPayload,
  collaborationCommandFailure,
  isAcceptableStoragePath,
  readScope,
  cleanText,
  type BuilderScopeType,
} from '../_shared/builderCollaboration.ts';

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, any>));
    const operation = String(body.operation || '');

    const session = await resolveBuilderSession(supabase, req);
    if (!session.ok || !session.user) {
      return json({ error: session.error || 'Unauthorised', code: session.code }, session.status || 401);
    }
    const me = session.user;
    const governanceError = builderGovernanceError(session);
    if (governanceError) return json({ error: 'Portal setup required', code: governanceError }, 403);

    const activeOrganisationId = session.active_organisation?.organisation_id ?? null;
    if (!activeOrganisationId) {
      return json({ error: 'Select an organisation to continue', code: 'organisation_selection_required' }, 403);
    }

    /** Resolve one project exactly as the other Builder functions do. */
    const loadProject = async (projectId: string): Promise<
      { ok: true; perms: BuilderPermissionMatrix } | { ok: false; status: number; error: string }
    > => {
      if (!projectId) return { ok: false, status: 400, error: 'project_id is required' };
      const access = await resolveBuilderProjectAccess(supabase, me.id, projectId);
      if (!access) return { ok: false, status: 404, error: 'Not found' };
      if (access.organisation_id !== activeOrganisationId) {
        return { ok: false, status: 404, error: 'Not found' };
      }
      const { data: project } = await supabase.from('builder_projects')
        .select('id, developer_organisation_id, builder_organisation_id')
        .eq('id', projectId).maybeSingle();
      if (!project) return { ok: false, status: 404, error: 'Not found' };
      const sideOrg = access.organisation_side === 'developer'
        ? project.developer_organisation_id
        : project.builder_organisation_id;
      if (!sideOrg || sideOrg !== access.organisation_id) {
        return { ok: false, status: 404, error: 'Not found' };
      }
      const perms = await resolveBuilderProjectPermissions(supabase, access);
      if (!builderMatrixCan(perms, 'projects', 'view')) {
        return { ok: false, status: 403, error: 'You do not have access to this project' };
      }
      return { ok: true, perms };
    };

    /**
     * The project that owns a scope. Written out per table because the generated
     * Supabase types cannot resolve a union of table names — and because this is
     * the walk that anchors every collaboration row to a project the session's
     * active organisation is actually on.
     */
    const projectIdForScope = async (
      scopeType: BuilderScopeType, scopeId: string,
    ): Promise<string | null> => {
      switch (scopeType) {
        case 'project': {
          const { data } = await supabase.from('builder_projects')
            .select('id').eq('id', scopeId).maybeSingle();
          return data?.id ?? null;
        }
        case 'unit': {
          const { data } = await supabase.from('builder_units')
            .select('project_id').eq('id', scopeId).maybeSingle();
          return data?.project_id ?? null;
        }
        case 'transaction': {
          const { data } = await supabase.from('builder_transactions')
            .select('project_id').eq('id', scopeId).maybeSingle();
          return data?.project_id ?? null;
        }
        case 'construction_case': {
          const { data } = await supabase.from('builder_construction_cases')
            .select('project_id').eq('id', scopeId).maybeSingle();
          return data?.project_id ?? null;
        }
        default:
          return null;
      }
    };

    /**
     * Authorise a scope pair. The project gate runs first (which pins the
     * session's active organisation), then the database's own dispatching
     * resolver — which re-reads the active membership before any override and
     * lets narrower scopes only deny.
     */
    const loadScope = async (
      scopeType: BuilderScopeType | null, scopeId: string | null,
      permissionKey: 'documents' | 'messages' | 'tasks',
      level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; scopeType: BuilderScopeType; scopeId: string; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!scopeType || !scopeId) {
        return { ok: false, status: 400, error: 'scope_type and scope_id are required' };
      }
      const projectId = await projectIdForScope(scopeType, scopeId);
      if (!projectId) return { ok: false, status: 404, error: 'Not found' };

      const parent = await loadProject(projectId);
      // A scope whose project the caller cannot see is reported as "not found",
      // never "forbidden" — probing ids must not reveal one exists.
      if (!parent.ok) return { ok: false, status: 404, error: 'Not found' };

      const { data: allowed, error } = await supabase.rpc('builder_resolve_scope_permission', {
        _user_id: me.id, _scope_type: scopeType, _scope_id: scopeId,
        _permission_key: permissionKey, _level: level,
      });
      if (error) throw error;
      if (allowed !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this' };
      }
      return { ok: true, scopeType, scopeId, perms: parent.perms };
    };

    /**
     * Authorise a document. The scope gate runs first; `builder_can_see_document`
     * then applies any grant, which can only NARROW. Both must pass.
     */
    const loadDocument = async (
      documentId: string | null, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; document: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!documentId) return { ok: false, status: 400, error: 'document_id is required' };
      const { data: document } = await supabase.from('builder_documents')
        .select(BUILDER_DOCUMENT_SELECT).eq('id', documentId).maybeSingle();
      if (!document) return { ok: false, status: 404, error: 'Document not found' };

      const scope = await loadScope(
        document.scope_type as BuilderScopeType, document.scope_id, 'documents', level);
      if (!scope.ok) return { ok: false, status: 404, error: 'Document not found' };

      const { data: visible, error } = await supabase.rpc('builder_can_see_document', {
        _user_id: me.id, _document_id: documentId, _level: level,
      });
      if (error) throw error;
      if (visible !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Document not found' }
          : { ok: false, status: 403, error: 'You do not have permission to change this document' };
      }
      return { ok: true, document, perms: scope.perms };
    };

    /** Authorise a conversation. Participation narrows; the scope gates. */
    const loadConversation = async (
      conversationId: string | null, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; conversation: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!conversationId) return { ok: false, status: 400, error: 'conversation_id is required' };
      const { data: conversation } = await supabase.from('builder_conversations')
        .select(BUILDER_CONVERSATION_SELECT).eq('id', conversationId).maybeSingle();
      if (!conversation) return { ok: false, status: 404, error: 'Conversation not found' };

      const scope = await loadScope(
        conversation.scope_type as BuilderScopeType, conversation.scope_id, 'messages', level);
      if (!scope.ok) return { ok: false, status: 404, error: 'Conversation not found' };

      const { data: visible, error } = await supabase.rpc('builder_can_see_conversation', {
        _user_id: me.id, _conversation_id: conversationId, _level: level,
      });
      if (error) throw error;
      if (visible !== true) {
        return level === 'view'
          ? { ok: false, status: 404, error: 'Conversation not found' }
          : { ok: false, status: 403, error: 'You do not have permission to post here' };
      }
      return { ok: true, conversation, perms: scope.perms };
    };

    /** Authorise a task through the scope that owns it. */
    const loadTask = async (
      taskId: string | null, level: 'view' | 'edit' | 'delete' = 'view',
    ): Promise<
      { ok: true; task: any; perms: BuilderPermissionMatrix }
      | { ok: false; status: number; error: string }
    > => {
      if (!taskId) return { ok: false, status: 400, error: 'task_id is required' };
      const { data: task } = await supabase.from('builder_tasks')
        .select(BUILDER_TASK_SELECT).eq('id', taskId).maybeSingle();
      if (!task) return { ok: false, status: 404, error: 'Task not found' };

      const scope = await loadScope(
        task.scope_type as BuilderScopeType, task.scope_id, 'tasks', level);
      if (!scope.ok) {
        return scope.status === 403
          ? { ok: false, status: 403, error: 'You do not have permission to change this task' }
          : { ok: false, status: 404, error: 'Task not found' };
      }
      return { ok: true, task, perms: scope.perms };
    };

    const fail = (message: string, fallbackStatus = 400, fallbackError = 'The request failed') => {
      const mapped = collaborationCommandFailure(message);
      return mapped
        ? json({ error: mapped.error, code: mapped.code }, mapped.status)
        : json({ error: fallbackError }, fallbackStatus);
    };

    /**
     * Read expected_version for an update. Missing is a hard 400: it is never
     * silently replaced with the current database value.
     */
    const requireVersion = (): number | { error: Response } => {
      const supplied = Number(body.expected_version);
      if (!Number.isInteger(supplied) || supplied < 1) {
        return {
          error: json({
            error: 'expected_version is required when updating an existing record',
            code: 'EXPECTED_VERSION_REQUIRED',
          }, 400),
        };
      }
      return supplied;
    };

    // ───────────────────────── DOCUMENTS ─────────────────────────
    if (operation === 'list_documents') {
      const scope = readScope(body);
      const res = await loadScope(scope?.scopeType ?? null, scope?.scopeId ?? null, 'documents');
      if (!res.ok) return json({ error: res.error }, res.status);

      // The accessible set is computed by the database, so a document restricted
      // by a grant never appears in the list for someone without it.
      const { data: allowedRows } = await supabase.rpc('builder_accessible_documents', {
        _user_id: me.id, _scope_type: res.scopeType, _scope_id: res.scopeId,
      });
      const ids = (allowedRows || []).map((row: any) => row.document_id);
      if (!ids.length) return json({ success: true, records: [] });

      const { data } = await supabase.from('builder_documents').select(BUILDER_DOCUMENT_SELECT)
        .in('id', ids).order('created_at', { ascending: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'get_document') {
      const res = await loadDocument(cleanText(body.document_id, 64));
      if (!res.ok) return json({ error: res.error }, res.status);

      const [{ data: versions }, { data: grants }] = await Promise.all([
        supabase.from('builder_document_versions').select(BUILDER_DOCUMENT_VERSION_SELECT)
          .eq('document_id', res.document.id).order('version_number', { ascending: false }).limit(100),
        supabase.from('builder_document_grants').select(BUILDER_DOCUMENT_GRANT_SELECT)
          .eq('document_id', res.document.id).order('granted_at', { ascending: true }).limit(200),
      ]);

      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_document_viewed', entityType: 'document', entityId: res.document.id,
      });

      // BUILDER_DOCUMENT_VERSION_SELECT never names storage_path, so no path can
      // reach the browser from here.
      return json({
        success: true,
        document: res.document,
        versions: versions || [],
        grants: grants || [],
        permissions: res.perms,
      });
    }

    if (operation === 'upsert_document') {
      const documentId = cleanText(body.document_id, 64);
      let expectedVersion: number | null = null;
      let scopeType: BuilderScopeType | null = null;
      let scopeId: string | null = null;

      if (documentId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        // The scope comes from the STORED row, never the request: a caller
        // cannot move a document into a scope they can reach.
        const existing = await loadDocument(documentId, 'edit');
        if (!existing.ok) return json({ error: existing.error }, existing.status);
        scopeType = existing.document.scope_type;
        scopeId = existing.document.scope_id;
      } else {
        const scope = readScope(body);
        const res = await loadScope(
          scope?.scopeType ?? null, scope?.scopeId ?? null, 'documents', 'edit');
        if (!res.ok) return json({ error: res.error }, res.status);
        scopeType = res.scopeType;
        scopeId = res.scopeId;
      }

      const payload = buildDocumentPayload(body);
      if (!documentId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_document', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _document_id: documentId,
        _scope_type: documentId ? null : scopeType,
        _scope_id: documentId ? null : scopeId,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The document could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'add_document_version') {
      const res = await loadDocument(cleanText(body.document_id, 64), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const payload = buildVersionPayload(body);
      if (!payload.storage_path || !payload.file_name) {
        return json({ error: 'A file is required' }, 400);
      }
      if (!isAcceptableStoragePath(payload.storage_path as string)) {
        return json({ error: 'That file location is not allowed' }, 400);
      }

      const { data: created, error } = await supabase.rpc('builder_add_document_version', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _document_id: res.document.id,
        _payload: payload,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The version could not be added');

      // The bytes are in private storage but nothing has inspected them yet.
      // Quarantine the version and queue it for the shared scanner. Until the
      // scanner returns clean it is not downloadable and does not become the
      // document's current version.
      const { data, error: registerError } = await supabase
        .rpc('builder_register_uploaded_document_version', {
          _document_version_id: (created as any)?.id,
          _actor_builder_user_id: me.id,
          _actor_type: 'builder_user',
        });
      if (registerError) {
        return fail(String(registerError.message || ''), 400, 'The version could not be queued for scanning');
      }

      const { storage_path: _path, ...safe } = (data || {}) as any;
      return json({
        success: true,
        record: safe,
        // The client renders a "scanning" state rather than a download button.
        scan_pending: true,
      });
    }

    if (operation === 'document_url') {
      // The permission is re-resolved on EVERY url request, and the url expires
      // in minutes — a link that leaks cannot outlive the access that made it.
      const res = await loadDocument(cleanText(body.document_id, 64));
      if (!res.ok) return json({ error: res.error }, res.status);

      const versionId = cleanText(body.version_id, 64) || res.document.current_version_id;
      if (!versionId) return json({ error: 'This document has no file yet' }, 404);

      const { data: version } = await supabase.from('builder_document_versions')
        .select('id, storage_path, file_name, lifecycle_status, malware_scan_status')
        .eq('id', versionId)
        .eq('document_id', res.document.id).maybeSingle();
      if (!version) return json({ error: 'Version not found' }, 404);

      // CONTENT SAFETY, checked before permission so an unscanned file is
      // refused identically to everyone. The database is the authority; this
      // call re-reads the current state rather than trusting anything cached.
      const { data: downloadable } = await supabase
        .rpc('builder_document_version_is_downloadable', { _version_id: version.id });
      if (downloadable !== true) {
        const scan = String((version as any).malware_scan_status || 'pending');
        return json({
          error: scan === 'infected'
            ? 'This file was blocked because it failed a malware scan.'
            : scan === 'error'
              ? 'This file could not be scanned. It stays blocked until a scan succeeds.'
              : 'This file is still being scanned and cannot be downloaded yet.',
          code: scan === 'infected' ? 'document_infected' : 'document_not_scanned',
          lifecycle_status: (version as any).lifecycle_status,
          malware_scan_status: scan,
        }, 409);
      }

      // A grant may permit viewing without downloading. When any live grant
      // exists, the caller's own grant decides.
      const { data: grants } = await supabase.from('builder_document_grants')
        .select('builder_user_id, can_download').eq('document_id', res.document.id)
        .is('revoked_at', null);
      if ((grants || []).length) {
        const mine = (grants || []).find((g: any) => g.builder_user_id === me.id);
        if (!mine?.can_download) {
          return json({ error: 'You may view this document but not download it' }, 403);
        }
      }

      const { data: signed, error } = await supabase.storage
        .from(BUILDER_DOCUMENT_BUCKET)
        .createSignedUrl(version.storage_path, BUILDER_DOCUMENT_URL_TTL_SECONDS);
      if (error || !signed?.signedUrl) {
        return json({ error: 'The document could not be prepared' }, 502);
      }
      await logBuilderProjectActivity(supabase, req, {
        builderUserId: me.id, organisationId: activeOrganisationId,
        action: 'builder_document_downloaded',
        entityType: 'document_version', entityId: version.id,
      });
      return json({
        success: true, url: signed.signedUrl,
        file_name: version.file_name, expires_in: BUILDER_DOCUMENT_URL_TTL_SECONDS,
      });
    }

    if (operation === 'list_document_grants') {
      const res = await loadDocument(cleanText(body.document_id, 64));
      if (!res.ok) return json({ error: res.error }, res.status);
      const { data } = await supabase.from('builder_document_grants')
        .select(BUILDER_DOCUMENT_GRANT_SELECT).eq('document_id', res.document.id)
        .order('granted_at', { ascending: true }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'set_document_grant') {
      const res = await loadDocument(cleanText(body.document_id, 64), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const builderUserId = cleanText(body.builder_user_id, 64);
      if (!builderUserId) return json({ error: 'builder_user_id is required' }, 400);

      // A grant may only name someone who is already in this organisation. The
      // grant narrows; it can never introduce an outsider.
      const { data: membership } = await supabase.from('builder_organisation_memberships')
        .select('id').eq('builder_user_id', builderUserId)
        .eq('organisation_id', activeOrganisationId).eq('status', 'active').maybeSingle();
      if (!membership) return json({ error: 'That person is not in your organisation' }, 404);

      const revoke = !!body.revoke;
      const { data: existing } = await supabase.from('builder_document_grants')
        .select('id').eq('document_id', res.document.id)
        .eq('builder_user_id', builderUserId).maybeSingle();

      let expectedVersion: number | null = null;
      if (existing) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      }

      const { data, error } = await supabase.rpc('builder_set_document_grant', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _document_id: res.document.id,
        _builder_user_id: builderUserId,
        _can_download: body.can_download !== false,
        _revoke: revoke,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The permission could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── CONVERSATIONS ─────────────────────────
    if (operation === 'list_conversations') {
      const scope = readScope(body);
      const res = await loadScope(scope?.scopeType ?? null, scope?.scopeId ?? null, 'messages');
      if (!res.ok) return json({ error: res.error }, res.status);

      const { data: allowedRows } = await supabase.rpc('builder_accessible_conversations', {
        _user_id: me.id, _scope_type: res.scopeType, _scope_id: res.scopeId,
      });
      const ids = (allowedRows || []).map((row: any) => row.conversation_id);
      if (!ids.length) return json({ success: true, records: [] });

      const { data } = await supabase.from('builder_conversations').select(BUILDER_CONVERSATION_SELECT)
        .in('id', ids).order('last_message_at', { ascending: false, nullsFirst: false }).limit(200);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'get_conversation') {
      const res = await loadConversation(cleanText(body.conversation_id, 64));
      if (!res.ok) return json({ error: res.error }, res.status);

      const [{ data: participants }, { data: messages }] = await Promise.all([
        supabase.from('builder_conversation_participants').select(BUILDER_PARTICIPANT_SELECT)
          .eq('conversation_id', res.conversation.id).order('joined_at', { ascending: true }).limit(100),
        supabase.from('builder_messages').select(BUILDER_MESSAGE_SELECT)
          .eq('conversation_id', res.conversation.id).order('created_at', { ascending: true }).limit(500),
      ]);
      return json({
        success: true,
        conversation: res.conversation,
        participants: participants || [],
        messages: messages || [],
        permissions: res.perms,
      });
    }

    if (operation === 'create_conversation') {
      const scope = readScope(body);
      const res = await loadScope(
        scope?.scopeType ?? null, scope?.scopeId ?? null, 'messages', 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const payload = buildConversationPayload(body);
      if (!payload.subject) return json({ error: 'A subject is required' }, 400);

      // Named participants are filtered to active members of THIS organisation.
      // An id from the browser is a request, not authority.
      const requested = Array.isArray(body.participant_ids)
        ? body.participant_ids.map((id: unknown) => cleanText(id, 64)).filter(Boolean).slice(0, 50)
        : [];
      let participantIds: string[] = [];
      if (requested.length) {
        const { data: members } = await supabase.from('builder_organisation_memberships')
          .select('builder_user_id').in('builder_user_id', requested)
          .eq('organisation_id', activeOrganisationId).eq('status', 'active');
        participantIds = (members || []).map((m: any) => m.builder_user_id);
      }

      const { data, error } = await supabase.rpc('builder_create_conversation', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _scope_type: res.scopeType,
        _scope_id: res.scopeId,
        _payload: payload,
        _participant_ids: participantIds.length ? participantIds : null,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The conversation could not be started');
      return json({ success: true, record: data });
    }

    if (operation === 'post_message') {
      const res = await loadConversation(cleanText(body.conversation_id, 64), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const messageBody = cleanText(body.body, 8000);
      if (!messageBody) return json({ error: 'A message cannot be empty' }, 400);

      const { data, error } = await supabase.rpc('builder_post_message', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _conversation_id: res.conversation.id,
        _body: messageBody,
        // The display name comes from the SESSION, never the request body.
        _display_name: me.name ?? null,
        _reason: null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The message could not be sent');
      return json({ success: true, record: data });
    }

    if (operation === 'mark_conversation_read') {
      const res = await loadConversation(cleanText(body.conversation_id, 64));
      if (!res.ok) return json({ error: res.error }, res.status);

      const { error } = await supabase.rpc('builder_mark_conversation_read', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _conversation_id: res.conversation.id,
      });
      if (error) return fail(String(error.message || ''), 400, 'The conversation could not be marked read');
      return json({ success: true });
    }

    // ───────────────────────── TASKS ─────────────────────────
    if (operation === 'list_tasks') {
      const scope = readScope(body);
      const res = await loadScope(scope?.scopeType ?? null, scope?.scopeId ?? null, 'tasks');
      if (!res.ok) return json({ error: res.error }, res.status);

      const { data: allowedRows } = await supabase.rpc('builder_accessible_tasks', {
        _user_id: me.id, _scope_type: res.scopeType, _scope_id: res.scopeId,
      });
      const ids = (allowedRows || []).map((row: any) => row.task_id);
      if (!ids.length) return json({ success: true, records: [], assignments: [] });

      const [{ data: tasks }, { data: assignments }] = await Promise.all([
        supabase.from('builder_tasks').select(BUILDER_TASK_SELECT)
          .in('id', ids).order('due_date', { ascending: true, nullsFirst: false }).limit(300),
        supabase.from('builder_task_assignments').select(BUILDER_TASK_ASSIGNMENT_SELECT)
          .in('task_id', ids).is('unassigned_at', null).limit(600),
      ]);
      return json({ success: true, records: tasks || [], assignments: assignments || [] });
    }

    if (operation === 'my_tasks') {
      // Every task assigned to me that I can still reach. The accessible set is
      // computed by the database, so a task in a project I have lost stays out.
      const { data: allowedRows } = await supabase.rpc('builder_accessible_tasks', {
        _user_id: me.id, _scope_type: null, _scope_id: null,
      });
      const ids = (allowedRows || []).map((row: any) => row.task_id);
      if (!ids.length) return json({ success: true, records: [] });

      const { data: assignments } = await supabase.from('builder_task_assignments')
        .select('task_id').eq('builder_user_id', me.id).is('unassigned_at', null)
        .in('task_id', ids).limit(300);
      const mine = (assignments || []).map((a: any) => a.task_id);
      if (!mine.length) return json({ success: true, records: [] });

      const { data } = await supabase.from('builder_tasks').select(BUILDER_TASK_SELECT)
        .in('id', mine).order('due_date', { ascending: true, nullsFirst: false }).limit(300);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'upsert_task') {
      const taskId = cleanText(body.task_id, 64);
      let expectedVersion: number | null = null;
      let scopeType: BuilderScopeType | null = null;
      let scopeId: string | null = null;

      if (taskId) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
        const existing = await loadTask(taskId, 'edit');
        if (!existing.ok) return json({ error: existing.error }, existing.status);
        scopeType = existing.task.scope_type;
        scopeId = existing.task.scope_id;
      } else {
        const scope = readScope(body);
        const res = await loadScope(scope?.scopeType ?? null, scope?.scopeId ?? null, 'tasks', 'edit');
        if (!res.ok) return json({ error: res.error }, res.status);
        scopeType = res.scopeType;
        scopeId = res.scopeId;
      }

      const payload = buildTaskPayload(body);
      if (!taskId && !payload.title) return json({ error: 'A title is required' }, 400);

      const { data, error } = await supabase.rpc('builder_upsert_task', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _task_id: taskId,
        _scope_type: taskId ? null : scopeType,
        _scope_id: taskId ? null : scopeId,
        _payload: payload,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The task could not be saved');
      return json({ success: true, record: data });
    }

    if (operation === 'set_task_assignment') {
      const res = await loadTask(cleanText(body.task_id, 64), 'edit');
      if (!res.ok) return json({ error: res.error }, res.status);

      const builderUserId = cleanText(body.builder_user_id, 64);
      if (!builderUserId) return json({ error: 'builder_user_id is required' }, 400);

      // Only an active member of this organisation can be assigned. An id from
      // the browser names a candidate; the membership decides.
      const { data: membership } = await supabase.from('builder_organisation_memberships')
        .select('id').eq('builder_user_id', builderUserId)
        .eq('organisation_id', activeOrganisationId).eq('status', 'active').maybeSingle();
      if (!membership) return json({ error: 'That person is not in your organisation' }, 404);

      const { data: existing } = await supabase.from('builder_task_assignments')
        .select('id').eq('task_id', res.task.id)
        .eq('builder_user_id', builderUserId).maybeSingle();

      let expectedVersion: number | null = null;
      if (existing) {
        const version = requireVersion();
        if (typeof version !== 'number') return version.error;
        expectedVersion = version;
      }

      const { data, error } = await supabase.rpc('builder_set_task_assignment', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        _actor_builder_user_id: me.id,
        _task_id: res.task.id,
        _builder_user_id: builderUserId,
        _unassign: !!body.unassign,
        _expected_version: expectedVersion,
        _reason: cleanText(body.reason, 500),
      });
      if (error) return fail(String(error.message || ''), 400, 'The assignment could not be saved');
      return json({ success: true, record: data });
    }

    // ───────────────────────── NOTIFICATIONS ─────────────────────────
    if (operation === 'list_notifications') {
      // Always the caller's own, filtered to the session's active organisation.
      // No id from the request narrows or widens this.
      const { data } = await supabase.from('builder_notifications')
        .select(BUILDER_NOTIFICATION_SELECT)
        .eq('builder_user_id', me.id).eq('organisation_id', activeOrganisationId)
        .order('created_at', { ascending: false }).limit(100);
      return json({ success: true, records: data || [] });
    }

    if (operation === 'mark_notifications_read') {
      const ids = Array.isArray(body.notification_ids)
        ? body.notification_ids.map((id: unknown) => cleanText(id, 64)).filter(Boolean).slice(0, 200)
        : null;

      const { data, error } = await supabase.rpc('builder_mark_notifications_read', {
        _actor_user_id: null,
        _actor_type: 'builder_user',
        // The reader is the SESSION user. An id in the body selects among the
        // caller's own notifications and can never reach someone else's.
        _actor_builder_user_id: me.id,
        _notification_ids: ids && ids.length ? ids : null,
      });
      if (error) return fail(String(error.message || ''), 400, 'The notifications could not be updated');
      return json({ success: true, marked_read: Number(data ?? 0) });
    }

    if (operation === 'unread_counts') {
      const { data, error } = await supabase.rpc('builder_unread_counts', { _user_id: me.id });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        success: true,
        unread_messages: Number(row?.unread_messages ?? 0),
        unread_notifications: Number(row?.unread_notifications ?? 0),
        overdue_tasks: Number(row?.overdue_tasks ?? 0),
      });
    }

    // ───────────────────────── SUMMARY ─────────────────────────
    if (operation === 'collaboration_summary') {
      const accessibleProjectIds = await listAccessibleBuilderProjectIds(
        supabase, me.id, activeOrganisationId);
      const requestedProjectId = cleanText(body.project_id, 64);
      const projectIds = requestedProjectId
        ? accessibleProjectIds.filter((id) => id === requestedProjectId)
        : accessibleProjectIds;

      const empty = {
        success: true, documents: 0, open_conversations: 0,
        open_tasks: 0, overdue_tasks: 0, unread_messages: 0, unread_notifications: 0,
      };
      if (!projectIds.length) return json(empty);

      const [docRows, convRows, taskRows, counts] = await Promise.all([
        supabase.rpc('builder_accessible_documents',
          { _user_id: me.id, _scope_type: null, _scope_id: null }),
        supabase.rpc('builder_accessible_conversations',
          { _user_id: me.id, _scope_type: null, _scope_id: null }),
        supabase.rpc('builder_accessible_tasks',
          { _user_id: me.id, _scope_type: null, _scope_id: null }),
        supabase.rpc('builder_unread_counts', { _user_id: me.id }),
      ]);

      const conversationIds = (convRows.data || []).map((row: any) => row.conversation_id);
      const taskIds = (taskRows.data || []).map((row: any) => row.task_id);
      const today = new Date().toISOString().slice(0, 10);

      const [{ data: conversations }, { data: tasks }] = await Promise.all([
        conversationIds.length
          ? supabase.from('builder_conversations').select('status').in('id', conversationIds)
          : Promise.resolve({ data: [] as any[] }),
        taskIds.length
          ? supabase.from('builder_tasks').select('status, due_date').in('id', taskIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const openTasks = (tasks || []).filter(
        (t: any) => !['done', 'cancelled'].includes(t.status));
      const countRow = Array.isArray(counts.data) ? counts.data[0] : counts.data;
      return json({
        success: true,
        documents: (docRows.data || []).length,
        open_conversations: (conversations || []).filter((c: any) => c.status === 'open').length,
        open_tasks: openTasks.length,
        overdue_tasks: openTasks.filter((t: any) => t.due_date && t.due_date < today).length,
        unread_messages: Number(countRow?.unread_messages ?? 0),
        unread_notifications: Number(countRow?.unread_notifications ?? 0),
      });
    }

    return json({ error: 'Unknown operation' }, 400);
  } catch (error) {
    console.error('[builder-portal-collaboration]', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
