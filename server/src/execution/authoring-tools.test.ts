/**
 * The Orchestrator's authoring tools through the runtime-tool executor
 * (execution-model §5.5.1, §8.2, §4.5): `create_tasks` creates Run-level
 * Tasks the runtime owns; the full `update_task` enforces visibility,
 * ownership, terminal immutability, Evidence scope, and output provenance
 * per role; `record_decision` records a resolved `orchestrator_choice` the
 * Orchestrator alone owns; `revise_execution_plan` compiles through the one
 * plan-revision service and reports the compiler's verdict. Every call is
 * replayable by digest; every rejection writes nothing.
 */
import type { PlanExpression, RuntimeToolCallRequest, TaskId, TaskProposal, TaskUpdate } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { seedArtifact, seedSnapshot } from "../persistence/test-support.ts";
import { decomposePort, portFor, proposal, propose as proposeTasks, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { rootPort, workerPort } from "./decision-test-support.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { asSeeded, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

const create = (tasks: TaskProposal[]): RuntimeToolCallRequest => ({ tool: "create_tasks", input: { tasks } });
const update = (taskId: string, change: TaskUpdate): RuntimeToolCallRequest => ({ tool: "update_task", input: { taskId: taskId as never, update: change } });
const record = (overrides: Partial<Extract<RuntimeToolCallRequest, { tool: "record_decision" }>["input"]> = {}): RuntimeToolCallRequest => ({
  tool: "record_decision",
  input: { question: "Which framework?", options: [{ key: "fastify", label: "Fastify" }, { key: "express", label: "Express", description: "the incumbent" }], chosenOptionKey: "express", rationale: "The repository already depends on it.", affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, ...overrides },
});

function acceptedIds(outcome: Awaited<ReturnType<RuntimeToolExecutor["call"]>>): TaskId[] {
  if (outcome.kind !== "accepted" || outcome.result.tool !== "create_tasks") throw new Error(`expected accepted create_tasks, got ${JSON.stringify(outcome)}`);
  return outcome.result.taskIds;
}

describe("create_tasks", () => {
  it("creates Run-level Tasks the runtime owns — origin orchestrator, no node, pinned to the current revision, dependencies by key and by id — replays by digest, and refuses out-of-scope Requirements, unknown keys, cycles, and a Coordinator's Task as a replacement", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const leaf = s.completion.requirementId;
      const seq = h.ctx.journal.lastSeq();
      // Rejections write nothing.
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [h.ctx.ids("requirement")] })]))).toMatchObject({ kind: "rejected", tool: "create_tasks", reasons: [{ code: "requirement_out_of_scope", path: "tasks.0.requirementIds" }] });
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf], dependsOnKeys: ["zzz"] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "unknown_dependency_key" }] });
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf], dependsOnKeys: ["b"] }), proposal({ key: "b", requirementIds: [leaf], dependsOnKeys: ["a"] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "dependency_cycle" }] });
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf], dependsOnTaskIds: [h.ctx.ids("task")] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "foreign_dependency" }] });
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf], inputArtifactIds: [h.ctx.ids("artifact")] })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "unknown_artifact" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.tasks.listByRun(runId)).toEqual([]);
      // Acceptance: two Tasks, the second depending on the first by key; then a third depending on the first by id.
      const first = await r.port.call(create([proposal({ key: "a", requirementIds: [leaf] }), proposal({ key: "b", requirementIds: [leaf], dependsOnKeys: ["a"] })]));
      const [a, b] = acceptedIds(first);
      expect(first).toMatchObject({ kind: "accepted", replayed: false, result: { tool: "create_tasks", taskIdsByKey: { a, b } } });
      expect(h.stores.tasks.get(a!)).toMatchObject({ runId, planNodeId: null, origin: "orchestrator", requirementIds: [leaf], requirementRevisionId: s.completion.revision.id, replacesTaskId: null });
      expect(h.stores.tasks.dependenciesOf(b!).map((d) => d.dependsOnTaskId)).toEqual([a]);
      expect(h.stores.reservations.listByChild({ type: "task", id: a! })).toEqual([]);
      // The identical call replays without a second batch; a different batch depending on `a` by id is a new call.
      expect(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf] }), proposal({ key: "b", requirementIds: [leaf], dependsOnKeys: ["a"] })]))).toMatchObject({ kind: "accepted", replayed: true, result: { taskIds: [a, b] } });
      const third = await r.port.call(create([proposal({ key: "c", requirementIds: [leaf], dependsOnTaskIds: [a!] })]));
      const [c] = acceptedIds(third);
      expect(h.stores.tasks.dependenciesOf(c!).map((d) => d.dependsOnTaskId)).toEqual([a]);
      expect(h.stores.tasks.listByRun(runId)).toHaveLength(3);
      expect(h.stores.runtimeToolCalls.listByInvocation(r.invocation.id).map((call) => call.tool)).toEqual(["create_tasks", "create_tasks"]);
      // A Worker never holds create_tasks; the executor refuses it by name without a handler.
      const w = await workerPort(h, s);
      expect(w.port.tools).not.toContain("create_tasks");
      expect(await w.port.call(create([proposal({ key: "z", requirementIds: [leaf] })]))).toEqual({ kind: "not_callable", tool: "create_tasks" });
    } finally {
      h.close();
    }
  });

  it("never replaces a Coordinator's Task from the root: a Coordinator's ledger is its own", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const accepted = await d.port.call(proposeTasks([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error(accepted.kind);
      const coordinatorTask = accepted.result.taskIds[0]!;
      h.stores.tasks.transition(coordinatorTask, { to: "blocked", blockReason: { kind: "input", description: "awaiting the operator" } });
      // The root has ended (the Coordinator node runs); a later root turn is prepared for the check.
      const turn = h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "node_result", patternPosition: { kind: "orchestrator" }, continuedFromInvocationId: s.invocation.id, handoffIds: [], inputs: [{ kind: "node_result", planNodeId: d.node.id, status: "running", outputArtifactIds: [] }] });
      const prepared = await h.executor.prepareNextAttempt(turn.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      expect(await port.call(create([proposal({ key: "r", requirementIds: [d.leafIds[0]!], replacesTaskId: coordinatorTask })]))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_replacement", path: "tasks.0.replacesTaskId" }] });
      expect(h.stores.tasks.get(coordinatorTask).status).toBe("blocked");
    } finally {
      h.close();
    }
  });
});

describe("update_task", () => {
  it("lets the Orchestrator add scoped Evidence and provenance-checked outputs to a current non-terminal Task, cancel its own unstarted Task, and refuses hidden, terminal, foreign, or runtime-owned associations", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const leaf = s.completion.requirementId;
      const [a, b] = acceptedIds(await r.port.call(create([proposal({ key: "a", requirementIds: [leaf] }), proposal({ key: "b", requirementIds: [leaf] })])));
      const own = seedArtifact(h, asSeeded(s), "notes", { invocationId: r.invocation.id });
      const foreignRun = seedPlanningRuntime(h);
      const foreign = seedArtifact(h, asSeeded(foreignRun), "elsewhere");
      const snapshot = seedSnapshot(h, asSeeded(s));
      const foreignSnapshot = seedSnapshot(h, asSeeded(foreignRun));
      const seq = h.ctx.journal.lastSeq();
      // Scope refusals: command Evidence is the runtime's; a foreign Artifact or Snapshot is out of scope; an unknown Task is not visible.
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence: [{ kind: "command", command: "npm test", exitCode: 0, outputArtifactId: own.id }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_out_of_scope", path: "update.evidence.0" }] });
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence: [{ kind: "artifact", artifactId: foreign.id }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_out_of_scope" }] });
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence: [{ kind: "snapshot", snapshotId: foreignSnapshot.id }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_out_of_scope" }] });
      expect(await r.port.call(update(a!, { kind: "add_outputs", artifactIds: [foreign.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "artifact_provenance_invalid" }] });
      expect(await r.port.call(update(h.ctx.ids("task"), { kind: "add_outputs", artifactIds: [own.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_visible", path: "taskId" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // Evidence within scope: the caller's own Artifact, the Run's Snapshot, a URL; a repeat association writes nothing; the identical call replays.
      const evidence = [{ kind: "artifact" as const, artifactId: own.id }, { kind: "snapshot" as const, snapshotId: snapshot.id }, { kind: "url" as const, url: "https://example.test/report" }];
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence }))).toMatchObject({ kind: "accepted", replayed: false, result: { tool: "update_task", taskId: a, status: "pending" } });
      expect(h.stores.tasks.get(a!).evidence).toEqual(evidence);
      expect(h.ctx.journal.read({ runId, type: "task.evidence_recorded" })).toHaveLength(1);
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence }))).toMatchObject({ kind: "accepted", replayed: true });
      const before = h.ctx.journal.lastSeq();
      expect(await r.port.call(update(a!, { kind: "add_evidence", evidence: [evidence[0]!] }))).toMatchObject({ kind: "accepted", replayed: false });
      expect(h.stores.tasks.get(a!).evidence).toEqual(evidence);
      expect(h.ctx.journal.read({ runId, afterSeq: before, type: "task.evidence_recorded" })).toEqual([]);
      // Outputs: the Artifact becomes `a`'s output; the same Artifact is refused as another Task's output.
      expect(await r.port.call(update(a!, { kind: "add_outputs", artifactIds: [own.id] }))).toMatchObject({ kind: "accepted", result: { taskId: a } });
      expect(h.stores.tasks.get(a!).outputArtifactIds).toEqual([own.id]);
      expect(await r.port.call(update(b!, { kind: "add_outputs", artifactIds: [own.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "artifact_provenance_invalid", path: "update.artifactIds.0" }] });
      // The Orchestrator cancels its own unstarted Task once; the cancelled Task is terminal and immutable.
      expect(await r.port.call(update(b!, { kind: "cancel", reason: "no longer needed" }))).toMatchObject({ kind: "accepted", result: { taskId: b, status: "cancelled" } });
      expect(await r.port.call(update(b!, { kind: "cancel", reason: "again" }))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_cancellable" }] });
      expect(await r.port.call(update(b!, { kind: "add_evidence", evidence: [evidence[2]!] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_terminal", path: "taskId" }] });
      expect(h.stores.tasks.get(b!).evidence).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("scopes a Coordinator to its node's Tasks and a Worker to the Tasks assigned to it, and lets neither cancel outside its rule", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const accepted = await d.port.call(proposeTasks([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error(accepted.kind);
      const [a, b] = accepted.result.taskIds;
      const orchestratorTask = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: null, origin: "orchestrator", subject: "root-owned", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const coordinatorArtifact = seedArtifact(h, asSeeded(s), "plan", { invocationId: d.invocation.id });
      // The Coordinator: its own node's Task accepts Evidence; the root's Task is not visible to it.
      expect(await d.port.call(update(a!, { kind: "add_evidence", evidence: [{ kind: "artifact", artifactId: coordinatorArtifact.id }] }))).toMatchObject({ kind: "accepted", result: { taskId: a } });
      expect(await d.port.call(update(orchestratorTask.id, { kind: "add_evidence", evidence: [{ kind: "url", url: "https://example.test" }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_visible" }] });
      // A Worker running Task `a`: it may add Evidence and outputs to `a` alone, and never cancels.
      h.stores.tasks.transition(a!, { to: "ready" });
      const worker = h.preparation.prepare({ runId: s.created.run.id, planNodeId: d.node.id, role: "worker", purpose: "task", continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: a! }, funding: { source: "task_transfer", taskReservationId: h.stores.reservations.activeForChild({ type: "task", id: a! })!.id } });
      const prepared = await h.executor.prepareNextAttempt(worker.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const workerPortForA = portFor(h, prepared.invocation, prepared.attempt);
      const workerArtifact = seedArtifact(h, asSeeded(s), "diff", { invocationId: prepared.invocation.id });
      expect(workerPortForA.tools).toContain("update_task");
      expect(await workerPortForA.call(update(a!, { kind: "add_outputs", artifactIds: [workerArtifact.id] }))).toMatchObject({ kind: "accepted", result: { taskId: a, status: "running" } });
      expect(h.stores.tasks.get(a!).outputArtifactIds).toEqual([workerArtifact.id]);
      expect(await workerPortForA.call(update(b!, { kind: "add_outputs", artifactIds: [workerArtifact.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "task_not_visible" }] });
      expect(await workerPortForA.call(update(a!, { kind: "cancel", reason: "cannot do it" }))).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted", path: "update" }] });
      // The Coordinator's Artifact is not readable by the Worker: Evidence scope follows the caller's manifest and own production.
      expect(await workerPortForA.call(update(a!, { kind: "add_evidence", evidence: [{ kind: "artifact", artifactId: coordinatorArtifact.id }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_out_of_scope" }] });
      expect(h.stores.tasks.get(a!).status).toBe("running");
    } finally {
      h.close();
    }
  });
});

describe("record_decision", () => {
  it("records a resolved orchestrator_choice the calling Orchestrator requested and resolved in one transaction, within its scope; replays by digest; and is never resolvable or requestable by anyone else", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      expect(await r.port.call(record({ chosenOptionKey: "nope" }))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(record({ affects: { requirementIds: [], taskIds: [h.ctx.ids("task")], planNodeIds: [] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.taskIds" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      const outcome = await r.port.call(record({ affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [s.created.root.id] } }));
      if (outcome.kind !== "accepted" || outcome.result.tool !== "record_decision") throw new Error(JSON.stringify(outcome));
      const decision = h.stores.decisions.get(outcome.result.decisionId);
      expect(outcome.result.chosenOptionId).toBe("express");
      expect(decision).toMatchObject({
        kind: "orchestrator_choice",
        status: "resolved",
        requestedBy: { kind: "invocation", invocationId: r.invocation.id },
        recommendedOptionId: "express",
        rationale: "The repository already depends on it.",
        affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [s.created.root.id] },
        resolution: { resolvedBy: "orchestrator", chosenOptionId: "express", rationale: "The repository already depends on it.", artifactIds: [] },
      });
      expect(decision.options.map((o) => [o.id, o.label, o.description])).toEqual([["fastify", "Fastify", null], ["express", "Express", "the incumbent"]]);
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type)).toEqual(["decision.requested", "decision.resolved", "runtime_tool_call.committed"]);
      // The identical call replays; the recorded choice is visible to the Orchestrator's reads; the operator never resolves or supersedes it.
      expect(await r.port.call(record({ affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [s.created.root.id] } }))).toMatchObject({ kind: "accepted", replayed: true, result: { decisionId: decision.id } });
      const read = await r.port.call({ tool: "read_decisions", input: { decisionId: decision.id } });
      expect(read).toMatchObject({ kind: "read", tool: "read_decisions" });
      expect(() => h.decisionRequests.resolve({ decisionId: decision.id, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "decision_not_requested" }));
      expect(() => h.decisionRequests.supersede({ decisionId: decision.id, optionId: "fastify" })).toThrow(expect.objectContaining({ refusal: "decision_not_requested" }));
      const w = await workerPort(h, s);
      expect(await w.port.call(record())).toEqual({ kind: "not_callable", tool: "record_decision" });
    } finally {
      h.close();
    }
  });
});

describe("revise_execution_plan", () => {
  it("compiles the Orchestrator's source through the one plan-revision service: an accepted revision reports its number, a rejected source reports the compiler's reasons as an accepted call, replays by digest, and the tool is absent without a configured service", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      expect(r.port.tools).toContain("revise_execution_plan");
      const before = h.stores.plans.latestRevisionNumber(runId);
      const expression: PlanExpression = { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "implement" }, allocation: { costUsd: 1, tokens: 10_000, attempts: 2 } } as PlanExpression;
      const revise = (expressions: unknown[]): RuntimeToolCallRequest => ({ tool: "revise_execution_plan", input: { source: { version: 1, expressions } } });
      const accepted = await r.port.call(revise([expression]));
      expect(accepted).toMatchObject({ kind: "accepted", replayed: false, result: { tool: "revise_execution_plan", accepted: true, revisionNumber: before + 1, reasons: [] } });
      expect(h.stores.plans.latestRevisionNumber(runId)).toBe(before + 1);
      expect(h.stores.plans.getRevision(runId, before + 1).proposedByInvocationId).toBe(r.invocation.id);
      expect(h.stores.plans.currentGraph(runId).nodes.map((n) => n.kind === "pattern" && n.title)).toContain("implement");
      expect(await r.port.call(revise([expression]))).toMatchObject({ kind: "accepted", replayed: true });
      // A source the compiler refuses is an accepted call whose result carries the typed reasons; no revision is recorded.
      const rejected = await r.port.call(revise([{ pattern: "sequential_dance" }]));
      expect(rejected).toMatchObject({ kind: "accepted", result: { tool: "revise_execution_plan", accepted: false, revisionNumber: null } });
      if (rejected.kind !== "accepted" || rejected.result.tool !== "revise_execution_plan") throw new Error("unreachable");
      expect(rejected.result.reasons.length).toBeGreaterThan(0);
      expect(h.stores.plans.latestRevisionNumber(runId)).toBe(before + 1);
      expect(await r.port.call({ tool: "revise_execution_plan", input: { source: "not an object" } } as never)).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      // Without a configured plan-revision service the tool is not callable at all.
      const manifest = h.stores.invocations.getManifest(r.invocation.id);
      const bare = new RuntimeToolExecutor(h.ctx, h.stores, { runId, planNodeId: r.invocation.planNodeId, invocationId: r.invocation.id, attemptId: r.attempt.id, role: "orchestrator", purpose: r.invocation.purpose, manifestTools: manifest.content.runtimeTools });
      expect(bare.tools).not.toContain("revise_execution_plan");
      expect(await bare.call(revise([expression]))).toEqual({ kind: "not_callable", tool: "revise_execution_plan" });
      const w = await workerPort(h, s);
      expect(await w.port.call(revise([expression]))).toEqual({ kind: "not_callable", tool: "revise_execution_plan" });
    } finally {
      h.close();
    }
  });
});
