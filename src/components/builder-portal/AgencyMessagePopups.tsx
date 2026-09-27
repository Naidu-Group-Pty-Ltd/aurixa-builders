import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { useBuilderMyPreferences } from '@/lib/builderQueries';
import { builderStockKeys, readNewAgencyMessages } from '@/lib/builderStockQueries';
import {
  AGENCY_MESSAGE_POPUP_POLL_MS, agencyMessagePollingRefused, agencyMessagePopup, isViewingAgencyConversation,
} from '@/lib/agencyMessagePopups.pure';

/**
 * "New message from <agency>" — a popup wherever the reader is in the portal
 * when an agency writes in one of their conversations. The builder-side
 * counterpart of the Command Centre's popup, and the same kind of thing:
 * polling, never pushed.
 *
 * It asks `list_new_agency_messages` for what arrived after its cursor, every
 * five seconds while the tab is in view and at once when the tab comes back.
 * The first read only takes the cursor, so opening the portal never replays
 * messages from before. The server lists only conversations the reader is in,
 * in the organisation the session is acting for, and only what the agency
 * wrote; a refused read stops asking rather than retrying for ever.
 *
 * The same answer tells the conversation it names to re-read itself, so a
 * thread already on screen shows the message within one poll instead of on
 * its own ten-second cadence — and no popup is raised over the thread the
 * reader is looking at. "Tell me when a message is posted" (Settings → Your
 * preferences) turns the popup off; the thread still refreshes.
 */
export function AgencyMessagePopups() {
  const { user, activeOrganisation, can } = useBuilderPortalAuth();
  // Agency conversations are read under `inventory` view; nobody else is asked.
  if (!user || !activeOrganisation || !can('inventory', 'view')) return null;
  // A new reader or organisation starts again from a new cursor.
  return <AgencyMessagePoller key={`${user.id}:${activeOrganisation.organisation_id}`} />;
}

function AgencyMessagePoller() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const preferences = useBuilderMyPreferences();

  // The loop below runs once per mount; these keep what it reads current.
  const navigateRef = useRef(navigate);
  const locationRef = useRef(location);
  const announceRef = useRef(true);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  useEffect(() => { locationRef.current = location; }, [location]);
  // Until the preference is read — or where it cannot be — the column's own
  // default applies: tell them.
  useEffect(() => {
    announceRef.current = preferences.data?.notify_message_posted !== false;
  }, [preferences.data]);

  useEffect(() => {
    let cursor: string | null = null;
    let stopped = false;
    let inFlight = false;
    const shown = new Set<string>();

    const check = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const answer = await readNewAgencyMessages(cursor);
        const firstRead = cursor === null;
        if (answer?.cursor) cursor = answer.cursor;
        if (firstRead) return;
        const fresh = (answer?.messages ?? []).filter((message) => !shown.has(message.message_id));
        if (!fresh.length) return;

        // The popup's poll is the open thread's doorbell.
        for (const conversationId of new Set(fresh.map((message) => message.conversation_id))) {
          void queryClient.invalidateQueries({ queryKey: builderStockKeys.agencyConversation(conversationId) });
        }
        void queryClient.invalidateQueries({ queryKey: builderStockKeys.myAgencyConversations() });

        for (const message of fresh) {
          shown.add(message.message_id);
          if (!announceRef.current) continue;
          if (isViewingAgencyConversation(locationRef.current, message.conversation_id)) continue;
          const popup = agencyMessagePopup(message);
          toast(popup.title, {
            id: `agency-message-${popup.id}`,
            description: popup.description,
            duration: 12_000,
            action: { label: 'Open', onClick: () => navigateRef.current(popup.href) },
          });
        }
      } catch (error) {
        // A refusal will not change on the next tick; anything else might,
        // and the next tick asks again from the same cursor.
        if (agencyMessagePollingRefused((error as { status?: number } | null)?.status)) stopped = true;
      } finally {
        inFlight = false;
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), AGENCY_MESSAGE_POPUP_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [queryClient]);

  return null;
}
