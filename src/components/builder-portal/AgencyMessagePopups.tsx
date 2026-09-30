import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { useBuilderMyPreferences } from '@/lib/builderQueries';
import { builderStockKeys, readNewAgencyMessages } from '@/lib/builderStockQueries';
import {
  AGENCY_MESSAGE_BACKGROUND_POLL_MS, AGENCY_MESSAGE_POPUP_POLL_MS, agencyAlertKey, agencyCatchUpKey,
  agencyConversationPopup, agencyMessagePollingRefused, groupAgencyMessages, isViewingAgencyConversation,
  type NewAgencyMessage,
} from '@/lib/agencyMessagePopups.pure';
import {
  claimAlert, clearTitleCount, deliverDesktopAlert, dismissDesktopAlert, seedAlert, setTitleCount,
} from '@/lib/builderPortalAlerts';
import { offerDesktopAlerts } from './offerDesktopAlerts';

/** The tab-title count this component publishes. */
const TITLE_SOURCE = 'agency-messages';

/**
 * "New message from <agency>" — wherever the builder is, not only on the
 * Messages page, and not only while they are looking at the portal. The
 * builder-side counterpart of the Command Centre's popup, and the same kind
 * of thing: polling, never pushed.
 *
 * It asks `list_new_agency_messages` for what arrived after its cursor: every
 * five seconds while the tab is in view, every thirty while it is not, and at
 * once when the tab comes back. The first read only takes the cursor, so
 * opening the portal never replays messages from before. The server lists
 * only conversations the reader is in, in the organisation the session is
 * acting for, and only what the agency wrote; a refused read stops asking
 * rather than retrying for ever.
 *
 * Where the message reaches them:
 *   • In this tab — a pop-up with an Open button, one per conversation, so a
 *     conversation that received three messages says so once. Nothing is
 *     raised over the thread they are already reading.
 *   • Somewhere else — a desktop notification (once per person however many
 *     tabs are open, and only where they turned desktop alerts on), a count
 *     on the tab, and the pop-up waiting when they come back, shown by
 *     whichever tab they return to first.
 *
 * The same answer tells the conversation it names to re-read itself, so a
 * thread already on screen shows the message within one poll instead of on
 * its own ten-second cadence. "Tell me when a message is posted" (Settings →
 * Your preferences) turns the pop-up, the notification and the count off;
 * the thread still refreshes.
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

  // Opening a conversation puts away its desktop notification.
  useEffect(() => {
    const thread = new URLSearchParams(location.search).get('thread');
    if (thread && isViewingAgencyConversation(location, thread)) dismissDesktopAlert(agencyAlertKey(thread));
  }, [location]);

  useEffect(() => {
    let cursor: string | null = null;
    let stopped = false;
    let inFlight = false;
    let lastAskedAt = 0;
    const shown = new Set<string>();
    /** What arrived while nobody was looking at this tab, by conversation. */
    const held = new Map<string, NewAgencyMessage[]>();

    const open = (path: string) => navigateRef.current(path);

    const raise = (messages: NewAgencyMessage[]) => {
      const popup = agencyConversationPopup(messages);
      toast(popup.title, {
        id: `agency-conversation-${popup.id}`,
        description: popup.description,
        duration: 12_000,
        action: { label: 'Open', onClick: () => open(popup.href) },
      });
    };

    const showHeldCount = () => {
      let count = 0;
      let label: string | undefined;
      for (const messages of held.values()) {
        count += messages.length;
        const agency = messages[messages.length - 1].agency_name?.trim();
        if (agency) label = `${agency} sent a message`;
      }
      if (count) setTitleCount(TITLE_SOURCE, count, label ?? 'New agency message');
      else clearTitleCount(TITLE_SOURCE);
    };

    const check = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState === 'hidden' && Date.now() - lastAskedAt < AGENCY_MESSAGE_BACKGROUND_POLL_MS) return;
      inFlight = true;
      lastAskedAt = Date.now();
      try {
        const answer = await readNewAgencyMessages(cursor);
        const firstRead = cursor === null;
        if (answer?.cursor) cursor = answer.cursor;
        if (firstRead) return;
        const fresh = (answer?.messages ?? []).filter((message) => !shown.has(message.message_id));
        if (!fresh.length) return;
        for (const message of fresh) shown.add(message.message_id);

        // The popup's poll is the open thread's doorbell.
        for (const conversationId of new Set(fresh.map((message) => message.conversation_id))) {
          void queryClient.invalidateQueries({ queryKey: builderStockKeys.agencyConversation(conversationId) });
        }
        void queryClient.invalidateQueries({ queryKey: builderStockKeys.myAgencyConversations() });

        if (!announceRef.current) return;
        const away = document.visibilityState === 'hidden';
        for (const arrival of groupAgencyMessages(fresh)) {
          // The conversation is on screen: it has just re-read itself.
          if (!away && isViewingAgencyConversation(locationRef.current, arrival.conversationId)) {
            seedAlert(agencyAlertKey(arrival.conversationId), arrival.latest.received_at);
            seedAlert(agencyCatchUpKey(arrival.conversationId), arrival.latest.received_at);
            continue;
          }
          // Once per person, however many tabs are open.
          if (claimAlert(agencyAlertKey(arrival.conversationId), arrival.latest.received_at)) {
            const popup = agencyConversationPopup(arrival.messages);
            const outcome = deliverDesktopAlert(
              { key: agencyAlertKey(arrival.conversationId), heading: popup.title, body: popup.description, path: popup.href },
              open,
            );
            if (outcome === 'unsupported' && !away) offerDesktopAlerts();
          }
          if (away) {
            held.set(arrival.conversationId, [...(held.get(arrival.conversationId) ?? []), ...arrival.messages]);
          } else {
            seedAlert(agencyCatchUpKey(arrival.conversationId), arrival.latest.received_at);
            raise(arrival.messages);
          }
        }
        showHeldCount();
      } catch (error) {
        // A refusal will not change on the next tick; anything else might,
        // and the next tick asks again from the same cursor.
        if (agencyMessagePollingRefused((error as { status?: number } | null)?.status)) stopped = true;
      } finally {
        inFlight = false;
      }
    };

    // Back in front of the reader: what arrived while they were away, once.
    const showHeld = () => {
      if (document.visibilityState !== 'visible' || !held.size) return;
      const waiting = [...held.values()];
      held.clear();
      showHeldCount();
      for (const messages of waiting) {
        const latest = messages[messages.length - 1];
        if (isViewingAgencyConversation(locationRef.current, latest.conversation_id)) continue;
        // Another tab the reader came back to first has already shown these.
        if (!claimAlert(agencyCatchUpKey(latest.conversation_id), latest.received_at)) continue;
        raise(messages);
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), AGENCY_MESSAGE_POPUP_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      showHeld();
      void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearTitleCount(TITLE_SOURCE);
    };
  }, [queryClient]);

  return null;
}
