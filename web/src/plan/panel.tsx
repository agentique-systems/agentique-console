import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import type { PlanEdge, PlanNode, PlanNodeSummary, RunOverview } from "@agentique-console/core";
import { usePlanNode, useRunPlan } from "@/api/queries";
import { Facts, Panel, Section } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { allocation, statusTone, TONE_CLASS, usage } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InvocationView } from "@/plan/invocation";

/** A layered layout from the edges: sources first; nodes on one layer share a column. */
export function layout(nodes: PlanNode[], edges: PlanEdge[]): Map<string, { layer: number; row: number }> {
  const layer = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) incoming.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  const visit = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => visit(p, seen))) + 1;
    layer.set(id, value);
    return value;
  };
  for (const node of nodes) visit(node.id, new Set());
  const rows = new Map<number, number>();
  const out = new Map<string, { layer: number; row: number }>();
  for (const node of nodes) {
    const l = layer.get(node.id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    out.set(node.id, { layer: l, row });
  }
  return out;
}

export function PlanPanel({ overview, entityId }: { overview: RunOverview; entityId: string | null }) {
  const plan = useRunPlan(overview.run.id);
  const navigate = useNavigate();
  const selectedNode = entityId !== null && entityId.startsWith("pn_") ? entityId : null;
  const selectedInvocation = entityId !== null && entityId.startsWith("inv_") ? entityId : null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Panel query={plan}>
        {(p) => (
          <>
            <PlanGraph plan={p} selected={selectedNode} onSelect={(id) => void navigate(`/runs/${overview.run.id}/plan/${id}`)} />
            <div className="text-3xs text-muted-foreground">
              Revision {p.revisionNumber} of {p.revisionCount}. {p.nodes.length} node{p.nodes.length === 1 ? "" : "s"}; the Orchestrator revises the plan from its turns.
            </div>
          </>
        )}
      </Panel>
      {selectedNode !== null && <NodeInspector planNodeId={selectedNode} runId={overview.run.id} />}
      {selectedInvocation !== null && <InvocationView invocationId={selectedInvocation} runId={overview.run.id} />}
    </div>
  );
}

const NODE_W = 220;
const NODE_H = 64;
const GAP_X = 60;
const GAP_Y = 20;

function PlanGraph({ plan, selected, onSelect }: { plan: { graph: { nodes: PlanNode[]; edges: PlanEdge[] }; nodes: PlanNodeSummary[] }; selected: string | null; onSelect: (id: string) => void }) {
  const positions = useMemo(() => layout(plan.graph.nodes, plan.graph.edges), [plan.graph.nodes, plan.graph.edges]);
  const summaries = new Map(plan.nodes.map((n) => [n.node.id, n] as const));
  const width = (Math.max(0, ...[...positions.values()].map((p) => p.layer)) + 1) * (NODE_W + GAP_X);
  const height = (Math.max(0, ...[...positions.values()].map((p) => p.row)) + 1) * (NODE_H + GAP_Y);
  const center = (id: string) => {
    const p = positions.get(id)!;
    return { x: p.layer * (NODE_W + GAP_X), y: p.row * (NODE_H + GAP_Y) };
  };
  return (
    <div className="overflow-auto rounded-md border border-border" data-testid="plan-graph">
      <svg width={width} height={height} className="block" role="img" aria-label="Execution Plan graph">
        {plan.graph.edges.map((edge) => {
          const a = center(edge.sourceNodeId);
          const b = center(edge.targetNodeId);
          return <line key={edge.id} x1={a.x + NODE_W} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y + NODE_H / 2} stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray={edge.type === "retry" ? "4 3" : undefined} />;
        })}
        {plan.graph.nodes.map((node) => {
          const p = center(node.id);
          const summary = summaries.get(node.id);
          const tone = statusTone(node.status);
          return (
            <foreignObject key={node.id} x={p.x} y={p.y} width={NODE_W} height={NODE_H}>
              <button type="button" onClick={() => onSelect(node.id)} aria-pressed={selected === node.id} className={cn("flex h-full w-full flex-col justify-center gap-0.5 rounded-md border bg-card px-2 py-1 text-left text-xs hover:bg-muted/40", TONE_CLASS[tone], selected === node.id && "ring-2 ring-ring")} data-node={node.id}>
                <span className="truncate font-medium text-foreground">{node.kind === "pattern" ? node.title : "join"}</span>
                <span className="flex items-center gap-1 text-3xs">
                  <StatusBadge status={node.status} />
                  <span className="text-muted-foreground">{node.kind === "pattern" ? node.pattern : node.fanInPolicy}</span>
                  {summary !== undefined && summary.invocations.length > 0 && <span className="text-muted-foreground">· {summary.invocations.length} inv</span>}
                </span>
              </button>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}

function NodeInspector({ planNodeId, runId }: { planNodeId: string; runId: string }) {
  const node = usePlanNode(planNodeId);
  return (
    <Panel query={node}>
      {(n) => (
        <div className="grid gap-4 md:grid-cols-2" data-testid="node-inspector">
          <Section title={`Plan Node ${n.node.kind === "pattern" ? n.node.title : "join"}`}>
            <Facts
              items={[
                ["Status", <StatusBadge key="s" status={n.node.status} />],
                ["Kind", n.node.kind === "pattern" ? `${n.node.pattern}` : `join (${n.node.fanInPolicy})`],
                ["Source path", n.node.sourcePath],
                ["Wait", n.node.waitReason ?? "—"],
                ["Allocation", n.allocation === null ? "—" : `${allocation(n.allocation.effective)} (used ${allocation(n.allocation.account.consumed)})`],
                ["Usage", usage(n.usage)],
                ["Tasks", n.taskCount],
                ["Gates", `${n.gates.map((g) => `${g.kind} ${g.status}`).join(", ") || "—"}${n.gateCount > n.gates.length ? ` (${n.gateCount - n.gates.length} older)` : ""}`],
                ["Evaluations", n.evaluationCount],
                ["Extensions", n.extensionCount],
              ]}
            />
          </Section>
          <Section title={`Invocations (${n.invocationCount})`}>
            {n.invocationCount > n.invocations.length && (
              <div className="text-3xs text-muted-foreground" data-testid="invocations-windowed">
                The {n.invocations.length} most recent of {n.invocationCount}; the Run's invocation list pages the rest.
              </div>
            )}
            <ul className="flex flex-col gap-1 text-xs">
              {n.invocations.map((i) => (
                <li key={i.id}>
                  <Link to={`/runs/${runId}/plan/${i.id}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 hover:bg-muted/40">
                    <StatusBadge status={i.status} />
                    <span>
                      {i.role} · {i.purpose}
                    </span>
                    <span className="flex-1" />
                    <span className="font-mono text-3xs text-muted-foreground">{i.id.slice(0, 12)}</span>
                  </Link>
                </li>
              ))}
              {n.invocations.length === 0 && <li className="text-muted-foreground">No Invocation yet.</li>}
            </ul>
          </Section>
        </div>
      )}
    </Panel>
  );
}
