import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  useBuilderMyPreferences, useBuilderWorkspaceMutation,
} from '@/lib/builderQueries';
import {
  BUILDER_DATE_FORMATS, BUILDER_EMAIL_DIGESTS, BUILDER_LANDING_PAGES, BUILDER_TIMEZONES,
  EMAIL_DIGEST_LABELS, LANDING_PAGE_LABELS,
  type BuilderDateFormat, type BuilderEmailDigest, type BuilderLandingPage,
} from '@/lib/builderWorkspace';

/**
 * One Builder user's own preferences.
 *
 * The row saved is always the caller's: the server takes the owner from the
 * verified session and this component sends no user id at all. Every save after
 * the first carries the version the form loaded, so two tabs cannot silently
 * overwrite each other.
 */
export function BuilderPreferencesCard() {
  const { toast } = useToast();
  const query = useBuilderMyPreferences();
  const mutation = useBuilderWorkspaceMutation();

  const [landingPage, setLandingPage] = useState<BuilderLandingPage>('dashboard');
  const [timezone, setTimezone] = useState('Australia/Sydney');
  const [dateFormat, setDateFormat] = useState<BuilderDateFormat>('DD/MM/YYYY');
  const [emailDigest, setEmailDigest] = useState<BuilderEmailDigest>('daily');
  const [notifyTask, setNotifyTask] = useState(true);
  const [notifyMessage, setNotifyMessage] = useState(true);
  const [notifyStatus, setNotifyStatus] = useState(true);

  const preferences = query.data ?? null;

  useEffect(() => {
    if (!preferences) return;
    setLandingPage(preferences.landing_page);
    setTimezone(preferences.timezone);
    setDateFormat(preferences.date_format);
    setEmailDigest(preferences.email_digest);
    setNotifyTask(preferences.notify_task_assigned);
    setNotifyMessage(preferences.notify_message_posted);
    setNotifyStatus(preferences.notify_status_change);
  }, [preferences]);

  const save = async () => {
    try {
      await mutation.mutateAsync({
        operation: 'save_my_preferences',
        expected_version: preferences?.row_version,
        landing_page: landingPage,
        timezone,
        date_format: dateFormat,
        email_digest: emailDigest,
        notify_task_assigned: notifyTask,
        notify_message_posted: notifyMessage,
        notify_status_change: notifyStatus,
      });
      toast({ title: 'Your preferences were saved' });
    } catch (error) {
      toast({
        title: 'Your preferences could not be saved',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const toggles: Array<[string, boolean, (value: boolean) => void, string]> = [
    ['notify-task', notifyTask, setNotifyTask, 'Tell me when a task is assigned to me'],
    ['notify-message', notifyMessage, setNotifyMessage, 'Tell me when a message is posted'],
    ['notify-status', notifyStatus, setNotifyStatus, 'Tell me when a record changes status'],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your preferences</CardTitle>
        <CardDescription>
          These change how the portal looks and what you are told about. They do not change what
          you can see — your administrator controls that.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading preferences" />
          </div>
        ) : query.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
            <p className="font-medium">Your preferences could not be loaded</p>
            <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="landing-page">Open the portal on</Label>
                <Select
                  value={landingPage}
                  onValueChange={(value) => setLandingPage(value as BuilderLandingPage)}
                >
                  <SelectTrigger id="landing-page"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_LANDING_PAGES.map((value) => (
                      <SelectItem key={value} value={value}>{LANDING_PAGE_LABELS[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="preference-timezone">Time zone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger id="preference-timezone"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_TIMEZONES.map((value) => (
                      <SelectItem key={value} value={value}>{value}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="date-format">Date format</Label>
                <Select
                  value={dateFormat}
                  onValueChange={(value) => setDateFormat(value as BuilderDateFormat)}
                >
                  <SelectTrigger id="date-format"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_DATE_FORMATS.map((value) => (
                      <SelectItem key={value} value={value}>{value}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-digest">Email digest</Label>
                <Select
                  value={emailDigest}
                  onValueChange={(value) => setEmailDigest(value as BuilderEmailDigest)}
                >
                  <SelectTrigger id="email-digest"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUILDER_EMAIL_DIGESTS.map((value) => (
                      <SelectItem key={value} value={value}>{EMAIL_DIGEST_LABELS[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-4">
              {toggles.map(([id, value, setValue, label]) => (
                <div key={id} className="flex items-center justify-between gap-4">
                  <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
                  <Switch id={id} checked={value} onCheckedChange={setValue} />
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button onClick={() => void save()} disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="mr-2 h-4 w-4" aria-hidden />
                )}
                Save preferences
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
