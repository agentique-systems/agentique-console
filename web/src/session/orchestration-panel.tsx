/**
 * The orchestration review surface: the governing spec revision, main's
 * working state (strategy, uncertainties, assumptions, risks), and every
 * commission joined to its rationale and outcome by stable ids. Read-only by
 * design — understanding the orchestrator's reasoning, not driving it — and
 * deliberately not a debugging dashboard: no handoff bodies, no event lists.
 */
import { useState } from "react";
import { useOrchestration, useRequirements } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { CommissionSummary } from "@agentique-console/shared";

const STATUS_TONE: Record<CommissionSummary["status"], string> = {
  working: "text-status-working",
  idle: "text-muted-foreground",
  reported: "text-status-completed",
  archived: "text-muted-foreground",
};

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="text-2xs font-medium uppercase text-muted-foreground">{title}</h3>
      <ul className="mt-1 space-y-1 text-2xs">
        {items.map((item) => <li key={item} className="text-foreground">• {item}</li>)}
      </ul>
    </div>
  );
}

function CommissionRow({ row }: { row: CommissionSummary }) {
  return (
    <div className={cn("rounded-md border border-border p-2", row.parentAgentSessionId !== null && "ml-4")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{row.title}</span>
        <Badge variant="outline" className="text-3xs">{row.pattern}</Badge>
        <Badge variant="outline" className={cn("text-3xs uppercase", STATUS_TONE[row.status])}>{row.status}</Badge>
        {row.steering.count > 0 && (
          <span className="text-3xs text-muted-foreground">steered ×{row.steering.count}</span>
        )}
      </div>
      {row.requirements.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {row.requirements.map((requirement) => (
            <Badge key={requirement.id} variant="outline" className="text-3xs" title={requirement.statement}>
              {requirement.id}
            </Badge>
          ))}
        </div>
      )}
      {row.commission !== null ? (
        <div className="mt-1 space-y-0.5 text-2xs text-muted-foreground">
          <div>{row.commission.action}</div>
          {row.commission.why !== null && <div>why: {row.commission.why}</div>}
          {row.commission.expecting !== null && <div>expecting: {row.commission.expecting}</div>}
        </div>
      ) : (
        <div className="mt-1 text-2xs text-muted-foreground">
          {row.parentAgentSessionId !== null ? "child session — commissioned by its controller" : "no briefing recorded"}
        </div>
      )}
      <div className="mt-1 text-2xs">
        {row.outcome !== null ? (
          <span className={cn(row.outcome.status === "completed" ? "text-status-completed" : "text-status-waiting")}>
            {row.outcome.trigger} ({row.outcome.status}): <span className="text-muted-foreground">{row.outcome.action}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">no terminal report yet</span>
        )}
      </div>
    </div>
  );
}

export function OrchestrationPanel({ userSessionId }: { userSessionId: string }) {
  const requirements = useRequirements(userSessionId);
  const orchestration = useOrchestration(userSessionId);
  const governing = requirements.data?.approved ?? null;
  const nodes = requirements.data?.nodes ?? [];
  const current = orchestration.data?.current ?? null;
  const commissions = orchestration.data?.commissions ?? [];

  return (
    <div className="min-h-0 space-y-4 overflow-y-auto p-4">
      <section>
        <h3 className="text-2xs font-medium uppercase text-muted-foreground">Requirements</h3>
        {governing !== null ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs">
            <Badge variant="outline" className="text-3xs">rev {governing.revision}</Badge>
            {governing.origin === "operator_edited" && <Badge variant="outline" className="text-3xs">operator-edited</Badge>}
            <span className="text-muted-foreground">
              {nodes.filter((node) => node.derivedStatus === "satisfied").length}/{nodes.length} satisfied — the requirements tab has the tree
            </span>
          </div>
        ) : (
          <p className="mt-1 text-2xs text-muted-foreground">No approved requirements — the run is governed by the conversation.</p>
        )}
      </section>

      <section>
        <h3 className="text-2xs font-medium uppercase text-muted-foreground">Working state</h3>
        {current === null ? (
          <p className="mt-1 text-2xs text-muted-foreground">No working state recorded.</p>
        ) : (
          <div className="mt-1 text-2xs">
            {current.strategy !== "" && (
              <p>
                <span className="font-medium">Strategy:</span> {current.strategy}
                {current.strategyWhy !== "" && <span className="text-muted-foreground"> — {current.strategyWhy}</span>}
              </p>
            )}
            <Bullets title="Open uncertainties" items={current.uncertainties} />
            <Bullets title="Assumptions" items={current.assumptions} />
            <Bullets title="Risks" items={current.risks} />
            <p className="mt-2 text-3xs text-muted-foreground">
              rev {current.revision} · {current.trigger}{current.note !== null ? ` · ${current.note}` : ""}
            </p>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-2xs font-medium uppercase text-muted-foreground">Commissions</h3>
        {commissions.length === 0 ? (
          <p className="mt-1 text-2xs text-muted-foreground">Nothing commissioned.</p>
        ) : (
          <div className="mt-1 space-y-2">
            {commissions.map((row) => <CommissionRow key={row.agentSessionId} row={row} />)}
          </div>
        )}
      </section>
    </div>
  );
}
