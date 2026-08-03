/**
 * The plan-approval card: the proposed plan as rendered markdown plus the two
 * verbs. "Approve & execute" resolves the interaction; "Request changes" only
 * focuses the composer — the operator's next chat message auto-rejects the
 * plan server-side with that text as the note.
 */
import { FileTextIcon } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { useResolveInteraction } from "@/api/mutations";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { PlanItem } from "./user-fold";

export function PlanCard({
  sessionId,
  item,
  onRequestChanges,
}: {
  sessionId: string;
  item: PlanItem;
  /** Focuses the composer — the next chat message IS the change request. */
  onRequestChanges: () => void;
}) {
  const resolve = useResolveInteraction();
  const resolution = item.resolution;
  const resolved = resolution !== undefined;

  const approve = () => {
    resolve.mutate(
      {
        sessionId,
        interactionId: item.interactionId,
        body: { decision: "approve" },
      },
      {
        onError: (error) => {
          toast.error(
            error instanceof ApiError && error.status === 409
              ? "Already resolved elsewhere."
              : `Approve failed: ${error.message}`,
          );
        },
      },
    );
  };

  return (
    <div
      data-testid="plan-card"
      className={cn(
        "my-2 rounded-lg border border-border bg-card px-4 py-3",
        !resolved && "border-attention/50",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <FileTextIcon className="size-3.5 shrink-0 text-attention" />
        <span className="font-medium">proposed plan</span>
        {resolution !== undefined && (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase",
              resolution.approved
                ? "text-status-completed"
                : "text-status-waiting",
            )}
          >
            {resolution.approved ? "approved" : "revised"}
          </Badge>
        )}
      </div>

      <div className="text-sm">
        <MessageResponse>{item.plan}</MessageResponse>
      </div>

      {resolution?.note !== undefined && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          note: {resolution.note}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button size="xs" disabled={resolved || resolve.isPending} onClick={approve}>
          {resolve.isPending ? <Spinner className="size-3" /> : "Approve & execute"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={resolved || resolve.isPending}
          onClick={onRequestChanges}
        >
          Request changes
        </Button>
      </div>
    </div>
  );
}
