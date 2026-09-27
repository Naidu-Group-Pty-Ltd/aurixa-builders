import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import {
  builderListOrgMembers, builderManageOrgMember, builderRevokeOrgInvite,
  type BuilderMemberAction, type BuilderOrgMember,
} from '@/lib/builderPortal';

/**
 * The ACTIVE organisation's members, managed by an owner or administrator.
 *
 * Renders only for an owner or administrator — a journey aid, exactly like
 * the invite card beside it. `builder-portal-invite` and, beneath it,
 * `builder_org_manage_membership` decide every act: an owner only by an
 * owner, never oneself, never the last active owner, never `owner` as a role.
 */
export const MEMBER_ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  administrator: 'Administrator',
  manager: 'Manager',
  member: 'Member',
  read_only: 'Read only',
};
const ASSIGNABLE_ROLES = ['administrator', 'manager', 'member', 'read_only'];

type Pending = { member: BuilderOrgMember; action: BuilderMemberAction | 'revoke_invite' } | null;

const CONFIRM: Record<string, { title: string; body: (name: string) => string; label: string }> = {
  suspend: {
    title: 'Suspend this member?',
    body: (name) => `${name} will lose access to this organisation on their next request. Their history stays as it is, and you can reactivate them later.`,
    label: 'Suspend',
  },
  remove: {
    title: 'Remove this member?',
    body: (name) => `${name} will be removed from this organisation and lose access immediately. Their history stays as it is. To give them access again you will need to invite them.`,
    label: 'Remove',
  },
  revoke_invite: {
    title: 'Cancel this invitation?',
    body: (name) => `${name}'s invitation link will stop working.`,
    label: 'Cancel invitation',
  },
};

export function BuilderTeamMembersCard() {
  const { activeOrganisation, organisations } = useBuilderPortalAuth();
  const { toast } = useToast();
  const [members, setMembers] = useState<BuilderOrgMember[]>([]);
  const [invitations, setInvitations] = useState<BuilderOrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const membershipRole = useMemo(
    () => organisations.find(
      (organisation) => organisation.organisation_id === activeOrganisation?.organisation_id,
    )?.membership_role ?? null,
    [activeOrganisation?.organisation_id, organisations],
  );
  const mayManage = membershipRole === 'owner' || membershipRole === 'administrator';

  const load = useCallback(async () => {
    setLoadError(null);
    const { data, error } = await builderListOrgMembers();
    if (error || !data?.success) {
      setLoadError(error?.message || 'Members could not be loaded.');
    } else {
      setMembers(data.members ?? []);
      setInvitations(data.invitations ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (mayManage) void load();
  }, [mayManage, load, activeOrganisation?.organisation_id]);

  if (!mayManage) return null;

  const act = async (member: BuilderOrgMember, action: BuilderMemberAction | 'revoke_invite', role?: string) => {
    setBusy(member.membership_id);
    const { data, error } = action === 'revoke_invite'
      ? await builderRevokeOrgInvite(member.builder_user_id)
      : await builderManageOrgMember({ membership_id: member.membership_id, member_action: action, role });
    setBusy(null);
    if (error || !data?.success) {
      toast({ title: 'Not changed', description: error?.message || 'The change could not be made.', variant: 'destructive' });
      return;
    }
    const who = member.name || member.email;
    const done: Record<string, string> = {
      set_role: `${who} is now ${MEMBER_ROLE_LABELS[role ?? ''] ?? role}.`,
      suspend: `${who} is suspended.`,
      reactivate: `${who} is active again.`,
      remove: `${who} was removed from the organisation.`,
      revoke_invite: `${who}'s invitation was cancelled.`,
    };
    toast({ title: 'Saved', description: done[action] });
    await load();
  };

  const confirmAndAct = async () => {
    if (!pending) return;
    const { member, action } = pending;
    setPending(null);
    await act(member, action);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" aria-hidden />
          Team members
        </CardTitle>
        <CardDescription>
          Change what colleagues can do, suspend or remove them. Owners can only be changed by another owner,
          and an organisation always keeps at least one active owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading members…
          </p>
        ) : loadError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              {loadError}
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <ul className="divide-y divide-border" aria-label="Members">
              {members.map((member) => (
                <li key={member.membership_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {member.name || member.email}
                      {member.is_self ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {member.status === 'suspended' ? <Badge variant="outline">Suspended</Badge> : null}
                    {member.can_manage && member.role !== 'owner' ? (
                      <Select
                        value={member.role}
                        disabled={busy === member.membership_id}
                        onValueChange={(role) => void act(member, 'set_role', role)}
                      >
                        <SelectTrigger className="w-40" aria-label={`Role for ${member.name || member.email}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>{MEMBER_ROLE_LABELS[role]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary">{MEMBER_ROLE_LABELS[member.role] ?? member.role}</Badge>
                    )}
                    {member.can_manage ? (
                      <>
                        {member.status === 'suspended' ? (
                          <Button type="button" size="sm" variant="outline" disabled={busy === member.membership_id}
                            onClick={() => void act(member, 'reactivate')}>
                            Reactivate
                          </Button>
                        ) : (
                          <Button type="button" size="sm" variant="outline" disabled={busy === member.membership_id}
                            onClick={() => setPending({ member, action: 'suspend' })}>
                            Suspend
                          </Button>
                        )}
                        <Button type="button" size="sm" variant="outline" disabled={busy === member.membership_id}
                          onClick={() => setPending({ member, action: 'remove' })}>
                          Remove
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Pending invitations</h3>
              {invitations.length ? (
                <ul className="divide-y divide-border" aria-label="Pending invitations">
                  {invitations.map((member) => (
                    <li key={member.membership_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">{member.name || member.email}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {member.email} · invited as {MEMBER_ROLE_LABELS[member.role] ?? member.role}
                        </p>
                      </div>
                      {member.can_manage ? (
                        <Button type="button" size="sm" variant="outline" disabled={busy === member.membership_id}
                          onClick={() => setPending({ member, action: 'revoke_invite' })}>
                          Cancel invitation
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No invitations are waiting.</p>
              )}
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          {pending ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{CONFIRM[pending.action].title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {CONFIRM[pending.action].body(pending.member.name || pending.member.email)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction onClick={() => void confirmAndAct()}>{CONFIRM[pending.action].label}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
