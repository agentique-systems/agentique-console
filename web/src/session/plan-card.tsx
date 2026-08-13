/**
 * The plan-approval card: the proposed plan as rendered markdown plus the two
 * verbs. "Approve & execute" resolves the interaction; "Request changes" only
 * focuses the composer — the operator's next chat message auto-rejects the
 * plan server-side with that text as the note.
 */
import { FileTextIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
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
  // Edit-in-place: the operator's version becomes the governing text — their
  // words outrank the proposal. (The roguelike run's operator had no way to
  // say "none of these" except chat, which lost the answer.)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.plan);

  const approve = () => {
    const edited = editing && draft.trim() !== "" && draft.trim() !== item.plan.trim();
    resolve.mutate(
      {
        sessionId,
        interactionId: item.interactionId,
        body: { decision: "approve", ...(edited ? { editedDocument: draft } : {}) },
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
          <span>{item.spec !== undefined ? `proposed specification (rev ${item.spec.revision})` : "proposed plan"}</span>
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
        {editing && !resolved ? (
          <textarea
            className="min-h-48 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="edit the proposed text"
          />
        ) : (
          <MessageResponse>{item.plan}</MessageResponse>
        )}
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
          onClick={() => setEditing((value) => !value)}
        >
          <PencilIcon className="size-3" />
          {editing ? "Preview" : "Edit"}
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
