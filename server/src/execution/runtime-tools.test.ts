/**
 * The runtime-tool call boundary (execution-model §6.4 "Runtime tools";
 * invariants 5 the runtime owns Task creation and 6 no transcript decides
 * anything): the effective callable set, separation from provider-native
 * authorization, one short root transaction per mutating call outside the
 * provider's, nothing written for a rejected call, replay by canonical
 * digest, replay after a lost response, and no raw input in Events or
 * diagnostics.
 */
import { canonicalJson, effectiveRuntimeTools, runtimeToolsFor, type RuntimeToolCallRequest, type TaskProposalBatch } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { coordinatorNode, decomposePort, finishRoot, proposal, propose, workersOf, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";
import type { ExecutionDiagnostic } from "./workspace-cleanup.ts";

describe("runtime-tool call boundary", () => {
  it("exposes only the effective callable set — manifest permission ∩ registered handlers ∩ role and purpose — and refuses every other tool without writing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      // Role permission is wider than the effective set: an Evaluator never reaches a handler, and a synthesize turn holds no Task handler.
      expect(runtimeToolsFor("coordinator", "decompose")).toContain("request_decision");
      expect(d.port.tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "propose_tasks", "update_task", "request_decision", "write_artifact"]);
      expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "synthesize"), "coordinator", "synthesize")).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "request_decision", "write_artifact"]);
      expect(effectiveRuntimeTools(runtimeToolsFor("worker", "task"), "worker", "task")).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "update_task", "request_decision", "write_artifact"]);
      expect(effectiveRuntimeTools(runtimeToolsFor("evaluator", "evaluate"), "evaluator", "evaluate")).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "write_artifact"]);
      expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", "operator_input"), "orchestrator", "operator_input")).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "update_task", "request_completion", "request_decision", "write_artifact", "create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]);
      // A manifest that withholds a tool withholds it from the port even for the right role and purpose.
      const narrowed = new RuntimeToolExecutor(h.ctx, h.stores, { runId: s.created.run.id, planNodeId: d.node.id, invocationId: d.invocation.id, attemptId: d.attempt.id, role: "coordinator", purpose: "decompose", manifestTools: ["update_task", "return_result"] });
      expect(narrowed.tools).toEqual(["update_task"]);
      expect(await narrowed.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]))).toEqual({ kind: "not_callable", tool: "propose_tasks" });
      const seq = h.ctx.journal.lastSeq();
      expect(await d.port.call({ tool: "request_decision", input: {} } as never)).toMatchObject({ kind: "rejected", tool: "request_decision", reasons: [{ code: "invalid_input" }] });
      expect(await d.port.call({ tool: "return_result", input: {} } as never)).toEqual({ kind: "not_callable", tool: "return_result" });
      expect(await d.port.call({ input: {} } as never)).toEqual({ kind: "not_callable", tool: "unknown" });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.tasks.listByRun(s.created.run.id)).toEqual([]);
      // The port bound to the root Orchestrator's Attempt exposes exactly its handlers, whatever its role permits.
      expect(h.provider.requests[0]!.runtimeTools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "update_task", "request_completion", "request_decision", "write_artifact", "create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]);
    } finally {
      h.close();
    }
  });

  it("is separate from capability authorization: an accepted call claims no approval, opens no Decision, and needs no authorization port", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const decisions = h.stores.decisions.listByConversation(s.created.run.conversationId).length;
      const outcome = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]));
      expect(outcome.kind).toBe("accepted");
      expect(h.stores.approvedToolCallUses.listByRun(s.created.run.id)).toEqual([]);
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toHaveLength(decisions);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === "application/x-tool-call+json")).toEqual([]);
      // The scripted provider records the two ports apart: a runtime-tool call is never an authorization.
      expect(h.provider.authorizations).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("runs a mutating call in its own short root transaction outside the provider's execution, committing the mutation, the record, and its Event together", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const batch = propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a"] })]);
      // Never inside a transaction: the provider executes outside every one, and so does every call it submits.
      await expect(h.ctx.tx.write(() => d.port.call(batch))).rejects.toThrow(/outside any persistence transaction/);
      expect(h.ctx.tx.inTransaction).toBe(false);
      const seq = h.ctx.journal.lastSeq();
      const outcome = await d.port.call(batch);
      expect(outcome.kind).toBe("accepted");
      expect(h.ctx.tx.inTransaction).toBe(false);
      // One contiguous group of Events: Tasks, dependency, reservations, then the committed call, nothing in between.
      const events = h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual(["task.created", "task.created", "task.dependency_added", "budget_reservation.created", "budget_reservation.created", "runtime_tool_call.committed"]);
      if (outcome.kind !== "accepted") return;
      const call = h.stores.runtimeToolCalls.get(outcome.callId);
      expect(call).toMatchObject({ runId: s.created.run.id, planNodeId: d.node.id, invocationId: d.invocation.id, attemptId: d.attempt.id, tool: "propose_tasks", callDigest: outcome.callDigest });
      expect(h.stores.runtimeToolCalls.listByAttempt(d.attempt.id)).toEqual([call]);
      // The provider itself, when it runs, is outside any transaction (recorded by the fake).
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(d.attempt.id);
      expect(h.provider.requests[0]!.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("writes nothing for an invalid or rejected call: no row, no domain mutation, no Event, no reservation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const seq = h.ctx.journal.lastSeq();
      const capacity = h.stores.reservations.capacity({ type: "plan_node", id: d.node.id });
      const malformed = await d.port.call({ tool: "propose_tasks", input: { tasks: [{ key: "a", subject: "", requirementIds: [], inputArtifactIds: [], requiredOutputs: [], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null }] } } as never);
      expect(malformed).toMatchObject({ kind: "rejected", tool: "propose_tasks", reasons: [{ code: "invalid_input" }] });
      const unknownField = await d.port.call({ tool: "propose_tasks", input: { tasks: [{ ...proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), planNodeId: d.node.id }] } } as never);
      expect(unknownField).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      const outOfScope = await d.port.call(propose([proposal({ key: "a", requirementIds: [h.ctx.ids("requirement")] })]));
      expect(outOfScope).toMatchObject({ kind: "rejected", reasons: [{ code: "requirement_out_of_scope", path: "tasks.0.requirementIds" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.tasks.listByRun(s.created.run.id)).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByInvocation(d.invocation.id)).toEqual([]);
      expect(h.stores.reservations.capacity({ type: "plan_node", id: d.node.id })).toEqual(capacity);
    } finally {
      h.close();
    }
  });

  it("replays an accepted call by canonical digest without repeating its effects, refuses a different proposal after one committed, and lets a corrected call follow a rejected one", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const rejected = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "a", requirementIds: [d.leafIds[1]!] })]));
      expect(rejected).toMatchObject({ kind: "rejected", reasons: [{ code: "duplicate_key", path: "tasks.1.key" }] });
      const batch = propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!] })]);
      const first = await d.port.call(batch);
      expect(first).toMatchObject({ kind: "accepted", replayed: false });
      if (first.kind !== "accepted") return;
      const seq = h.ctx.journal.lastSeq();
      // The same call — the same canonical bytes whatever the key order of the objects — replays the committed result.
      const reordered: RuntimeToolCallRequest = { input: { tasks: (batch.input as TaskProposalBatch).tasks.map((t) => ({ replacesTaskId: t.replacesTaskId, dependsOnTaskIds: t.dependsOnTaskIds, dependsOnKeys: t.dependsOnKeys, requiredOutputs: t.requiredOutputs, inputArtifactIds: t.inputArtifactIds, requirementIds: t.requirementIds, subject: t.subject, key: t.key })) }, tool: "propose_tasks" };
      const again = await d.port.call(reordered);
      expect(again).toEqual({ ...first, replayed: true });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.tasks.listByRun(s.created.run.id)).toHaveLength(2);
      // A different proposal from the same turn is refused; nothing changes.
      const other = await d.port.call(propose([proposal({ key: "c", requirementIds: [d.leafIds[0]!] })]));
      expect(other).toMatchObject({ kind: "rejected", reasons: [{ code: "proposal_already_accepted" }] });
      expect(h.stores.tasks.listByRun(s.created.run.id)).toHaveLength(2);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // Concurrent identical calls: one batch, the second a replay.
      const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s2 = seedPlanningRuntime(g);
        const d2 = await decomposePort(g, s2);
        const b2 = propose([proposal({ key: "a", requirementIds: [d2.leafIds[0]!] })]);
        const both = await Promise.all([d2.port.call(b2), d2.port.call(b2)]);
        expect(both.map((o) => o.kind === "accepted" && o.replayed)).toEqual([false, true]);
        expect(g.stores.tasks.listByRun(s2.created.run.id)).toHaveLength(1);
        expect(g.stores.runtimeToolCalls.listByInvocation(d2.invocation.id)).toHaveLength(1);
      } finally {
        g.close();
      }
    } finally {
      h.close();
    }
  });

  it("keeps an accepted call after the provider fails and the Attempt is retried: the retry's identical call replays, and the batch exists once", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds, revisionNumber } = coordinatorNode(h, s);
      await finishRoot(h, s);
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      const started = h.runners.coordinatorWorker.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const batch = propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })]);
      // Attempt 1: the proposal commits, then the provider response is lost (a transient failure); Attempt 2 submits the same call.
      h.provider.script({ kind: "runtime_tool_calls", calls: [batch], then: { kind: "transient_error" } }, { kind: "runtime_tool_calls", calls: [batch], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const first = await h.executor.advanceInvocation(started.invocationId);
      expect(first).toMatchObject({ kind: "finalized", attempt: { number: 1, failureClass: "provider_transient" }, settlement: { kind: "retry_pending" } });
      expect(h.stores.tasks.listByRun(s.created.run.id)).toHaveLength(1);
      h.clock.set(h.stores.invocations.listAttempts(started.invocationId)[0]!.retryDecision!.notBefore!);
      const second = await h.executor.advanceInvocation(started.invocationId);
      expect(second).toMatchObject({ kind: "finalized", attempt: { number: 2, status: "succeeded" } });
      expect(h.provider.runtimeToolCalls.map((c) => c.outcome.kind === "accepted" && [c.outcome.replayed, c.outcome.callId])).toEqual([[false, expect.any(String)], [true, h.stores.runtimeToolCalls.listByInvocation(started.invocationId)[0]!.id]]);
      expect(h.stores.tasks.listByRun(s.created.run.id)).toHaveLength(1);
      expect(h.stores.runtimeToolCalls.listByInvocation(started.invocationId)).toHaveLength(1);
      expect(h.stores.runtimeToolCalls.listByInvocation(started.invocationId)[0]!.attemptId).toBe(h.stores.invocations.listAttempts(started.invocationId)[0]!.id);
      expect(workersOf(h, node)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("keeps raw call input out of Events and diagnostics: the record carries ids, the digest, and the bounded result; a failed commit reports ids and the digest only", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const diagnostics: ExecutionDiagnostic[] = [];
      const d = await decomposePort(h, s, {}, (x) => diagnostics.push(x));
      const marker = "MARKER-9c1f-do-not-persist";
      // A rejected call with a distinctive subject leaves no trace of it anywhere.
      const rejected = await d.port.call(propose([proposal({ key: "x", subject: marker, requirementIds: [h.ctx.ids("requirement")] })]));
      expect(rejected.kind).toBe("rejected");
      expect(canonicalJson(h.ctx.journal.read({ runId: s.created.run.id }))).not.toContain(marker);
      expect(diagnostics).toEqual([]);
      // An accepted call's Event is the record: no input, no prompt, no transcript; the Task subject lives only on the Task.
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] })]));
      if (accepted.kind !== "accepted") throw new Error(accepted.kind);
      const event = h.ctx.journal.read({ runId: s.created.run.id, type: "runtime_tool_call.committed" })[0]!;
      expect(Object.keys(event.payload as object).sort()).toEqual(["attemptId", "callDigest", "committedAt", "id", "invocationId", "planNodeId", "result", "runId", "tool"]);
      expect(canonicalJson(event.payload)).not.toContain("requiredOutputs");
      expect(event.actor).toEqual({ kind: "invocation", invocationId: d.invocation.id });
      // A commit that fails (here: the Attempt ended meanwhile) reports `failed` with ids, tool, digest, and a bounded message — never the input.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(d.attempt.id);
      const late = await d.port.call({ tool: "update_task", input: { taskId: accepted.result.tool === "propose_tasks" ? accepted.result.taskIds[0]! : ("task_0" as never), update: { kind: "cancel", reason: marker } } });
      expect(late).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_running" }] });
      expect(canonicalJson(h.ctx.journal.read({ runId: s.created.run.id }))).not.toContain(marker);
      expect(diagnostics).toEqual([]);
    } finally {
      h.close();
    }
  });
});
