import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNewerBuildAvailable } from '@/hooks/useNewerBuildAvailable';

/**
 * Says so when this tab is running an older build than the site serves, and
 * offers the one remedy: reload. Never reloads by itself — a half-written
 * message or form would be lost.
 */
export function NewerBuildBanner() {
  const newer = useNewerBuildAvailable();
  if (!newer) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
      <span className="text-foreground">
        A newer version of the portal is available. Reload to keep your messages and properties up to date.
      </span>
      <Button type="button" size="sm" onClick={() => window.location.reload()}>
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
        Reload
      </Button>
    </div>
  );
}
