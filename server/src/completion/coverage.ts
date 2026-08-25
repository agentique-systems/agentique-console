/**
 * The completion coverage evaluator: how the Console answers, from durable
 * state only, "for the current approved objective, what remains unsatisfied,
 * stale, insufficiently verified, unfinished, or defaulted?" before the
 * operator is asked to sign off.
 *
 * Division of labor, run doctrine applied to completion: the CONSOLE computes
 * compliance (this file — every fact here is derivable from rows); MAIN
 * supplies synthesis (record_completion's gaps/non-goals rationale); the
 * OPERATOR judges meaning and accepts exceptions as typed waivers at sign-off
 * (completion/service.ts). Nothing here consults a model, so the report is
 * reproducible from the database at any moment — the tail summary reads it
 * mid-run, the proposal persists it verbatim, and the accept path recomputes
 * it as the staleness guard.
 *
 * Coverage is null when no requirement revision governs: without an
 * operator-approved frontier there is nothing to account against, exactly the
 * boundary the completion-record oracle already draws.
 */
import type {
  ChangeImpactWire,
  CompletionCoverageReport,
  CompletionPolicy,
  CoverageException,
  CoverageObligation,
  DecisionIssueWire,
  Task,
  WorkstreamLinkWire,
} from "@agentique-console/shared";
import { nowIso } from "../ids.ts";

/** Narrow read closures over other aggregates' facts — wired once in createApp. */
export interface CoverageDeps {
  /** The current approved requirement revision; null = nothing governs. */
  governingRevision(userSessionId: string): number | null;
  /** RequirementService.completionObligations — the exactly-once leaf frontier. */
  obligations(userSessionId: string): CoverageObligation[];
  /** All live requirement ids (parents included) — task links may name non-leaves. */
  liveRequirementIds(userSessionId: string): Set<string>;
  listTasks(userSessionId: string): Task[];
  listOpenDecisionIssues(userSessionId: string): DecisionIssueWire[];
  listOpenChangeImpacts(userSessionId: string): ChangeImpactWire[];
  brokenWorkstreamLinks(userSessionId: string): WorkstreamLinkWire[];
  isAgentSessionOpen(agentSessionId: string): boolean;
  policy: CompletionPolicy;
}

const clip = (text: string, max = 120): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function computeCoverageReport(deps: CoverageDeps, userSessionId: string): CompletionCoverageReport | null {
  const revision = deps.governingRevision(userSessionId);
  if (revision === null) return null;

  const obligations = deps.obligations(userSessionId);
  const exceptions: CoverageException[] = [];
  const counts = { satisfied: 0, open: 0, violated: 0, infeasible: 0, moot: 0, stale: 0 };

  for (const obligation of obligations) {
    counts[obligation.state] += 1;
    // A moot leaf is accounted for (the chosen alternative discharged it) and
    // can never be an exception — that is the whole point of classifying it.
    if (obligation.state === "moot") continue;
    if (obligation.stale) counts.stale += 1;
    const name = `${obligation.requirementId} ("${clip(obligation.statement)}")`;
    if (obligation.state === "open" || obligation.state === "violated") {
      exceptions.push({
        kind: "requirement_unsatisfied",
        ref: obligation.requirementId,
        detail: `${name} is ${obligation.state}`,
      });
    }
    if (obligation.stale) {
      exceptions.push({
        kind: "requirement_stale",
        ref: obligation.requirementId,
        detail: `${name} is ${obligation.state} but a dependency or assumption moved after the claim — revalidation required`,
      });
    }
    if (obligation.verification !== null && !obligation.verification.met) {
      exceptions.push({
        kind: "verification_below_declared",
        ref: obligation.requirementId,
        detail: `${name} is satisfied below its declared ${obligation.verification.expected} verification (claimed ${obligation.claim?.verifiedBy ?? "self"} by ${obligation.claim?.actor ?? "unknown"})`,
      });
    }
    // Defensive: report_requirement refuses evidence-less non-operator
    // terminal claims, so this fires only on rows that predate or bypassed
    // that rule. The operator's own word is the gate and is exempt. Violated
    // is already an unsatisfied exception — no second entry for it.
    if (
      (obligation.state === "satisfied" || obligation.state === "infeasible")
      && obligation.claim !== null
      && obligation.claim.evidence.length === 0
      && obligation.claim.verifiedBy !== "operator"
    ) {
      exceptions.push({
        kind: "evidence_missing",
        ref: obligation.requirementId,
        detail: `${name} is ${obligation.state} on a ${obligation.claim.verifiedBy} claim by ${obligation.claim.actor} that carries no evidence ref`,
      });
    }
  }

  // Required execution debt: an open task in an open session (or main's own
  // ledger) that still discharges a LIVE requirement — including one already
  // marked satisfied, where the inconsistency is exactly the finding. Deleted
  // tasks are the superseded/abandoned marker; unlinked open tasks stay
  // advisory bookkeeping in the summary's existing open-task list.
  const liveIds = deps.liveRequirementIds(userSessionId);
  for (const task of deps.listTasks(userSessionId)) {
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    if (task.requirementId === null || !liveIds.has(task.requirementId)) continue;
    if (task.agentSessionId !== null && !deps.isAgentSessionOpen(task.agentSessionId)) continue;
    exceptions.push({
      kind: "task_debt",
      ref: task.id,
      detail: `open task "${clip(task.subject)}" (${task.agentSessionId === null ? "main ledger" : `session ${task.agentSessionId}`}) still discharges live requirement ${task.requirementId}`,
    });
  }

  // Defaulted human choices: an open issue that proceeded provisionally on an
  // asker's recommendation is by definition an operator-owned decision made
  // without the operator — accepting the run must accept the default
  // explicitly. Open issues nobody can act on any more are advisory: they
  // block nothing operationally, but they should not vanish from the record.
  const advisories: string[] = [];
  for (const issue of deps.listOpenDecisionIssues(userSessionId)) {
    if (issue.provisional) {
      const requirements = issue.requirementIds.length === 0 ? "" : ` [${issue.requirementIds.join(", ")}]`;
      exceptions.push({
        kind: "decision_provisional",
        ref: issue.id,
        detail: `decision "${clip(issue.subject)}"${requirements} proceeded provisionally on an asker's recommendation — not a human answer`,
      });
    } else {
      advisories.push(`unresolved decision issue ${issue.id}: "${clip(issue.subject)}" (${issue.pendingAsksActive} active ask(s))`);
    }
  }

  // Reconciliation preconditions. The completion predicate holds the proposal
  // while either is non-zero, so a PROPOSAL-time report always records 0/0;
  // the counts exist for tail (mid-run) reads and for the audit trail.
  const reconciliation = {
    openChangeImpacts: deps.listOpenChangeImpacts(userSessionId).length,
    brokenWorkstreamLinks: deps.brokenWorkstreamLinks(userSessionId).length,
  };

  return {
    revision,
    policy: deps.policy,
    computedAt: nowIso(),
    obligations,
    counts,
    exceptions,
    advisories,
    reconciliation,
    readiness: exceptions.length === 0 ? "ready" : "ready_with_exceptions",
  };
}
