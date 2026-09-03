/**
 * Shared fixtures for the runtime data-access suites (execution-model §6.4
 * "Runtime read tools", `write_artifact`): read and write call builders,
 * outcome narrowers, a Gate Evaluator port prepared exactly as the executor
 * binds one, a second independent seeded Run for foreign-scope records, and
 * a large current Requirement revision for paging. Nothing here reads a
 * transcript or process memory of the runtime.
 */
import {
  approvalSubjectOf,
  EMPTY_MANIFEST_TEMPLATE,
  type Artifact,
  type ArtifactId,
  type Decision,
  type DecisionRequest,
  type Invocation,
  type InvocationId,
  type PlanExpression,
  type PlanNode,
  type ProposedToolCall,
  type ReadArtifactInput,
  type ReadRequirementsInput,
  type RequirementId,
  type RuntimeToolCallOutcome,
  type RuntimeToolCallRequest,
  type RuntimeToolReadResult,
  type RuntimeToolRejection,
  type WriteArtifactInput,
} from "@agentique-console/core";
import { portFor, type PlanningSeed } from "./coordinator-test-support.ts";
import { finishRoot, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { DEFAULT_BUDGET } from "../persistence/test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, planNodes, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness, type RuntimeSeed } from "./test-support.ts";

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

/** An open `operator_choice` Decision recorded by the operator, of the Conversation (and, when given, the Run), affecting the given ids. */
export function operatorDecision(h: RuntimeHarness, conversationId: string, runId: string | null, affects: Partial<DecisionRequest["affects"]> = {}, question = "Which way?"): Decision {
  return h.stores.decisions.request({
    conversationId: conversationId as never,
    runId: runId as never,
    kind: "operator_choice",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question,
    options: [
      { id: "a", label: "A", description: null },
      { id: "b", label: "B", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [], ...affects },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
  });
}

/** A Run-scoped Task recorded by the runtime for the Orchestrator's ledger (no Plan Node). */
export function orchestratorTask(h: RuntimeHarness, runId: string, subject: string, requirementIds: string[] = []) {
  return h.stores.tasks.create({ runId: runId as never, planNodeId: null, origin: "orchestrator", subject, requirementIds: requirementIds as never, requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
}

/** Moves the shared clock past an Invocation's latest durable retry backoff, as a later scheduler pass would wait it out. */
export function passRetryBackoff(h: RuntimeHarness, invocationId: InvocationId): void {
  const notBefore = h.stores.invocations.listAttempts(invocationId).at(-1)?.retryDecision?.notBefore;
  if (notBefore) h.clock.set(notBefore);
}

/**
 * A second Run in the seed's Conversation. The seed's Run must be terminal
 * first (a Conversation has at most one active Run); this one shares every
 * Requirement identity of the Conversation with it. Returns a planning seed
 * over the new Run whose first Orchestrator turn is prepared.
 */
export function laterRunInConversation(h: RuntimeHarness, s: PlanningSeed): PlanningSeed {
  const conversationId = s.created.run.conversationId;
  const created = h.runCreation.create({
    conversationId,
    kind: "code",
    target: { kind: "branch", branch: "main" },
    budget: DEFAULT_BUDGET,
    orchestratorAgentDefinitionRevisionId: s.orchestrator.id,
    verificationPolicy: { evaluatorAgentDefinitionRevisionId: s.evaluator.id, runCompletionAcceptanceCriterionIds: [s.completion.criterionId] },
  });
  const message = h.stores.conversations.postMessage({ conversationId, author: "operator", content: "Continue the work.", runId: created.run.id, invocationId: null });
  const started = h.runStart.start({ runId: created.run.id, conversationMessageId: message.id });
  return { ...s, created, message, invocation: started.prepared.invocation };
}

/** The seed's Run cancelled through the store, so another Run of the Conversation may be created. */
export function cancelRun(h: RuntimeHarness, s: PlanningSeed): void {
  for (const invocation of h.stores.invocations.listByRun(s.created.run.id)) {
    if (invocation.status === "pending" || invocation.status === "running") h.stores.invocations.transition(invocation.id, { to: "cancelled" });
  }
  h.stores.runs.transition(s.created.run.id, { to: "cancelled" });
}

/**
 * A running Worker `step` on a fresh single node of the seed's plan whose
 * operation input lists `artifactIds` explicitly (the Orchestrator listing
 * Artifacts on a node: one of the canonical manifest routes), with the port
 * bound to its running Attempt.
 */
export async function listedArtifactWorker(h: RuntimeHarness, s: PlanningSeed, artifactIds: ArtifactId[], options: { title?: string; allocation?: { costUsd: number; tokens: number; attempts: number }; agent?: string } = {}) {
  const title = options.title ?? "reader";
  const expression: PlanExpression = {
    pattern: "single",
    operation: { agentDefinitionRevisionId: (options.agent ?? s.worker.id) as never, title, input: { ...EMPTY_MANIFEST_TEMPLATE, artifactIds } },
    allocation: options.allocation ?? INVOCATION_ALLOCATION,
  };
  const runId = s.created.run.id;
  const existing = h.stores.plans.getRevision(runId, h.stores.plans.latestRevisionNumber(runId)).source.expressions;
  const { nodes, revisionNumber } = planNodes(h, s, [...existing, expression]);
  const node = nodes.find((n) => n.kind === "pattern" && n.title === title && n.status === "pending") as (PlanNode & { kind: "pattern" }) | undefined;
  if (node === undefined) throw new Error(`no fresh single node titled ${title}`);
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  const started = h.runners.single.start(node.id, revisionNumber);
  if (started.kind !== "started") throw new Error(`worker did not start: ${started.kind}`);
  const prepared = await h.executor.prepareNextAttempt(started.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`worker Attempt not prepared: ${prepared.kind}`);
  return { node, revisionNumber, invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

/** The provider-native call every approval fixture intercepts (the seeded definitions require approval for `shell`). */
export const APPROVAL_CALL: ProposedToolCall = { tool: "shell", input: { command: "rm -rf build", cwd: "/w" } };

/**
 * Ends a prepared Attempt on an intercepted `approval_required` call after
 * the given runtime-tool calls: the Invocation ends `blocked` on the open
 * `side_effect_approval` Decision. Returns the outcome and every recorded
 * runtime-tool call of the execution.
 */
export async function blockOnApproval(h: RuntimeHarness, attemptId: string, calls: RuntimeToolCallRequest[] = [], call: ProposedToolCall = APPROVAL_CALL) {
  const before = h.provider.runtimeToolCalls.length;
  h.provider.script(calls.length === 0 ? { kind: "tool_calls", calls: [call], then: { kind: "succeed", result: COMPLETED_RESULT } } : { kind: "runtime_tool_calls", calls, then: { kind: "tool_calls", calls: [call], then: { kind: "succeed", result: COMPLETED_RESULT } } });
  const outcome = await h.executor.executePreparedAttempt(attemptId as never);
  if (outcome.kind !== "approval_required") throw new Error(`expected approval_required, got ${outcome.kind}`);
  return { outcome, decision: outcome.decision, recorded: h.provider.runtimeToolCalls.slice(before) };
}

/**
 * The one successor of an Invocation blocked on a `side_effect_approval`
 * Decision the operator resolved, prepared exactly as the Pattern runner's
 * `prepareSuccessor` prepares it: the same node, role, purpose, position,
 * and Task ownership, `continuedFromInvocationId` naming the blocked
 * Invocation, its predecessor's Handoffs, and one typed
 * `side_effect_approval_resolution` input. Its first Attempt is prepared and
 * a port bound to it.
 */
export async function approvalSuccessor(h: RuntimeHarness, blocked: Invocation, decisionId: string, outcome: "approve_once" | "deny") {
  const current = h.stores.decisions.get(decisionId as never);
  if (current.status === "open") h.stores.decisions.resolve(current.id, { resolvedBy: "operator", chosenOptionId: outcome, rationale: null, artifactIds: [] });
  const decision = h.stores.decisions.get(current.id);
  const subject = approvalSubjectOf(decision);
  const handoffIds = h.stores.invocations.getManifest(blocked.id).content.handoffs.map((x) => x.handoffId);
  const prepared = h.preparation.prepare({
    runId: blocked.runId,
    planNodeId: blocked.planNodeId,
    role: blocked.role,
    purpose: blocked.role === "orchestrator" ? "decision_resolution" : blocked.purpose,
    continuedFromInvocationId: blocked.id,
    patternPosition: blocked.patternPosition,
    taskIds: [...blocked.taskIds],
    handoffIds,
    inputs: [{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: blocked.id, attemptId: subject.attemptId, tool: subject.tool, callDigest: subject.callDigest, callArtifactId: subject.callArtifactId, outcome }],
  });
  const attempt = await h.executor.prepareNextAttempt(prepared.invocation.id);
  if (attempt.kind !== "prepared") throw new Error(`successor Attempt not prepared: ${attempt.kind}`);
  return { invocation: attempt.invocation, attempt: attempt.attempt, decision, subject, port: portFor(h, attempt.invocation, attempt.attempt) };
}

/**
 * A running root Orchestrator turn with its port: the seed's first turn when
 * it has not executed yet, otherwise a fresh ordinary turn continuing the
 * latest root turn (prepared through the preparation service, as the root
 * support prepares one), with a fresh manifest assembled now.
 */
export async function rootTurn(h: RuntimeHarness, s: PlanningSeed) {
  const rootId = s.created.root.id;
  const latest = h.stores.invocations.latestAtPosition(rootId, "orchestrator");
  const invocation = latest !== null && (latest.status === "pending" || latest.status === "running") ? latest : h.preparation.prepare({ runId: s.created.run.id, planNodeId: rootId, role: "orchestrator", purpose: "operator_input", continuedFromInvocationId: latest?.id ?? null, patternPosition: { kind: "orchestrator" } }).invocation;
  const prepared = await h.executor.prepareNextAttempt(invocation.id);
  if (prepared.kind !== "prepared") throw new Error(`root Attempt not prepared: ${prepared.kind}`);
  return { invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

/**
 * Observes every statement the harness database executes from now on:
 * the SQL texts and the rows each returned. A bounded read is proven by
 * what the store actually retrieved, never inferred from a small response.
 */
export function observeQueries(h: RuntimeHarness) {
  const sqlite = h.ctx.sqlite;
  const original = sqlite.prepare.bind(sqlite);
  const statements: { sql: string; rows: number }[] = [];
  const prepare = (source: string) => {
    const statement = original(source);
    const count = (rows: number) => statements.push({ sql: source, rows });
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const raw = statement.raw.bind(statement);
    statement.all = ((...params: unknown[]) => {
      const rows = all(...params);
      count(rows.length);
      return rows;
    }) as typeof statement.all;
    statement.get = ((...params: unknown[]) => {
      const row = get(...params);
      count(row === undefined ? 0 : 1);
      return row;
    }) as typeof statement.get;
    statement.raw = ((...args: unknown[]) => {
      raw(...(args as []));
      return statement;
    }) as typeof statement.raw;
    return statement;
  };
  (sqlite as { prepare: unknown }).prepare = prepare;
  return {
    statements,
    reset: () => statements.splice(0),
    /** Rows retrieved from `table` by every statement selecting from it. */
    rowsFrom: (table: string) => statements.filter((s) => new RegExp(`\\bfrom\\s+"?${table}"?`, "i").test(s.sql)).reduce((sum, s) => sum + s.rows, 0),
    /** The statements selecting from `table`. */
    selectsFrom: (table: string) => statements.filter((s) => new RegExp(`\\bfrom\\s+"?${table}"?`, "i").test(s.sql)),
    restore: () => {
      (sqlite as { prepare: unknown }).prepare = original;
    },
  };
}

/** The next Attempt of a running Invocation whose previous Attempt failed transiently: the same Invocation, a retried Attempt, a fresh port. */
export async function retriedAttempt(h: RuntimeHarness, invocation: Invocation) {
  passRetryBackoff(h, invocation.id);
  const prepared = await h.executor.prepareNextAttempt(invocation.id);
  if (prepared.kind !== "prepared") throw new Error(`retry not prepared: ${prepared.kind}`);
  return { invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}
