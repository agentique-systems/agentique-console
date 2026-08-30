/**
 * The root Orchestrator node under the scheduler (execution-model §3, §4.6).
 * The root is a `single` node held by the `orchestrator` role, but no
 * Pattern runner completes it: it stays `running` for the life of the Run
 * and its Invocations are logical turns. In Phase 2C the scheduler executes
 * the root's existing Invocations through the executor (consuming capacity
 * like any other), integrates an Orchestrator turn's Changeset once it
 * completes (the Orchestrator may work directly), continues a turn blocked
 * on an approval once the Decision resolves, and fails the Run when the
 * root Invocation fails after its permitted Attempts (§3 `failed`). The
 * Orchestrator input queue that creates new turns from queued inputs is a
 * later phase; nothing here creates a turn from routine progress.
 */
import { INVOCATION_MACHINE, ROOT_SOURCE_PATH, RUN_MACHINE, type DecisionId, type Invocation, type InvocationId, type PatternPlanNode, type RunId, type Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { blockingDecisionOf, outstandingChangesetOf, type PatternRunnerDependencies } from "./support.ts";

export type RootAdvice =
  /** No turn exists, or the latest turn is fully settled. */
  | { kind: "idle"; invocationId: InvocationId | null }
  | { kind: "execute"; invocationId: InvocationId }
  | { kind: "attempt_in_flight"; invocationId: InvocationId }
  | { kind: "retry_not_before"; invocationId: InvocationId; notBefore: Timestamp }
  /** The latest turn is terminal and its consequences are not yet applied. */
  | { kind: "settle"; invocationId: InvocationId }
  /** The latest turn is blocked on an open `side_effect_approval` Decision. */
  | { kind: "blocked"; invocationId: InvocationId; decisionId: DecisionId }
  | { kind: "run_terminal" };

export type RootOutcome =
  | { kind: "integrated"; changesetId: string }
  | { kind: "run_failed" }
  | { kind: "successor_prepared"; invocationId: InvocationId; decisionId: DecisionId }
  | { kind: "no_change" };

export class RootNodeSupport {
  constructor(private readonly deps: PatternRunnerDependencies) {}

  rootOf(runId: RunId): PatternPlanNode {
    const root = this.deps.stores.plans.rootNode(runId);
    if (root.kind !== "pattern" || root.sourcePath !== ROOT_SOURCE_PATH) throw new Error(`Run ${runId} has no root Orchestrator node`);
    return root;
  }

  /** The latest Orchestrator turn from the persisted `orchestrator` position. */
  latestTurn(runId: RunId): Invocation | null {
    return this.deps.stores.invocations.latestAtPosition(this.rootOf(runId).id, "orchestrator");
  }

  inspect(runId: RunId, now: Timestamp = this.deps.ctx.clock()): RootAdvice {
    const { stores, executor } = this.deps;
    const run = stores.runs.get(runId);
    if (RUN_MACHINE.isTerminal(run.status)) return { kind: "run_terminal" };
    const latest = this.latestTurn(runId);
    if (latest === null) return { kind: "idle", invocationId: null };
    if (!INVOCATION_MACHINE.isTerminal(latest.status)) {
      const inspection = executor.inspectInvocation(latest.id, now);
      if (inspection.next.permitted) return { kind: "execute", invocationId: latest.id };
      if (inspection.next.reason === "attempt_active") return { kind: "attempt_in_flight", invocationId: latest.id };
      if (inspection.next.reason === "retry_not_yet") return { kind: "retry_not_before", invocationId: latest.id, notBefore: inspection.next.notBefore! };
      return { kind: "execute", invocationId: latest.id };
    }
    if (latest.status === "blocked") {
      const decision = blockingDecisionOf(stores, latest)!;
      return decision.status === "open" ? { kind: "blocked", invocationId: latest.id, decisionId: decision.id } : { kind: "settle", invocationId: latest.id };
    }
    if (latest.status === "failed") return this.rootOf(runId).status === "failed" ? { kind: "idle", invocationId: latest.id } : { kind: "settle", invocationId: latest.id };
    if (latest.status === "succeeded" && outstandingChangesetOf(stores, latest) !== null) return { kind: "settle", invocationId: latest.id };
    return { kind: "idle", invocationId: latest.id };
  }

  /** Applies the consequences of the latest terminal turn; repeated calls apply nothing twice. */
  async settle(runId: RunId, options: WriteOptions = {}): Promise<RootOutcome> {
    const { ctx, stores, integration, preparation } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("the root settles outside any transaction; integration is external");
    const latest = this.latestTurn(runId);
    if (latest === null || !INVOCATION_MACHINE.isTerminal(latest.status)) return { kind: "no_change" };
    if (latest.status === "succeeded") {
      const changeset = outstandingChangesetOf(stores, latest);
      if (changeset === null) return { kind: "no_change" };
      const outcome = await integration.integrate(changeset.id, options);
      // The Orchestrator's own conflict is recorded as its conflict Task; the root never waits, and the later
      // Orchestrator input phase acts on it.
      return outcome.kind === "integrated" || outcome.kind === "already_integrated" ? { kind: "integrated", changesetId: changeset.id } : { kind: "no_change" };
    }
    return ctx.tx.write((): RootOutcome => {
      const root = this.rootOf(runId);
      const run = stores.runs.get(runId);
      const turn = stores.invocations.get(latest.id);
      if (RUN_MACHINE.isTerminal(run.status)) return { kind: "no_change" };
      if (turn.status === "failed") {
        if (root.status === "failed") return { kind: "no_change" };
        if (root.status === "waiting") stores.plans.transitionNode(root.id, { to: "running" }, options);
        stores.plans.transitionNode(root.id, { to: "failed", reason: "invocation_failed" }, options);
        stores.runs.transition(run.id, { to: "failed", failure: { kind: "root_node_failed", summary: `Orchestrator Invocation ${turn.id} failed: ${turn.failureReason ?? "unknown"}`, evidenceArtifactIds: [] } }, options);
        return { kind: "run_failed" };
      }
      if (turn.status === "blocked") {
        const decision = blockingDecisionOf(stores, turn)!;
        if (decision.status !== "resolved" || decision.resolution === null || decision.subject === null) return { kind: "no_change" };
        if (stores.invocations.latestAtPosition(root.id, "orchestrator")?.id !== turn.id) return { kind: "no_change" };
        const prepared = preparation.prepare({
          runId,
          planNodeId: root.id,
          role: "orchestrator",
          purpose: "decision_resolution",
          patternPosition: { kind: "orchestrator" },
          continuedFromInvocationId: turn.id,
          handoffIds: stores.invocations.getManifest(turn.id).content.handoffs.map((h) => h.handoffId),
          inputs: [{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: turn.id, attemptId: decision.subject.attemptId, tool: decision.subject.tool, callDigest: decision.subject.callDigest, callArtifactId: decision.subject.callArtifactId, outcome: decision.resolution.chosenOptionId as "approve_once" | "deny" }],
          correlationId: options.correlationId ?? null,
          causationSeq: options.causationSeq ?? null,
        });
        return { kind: "successor_prepared", invocationId: prepared.invocation.id, decisionId: decision.id };
      }
      return { kind: "no_change" };
    });
  }
}
