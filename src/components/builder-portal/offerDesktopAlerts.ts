import { toast } from 'sonner';
import {
  markDesktopAlertsOffered, requestAlertPermission, shouldOfferDesktopAlerts,
} from '@/lib/builderPortalAlerts';

/**
 * Offer desktop alerts at the moment they are worth having: something just
 * arrived and the browser has not been asked yet. Once a visit, whichever
 * pop-up gets there first — the portal remembers nothing in the browser, and
 * the browser remembers the answer. Permission is requested only from the
 * button: a request nobody asked for is refused, or remembered as a refusal,
 * by the browser.
 */
export function offerDesktopAlerts() {
  if (!shouldOfferDesktopAlerts()) return;
  markDesktopAlertsOffered();
  toast('Get desktop alerts?', {
    id: 'desktop-alerts-offer',
    description: 'We’ll tell you about new messages and activations, even from another tab.',
    duration: 15_000,
    action: {
      label: 'Turn on',
      onClick: () => {
        void requestAlertPermission().then((result) => {
          if (result === 'granted') toast.success('Desktop alerts are on');
          else if (result === 'denied') {
            toast('Your browser is blocking notifications', {
              description: 'Allow them for this site from the padlock in the address bar.',
            });
          }
        });
      },
    },
    cancel: { label: 'Not now', onClick: () => undefined },
  });
}
