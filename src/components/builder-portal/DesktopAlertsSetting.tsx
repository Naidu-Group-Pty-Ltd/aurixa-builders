import { useCallback, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { alertPermission, markDesktopAlertsOffered, requestAlertPermission } from '@/lib/builderPortalAlerts';

/**
 * Desktop alerts in this browser — the durable way in.
 *
 * The in-app offer is made once a visit, when something arrives. This is
 * where a builder turns alerts on at any time. The switch is the browser's
 * own permission rather than anything the portal stores (the portal keeps
 * nothing in the browser), so turning them off is the browser's site
 * settings, and saying so is the honest control. "Tell me when a message is
 * posted" above still decides whether a message alerts at all.
 */
export function DesktopAlertsSetting() {
  const [permission, setPermission] = useState(alertPermission);
  const [asking, setAsking] = useState(false);

  const turnOn = useCallback(async () => {
    setAsking(true);
    try {
      markDesktopAlertsOffered();
      setPermission(await requestAlertPermission());
    } finally {
      setAsking(false);
    }
  }, []);

  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="desktop-alerts" className="text-sm font-normal">
          Desktop alerts in this browser
        </Label>
        {permission === 'default' ? (
          <Button id="desktop-alerts" size="sm" variant="outline" onClick={() => void turnOn()} disabled={asking}>
            <BellRing className="mr-2 h-4 w-4" aria-hidden />
            Turn on
          </Button>
        ) : (
          <span id="desktop-alerts" className="text-sm text-muted-foreground">
            {permission === 'granted' ? 'On' : 'Off'}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {permission === 'unsupported'
          ? 'This browser can’t show desktop alerts.'
          : permission === 'denied'
            ? 'Your browser is blocking notifications for this site. Allow them from the padlock in the address bar.'
            : permission === 'granted'
              ? 'New agency messages and activations reach you in another tab or app. Turn them off from the padlock in the address bar.'
              : 'New agency messages and activations, while you’re in another tab or app.'}
      </p>
    </div>
  );
}
