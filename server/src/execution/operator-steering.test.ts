/**
 * Service-level operator steering (execution-model §4.6): an operator
 * message is posted to the Run's Conversation and queued as a typed input;
 * nothing is injected into an active provider session; once the latest root
 * turn is settled the scheduler prepares exactly one `operator_input` turn
 * delivering every queued input, funded like every root turn; a terminal
 * Run accepts nothing.
 */
import { describe, expect, it } from "vitest";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { rootPort } from "./decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

describe("operator steering", () => {
  it("queues the operator's message without touching the active turn, then delivers every queued message in one new operator_input turn the scheduler prepares from rows", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      expect(() => h.orchestratorInputs.postOperatorMessage({ runId, content: "   " })).toThrow(expect.objectContaining({ refusal: "content_invalid" }));
      expect(() => h.orchestratorInputs.postOperatorMessage({ runId, content: "x" }, { actor: { kind: "runtime" } })).toThrow(expect.objectContaining({ refusal: "operator_required" }));
      const requests = h.provider.requests.length;
      const posted = h.orchestratorInputs.postOperatorMessage({ runId, content: "Also update the README." });
      expect(posted.message).toMatchObject({ conversationId: s.created.run.conversationId, runId, author: "operator", content: "Also update the README.", invocationId: null });
      expect(posted.queued).toMatchObject({ runId, kind: "operator_message", input: { kind: "operator_message", conversationMessageId: posted.message.id, content: "Also update the README." }, deliveredByInvocationId: null, deliveredAt: null });
      expect(h.ctx.journal.read({ runId, type: "orchestrator_input.queued" }).map((e) => e.actor)).toEqual([{ kind: "operator" }]);
      // The active root turn is untouched: no provider call, no new Invocation, no action to prepare a turn while it runs.
      expect(h.provider.requests.length).toBe(requests);
      expect(h.scheduler.reconcileRun(runId).actions.some((a) => a.kind === "prepare_root_turn")).toBe(false);
      expect(h.stores.invocations.listByRun(runId).map((i) => i.id)).toEqual([r.invocation.id]);
      const second = h.orchestratorInputs.postOperatorMessage({ runId, content: "And keep the changelog current." });
      expect(h.orchestratorInputs.pending(runId).map((q) => q.id)).toEqual([posted.queued.id, second.queued.id]);
      // The turn ends and settles; the next pass prepares exactly one operator_input turn delivering both messages, in order.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(r.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const projection = h.scheduler.reconcileRun(runId);
      expect(projection.nodes.find((n) => n.nodeId === s.created.root.id)?.advice).toMatchObject({ kind: "prepare_turn", inputIds: [posted.queued.id, second.queued.id], funded: true });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["prepare_root_turn", "turn_prepared"]]);
      const turns = h.stores.invocations.listByRun(runId).filter((i) => i.role === "orchestrator");
      expect(turns).toHaveLength(2);
      const turn = turns.find((i) => i.id !== r.invocation.id)!;
      expect(turn).toMatchObject({ purpose: "operator_input", continuedFromInvocationId: r.invocation.id, status: "pending" });
      const content = h.stores.invocations.getManifest(turn.id).content;
      expect(content.inputs).toEqual([
        { kind: "operator_message", conversationMessageId: posted.message.id, content: "Also update the README." },
        { kind: "operator_message", conversationMessageId: second.message.id, content: "And keep the changelog current." },
      ]);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
      expect(h.orchestratorInputs.listByRun(runId).map((q) => [q.id, q.deliveredByInvocationId])).toEqual([[posted.queued.id, turn.id], [second.queued.id, turn.id]]);
      expect(h.ctx.journal.read({ runId, type: "orchestrator_input.delivered" })).toHaveLength(2);
      // The turn is funded like every root turn from the root's allocation; a second pass prepares nothing more.
      expect(h.stores.reservations.listByChild({ type: "invocation", id: turn.id })).toHaveLength(1);
      expect(h.scheduler.reconcileRun(runId).actions.some((a) => a.kind === "prepare_root_turn")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("refuses to queue for a Run that ended, and delivers a message posted while the root waits on nothing else as the very next turn", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(r.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(h.scheduler.reconcileRun(runId).actions.map((a) => a.kind)).not.toContain("prepare_root_turn");
      const idle = h.stores.invocations.listByRun(runId).length;
      h.orchestratorInputs.postOperatorMessage({ runId, content: "Change of plan: skip the docs." });
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(idle + 1);
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn.purpose).toBe("operator_input");
      expect(h.stores.invocations.getManifest(turn.id).content.inputs.map((i) => i.kind)).toEqual(["operator_message"]);
      // A cancelled Run accepts no steering.
      h.runControl.cancel({ runId });
      expect(() => h.orchestratorInputs.postOperatorMessage({ runId, content: "too late" })).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      expect(h.stores.conversations.listMessages(s.created.run.conversationId).filter((m) => m.content === "too late")).toEqual([]);
    } finally {
      h.close();
    }
  });
});
