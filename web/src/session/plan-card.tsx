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
import {
  Card,
  CardContent,
  CardEyebrow,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
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
    <Card
      data-testid="plan-card"
      className={cn("my-2", !resolved && "border-attention/50")}
    >
      <CardHeader>
        <CardEyebrow className={cn(!resolved && "text-attention")}>
          <FileTextIcon className="size-3.5 shrink-0" />
          <span>proposed plan</span>
        </CardEyebrow>
        {resolution !== undefined && (
          <Badge
            variant="outline"
            className={cn(
              "text-3xs uppercase",
              resolution.approved
                ? "text-status-completed"
                : "text-status-waiting",
            )}
          >
            {resolution.approved ? "approved" : "revised"}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        <MessageResponse>{item.plan}</MessageResponse>
        {resolution?.note !== undefined && (
          <div className="mt-2 text-2xs text-muted-foreground">
            note: {resolution.note}
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-0">
        <Button
          size="xs"
          disabled={resolved || resolve.isPending}
          onClick={approve}
        >
          {resolve.isPending ? (
            <Spinner className="size-3" />
          ) : (
            "Approve & execute"
          )}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={resolved || resolve.isPending}
          onClick={onRequestChanges}
        >
          Request changes
        </Button>
      </CardFooter>
    </Card>
  );
}
