import { useMemo } from "react";
import type { PlanEdge, PlanNode, PlanNodeSummary } from "@agentique-console/core";

import { StatusDot } from "@/components/status";
import { statusTone, TONE_BORDER, words, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { layout, NODE_H, NODE_W, place } from "@/plan/layout";

const PATTERN_LABELS: Record<string, string> = {
  single: "single",
  chain: "chain",
  route: "route",
  parallel: "parallel",
  coordinator_worker: "coordinator / workers",
  evaluator_optimizer: "evaluator / optimizer",
};

export function edgeStyle(type: PlanEdge["type"]): { dash: string | undefined; label: string } {
  switch (type) {
    case "sequence":
      return { dash: undefined, label: "then" };
    case "branch":
      return { dash: "6 4", label: "branch" };
    case "fan_in":
      return { dash: undefined, label: "join" };
    case "retry":
      return { dash: "2 3", label: "retry" };
  }
}

/**
 * The execution plan as a left-to-right graph: HTML node cards over an SVG of
 * curved edges. Colour on a card is its status; the current node of the
 * scheduler's projection carries a ring.
 */
export function PlanGraph({ plan, selected, current, onSelect }: { plan: { graph: { nodes: PlanNode[]; edges: PlanEdge[] }; nodes: PlanNodeSummary[] }; selected: string | null; current: ReadonlySet<string>; onSelect: (id: string) => void }) {
  const { placed, width, height } = useMemo(() => place(layout(plan.graph.nodes, plan.graph.edges)), [plan.graph.nodes, plan.graph.edges]);
  const summaries = useMemo(() => new Map(plan.nodes.map((n) => [n.node.id, n] as const)), [plan.nodes]);
  const at = (id: string) => placed.get(id) ?? { x: 0, y: 0 };
  return (
    <div className="relative min-h-0 flex-1 overflow-auto" data-testid="plan-graph">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0 text-muted-foreground" aria-hidden>
          <defs>
            <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.5 L8 4 L0 7.5 z" fill="currentColor" />
            </marker>
          </defs>
          {plan.graph.edges.map((edge) => {
            const a = at(edge.sourceNodeId);
            const b = at(edge.targetNodeId);
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const dx = Math.max(24, (x2 - x1) / 2);
            const style = edgeStyle(edge.type);
            const label = edge.type === "branch" ? edge.label : edge.type === "retry" ? `retry ${edge.round}` : null;
            return (
              <g key={edge.id} opacity={0.7}>
                <path d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={style.dash} markerEnd="url(#plan-arrow)" />
                {label !== null && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {plan.graph.nodes.map((node) => {
          const p = at(node.id);
          const summary = summaries.get(node.id);
          const tone: Tone = statusTone(node.status);
          const isSelected = selected === node.id;
          const isCurrent = current.has(node.id);
          const attempts = summary?.invocations.reduce((sum, i) => sum + i.attempts, 0) ?? 0;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              aria-pressed={isSelected}
              aria-label={`${node.kind === "pattern" ? node.title : "join"}, ${words(node.status)}`}
              data-node={node.id}
              data-status={node.status}
              className={cn(
                "surface-raised absolute flex flex-col justify-center gap-1 rounded-lg border bg-card px-3 py-2 text-left text-sm shadow-xs transition-[box-shadow,transform] outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/70",
                node.status === "pending" || node.status === "ready" ? "border-border" : TONE_BORDER[tone],
                isSelected && "ring-2 ring-foreground/70",
                isCurrent && !isSelected && "ring-2 ring-status-running/50",
              )}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot tone={tone} />
                <span className="min-w-0 flex-1 truncate font-medium">{node.kind === "pattern" ? node.title : "join"}</span>
                {isCurrent && <span className="rounded-sm bg-status-running/12 px-1 text-2xs text-status-running">current</span>}
              </span>
              <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                <span className="truncate">{node.kind === "pattern" ? (PATTERN_LABELS[node.pattern] ?? node.pattern) : `join · ${words(node.fanInPolicy)}`}</span>
                <span className="ml-auto shrink-0 font-mono">{words(node.status)}</span>
                {summary !== undefined && summary.invocations.length > 0 && (
                  <span className="shrink-0 font-mono" title={`${summary.invocations.length} Invocations, ${attempts} Attempts`}>
                    {summary.invocations.length} inv
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What the marks on the graph mean. */
export function PlanLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      {(["running", "waiting", "completed", "failed", "cancelled"] as const).map((tone) => (
        <span key={tone} className="flex items-center gap-1">
          <StatusDot tone={tone} live={false} />
          {tone === "completed" ? "succeeded" : tone}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" />
        </svg>
        branch
      </span>
      <span className="flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" />
        </svg>
        retry
      </span>
    </div>
  );
}
