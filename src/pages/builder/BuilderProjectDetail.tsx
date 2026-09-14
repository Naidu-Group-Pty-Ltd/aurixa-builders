import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, HardHat, Loader2, Save, Users } from 'lucide-react';
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
import { useBuilderProject, useBuilderProjectMutation } from '@/lib/builderQueries';
import {
  ACCESS_ROLE_LABELS, PARTY_ROLE_LABELS, PROJECT_STATUS_CLASSES, PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS, allowedProjectTransitions, formatProjectAddress, formatProjectDate,
  type BuilderProjectStatus,
} from '@/lib/builderProjects';

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
  } = query.data;

  const canEdit = permissions?.projects?.edit === true;
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-primary" aria-hidden />Project parties
              </CardTitle>
              <CardDescription>Everyone recorded against this project.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!parties.length ? (
                <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No parties recorded yet.
                </p>
              ) : parties.map((party) => (
                <div key={party.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/60 p-4">
                  <div className="min-w-0">
                    {/* A div, not a p: Badge renders a div, and a div inside a
                        p is invalid HTML that the browser silently reflows. */}
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{party.name}</span>
                      {party.is_primary_contact ? <Badge variant="outline">Primary</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {PARTY_ROLE_LABELS[party.role] || party.role}
                      {party.organisation ? ` · ${party.organisation}` : ''}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {party.email ? <p className="truncate">{party.email}</p> : null}
                    {party.phone ? <p>{party.phone}</p> : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
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
