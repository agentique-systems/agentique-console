/**
 * The plan-approval card: the proposed plan as rendered markdown plus the two
 * verbs. "Approve & execute" resolves the interaction; "Request changes" only
 * focuses the composer — the operator's next chat message auto-rejects the
 * plan server-side with that text as the note.
 *
 * A REQUIREMENTS proposal rides the same card with the `requirements` marker:
 * the preview renders the parsed outline as a tree, and the edit-in-place
 * textarea live-parses through the SAME shared grammar the server enforces —
 * Approve disables on a parse error, so a bad edit can never eat an approval
 * (the server's soft-fail 400 remains the backstop).
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

import { flattenRequirementGraph, parseRequirementsDocument } from "@agentique-console/shared";

import type { PlanItem } from "./user-fold";

/** The parsed outline as an indented tree — the requirements preview. */
function RequirementsPreview({ document }: { document: string }) {
  const parsed = parseRequirementsDocument(document);
  if (!parsed.ok) return <MessageResponse>{document}</MessageResponse>;
  const preamble = [
    ...(parsed.graph.title !== null ? [`# ${parsed.graph.title}`] : []),
    ...parsed.graph.preamble.map((section) => `${section.heading === "" ? "" : `**${section.heading}** — `}${section.body}`),
  ].join("\n\n");
  return (
    <div className="text-xs">
      {preamble !== "" && <MessageResponse>{preamble}</MessageResponse>}
      <div className="mt-2 space-y-0.5" data-testid="requirements-preview">
        {flattenRequirementGraph(parsed.graph).map((row, index) => (
          <div key={`${row.id ?? "new"}-${index}`} style={{ paddingLeft: `${row.depth * 14}px` }} className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-3xs text-muted-foreground">{row.id ?? "new"}</span>
            {row.composition === "any" && <Badge variant="outline" className="text-3xs">any of</Badge>}
            <span>{row.statement}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

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
  const isRequirements = item.requirements !== undefined;
  // The edit survives the Edit/Preview toggle, so EVERYTHING keys off the
  // draft differing from the proposal — never off the editing flag: a dirty
  // draft is what approve sends, what the preview renders, and what the
  // parse guard protects, whichever pane is showing.
  const dirty = draft.trim() !== "" && draft.trim() !== item.plan.trim();
  // Live parse of the operator's edit against the shared grammar; the server
  // re-validates on resolve (400 + line errors) as the backstop.
  const editParse = isRequirements && (editing || dirty) ? parseRequirementsDocument(draft) : null;
  const editInvalid = editParse !== null && !editParse.ok;

  const approve = () => {
    const edited = dirty;
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
          <span>
            {item.requirements !== undefined
              ? `proposed requirements (rev ${item.requirements.revision}, ${item.requirements.nodeCount} requirements)`
              : item.spec !== undefined ? `proposed specification (rev ${item.spec.revision})` : "proposed plan"}
            {(item.requirements?.changeNote ?? item.spec?.changeNote) !== undefined && (
              <span className="ml-1 normal-case text-muted-foreground">— {item.requirements?.changeNote ?? item.spec?.changeNote}</span>
            )}
          </span>
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
        ) : isRequirements ? (
          // A dirty draft IS what approve will send — preview it, not the
          // superseded proposal.
          <RequirementsPreview document={dirty ? draft : item.plan} />
        ) : (
          <MessageResponse>{dirty && !resolved ? draft : item.plan}</MessageResponse>
        )}
        {/* Outside the pane switch: a dirty invalid draft must show WHY
            Approve is disabled from the preview too. */}
        {!resolved && editInvalid && editParse !== null && !editParse.ok && (
          <ul className="mt-1 space-y-0.5 text-2xs text-status-failed" data-testid="requirements-parse-errors">
            {editParse.errors.slice(0, 6).map((error) => (
              <li key={`${error.line}:${error.message}`}>line {error.line}: {error.message}</li>
            ))}
          </ul>
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
          disabled={resolved || resolve.isPending || editInvalid}
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
