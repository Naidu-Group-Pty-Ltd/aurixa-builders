import { FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, CheckCircle2, HardHat, Home, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  ActivationContact, ActivationStatusBadge, ActivationStockLink,
} from '@/components/builder-portal/StockActivation';
import { builderKeys, useBuilderProject, useBuilderProjectMutation } from '@/lib/builderQueries';
import { useAcknowledgeStockSelection } from '@/lib/builderStockQueries';
import {
  formatCollaborationTime, formatRelativeTime, type BuilderStockActivation,
} from '@/lib/builderCollaboration';
import { describeManualStats, type BuilderStockItem } from '@/lib/builderStock';
import { PropertyDocumentsList, ProjectPropertyPicture } from '@/components/builder-portal/ProjectProperty';
import { ProjectPartiesPanel } from '@/components/builder-portal/ProjectParties';
import type {
  PropertyDocumentLink,
} from '../../../supabase/functions/_shared/builderStock/propertyDocuments.pure';
import {
  ACCESS_ROLE_LABELS, PROJECT_STATUS_CLASSES, PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS, allowedProjectTransitions, formatProjectAddress, formatProjectDate,
  type BuilderProject, type BuilderProjectStatus,
} from '@/lib/builderProjects';

/** `4.0 m²`-style noise never reaches the page: trim, localise, unit. */
const formatMeasure = (value: number | null | undefined, unit = ''): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return `${parsed.toLocaleString('en-AU')}${unit}`;
};

/**
 * The activated property, as a record — its photograph, then every stated
 * fact in its own labelled row, sourced from the same Stock List projection
 * the rest of the portal reads. Rows without a value do not render; nothing
 * here is ever invented. The photograph is the Stock List's own, chosen and
 * drawn by the same code (`ProjectPropertyPicture`).
 */
function PropertyInformationCard({
  project, item, activation, documents,
}: {
  project: BuilderProject;
  item: Partial<BuilderStockItem>;
  activation: BuilderStockActivation | null;
  documents: PropertyDocumentLink[];
}) {
  const location = [item.suburb, item.state, item.postcode]
    .map((part) => (part ?? '').trim()).filter(Boolean).join(' ');
  const specs = [
    formatMeasure(item.bedrooms) ? `${formatMeasure(item.bedrooms)} bed` : null,
    formatMeasure(item.bathrooms) ? `${formatMeasure(item.bathrooms)} bath` : null,
    formatMeasure(item.car_spaces) ? `${formatMeasure(item.car_spaces)} car` : null,
  ].filter(Boolean).join(' · ');

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Property', value: project.name },
    { label: 'Location', value: location || (item.address_line ?? '').trim() },
    { label: 'Lot number', value: (item.lot_number ?? '').trim() },
    { label: 'Development', value: (item.development_name ?? item.project_name ?? '').trim() },
    { label: 'House type', value: (item.house_design ?? '').trim() || (item.property_type ?? '').trim() },
    { label: 'Layout', value: specs },
    { label: 'Building size', value: formatMeasure(item.building_size_sqm, ' m²') ?? '' },
    { label: 'Land size', value: formatMeasure(item.land_size_sqm, ' m²') ?? '' },
    { label: 'Price', value: (item.price_display ?? '').trim() },
    { label: 'Expected completion', value: (item.expected_completion ?? '').trim() },
    { label: 'Client reference', value: activation?.client_reference ?? '' },
  ].filter((row) => row.value);
  // The Stock List's own sentence about where each figure came from.
  const provenance = describeManualStats(item as BuilderStockItem).note;
  const description = (item.description ?? '').trim();

  return (
    <Card className="overflow-hidden">
      <ProjectPropertyPicture
        projectId={project.id}
        item={item}
        alt={`${project.name} — the builder's photograph of this property`}
        aspectClassName="aspect-[16/9]"
        className="border-b border-border/60"
      />
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Home className="h-4 w-4 text-primary" aria-hidden />
          Property information
        </CardTitle>
        <CardDescription>
          From your Stock List record for this property — the same source the
          marketplace shows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-2">
              <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-medium text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
        {provenance ? <p className="mt-3 text-xs text-muted-foreground">{provenance}</p> : null}
        {description ? (
          <div className="mt-4 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="whitespace-pre-line text-sm text-foreground">{description}</p>
          </div>
        ) : null}
        <PropertyDocumentsList documents={documents} className="mt-4" />
        <ActivationStockLink className="mt-4" />
      </CardContent>
    </Card>
  );
}

/**
 * The activation stays connected to the agency that sent it: who activated,
 * where the acknowledgement stands, and the person to contact — as actions.
 * While the activation is unacknowledged the acknowledge action lives here
 * too, because this page is now the record the notification opens.
 */
function ActivatedByAgencyCard({
  projectId, activation,
}: {
  projectId: string;
  activation: BuilderStockActivation;
}) {
  const queryClient = useQueryClient();
  const acknowledge = useAcknowledgeStockSelection();

  const acknowledgeActivation = () => {
    acknowledge.mutate(activation.announcement_id, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: builderKeys.project(projectId) });
        toast.success('Activation acknowledged', {
          description: `${activation.agency_name || 'The agency'} can now see your team has it.`,
        });
      },
      onError: (error: any) => {
        toast.error('Could not acknowledge', {
          description: error?.message || 'Try again, or acknowledge from the Stock List.',
        });
      },
    });
  };

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-primary" aria-hidden />
            Activated by agency
          </CardTitle>
          <ActivationStatusBadge status={activation.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {activation.agency_name || 'A connected agency'}
          </p>
          <time
            className="text-xs text-muted-foreground"
            dateTime={activation.activated_at}
            title={formatCollaborationTime(activation.activated_at)}
          >
            Activated {formatRelativeTime(activation.activated_at)}
          </time>
        </div>

        <ActivationContact activation={activation} className="flex-col items-start gap-y-1.5" />

        {activation.client_reference ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Client reference </span>
            <span className="font-medium text-foreground">{activation.client_reference}</span>
          </p>
        ) : null}

        {activation.status === 'selected' ? (
          <div className="space-y-1.5 pt-1">
            <Button size="sm" onClick={acknowledgeActivation} disabled={acknowledge.isPending}>
              {acknowledge.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                : <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden />}
              Acknowledge activation
            </Button>
            <p className="text-xs text-muted-foreground">
              Tells {activation.agency_name || 'the agency'} your team has this
              and closes the pending task.
            </p>
          </div>
        ) : activation.acknowledged_at ? (
          <p className="text-xs text-muted-foreground">
            Acknowledged {formatRelativeTime(activation.acknowledged_at)}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * External Builder Portal project detail. Mirrors `SolicitorMatterDetail`:
 * overview / parties / history tabs, optimistic-concurrency edits carrying
 * `expected_version`, and a status change that requires a reason.
 *
 * Every control here is rendered from the server-resolved permission matrix.
 * That is a rendering aid only — the server re-authorises every request, so
 * hiding a button is never what prevents an action.
 */
export default function BuilderProjectDetail() {
  const { projectId = '' } = useParams();
  const query = useBuilderProject(projectId);
  const mutation = useBuilderProjectMutation(projectId);

  const [statusValue, setStatusValue] = useState('');
  const [statusReason, setStatusReason] = useState('');

  if (query.isLoading) {
    return (
      <BuilderPortalShell title="Project">
        <div className="flex justify-center py-16" role="status" aria-label="Loading project">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderPortalShell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <BuilderPortalShell title="Project">
        <Alert variant="destructive">
          <AlertDescription>
            This project could not be loaded. It may not exist, or your access may have been
            changed. <Link to="/builder/projects" className="underline">Back to projects</Link>.
          </AlertDescription>
        </Alert>
      </BuilderPortalShell>
    );
  }

  const {
    project, parties, status_history: history, permissions,
    developer_organisation: developer, builder_organisation: builder,
    development, access_role: accessRole,
    activation, stock_item: stockItem, property_documents: propertyDocuments,
  } = query.data;

  const canEdit = permissions?.projects?.edit === true;
  const canDelete = permissions?.projects?.delete === true;
  const transitions = allowedProjectTransitions(project.status);

  const handleDetailSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync({
        operation: 'update_project',
        expected_version: project.row_version,
        name: String(form.get('name') || ''),
        address_line: String(form.get('address_line') || ''),
        suburb: String(form.get('suburb') || ''),
        postcode: String(form.get('postcode') || ''),
        estimated_start_date: String(form.get('estimated_start_date') || '') || null,
        estimated_completion_date: String(form.get('estimated_completion_date') || '') || null,
        shared_summary: String(form.get('shared_summary') || ''),
        builder_notes: String(form.get('builder_notes') || ''),
      });
      toast.success('Project updated');
    } catch (error: any) {
      toast.error(error?.code === 'STALE_VERSION'
        ? 'This project was changed by someone else. Refresh and try again.'
        : error?.message || 'The project could not be updated');
    }
  };

  const handleStatusChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!statusValue || !statusReason.trim()) {
      toast.error('Choose a status and give a reason');
      return;
    }
    try {
      await mutation.mutateAsync({
        operation: 'set_status',
        expected_version: project.row_version,
        status: statusValue,
        reason: statusReason.trim(),
      });
      setStatusValue('');
      setStatusReason('');
      toast.success('Project status updated');
    } catch (error: any) {
      toast.error(error?.message || 'The status could not be changed');
    }
  };

  return (
    <BuilderPortalShell
      title={project.name}
      description={formatProjectAddress(project)}
      actions={
        <>
          <Badge variant="outline" className={PROJECT_STATUS_CLASSES[project.status as BuilderProjectStatus]}>
            {PROJECT_STATUS_LABELS[project.status as BuilderProjectStatus]}
          </Badge>
          <Badge variant="outline">{ACCESS_ROLE_LABELS[accessRole] || accessRole}</Badge>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/projects"><ArrowLeft className="mr-2 h-4 w-4" aria-hidden />All projects</Link>
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-primary" aria-hidden />Developer
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="truncate font-medium text-foreground">
              {developer ? developer.trading_name || developer.legal_name : 'Not appointed'}
            </p>
            {development ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Development: {development.name}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <HardHat className="h-4 w-4 text-primary" aria-hidden />Builder
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="truncate font-medium text-foreground">
              {builder ? builder.trading_name || builder.legal_name : 'Not appointed'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {PROJECT_TYPE_LABELS[project.project_type]}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Programme</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Start: {formatProjectDate(project.estimated_start_date)}</p>
            <p>Completion: {formatProjectDate(project.estimated_completion_date)}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="parties">Parties</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {activation || stockItem ? (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
              {stockItem ? (
                <PropertyInformationCard
                  project={project} item={stockItem} activation={activation}
                  documents={propertyDocuments ?? []}
                />
              ) : null}
              {activation ? (
                <ActivatedByAgencyCard projectId={project.id} activation={activation} />
              ) : null}
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Project details</CardTitle>
              <CardDescription>
                {canEdit
                  ? 'Changes are saved against the version you loaded. If someone else saves first, you will be asked to refresh.'
                  : 'Your access to this project is read-only.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleDetailSave} className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="name">Project name</Label>
                  <Input id="name" name="name" defaultValue={project.name} disabled={!canEdit} required />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="address_line">Address</Label>
                  <Input id="address_line" name="address_line" defaultValue={project.address_line ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="suburb">Suburb</Label>
                  <Input id="suburb" name="suburb" defaultValue={project.suburb ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postcode">Postcode</Label>
                  <Input id="postcode" name="postcode" defaultValue={project.postcode ?? ''} disabled={!canEdit} inputMode="numeric" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="estimated_start_date">Estimated start</Label>
                  <Input id="estimated_start_date" name="estimated_start_date" type="date" defaultValue={project.estimated_start_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="estimated_completion_date">Estimated completion</Label>
                  <Input id="estimated_completion_date" name="estimated_completion_date" type="date" defaultValue={project.estimated_completion_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="shared_summary">Shared summary</Label>
                  <Textarea id="shared_summary" name="shared_summary" rows={3} defaultValue={project.shared_summary ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="builder_notes">Your private notes</Label>
                  <Textarea id="builder_notes" name="builder_notes" rows={3} defaultValue={project.builder_notes ?? ''} disabled={!canEdit} />
                  <p className="text-xs text-muted-foreground">
                    Visible to your organisation only. Never shared with the Command Centre.
                  </p>
                </div>
                {canEdit ? (
                  <div className="sm:col-span-2">
                    <Button type="submit" disabled={mutation.isPending}>
                      {mutation.isPending
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                        : <Save className="mr-2 h-4 w-4" aria-hidden />}
                      Save changes
                    </Button>
                  </div>
                ) : null}
              </form>
            </CardContent>
          </Card>

          {canEdit && transitions.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Change status</CardTitle>
                <CardDescription>
                  A reason is required and is recorded permanently in the project history.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleStatusChange} className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="next-status">New status</Label>
                    <Select value={statusValue} onValueChange={setStatusValue}>
                      <SelectTrigger id="next-status"><SelectValue placeholder="Choose a status" /></SelectTrigger>
                      <SelectContent>
                        {transitions.map((value) => (
                          <SelectItem key={value} value={value}>{PROJECT_STATUS_LABELS[value]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="status-reason">Reason</Label>
                    <Input
                      id="status-reason" value={statusReason}
                      onChange={(event) => setStatusReason(event.target.value)}
                      placeholder="Why is this changing?" required
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button type="submit" disabled={mutation.isPending || !statusValue || !statusReason.trim()}>
                      {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                      Update status
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="parties" className="mt-4">
          <ProjectPartiesPanel
            projectId={project.id} parties={parties} canEdit={canEdit} canDelete={canDelete}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status history</CardTitle>
              <CardDescription>Append-only. Entries cannot be edited or removed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!history.length ? (
                <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No status changes recorded yet.
                </p>
              ) : history.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border/60 p-4 text-sm">
                  <p className="font-medium text-foreground">
                    {entry.from_status
                      ? `${PROJECT_STATUS_LABELS[entry.from_status]} → ${PROJECT_STATUS_LABELS[entry.to_status]}`
                      : PROJECT_STATUS_LABELS[entry.to_status]}
                  </p>
                  {entry.reason ? <p className="mt-1 text-muted-foreground">{entry.reason}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(entry.created_at).toLocaleString('en-AU')} · {entry.changed_by_type.replace(/_/g, ' ')}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </BuilderPortalShell>
  );
}
