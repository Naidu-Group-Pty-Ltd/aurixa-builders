import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, FileWarning, Loader2, Receipt, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  useBuilderClaims, useBuilderCompletion, useBuilderConstructionCase, useBuilderDefects,
  useBuilderDeliveryHistory, useBuilderDeliveryMutation, useBuilderInspections,
  useBuilderVariations,
} from '@/lib/builderQueries';
import {
  CLAIM_STATUS_LABELS, DEFECT_SEVERITY_CLASSES, DEFECT_SEVERITY_LABELS,
  DEFECT_STATUS_CLASSES, DEFECT_STATUS_LABELS, DELIVERY_KIND_LABELS,
  HANDOVER_STATUS_LABELS, INSPECTION_STATUS_LABELS, PC_STATUS_LABELS,
  VARIATION_STATUS_LABELS, WARRANTY_CLAIM_STATUS_LABELS,
  allowedDeliveryTransitions, formatDeliveryDate, formatDeliveryMoney, isDefectOverdue,
  statusLabel, type BuilderDeliveryKind,
} from '@/lib/builderDelivery';

/**
 * External Builder Portal delivery detail — variations, progress claims,
 * inspections, defects, practical completion, handover and warranty for one
 * construction case. Mirrors `BuilderConstructionDetail`: tabbed aggregates,
 * optimistic-concurrency edits carrying `expected_version`, and status changes
 * that require a reason.
 *
 * Every control is rendered from the server-resolved permission matrix on the
 * parent construction case. That is a rendering aid only — the server
 * re-authorises every request through project -> transaction -> case.
 *
 * DATA BOUNDARY: a progress claim shows what was claimed and certified. It shows
 * no payment, receipt or commission: Finance owns those and this page never
 * asks for them.
 */
export default function BuilderDeliveryDetail() {
  const { constructionCaseId = '' } = useParams();
  const caseQuery = useBuilderConstructionCase(constructionCaseId);
  const variations = useBuilderVariations(constructionCaseId);
  const claims = useBuilderClaims(constructionCaseId);
  const inspections = useBuilderInspections(constructionCaseId);
  const defects = useBuilderDefects(constructionCaseId);
  const completion = useBuilderCompletion(constructionCaseId);
  const history = useBuilderDeliveryHistory(constructionCaseId);
  const mutation = useBuilderDeliveryMutation(constructionCaseId);

  const [busyId, setBusyId] = useState('');

  if (caseQuery.isLoading) {
    return (
      <BuilderPortalShell title="Delivery">
        <div className="flex justify-center py-16" role="status" aria-label="Loading delivery">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderPortalShell>
    );
  }

  if (caseQuery.isError || !caseQuery.data) {
    return (
      <BuilderPortalShell title="Delivery">
        <Alert variant="destructive">
          <AlertDescription>
            This construction case could not be loaded. It may not exist, or your access may have
            been changed. <Link to="/builder/construction" className="underline">Back to construction</Link>.
          </AlertDescription>
        </Alert>
      </BuilderPortalShell>
    );
  }

  const { construction_case: record, project, permissions } = caseQuery.data;
  const can = (key: string) => permissions?.[key]?.edit === true;

  const reportError = (error: any, fallback: string) => {
    toast.error(error?.code === 'STALE_VERSION'
      ? 'This record was changed by someone else. Refresh and try again.'
      : error?.message || fallback);
  };

  /** Every status change carries the loaded version and a reason. */
  const changeStatus = async (
    kind: BuilderDeliveryKind, entityId: string, rowVersion: number,
    fromStatus: string, status: string,
  ) => {
    const reason = window.prompt('Give a reason for this change');
    if (!reason || !reason.trim()) return;
    setBusyId(entityId);
    try {
      await mutation.mutateAsync({
        operation: 'set_status',
        kind,
        entity_id: entityId,
        expected_version: rowVersion,
        from_status: fromStatus,
        status,
        reason: reason.trim(),
      });
      toast.success(`${DELIVERY_KIND_LABELS[kind]} updated`);
    } catch (error: any) {
      reportError(error, 'The status could not be changed');
    } finally {
      setBusyId('');
    }
  };

  const addRecord = async (
    event: FormEvent<HTMLFormElement>, operation: string, build: (form: FormData) => Record<string, unknown>,
    label: string,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await mutation.mutateAsync({ operation, ...build(new FormData(form)) });
      form.reset();
      toast.success(`${label} added`);
    } catch (error: any) {
      reportError(error, `The ${label.toLowerCase()} could not be added`);
    }
  };

  const saveCompletion = async (event: FormEvent<HTMLFormElement>, kind: string) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = kind === 'practical_completion' ? completion.data?.practical_completion
      : kind === 'handover' ? completion.data?.handover : completion.data?.warranty;
    try {
      await mutation.mutateAsync({
        operation: 'save_completion',
        kind,
        // The first save creates the row and carries no version; every save
        // after that must carry the one that was loaded.
        expected_version: current?.row_version,
        certificate_reference: String(form.get('certificate_reference') || ''),
        attendee_names: String(form.get('attendee_names') || ''),
        key_set_count: String(form.get('key_set_count') || '') || null,
        provider_name: String(form.get('provider_name') || ''),
        policy_reference: String(form.get('policy_reference') || ''),
        starts_on: String(form.get('starts_on') || '') || null,
        expires_on: String(form.get('expires_on') || '') || null,
        notes: String(form.get('notes') || ''),
      });
      toast.success('Saved');
    } catch (error: any) {
      reportError(error, 'The record could not be saved');
    }
  };

  const statusButtons = (
    kind: BuilderDeliveryKind, id: string, rowVersion: number, status: string,
  ) => (
    <div className="flex flex-wrap justify-end gap-1">
      {allowedDeliveryTransitions(kind, status).map((next) => (
        <Button
          key={next} size="sm" variant="outline"
          disabled={!can(kind === 'variation' ? 'variations'
            : kind === 'progress_claim' ? 'progress_claims'
            : kind === 'inspection' ? 'inspections'
            : kind === 'defect' ? 'defects' : 'handover') || busyId === id}
          onClick={() => void changeStatus(kind, id, rowVersion, status, next)}
        >
          {statusLabel(kind, next)}
        </Button>
      ))}
    </div>
  );

  return (
    <BuilderPortalShell
      title={`Delivery · ${record.case_reference || 'build'}`}
      description={project.name}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to={`/builder/construction/${constructionCaseId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />Build programme
          </Link>
        </Button>
      }
    >
      <Tabs defaultValue="variations">
        <TabsList>
          <TabsTrigger value="variations">Variations</TabsTrigger>
          <TabsTrigger value="claims">Progress claims</TabsTrigger>
          <TabsTrigger value="inspections">Inspections</TabsTrigger>
          <TabsTrigger value="defects">Defects</TabsTrigger>
          <TabsTrigger value="completion">Completion</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="variations">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Variations</CardTitle>
              <CardDescription>
                The customer-facing variation price only — no cost or margin.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {variations.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading variations" />
                </div>
              ) : variations.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>Variations could not be loaded.</AlertDescription>
                </Alert>
              ) : !(variations.data || []).length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No variations recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Variation</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(variations.data || []).map((variation) => (
                        <TableRow key={variation.id}>
                          <TableCell>
                            <span className="font-medium">{variation.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {variation.variation_number || 'No number'} ·
                              {' '}{variation.time_impact_days} day impact
                            </span>
                          </TableCell>
                          <TableCell>{formatDeliveryMoney(variation.variation_price)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {VARIATION_STATUS_LABELS[variation.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {statusButtons('variation', variation.id, variation.row_version,
                              variation.status)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void addRecord(event, 'upsert_variation', (form) => ({
                  title: String(form.get('title') || ''),
                  variation_number: String(form.get('variation_number') || ''),
                  variation_price: String(form.get('variation_price') || '') || null,
                }), 'Variation')}
              >
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="variation_title">Title</Label>
                  <Input id="variation_title" name="title" required disabled={!can('variations')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="variation_price">Price</Label>
                  <Input id="variation_price" name="variation_price" type="number" min={0}
                    disabled={!can('variations')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('variations') || mutation.isPending}>
                    Add variation
                  </Button>
                </div>
                <input type="hidden" name="variation_number" />
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="claims">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <Receipt className="mr-2 inline h-4 w-4 text-primary" aria-hidden />
                Progress claims
              </CardTitle>
              <CardDescription>
                What was claimed and certified. Receipt, reconciliation and commission stay with
                Finance and are not shown here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {claims.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading claims" />
                </div>
              ) : !(claims.data || []).length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No progress claims recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Claim</TableHead>
                        <TableHead>Claimed</TableHead>
                        <TableHead>Certified</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(claims.data || []).map((claim) => (
                        <TableRow key={claim.id}>
                          <TableCell>
                            <span className="font-medium">{claim.claim_number || 'No number'}</span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDeliveryDate(claim.claimed_at)}
                            </span>
                          </TableCell>
                          <TableCell>{formatDeliveryMoney(claim.claimed_amount)}</TableCell>
                          <TableCell>{formatDeliveryMoney(claim.certified_amount)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{CLAIM_STATUS_LABELS[claim.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {statusButtons('progress_claim', claim.id, claim.row_version,
                              claim.status)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void addRecord(event, 'upsert_claim', (form) => ({
                  claim_number: String(form.get('claim_number') || ''),
                  claimed_amount: String(form.get('claimed_amount') || ''),
                }), 'Progress claim')}
              >
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="claim_number">Claim number</Label>
                  <Input id="claim_number" name="claim_number" disabled={!can('progress_claims')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="claimed_amount">Claimed amount</Label>
                  <Input id="claimed_amount" name="claimed_amount" type="number" min={0} required
                    disabled={!can('progress_claims')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('progress_claims') || mutation.isPending}>
                    Add claim
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inspections">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <ClipboardCheck className="mr-2 inline h-4 w-4 text-primary" aria-hidden />
                Inspections
              </CardTitle>
              <CardDescription>Scheduling and outcomes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {inspections.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading inspections" />
                </div>
              ) : !(inspections.data || []).length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No inspections recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Inspection</TableHead>
                        <TableHead className="hidden sm:table-cell">Scheduled</TableHead>
                        <TableHead>Defects</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(inspections.data || []).map((inspection) => (
                        <TableRow key={inspection.id}>
                          <TableCell>
                            <span className="font-medium">{inspection.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {inspection.inspector_name || 'No inspector recorded'}
                            </span>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {formatDeliveryDate(inspection.scheduled_for)}
                          </TableCell>
                          <TableCell>{inspection.defect_count}</TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {INSPECTION_STATUS_LABELS[inspection.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {statusButtons('inspection', inspection.id, inspection.row_version,
                              inspection.status)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void addRecord(event, 'upsert_inspection', (form) => ({
                  title: String(form.get('title') || ''),
                  inspector_name: String(form.get('inspector_name') || ''),
                  scheduled_for: String(form.get('scheduled_for') || '') || null,
                }), 'Inspection')}
              >
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="inspection_title">Title</Label>
                  <Input id="inspection_title" name="title" required disabled={!can('inspections')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inspection_schedule">Scheduled for</Label>
                  <Input id="inspection_schedule" name="scheduled_for" type="datetime-local"
                    disabled={!can('inspections')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('inspections') || mutation.isPending}>
                    Schedule
                  </Button>
                </div>
                <input type="hidden" name="inspector_name" />
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="defects">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <FileWarning className="mr-2 inline h-4 w-4 text-primary" aria-hidden />
                Defects
              </CardTitle>
              <CardDescription>
                A quality record. No rectification cost is held or shown.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {defects.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading defects" />
                </div>
              ) : !(defects.data || []).length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No defects recorded for this build.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Defect</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead className="hidden sm:table-cell">Due</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(defects.data || []).map((defect) => (
                        <TableRow key={defect.id}>
                          <TableCell>
                            <span className="font-medium">{defect.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {defect.location || 'No location recorded'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={DEFECT_SEVERITY_CLASSES[defect.severity]}>
                              {DEFECT_SEVERITY_LABELS[defect.severity]}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {formatDeliveryDate(defect.due_date)}
                            {isDefectOverdue(defect) ? (
                              <span className="block text-xs text-destructive">Overdue</span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={DEFECT_STATUS_CLASSES[defect.status]}>
                              {DEFECT_STATUS_LABELS[defect.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {statusButtons('defect', defect.id, defect.row_version, defect.status)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void addRecord(event, 'upsert_defect', (form) => ({
                  title: String(form.get('title') || ''),
                  location: String(form.get('location') || ''),
                  severity: String(form.get('severity') || 'minor'),
                  due_date: String(form.get('due_date') || '') || null,
                }), 'Defect')}
              >
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="defect_title">Title</Label>
                  <Input id="defect_title" name="title" required disabled={!can('defects')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="defect_severity">Severity</Label>
                  <select
                    id="defect_severity" name="severity" defaultValue="minor" disabled={!can('defects')}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {Object.entries(DEFECT_SEVERITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('defects') || mutation.isPending}>
                    Raise defect
                  </Button>
                </div>
                <input type="hidden" name="location" />
                <input type="hidden" name="due_date" />
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completion" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Practical completion</CardTitle>
              <CardDescription>
                Status {completion.data?.practical_completion
                  ? PC_STATUS_LABELS[completion.data.practical_completion.status]
                  : 'not started'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form className="grid gap-3 sm:grid-cols-3"
                onSubmit={(event) => void saveCompletion(event, 'practical_completion')}>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="pc_reference">Certificate reference</Label>
                  <Input id="pc_reference" name="certificate_reference"
                    defaultValue={completion.data?.practical_completion?.certificate_reference ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('handover') || mutation.isPending}>Save</Button>
                </div>
              </form>
              {completion.data?.practical_completion ? statusButtons(
                'practical_completion',
                completion.data.practical_completion.id,
                completion.data.practical_completion.row_version,
                completion.data.practical_completion.status) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Handover</CardTitle>
              <CardDescription>
                Status {completion.data?.handover
                  ? HANDOVER_STATUS_LABELS[completion.data.handover.status]
                  : 'not started'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form className="grid gap-3 sm:grid-cols-3"
                onSubmit={(event) => void saveCompletion(event, 'handover')}>
                <div className="space-y-1.5">
                  <Label htmlFor="ho_attendees">Attendees</Label>
                  <Input id="ho_attendees" name="attendee_names"
                    defaultValue={completion.data?.handover?.attendee_names ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ho_keys">Key sets</Label>
                  <Input id="ho_keys" name="key_set_count" type="number" min={0}
                    defaultValue={completion.data?.handover?.key_set_count ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('handover') || mutation.isPending}>Save</Button>
                </div>
              </form>
              {completion.data?.handover ? statusButtons(
                'handover', completion.data.handover.id,
                completion.data.handover.row_version,
                completion.data.handover.status) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <ShieldCheck className="mr-2 inline h-4 w-4 text-primary" aria-hidden />
                Warranty
              </CardTitle>
              <CardDescription>
                {completion.data?.warranty
                  ? `Expires ${formatDeliveryDate(completion.data.warranty.expires_on)}`
                  : 'No warranty recorded'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void saveCompletion(event, 'warranty')}>
                <div className="space-y-1.5">
                  <Label htmlFor="wr_provider">Provider</Label>
                  <Input id="wr_provider" name="provider_name"
                    defaultValue={completion.data?.warranty?.provider_name ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wr_starts">Starts</Label>
                  <Input id="wr_starts" name="starts_on" type="date"
                    defaultValue={completion.data?.warranty?.starts_on ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wr_expires">Expires</Label>
                  <Input id="wr_expires" name="expires_on" type="date"
                    defaultValue={completion.data?.warranty?.expires_on ?? ''}
                    disabled={!can('handover')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('handover') || mutation.isPending}>Save</Button>
                </div>
              </form>

              {!(completion.data?.warranty_claims || []).length ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No warranty claims lodged.
                </p>
              ) : (
                <ul className="space-y-2">
                  {(completion.data?.warranty_claims || []).map((claim) => (
                    <li key={claim.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                      <div>
                        <span className="font-medium">{claim.title}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {WARRANTY_CLAIM_STATUS_LABELS[claim.status]}
                        </span>
                      </div>
                      {statusButtons('warranty_claim', claim.id, claim.row_version, claim.status)}
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => void addRecord(event, 'upsert_warranty_claim', (form) => ({
                  title: String(form.get('title') || ''),
                  warranty_id: completion.data?.warranty?.id,
                }), 'Warranty claim')}
              >
                <div className="space-y-1.5 sm:col-span-3">
                  <Label htmlFor="wc_title">New warranty claim</Label>
                  <Input id="wc_title" name="title" required disabled={!can('handover')} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!can('handover') || mutation.isPending}>Lodge</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delivery history</CardTitle>
              <CardDescription>Append-only. Entries cannot be edited or removed.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading history" />
                </div>
              ) : !(history.data || []).length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No delivery changes recorded yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {(history.data || []).map((entry) => (
                    <li key={entry.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{DELIVERY_KIND_LABELS[entry.entity_kind]}</Badge>
                        <span className="font-medium">
                          {entry.from_status
                            ? `${statusLabel(entry.entity_kind, entry.from_status)} → `
                            : ''}
                          {statusLabel(entry.entity_kind, entry.to_status)}
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
        </TabsContent>
      </Tabs>
    </BuilderPortalShell>
  );
}
