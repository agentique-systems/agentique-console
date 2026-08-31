/**
 * Shared fixtures for the runtime data-access suites (execution-model §6.4
 * "Runtime read tools", `write_artifact`): read and write call builders,
 * outcome narrowers, a Gate Evaluator port prepared exactly as the executor
 * binds one, a second independent seeded Run for foreign-scope records, and
 * a large current Requirement revision for paging. Nothing here reads a
 * transcript or process memory of the runtime.
 */
import type {
  Artifact,
  ArtifactId,
  ReadArtifactInput,
  ReadRequirementsInput,
  RequirementId,
  RuntimeToolCallOutcome,
  RuntimeToolCallRequest,
  RuntimeToolReadResult,
  RuntimeToolRejection,
  WriteArtifactInput,
} from "@agentique-console/core";
import { portFor, type PlanningSeed } from "./coordinator-test-support.ts";
import { finishRoot, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { planNodes, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness, type RuntimeSeed } from "./test-support.ts";

// ---------------------------------------------------------------------------
// Call builders
// ---------------------------------------------------------------------------

export const readRequirements = (input: ReadRequirementsInput = {}): RuntimeToolCallRequest => ({ tool: "read_requirements", input });
export const readDecisions = (input: Extract<RuntimeToolCallRequest, { tool: "read_decisions" }>["input"] = {}): RuntimeToolCallRequest => ({ tool: "read_decisions", input });
export const readTasks = (input: Extract<RuntimeToolCallRequest, { tool: "read_tasks" }>["input"] = {}): RuntimeToolCallRequest => ({ tool: "read_tasks", input });
export const readPlan = (input: Extract<RuntimeToolCallRequest, { tool: "read_execution_plan" }>["input"] = { view: "nodes" }): RuntimeToolCallRequest => ({ tool: "read_execution_plan", input });
export const readAgents = (input: Extract<RuntimeToolCallRequest, { tool: "read_agent_definitions" }>["input"] = {}): RuntimeToolCallRequest => ({ tool: "read_agent_definitions", input });
export const readArtifact = (input: ReadArtifactInput): RuntimeToolCallRequest => ({ tool: "read_artifact", input });
export const writeArtifact = (input: Partial<WriteArtifactInput> = {}): RuntimeToolCallRequest => ({
  tool: "write_artifact",
  input: { title: "a report", mediaType: "text/plain", encoding: "utf8", content: "hello", ...input },
});

// ---------------------------------------------------------------------------
// Outcome narrowers
// ---------------------------------------------------------------------------

/** Narrows a successful read to its result of the given tool; throws with the outcome otherwise. */
export function readResult<T extends RuntimeToolReadResult["tool"]>(outcome: RuntimeToolCallOutcome, tool: T): Extract<RuntimeToolReadResult, { tool: T }> {
  if (outcome.kind !== "read" || outcome.result.tool !== tool) throw new Error(`expected a ${tool} read, got ${JSON.stringify(outcome).slice(0, 400)}`);
  return outcome.result as Extract<RuntimeToolReadResult, { tool: T }>;
}

/** Narrows an accepted `write_artifact` to its result; throws with the outcome otherwise. */
export function writtenArtifact(outcome: RuntimeToolCallOutcome): { artifactId: ArtifactId; mediaType: string; digest: string; byteSize: number; title: string; replayed: boolean } {
  if (outcome.kind !== "accepted" || outcome.result.tool !== "write_artifact") throw new Error(`expected an accepted write_artifact, got ${JSON.stringify(outcome).slice(0, 400)}`);
  return { ...outcome.result, replayed: outcome.replayed };
}

/** The closed rejection codes of a rejected outcome; throws with the outcome otherwise. */
export function rejectionCodes(outcome: RuntimeToolCallOutcome): RuntimeToolRejection["code"][] {
  if (outcome.kind !== "rejected") throw new Error(`expected a rejection, got ${JSON.stringify(outcome).slice(0, 400)}`);
  return outcome.reasons.map((r) => r.code);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Performs one canonical action at a time until `done` holds, returning the action kinds performed. */
export async function stepUntil(h: RuntimeHarness, runId: string, done: () => boolean): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 200 && !done(); i += 1) {
    const pass = await h.scheduler.advanceRun(runId as never, { maxActions: 1 });
    if (pass.failure) throw new Error(pass.failure.message);
    kinds.push(...pass.actions.map((p) => p.action.kind));
    if (pass.actions.length === 0 && pass.stop !== "waiting") break;
  }
  if (!done()) throw new Error(`the Run did not reach the expected state after ${kinds.length} actions`);
  return kinds;
}

/**
 * A running `node_exit` Gate Evaluator Attempt with the runtime-tool port
 * bound to it exactly as the executor binds one: a gated single node whose
 * Worker completed and integrated, the Gate open with its deterministic
 * phase passed, and the one Gate Evaluator Invocation prepared.
 */
export async function evaluatorPort(h: RuntimeHarness, options: { evaluated?: number } = {}) {
  const s = seedPlanningRuntime(h);
  const criteria = seedCriteria(h, s, { evaluated: options.evaluated ?? 1 });
  const { nodes, revisionNumber } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
  const node = nodes[0]!;
  await finishRoot(h, s);
  scriptByRole(h, { worker: [workerStep(h, "a")] });
  const runId = s.created.run.id;
  await stepUntil(h, runId, () => h.scheduler.reconcileRun(runId).actions[0]?.kind === "open_node_gate");
  const runner = h.runners.single;
  const opened = runner.openGate(node.id, revisionNumber);
  if (opened.kind !== "gate_opened") throw new Error(`gate not opened: ${opened.kind}`);
  // A Gate with no deterministic criteria has nothing to verify before its Evaluator; either outcome leaves it open.
  const verified = await runner.verifyGate(node.id, revisionNumber);
  if (verified.kind !== "gate_verified" && verified.kind !== "no_change") throw new Error(`gate not verified: ${verified.kind}`);
  const evaluator = runner.prepareGateEvaluator(node.id, revisionNumber);
  if (evaluator.kind !== "gate_evaluator_prepared") throw new Error(`Evaluator not prepared: ${evaluator.kind}`);
  const prepared = await h.executor.prepareNextAttempt(evaluator.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`Evaluator Attempt not prepared: ${prepared.kind}`);
  return {
    s,
    criteria,
    node,
    revisionNumber,
    runId,
    gateId: opened.gateId,
    candidate: opened.candidateArtifactIds,
    invocation: prepared.invocation,
    attempt: prepared.attempt,
    port: portFor(h, prepared.invocation, prepared.attempt),
  };
}

/** A second, fully independent seeded and started Run in the same database: its records are foreign to the first Run's callers. */
export function seedForeignRun(h: RuntimeHarness): RuntimeSeed & { artifact: Artifact } {
  const foreign = seedRuntime(h);
  startRun(h, foreign);
  const artifact = h.stores.artifacts.create(
    { runId: foreign.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "foreign output" },
    new TextEncoder().encode("foreign content"),
  );
  return { ...foreign, artifact };
}

/**
 * Approves a new current Requirement revision of the seed's Conversation:
 * one root composing `leaves` leaf statements (each `statementBytes` long),
 * in tree order. Returns the revision and its ids.
 */
export function approveRevision(h: RuntimeHarness, s: PlanningSeed | RuntimeSeed, leaves: number, statementBytes = 24) {
  const conversationId = s.created.run.conversationId;
  const rootId = h.ctx.ids("requirement");
  const leafIds: RequirementId[] = Array.from({ length: leaves }, () => h.ctx.ids("requirement"));
  const statement = (index: number) => `Leaf ${index + 1} `.padEnd(statementBytes, "x");
  const revision = h.stores.requirements.createRevision({
    conversationId,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "Everything holds", position: 0, acceptanceCriterionIds: [] },
      ...leafIds.map((id, index) => ({ id, parentId: rootId, composition: null, statement: statement(index), position: index + 1, acceptanceCriterionIds: [] })),
    ],
  });
  return { revision, rootId, leafIds };
}

/** One Artifact of the seed's Run with the given bytes, produced by the runtime (readable only where canonically routed). */
export function runArtifact(h: RuntimeHarness, s: PlanningSeed | RuntimeSeed, bytes: Uint8Array, title = "content", mediaType = "application/octet-stream"): Artifact {
  return h.stores.artifacts.create({ runId: s.created.run.id, mediaType, producer: { kind: "runtime", component: "command" }, taskId: null, title }, bytes);
}
