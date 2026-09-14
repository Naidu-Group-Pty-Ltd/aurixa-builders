import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Link2, Loader2, Receipt, Save, Trash2, Users } from 'lucide-react';
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
import { useBuilderTransaction, useBuilderTransactionMutation } from '@/lib/builderQueries';
import {
  TRANSACTION_PARTY_ROLE_LABELS, TRANSACTION_STATUS_CLASSES, TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS, allowedTransactionTransitions, formatTransactionDate,
  formatTransactionMoney, sunsetCountdown,
  type BuilderTransactionPartyRole, type BuilderTransactionStatus,
} from '@/lib/builderTransactions';

/**
 * External Builder Portal transaction detail. Mirrors `BuilderUnitDetail`, which
 * mirrors `BuilderProjectDetail`: overview / parties / case / history tabs,
 * optimistic-concurrency edits carrying `expected_version`, and a status change
 * that requires a reason.
 *
 * Every control is rendered from the server-resolved permission matrix. That is
 * a rendering aid only — the server re-authorises every request through the
 * transaction's parent project, so hiding a button is never what prevents an
 * action.
 *
 * The case panel reports only that a shared case exists and which slot this
 * transaction fills. Nothing from the Legal matter, the Finance file or any
 * client financial position is fetched or shown.
 */
export default function BuilderTransactionDetail() {
  const { transactionId = '' } = useParams();
  const query = useBuilderTransaction(transactionId);
  const mutation = useBuilderTransactionMutation(transactionId);

  const [statusValue, setStatusValue] = useState('');
  const [statusReason, setStatusReason] = useState('');

  if (query.isLoading) {
    return (
      <BuilderPortalShell title="Transaction">
        <div className="flex justify-center py-16" role="status" aria-label="Loading transaction">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderPortalShell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <BuilderPortalShell title="Transaction">
        <Alert variant="destructive">
          <AlertDescription>
            This transaction could not be loaded. It may not exist, or your access may have been
            changed. <Link to="/builder/transactions" className="underline">Back to transactions</Link>.
          </AlertDescription>
        </Alert>
      </BuilderPortalShell>
    );
  }

  const {
    transaction, project, unit, parties, status_history: history,
    case_link: caseLink, permissions,
  } = query.data;

  const canEdit = permissions?.transactions?.edit === true;
  const canDelete = permissions?.transactions?.delete === true;
  const transitions = allowedTransactionTransitions(transaction.status);

  const reportError = (error: any, fallback: string) => {
    toast.error(error?.code === 'STALE_VERSION'
      ? 'This transaction was changed by someone else. Refresh and try again.'
      : error?.message || fallback);
  };

  const handleDetailSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync({
        operation: 'update_transaction',
        expected_version: transaction.row_version,
        purchaser_name: String(form.get('purchaser_name') || ''),
        purchaser_email: String(form.get('purchaser_email') || ''),
        purchaser_phone: String(form.get('purchaser_phone') || ''),
        contract_price: String(form.get('contract_price') || '') || null,
        deposit_amount: String(form.get('deposit_amount') || '') || null,
        contract_issued_date: String(form.get('contract_issued_date') || '') || null,
        contract_signed_date: String(form.get('contract_signed_date') || '') || null,
        sunset_date: String(form.get('sunset_date') || '') || null,
        estimated_settlement_date: String(form.get('estimated_settlement_date') || '') || null,
        shared_summary: String(form.get('shared_summary') || ''),
        builder_notes: String(form.get('builder_notes') || ''),
      });
      toast.success('Transaction updated');
    } catch (error: any) {
      reportError(error, 'The transaction could not be updated');
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
        expected_version: transaction.row_version,
        status: statusValue,
        reason: statusReason.trim(),
      });
      setStatusValue('');
      setStatusReason('');
      toast.success('Transaction status updated');
    } catch (error: any) {
      reportError(error, 'The status could not be changed');
    }
  };

  const handlePartyAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await mutation.mutateAsync({
        operation: 'upsert_party',
        role: String(data.get('role') || 'other'),
        name: String(data.get('name') || ''),
        organisation: String(data.get('organisation') || ''),
        email: String(data.get('email') || ''),
        phone: String(data.get('phone') || ''),
      });
      form.reset();
      toast.success('Party added');
    } catch (error: any) {
      reportError(error, 'The party could not be added');
    }
  };

  const handlePartyDelete = async (partyId: string) => {
    try {
      await mutation.mutateAsync({ operation: 'delete_party', party_id: partyId });
      toast.success('Party removed');
    } catch (error: any) {
      reportError(error, 'The party could not be removed');
    }
  };

  const handleUnlinkCase = async () => {
    const reason = window.prompt('Give a reason for unlinking this case');
    if (!reason || !reason.trim()) return;
    try {
      await mutation.mutateAsync({ operation: 'unlink_case', reason: reason.trim() });
      toast.success('Case unlinked');
    } catch (error: any) {
      reportError(error, 'The case could not be unlinked');
    }
  };

  const countdown = sunsetCountdown(transaction.sunset_date);

  return (
    <BuilderPortalShell
      title={transaction.transaction_reference || 'Transaction'}
      description={`${project.name}${unit ? ` · Unit ${unit.unit_number}` : ''}`}
      actions={
        <>
          <Badge
            variant="outline"
            className={TRANSACTION_STATUS_CLASSES[transaction.status as BuilderTransactionStatus]}
          >
            {TRANSACTION_STATUS_LABELS[transaction.status as BuilderTransactionStatus]}
          </Badge>
          <Badge variant="outline">
            {TRANSACTION_TYPE_LABELS[transaction.transaction_type]}
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link to="/builder/transactions">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />All transactions
            </Link>
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Receipt className="h-4 w-4 text-primary" aria-hidden />Contract
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {formatTransactionMoney(transaction.contract_price)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deposit {formatTransactionMoney(transaction.deposit_amount)}
              {transaction.deposit_received ? ' · received' : ''}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-primary" aria-hidden />Purchaser
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="truncate font-medium text-foreground">
              {transaction.purchaser_name || 'Not recorded'}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {transaction.purchaser_email || 'No email recorded'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="h-4 w-4 text-primary" aria-hidden />Shared case
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">
              {caseLink ? 'Linked' : transaction.client_id ? 'Not linked' : 'No client yet'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {countdown || formatTransactionDate(transaction.estimated_settlement_date)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="mt-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="parties">Parties</TabsTrigger>
          <TabsTrigger value="case">Case</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transaction details</CardTitle>
              <CardDescription>
                {canEdit
                  ? 'Changes carry the version you loaded; a conflicting edit is rejected.'
                  : 'You have read-only access to this transaction.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleDetailSave}>
                <div className="space-y-1.5">
                  <Label htmlFor="purchaser_name">Purchaser name</Label>
                  <Input id="purchaser_name" name="purchaser_name"
                    defaultValue={transaction.purchaser_name ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="purchaser_email">Purchaser email</Label>
                  <Input id="purchaser_email" name="purchaser_email" type="email"
                    defaultValue={transaction.purchaser_email ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="purchaser_phone">Purchaser phone</Label>
                  <Input id="purchaser_phone" name="purchaser_phone"
                    defaultValue={transaction.purchaser_phone ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract_price">Contract price</Label>
                  <Input id="contract_price" name="contract_price" type="number" min={0} step="1"
                    defaultValue={transaction.contract_price ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deposit_amount">Deposit</Label>
                  <Input id="deposit_amount" name="deposit_amount" type="number" min={0} step="1"
                    defaultValue={transaction.deposit_amount ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract_issued_date">Contract issued</Label>
                  <Input id="contract_issued_date" name="contract_issued_date" type="date"
                    defaultValue={transaction.contract_issued_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract_signed_date">Contract signed</Label>
                  <Input id="contract_signed_date" name="contract_signed_date" type="date"
                    defaultValue={transaction.contract_signed_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sunset_date">Sunset date</Label>
                  <Input id="sunset_date" name="sunset_date" type="date"
                    defaultValue={transaction.sunset_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="estimated_settlement_date">Estimated settlement</Label>
                  <Input id="estimated_settlement_date" name="estimated_settlement_date" type="date"
                    defaultValue={transaction.estimated_settlement_date ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="shared_summary">Shared summary</Label>
                  <Textarea id="shared_summary" name="shared_summary" rows={2}
                    defaultValue={transaction.shared_summary ?? ''} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="builder_notes">Builder notes (private)</Label>
                  <Textarea id="builder_notes" name="builder_notes" rows={3}
                    defaultValue={transaction.builder_notes ?? ''} disabled={!canEdit} />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>
                    <Save className="mr-2 h-4 w-4" aria-hidden />Save changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
              <CardDescription>
                {transitions.length
                  ? 'A reason is recorded with every change.'
                  : 'This transaction has reached a terminal status.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleStatusChange}>
                <div className="space-y-1.5">
                  <Label htmlFor="transaction_status">New status</Label>
                  <Select value={statusValue} onValueChange={setStatusValue}
                    disabled={!canEdit || !transitions.length}>
                    <SelectTrigger id="transaction_status">
                      <SelectValue placeholder="Choose a status" />
                    </SelectTrigger>
                    <SelectContent>
                      {transitions.map((value) => (
                        <SelectItem key={value} value={value}>
                          {TRANSACTION_STATUS_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transaction_status_reason">Reason</Label>
                  <Input id="transaction_status_reason" value={statusReason}
                    onChange={(event) => setStatusReason(event.target.value)}
                    disabled={!canEdit || !transitions.length} />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit"
                    disabled={!canEdit || !transitions.length || mutation.isPending}>
                    Change status
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="parties" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Parties</CardTitle>
              <CardDescription>Contact details only — no client financial position.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!parties.length ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No parties recorded for this transaction.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead className="hidden sm:table-cell">Contact</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parties.map((party) => (
                        <TableRow key={party.id}>
                          <TableCell>
                            <span className="font-medium">{party.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {party.organisation || '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            {TRANSACTION_PARTY_ROLE_LABELS[
                              party.role as BuilderTransactionPartyRole] || party.role}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {party.email || party.phone || '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm" variant="outline"
                              disabled={!canDelete || mutation.isPending}
                              onClick={() => void handlePartyDelete(party.id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" aria-hidden />Remove
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <form className="grid gap-3 sm:grid-cols-5" onSubmit={handlePartyAdd}>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="party_name">Name</Label>
                  <Input id="party_name" name="name" required disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="party_role">Role</Label>
                  <select
                    id="party_role" name="role" defaultValue="purchaser" disabled={!canEdit}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {(Object.keys(TRANSACTION_PARTY_ROLE_LABELS) as BuilderTransactionPartyRole[])
                      .map((value) => (
                        <option key={value} value={value}>
                          {TRANSACTION_PARTY_ROLE_LABELS[value]}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="party_email">Email</Label>
                  <Input id="party_email" name="email" type="email" disabled={!canEdit} />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!canEdit || mutation.isPending}>Add party</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="case">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Shared transaction case</CardTitle>
              <CardDescription>
                The case is the shared identity across Builder, Finance, Legal and the Command
                Centre. This panel reports only that the link exists — no matter, file or client
                financial information is read.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!transaction.client_id ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  This transaction has no client yet, so it cannot join a case. Unsold inventory
                  stays Builder-only.
                </p>
              ) : !caseLink ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  This transaction has a client but is not linked to a case. Ask the Command Centre
                  to link it.
                </p>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Linked to a shared case</p>
                    <p className="text-xs text-muted-foreground">
                      Source {caseLink.link_source} · {formatTransactionDate(caseLink.linked_at)}
                    </p>
                  </div>
                  <Button
                    variant="outline" size="sm"
                    disabled={!canEdit || mutation.isPending}
                    onClick={() => void handleUnlinkCase()}
                  >
                    Unlink
                  </Button>
                </div>
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
                        <span className="font-medium">
                          {entry.from_status
                            ? `${TRANSACTION_STATUS_LABELS[entry.from_status]} → `
                            : ''}
                          {TRANSACTION_STATUS_LABELS[entry.to_status]}
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
