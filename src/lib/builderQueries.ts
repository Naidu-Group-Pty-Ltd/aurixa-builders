import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBuilderFunction } from '@/lib/builderPortal';
import type {
  BuilderProject, BuilderProjectParty, BuilderProjectStatusHistoryEntry,
} from '@/lib/builderProjects';
import type {
  BuilderAllocation, BuilderBuilding, BuilderLot, BuilderReservation, BuilderStage,
  BuilderUnit, BuilderUnitHistoryEntry, BuilderUnitHold, BuilderUnitPrice,
} from '@/lib/builderInventory';
import type {
  BuilderCaseLink, BuilderPipelineColumn, BuilderPipelineStage, BuilderTransaction,
  BuilderTransactionHistoryEntry, BuilderTransactionParty,
} from '@/lib/builderTransactions';
import type {
  BuilderConstructionCase, BuilderConstructionDateHistoryEntry, BuilderConstructionHistoryEntry,
  BuilderConstructionStage, BuilderMilestone, BuilderPhotograph, BuilderProgressUpdate,
} from '@/lib/builderConstruction';
import type {
  BuilderDefect, BuilderDeliveryHistoryEntry, BuilderDeliveryKind, BuilderHandover,
  BuilderInspection, BuilderPracticalCompletion, BuilderProgressClaim, BuilderVariation,
  BuilderVariationApproval, BuilderWarranty, BuilderWarrantyClaim,
} from '@/lib/builderDelivery';
import type {
  BuilderConversation, BuilderConversationParticipant, BuilderDocument,
  BuilderDocumentGrant, BuilderDocumentVersion, BuilderMessage, BuilderNotification,
  BuilderScopeType, BuilderTask, BuilderTaskAssignment, BuilderUnreadCounts,
} from '@/lib/builderCollaboration';
import type {
  BuilderActivityEntry, BuilderOrganisationSettings, BuilderUserPreferences,
  BuilderWorkspaceSummary,
} from '@/lib/builderWorkspace';

/**
 * Builder Portal query layer. Mirrors `src/lib/solicitorQueries.ts`: query keys,
 * the single `invoke` wrapper that raises a typed error, and one hook per
 * surface. Every call goes through `invokeBuilderFunction`, which carries the
 * HttpOnly session cookie — the browser never reaches the database directly.
 */
export const builderKeys = {
  session: () => ['builder', 'session'] as const,
  projectsRoot: () => ['builder', 'projects'] as const,
  projects: (filters: ProjectFilters) => [...builderKeys.projectsRoot(), filters] as const,
  project: (projectId: string) => ['builder', 'project', projectId] as const,
  projectStats: () => ['builder', 'project-stats'] as const,
  unitsRoot: () => ['builder', 'units'] as const,
  units: (filters: UnitFilters) => [...builderKeys.unitsRoot(), filters] as const,
  unit: (unitId: string) => ['builder', 'unit', unitId] as const,
  inventoryStats: (projectId: string) => ['builder', 'inventory-stats', projectId] as const,
  stages: (projectId: string) => ['builder', 'stages', projectId] as const,
  buildings: (projectId: string) => ['builder', 'buildings', projectId] as const,
  lots: (projectId: string) => ['builder', 'lots', projectId] as const,
  transactionsRoot: () => ['builder', 'transactions'] as const,
  transactions: (filters: TransactionFilters) =>
    [...builderKeys.transactionsRoot(), filters] as const,
  transaction: (transactionId: string) => ['builder', 'transaction', transactionId] as const,
  transactionStats: (projectId: string) => ['builder', 'transaction-stats', projectId] as const,
  pipeline: (projectId: string) => ['builder', 'pipeline', projectId] as const,
  constructionRoot: () => ['builder', 'construction'] as const,
  constructionCases: (filters: ConstructionFilters) =>
    [...builderKeys.constructionRoot(), filters] as const,
  constructionCase: (caseId: string) => ['builder', 'construction-case', caseId] as const,
  constructionStats: (projectId: string) => ['builder', 'construction-stats', projectId] as const,
  deliveryRoot: (caseId: string) => ['builder', 'delivery', caseId] as const,
  delivery: (caseId: string, kind: string) => ['builder', 'delivery', caseId, kind] as const,
  deliverySummary: (projectId: string) => ['builder', 'delivery-summary', projectId] as const,
  collaborationRoot: () => ['builder', 'collaboration'] as const,
  scopeCollaboration: (scopeType: string, scopeId: string, surface: string) =>
    ['builder', 'collaboration', scopeType, scopeId, surface] as const,
  document: (documentId: string) => ['builder', 'document', documentId] as const,
  conversation: (conversationId: string) => ['builder', 'conversation', conversationId] as const,
  myTasks: () => ['builder', 'my-tasks'] as const,
  notifications: () => ['builder', 'notifications'] as const,
  unreadCounts: () => ['builder', 'unread-counts'] as const,
  collaborationSummary: (projectId: string) =>
    ['builder', 'collaboration-summary', projectId] as const,
  workspaceRoot: () => ['builder', 'workspace'] as const,
  workspaceSummary: () => ['builder', 'workspace', 'summary'] as const,
  activity: (entityType: string, entityId: string) =>
    ['builder', 'workspace', 'activity', entityType, entityId] as const,
  organisationSettings: () => ['builder', 'workspace', 'organisation-settings'] as const,
  myPreferences: () => ['builder', 'workspace', 'my-preferences'] as const,
};

export interface ProjectFilters { search: string; status: string; page: number; pageSize: number }

export interface ProjectsPage {
  records: BuilderProject[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface ProjectDetail {
  project: BuilderProject;
  developer_organisation: { id: string; legal_name: string; trading_name: string | null; org_type: string } | null;
  builder_organisation: { id: string; legal_name: string; trading_name: string | null; org_type: string } | null;
  development: { id: string; name: string; development_reference: string | null; status: string } | null;
  parties: BuilderProjectParty[];
  status_history: BuilderProjectStatusHistoryEntry[];
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
  access_role: string;
}

export class BuilderPortalRequestError extends Error {
  constructor(message: string, public code: string, public status?: number) { super(message); }
}

export function mapBuilderError(value: any) {
  const code = value?.data?.code || value?.code || 'PORTAL_REQUEST_FAILED';
  return new BuilderPortalRequestError(
    value?.data?.error || value?.message || 'The request could not be completed',
    code, value?.status);
}

/**
 * Retry policy for Builder queries.
 *
 * A 4xx is the server's answer, not a transient failure: retrying a withheld
 * project three times with backoff leaves the user watching a spinner for
 * several seconds before the "not available" state finally renders. Only
 * network and server-side failures are worth retrying.
 */
function retryBuilderQuery(failureCount: number, error: unknown): boolean {
  const status = (error as BuilderPortalRequestError)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

async function invoke(
  functionName: string, payload: Record<string, unknown> = {}, signal?: AbortSignal,
) {
  const result = await invokeBuilderFunction(functionName, payload, { signal });
  if (result.error || (result.data as any)?.error) {
    throw mapBuilderError(result.error || { data: result.data });
  }
  return result.data;
}

export function useBuilderProjects(filters: ProjectFilters) {
  return useQuery({
    queryKey: builderKeys.projects(filters),
    queryFn: async ({ signal }) => await invoke('builder-portal-projects', {
      operation: 'list_projects',
      search: filters.search,
      status: filters.status,
      page: filters.page,
      page_size: filters.pageSize,
    }, signal) as ProjectsPage,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderProject(projectId: string) {
  return useQuery({
    queryKey: builderKeys.project(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-projects', {
      operation: 'get_project', project_id: projectId,
    }, signal) as Promise<ProjectDetail>,
    enabled: Boolean(projectId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderProjectStats() {
  return useQuery({
    queryKey: builderKeys.projectStats(),
    queryFn: ({ signal }) => invoke('builder-portal-projects', { operation: 'project_stats' }, signal),
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook per project, mirroring `useMatterMutation`. The project id
 * is bound here rather than passed per call so a caller cannot accidentally
 * mutate a different project than the one on screen.
 */
export function useBuilderProjectMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-projects', { ...payload, project_id: projectId }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.project(projectId) }),
        client.invalidateQueries({ queryKey: builderKeys.projectsRoot() }),
        client.invalidateQueries({ queryKey: builderKeys.projectStats() }),
      ]);
    },
  });
}

/* ────────────────────────────── INVENTORY ────────────────────────────── */

export interface UnitFilters {
  projectId: string;
  search: string;
  availabilityStatus: string;
  releaseStatus: string;
  page: number;
  pageSize: number;
}

export interface UnitsPage {
  records: BuilderUnit[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface UnitDetail {
  unit: BuilderUnit;
  project: { id: string; name: string; project_reference: string | null };
  current_price: BuilderUnitPrice | null;
  status_history: BuilderUnitHistoryEntry[];
  holds: BuilderUnitHold[];
  reservations: BuilderReservation[];
  allocations: BuilderAllocation[];
  stage: BuilderStage | null;
  building: BuilderBuilding | null;
  lot: BuilderLot | null;
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
}

export interface InventoryStats {
  total: number;
  by_availability: Record<string, number>;
  by_release: Record<string, number>;
  released: number;
}

export function useBuilderUnits(filters: UnitFilters) {
  return useQuery({
    queryKey: builderKeys.units(filters),
    queryFn: async ({ signal }) => await invoke('builder-portal-inventory', {
      operation: 'list_units',
      project_id: filters.projectId || undefined,
      search: filters.search,
      availability_status: filters.availabilityStatus,
      release_status: filters.releaseStatus,
      page: filters.page,
      page_size: filters.pageSize,
    }, signal) as UnitsPage,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderUnit(unitId: string) {
  return useQuery({
    queryKey: builderKeys.unit(unitId),
    queryFn: ({ signal }) => invoke('builder-portal-inventory', {
      operation: 'get_unit', unit_id: unitId,
    }, signal) as Promise<UnitDetail>,
    enabled: Boolean(unitId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderInventoryStats(projectId = '') {
  return useQuery({
    queryKey: builderKeys.inventoryStats(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-inventory', {
      operation: 'inventory_stats', project_id: projectId || undefined,
    }, signal) as Promise<InventoryStats>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderStages(projectId: string) {
  return useQuery({
    queryKey: builderKeys.stages(projectId),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-inventory', {
      operation: 'list_stages', project_id: projectId,
    }, signal)) as { records: BuilderStage[] }).records,
    enabled: Boolean(projectId),
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook per unit, mirroring `useBuilderProjectMutation`. The unit id
 * is bound here rather than passed per call so a caller cannot accidentally
 * mutate a different unit than the one on screen.
 */
export function useBuilderUnitMutation(unitId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-inventory', { ...payload, unit_id: unitId }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.unit(unitId) }),
        client.invalidateQueries({ queryKey: builderKeys.unitsRoot() }),
        client.invalidateQueries({ queryKey: ['builder', 'inventory-stats'] }),
      ]);
    },
  });
}


/* ───────────────────────────── TRANSACTIONS ───────────────────────────── */

export interface TransactionFilters {
  projectId: string;
  search: string;
  status: string;
  page: number;
  pageSize: number;
}

export interface TransactionsPage {
  records: BuilderTransaction[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface TransactionDetail {
  transaction: BuilderTransaction;
  project: { id: string; name: string; project_reference: string | null };
  unit: { id: string; unit_number: string; unit_type: string; availability_status: string } | null;
  parties: BuilderTransactionParty[];
  status_history: BuilderTransactionHistoryEntry[];
  case_link: BuilderCaseLink | null;
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
}

export interface TransactionStats {
  total: number;
  by_status: Record<string, number>;
  at_risk: number;
  unlinked: number;
}

export interface PipelineBoard {
  stages: BuilderPipelineStage[];
  columns: BuilderPipelineColumn[];
}

export function useBuilderTransactions(filters: TransactionFilters) {
  return useQuery({
    queryKey: builderKeys.transactions(filters),
    queryFn: async ({ signal }) => await invoke('builder-portal-transactions', {
      operation: 'list_transactions',
      project_id: filters.projectId || undefined,
      search: filters.search,
      status: filters.status,
      page: filters.page,
      page_size: filters.pageSize,
    }, signal) as TransactionsPage,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderTransaction(transactionId: string) {
  return useQuery({
    queryKey: builderKeys.transaction(transactionId),
    queryFn: ({ signal }) => invoke('builder-portal-transactions', {
      operation: 'get_transaction', transaction_id: transactionId,
    }, signal) as Promise<TransactionDetail>,
    enabled: Boolean(transactionId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderTransactionStats(projectId = '') {
  return useQuery({
    queryKey: builderKeys.transactionStats(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-transactions', {
      operation: 'transaction_stats', project_id: projectId || undefined,
    }, signal) as Promise<TransactionStats>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderPipeline(projectId = '') {
  return useQuery({
    queryKey: builderKeys.pipeline(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-transactions', {
      operation: 'pipeline', project_id: projectId || undefined,
    }, signal) as Promise<PipelineBoard>,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook per transaction, mirroring `useBuilderUnitMutation`. The
 * transaction id is bound here rather than passed per call so a caller cannot
 * accidentally mutate a different transaction than the one on screen.
 */
export function useBuilderTransactionMutation(transactionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-transactions', { ...payload, transaction_id: transactionId }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.transaction(transactionId) }),
        client.invalidateQueries({ queryKey: builderKeys.transactionsRoot() }),
        client.invalidateQueries({ queryKey: ['builder', 'transaction-stats'] }),
        client.invalidateQueries({ queryKey: ['builder', 'pipeline'] }),
      ]);
    },
  });
}


/* ───────────────────────────── CONSTRUCTION ───────────────────────────── */

export interface ConstructionFilters {
  projectId: string;
  search: string;
  status: string;
  page: number;
  pageSize: number;
}

export interface ConstructionPage {
  records: BuilderConstructionCase[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface ConstructionDetail {
  construction_case: BuilderConstructionCase;
  project: { id: string; name: string; project_reference: string | null };
  unit: { id: string; unit_number: string; unit_type: string } | null;
  stages: BuilderConstructionStage[];
  milestones: BuilderMilestone[];
  progress_updates: BuilderProgressUpdate[];
  photographs: BuilderPhotograph[];
  status_history: BuilderConstructionHistoryEntry[];
  date_history: BuilderConstructionDateHistoryEntry[];
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
}

export interface ConstructionStats {
  total: number;
  by_status: Record<string, number>;
  average_percent: number;
  overdue: number;
}

export function useBuilderConstructionCases(filters: ConstructionFilters) {
  return useQuery({
    queryKey: builderKeys.constructionCases(filters),
    queryFn: async ({ signal }) => await invoke('builder-portal-construction', {
      operation: 'list_cases',
      project_id: filters.projectId || undefined,
      search: filters.search,
      status: filters.status,
      page: filters.page,
      page_size: filters.pageSize,
    }, signal) as ConstructionPage,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderConstructionCase(caseId: string) {
  return useQuery({
    queryKey: builderKeys.constructionCase(caseId),
    queryFn: ({ signal }) => invoke('builder-portal-construction', {
      operation: 'get_case', construction_case_id: caseId,
    }, signal) as Promise<ConstructionDetail>,
    enabled: Boolean(caseId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderConstructionStats(projectId = '') {
  return useQuery({
    queryKey: builderKeys.constructionStats(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-construction', {
      operation: 'construction_stats', project_id: projectId || undefined,
    }, signal) as Promise<ConstructionStats>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook per construction case. The case id is bound here rather than
 * passed per call so a caller cannot accidentally mutate a different case than
 * the one on screen.
 */
export function useBuilderConstructionMutation(caseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-construction', { ...payload, construction_case_id: caseId }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.constructionCase(caseId) }),
        client.invalidateQueries({ queryKey: builderKeys.constructionRoot() }),
        client.invalidateQueries({ queryKey: ['builder', 'construction-stats'] }),
      ]);
    },
  });
}

/**
 * Fetch a short-lived signed URL for one photograph. It is NOT cached: the
 * server re-resolves the grant on every request and the URL expires in minutes,
 * so a link that leaks cannot outlive the access that produced it.
 */
export async function fetchBuilderPhotographUrl(caseId: string, photographId: string) {
  const data = await invoke('builder-portal-construction', {
    operation: 'photograph_url',
    construction_case_id: caseId,
    photograph_id: photographId,
  }) as { url: string; expires_in: number };
  return data;
}


/* ────────────────────────────── DELIVERY ────────────────────────────── */

export interface DeliverySummary {
  open_defects: number;
  overdue_defects: number;
  pending_variations: number;
  scheduled_inspections: number;
}

export interface CompletionBundle {
  practical_completion: BuilderPracticalCompletion | null;
  handover: BuilderHandover | null;
  warranty: BuilderWarranty | null;
  warranty_claims: BuilderWarrantyClaim[];
}

/**
 * One list hook per delivery aggregate, all sharing the same operation shape.
 * The construction case id is the only key: every record is a child of it, and
 * the server re-resolves that case's grant on every call.
 */
function useDeliveryList<T>(caseId: string, kind: string, operation: string) {
  return useQuery({
    queryKey: builderKeys.delivery(caseId, kind),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-delivery', {
      operation, construction_case_id: caseId,
    }, signal)) as { records: T[] }).records,
    enabled: Boolean(caseId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderVariations(caseId: string) {
  return useDeliveryList<BuilderVariation>(caseId, 'variations', 'list_variations');
}

export function useBuilderClaims(caseId: string) {
  return useDeliveryList<BuilderProgressClaim>(caseId, 'claims', 'list_claims');
}

export function useBuilderInspections(caseId: string) {
  return useDeliveryList<BuilderInspection>(caseId, 'inspections', 'list_inspections');
}

export function useBuilderDefects(caseId: string) {
  return useDeliveryList<BuilderDefect>(caseId, 'defects', 'list_defects');
}

export function useBuilderVariationApprovals(caseId: string, variationId: string) {
  return useQuery({
    queryKey: [...builderKeys.delivery(caseId, 'approvals'), variationId],
    queryFn: async ({ signal }) => ((await invoke('builder-portal-delivery', {
      operation: 'list_approvals', construction_case_id: caseId, variation_id: variationId,
    }, signal)) as { records: BuilderVariationApproval[] }).records,
    enabled: Boolean(caseId && variationId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderCompletion(caseId: string) {
  return useQuery({
    queryKey: builderKeys.delivery(caseId, 'completion'),
    queryFn: ({ signal }) => invoke('builder-portal-delivery', {
      operation: 'get_completion', construction_case_id: caseId,
    }, signal) as Promise<CompletionBundle>,
    enabled: Boolean(caseId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderDeliveryHistory(caseId: string, kind?: BuilderDeliveryKind) {
  return useQuery({
    queryKey: [...builderKeys.delivery(caseId, 'history'), kind ?? 'all'],
    queryFn: async ({ signal }) => ((await invoke('builder-portal-delivery', {
      operation: 'delivery_history', construction_case_id: caseId, kind,
    }, signal)) as { records: BuilderDeliveryHistoryEntry[] }).records,
    enabled: Boolean(caseId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderDeliverySummary(projectId = '') {
  return useQuery({
    queryKey: builderKeys.deliverySummary(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-delivery', {
      operation: 'delivery_summary', project_id: projectId || undefined,
    }, signal) as Promise<DeliverySummary>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook per construction case. The case id is bound here rather
 * than passed per call so a caller cannot accidentally mutate a record under a
 * different case than the one on screen.
 */
export function useBuilderDeliveryMutation(caseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-delivery', { ...payload, construction_case_id: caseId }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.deliveryRoot(caseId) }),
        client.invalidateQueries({ queryKey: ['builder', 'delivery-summary'] }),
        client.invalidateQueries({ queryKey: builderKeys.constructionCase(caseId) }),
      ]);
    },
  });
}


/* ────────────────────────── COLLABORATION ────────────────────────── */

export interface BuilderScopeRef { scopeType: BuilderScopeType | ''; scopeId: string }

export interface DocumentBundle {
  document: BuilderDocument;
  versions: BuilderDocumentVersion[];
  grants: BuilderDocumentGrant[];
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
}

export interface ConversationBundle {
  conversation: BuilderConversation;
  participants: BuilderConversationParticipant[];
  messages: BuilderMessage[];
  permissions: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
}

export interface CollaborationSummary {
  documents: number;
  open_conversations: number;
  open_tasks: number;
  overdue_tasks: number;
  unread_messages: number;
  unread_notifications: number;
}

/**
 * One list hook per collaboration surface, all keyed by the SCOPE rather than a
 * single parent id — a document, conversation or task may hang off any Builder
 * aggregate, and the server re-resolves that aggregate's grant on every call.
 */
function useScopedList<T>(scope: BuilderScopeRef, surface: string, operation: string) {
  return useQuery({
    queryKey: builderKeys.scopeCollaboration(scope.scopeType, scope.scopeId, surface),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-collaboration', {
      operation, scope_type: scope.scopeType, scope_id: scope.scopeId,
    }, signal)) as { records: T[] }).records,
    enabled: Boolean(scope.scopeType && scope.scopeId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderDocuments(scope: BuilderScopeRef) {
  return useScopedList<BuilderDocument>(scope, 'documents', 'list_documents');
}

export function useBuilderConversations(scope: BuilderScopeRef) {
  return useScopedList<BuilderConversation>(scope, 'conversations', 'list_conversations');
}

export function useBuilderScopedTasks(scope: BuilderScopeRef) {
  return useQuery({
    queryKey: builderKeys.scopeCollaboration(scope.scopeType, scope.scopeId, 'tasks'),
    queryFn: ({ signal }) => invoke('builder-portal-collaboration', {
      operation: 'list_tasks', scope_type: scope.scopeType, scope_id: scope.scopeId,
    }, signal) as Promise<{ records: BuilderTask[]; assignments: BuilderTaskAssignment[] }>,
    enabled: Boolean(scope.scopeType && scope.scopeId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderDocument(documentId: string) {
  return useQuery({
    queryKey: builderKeys.document(documentId),
    queryFn: ({ signal }) => invoke('builder-portal-collaboration', {
      operation: 'get_document', document_id: documentId,
    }, signal) as Promise<DocumentBundle>,
    enabled: Boolean(documentId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderConversation(conversationId: string) {
  return useQuery({
    queryKey: builderKeys.conversation(conversationId),
    queryFn: ({ signal }) => invoke('builder-portal-collaboration', {
      operation: 'get_conversation', conversation_id: conversationId,
    }, signal) as Promise<ConversationBundle>,
    enabled: Boolean(conversationId),
    retry: retryBuilderQuery,
  });
}

export function useBuilderMyTasks() {
  return useQuery({
    queryKey: builderKeys.myTasks(),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-collaboration', {
      operation: 'my_tasks',
    }, signal)) as { records: BuilderTask[] }).records,
    retry: retryBuilderQuery,
  });
}

export function useBuilderNotifications() {
  return useQuery({
    queryKey: builderKeys.notifications(),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-collaboration', {
      operation: 'list_notifications',
    }, signal)) as { records: BuilderNotification[] }).records,
    retry: retryBuilderQuery,
  });
}

export function useBuilderUnreadCounts() {
  return useQuery({
    queryKey: builderKeys.unreadCounts(),
    queryFn: ({ signal }) => invoke('builder-portal-collaboration', {
      operation: 'unread_counts',
    }, signal) as Promise<BuilderUnreadCounts>,
    staleTime: 30_000,
    retry: retryBuilderQuery,
  });
}

export function useBuilderCollaborationSummary(projectId = '') {
  return useQuery({
    queryKey: builderKeys.collaborationSummary(projectId),
    queryFn: ({ signal }) => invoke('builder-portal-collaboration', {
      operation: 'collaboration_summary', project_id: projectId || undefined,
    }, signal) as Promise<CollaborationSummary>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook for every collaboration write. The whole collaboration tree
 * is invalidated on success because a single write — posting a message, closing
 * a task — moves counts that are read on other screens.
 */
export function useBuilderCollaborationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-collaboration', payload),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: builderKeys.collaborationRoot() }),
        client.invalidateQueries({ queryKey: builderKeys.myTasks() }),
        client.invalidateQueries({ queryKey: builderKeys.notifications() }),
        client.invalidateQueries({ queryKey: builderKeys.unreadCounts() }),
        client.invalidateQueries({ queryKey: ['builder', 'collaboration-summary'] }),
        client.invalidateQueries({ queryKey: ['builder', 'document'] }),
        client.invalidateQueries({ queryKey: ['builder', 'conversation'] }),
      ]);
    },
  });
}

/** A short-lived signed URL. The path never reaches the browser. */
export async function fetchBuilderDocumentUrl(documentId: string, versionId?: string) {
  return await invoke('builder-portal-collaboration', {
    operation: 'document_url', document_id: documentId, version_id: versionId,
  }) as { url: string; file_name: string; expires_in: number };
}


/* ─────────────────────────── WORKSPACE ─────────────────────────── */

export interface OrganisationSettingsBundle {
  settings: BuilderOrganisationSettings | null;
  /** A hint for rendering only. The server re-checks the role on every write. */
  can_edit: boolean;
}

/**
 * The cross-module dashboard summary. Every number is computed by the database
 * from an accessible-set function, so a count can never reveal a record this
 * user cannot open.
 */
export function useBuilderWorkspaceSummary() {
  return useQuery({
    queryKey: builderKeys.workspaceSummary(),
    queryFn: ({ signal }) => invoke('builder-portal-workspace', {
      operation: 'workspace_summary',
    }, signal) as Promise<BuilderWorkspaceSummary>,
    staleTime: 60_000,
    retry: retryBuilderQuery,
  });
}

/**
 * The activity feed. Optionally narrowed to one record — which narrows WITHIN
 * what is already permitted; the server resolves every row through the resolver
 * that governs the record itself.
 */
export function useBuilderActivity(entityType = '', entityId = '') {
  return useQuery({
    queryKey: builderKeys.activity(entityType, entityId),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-workspace', {
      operation: 'activity_history',
      entity_type: entityType || undefined,
      entity_id: entityId || undefined,
      limit: 100,
    }, signal)) as { records: BuilderActivityEntry[] }).records,
    retry: retryBuilderQuery,
  });
}

export function useBuilderOrganisationSettings() {
  return useQuery({
    queryKey: builderKeys.organisationSettings(),
    queryFn: ({ signal }) => invoke('builder-portal-workspace', {
      operation: 'get_organisation_settings',
    }, signal) as Promise<OrganisationSettingsBundle>,
    retry: retryBuilderQuery,
  });
}

export function useBuilderMyPreferences() {
  return useQuery({
    queryKey: builderKeys.myPreferences(),
    queryFn: async ({ signal }) => ((await invoke('builder-portal-workspace', {
      operation: 'get_my_preferences',
    }, signal)) as { preferences: BuilderUserPreferences | null }).preferences,
    retry: retryBuilderQuery,
  });
}

/**
 * One mutation hook for both settings surfaces. The whole workspace tree is
 * invalidated on success because a saved preference changes what the dashboard
 * and the shell render.
 */
export function useBuilderWorkspaceMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      invoke('builder-portal-workspace', payload),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: builderKeys.workspaceRoot() });
    },
  });
}
