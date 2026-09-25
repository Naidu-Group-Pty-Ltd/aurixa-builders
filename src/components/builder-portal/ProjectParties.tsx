import { useState, type FormEvent } from 'react';
import { Loader2, Mail, Pencil, Phone, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useBuilderProjectMutation } from '@/lib/builderQueries';
import {
  PARTY_ROLE_LABELS, type BuilderPartyRole, type BuilderProjectParty,
} from '@/lib/builderProjects';

/**
 * A PROJECT'S PARTIES — ITS CONTACT DIRECTORY.
 *
 * Who is on this job and how to reach them: the certifier, the site
 * supervisor, the purchaser's contact. A party is a RECORD, with a free-text
 * name, email and phone and no link to any portal user, so adding somebody
 * here gives them nothing: who may open a project is decided by project
 * access grants, which this surface never touches and which the dialog says
 * in so many words.
 *
 * The controls follow the server-resolved matrix — `projects.edit` adds and
 * edits, `projects.delete` removes — and the server re-checks every call.
 */

const ROLE_ORDER: BuilderPartyRole[] = [
  'site_supervisor', 'project_manager', 'certifier', 'surveyor', 'engineer',
  'architect', 'contractor', 'sales_agent', 'purchaser', 'developer', 'builder', 'other',
];

interface PartyDraft {
  role: BuilderPartyRole;
  name: string;
  organisation: string;
  email: string;
  phone: string;
  address: string;
  reference: string;
  is_primary_contact: boolean;
  notes: string;
}

const draftFrom = (party: BuilderProjectParty | null): PartyDraft => ({
  role: party?.role ?? 'site_supervisor',
  name: party?.name ?? '',
  organisation: party?.organisation ?? '',
  email: party?.email ?? '',
  phone: party?.phone ?? '',
  address: party?.address ?? '',
  reference: party?.reference ?? '',
  is_primary_contact: party?.is_primary_contact ?? false,
  notes: party?.notes ?? '',
});

function PartyDialog({
  projectId, party, open, onOpenChange,
}: {
  projectId: string;
  /** Null to add a party. */
  party: BuilderProjectParty | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useBuilderProjectMutation(projectId);
  const [draft, setDraft] = useState<PartyDraft>(() => draftFrom(party));
  const set = <K extends keyof PartyDraft>(key: K, value: PartyDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const named = draft.name.trim().length > 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!named) return;
    try {
      await mutation.mutateAsync({
        operation: 'upsert_party',
        ...(party ? { party_id: party.id } : {}),
        role: draft.role,
        name: draft.name.trim(),
        organisation: draft.organisation.trim(),
        email: draft.email.trim(),
        phone: draft.phone.trim(),
        address: draft.address.trim(),
        reference: draft.reference.trim(),
        is_primary_contact: draft.is_primary_contact,
        notes: draft.notes.trim(),
      });
      toast.success(party ? 'Party updated' : 'Party added');
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error?.message || 'The party could not be saved');
    }
  };

  const field = (key: 'organisation' | 'email' | 'phone' | 'address' | 'reference', label: string,
    type = 'text') => (
    <div className="space-y-1.5">
      <Label htmlFor={`party-${key}`}>{label}</Label>
      <Input
        id={`party-${key}`} type={type} value={draft[key]}
        onChange={(event) => set(key, event.target.value)}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{party ? `Edit ${party.name}` : 'Add a party'}</DialogTitle>
          <DialogDescription>
            A contact record for this project. Adding someone here does not give them access
            to the project or change anyone&apos;s permissions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="party-name">Name</Label>
            <Input
              id="party-name" value={draft.name} required maxLength={200}
              onChange={(event) => set('name', event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="party-role">Role</Label>
            <Select value={draft.role} onValueChange={(value) => set('role', value as BuilderPartyRole)}>
              <SelectTrigger id="party-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_ORDER.map((role) => (
                  <SelectItem key={role} value={role}>{PARTY_ROLE_LABELS[role]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {field('organisation', 'Organisation')}
          {field('email', 'Email', 'email')}
          {field('phone', 'Phone', 'tel')}
          <div className="sm:col-span-2">{field('address', 'Address')}</div>
          {field('reference', 'Reference')}
          <div className="flex items-center gap-2 self-end pb-2">
            <Checkbox
              id="party-primary" checked={draft.is_primary_contact}
              onCheckedChange={(value) => set('is_primary_contact', value === true)}
            />
            <Label htmlFor="party-primary" className="font-normal">Primary contact</Label>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="party-notes">Notes</Label>
            <Textarea
              id="party-notes" rows={3} value={draft.notes}
              onChange={(event) => set('notes', event.target.value)}
            />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!named || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Save party
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectPartiesPanel({
  projectId, parties, canEdit, canDelete,
}: {
  projectId: string;
  parties: BuilderProjectParty[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const mutation = useBuilderProjectMutation(projectId);
  // `undefined` closed; `null` adding; a party editing it.
  const [editing, setEditing] = useState<BuilderProjectParty | null | undefined>(undefined);
  const [removing, setRemoving] = useState<BuilderProjectParty | null>(null);

  const remove = async () => {
    if (!removing) return;
    try {
      await mutation.mutateAsync({ operation: 'delete_party', party_id: removing.id });
      toast.success(`${removing.name} removed`);
      setRemoving(null);
    } catch (error: any) {
      toast.error(error?.message || 'The party could not be removed');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" aria-hidden />Project parties
          </CardTitle>
          <CardDescription>
            Who is on this job and how to reach them. A contact directory only — it grants no
            access to the project.
          </CardDescription>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />Add party
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {!parties.length ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No parties recorded yet.
          </p>
        ) : parties.map((party) => (
          <div key={party.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/60 p-4">
            <div className="min-w-0 flex-1 basis-56">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                <span className="truncate">{party.name}</span>
                {party.is_primary_contact ? <Badge variant="outline">Primary</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {PARTY_ROLE_LABELS[party.role] || party.role}
                {party.organisation ? ` · ${party.organisation}` : ''}
              </p>
              {party.notes ? <p className="mt-1 text-xs text-muted-foreground">{party.notes}</p> : null}
            </div>
            <div className="flex flex-col gap-1 text-xs">
              {party.email ? (
                <a href={`mailto:${party.email}`} className="inline-flex items-center gap-1.5 text-foreground hover:text-primary">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{party.email}
                </a>
              ) : null}
              {party.phone ? (
                <a href={`tel:${party.phone.replace(/\s+/g, '')}`} className="inline-flex items-center gap-1.5 text-foreground hover:text-primary">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{party.phone}
                </a>
              ) : null}
            </div>
            {canEdit || canDelete ? (
              <div className="flex gap-1">
                {canEdit ? (
                  <Button
                    variant="ghost" size="sm" onClick={() => setEditing(party)}
                    aria-label={`Edit ${party.name}`}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    variant="ghost" size="sm" onClick={() => setRemoving(party)}
                    aria-label={`Remove ${party.name}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>

      {editing !== undefined ? (
        <PartyDialog
          key={editing?.id ?? 'new'}
          projectId={projectId}
          party={editing}
          open
          onOpenChange={(open) => { if (!open) setEditing(undefined); }}
        />
      ) : null}

      <AlertDialog open={!!removing} onOpenChange={(open) => { if (!open && !mutation.isPending) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this party?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.name} will be removed from this project&apos;s contact directory. The
              change is recorded in the project&apos;s activity.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void remove(); }}
              disabled={mutation.isPending}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
