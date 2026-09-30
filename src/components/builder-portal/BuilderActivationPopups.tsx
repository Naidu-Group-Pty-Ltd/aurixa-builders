import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { useBuilderNotifications } from '@/lib/builderQueries';
import type { BuilderNotification } from '@/lib/builderCollaboration';
import {
  activationAlertKey, activationCatchUpKey, activationPopup, isActivationToAnnounce,
} from '@/lib/activationPopups.pure';
import {
  claimAlert, clearTitleCount, deliverDesktopAlert, seedAlert, setTitleCount,
} from '@/lib/builderPortalAlerts';
import { offerDesktopAlerts } from './offerDesktopAlerts';

/** The tab-title count this component publishes. */
const TITLE_SOURCE = 'activations';

/**
 * Ids already popped, held at module scope so a refetch of the shared
 * notifications query — or a page change, or leaving the portal's layout and
 * coming back — cannot show the same one twice.
 *
 * Nothing here writes: the notification is not marked read, so the bell, its
 * list and the unread count are untouched and the entry stays where it is.
 */
const popped = new Set<string>();

/**
 * "Property activated by <agency>" — wherever the builder is in the portal,
 * and when they are not looking at it at all.
 *
 * It used to live on the Dashboard page, so an activation reached a builder
 * only when they opened the Dashboard. It reads the list the bell reads —
 * same hook, same query key, no second fetch — which now polls, in the
 * background too, and it is mounted by the layout every signed-in page shares.
 *
 * Every unread activation pops once per visit, oldest first, so the most
 * recent is the one left standing. One that arrives while the tab is hidden
 * raises a desktop notification (once per person, however many tabs are
 * open, and only where desktop alerts are on), counts on the tab, and pops
 * when the builder comes back — in whichever tab they return to first.
 * Activations that were already waiting when the portal opened pop on screen
 * but never as a burst of desktop notifications.
 */
export function BuilderActivationPopups() {
  const { user, activeOrganisation } = useBuilderPortalAuth();
  if (!user || !activeOrganisation) return null;
  return <ActivationWatcher key={`${user.id}:${activeOrganisation.organisation_id}`} />;
}

function ActivationWatcher() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  const { data: notifications } = useBuilderNotifications();

  /** Whether the first answer — what was already waiting — has been read. */
  const bootedRef = useRef(false);
  /** Activations that arrived while nobody was looking at this tab. */
  const heldRef = useRef(new Map<string, BuilderNotification>());

  const raise = useCallback((item: BuilderNotification) => {
    const popup = activationPopup(item);
    toast(popup.title, {
      id: `activation-${popup.id}`,
      description: popup.description,
      duration: 12_000,
      action: { label: 'Open', onClick: () => navigateRef.current(popup.href) },
    });
  }, []);

  const showHeldCount = useCallback(() => {
    const count = heldRef.current.size;
    if (count) setTitleCount(TITLE_SOURCE, count, 'New activation');
    else clearTitleCount(TITLE_SOURCE);
  }, []);

  useEffect(() => {
    if (!notifications) return;
    const backlog = !bootedRef.current;
    bootedRef.current = true;
    const away = document.visibilityState === 'hidden';
    for (const item of [...notifications].reverse()) {
      if (!isActivationToAnnounce(item) || popped.has(item.id)) continue;
      popped.add(item.id);
      if (backlog) {
        seedAlert(activationAlertKey(item.id), item.created_at);
      } else if (claimAlert(activationAlertKey(item.id), item.created_at)) {
        const popup = activationPopup(item);
        const outcome = deliverDesktopAlert(
          { key: activationAlertKey(item.id), heading: popup.title, body: popup.description ?? '', path: popup.href },
          (path) => navigateRef.current(path),
        );
        if (outcome === 'unsupported' && !away) offerDesktopAlerts();
      }
      if (away) {
        heldRef.current.set(item.id, item);
      } else {
        seedAlert(activationCatchUpKey(item.id), item.created_at);
        raise(item);
      }
    }
    showHeldCount();
  }, [notifications, raise, showHeldCount]);

  // Back in front of the builder: what arrived while they were away, once.
  useEffect(() => {
    const held = heldRef.current;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !held.size) return;
      const waiting = [...held.values()];
      held.clear();
      showHeldCount();
      for (const item of waiting) {
        if (!claimAlert(activationCatchUpKey(item.id), item.created_at)) continue;
        raise(item);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearTitleCount(TITLE_SOURCE);
    };
  }, [raise, showHeldCount]);

  return null;
}
