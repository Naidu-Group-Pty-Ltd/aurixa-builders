import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarClock, Camera, Flag, Layers, Loader2, Save,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { DimensionRail } from '@/components/builder-portal/ui/DimensionRail';
import {
  isOffSequenceStatus, railIndexFromStages, railIndexFromStatus, railNoteForStatus,
  railStationsFromStages, railStationsFromStatuses, stageDwellAnnotation,
} from '@/lib/builderConstructionRail.pure';
import {
  fetchBuilderPhotographUrl, useBuilderConstructionCase, useBuilderConstructionMutation,
} from '@/lib/builderQueries';
import {
  CONSTRUCTION_DATE_KIND_LABELS, CONSTRUCTION_STAGE_KEY_LABELS,
  CONSTRUCTION_STAGE_STATUS_LABELS, CONSTRUCTION_STATUS_CLASSES, CONSTRUCTION_STATUS_LABELS,
  MILESTONE_STATUS_CLASSES, MILESTONE_STATUS_LABELS,
  allowedConstructionTransitions, allowedMilestoneTransitions,
  formatConstructionDate, formatPercentComplete,
  type BuilderConstructionDateKind, type BuilderConstructionStageKey,
  type BuilderConstructionStageStatus, type BuilderConstructionStatus,
  type BuilderMilestoneStatus,
} from '@/lib/builderConstruction';

/**
 * External Builder Portal construction detail. Mirrors
 * `BuilderTransactionDetail`: overview / stages / milestones / progress /
 * photographs / history tabs, optimistic-concurrency edits carrying
 * `expected_version`, and status and date changes that require a reason.
 *
 * Every control is rendered from the server-resolved permission matrix. That is
 * a rendering aid only — the server re-authorises every request through the
 * case's parent transaction and project.
 *
 * Photograph bytes are fetched through a short-lived signed URL that the server
 * mints only after re-resolving the grant. No storage path reaches the browser.
 */
export default function BuilderConstructionDetail() {
  const { constructionCaseId = '' } = useParams();
  const query = useBuilderConstructionCase(constructionCaseId);
  const mutation = useBuilderConstructionMutation(constructionCaseId);

  const [statusValue, setStatusValue] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  /*
   * The clock, read once.
   *
   * The rail's extent annotation is "how long has this build stood here",
   * which needs a now — and a `Date.now()` during render is impure: two
   * renders nothing asked for can disagree. A lazy initialiser reads it once
   * per mount and every render after that agrees with the first.
   *
   * It sits HERE, above the two early returns below, because a hook after an
   * early return is called on some renders and not others — the defect that
   * made AmlConfiguration read "Something went wrong" on every visit.
   */
  const [renderedAt] = useState(() => Date.now());

  if (query.isLoading) {
    return (
      <BuilderPortalShell title="Construction">
        <div className="flex justify-center py-16" role="status" aria-label="Loading construction case">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderPortalShell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <BuilderPortalShell title="Construction">
        <Alert variant="destructive">
          <AlertDescription>
            This construction case could not be loaded. It may not exist, or your access may have
            been changed. <Link to="/builder/construction" className="underline">Back to construction</Link>.
          </AlertDescription>
        </Alert>
      </BuilderPortalShell>
    );
  }

  const {
    construction_case: record, project, unit, stages, milestones,
    progress_updates: updates, photographs, status_history: history,
    date_history: dateHistory, permissions,
  } = query.data;

  const canEdit = permissions?.construction?.edit === true;
  const canDelete = permissions?.construction?.delete === true;
  const transitions = allowedConstructionTransitions(record.status);

  /*
   * What the hero's dimension rail is drawn from.
   *
   * The build's own stages are the extent where it has them, because a
   * builder may not run every stage and a rail showing stations this build
   * does not have is measuring somebody else's job. Otherwise the case's
   * lifecycle status carries it.
   *
   * An off-sequence status (on hold, cancelled) has NO position on either —
   * the pure module returns null and the rail states the absence rather than
   * marking a station the record does not name.
   */
  const offSequence = isOffSequenceStatus(record.status);
  const hasStageRows = stages.some((stage) => stage.stage_key !== 'other');
  const railStages = hasStageRows
    ? railStationsFromStages(stages)
    : railStationsFromStatuses();
  const railIndex = offSequence
    ? null
    : hasStageRows
      ? railIndexFromStages(stages)
      : railIndexFromStatus(record.status);

  /*
   * The annotated extent over the current station — how long the build has
   * stood there. Read from the stage's own `actual_start_date`, so it is
   * absent rather than estimated where the stage was never dated, and it is
   * never shown for a status-only rail, which carries no dates at all.
   */
  const railAnnotation = railIndex !== null && hasStageRows
    ? stageDwellAnnotation(
        stages.find((row) => row.id === railStages[railIndex]?.key)?.actual_start_date,
        renderedAt,
      )
    : null;

  const reportError = (error: any, fallback: string) => {
    toast.error(error?.code === 'STALE_VERSION'
      ? 'This construction case was changed by someone else. Refresh and try again.'
      : error?.message || fallback);
  };

  const handleDetailSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync({
        operation: 'update_case',
        expected_version: record.row_version,
        site_supervisor_name: String(form.get('site_supervisor_name') || ''),
        site_supervisor_email: String(form.get('site_supervisor_email') || ''),
        site_supervisor_phone: String(form.get('site_supervisor_phone') || ''),
        percent_complete: String(form.get('percent_complete') || '') || null,
        weather_delay_days: String(form.get('weather_delay_days') || '') || null,
        variation_delay_days: String(form.get('variation_delay_days') || '') || null,
        shared_summary: String(form.get('shared_summary') || ''),
        builder_notes: String(form.get('builder_notes') || ''),
      });
      toast.success('Construction case updated');
    } catch (error: any) {
      reportError(error, 'The construction case could not be updated');
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
        expected_version: record.row_version,
        status: statusValue,
        reason: statusReason.trim(),
      });
      setStatusValue('');
      setStatusReason('');
      toast.success('Construction status updated');
    } catch (error: any) {
      reportError(error, 'The status could not be changed');
    }
  };

  const handleDateChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('date_reason') || '');
    if (!reason.trim()) {
      toast.error('A reason is required for every date change');
      return;
    }
    try {
      await mutation.mutateAsync({
        operation: 'set_date',
        expected_version: record.row_version,
        date_kind: String(form.get('date_kind') || 'estimated_completion'),
        new_date: String(form.get('new_date') || '') || null,
        reason: reason.trim(),
      });
      toast.success('Date updated');
    } catch (error: any) {
      reportError(error, 'The date could not be changed');
    }
  };

  const handleMilestoneStatus = async (
    milestoneId: string, rowVersion: number, status: BuilderMilestoneStatus,
  ) => {
    const reason = window.prompt('Give a reason for this change');
    if (!reason || !reason.trim()) return;
    try {
      await mutation.mutateAsync({
        operation: 'set_milestone_status',
        milestone_id: milestoneId,
        expected_version: rowVersion,
        status,
        reason: reason.trim(),
      });
      toast.success('Milestone updated');
    } catch (error: any) {
      reportError(error, 'The milestone could not be updated');
    }
  };

  const handleProgressAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await mutation.mutateAsync({
        operation: 'add_progress',
        title: String(data.get('title') || ''),
        body: String(data.get('body') || ''),
        percent_complete: String(data.get('progress_percent') || '') || null,
      });
      form.reset();
      toast.success('Progress update added');
    } catch (error: any) {
      reportError(error, 'The update could not be added');
    }
  };

  const handlePhotographDelete = async (photographId: string) => {
    try {
      await mutation.mutateAsync({ operation: 'delete_photograph', photograph_id: photographId });
      toast.success('Photograph removed');
    } catch (error: any) {
      reportError(error, 'The photograph could not be removed');
    }
  };

  /** The signed URL is minted per request and expires in minutes. */
  const revealPhotograph = async (photographId: string) => {
    try {
      const { url } = await fetchBuilderPhotographUrl(constructionCaseId, photographId);
      setPhotoUrls((current) => ({ ...current, [photographId]: url }));
    } catch (error: any) {
      reportError(error, 'The photograph could not be opened');
    }
  };

  return (
    <BuilderPortalShell
      title={record.case_reference || 'Construction'}
      description={`${project.name}${unit ? ` · Unit ${unit.unit_number}` : ''}`}
      /*
       * THE DIMENSION RAIL, ON THE ONE RECORD THAT IS ACTUALLY A SEQUENCE.
       *
       * A build runs site preparation → base → frame → lock-up → fixing →
       * practical completion → handover, and `construction_stages` already
       * carries exactly that with its own `sequence_number`. The page drew it
       * as "4 of 7 stages complete" under a progress bar — a percentage,
       * which answers how much and never which.
       *
       * Where the build has no stage rows the case's own lifecycle status is
       * the extent instead; `builderConstructionRail.pure.ts` decides both,
       * and returns no position rather than guessing one for a status that is
       * not a point on the line (on hold, cancelled).
       */
      aside={
        <DimensionRail
          stages={railStages}
          currentIndex={railIndex}
          annotation={railAnnotation}
          note={
            railNoteForStatus(record.status)
            ?? (railIndex !== null
              ? `Stage ${railIndex + 1} of ${railStages.length}`
              : null)
          }
        />
      }
      actions={
        <>
          <Badge
            variant="outline"
            className={CONSTRUCTION_STATUS_CLASSES[record.status as BuilderConstructionStatus]}
          >
            {CONSTRUCTION_STATUS_LABELS[record.status as BuilderConstructionStatus]}
          </Badge>
          <Badge variant="outline">{formatPercentComplete(record.percent_complete)}</Badge>
          <Button asChild variant="outline" size="sm">
            <Link to={`/builder/construction/${constructionCaseId}/delivery`}>
              Delivery
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/construction">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />All construction
            </Link>
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="h-4 w-4 text-primary" aria-hidden />Programme
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {formatConstructionDate(record.estimated_completion_date)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Started {formatConstructionDate(record.site_start_date)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Layers className="h-4 w-4 text-primary" aria-hidden />Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Progress value={Number(record.percent_complete)} className="h-2" />
            <p className="mt-2 text-xs text-muted-foreground">
              {stages.filter((s) => s.status === 'complete').length} of {stages.length} stages complete
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Flag className="h-4 w-4 text-primary" aria-hidden />Delays
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {record.weather_delay_days + record.variation_delay_days} days
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {record.weather_delay_days} weather · {record.variation_delay_days} variation
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="stages">Stages</TabsTrigger>
          <TabsTrigger value="milestones">Milestones</TabsTrigger>
          <TabsTrigger value="progress">Progress</TabsTrigger>
          <TabsTrigger value="photographs">Photographs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Build details</CardTitle>
              <CardDescription>
                {canEdit
                  ? 'Changes carry the version you loaded; a conflicting edit is rejected.'
                  : 'You have read-only access to this construction case.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleDetailSave}>
                <div className="space-y-1.5">
                  <Label htmlFor="site_supervisor_name">Site supervisor</Label>
                  <Input id="site_supervisor_name" name="site_supervisor_name"
                    defaultValue={record.site_supervisor_name ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="site_supervisor_email">Supervisor email</Label>
                  <Input id="site_supervisor_email" name="site_supervisor_email" type="email"
                    defaultValue={record.site_supervisor_email ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="site_supervisor_phone">Supervisor phone</Label>
                  <Input id="site_supervisor_phone" name="site_supervisor_phone"
                    defaultValue={record.site_supervisor_phone ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="percent_complete">Percent complete</Label>
                  <Input id="percent_complete" name="percent_complete" type="number" min={0} max={100}
                    step="0.01" defaultValue={record.percent_complete ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="weather_delay_days">Weather delay (days)</Label>
                  <Input id="weather_delay_days" name="weather_delay_days" type="number" min={0}
                    defaultValue={record.weather_delay_days} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="variation_delay_days">Variation delay (days)</Label>
                  <Input id="variation_delay_days" name="variation_delay_days" type="number" min={0}
                    defaultValue={record.variation_delay_days} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="shared_summary">Shared summary</Label>
                  <Textarea id="shared_summary" name="shared_summary" rows={2}
                    defaultValue={record.shared_summary ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="builder_notes">Builder notes (private)</Label>
                  <Textarea id="builder_notes" name="builder_notes" rows={3}
                    defaultValue={record.builder_notes ?? ''} disabled={!canEdit} />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>
                    <Save className="mr-2 h-4 w-4" aria-hidden />Save changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status</CardTitle>
                <CardDescription>
                  {transitions.length
                    ? 'A reason is recorded with every change.'
                    : 'This build has reached a terminal status.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleStatusChange}>
                  <div className="space-y-1.5">
                    <Label htmlFor="construction_status">New status</Label>
                    <Select value={statusValue} onValueChange={setStatusValue}
                      disabled={!canEdit || !transitions.length}>
                      <SelectTrigger id="construction_status">
                        <SelectValue placeholder="Choose a status" />
                      </SelectTrigger>
                      <SelectContent>
                        {transitions.map((value) => (
                          <SelectItem key={value} value={value}>
                            {CONSTRUCTION_STATUS_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="construction_status_reason">Reason</Label>
                    <Input id="construction_status_reason" value={statusReason}
                      onChange={(event) => setStatusReason(event.target.value)}
                      disabled={!canEdit || !transitions.length} />
                  </div>
                  <Button type="submit"
                    disabled={!canEdit || !transitions.length || mutation.isPending}>
                    Change status
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dates</CardTitle>
                <CardDescription>
                  Every date change records its previous value and a reason, so slippage is
                  auditable rather than silent.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleDateChange}>
                  <div className="space-y-1.5">
                    <Label htmlFor="date_kind">Date</Label>
                    <select
                      id="date_kind" name="date_kind" defaultValue="estimated_completion"
                      disabled={!canEdit}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {(Object.keys(CONSTRUCTION_DATE_KIND_LABELS) as BuilderConstructionDateKind[])
                        .map((value) => (
                          <option key={value} value={value}>
                            {CONSTRUCTION_DATE_KIND_LABELS[value]}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new_date">New date</Label>
                    <Input id="new_date" name="new_date" type="date" disabled={!canEdit} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="date_reason">Reason</Label>
                    <Input id="date_reason" name="date_reason" disabled={!canEdit} />
                  </div>
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>Change date</Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="stages">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Construction stages</CardTitle>
              <CardDescription>The build programme in sequence.</CardDescription>
            </CardHeader>
            <CardContent>
              {!stages.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No stages recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Stage</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">Planned</TableHead>
                        <TableHead className="hidden md:table-cell">Actual</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stages.map((stage) => (
                        <TableRow key={stage.id}>
                          <TableCell>
                            <span className="font-medium">{stage.sequence_number}. {stage.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {CONSTRUCTION_STAGE_KEY_LABELS[
                                stage.stage_key as BuilderConstructionStageKey]}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {CONSTRUCTION_STAGE_STATUS_LABELS[
                                stage.status as BuilderConstructionStageStatus]}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {formatConstructionDate(stage.planned_end_date)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {formatConstructionDate(stage.actual_end_date)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="milestones">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Milestones</CardTitle>
              <CardDescription>
                Programme events. A milestone carries no amount — payments stay with Finance.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!milestones.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No milestones recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Milestone</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">Planned</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {milestones.map((milestone) => (
                        <TableRow key={milestone.id}>
                          <TableCell>
                            <span className="font-medium">{milestone.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {milestone.achieved_date
                                ? `Achieved ${formatConstructionDate(milestone.achieved_date)}`
                                : 'Not yet achieved'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={MILESTONE_STATUS_CLASSES[milestone.status]}
                            >
                              {MILESTONE_STATUS_LABELS[milestone.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {formatConstructionDate(milestone.planned_date)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {allowedMilestoneTransitions(milestone.status).map((next) => (
                                <Button
                                  key={next} size="sm" variant="outline"
                                  disabled={!canEdit || mutation.isPending}
                                  onClick={() => void handleMilestoneStatus(
                                    milestone.id, milestone.row_version, next)}
                                >
                                  {MILESTONE_STATUS_LABELS[next]}
                                </Button>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="progress">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Progress updates</CardTitle>
              <CardDescription>The newest update sets the headline percentage.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!updates.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No progress updates recorded for this build.
                </p>
              ) : (
                <ol className="space-y-3">
                  {updates.map((update) => (
                    <li key={update.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{update.title}</span>
                        {update.percent_complete !== null ? (
                          <Badge variant="outline">
                            {formatPercentComplete(update.percent_complete)}
                          </Badge>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {formatConstructionDate(update.update_date)}
                        </span>
                      </div>
                      {update.body ? (
                        <p className="mt-1 text-xs text-muted-foreground">{update.body}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}

              <form className="grid gap-3 sm:grid-cols-4" onSubmit={handleProgressAdd}>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="progress_title">Title</Label>
                  <Input id="progress_title" name="title" required disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="progress_percent">Percent</Label>
                  <Input id="progress_percent" name="progress_percent" type="number" min={0}
                    max={100} step="0.01" disabled={!canEdit} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>Add update</Button>
                </div>
                <div className="space-y-1.5 sm:col-span-4">
                  <Label htmlFor="progress_body">Detail</Label>
                  <Textarea id="progress_body" name="body" rows={2} disabled={!canEdit} />
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="photographs">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Site photographs</CardTitle>
              <CardDescription>
                Images open through a short-lived link the server issues after re-checking your
                access. No storage path reaches this page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!photographs.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  <Camera className="mx-auto mb-2 h-6 w-6" aria-hidden />
                  No photographs recorded for this build.
                </p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {photographs.map((photograph) => (
                    <li key={photograph.id} className="rounded-lg border p-3 text-sm">
                      {photoUrls[photograph.id] ? (
                        <img
                          src={photoUrls[photograph.id]}
                          alt={photograph.caption || photograph.file_name}
                          className="mb-2 max-h-48 w-full rounded object-cover"
                        />
                      ) : null}
                      <p className="truncate font-medium">{photograph.file_name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {photograph.caption || 'No caption'}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="outline"
                          onClick={() => void revealPhotograph(photograph.id)}>
                          View
                        </Button>
                        <Button size="sm" variant="outline" disabled={!canDelete || mutation.isPending}
                          onClick={() => void handlePhotographDelete(photograph.id)}>
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status history</CardTitle>
              <CardDescription>Append-only. Entries cannot be edited or removed.</CardDescription>
            </CardHeader>
            <CardContent>
              {!history.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No status changes recorded yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {history.map((entry) => (
                    <li key={entry.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{entry.entity_kind}</Badge>
                        <span className="font-medium">
                          {entry.from_status ? `${entry.from_status} → ` : ''}{entry.to_status}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.created_at).toLocaleString('en-AU')}
                        </span>
                      </div>
                      {entry.reason ? (
                        <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Date history</CardTitle>
              <CardDescription>Every estimate change, with its previous value.</CardDescription>
            </CardHeader>
            <CardContent>
              {!dateHistory.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No date changes recorded yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {dateHistory.map((entry) => (
                    <li key={entry.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {CONSTRUCTION_DATE_KIND_LABELS[entry.date_kind]}
                        </Badge>
                        <span className="font-medium">
                          {formatConstructionDate(entry.from_date)} → {formatConstructionDate(entry.to_date)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.created_at).toLocaleString('en-AU')}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </BuilderPortalShell>
  );
}
