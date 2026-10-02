import { useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { AgencyConversations } from '@/components/builder-portal/AgencyConversations';
import { useRefreshMyAgencyConversations } from '@/lib/builderStockQueries';
import { messagesViewFrom } from '@/lib/builderAgency';

/**
 * Builder Portal — Messages: the portal's one home for messaging.
 *
 * ONE KIND OF CONVERSATION. Each acknowledged activation opens a private
 * conversation with the agency user who made it (docs/builder-portal/62);
 * those are what this page draws. Project conversations — a thread a builder
 * started against their own project, with nobody on the other side — were a
 * second tab here and are withdrawn (`WITHDRAWN_BUILDER_MESSAGE_VIEWS`).
 *
 * So there is no tab strip: one offered view needs no chooser. Every URL that
 * named the withdrawn tab — `?view=projects` and the four keys a project
 * conversation was addressed by — resolves through `messagesViewFrom` to the
 * agency conversations, so a bookmark lands on a working page rather than an
 * empty one. The records themselves are untouched; this is what the portal
 * OFFERS, not what the database holds.
 */
export default function BuilderMessages() {
  const [params] = useSearchParams();
  /*
   * Read, not merely defaulted: a URL naming the withdrawn view resolves to
   * the offered one here, so the page below is the only thing it can draw.
   */
  const view = messagesViewFrom(params);
  const refreshAgency = useRefreshMyAgencyConversations();

  return (
    <BuilderPortalShell
      title="Messages"
      description="Your private conversations with connected agencies about the properties they activated."
      actions={
        <Button variant="outline" size="sm" onClick={() => void refreshAgency()}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
          Refresh
        </Button>
      }
    >
      {view === 'agencies' ? <AgencyConversations /> : null}
    </BuilderPortalShell>
  );
}
