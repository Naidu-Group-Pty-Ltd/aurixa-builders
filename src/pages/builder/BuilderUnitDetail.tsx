import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Loader2, Save, Tag, Users } from 'lucide-react';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { useBuilderUnit, useBuilderUnitMutation } from '@/lib/builderQueries';
import {
  ALLOCATION_TYPE_LABELS, AVAILABILITY_STATUS_CLASSES, AVAILABILITY_STATUS_LABELS,
  PRICE_BASIS_LABELS, RELEASE_STATUS_CLASSES, RELEASE_STATUS_LABELS,
  RESERVATION_STATUS_CLASSES, RESERVATION_STATUS_LABELS, UNIT_TYPE_LABELS,
  allowedAvailabilityTransitions, allowedReleaseTransitions, allowedReservationTransitions,
  formatListPrice, formatUnitArea, formatUnitConfiguration,
  type BuilderAvailabilityStatus, type BuilderPriceBasis, type BuilderReleaseStatus,
  type BuilderReservationStatus,
} from '@/lib/builderInventory';

/**
 * External Builder Portal unit detail. Mirrors `BuilderProjectDetail`:
 * overview / commercial / history tabs, optimistic-concurrency edits carrying
 * `expected_version`, and status changes that require a reason.
 *
 * Every control is rendered from the server-resolved permission matrix. That is
 * a rendering aid only — the server re-authorises every request through the
 * unit's parent project, so hiding a button is never what prevents an action.
 */
export default function BuilderUnitDetail() {
  const { unitId = '' } = useParams();
  const query = useBuilderUnit(unitId);
  const mutation = useBuilderUnitMutation(unitId);

  const [availabilityValue, setAvailabilityValue] = useState('');
  const [availabilityReason, setAvailabilityReason] = useState('');
  const [releaseValue, setReleaseValue] = useState('');
  const [releaseReason, setReleaseReason] = useState('');

  if (query.isLoading) {
    return (
      <BuilderPortalShell title="Unit">
        <div className="flex justify-center py-16" role="status" aria-label="Loading unit">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderPortalShell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <BuilderPortalShell title="Unit">
        <Alert variant="destructive">
          <AlertDescription>
            This unit could not be loaded. It may not exist, or your access may have been
            changed. <Link to="/builder/inventory" className="underline">Back to inventory</Link>.
          </AlertDescription>
        </Alert>
      </BuilderPortalShell>
    );
  }

  const {
    unit, project, current_price: price, status_history: history,
    holds, reservations, allocations, stage, building, lot, permissions,
  } = query.data;

  const canEdit = permissions?.inventory?.edit === true;
  const canPrice = permissions?.pricing?.edit === true;
  const canSeeReservations = permissions?.reservations?.view === true;
  const canReserve = permissions?.reservations?.edit === true;

  const availabilityTransitions = allowedAvailabilityTransitions(unit.availability_status);
  const releaseTransitions = allowedReleaseTransitions(unit.release_status);

  const reportError = (error: any, fallback: string) => {
    toast.error(error?.code === 'STALE_VERSION'
      ? 'This unit was changed by someone else. Refresh and try again.'
      : error?.message || fallback);
  };

  const handleDetailSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync({
        operation: 'update_unit',
        expected_version: unit.row_version,
        unit_number: String(form.get('unit_number') || ''),
        bedrooms: String(form.get('bedrooms') || '') || null,
        bathrooms: String(form.get('bathrooms') || '') || null,
        car_spaces: String(form.get('car_spaces') || '') || null,
        internal_area_sqm: String(form.get('internal_area_sqm') || '') || null,
        external_area_sqm: String(form.get('external_area_sqm') || '') || null,
        estimated_completion_date: String(form.get('estimated_completion_date') || '') || null,
        description: String(form.get('description') || ''),
      });
      toast.success('Unit updated');
    } catch (error: any) {
      reportError(error, 'The unit could not be updated');
    }
  };

  const handleAvailabilityChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!availabilityValue || !availabilityReason.trim()) {
      toast.error('Choose a status and give a reason');
      return;
    }
    try {
      await mutation.mutateAsync({
        operation: 'set_availability',
        expected_version: unit.row_version,
        status: availabilityValue,
        reason: availabilityReason.trim(),
      });
      setAvailabilityValue('');
      setAvailabilityReason('');
      toast.success('Availability updated');
    } catch (error: any) {
      reportError(error, 'The availability could not be changed');
    }
  };

  const handleReleaseChange = async (event: FormEvent) => {
    event.preventDefault();
    if (!releaseValue || !releaseReason.trim()) {
      toast.error('Choose a release state and give a reason');
      return;
    }
    try {
      await mutation.mutateAsync({
        operation: 'set_release',
        expected_version: unit.row_version,
        status: releaseValue,
        reason: releaseReason.trim(),
      });
      setReleaseValue('');
      setReleaseReason('');
      toast.success('Release state updated');
    } catch (error: any) {
      reportError(error, error?.code === 'PRICE_REQUIRED'
        ? 'Set a price before releasing this unit'
        : 'The release state could not be changed');
    }
  };

  const handlePriceSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const listPrice = String(form.get('list_price') || '');
    if (!listPrice) {
      toast.error('Enter a list price');
      return;
    }
    try {
      await mutation.mutateAsync({
        operation: 'set_price',
        list_price: listPrice,
        price_basis: String(form.get('price_basis') || 'fixed'),
        reason: String(form.get('price_reason') || ''),
      });
      toast.success('Price updated');
    } catch (error: any) {
      reportError(error, 'The price could not be updated');
    }
  };

  const handleReservationStatus = async (
    reservationId: string, rowVersion: number, status: BuilderReservationStatus,
  ) => {
    const reason = window.prompt('Give a reason for this change');
    if (!reason || !reason.trim()) return;
    try {
      await mutation.mutateAsync({
        operation: 'set_reservation_status',
        reservation_id: reservationId,
        expected_version: rowVersion,
        status,
        reason: reason.trim(),
      });
      toast.success('Reservation updated');
    } catch (error: any) {
      reportError(error, 'The reservation could not be updated');
    }
  };

  return (
    <BuilderPortalShell
      title={`Unit ${unit.unit_number}`}
      description={`${project.name} · ${formatUnitConfiguration(unit)}`}
      actions={
        <>
          <Badge
            variant="outline"
            className={AVAILABILITY_STATUS_CLASSES[
              unit.availability_status as BuilderAvailabilityStatus]}
          >
            {AVAILABILITY_STATUS_LABELS[unit.availability_status as BuilderAvailabilityStatus]}
          </Badge>
          <Badge
            variant="outline"
            className={RELEASE_STATUS_CLASSES[unit.release_status as BuilderReleaseStatus]}
          >
            {RELEASE_STATUS_LABELS[unit.release_status as BuilderReleaseStatus]}
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/inventory">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />All inventory
            </Link>
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Tag className="h-4 w-4 text-primary" aria-hidden />List price
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {formatListPrice(price?.list_price ?? null, price?.price_basis ?? null)}
            </p>
            {price ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {PRICE_BASIS_LABELS[price.price_basis as BuilderPriceBasis]}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Boxes className="h-4 w-4 text-primary" aria-hidden />Structure
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="truncate font-medium text-foreground">
              {stage ? stage.name : 'No stage'}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {building ? `Building ${building.name}` : lot ? `Lot ${lot.lot_number}` : 'No building or lot'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-primary" aria-hidden />Commercial
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {canSeeReservations
                ? `${reservations.filter((r) => r.status === 'active').length} live reservation(s)`
                : 'Not visible to you'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {allocations.filter((a) => a.status === 'active').length} active allocation(s)
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="commercial">Commercial</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Unit details</CardTitle>
              <CardDescription>
                {canEdit
                  ? 'Changes carry the version you loaded; a conflicting edit is rejected.'
                  : 'You have read-only access to this unit.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleDetailSave}>
                <div className="space-y-1.5">
                  <Label htmlFor="unit_number">Unit number</Label>
                  <Input id="unit_number" name="unit_number" defaultValue={unit.unit_number}
                    disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="unit_type_display">Type</Label>
                  <Input id="unit_type_display" value={UNIT_TYPE_LABELS[unit.unit_type]} readOnly disabled />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bedrooms">Bedrooms</Label>
                  <Input id="bedrooms" name="bedrooms" type="number" min={0} max={20}
                    defaultValue={unit.bedrooms ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bathrooms">Bathrooms</Label>
                  <Input id="bathrooms" name="bathrooms" type="number" min={0} max={20} step="0.5"
                    defaultValue={unit.bathrooms ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="car_spaces">Car spaces</Label>
                  <Input id="car_spaces" name="car_spaces" type="number" min={0} max={20}
                    defaultValue={unit.car_spaces ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="internal_area_sqm">Internal area (m²)</Label>
                  <Input id="internal_area_sqm" name="internal_area_sqm" type="number" step="0.01"
                    defaultValue={unit.internal_area_sqm ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="external_area_sqm">External area (m²)</Label>
                  <Input id="external_area_sqm" name="external_area_sqm" type="number" step="0.01"
                    defaultValue={unit.external_area_sqm ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="estimated_completion_date">Estimated completion</Label>
                  <Input id="estimated_completion_date" name="estimated_completion_date" type="date"
                    defaultValue={unit.estimated_completion_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea id="description" name="description" rows={3}
                    defaultValue={unit.description ?? ''} disabled={!canEdit} />
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
                <CardTitle className="text-base">Availability</CardTitle>
                <CardDescription>
                  {availabilityTransitions.length
                    ? 'A reason is recorded with every change.'
                    : 'No further availability change is possible from this state.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleAvailabilityChange}>
                  <div className="space-y-1.5">
                    <Label htmlFor="availability_status">New status</Label>
                    <Select value={availabilityValue} onValueChange={setAvailabilityValue}
                      disabled={!canEdit || !availabilityTransitions.length}>
                      <SelectTrigger id="availability_status">
                        <SelectValue placeholder="Choose a status" />
                      </SelectTrigger>
                      <SelectContent>
                        {availabilityTransitions.map((value) => (
                          <SelectItem key={value} value={value}>
                            {AVAILABILITY_STATUS_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="availability_reason">Reason</Label>
                    <Textarea id="availability_reason" rows={2} value={availabilityReason}
                      onChange={(event) => setAvailabilityReason(event.target.value)}
                      disabled={!canEdit || !availabilityTransitions.length} />
                  </div>
                  <Button type="submit"
                    disabled={!canEdit || !availabilityTransitions.length || mutation.isPending}>
                    Change availability
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Release</CardTitle>
                <CardDescription>
                  A unit cannot be released without a current price.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleReleaseChange}>
                  <div className="space-y-1.5">
                    <Label htmlFor="release_status">New release state</Label>
                    <Select value={releaseValue} onValueChange={setReleaseValue} disabled={!canEdit}>
                      <SelectTrigger id="release_status">
                        <SelectValue placeholder="Choose a release state" />
                      </SelectTrigger>
                      <SelectContent>
                        {releaseTransitions.map((value) => (
                          <SelectItem key={value} value={value}>
                            {RELEASE_STATUS_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release_reason">Reason</Label>
                    <Textarea id="release_reason" rows={2} value={releaseReason}
                      onChange={(event) => setReleaseReason(event.target.value)} disabled={!canEdit} />
                  </div>
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>
                    Change release state
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="commercial" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Price</CardTitle>
              <CardDescription>
                The customer-facing list price. Build costs and margins are not held here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-3" onSubmit={handlePriceSave}>
                <div className="space-y-1.5">
                  <Label htmlFor="list_price">List price</Label>
                  <Input id="list_price" name="list_price" type="number" min={0} step="1"
                    defaultValue={price?.list_price ?? ''} disabled={!canPrice} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="price_basis">Basis</Label>
                  <select
                    id="price_basis" name="price_basis" disabled={!canPrice}
                    defaultValue={price?.price_basis ?? 'fixed'}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {(Object.keys(PRICE_BASIS_LABELS) as BuilderPriceBasis[]).map((value) => (
                      <option key={value} value={value}>{PRICE_BASIS_LABELS[value]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="price_reason">Reason</Label>
                  <Input id="price_reason" name="price_reason" disabled={!canPrice} />
                </div>
                <div className="sm:col-span-3">
                  <Button type="submit" disabled={!canPrice || mutation.isPending}>
                    <Save className="mr-2 h-4 w-4" aria-hidden />Update price
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reservations</CardTitle>
              <CardDescription>
                {canSeeReservations
                  ? 'Purchaser contact details only — no client financial position is held here.'
                  : 'Your access does not include reservations.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!canSeeReservations ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Reservations are not visible with your current access.
                </p>
              ) : !reservations.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No reservations recorded for this unit.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Purchaser</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">Expires</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reservations.map((reservation) => (
                        <TableRow key={reservation.id}>
                          <TableCell>
                            <span className="font-medium">{reservation.purchaser_name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {reservation.reservation_reference || '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={RESERVATION_STATUS_CLASSES[reservation.status]}
                            >
                              {RESERVATION_STATUS_LABELS[reservation.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {reservation.expires_at
                              ? new Date(reservation.expires_at).toLocaleDateString('en-AU')
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {allowedReservationTransitions(reservation.status).map((next) => (
                                <Button
                                  key={next} size="sm" variant="outline"
                                  disabled={!canReserve || mutation.isPending}
                                  onClick={() => void handleReservationStatus(
                                    reservation.id, reservation.row_version, next)}
                                >
                                  {RESERVATION_STATUS_LABELS[next]}
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Holds and allocations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!holds.length && !allocations.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No holds or allocations recorded for this unit.
                </p>
              ) : (
                <>
                  {holds.map((hold) => (
                    <div key={hold.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                      <div>
                        <p className="font-medium">{hold.hold_reference || 'Hold'}</p>
                        <p className="text-xs text-muted-foreground">
                          Expires {new Date(hold.expires_at).toLocaleString('en-AU')}
                        </p>
                      </div>
                      <Badge variant="outline">{hold.status}</Badge>
                    </div>
                  ))}
                  {allocations.map((allocation) => (
                    <div key={allocation.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                      <div>
                        <p className="font-medium">
                          {ALLOCATION_TYPE_LABELS[allocation.allocation_type]}
                        </p>
                        <p className="text-xs text-muted-foreground">{allocation.reference || '—'}</p>
                      </div>
                      <Badge variant="outline">{allocation.status}</Badge>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
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
                        <Badge variant="outline">{entry.status_kind}</Badge>
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
        </TabsContent>
      </Tabs>

      <p className="mt-4 text-xs text-muted-foreground">
        {formatUnitArea(unit.internal_area_sqm)} internal
        {unit.external_area_sqm !== null ? ` · ${formatUnitArea(unit.external_area_sqm)} external` : ''}
      </p>
    </BuilderPortalShell>
  );
}
