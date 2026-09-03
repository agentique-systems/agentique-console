/**
 * The `request_decision` runtime tool (execution-model §6.4, §8.2;
 * invariants 5 runtime-owned control, 9 canonical objects by id, 19 no silent
 * resolution, 25 canonical runtime-tool calls): who may request which kinds,
 * scope validation against the caller's own work, atomic creation of exactly
 * one Decision with the accepted call, replay by digest, refusal of a second
 * request and of every later call of the ended turn, and nothing raw in
 * Events.
 */
import { canonicalJson, type Invocation, type RuntimeToolCallRequest } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { seedArtifact } from "../persistence/test-support.ts";
import { coordinatorNode, decomposePort, finishRoot, proposal, propose, tasksOf, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { choice, choiceInput, decisionOf, requestedBy, rootPort, waiver, workerPort } from "./decision-test-support.ts";
import { DecisionRequestService } from "./decision-requests.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { asSeeded, COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";
import type { ExecutionDiagnostic } from "./workspace-cleanup.ts";

/** Everything a request may write, for "nothing was written" assertions. */
function written(h: RuntimeHarness, runId: string) {
  return {
    decisions: h.stores.decisions.listByRun(runId as never).map((d) => [d.id, d.kind, d.status]),
    calls: h.stores.invocations.listByRun(runId as never).flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).map((c) => c.id)),
    events: h.ctx.journal.read({ runId: runId as never }).length,
  };
}

describe("request_decision", () => {
  it("lets the root Orchestrator request an operator_choice: one open Decision requested by the turn, one accepted call, the typed blocking result, replay by digest, and refusal of every later call of the turn", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const r = await rootPort(h, s);
      const seq = h.ctx.journal.lastSeq();
      const call = choice({ affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [s.created.root.id] } });
      const outcome = await r.port.call(call);
      expect(outcome).toMatchObject({ kind: "accepted", tool: "request_decision", replayed: false, result: { tool: "request_decision", status: "open", blocksInvocation: true } });
      const decisionId = decisionOf(outcome);
      const decision = h.stores.decisions.get(decisionId);
      expect(decision).toMatchObject({
        kind: "operator_choice",
        status: "open",
        resolutionPolicy: "operator_required",
        runId,
        conversationId: s.created.run.conversationId,
        requestedBy: { kind: "invocation", invocationId: r.invocation.id },
        question: "Which HTTP framework should the CLI use?",
        recommendedOptionId: "fastify",
        rationale: "Fastify is already installed.",
        affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [s.created.root.id] },
        deadlineAt: null,
        activationCondition: null,
        subject: null,
      });
      // Option order is operator-facing semantics: preserved exactly, keys as ids, descriptions kept or null.
      expect(decision.options).toEqual([
        { id: "fastify", label: "Fastify", description: "already a dependency" },
        { id: "express", label: "Express", description: null },
      ]);
      // One transaction: the Decision, then the accepted call, and nothing else; the call Event carries ids and the bounded result only.
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["decision.requested", "runtime_tool_call.committed"]);
      const committed = events[1]!.payload as Record<string, unknown>;
      expect(Object.keys(committed).sort()).toEqual(["attemptId", "callDigest", "committedAt", "id", "invocationId", "planNodeId", "result", "runId", "tool"]);
      expect(committed.result).toEqual({ tool: "request_decision", decisionId, status: "open", blocksInvocation: true });
      expect(canonicalJson(committed)).not.toContain("Fastify");
      expect(h.stores.runtimeToolCalls.listByInvocation(r.invocation.id).map((c) => c.tool)).toEqual(["request_decision"]);
      expect(requestedBy(h, r.invocation).map((d) => d.id)).toEqual([decisionId]);
      // The Invocation and Attempt are still running here: the executor settles the boundary once the provider returns.
      expect(h.stores.invocations.get(r.invocation.id).status).toBe("running");
      // An identical replay returns the same Decision and result without a second row or Event.
      const replay = await r.port.call(call);
      expect(replay).toMatchObject({ kind: "accepted", replayed: true, callId: outcome.kind === "accepted" ? outcome.callId : "", result: { decisionId } });
      expect(h.ctx.journal.lastSeq()).toBe(seq + 2);
      // A different request, and every other call of the ended turn, are refused without writing.
      const before = written(h, runId);
      expect(await r.port.call(choice({ question: "Another?" }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_already_requested" }] });
      expect(await r.port.call({ tool: "request_completion", input: {} })).toMatchObject({ kind: "rejected", reasons: [{ code: "turn_ended" }] });
      expect(written(h, runId)).toEqual(before);
      expect(h.stores.decisions.listByRun(runId).filter((d) => d.kind === "operator_choice")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("lets a Coordinator turn and a Worker Task request an operator_choice within their own scope, and refuses foreign, historical, or inaccessible ids atomically", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const d = await decomposePort(h, s, { leaves: 2 });
      // The Coordinator's scope: its own node, its node's Tasks, and its pinned leaves.
      const batch = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]));
      const taskId = batch.kind === "accepted" && batch.result.tool === "propose_tasks" ? batch.result.taskIds[0]! : ("task_0" as never);
      const before = written(h, runId);
      expect(await d.port.call(choice({ affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.requirementIds" }] });
      expect(await d.port.call(choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [s.created.root.id] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.planNodeIds" }] });
      expect(await d.port.call(choice({ affects: { requirementIds: [], taskIds: ["task_000000000000000000000000" as never], planNodeIds: [] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.taskIds" }] });
      expect(await d.port.call(waiver(d.leafIds[0]!))).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(written(h, runId)).toEqual(before);
      const accepted = await d.port.call(choice({ affects: { requirementIds: [d.leafIds[0]!, d.leafIds[1]!], taskIds: [taskId], planNodeIds: [d.node.id] } }));
      expect(accepted.kind).toBe("accepted");
      expect(h.stores.decisions.get(decisionOf(accepted))).toMatchObject({ requestedBy: { kind: "invocation", invocationId: d.invocation.id }, affects: { requirementIds: [d.leafIds[0], d.leafIds[1]], taskIds: [taskId], planNodeIds: [d.node.id] } });
      expect(tasksOf(h, d.node)).toHaveLength(1);
      // A Worker on its Task: its own Task and node only; another Task, another node, and a Requirement outside its manifest are refused.
      const w = await workerPort(h, s, { title: "step" });
      const beforeWorker = written(h, runId);
      expect(await w.port.call(choice({ affects: { requirementIds: [], taskIds: [taskId], planNodeIds: [] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.taskIds" }] });
      expect(await w.port.call(choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [d.node.id] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.planNodeIds" }] });
      // An unscoped Worker's manifest carries the current revision, so a current leaf is in scope; the leaf the new revision retired is not.
      expect(await w.port.call(choice({ affects: { requirementIds: [s.completion.requirementId], taskIds: [], planNodeIds: [] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "affects.requirementIds" }] });
      expect(await w.port.call(choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: d.node.id } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [w.node.id] } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "resolutionPolicy.activationCondition.planNodeId" }] });
      expect(await w.port.call(waiver(s.completion.requirementId))).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(written(h, runId)).toEqual(beforeWorker);
      const workerAccepted = await w.port.call(choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [w.node.id] } }));
      expect(workerAccepted.kind).toBe("accepted");
      expect(h.stores.decisions.get(decisionOf(workerAccepted)).requestedBy).toEqual({ kind: "invocation", invocationId: w.invocation.id });
    } finally {
      h.close();
    }
  });

  it("lets only the root Orchestrator request a requirement_waiver, pinned to a current leaf in a waivable state with readable Evidence; every other Requirement is refused typed", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      // A new revision: a root over two leaves; the seeded leaf is retired by it.
      const rootId = h.ctx.ids("requirement");
      const leaves = [h.ctx.ids("requirement"), h.ctx.ids("requirement")];
      const revision = h.stores.requirements.createRevision({
        conversationId,
        approvedByDecisionId: null,
        tree: [
          { id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] },
          ...leaves.map((id, index) => ({ id, parentId: rootId, composition: null, statement: `Leaf ${index + 1}`, position: index, acceptanceCriterionIds: [] })),
        ],
      });
      const r = await rootPort(h, s);
      const own = seedArtifact(h, asSeeded(s), "evidence", { invocationId: r.invocation.id });
      const foreignRun = seedPlanningRuntime(h);
      const foreign = seedArtifact(h, asSeeded(foreignRun), "foreign");
      const hidden = seedArtifact(h, asSeeded(s), "hidden");
      const before = written(h, runId);
      expect(await r.port.call(waiver(rootId))).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_not_waivable", path: "requirementId" }] });
      expect(await r.port.call(waiver(s.completion.requirementId))).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_not_waivable" }] });
      expect(await r.port.call(waiver(foreignRun.completion.requirementId))).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_scope_invalid", path: "requirementId" }] });
      expect(await r.port.call(waiver(leaves[0]!, { evidenceArtifactIds: [foreign.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_invalid" }] });
      expect(await r.port.call(waiver(leaves[0]!, { evidenceArtifactIds: [hidden.id] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_invalid" }] });
      expect(await r.port.call(waiver(leaves[0]!, { evidenceArtifactIds: ["art_000000000000000000000000" as never] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "evidence_invalid" }] });
      expect(written(h, runId)).toEqual(before);
      const accepted = await r.port.call(waiver(leaves[0]!, { evidenceArtifactIds: [own.id] }));
      expect(accepted).toMatchObject({ kind: "accepted", result: { tool: "request_decision", status: "open", blocksInvocation: true } });
      const decision = h.stores.decisions.get(decisionOf(accepted));
      expect(decision).toMatchObject({
        kind: "requirement_waiver",
        resolutionPolicy: "operator_required",
        status: "open",
        requestedBy: { kind: "invocation", invocationId: r.invocation.id },
        recommendedOptionId: null,
        rationale: "The Requirement cannot be met within this Run.",
        affects: { requirementIds: [leaves[0]], taskIds: [], planNodeIds: [] },
        subject: { kind: "requirement_waiver", runId, requirementId: leaves[0], requirementRevisionId: revision.id, evidenceArtifactIds: [own.id] },
      });
      expect(decision.options.map((o) => o.id)).toEqual(["waive", "deny"]);
      // A second waiver of the same Requirement is refused while the first is open (asked of the handler directly: the port already refuses a second request of the turn).
      const service = new DecisionRequestService(h.ctx, h.stores);
      const running = h.stores.invocations.get(r.invocation.id);
      const root = h.stores.plans.rootNode(runId) as never;
      expect(h.ctx.tx.write(() => service.request({ invocation: running, node: root }, { kind: "requirement_waiver", requirementId: leaves[0]!, rationale: "again" }, {}))).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_not_waivable" }] });
      // A waived Requirement is never waivable again; a violated one is.
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "accepted", artifactIds: [] });
      h.stores.requirements.recordStatusChange({ requirementId: leaves[0]!, runId, to: "waived", actor: "operator", evidence: [], gateId: null, decisionId: decision.id, rationale: "accepted" });
      h.stores.requirements.recordStatusChange({ requirementId: leaves[1]!, runId, to: "violated", actor: "runtime", evidence: [{ kind: "artifact", artifactId: own.id }], gateId: null, decisionId: null, rationale: null });
      expect(h.ctx.tx.write(() => service.request({ invocation: running, node: root }, { kind: "requirement_waiver", requirementId: leaves[0]!, rationale: "again" }, {}))).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_not_waivable" }] });
      expect(h.ctx.tx.write(() => service.request({ invocation: running, node: root }, { kind: "requirement_waiver", requirementId: leaves[1]!, rationale: "violated but acceptable" }, {}))).toMatchObject({ kind: "applied" });
    } finally {
      h.close();
    }
  });

  it("refuses every Decision kind with another owner by name before validation, and malformed or over-bound input without writing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const r = await rootPort(h, s);
      const before = written(h, runId);
      for (const kind of ["budget_increase", "side_effect_approval", "signoff", "publish", "orchestrator_choice"]) {
        expect(await r.port.call({ tool: "request_decision", input: { kind, question: "?" } } as never), kind).toMatchObject({ kind: "rejected", reasons: [{ code: "decision_kind_not_permitted", path: "kind" }] });
      }
      expect(await r.port.call({ tool: "request_decision", input: { kind: "auto_approve" } } as never)).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(choice({ options: [{ key: "a", label: "A" }] }))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input", path: "input.options" }] });
      expect(await r.port.call(choice({ recommendedOptionKey: "zzz" }))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(choice({ question: "x".repeat(2_001) }))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(choice({ resolutionPolicy: { kind: "use_default_after_deadline" } }))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(choice({ resolutionPolicy: { kind: "use_default_after_deadline", deadlineAt: "not a time" } } as never))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call({ tool: "request_decision", input: { ...choiceInput(), extra: 1 } } as never)).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(written(h, runId)).toEqual(before);
      // A use_default request carries its deadline and condition to the Decision; the activation condition stays within scope.
      const accepted = await r.port.call(choice({ resolutionPolicy: { kind: "use_default_after_deadline", deadlineAt: "2026-06-01T00:00:00.000Z", activationCondition: { kind: "plan_node_ready", planNodeId: s.created.root.id } }, affects: { requirementIds: [], taskIds: [], planNodeIds: [s.created.root.id] } }));
      expect(h.stores.decisions.get(decisionOf(accepted))).toMatchObject({ resolutionPolicy: "use_default_after_deadline", deadlineAt: "2026-06-01T00:00:00.000Z", activationCondition: { kind: "plan_node_ready", planNodeId: s.created.root.id }, recommendedOptionId: "fastify" });
    } finally {
      h.close();
    }
  });

  it("is never callable by an Evaluator or a final-synthesis turn, and the handler refuses a Gate-owned or non-running caller even when asked directly", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const w = await workerPort(h, s);
      const bind = (role: Invocation["role"], purpose: Invocation["purpose"]) => new RuntimeToolExecutor(h.ctx, h.stores, { runId: s.created.run.id, planNodeId: w.node.id, invocationId: w.invocation.id, attemptId: w.attempt.id, role, purpose, manifestTools: ["request_decision", "return_result"] });
      expect(bind("evaluator", "evaluate").tools).toEqual([]);
      expect(bind("evaluator", "select").tools).toEqual([]);
      expect(bind("orchestrator", "final_synthesis").tools).toEqual([]);
      expect(await bind("evaluator", "evaluate").call(choice())).toEqual({ kind: "not_callable", tool: "request_decision" });
      const service = new DecisionRequestService(h.ctx, h.stores);
      const ask = (invocation: Invocation) => h.ctx.tx.write(() => service.request({ invocation, node: w.node }, choiceInput(), {}));
      expect(ask({ ...w.invocation, role: "evaluator", purpose: "evaluate" })).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(ask({ ...w.invocation, role: "orchestrator", purpose: "final_synthesis" })).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(ask({ ...w.invocation, gateId: "gate_000000000000000000000000" as never })).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(ask({ ...w.invocation, status: "blocked" })).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(h.stores.decisions.listByRun(s.created.run.id).filter((d) => d.kind === "operator_choice")).toEqual([]);
      // An Attempt that is no longer running is refused at the boundary.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(w.attempt.id);
      expect(await w.port.call(choice())).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_running" }] });
    } finally {
      h.close();
    }
  });

  it("commits the Decision, the accepted call, and their Events together or not at all: a callback, Event, insert, or COMMIT failure leaves nothing, reports failed once, and the retried call succeeds", async () => {
    const injections: [string, (h: RuntimeHarness) => void][] = [
      ["at the Decision", (h) => vi.spyOn(h.stores.decisions, "request").mockImplementationOnce(() => { throw new Error("injected: decision"); })],
      ["at the call row", (h) => vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw new Error("injected: row"); })],
      ["at an Event append", (h) => {
        const append = h.ctx.journal.append.bind(h.ctx.journal);
        const spy = vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
          if (input.type === "runtime_tool_call.committed") {
            spy.mockRestore();
            throw new Error("injected: event");
          }
          return append(input);
        });
      }],
      ["at COMMIT", (h) => {
        const exec = h.ctx.sqlite.exec.bind(h.ctx.sqlite);
        const spy = vi.spyOn(h.ctx.sqlite, "exec").mockImplementation((sql: string) => {
          if (sql === "COMMIT") {
            spy.mockRestore();
            throw new Error("injected: COMMIT failed");
          }
          return exec(sql);
        });
      }],
    ];
    for (const [label, inject] of injections) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedPlanningRuntime(h);
        const runId = s.created.run.id;
        const diagnostics: ExecutionDiagnostic[] = [];
        const r = await rootPort(h, s);
        const port = new RuntimeToolExecutor(h.ctx, h.stores, { runId, planNodeId: s.created.root.id, invocationId: r.invocation.id, attemptId: r.attempt.id, role: "orchestrator", purpose: "operator_input", manifestTools: h.stores.invocations.getManifest(r.invocation.id).content.runtimeTools }, {}, (d) => diagnostics.push(d));
        const before = written(h, runId);
        inject(h);
        const failed = await port.call(choice());
        expect(failed, label).toMatchObject({ kind: "failed", tool: "request_decision" });
        expect(written(h, runId), label).toEqual(before);
        expect(h.ctx.tx.inTransaction).toBe(false);
        expect(diagnostics.map((d) => d.kind), label).toEqual(["runtime_tool_call_failed"]);
        expect(canonicalJson(diagnostics), label).not.toContain("Fastify");
        vi.restoreAllMocks();
        const retried = await port.call(choice());
        expect(retried, label).toMatchObject({ kind: "accepted", replayed: false });
        expect(h.stores.decisions.listByRun(runId).filter((d) => d.kind === "operator_choice"), label).toHaveLength(1);
        expect(h.stores.runtimeToolCalls.listByInvocation(r.invocation.id), label).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
  });

  it("keeps the requested Decision apart from capability authorization and Task proposals: an accepted request claims no approval and creates no Task, and a Coordinator's proposal in the same turn is refused after the request", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const accepted = await d.port.call(choice({ affects: { requirementIds: [d.leafIds[0]!], taskIds: [], planNodeIds: [d.node.id] } }));
      expect(accepted.kind).toBe("accepted");
      expect(h.stores.approvedToolCallUses.listByRun(s.created.run.id)).toEqual([]);
      expect(tasksOf(h, d.node)).toEqual([]);
      const late: RuntimeToolCallRequest = propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]);
      expect(await d.port.call(late)).toMatchObject({ kind: "rejected", reasons: [{ code: "turn_ended" }] });
      expect(tasksOf(h, d.node)).toEqual([]);
      // Root turn work continues to exist unchanged: the coordinator node was compiled, the root never touched.
      expect(coordinatorNode).toBeDefined();
      expect(finishRoot).toBeDefined();
    } finally {
      h.close();
    }
  });
});
