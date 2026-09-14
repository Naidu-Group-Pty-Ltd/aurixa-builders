import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarClock } from "lucide-react";
import type { PartnerPortalAdapter, PartnerWorkspaceDto } from "./types";

/** Open requests, evidence expiry and refresh obligations at a glance.
 * Service/settlement implications appear only when the server supplied a
 * task for them — nothing is inferred client-side. */
export function TaskDeadlineRail({
  workspace, adapter,
}: { workspace: PartnerWorkspaceDto; adapter: PartnerPortalAdapter }) {
  if (workspace.tasks.length === 0) return null;
  return (
    <Card data-testid="partner-task-rail">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" aria-hidden="true" /> Tasks and deadlines
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-xs">
          {workspace.tasks.map((t, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2">
              <span>{adapter.deadlineLabels?.[t.kind] ?? t.label}</span>
              {t.due_at && (
                <span className="text-muted-foreground">
                  {new Date(t.due_at).toLocaleDateString('en-AU')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
