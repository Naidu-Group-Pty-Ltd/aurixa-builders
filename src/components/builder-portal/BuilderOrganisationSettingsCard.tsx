import { useEffect, useState } from 'react';
import { Loader2, Lock, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  useBuilderOrganisationSettings, useBuilderWorkspaceMutation,
} from '@/lib/builderQueries';
import {
  BUILDER_LANDING_PAGES, BUILDER_TIMEZONES, LANDING_PAGE_LABELS,
  type BuilderLandingPage,
} from '@/lib/builderWorkspace';

/**
 * Organisation-wide settings for the session's active organisation.
 *
 * The organisation is the SESSION's — this component sends no organisation id.
 * `can_edit` from the server decides whether the form is editable, but it is a
 * hint only: the write path re-checks the membership role and is the authority,
 * so a tampered client still cannot save.
 */
export function BuilderOrganisationSettingsCard() {
  const { toast } = useToast();
  const query = useBuilderOrganisationSettings();
  const mutation = useBuilderWorkspaceMutation();

  const [displayName, setDisplayName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [timezone, setTimezone] = useState('Australia/Sydney');
  const [landingPage, setLandingPage] = useState<BuilderLandingPage>('dashboard');
  const [notifyDefect, setNotifyDefect] = useState(true);
  const [notifyInspection, setNotifyInspection] = useState(true);
  const [notifyVariation, setNotifyVariation] = useState(true);
  const [notifyMessage, setNotifyMessage] = useState(true);
  const [notifyTask, setNotifyTask] = useState(true);

  const settings = query.data?.settings ?? null;
  const canEdit = query.data?.can_edit === true;

  useEffect(() => {
    if (!settings) return;
    setDisplayName(settings.display_name ?? '');
    setContactName(settings.primary_contact_name ?? '');
    setContactEmail(settings.primary_contact_email ?? '');
    setContactPhone(settings.primary_contact_phone ?? '');
    setTimezone(settings.timezone);
    setLandingPage(settings.default_landing_page);
    setNotifyDefect(settings.notify_on_defect);
    setNotifyInspection(settings.notify_on_inspection);
    setNotifyVariation(settings.notify_on_variation);
    setNotifyMessage(settings.notify_on_message);
    setNotifyTask(settings.notify_on_task);
  }, [settings]);

  const save = async () => {
    try {
      await mutation.mutateAsync({
        operation: 'save_organisation_settings',
        expected_version: settings?.row_version,
        display_name: displayName.trim() || null,
        primary_contact_name: contactName.trim() || null,
        primary_contact_email: contactEmail.trim() || null,
        primary_contact_phone: contactPhone.trim() || null,
        timezone,
        default_landing_page: landingPage,
        notify_on_defect: notifyDefect,
        notify_on_inspection: notifyInspection,
        notify_on_variation: notifyVariation,
        notify_on_message: notifyMessage,
        notify_on_task: notifyTask,
      });
      toast({ title: 'Organisation settings saved' });
    } catch (error) {
      toast({
        title: 'The settings could not be saved',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const toggles: Array<[string, boolean, (value: boolean) => void, string]> = [
    ['org-notify-defect', notifyDefect, setNotifyDefect, 'Notify on a new defect'],
    ['org-notify-inspection', notifyInspection, setNotifyInspection, 'Notify on a scheduled inspection'],
    ['org-notify-variation', notifyVariation, setNotifyVariation, 'Notify on a variation decision'],
    ['org-notify-message', notifyMessage, setNotifyMessage, 'Notify on a new message'],
    ['org-notify-task', notifyTask, setNotifyTask, 'Notify on a task assignment'],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organisation settings</CardTitle>
        <CardDescription>
          Contact details and defaults for everyone in this organisation. These do not grant
          access to anything — organisation access and permissions remain the only authority.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading organisation settings" />
          </div>
        ) : query.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
            <p className="font-medium">Organisation settings could not be loaded</p>
            <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {!canEdit ? (
              <p className="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
                <Lock className="h-4 w-4" aria-hidden />
                Only an owner or administrator of this organisation can change these.
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-display-name">Display name</Label>
                <Input
                  id="org-display-name" value={displayName} disabled={!canEdit}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="How your organisation appears in the portal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-contact-name">Primary contact</Label>
                <Input
                  id="org-contact-name" value={contactName} disabled={!canEdit}
                  onChange={(event) => setContactName(event.target.value)}
                  placeholder="Who to reach first"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-contact-email">Contact email</Label>
                <Input
                  id="org-contact-email" type="email" value={contactEmail} disabled={!canEdit}
                  onChange={(event) => setContactEmail(event.target.value)}
                  placeholder="site@example.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-contact-phone">Contact phone</Label>
                <Input
                  id="org-contact-phone" value={contactPhone} disabled={!canEdit}
                  onChange={(event) => setContactPhone(event.target.value)}
                  placeholder="02 0000 0000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-timezone">Time zone</Label>
                <Select value={timezone} onValueChange={setTimezone} disabled={!canEdit}>
                  <SelectTrigger id="org-timezone"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_TIMEZONES.map((value) => (
                      <SelectItem key={value} value={value}>{value}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-landing-page">Default landing page</Label>
                <Select
                  value={landingPage} disabled={!canEdit}
                  onValueChange={(value) => setLandingPage(value as BuilderLandingPage)}
                >
                  <SelectTrigger id="org-landing-page"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_LANDING_PAGES.map((value) => (
                      <SelectItem key={value} value={value}>{LANDING_PAGE_LABELS[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-4">
              {toggles.map(([id, value, setValue, label]) => (
                <div key={id} className="flex items-center justify-between gap-4">
                  <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
                  <Switch id={id} checked={value} onCheckedChange={setValue} disabled={!canEdit} />
                </div>
              ))}
            </div>

            {canEdit ? (
              <div className="flex justify-end">
                <Button onClick={() => void save()} disabled={mutation.isPending}>
                  {mutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Save className="mr-2 h-4 w-4" aria-hidden />
                  )}
                  Save organisation settings
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
