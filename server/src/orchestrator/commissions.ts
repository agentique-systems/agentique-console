/**
 * The commission read-model: every agent session joined to its rationale and
 * outcome by STABLE ids. The commission is the FIRST main→session assignment
 * handoff — by construction the creation briefing — so later steering can
 * never overwrite a commission's why/expecting, and the outcome is the last
 * terminal (final/failure) report to main. The old recency-based join
 * reported whatever main sent LAST as "the commission", nulling rationale a
 * routine relay didn't carry.
 */
import type { AgentSessionStatus, CommissionSummary } from "@agentique-console/shared";
import type { AgentSessionRow, HandoffRecordRow, Repo } from "../db/repo.ts";

export interface CommissionDeps {
  repo: Pick<Repo, "listAgentSessions" | "listHandoffs">;
  statusOf: (row: AgentSessionRow) => AgentSessionStatus;
  /** The delegated sub-scope join: agentSessionId → requirement (id, statement). */
  delegatedRequirements?: (agentSessionId: string) => { id: string; statement: string }[];
}

const TERMINAL_TRIGGERS = new Set(["final", "failure"]);

export function buildCommissions(deps: CommissionDeps, userSessionId: string): CommissionSummary[] {
  return deps.repo.listAgentSessions(userSessionId).map((session): CommissionSummary => {
    const fromMain = deps.repo.listHandoffs({
      userSessionId, agentSessionId: session.id, sender: "main", excludeCheckpoints: true, excludeSynthetic: true,
    });
    const toMain = deps.repo.listHandoffs({
      userSessionId, agentSessionId: session.id, recipient: "main", excludeCheckpoints: true, excludeSynthetic: true,
    });
    const briefing: HandoffRecordRow | undefined = fromMain[0];
    const data = (briefing?.extension?.data ?? {}) as { why?: unknown; expecting?: unknown };
    const terminal = [...toMain].reverse().find((row) => TERMINAL_TRIGGERS.has(row.trigger));
    return {
      agentSessionId: session.id,
      title: session.title,
      pattern: session.pattern,
      lifecycle: session.lifecycle,
      parentAgentSessionId: session.parentAgentSessionId,
      status: deps.statusOf(session),
      commission: briefing === undefined ? null : {
        handoffId: briefing.id,
        action: briefing.core.action.slice(0, 200),
        why: typeof data.why === "string" && data.why !== "" ? data.why : null,
        expecting: typeof data.expecting === "string" && data.expecting !== "" ? data.expecting : null,
        briefedAt: briefing.createdAt,
      },
      steering: { count: Math.max(0, fromMain.length - 1) },
      requirements: deps.delegatedRequirements?.(session.id) ?? [],
      outcome: terminal === undefined ? null : {
        handoffId: terminal.id,
        trigger: terminal.trigger,
        status: terminal.core.status,
        action: terminal.core.action.slice(0, 200),
      },
    };
  });
}
