import { z } from "zod";
import type { AgentDefinitionRevisionId, TaskId } from "./ids.ts";
import type { InvocationPurpose, InvocationRole } from "./invocations.ts";
import { ROOT_SOURCE_PATH, type CompiledOperation, type PatternShape } from "./plans.ts";
import { idSchema, nonEmptyString, positiveCount } from "./validation.ts";

/**
 * The canonical position an Invocation occupies inside its Plan Node's
 * Pattern (execution-model §5, §6.2). The Pattern runtime owns it: a
 * scheduler never infers a chain step from Invocation creation order, a
 * rendered string, a source path, or a transcript. The union is closed and
 * covers every position the six Patterns define, so later runners bind to
 * an existing variant instead of replacing this contract; Phase 2C executes
 * exactly `orchestrator`, `single`, and `chain_step`.
 */
export const PATTERN_POSITION_KINDS = [
  "orchestrator",
  "single",
  "chain_step",
  "route_selection",
  "route_branch",
  "parallel_item",
  "parallel_aggregation",
  "coordinator_turn",
  "worker_task",
  "producer_round",
  "evaluator_round",
] as const;
export type PatternPositionKind = (typeof PATTERN_POSITION_KINDS)[number];

export type PatternPosition =
  /** The root node's Orchestrator turn; never an ordinary worker `single`. */
  | { kind: "orchestrator" }
  | { kind: "single" }
  | { kind: "chain_step"; index: number; count: number }
  | { kind: "route_selection" }
  | { kind: "route_branch"; label: string }
  | { kind: "parallel_item"; index: number; count: number }
  | { kind: "parallel_aggregation" }
  | { kind: "coordinator_turn" }
  | { kind: "worker_task"; taskId: TaskId }
  | { kind: "producer_round"; round: number; maxRounds: number }
  | { kind: "evaluator_round"; round: number; maxRounds: number };

const indexed = z
  .strictObject({ index: z.number().int().min(0), count: positiveCount })
  .refine((p) => p.index < p.count, { message: "index is within bounds", path: ["index"] });
const rounded = z
  .strictObject({ round: positiveCount, maxRounds: positiveCount })
  .refine((p) => p.round <= p.maxRounds, { message: "round is within maxRounds", path: ["round"] });

export const patternPositionSchema: z.ZodType<PatternPosition> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("orchestrator") }),
  z.strictObject({ kind: z.literal("single") }),
  z.strictObject({ kind: z.literal("chain_step"), index: z.number().int().min(0), count: positiveCount }).refine((p) => indexed.safeParse({ index: p.index, count: p.count }).success, { message: "chain step index is within bounds", path: ["index"] }),
  z.strictObject({ kind: z.literal("route_selection") }),
  z.strictObject({ kind: z.literal("route_branch"), label: nonEmptyString }),
  z.strictObject({ kind: z.literal("parallel_item"), index: z.number().int().min(0), count: positiveCount }).refine((p) => indexed.safeParse({ index: p.index, count: p.count }).success, { message: "parallel item index is within bounds", path: ["index"] }),
  z.strictObject({ kind: z.literal("parallel_aggregation") }),
  z.strictObject({ kind: z.literal("coordinator_turn") }),
  z.strictObject({ kind: z.literal("worker_task"), taskId: idSchema("task") }),
  z.strictObject({ kind: z.literal("producer_round"), round: positiveCount, maxRounds: positiveCount }).refine((p) => rounded.safeParse({ round: p.round, maxRounds: p.maxRounds }).success, { message: "producer round is within maxRounds", path: ["round"] }),
  z.strictObject({ kind: z.literal("evaluator_round"), round: positiveCount, maxRounds: positiveCount }).refine((p) => rounded.safeParse({ round: p.round, maxRounds: p.maxRounds }).success, { message: "evaluator round is within maxRounds", path: ["round"] }),
]);

/**
 * The stable technical key of a position within its node: the kind plus
 * its one discriminating field. Two Invocations of one node with the same
 * key occupy the same logical position, of which at most one may be active.
 */
export function patternPositionKey(position: PatternPosition): string {
  switch (position.kind) {
    case "orchestrator":
    case "single":
    case "route_selection":
    case "parallel_aggregation":
    case "coordinator_turn":
      return position.kind;
    case "chain_step":
    case "parallel_item":
      return `${position.kind}:${position.index}`;
    case "route_branch":
      return `${position.kind}:${position.label}`;
    case "worker_task":
      return `${position.kind}:${position.taskId}`;
    case "producer_round":
    case "evaluator_round":
      return `${position.kind}:${position.round}`;
  }
}

/** The concise human-readable projection of a position (`chain step 2 of 3`); never the record. */
export function renderPatternPosition(position: PatternPosition): string {
  switch (position.kind) {
    case "orchestrator":
      return "orchestrator";
    case "single":
      return "single";
    case "chain_step":
      return `chain step ${position.index + 1} of ${position.count}`;
    case "route_selection":
      return "route selection";
    case "route_branch":
      return `route branch ${position.label}`;
    case "parallel_item":
      return `parallel item ${position.index + 1} of ${position.count}`;
    case "parallel_aggregation":
      return "parallel aggregation";
    case "coordinator_turn":
      return "coordinator turn";
    case "worker_task":
      return `worker task ${position.taskId}`;
    case "producer_round":
      return `producer round ${position.round} of ${position.maxRounds}`;
    case "evaluator_round":
      return `evaluator round ${position.round} of ${position.maxRounds}`;
  }
}

/** The role every position holds and, where the Pattern fixes it, the purpose. */
export const PATTERN_POSITION_BINDINGS: Readonly<Record<PatternPositionKind, { role: InvocationRole; purpose: InvocationPurpose | null }>> = {
  orchestrator: { role: "orchestrator", purpose: null },
  single: { role: "worker", purpose: "step" },
  chain_step: { role: "worker", purpose: "step" },
  route_selection: { role: "evaluator", purpose: "select" },
  route_branch: { role: "worker", purpose: "step" },
  parallel_item: { role: "worker", purpose: "step" },
  parallel_aggregation: { role: "worker", purpose: "step" },
  coordinator_turn: { role: "coordinator", purpose: null },
  worker_task: { role: "worker", purpose: "task" },
  producer_round: { role: "worker", purpose: "step" },
  evaluator_round: { role: "evaluator", purpose: "evaluate" },
};

/**
 * The compiled operation a position names inside a shape, or `null` when
 * the shape holds no such position. This is the only way an Invocation's
 * operation (Agent Definition revision, exact input, role) is derived:
 * from the immutable node shape and the typed position, never from a
 * caller-supplied template.
 */
export function operationAt(shape: PatternShape, position: PatternPosition): CompiledOperation | null {
  switch (position.kind) {
    case "orchestrator":
      return shape.pattern === "single" && shape.role === "orchestrator" ? shape.operation : null;
    case "single":
      return shape.pattern === "single" && shape.role === "worker" ? shape.operation : null;
    case "chain_step":
      return shape.pattern === "chain" && position.count === shape.steps.length ? (shape.steps[position.index] ?? null) : null;
    case "route_selection":
      if (shape.pattern !== "route" || shape.selector.kind !== "evaluator") return null;
      return { agentDefinitionRevisionId: shape.selector.agentDefinitionRevisionId, title: "selector", input: { taskIds: [], decisionIds: [], artifactIds: [] }, role: "evaluator", readOnly: true };
    case "route_branch":
      return shape.pattern === "route" ? (shape.branches.find((b) => b.label === position.label)?.inline ?? null) : null;
    case "parallel_item":
      return shape.pattern === "parallel" && position.count === shape.items.length ? (shape.items[position.index] ?? null) : null;
    case "parallel_aggregation":
      return shape.pattern === "parallel" ? shape.aggregate : null;
    case "coordinator_turn":
      return shape.pattern === "coordinator_worker" ? shape.coordinator : null;
    case "worker_task":
      return shape.pattern === "coordinator_worker" ? shape.worker : null;
    case "producer_round":
      return shape.pattern === "evaluator_optimizer" && shape.round === null && position.maxRounds === shape.maxRounds ? shape.producer : null;
    case "evaluator_round":
      return shape.pattern === "evaluator_optimizer" && position.maxRounds === shape.maxRounds && (shape.round === null || shape.round === position.round) ? shape.evaluator : null;
  }
}

/** The positions a shape executes in Pattern order, for the Patterns whose sequence is fixed by the shape alone. */
export function positionsOf(shape: PatternShape): PatternPosition[] | null {
  switch (shape.pattern) {
    case "single":
      return [shape.role === "orchestrator" ? { kind: "orchestrator" } : { kind: "single" }];
    case "chain":
      return shape.steps.map((_, index) => ({ kind: "chain_step", index, count: shape.steps.length }));
    default:
      return null;
  }
}

export interface PositionedInvocationFacts {
  role: InvocationRole;
  purpose: InvocationPurpose;
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
}

/**
 * Why a position is not valid for a node and an Invocation; empty when it
 * is: the position exists in the node's shape and is within bounds, the
 * Orchestrator position is held only by the root node, and the
 * Invocation's role, purpose, and Agent Definition revision agree with the
 * operation at that position.
 */
export function patternPositionDefects(node: { sourcePath: string; shape: PatternShape }, position: PatternPosition, invocation: PositionedInvocationFacts): string[] {
  const defects: string[] = [];
  const parsed = patternPositionSchema.safeParse(position);
  if (!parsed.success) return [`position is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`];
  const isRoot = node.sourcePath === ROOT_SOURCE_PATH;
  if ((position.kind === "orchestrator") !== isRoot) {
    defects.push(isRoot ? "the root node holds only the orchestrator position" : "only the root node holds the orchestrator position");
  }
  const operation = operationAt(node.shape, position);
  if (operation === null) {
    defects.push(`the ${node.shape.pattern} shape has no ${renderPatternPosition(position)} position`);
    return defects;
  }
  const binding = PATTERN_POSITION_BINDINGS[position.kind];
  if (invocation.role !== binding.role || operation.role !== binding.role) defects.push(`the ${position.kind} position holds the ${binding.role} role, not ${invocation.role}`);
  if (binding.purpose !== null && invocation.purpose !== binding.purpose) defects.push(`the ${position.kind} position has purpose ${binding.purpose}, not ${invocation.purpose}`);
  if (invocation.agentDefinitionRevisionId !== operation.agentDefinitionRevisionId) {
    defects.push(`the ${position.kind} position runs Agent Definition revision ${operation.agentDefinitionRevisionId}, not ${invocation.agentDefinitionRevisionId}`);
  }
  return defects;
}
