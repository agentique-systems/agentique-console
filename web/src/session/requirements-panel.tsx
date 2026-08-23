/**
 * The requirement graph — the run's canonical specification — as the operator
 * reads it: the live tree with console-derived statuses, verification tiers
 * and evidence counts, delegation chips, the open-requirements frontier, and
 * the revision history. Read-mostly by design: the only actions are the
 * operator's own verdicts (satisfied / reopen / infeasible), because their
 * word IS the completion gate — everything else changes through main's tools.
 */
import { useState } from "react";
import { toast } from "sonner";

import { useRequirements } from "@/api/queries";
import { useResolveAssumption, useSetRequirementStatus } from "@/api/mutations";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type {
  AssumptionWire,
  RequirementFrontierEntry,
  RequirementNodeWire,
  RequirementStatus,
} from "@agentique-console/shared";

const STATUS_GLYPH: Record<RequirementStatus, string> = {
  open: "·",
  satisfied: "✓",
  violated: "✗",
  infeasible: "⊘",
  retired: "†",
};

const STATUS_TONE: Record<RequirementStatus, string> = {
  open: "text-muted-foreground",
  satisfied: "text-status-completed",
  violated: "text-status-failed",
  infeasible: "text-status-failed",
  retired: "text-muted-foreground",
};

const ANNOTATION_LABEL: Record<RequirementFrontierEntry["annotations"][number], string> = {
  in_progress: "in progress",
  blocked: "blocked",
  awaiting_operator: "awaiting you",
  unassigned: "unassigned",
};

/** Depth by parent chain — the API serves nodes in depth-first order. */
function depthOf(node: RequirementNodeWire, byId: Map<string, RequirementNodeWire>): number {
  let depth = 0;
  for (let parent = node.parentId; parent !== null; parent = byId.get(parent)?.parentId ?? null) depth += 1;
  return depth;
}

function NodeRow({ sessionId, node, depth, isLeaf, verifyGap }: {
  sessionId: string;
  node: RequirementNodeWire;
  depth: number;
  isLeaf: boolean;
  /** The unmet declared expectation, when this leaf is satisfied below it. */
  verifyGap?: "independent" | "operator";
}) {
  const setStatus = useSetRequirementStatus();
  const [confirming, setConfirming] = useState<"satisfied" | "infeasible" | null>(null);
  const [note, setNote] = useState("");
  // Parents render their derived roll-up; only LEAVES take operator verdicts —
  // the console derives, it never lets anyone assert a parent.
  const status = node.derivedStatus;

  // The note travels ONLY with the verdict it was typed for — passed in by
  // the confirm button, never read from state, so a note left behind by a
  // cancelled confirm can't attach to a later action (reopen posts none).
  const act = (to: "open" | "satisfied" | "infeasible", verdictNote = "") => {
    setStatus.mutate(
      { sessionId, requirementId: node.id, body: { status: to, ...(verdictNote.trim() === "" ? {} : { note: verdictNote.trim() }) } },
      {
        onSuccess: () => { setConfirming(null); setNote(""); },
        onError: (error) => toast.error(`Status change failed: ${error.message}`),
      },
    );
  };

  return (
    <div className="group" style={{ paddingLeft: `${depth * 14}px` }} data-testid={`requirement-${node.id}`}>
      <div className="flex flex-wrap items-baseline gap-1.5 py-0.5">
        <span className={cn("font-mono text-xs", STATUS_TONE[status])}>[{STATUS_GLYPH[status]}]</span>
        <span className="font-mono text-3xs text-muted-foreground">{node.id}</span>
        {node.composition === "any" && <Badge variant="outline" className="text-3xs">any of</Badge>}
        {node.verifyExpectation !== null && (
          <Badge variant="outline" className="text-3xs text-muted-foreground" title="declared verification expectation (committed)">
            verify: {node.verifyExpectation}
          </Badge>
        )}
        {verifyGap !== undefined && (
          <Badge variant="outline" className="text-3xs text-attention" title="satisfied below its declared verification tier">
            needs {verifyGap} verification
          </Badge>
        )}
        <span className={cn("text-xs", node.derivedStatus === "retired" && "line-through")}>{node.statement}</span>
        {node.origin === "refinement" && (
          <Badge variant="outline" className="text-3xs text-muted-foreground" title={node.refinedByAgentSessionId === null ? "decomposed during the run" : `decomposed by session ${node.refinedByAgentSessionId}`}>
            refined
          </Badge>
        )}
        {node.latestChange !== null && node.latestChange.status !== "open" && (
          <span className="text-3xs text-muted-foreground" title={`recorded by ${node.latestChange.actor}`}>
            {node.latestChange.verifiedBy}
            {node.latestChange.evidenceCount > 0 ? ` · ${node.latestChange.evidenceCount} evidence` : " · no evidence"}
          </span>
        )}
        {node.delegatedTo.length > 0 && (
          <span className="text-3xs text-status-working" title={node.delegatedTo.join(", ")}>
            delegated ×{node.delegatedTo.length}
          </span>
        )}
        {node.dependsOn.length > 0 && (
          <span className="text-3xs text-muted-foreground" title={`cannot be satisfied before ${node.dependsOn.join(", ")}`}>
            depends on {node.dependsOn.join(", ")}
          </span>
        )}
        {node.conflictsWith.length > 0 && (
          <Badge variant="outline" className="text-3xs text-status-failed" title="recorded conflict — resolved by an amendment or your decision">
            conflicts {node.conflictsWith.join(", ")}
          </Badge>
        )}
        {node.restsOn.length > 0 && (
          <span className="text-3xs text-muted-foreground" title="recorded assumptions this requirement rests on">
            rests on {node.restsOn.map((entry) => entry.id).join(", ")}
          </span>
        )}
        {node.flags.map((flag) => (
          <Badge key={flag} variant="outline" className="text-3xs text-attention"
            title={flag === "depends_changed"
              ? "a dependency changed AFTER this claim was recorded — the claim may be stale"
              : "an assumption under this claim was falsified AFTER it was recorded"}>
            {flag === "depends_changed" ? "depends changed" : "rests on falsified"}
          </Badge>
        ))}
        {isLeaf && (
          <span className="hidden gap-1 group-hover:inline-flex">
            {status !== "satisfied" && (
              <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => { setConfirming("satisfied"); setNote(""); }}>
                mark satisfied
              </button>
            )}
            {status !== "open" && (
              <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => act("open")}>
                reopen
              </button>
            )}
            {status === "open" && (
              <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => { setConfirming("infeasible"); setNote(""); }}>
                mark infeasible
              </button>
            )}
          </span>
        )}
      </div>
      {confirming !== null && (
        <div className="mb-1 flex items-center gap-1.5">
          <input
            className="w-64 rounded-md border border-border bg-card px-2 py-0.5 text-3xs"
            placeholder={`why ${confirming} — recorded with your verdict (optional)`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button type="button" className="text-3xs underline" disabled={setStatus.isPending} onClick={() => act(confirming, note)}>
            confirm {confirming}
          </button>
          <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => { setConfirming(null); setNote(""); }}>
            cancel
          </button>
        </div>
      )}
    </div>
  );
}

const ASSUMPTION_TONE: Record<AssumptionWire["status"], string> = {
  open: "text-muted-foreground",
  confirmed: "text-status-completed",
  falsified: "text-status-failed",
  retired: "text-muted-foreground",
};

function AssumptionRow({ sessionId, assumption }: { sessionId: string; assumption: AssumptionWire }) {
  const resolve = useResolveAssumption();
  const act = (outcome: "confirmed" | "falsified" | "retired") => {
    resolve.mutate(
      { sessionId, assumptionId: assumption.id, body: { outcome } },
      { onError: (error) => toast.error(`Resolve failed: ${error.message}`) },
    );
  };
  return (
    <li className="group flex flex-wrap items-baseline gap-1.5 text-2xs" data-testid={`assumption-${assumption.id}`}>
      <span className="font-mono text-3xs text-muted-foreground">{assumption.id}</span>
      <span className={cn(assumption.status === "retired" && "line-through")}>{assumption.text}</span>
      <span className={cn("text-3xs", ASSUMPTION_TONE[assumption.status])} title={`recorded by ${assumption.actor}`}>
        {assumption.status}
      </span>
      {assumption.requirementIds.length > 0 && (
        <span className="text-3xs text-muted-foreground" title="requirements resting on this premise">
          [{assumption.requirementIds.join(", ")}]
        </span>
      )}
      {assumption.status === "open" && (
        <span className="hidden gap-1 group-hover:inline-flex">
          <button type="button" className="text-3xs text-muted-foreground underline" disabled={resolve.isPending} onClick={() => act("confirmed")}>confirm</button>
          <button type="button" className="text-3xs text-muted-foreground underline" disabled={resolve.isPending} onClick={() => act("falsified")}>falsify</button>
          <button type="button" className="text-3xs text-muted-foreground underline" disabled={resolve.isPending} onClick={() => act("retired")}>retire</button>
        </span>
      )}
    </li>
  );
}

export function RequirementsPanel({ userSessionId }: { userSessionId: string }) {
  const requirements = useRequirements(userSessionId);
  const [showRevisions, setShowRevisions] = useState(false);
  const data = requirements.data;

  if (!data) return <p className="p-4 text-xs text-muted-foreground">Loading requirements…</p>;
  if (data.approved === null) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        No approved requirements — the orchestrator proposes them with propose_requirements, and your approval commits them.
      </p>
    );
  }

  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const counts = data.nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.derivedStatus] = (acc[node.derivedStatus] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-0 space-y-4 overflow-y-auto p-4" data-testid="requirements-panel">
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-2xs font-medium uppercase text-muted-foreground">Requirements</h3>
          <Badge variant="outline" className="text-3xs">rev {data.approved.revision}</Badge>
          <span className="text-3xs text-muted-foreground">
            {counts.satisfied ?? 0}/{data.nodes.length} satisfied
            {(counts.violated ?? 0) > 0 ? ` · ${counts.violated} violated` : ""}
            {(counts.infeasible ?? 0) > 0 ? ` · ${counts.infeasible} infeasible` : ""}
          </span>
        </div>
        <div className="mt-2">
          {data.nodes.map((node) => {
            const gap = data.verificationGaps.find((entry) => entry.requirementId === node.id);
            return (
              <NodeRow
                key={node.id}
                sessionId={userSessionId}
                node={node}
                depth={depthOf(node, byId)}
                isLeaf={!data.nodes.some((candidate) => candidate.parentId === node.id)}
                {...(gap === undefined ? {} : { verifyGap: gap.expected })}
              />
            );
          })}
        </div>
      </section>

      {data.verificationGaps.length > 0 && (
        <section>
          <h3 className="text-2xs font-medium uppercase text-muted-foreground">Verification gaps</h3>
          <ul className="mt-1 space-y-1">
            {data.verificationGaps.map((gap) => (
              <li key={gap.requirementId} className="flex flex-wrap items-baseline gap-1.5 text-2xs">
                <span className="font-mono text-3xs text-muted-foreground">{gap.requirementId}</span>
                <span>{gap.statement}</span>
                <Badge variant="outline" className="text-3xs text-attention">
                  needs {gap.expected} · claimed {gap.recorded.verifiedBy} by {gap.recorded.actor}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.reversals.length > 0 && (
        <section>
          <h3 className="text-2xs font-medium uppercase text-muted-foreground">
            Claims later reversed ({data.reversals.length})
          </h3>
          <ul className="mt-1 space-y-1">
            {data.reversals.map((reversal, index) => (
              <li key={`${reversal.requirementId}-${index}`} className="flex flex-wrap items-baseline gap-1.5 text-2xs">
                <span className="font-mono text-3xs text-muted-foreground">{reversal.requirementId}</span>
                <span>
                  {reversal.from} → {reversal.to} by {reversal.reversedBy.actor}
                  {reversal.original !== null
                    ? ` (original claim ${reversal.original.verifiedBy} by ${reversal.original.actor})`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-2xs font-medium uppercase text-muted-foreground">Open requirements</h3>
        {data.frontier.length === 0 ? (
          <p className="mt-1 text-2xs text-muted-foreground">Nothing open — every requirement is settled or closed by an alternative.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {data.frontier.map((entry) => (
              <li key={entry.requirementId} className="flex flex-wrap items-baseline gap-1.5 text-2xs">
                <span className="font-mono text-3xs text-muted-foreground">{entry.requirementId}</span>
                <span>{entry.statement}</span>
                {entry.annotations.map((annotation) => (
                  <Badge key={annotation} variant="outline" className={cn("text-3xs", annotation === "awaiting_operator" && "text-attention")}>
                    {ANNOTATION_LABEL[annotation]}
                  </Badge>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.assumptions.length > 0 && (
        <section data-testid="assumptions-section">
          <h3 className="text-2xs font-medium uppercase text-muted-foreground">Assumptions</h3>
          <ul className="mt-1 space-y-1">
            {data.assumptions.map((assumption) => (
              <AssumptionRow key={assumption.id} sessionId={userSessionId} assumption={assumption} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <button type="button" className="text-3xs text-muted-foreground underline" onClick={() => setShowRevisions((value) => !value)}>
          {showRevisions ? "hide" : "show"} revision history ({data.revisions.length})
        </button>
        {showRevisions && (
          <ul className="mt-1 space-y-0.5 text-2xs">
            {data.revisions.map((revision) => (
              <li key={revision.id} className="text-muted-foreground">
                rev {revision.revision} · {revision.status} · {revision.nodeCount} requirements
                {revision.changeNote !== null ? ` — ${revision.changeNote}` : ""}
                {revision.origin === "operator_edited" ? " (operator-edited)" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
