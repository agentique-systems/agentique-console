import { z } from "zod";
import type { ArtifactId, HandoffId, InvocationId, PlanNodeId, RunId, TaskId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/** A Handoff endpoint: a Plan Node or an Invocation. */
export type HandoffEndpoint =
  | { kind: "plan_node"; planNodeId: PlanNodeId }
  | { kind: "invocation"; invocationId: InvocationId };

export const handoffEndpointSchema: z.ZodType<HandoffEndpoint> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan_node"), planNodeId: idSchema("planNode") }),
  z.strictObject({ kind: z.literal("invocation"), invocationId: idSchema("invocation") }),
]);

export const HANDOFF_STATUSES = ["pending", "delivered", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_MAX_SUMMARY_LENGTH = 500;

/**
 * The logical transfers the runtime carries as Handoffs. The key derived
 * from a route identifies the transfer itself — never a process attempt or
 * a reconciliation pass — so repeated scheduling, transaction retry, a
 * restart, or two racing callers resolve to one row, which the database
 * enforces with a unique index per Run.
 */
export type HandoffRoute =
  /** A current-revision `sequence` edge: the terminal source node's outputs (or its failure, under `runOnDependencyFailure`) to the target node. */
  | { kind: "sequence"; sourceNodeId: PlanNodeId; targetNodeId: PlanNodeId }
  /** A chain node's internal transfer from step `fromStep` to step `fromStep + 1`. */
  | { kind: "chain_step"; planNodeId: PlanNodeId; fromStep: number }
  /**
   * The activation of a `branch(label)` edge: the route node selected `label` and the composite
   * branch's entry node may start. It carries no Artifacts (a composite selection fabricates no
   * output); a target belongs to exactly one branch of one route, so the pair identifies the
   * transfer and the label is validated routing metadata.
   */
  | { kind: "branch"; sourceNodeId: PlanNodeId; targetNodeId: PlanNodeId; label: string }
  /** A parallel node's internal delivery of its canonical index Artifact to its own aggregation Invocation. */
  | { kind: "parallel_index"; planNodeId: PlanNodeId }
  /**
   * A coordinator_worker node's internal transfer of one completed current Task's Worker result — its output
   * Artifacts and a bounded summary — from the Worker Invocation to the node, for the next Coordinator turn.
   * One exists per completed current Task, created only once the Worker's Changeset is integrated.
   */
  | { kind: "worker_result"; planNodeId: PlanNodeId; taskId: TaskId }
  /**
   * The activation of a `retry(round)` edge: the evaluate-only `evaluator_optimizer` node of round `round - 1` recorded a
   * `fail` or `inconclusive` verdict, and the next unrolled producer round's entry node may start. It carries the judged
   * candidate Artifact ids of the failed round; the round is validated routing metadata against the revision's edge.
   */
  | { kind: "retry"; sourceNodeId: PlanNodeId; targetNodeId: PlanNodeId; round: number }
  /** An inline `evaluator_optimizer` node's internal transfer of round `round`'s candidate output from its producer Invocation to the node, for that round's Evaluator. */
  | { kind: "optimizer_candidate"; planNodeId: PlanNodeId; round: number }
  /**
   * An inline `evaluator_optimizer` node's internal transfer of round `round`'s judged candidate Artifacts to the node, for
   * producer round `round + 1`, created once the round's overall verdict is `fail` or `inconclusive`. The verdict itself
   * travels as the typed `optimizer_feedback` manifest input, never as Handoff text.
   */
  | { kind: "optimizer_feedback"; planNodeId: PlanNodeId; round: number };

export const handoffRouteSchema: z.ZodType<HandoffRoute> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sequence"), sourceNodeId: idSchema("planNode"), targetNodeId: idSchema("planNode") }).refine((r) => r.sourceNodeId !== r.targetNodeId, { message: "a sequence Handoff joins two nodes", path: ["targetNodeId"] }),
  z.strictObject({ kind: z.literal("chain_step"), planNodeId: idSchema("planNode"), fromStep: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("branch"), sourceNodeId: idSchema("planNode"), targetNodeId: idSchema("planNode"), label: nonEmptyString }).refine((r) => r.sourceNodeId !== r.targetNodeId, { message: "a branch Handoff joins two nodes", path: ["targetNodeId"] }),
  z.strictObject({ kind: z.literal("parallel_index"), planNodeId: idSchema("planNode") }),
  z.strictObject({ kind: z.literal("worker_result"), planNodeId: idSchema("planNode"), taskId: idSchema("task") }),
  z.strictObject({ kind: z.literal("retry"), sourceNodeId: idSchema("planNode"), targetNodeId: idSchema("planNode"), round: z.number().int().min(2) }).refine((r) => r.sourceNodeId !== r.targetNodeId, { message: "a retry Handoff joins two nodes", path: ["targetNodeId"] }),
  z.strictObject({ kind: z.literal("optimizer_candidate"), planNodeId: idSchema("planNode"), round: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal("optimizer_feedback"), planNodeId: idSchema("planNode"), round: z.number().int().min(1) }),
]);

export const HANDOFF_KEY_PATTERN =
  /^(sequence:pn_[0-9a-f]{24}:pn_[0-9a-f]{24}|chain_step:pn_[0-9a-f]{24}:[0-9]+|branch:pn_[0-9a-f]{24}:pn_[0-9a-f]{24}|parallel_index:pn_[0-9a-f]{24}|worker_result:pn_[0-9a-f]{24}:task_[0-9a-f]{24}|retry:pn_[0-9a-f]{24}:pn_[0-9a-f]{24}|optimizer_candidate:pn_[0-9a-f]{24}:[0-9]+|optimizer_feedback:pn_[0-9a-f]{24}:[0-9]+)$/;

/** The stable canonical key of a route; two routes are the same transfer iff their keys are equal. */
export function handoffKeyOf(route: HandoffRoute): string {
  switch (route.kind) {
    case "sequence":
      return `sequence:${route.sourceNodeId}:${route.targetNodeId}`;
    case "chain_step":
      return `chain_step:${route.planNodeId}:${route.fromStep}`;
    case "branch":
      return `branch:${route.sourceNodeId}:${route.targetNodeId}`;
    case "parallel_index":
      return `parallel_index:${route.planNodeId}`;
    case "worker_result":
      return `worker_result:${route.planNodeId}:${route.taskId}`;
    case "retry":
      return `retry:${route.sourceNodeId}:${route.targetNodeId}`;
    case "optimizer_candidate":
      return `optimizer_candidate:${route.planNodeId}:${route.round}`;
    case "optimizer_feedback":
      return `optimizer_feedback:${route.planNodeId}:${route.round}`;
  }
}

/** The kinds of Handoff a node's next Invocation is delivered when it starts: transfers along the current graph's edges into the node. */
export const INCOMING_HANDOFF_KEY_PREFIXES = ["sequence:", "branch:", "retry:"] as const;

export function isIncomingHandoffKey(handoffKey: string): boolean {
  return INCOMING_HANDOFF_KEY_PREFIXES.some((prefix) => handoffKey.startsWith(prefix));
}

export const handoffKeySchema = z.string().regex(HANDOFF_KEY_PATTERN, "expected a canonical Handoff key");

/**
 * Routing metadata only: source, target, Task ids, Artifact ids, a bounded
 * summary, and a status. No free-form state and no instructions.
 */
export interface Handoff {
  id: HandoffId;
  runId: RunId;
  /** The stable logical key of the transfer (`handoffKeyOf`); unique per Run. */
  handoffKey: string;
  source: HandoffEndpoint;
  target: HandoffEndpoint;
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  summary: string;
  status: HandoffStatus;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
}

export const HANDOFF_MACHINE = defineStateMachine<HandoffStatus>("Handoff", HANDOFF_STATUSES, {
  pending: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
});

export const handoffSchema: z.ZodType<Handoff> = z
  .strictObject({
    id: idSchema("handoff"),
    runId: idSchema("run"),
    handoffKey: handoffKeySchema,
    source: handoffEndpointSchema,
    target: handoffEndpointSchema,
    taskIds: uniqueIds(idSchema("task")),
    artifactIds: uniqueIds(idSchema("artifact")),
    summary: z.string().max(HANDOFF_MAX_SUMMARY_LENGTH),
    status: z.enum(HANDOFF_STATUSES),
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.nullable(),
  })
  .refine((h) => (h.status === "delivered") === (h.deliveredAt !== null), {
    message: "deliveredAt is set exactly when the Handoff is delivered",
    path: ["deliveredAt"],
  });

export interface HandoffInput {
  runId: RunId;
  /** The transfer this Handoff carries; its key is the Handoff's identity. */
  route: HandoffRoute;
  source: HandoffEndpoint;
  target: HandoffEndpoint;
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  summary: string;
}

export const handoffInputSchema: z.ZodType<HandoffInput> = z.strictObject({
  runId: idSchema("run"),
  route: handoffRouteSchema,
  source: handoffEndpointSchema,
  target: handoffEndpointSchema,
  taskIds: uniqueIds(idSchema("task")),
  artifactIds: uniqueIds(idSchema("artifact")),
  summary: z.string().max(HANDOFF_MAX_SUMMARY_LENGTH),
});
