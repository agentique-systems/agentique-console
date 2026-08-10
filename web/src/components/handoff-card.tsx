import type { HandoffSummary } from "@agentique-console/shared";
import { ArrowRightIcon, CircleAlertIcon, FileCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function HandoffCard({ handoff, sender, recipient }: { handoff: HandoffSummary; sender?: string; recipient?: string }) {
  return (
    <div className="surface-raised my-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-3xs uppercase tracking-wider text-muted-foreground">handoff</span>
        <Badge variant="outline">{handoff.status.replaceAll("_", " ")}</Badge>
        <Badge variant="outline" className={cn(handoff.risk === "high" && "border-status-failed text-status-failed")}>{handoff.risk} risk</Badge>
        {sender && recipient && <span className="ml-auto text-3xs text-muted-foreground">{sender} → {recipient}</span>}
      </div>
      <div className="font-medium">{handoff.action}</div>
      <div className="mt-1 text-muted-foreground">{handoff.stateSummary}</div>
      {handoff.resultSummary && <div className="mt-2"><FileCheckIcon className="mr-1 inline size-3.5" />{handoff.resultSummary}</div>}
      {handoff.nextAction && <div className="mt-2 text-xs"><ArrowRightIcon className="mr-1 inline size-3.5" />{handoff.nextAction}</div>}
      <div className="mt-2 font-mono text-3xs text-muted-foreground">
        {handoff.evidenceCount} evidence · {handoff.artifactCount} artifacts · {handoff.extensionKind}
      </div>
      {handoff.referenceWarnings.length > 0 && (
        <div className="mt-2 text-xs text-status-failed"><CircleAlertIcon className="mr-1 inline size-3.5" />{handoff.referenceWarnings.join("; ")}</div>
      )}
    </div>
  );
}
