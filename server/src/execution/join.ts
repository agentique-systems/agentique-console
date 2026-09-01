/**
 * Deterministic `join` node settlement (execution-model §4.2, §4.3, §7.7).
 * A join creates no Invocation and no Attempt, requests no capacity lease,
 * consumes no provider tokens, holds zero allocation, and never enters
 * `running` or `waiting`: once the pure readiness evaluator has made it
 * `ready` — every current-revision `fan_in` predecessor terminal, not all
 * skipped — one transaction applies its fan-in policy, writes its canonical
 * index Artifact (`JOIN_INDEX_MEDIA_TYPE`), and moves it to `succeeded`
 * with that Artifact as its output (creating the current-revision edge
 * Handoffs from it) or to `failed` with `join_fan_in_failed` (the index
 * recorded on the failure for diagnosis).
 *
 * Policy over the non-skipped predecessors: `require_all` succeeds only
 * when every one succeeded; `require_any` when at least one did. A skipped
 * predecessor counts as neither success nor failure. The index lists every
 * current-revision `fan_in` predecessor by edge position, then edge id:
 * source node, terminal status, output Artifact ids, edge position — never
 * Artifact bytes or narrative. Because the index is created in the same
 * transaction as the terminal transition, a repeated pass or a restart
 * never creates a second index or a second Handoff.
 */
import { canonicalJoinIndex, indexArtifactTitle, InvariantViolationError, JOIN_INDEX_MEDIA_TYPE, PLAN_NODE_MACHINE, runAdmitsNewWork, type JoinIndex, type JoinIndexEntry, type JoinPlanNode, type OperatorPauseMode, type PlanNodeId, type RunStatus } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { HandoffRouter } from "./handoff-routing.ts";
import { currentReadinessInput } from "./readiness-facts.ts";
import { decideReadiness, predecessorEdges } from "./readiness.ts";

export type JoinOutcome =
  /** The Run admits no new work (ended, or paused by the operator); nothing was written (execution-model §14). */
  | { kind: "not_admitted"; status: RunStatus; operatorPause: OperatorPauseMode | null }
  | { kind: "succeeded"; outputArtifactIds: string[]; handoffIds: string[] }
  | { kind: "failed"; reason: "join_fan_in_failed"; indexArtifactId: string }
  | { kind: "skipped" }
  | { kind: "stale"; expectedRevisionNumber: number; currentRevisionNumber: number }
  | { kind: "no_change" };

export class JoinNodeSettler {
  private readonly router: HandoffRouter;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {
    this.router = new HandoffRouter(stores);
  }

  /** Settles a `ready` join in one transaction after revalidating the revision, membership, status, and readiness from rows. */
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options: WriteOptions = {}): JoinOutcome {
    return this.ctx.tx.write((): JoinOutcome => {
      const node = this.stores.plans.getNode(nodeId);
      if (node.kind !== "join") throw new InvariantViolationError(`PlanNode ${nodeId} is a ${node.kind} node, not a join`);
      const run = this.stores.runs.get(node.runId);
      if (!runAdmitsNewWork(run)) return { kind: "not_admitted", status: run.status, operatorPause: run.operatorPause };
      const current = this.stores.plans.latestRevisionNumber(node.runId);
      if (current !== expectedRevisionNumber) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
      if (PLAN_NODE_MACHINE.isTerminal(node.status)) return { kind: "no_change" };
      if (node.status !== "ready") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
      const input = currentReadinessInput(this.stores, node.runId);
      if (!input.graph.nodes.some((n) => n.id === nodeId)) return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
      const decision = decideReadiness(input, nodeId);
      if (decision.kind !== "ready") return { kind: "stale", expectedRevisionNumber, currentRevisionNumber: current };
      const byId = new Map(input.graph.nodes.map((n) => [n.id, n] as const));
      const sources: JoinIndexEntry[] = predecessorEdges(input.graph, nodeId).map((edge) => {
        if (edge.type !== "fan_in") throw new InvariantViolationError(`join PlanNode ${nodeId} receives a ${edge.type} edge`, { edgeId: edge.id });
        const source = byId.get(edge.sourceNodeId)!;
        if (!PLAN_NODE_MACHINE.isTerminal(source.status)) throw new InvariantViolationError(`join PlanNode ${nodeId} is ready while ${source.id} is ${source.status}`, { nodeId, sourceNodeId: source.id });
        const status = source.status as JoinIndexEntry["status"];
        return { position: edge.position, edgeId: edge.id, sourceNodeId: source.id, status, outputArtifactIds: status === "succeeded" ? [...(source.outputArtifactIds ?? [])].sort() : [] };
      });
      const counted = sources.filter((s) => s.status !== "skipped");
      if (counted.length === 0) {
        this.stores.plans.transitionNode(nodeId, { to: "skipped" }, options);
        return { kind: "skipped" };
      }
      const succeeded = counted.filter((s) => s.status === "succeeded").length;
      const met = node.fanInPolicy === "require_all" ? succeeded === counted.length : succeeded > 0;
      const index = this.createIndex(node, sources, options);
      if (!met) {
        this.stores.plans.transitionNode(nodeId, { to: "failed", reason: "join_fan_in_failed", artifactIds: [index.id] }, options);
        return { kind: "failed", reason: "join_fan_in_failed", indexArtifactId: index.id };
      }
      this.stores.plans.transitionNode(nodeId, { to: "succeeded", outputArtifactIds: [index.id] }, options);
      const handoffs = this.router.ensureEdgeHandoffsFrom(currentReadinessInput(this.stores, node.runId), nodeId, options);
      return { kind: "succeeded", outputArtifactIds: [index.id], handoffIds: handoffs.map((h) => h.handoff.id) };
    });
  }

  private createIndex(node: JoinPlanNode, sources: JoinIndexEntry[], options: WriteOptions) {
    const index: JoinIndex = { version: 1, planNodeId: node.id, sources };
    return this.stores.artifacts.create(
      { runId: node.runId, mediaType: JOIN_INDEX_MEDIA_TYPE, producer: { kind: "runtime", component: "join" }, taskId: null, title: indexArtifactTitle("join", node.id) },
      new TextEncoder().encode(canonicalJoinIndex(index)),
      options,
    );
  }
}
